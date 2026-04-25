# SQLite 持久化缓存设计文档

## 概述

引入 SQLite 是为了消除重复的 GitHub API 调用。Copilot Enterprise 的历史用量数据在发布后不再变化（存在 24-48 小时延迟），但每次页面刷新都重新拉取，浪费 API 配额并导致响应缓慢。

通过 SQLite 持久化缓存，历史数据从本地读取，API 调用量可减少约 97%。

### 关键设计决策

- **per-user ranking 持久化** — GitHub Enterprise API 不返回用户字段，首次查询成本高昂（N 用户 × N 天），通过 `ranking` 列持久化结果，后续读取零成本
- **Cycle 数据从 SQLite 聚合** — "按日期查询"中的"本周期请求量"从当月已缓存天数的 ranking 累加，避免每次都触发 per-user fallback
- **并发请求合并（In-flight Dedup）** — 多个浏览器标签页同时刷新时复用同一个 Promise，防止重复查询
- **ETag 条件请求** — 数据未变化时返回 304 Not Modified，不消耗 rate limit
- **同步 SQLite** — 选用 better-sqlite3 同步 API，数据量小（每天一行 JSON），同步查询耗时可忽略（< 1ms），避免了 async 版本的回调复杂性

## 整体架构

```
                    ┌──────────────┐
                    │   前端页面    │
                    │ (HTML/JS/CSS)│
                    └─────────────┘
                           │ HTTP
                           ▼
              ┌────────────────────────┐
              │      Express Server     │
              │       server.js         │
              └──┬─────────────────────┘
                 │          │
    ┌────────────▼    ┌─────▼──────────┐
    │  内存缓存层       │  SQLite 持久层  │
    │  refreshCache   │  usage-store.js │
    │  githubGetCache │  data/usage.db  │
    │  etagCache      │                 │
    │  teamCache      │                 │
    └────────────┘    └───────────────┘
                            │
                     ┌──────▼───────┐
                     │ GitHub API   │
                     │ (最终数据源)   │
                     └──────────────┘
```

### 缓存层级（从快到慢）

1. **内存缓存**（`refreshCache`、`githubGetCache`、`etagCache`）— 进程内，重启丢失
2. **SQLite 持久缓存**（`data/usage.db`）— 磁盘持久化，重启恢复
3. **GitHub API** — 最终数据源，速率受限

## 数据表设计

### 1. `daily_usage` — 每日用量数据

存储每天的原始用量数据 + per-user 排名，是整个系统的核心表。

| 列名 | 类型 | 说明 |
|------|------|------|
| `date` | TEXT (PK) | 日期，格式 `YYYY-MM-DD` |
| `year` | INTEGER | 年份 |
| `month` | INTEGER | 月份 |
| `day` | INTEGER | 日期 |
| `data` | TEXT (JSON) | GitHub API 返回的原始 JSON 数据（包含 `usageItems`） |
| `mode` | TEXT | 数据获取模式：`direct` / `per-user-fallback` |
| `raw_count` | INTEGER | 原始 `usageItems` 数量 |
| `source` | TEXT | 数据来源标识，如 `enterprise:your-enterprise` |
| `fetched_at` | TEXT (ISO) | 数据获取时间 |
| `ranking` | TEXT (JSON) | per-user 排名数据（`[{user, requests, amount}, ...]`） |

**用途：**
- `GET /api/usage` — 返回内存中的当前排名（不直接读此表）
- `POST /api/usage/refresh` — 先查此表，命中则直接返回，不查询 GitHub
- `/api/analytics/*` — 读取历史数据生成趋势图和排名

**TTL 策略：**
- 默认 90 天（`USAGE_TTL_MS = 90 * 24 * 60 * 60 * 1000`）
- 覆盖 GitHub 24-48h 延迟窗口，历史数据稳定后不再变化
- 可通过 `getFreshDays()` 按 TTL 过滤过期数据

### 2. `seats_snapshot` — 用户席位快照

存储 Copilot 席位列表的快照，用于团队映射和用户列表。

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER (PK) | 自增主键 |
| `data` | TEXT (JSON) | 席位数组 `[{login, team, planType, ...}, ...]` |
| `fetched_at` | TEXT (ISO) | 快照时间 |
| `total` | INTEGER | 席位总数 |

**用途：**

- `ensureSeatsData()` — 启动时尝试从此表恢复席位数据
- 如果快照在 TTL 内（10 分钟），跳过 GitHub API 调用
- 每次从 GitHub 拉取新席位后写入此表

**TTL 策略：**
- 10 分钟（`SEATS_TTL_MS = 10 * 60 * 1000`）
- 席位数据变化较频繁（用户分配/移除）

### 3. `etag_cache` — ETag 条件请求缓存

存储 GitHub API 的 ETag 响应头，实现 304 Not Modified 条件请求。

| 列名 | 类型 | 说明 |
|------|------|------|
| `pathname` | TEXT (PK) | API 路径（含排序后的查询参数） |
| `etag` | TEXT | GitHub 返回的 ETag 值 |
| `data` | TEXT (JSON) | 上次 200 响应的数据 |
| `fetched_at` | TEXT (ISO) | 缓存时间 |

**用途：**
- `githubGetJson()` — 每次 GET 请求前，从此表加载 ETag 到内存 `etagCache`
- 收到 200 响应时，同步写入此表
- 收到 304 响应时，使用缓存数据，不消耗 API 配额

**启动恢复：**
```
server.js 启动 → usageStore.loadAllEtags() → 恢复到 etagCache Map
```

## 何时使用 SQLite vs GitHub API

### 查询优先级（refreshForDateOverride）

```
1. 内存缓存 refreshCache（TTL = 5 分钟）
   ↓ 未命中
2. SQLite daily_usage（TTL = 90 天）
   → 命中且有 ranking → 直接返回
   → 命中但 ranking 为空 → 触发 per-user fallback
   ↓ 未命中
3. GitHub API（带 ETag 条件请求）
   → 304 → 使用 etagCache 数据
   → 200 → 解析数据，写入 SQLite，写入 refreshCache
```

### 各接口的缓存行为

| 接口 | 缓存层 | 行为 |
|------|--------|------|
| `GET /api/usage` | 内存 | 只返回 `state.ranking`，不查 SQLite |
| `POST /api/usage/refresh` | 三层 | refreshCache → SQLite → GitHub API |
| `GET /api/seats` | 内存+SQLite | teamCache → SQLite → GitHub API |
| `GET /api/teams` | 内存 | 只返回 `teamCache`，不查 SQLite |
| `GET /api/enterprise-teams` | 内存+GitHub | teamMemberCountCache → GitHub |
| `GET /api/cost-centers` | 无 | 每次查询 GitHub（预算数据需实时） |
| `GET /api/analytics/trends` | SQLite | 从 `daily_usage` 读取历史趋势 |
| `GET /api/analytics/top-users` | SQLite | 优先读取 `ranking` 列，回退到 `data.usageItems` |
| `GET /api/analytics/daily-summary` | SQLite | 优先读取 `ranking` 列，回退到 `data.usageItems` |

## 数据写入时机

### 1. `saveDay()` — 写入每日用量

调用时机：`refreshForDateOverride()` 从 GitHub 获取新数据后

```javascript
// server.js: refreshForDateOverride()
const { data, endpoint } = await fetchUsageFromGitHub(dateOverride);
let ranking = aggregateRanking(data);
let mode = "direct";

// 如果 direct 聚合没有已知用户，触发 per-user fallback
if (!hasKnownUsers(ranking) && data.usageItems.length > 0) {
  ranking = await buildRankingByUserQueries(endpoint, dateOverride);
  mode = "per-user-fallback";
}

// 持久化到 SQLite（仅当有 day 参数时）
if (day) {
  usageStore.saveDay(dateKey, year, month, day, data, mode, rawItemsCount, source, fetchedAt, ranking);
}
```

**注意：**
- `ranking` 列存储 per-user 排名，是 Analytics 页面 Top 用户的关键数据源
- 如果 SQLite 缓存的 ranking 为空，会自动触发 per-user fallback 并重新写入

### 2. `saveSeatsSnapshot()` — 写入席位快照

调用时机：`ensureSeatsData()` 从 GitHub 拉取席位后

```javascript
// server.js: ensureSeatsData()
const seats = await fetchCopilotSeats(endpoint.enterprise);
teamCache.seatsRaw = seats;
teamCache.fetchedAt = new Date().toISOString();
usageStore.saveSeatsSnapshot(seats, teamCache.fetchedAt);
```

### 3. `saveEtag()` — 写入 ETag

调用时机：`githubFetchRaw()` 收到 200 响应后

```javascript
// server.js: githubFetchRaw()
if (method === "GET" && resp.ok && etag) {
  etagCache.set(cacheKey, { etag, data, ts: Date.now() });
  usageStore.saveEtag(cacheKey, etag, data, now);
}
```

## per-user Fallback 机制

### 为什么需要

GitHub Enterprise 用量 API 返回的 `usageItems` **不包含用户字段**（只有 `product`、`sku`、`model`、`quantity` 等聚合数据），无法直接知道哪个用户产生了用量。

### 工作流程

```
1. aggregateRanking() 尝试从 usageItems 提取用户
   → pickUser() 找不到任何用户字段 → 全部归为 "(unknown)"
   → 过滤后 ranking 为空

2. 触发 buildRankingByUserQueries()
   → 遍历 teamCache.userTeamMap 中的所有用户（N 个）
   → 按 user 参数逐个查询 GitHub API:
     GET /enterprises/{slug}/settings/billing/premium_request/usage?user={login}&year={y}&month={m}
   → 受 MAX_CONCURRENT_GITHUB 限制并发（默认 3）
   → 聚合每个用户的请求量和费用

3. 结果写入 SQLite ranking 列
   → 下次刷新时直接从 SQLite 读取，不再查询 GitHub
```

### 性能优化

- 用户查询按 8 个一组并发执行（受 GitHub 并发限制）
- 结果持久化到 SQLite `ranking` 列，避免重复查询
- 如果 SQLite 缓存的 ranking 为空但 `usageItems` 有数据，自动触发 fallback

## API 接口调用方法详解

### POST /api/usage/refresh

刷新用量数据，支持三种查询模式：

```json
// 按日期查询（single）
{
  "queryMode": "single",
  "date": "YYYY-MM-DD"
}

// 按日期范围查询（range）
{
  "queryMode": "range",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD"
}

// 默认模式（latest）
{}
```

**响应：**
```json
{
  "ok": true,
  "ranking": [{ "user": "username", "team": "TeamName", "requests": 300, "amount": 51.0 }],
  "mode": "per-user-fallback",
  "cacheHitRatio": 80
}
```

**内部流程：**
1. `ensureSeatsData()` — 确保席位数据已加载（内存或 SQLite）
2. 根据查询模式，遍历日期列表
3. 每个日期调用 `refreshForDateOverride()`：
   - 先查内存 `refreshCache`（TTL 5 分钟）
   - 再查 SQLite `daily_usage`（TTL 90 天）
   - 最后调用 GitHub API（带 ETag）
4. 如果是 single 模式，额外查询当月周期数据（计算百分比）
5. `enrichRanking()` — 补充 team、adName、percentage、amount
6. 写入 `state.ranking`，返回前端

### GET /api/seats?refresh=1

获取 Copilot 席位数据。

```json
{
  "ok": true,
  "totalSeats": N,
  "seats": [{ "login": "username", "team": "TeamName", "planType": "business" }],
  "fetchedAt": "YYYY-MM-DDTHH:MM:SS.sssZ"
}
```

**内部流程：**
1. 如果 `refresh=1`，强制从 GitHub 拉取
2. 否则检查 `teamCache.fetchedAt` 和 SQLite 快照
3. 如果快照在 TTL 内（10 分钟），直接从 SQLite 恢复
4. 否则调用 `fetchCopilotSeats()` 串行分页拉取
5. 写入 SQLite `seats_snapshot` 和内存 `teamCache`

### GET /api/enterprise-teams

获取 Enterprise Teams 列表（含成员数）。

```json
{
  "ok": true,
  "teams": [{
    "id": 123,
    "name": "YourTeamName",
    "description": "团队描述",
    "membersCount": N,
    "createdAt": "YYYY-MM-DDTHH:MM:SS+HH:MM",
    "htmlUrl": "https://github.com/orgs/..."
  }]
}
```

**成员数获取：**
- 使用串行分页 `fetchEnterpriseTeamMemberCount()`
- 结果缓存在内存 `teamMemberCountCache`（TTL 10 分钟）
- 不使用 Link header（304 响应不包含）

### GET /api/analytics/trends?range=30

获取每日用量趋势数据（用于 Chart.js 趋势图）。

```json
{
  "ok": true,
  "range": 30,
  "trend": [
    { "date": "YYYY-MM-DD", "requests": 593.32, "amount": 23.7328 },
    { "date": "YYYY-MM-DD", "requests": 716.22, "amount": 28.6488 }
  ],
  "cachedCount": 25
}
```

**数据来源：** 直接读取 SQLite `daily_usage` 表的 `data.usageItems`，不查询 GitHub API。

### GET /api/analytics/top-users?range=30

获取 Top 20 用户排名（用于 Chart.js 柱状图）。

```json
{
  "ok": true,
  "range": 30,
  "topUsers": [
    { "rank": 1, "user": "user1", "requests": 300, "amount": 51.0 },
    { "rank": 2, "user": "user2", "requests": 300, "amount": 51.0 },
    { "rank": 3, "user": "user3", "requests": 292.5, "amount": 50.7 }
  ]
}
```

**数据来源优先级：**
1. 读取 SQLite `daily_usage.ranking` 列（per-user 排名数据）
2. 如果 ranking 为空，回退到 `data.usageItems` 聚合（但 Enterprise API 不返回用户字段，通常为空）

### GET /api/analytics/daily-summary?range=30

获取汇总统计（用于页面顶部摘要卡片）。

```json
{
  "ok": true,
  "range": 30,
  "totalRequests": 5191.46,
  "totalAmount": 207.6584,
  "avgDailyRequests": 865.24,
  "avgDailyAmount": 34.6097,
  "daysWithData": 6,
  "totalDaysInRange": 25
}
```

**数据来源优先级：**
1. 读取 SQLite `daily_usage.ranking` 列聚合
2. 回退到 `data.usageItems` 聚合

## Analytics Top 用户 — 工作原理详解

### 计算方式：预计算 + 累加

Top 用户排名**不是实时计算**，而是两步流程：

#### 第一步：预计算（用户刷新时）

```text
用户点击"刷新" → POST /api/usage/refresh
  → buildRankingByUserQueries() 逐个查询 GitHub
  → 结果写入 daily_usage.ranking 列
```

- 每个用户的请求量和费用写入 `daily_usage.ranking`（每行约 10KB JSON）
- 此步骤调用 GitHub API，耗时较长（取决于用户数量）
- 结果持久化到 SQLite，后续分析页面不再调用 GitHub

#### 第二步：读取累加（访问分析页时）

```text
访问 /analytics → GET /api/analytics/top-users?range=N
  → 从 SQLite 读取选定日期范围内的每天 ranking
  → 按 user 累加 requests 和 amount
  → 排序取 Top 20，返回前端
```

- **纯本地 SQLite 读取**，不调用 GitHub API
- 响应速度快（< 10ms）
- 前端支持 30 天 / 90 天 / 1 年三个统计周期

### 统计周期

由 URL 参数 `?range=N` 控制：

| 按钮 | range 值 | 统计范围            |
|------|----------|---------------------|
| 30天 | `30`    | 当天往前推 30 天     |
| 90天 | `90`    | 当天往前推 90 天     |
| 1年  | `365`   | 当天往前推 365 天    |

计算方式：

```javascript
const endDate = new Date();
const startDate = new Date(endDate);
startDate.setDate(endDate - range + 1);
// 从 SQLite 读取 [startDate, endDate] 区间内每天的 ranking 数据
```

### 用户名展示规则

返回前通过 `userMappingService` 进行名称转换：

- **已映射用户**（在"用户映射管理"中存在映射记录）：显示 AD 用户名
- **未映射用户**（无映射记录）：显示 GitHub 用户名

与主页面和其他页面的命名展示原则保持一致。

### 注意事项和限制

#### 1. 数据新鲜度依赖手动刷新

Top 用户的准确性取决于用户最近一次刷新覆盖了多少天。如果用户多天没有执行刷新操作，ranking 数据是旧的，分析结果也是旧的。

**建议**：在分析页也提供"刷新"按钮，先刷新数据再展示分析结果。

#### 2. SQLite 数据 TTL = 90 天

`refreshForDateOverride` 的 SQLite 缓存 TTL 为 90 天。超过 90 天的数据在刷新时会被视为过期并重新查询 GitHub。但已有的 ranking 数据不会被自动清理，仍然保留在数据库中。

#### 3. 只有被刷新过的日期才有 ranking

如果某一天从未被刷新过，SQLite 中没有该天的 ranking 记录。累加时会跳过这一天，可能导致统计不完整。

**示例**：range=30 天的范围内，只有 6 天被刷新过，则 Top 用户只反映这 6 天的累计数据，而非完整的 30 天。

#### 4. ranking 为空时的回退

如果某天有 `usageItems` 但 `ranking` 列为空（GitHub Enterprise API 不返回用户字段），系统会尝试触发 per-user fallback 重新计算。但如果 fallback 也失败，则该天数据会被跳过。

#### 5. per-user 查询成本

首次生成 ranking 时，需要逐个查询每个用户的用量（N 个用户 × N 个日期），受 `MAX_CONCURRENT_GITHUB` 限制并发执行。用户规模较大时，首次刷新可能耗时较长。

### 优化建议

1. **分析页增加"先刷新"提示** — 在 Top 用户图表旁显示"当前基于最近 X 天的数据，点击主页刷新按钮获取最新数据"
2. **定期自动刷新** — 可配置定时任务定期执行 refresh，确保 ranking 数据保持最新
3. **ranking 数据清理** — 可定期清理超过一定时间（如 1 年）的 ranking 数据，减小数据库体积

### 为什么使用 better-sqlite3（同步）而非 async 版本

- 用量存储的读写在请求处理路径上，同步操作更简单可靠
- 数据量小（每天一行 JSON），同步查询耗时可忽略（< 1ms）
- 避免了 async SQLite 的回调地狱和并发控制问题
- WAL 模式确保读写不互斥

### 为什么 ranking 列存储完整 JSON

- per-user ranking 是 Analytics 页面的关键数据源
- GitHub Enterprise API 不返回用户字段，per-user 查询成本高
- 存储 ranking 避免每次 Analytics 请求都重新查询 GitHub
- N 个用户的 JSON 约 10KB，存储成本可接受

### 为什么使用 INSERT OR REPLACE

- `date` 是 PRIMARY KEY，同一天多次刷新会覆盖
- 简化逻辑：不需要先检查是否存在再决定 INSERT/UPDATE
- SQLite 的 WAL 模式确保并发安全

## Cycle（月度汇总）数据

### 问题背景

在 "按日期查询"（single 模式）中，每个用户除了当日请求量，还显示 "本周期请求量"（当月累计），用于进度条和百分比计算。

实现上需要同时查询两条数据：

```javascript
// server.js: single 模式
const [dailyResp, cycleResp] = await Promise.all([
  refreshForDateOverride({ year: 2026, month: 4, day: 25 }),  // 当日
  refreshForDateOverride({ year: 2026, month: 4 }),          // 当月汇总（无 day）
]);
```

**月度汇总请求**（无 `day` 参数）存在以下问题：
- GitHub Enterprise 用量 API 返回的 aggregate 数据不包含用户字段
- `aggregateRanking()` 会全部归为 `(unknown)` 并触发 205 用户的 per-user fallback
- 结果既不写入 SQLite（`if (day)` 为 false），每次刷新都重复查询，浪费 API 配额

### 解决方案

新增 `buildCycleFromSQLite(year, month)` 函数：
- 从 SQLite `daily_usage` 读取当月所有已缓存日期的 `ranking` 列
- 按用户累加 `requests` 和 `amount`
- 直接返回月度汇总排名，**零 GitHub API 调用**

**优先级：**
```
月度汇总查询 → 优先从 SQLite 聚合已有日期的 ranking
             → 如果当月无缓存数据 → 回退到 GitHub API（降级为 empty ranking）
```

### 优势

1. 零 GitHub 调用 — 纯本地 SQLite 读取
2. 自动利用已有的 per-user ranking 数据
3. 当月数据越完整（刷新天数越多），cycle 统计越精确
4. 无需额外的 per-user fallback，节省 API 配额

---

## 文件清单

| 文件 | 说明 |
|------|------|
| `lib/usage-store.js` | SQLite 封装层，所有数据库操作集中在此 |
| `server.js` | 主服务文件，使用 `usageStore` 实例 |
| `data/usage.db` | SQLite 数据库文件（自动生成） |
| `public/analytics.js` | Analytics 页面，调用分析 API |

## 运维操作

### 清理过期数据

```javascript
// 删除 90 天前的 daily_usage 记录
usageStore.cleanupOldData(90 * 24 * 60 * 60 * 1000);

// 删除 30 天前的 ETag 缓存
usageStore.cleanupEtagCache(30 * 24 * 60 * 60 * 1000);
```

### 重置缓存

```bash
# 删除数据库文件（谨慎操作，会丢失所有缓存）
rm data/usage.db

# 重启服务后自动重新创建
npm start
```

### 查看缓存状态

```bash
node -e "
const { UsageStore } = require('./lib/usage-store');
const store = new UsageStore();

// 查看 daily_usage 统计
const count = store.db.prepare('SELECT COUNT(*) as c FROM daily_usage').get();
console.log('Cached days:', count.c);

// 查看 seats 快照
const seats = store.getLatestSeatsSnapshot();
console.log('Latest seats snapshot:', seats ? seats.total : 0, 'users');

// 查看 ETag 缓存
const etags = store.loadAllEtags();
console.log('ETag cache entries:', Object.keys(etags).length);

store.close();
"
```
