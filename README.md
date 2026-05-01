# Copilot 每用户用量展示

基于 Node.js + Express 的 GitHub Copilot Premium Request 用量可视化仪表盘，面向 GitHub Enterprise 管理员，提供每用户请求量排行、费用估算、Team 管理和账单汇总等功能。

## 功能特性

- **每用户用量排行** — 按日期或日期范围查询每个用户的 Premium Request 请求量
- **默认范围查询模式** — 首页默认切换为“按日期范围查询”
- **当日 / 本周期双列展示** — 按日期查询时同时显示当日请求量和本月累计请求量
- **本周期进度条展示** — “本周期请求量”按配额基线显示进度条，支持超额标记
- **Team 多选筛选** — 支持下拉复选 Team，默认全选，可按 Team 过滤表格数据
- **Premium Requests (%)** — 基于订阅计划额度计算（Business = 300 / Enterprise = 1000）
- **费用估算** — 额度内显示订阅费（Business $19），超额按 $0.04/request 累加
- **平滑刷新体验** — 采用 SWR (Stale-While-Revalidate) 缓存策略，刷新时优先显示缓存并后台静默更新，配合骨架屏 (Skeleton Screen) 消除长时间白屏的感知等待。
- **防止限流与并发控制** — 内置 GitHub API 调用并发队列和请求防抖 (Single-flight)；遇到 API 速率限制 (Rate Limit) 时会自动进行指数退避重试，向前端返回友好的恢复时间提示。
- **分批渲染大表** — 处理海量用量数据时采用 requestAnimationFrame 进行 chunked 渲染，避免卡死浏览器主线程。
- **排序** — 全部表格列支持升序/降序点击排序
- **用户 & Team 信息** — 查看 Enterprise Teams（名称、描述、成员数），点击展开查看 Team 成员（AD 名称优先，GitHub 登录名回退）；查看全量 Copilot 席位列表（AD 名映射显示）
- **整体账单汇总** — 席位订阅费 + Premium Requests 超额费用（API 净额口径），支持历史月切換和强制刷新回源
- **模型使用排行** — 按月查看各 AI 模型的请求量和费用占比
- **启动前自检** — 提供 Shell 与 Node 两版 preflight 脚本用于权限和连通性检查
- **Cost Center 详情增强** — 点击名称可查看常规信息卡片、资源分组明细（Users/Organizations/Repositories）
- **Cost Center 预算进度条** — 预算按百分比可视化（<75% 蓝色，75%-100% 黄色，>=100% 红色）
- **Team 批量加 Users** — 在 Cost Center 详情页可按 Team 批量将成员加入该 cost center 的 Users 资源
- **Team 同步可选删除** — 执行批量加入时，若存在”Cost Center 有 / Team 无”用户，会提示”确认删除”或”忽略删除”
- **分页显示** — 表格默认每页显示 15 行，支持页码点击跳转。分页控件右下角展示，规则为：
  - 总页数 ≤ 1 时隐藏分页器
  - 最多同时显示 5 个数字页码，超出时以省略号分隔（`上一页 1 ... 3 4 5 ... 8 下一页`）
  - 第一页不显示”上一页”按钮，最后一页不显示”下一页”按钮
  - 排序、筛选、刷新时自动回到第 1 页
- **用户映射管理** — 上传 Excel（`.xlsx` / `.xls`）映射表，将 GitHub 用户名关联到展示名称
- **自定义名称显示** — 已映射用户在首页用量排行中优先显示自定义名称，未映射用户仍显示 GitHub 登录名
- **映射状态可视化** — 用户映射管理页中每行显示 已映射/未映射 标签，支持一键刷新成员列表
- **自动热重载映射** — 映射文件变更时，内存中的数据自动同步，无需重启服务
- **三层缓存架构** — 内存缓存（5 分钟） → SQLite 持久缓存（90 天） → GitHub API，大幅减少 API 调用
- **ETag 条件请求** — 数据未变化时返回 304 Not Modified，不消耗 API 配额
- **数据分析页面** — 独立页面提供用量趋势图、Top 用户排行柱状图、汇总统计卡片（30 天 / 90 天 / 1 年）
- **Team 月度账单** — 独立页面 `/billpage`，按月查看 Team 维度账单，显示席位费、套餐外附加费、总费用，支持展开查看用户明细，历史数据持久化到 SQLite（仅通过直接访问 URL `/billpage` 进入，主页不展示入口）
- **按月强制刷新兑底** — `/billpage` 页面提供“强制刷新”按钮：二次确认后会清空选中月份的 SQLite 缓存、逐日回源 GitHub API并重新计算账单，作为缓存错误、空数据或 API 数据延迟场景下的兑底手段- **账单导出 Excel** — `/billpage` 页面提供"导出Excel"按钮，将选中月份的 Team 账单导出为 `.xlsx` 文件；每个 Team 生成独立 Sheet（含用户名、Team名、用量信息、套餐外附加费、总费用），另附 "Total" 汇总 Sheet（Team 级聚合统计），使用 `exceljs` 库在服务端生成并流式返回- **按日强制回源** — `POST /api/usage/refresh` 支持 `force:true` 参数，跳过内存与 SQLite TTL 检查，直接拉取最新数据并覆盖写入
- **动态 TTL抖动防护** — 近 3 天的日期采用 1 小时 SQLite TTL，更老的日期使用 90 天 TTL，避免因 GitHub Billing API 24–48h 延迟期写入不完整数据后被“锁死”
- **内置自动刷新调度器**（默认开启）— 服务启动后自动刷新当天数据；每天 03:00 / 12:00 强制刷新今天 + 剩下的近 N 天（默认 N=2），避免依赖人工点击刷新。可通过环境变量关闭或调整时间
- **缓存命中率展示** — 页面顶部显示缓存命中百分比，直观反映 API 调用节省效果
- **并发请求合并（In-flight Dedup）** — 多个浏览器标签页同时刷新时自动复用同一请求，避免重复查询

## 技术架构

项目采用 **模块化分层架构**，后端按职责拆分为入口层、路由层、服务层、数据层，前端通过 IIFE + 公共命名空间消除全局变量污染。

```text
server.js                Express 入口（~100 行），挂载路由、优雅关闭、全局错误处理、健康检查
routes/
  usage.js              用量查询与聚合路由
  billing.js            账单汇总路由
  teams.js              Enterprise Teams 路由
  costcenter.js         Cost Center 管理路由
  analytics.js          数据分析路由（趋势、Top 用户、汇总）
  user-mapping.js       用户映射管理路由（上传、重载、成员列表）
  seats.js              Copilot 席位数据加载器（共享模块）
lib/
  github-api.js         GitHub API 服务层（LRU 缓存、ETag、并发队列、重试退避、single-flight）
  usage-store.js        SQLite 持久缓存层（预编译语句、席位快照清理、月度账单存储）
  scheduler.js          轻量自动刷新调度器（setTimeout 自重排，启动时刷今天、定时点刷近 N 天）
  user-mapping.js       用户映射服务（fs.watch + debounce 热重载）
  billing-config.js     计费配置与费用计算
  date-utils.js         日期工具函数
  helpers.js            共享辅助函数
  logger.js             pino 结构化日志（dev 模式 pretty，生产 JSON）
public/
  common.js             前端公共模块（IIFE，CopilotDashboard 命名空间）
  index.html / script.js      主页面（用量排行、排序、模态框、分页）
  costcenter.html / costcenter.js  Cost Center 管理页
  analytics.html / analytics.js    数据分析页（含数据新鲜度提示）
  billpage.html / billpage.js      Team 月度账单页
  user.html / user.js              用户映射管理页
  styles.css            全局样式
test/
  date-utils.test.js    日期工具单元测试
  billing-config.test.js  计费配置单元测试
  helpers.test.js       辅助函数单元测试
scripts/
  preflight-check.sh    启动前自检（Shell）
  preflight-check.js    启动前自检（Node）
docs/
  refactoring-architecture.md  重构架构设计文档
  sqlite-cache-design.md       SQLite 缓存架构设计文档
  ...                          其他设计文档
deploy/
  copilot-dashboard.service    systemd 服务单元
  nginx-copilot-dashboard.conf Nginx 反向代理配置
data/
  usage.db              SQLite 数据库文件（自动生成）
  user_mapping.json     本地用户映射表（自动生成）
.env                    配置（不入库）
.env.example            配置模板
```

## 使用的 GitHub API

| 端点 | 用途 |
| --- | --- |
| `GET /enterprises/{enterprise}/copilot/billing/seats` | 用户列表、Team 归属、计划类型、最后活跃时间/编辑器 |
| `GET /enterprises/{enterprise}/settings/billing/premium_request/usage` | 每用户 Premium Request 用量（支持 `?user=`、`?year=`、`?month=`、`?day=`） |
| `GET /enterprises/{enterprise}/settings/billing/usage` | 企业整体账单（席位费 + Premium Requests 费用） |
| `GET /enterprises/{enterprise}/settings/billing/cost-centers` | Cost Center 列表与详情 |
| `POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource` | 向 Cost Center 添加资源（users/orgs/repos） |
| `DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource` | 从 Cost Center 移除资源（users/orgs/repos） |
| `GET /enterprises/{enterprise}/teams` | Enterprise Teams 列表及描述 |
| `GET /enterprises/{enterprise}/teams/{team_id}/memberships` | Team 成员列表 |

## 新增 API 端点（本项目内部）

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查端点，返回服务运行状态 |
| `POST` | `/api/usage/refresh` | 刷新用量数据，支持按日期/日期范围/默认三种查询模式；请求体可传 `force:true` 跳过内存与 SQLite 缓存强制回源 |
| `POST` | `/api/bill/refresh` | **按月强制刷新**：请求体 `{year, month}`，清空该月所有 `daily_usage` 与 `monthly_bill` 缓存后逐日回源 GitHub，重新计算账单 |
| `GET` | `/api/seats` | 获取 Copilot 席位数据（支持 `?refresh=1` 强制刷新） |
| `GET` | `/api/teams` | 获取 Enterprise Teams 列表（含成员数） |
| `GET` | `/api/cost-centers` | 获取 Cost Center 列表 |
| `GET` | `/api/cost-centers/:name` | 获取单个 Cost Center 详情（含资源分组） |
| `POST` | `/api/cost-centers/:id/add-users-from-teams` | 按 Team 批量向 Cost Center 添加 Users |
| `GET` | `/api/analytics/trends?range=30` | 每日用量趋势数据（Chart.js 趋势图） |
| `GET` | `/api/analytics/top-users?range=30` | Top 20 用户排名（Chart.js 柱状图） |
| `GET` | `/api/analytics/daily-summary?range=30` | 汇总统计（总量、日均、有数据天数） |
| `GET` | `/api/bill?year=2026&month=4` | Team 月度账单（席位费 + 超额费 + 总费用，按 Team 分组） |
| `GET` | `/api/bill/export?year=2026&month=4` | 导出 Team 月度账单为 Excel 文件（多 Sheet：每 Team 明细 + Total 汇总） |

> 详细的“强制刷新”与“自动刷新调度器”使用说明见后文《强制刷新与自动刷新》小节。

## 快速开始

### 前置要求

- Node.js >= 18
- GitHub PAT (classic)，账号需具有 Enterprise admin 或 billing manager 权限

### 安装

```bash
git clone <repo-url>
cd CopilotEnterpriseUsageDisplay
npm install
```

### 配置

```bash
cp .env.example .env
```

编辑 `.env` 填写：

```env
GITHUB_TOKEN=YOUR_GITHUB_TOKEN
ENTERPRISE_SLUG=YourEnterprise
PRODUCT=Copilot
```

### 启动

```bash
npm start
```

访问 <http://localhost:3000>

### 开发模式（文件变更自动重启）

```bash
npm run dev
```

### 运行测试

```bash
npm test              # 运行所有单元测试
npm run test:watch    # 监听模式
```

### 启动前自检（推荐）

```bash
# Shell 版
./scripts/preflight-check.sh

# Node 版
node ./scripts/preflight-check.js

# 严格模式（将 WARN 视为失败）
./scripts/preflight-check.sh --strict
node ./scripts/preflight-check.js --strict
```

建议生产环境先运行自检，再启动服务。

## 环境变量说明

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 是 | GitHub PAT，需 Enterprise billing 读取权限 |
| `ENTERPRISE_SLUG` | 是 | Enterprise slug（如 `YourEnterprise-slug`） |
| `BILLING_YEAR` | 否 | 账单年份（默认取当前年） |
| `BILLING_MONTH` | 否 | 账单月份（默认取当前月） |
| `BILLING_DAY` | 否 | 可选，指定具体日期 |
| `PRODUCT` | 否 | 产品过滤，默认 `Copilot` |
| `MODEL` | 否 | 可选，按模型过滤 |
| `INCLUDED_QUOTA` | 否 | 每用户每周期包含请求配额，默认 `300`，用于进度条基线和百分比计算 |
| `CACHE_TTL` | 否 | API 响应在前端的缓存时长（秒），默认 `300`（5 分钟），缓存期内采用 SWR 策略无缝展示 |
| `GITHUB_MAX_CONCURRENT` | 否 | GitHub API 并发请求上限，默认 `3`，防止因瞬时并发触发 Secondary Rate Limit |
| `GITHUB_MAX_RETRIES` | 否 | GitHub API 请求遇错和被限流时的最大重试次数，默认 `3` |
| `GITHUB_API_BASE` | 否 | API 地址，默认 `https://api.github.com` |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `SCHED_DISABLED` | 否 | 设为 `true` 可关闭内置自动刷新调度器（默认开启，多副本部署时可在其他副本上关闭） |
| `SCHED_DAILY_TIMES` | 否 | 逗号分隔的本地时间 `HH:MM` 列表，默认 `03:00,12:00` |
| `SCHED_BACKFILL_DAYS` | 否 | 调度器每次运行时除今天外额外回填的天数，默认 `2`（即今天+昨天+前天） |
| `SCHED_STARTUP_DELAY_MS` | 否 | 启动后首次刷今天数据的延迟毫秒数，默认 `5000` |

## 缓存架构

### 三层缓存体系

```
内存缓存 (5 分钟) → SQLite 持久缓存 (90 天) → GitHub API
```

| 缓存层 | 存储 | TTL | 用途 |
| --- | --- | --- | --- |
| `refreshCache` | 内存 Map | 5 分钟 | 最近查询的用量排名 |
| `etagCache` | 内存 Map + SQLite | 持久化 | GitHub API 条件请求 (304) |
| `teamCache` | 内存对象 | 10 分钟 | Copilot 席位列表 |
| `daily_usage` | SQLite 表 | 动态：近 3 天 1 小时，更老 90 天 | 每日用量原始数据 + per-user 排名 |
| `seats_snapshot` | SQLite 表 | 10 分钟 | 席位快照，启动恢复 |
| `monthly_bill` | SQLite 表 | 持久化 | Team 月度账单计算结果 |
| `etag_cache` | SQLite 表 | 持久化 | ETag 持久化，重启恢复 |

### 缓存命中率

每次刷新后页面顶部显示缓存命中百分比：
- **100%** = 全部从 SQLite 读取，零 GitHub 调用
- **50%** = 一半日期命中缓存，另一半调用了 GitHub
- **0%** = 全部为首次查询，需逐个调用 GitHub API

## 强制刷新与自动刷新

由于 GitHub Billing API 存在 24–48 小时的数据延迟，首次拉取某天数据时可能得到空或不完整结果。为避免这些数据被默认 90 天的 SQLite 缓存“锁死”，系统提供三种刷新途径：

### 1) 自动刷新调度器（默认开启）

- 服务启动后会延迟数秒自动强制刷新当天数据，保证首次访问时数据为最新。
- 每天 `03:00` 与 `12:00`（本地时间）会自动强制刷新今天 + 最近 N 天（默认 N=2，即 今天 + 昨天 + 前天）。
- 多副本部署时，可在非主副本上设置 `SCHED_DISABLED=true` 关闭，避免重复调用 GitHub API。
- 调度时间点、回填天数、启动延时可通过 `SCHED_DAILY_TIMES`、`SCHED_BACKFILL_DAYS`、`SCHED_STARTUP_DELAY_MS` 调整。

### 2) 按月强制刷新（推荐作为兜底手段）

适用于：历史账单出现明显偏差、怀疑缓存中已写入不完整数据、Token 替换后需要重新拉取等场景。

- **页面操作**：手动访问 `/billpage`（主页不展示入口）→ 选择月份 → 点击“强制刷新” → 二次确认后等待逐日回源完成。
- **API 调用**：

  ```bash
  curl -X POST http://localhost:3000/api/bill/refresh \
    -H "Content-Type: application/json" \
    -d '{"year":2026,"month":4}'
  ```

  实现步骤：

  1. 根据账单周期枚举该月所有日期（当月仅枚举至昨天）
  2. 删除 SQLite 中该月的 `daily_usage` 与 `monthly_bill` 记录
  3. 受 `GITHUB_MAX_CONCURRENT` 限制的并发逐日回源 GitHub API（每日带 `force=true`）
  4. 重新计算 Team 月度账单并写入 `monthly_bill`，返回 `refreshedDays` 与 `failedDates`

### 3) 按日强制刷新（精细控制）

```bash
# 单日强制回源
curl -X POST http://localhost:3000/api/usage/refresh \
  -H "Content-Type: application/json" \
  -d '{"queryMode":"single","date":"2026-04-28","force":true}'

# 日期范围强制回源（最多 31 天）
curl -X POST http://localhost:3000/api/usage/refresh \
  -H "Content-Type: application/json" \
  -d '{"queryMode":"range","startDate":"2026-04-26","endDate":"2026-04-28","force":true}'
```

`force:true` 同时跳过内存层 `refreshCache` 与 SQLite TTL，但仍会进入 single-flight 去重，避免同参数并发请求重复打 GitHub API。

### 账单页访问说明

账单页为**隐式入口**，主页不提供点击跳转，需手动访问 URL：

- 路径：`http://<host>:<port>/billpage`
- 能力：按月查询 Team 账单、按 Team 多选筛选、点击展开查看用户明细、强制刷新选中月份。

## 自检脚本说明

- `scripts/preflight-check.sh`：Shell 版自检，适合 CI/CD 与服务器预检查
- `scripts/preflight-check.js`：Node 版自检，便于后续与项目日志体系整合

检查项包括：

1. 必填环境变量校验
2. DNS 与网络连通性
3. Token 有效性
4. Seats 与 Premium Usage 必要权限
5. Cost Centers / Budgets 能力探测（可选功能）

输出级别：`PASS` / `WARN` / `FAIL`

- 默认：有 `FAIL` 时退出码为 `1`
- `--strict`：有 `WARN` 也返回 `1`

## 文档索引

- `docs/refactoring-architecture.md`：v2 重构架构设计——模块化拆分、性能优化、可靠性改进的思路与方案
- `docs/github-enterprise-copilot-billing-api-checklist.md`：Copilot/Billing API 设计与字段映射清单
- `docs/github-enterprise-copilot-billing-scope-checklist.md`：按接口逐条对应的角色与 scope 核对表
- `docs/minimal-env-and-preflight-design.md`：最小权限 `.env` 模板与 preflight 设计说明
- `docs/sqlite-cache-design.md`：SQLite 持久缓存架构设计、数据表结构、API 调用流程详解

## Cost Center 功能使用说明

### 1) 进入详情页

1. 打开 `/costcenter`
2. 点击某个 Cost Center 名称，进入 `/costcenter/{name}`
3. 在详情页底部可看到“按 Team 批量加入 Cost Center Users”面板

### 2) 按 Team 批量加入 Users

1. 勾选一个或多个 Team（支持“全选 Team”）
2. 点击“预览变更”查看：
   - 请求用户数
   - 已存在用户数
   - 可新增用户数
   - 可删除用户数（Cost Center 有 / Team 无）
3. 点击“确认加入 Users”执行

### 3) 删除行为（已实现）

当存在“Cost Center 有、Team 没有”的用户时，执行阶段会弹窗二次确认：

1. 点击“确定” => 删除这批用户（同时执行新增）
2. 点击“取消” => 忽略删除，仅执行新增

### 4) 后端聚合接口（本项目新增）

`POST /api/cost-centers/:id/add-users-from-teams`

请求体：

```json
{
  "teamIds": ["TEAM_ID_1", "TEAM_ID_2"],
  "dryRun": true,
  "removeMissingUsers": false
}
```

参数说明：

1. `teamIds`：要同步的 Team ID 列表
2. `dryRun`：是否仅预览（不落库）
3. `removeMissingUsers`：执行时是否删除“Cost Center 有 / Team 无”的用户

返回中包含：

1. `requestedUsersCount`
2. `newUsersCount`
3. `existingUsersCount`
4. `usersToRemoveCount`
5. `newUsers` / `existingUsers` / `usersToRemove`

## 用户映射管理 功能使用说明

### 1) 进入页面

访问 `/user` 或通过导航打开用户映射管理页。

### 2) 上传映射文件

- 点击“上传用户映射文件”按钮，选择 Excel 文件（`.xlsx` 或 `.xls`）
- 文件需包含以下四个列名：

| 列名 | 必填 | 说明 |
| --- | :---: | --- |
| `AD-name` | 是 | AD 用户名（显示用） |
| `AD-mail` | 否 | AD 邮箱地址 |
| `Github-name` | 是 | GitHub 用户名 |
| `Github-mail` | 否 | GitHub 邮箱地址 |

- 上传后系统自动解析并保存至本地 `data/user_mapping.json`，**已校验** 的行会跳过 `AD-name` 或 `Github-name` 为空的无效数据

### 3) 使用效果

- **用量排行页**：已映射的用户优先显示其 AD 用户名；未映射的用户仍显示 GitHub 用户名
- **用户映射页**：可查看所有 Copilot 席位用户的映射状态（已映射 / 未映射），支持分页和排序
- **重新加载映射**：如果手动修改了 `data/user_mapping.json` 文件，点击“重新加载映射”即可刷新内存数据（文件变更也会被自动检测到）

### 4) 相关接口

| Method | Path | 用途 |
| :---: | --- | --- |
| `GET` | `/user` | 渲染用户映射管理页面 |
| `POST` | `/user/upload-members` | 上传 Excel 文件，解析并保存映射表 |
| `POST` | `/user/reload-mapping` | 手动触发映射数据重载 |
| `GET` | `/api/user/members` | 获取 Copilot 成员列表（含 Team + AD 映射信息） |
| `GET` | `/api/user/info?github=xxx` | 根据 GitHub 用户名查询对应的 AD 信息（供其他页面调用） |

## Ubuntu 22.04 部署

### 1. 安装 Node.js 18

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # 确认 >= 18
```

### 2. 部署应用代码

```bash
sudo mkdir -p /opt/copilot-dashboard
sudo cp -r ./* /opt/copilot-dashboard/
sudo cp .env /opt/copilot-dashboard/.env
cd /opt/copilot-dashboard
sudo npm install --production
sudo chown -R www-data:www-data /opt/copilot-dashboard
sudo mkdir -p /opt/copilot-dashboard/data /opt/copilot-dashboard/uploads
```

### 3. 配置 systemd 开机自启

```bash
sudo cp deploy/copilot-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable copilot-dashboard   # 开机自启
sudo systemctl start copilot-dashboard    # 立即启动
```

常用管理命令：

```bash
sudo systemctl status copilot-dashboard   # 查看状态
sudo systemctl restart copilot-dashboard  # 重启
sudo journalctl -u copilot-dashboard -f   # 实时日志
```

### 4. 配置 Nginx 反向代理（80 → 3000）

```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx-copilot-dashboard.conf /etc/nginx/sites-available/copilot-dashboard
sudo ln -sf /etc/nginx/sites-available/copilot-dashboard /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # 移除默认站点
sudo nginx -t                                 # 测试配置
sudo systemctl reload nginx
```

部署完成后，通过 `http://<服务器IP>` 即可访问仪表盘。

### 部署文件说明

| 文件 | 说明 |
| --- | --- |
| `deploy/copilot-dashboard.service` | systemd 服务单元，以 `www-data` 用户运行，异常自动重启 |
| `deploy/nginx-copilot-dashboard.conf` | Nginx 反向代理，将 80 端口转发到 Node.js 的 3000 端口 |

## 费用计算逻辑

每用户月度费用按以下规则计算：

- **额度内**（请求量 ≤ 计划额度）：费用 = 订阅基础价（Business $19 / Enterprise $39）
- **超额**（请求量 > 计划额度）：费用 = 基础价 + (超出请求数 × $0.04)

| 计划 | 月额度 | 基础价 | 超额单价 |
| --- | --- | --- | --- |
| Business | 300 requests | $19 | $0.04/request |
| Enterprise | 1000 requests | $39 | $0.04/request |

## 更新日志

### v2.5 — Team 月度账单用户名映射持久化

- **`monthly_bill` 表新增 `ad_name` 列** — 历史月份账单走 SQLite 缓存路径（`getBill`）时会丢失 `adName` 字段，导致 Team 月度账单详情里“已映射”用户退化为显示 GitHub 登录名。UTC 化后当前月在 UTC 凌晨跨日即被判定为已完结，该问题大量暴露。修复以结构化持久化为准：
  1. **Schema 迁移**：`lib/usage-store.js` 的 `_initSchema` 在 `CREATE TABLE monthly_bill` 中增加 `ad_name TEXT`；对既有数据库执行幂等 `ALTER TABLE monthly_bill ADD COLUMN ad_name TEXT`，启动即自动升级，无需人工迁移。
  2. **写入链路**：`saveBillRow` INSERT 字段由 11 个扩展到 12 个，`saveBill` 循环将 `r.adName` 传入占位符。`computeBill` 路径生成的 `adName` 自此随 bill 行一起落库。
  3. **读取链路**：`getBill` 返回结果映射新增 `adName: row.ad_name || null`，恢复前端 `u.adName || u.login` 的映射优先显示逻辑。
- **读时兜底映射（读时永久自愈）** — `routes/bill.js` 在走 `getBill` 历史缓存路径时，对 `adName` 为空的行（迁移前写入的遗留数据）调用 `userMappingService.getUserByGithub(login)` 实时补齐。老历史月无需手动“强制刷新”也能立刻显示最新 AD 映射；下一次该月被重算（或强制刷新）时，真实 `ad_name` 会随 `saveBill` 落库替代兜底值。
- **路由依赖注入对齐** — `server.js` 将 `routes/costcenter.js` 的挂载调用由 `require(...)()` 改为 `require(...)(deps)`，与 `billing` / `teams` / `analytics` / `user-mapping` / `bill` / `usage` 等其他路由保持一致；`createCostCenterRouter` 函数签名同步接受一个 `_deps` 形参（当前路由未使用，仅为对齐），避免未来引入映射服务时再踩 `undefined` DI 隐患。

### v2.6 — 响应层 AD 名称全覆盖 + 整体账单汇总增强

- **账单超额费用改用 API 净额** — `routes/billing.js` 的 `/api/billing/summary` 中 `overageCost` 优先取 `premiumItem.netAmount`（与 GitHub 企业账单 API 口径一致，`grossAmount − discountAmount`），仅当 API 未返回 `netAmount` 时才 fallback 到本地公式（`overageRequests × unitPrice`）。响应新增 `netPremiumCost` / `localOverageCost` / `overageCostSource` 字段用于审计区分数据来源。
- **账单汇总支持历史月查询** — `/api/billing/summary` 新增 `?year=&month=` 查询参数；前端弹窗新增月份选择器（当月 + 过去 11 个月），按月切换无需刷新页面。
- **账单强制刷新** — 前端"整体账单汇总"弹窗新增"强制刷新"按钮，点击后传 `force=1`。后端在 `force` 模式下执行 `invalidateCacheByPrefix("/settings/billing/usage")` 清空该路径的 LRU 缓存，再回源 GitHub 拉取最新数据，跳过 3 分钟默认 TTL。
- **席位 API 响应层 adName 注入** — `routes/billing.js` 的 `/api/seats` 返回前对 `teamCache.seatsRaw` 做 `enrichSeatsWithAdName` 映射注入 `adName` 字段（不 mutate 缓存原数据、不动 `seats_snapshot` 表）。前端"用户席位"表第一列改为显示 `adName || login`，原始 `login` 保留为 tooltip。
- **Team 成员 adName 注入** — `routes/teams.js` 的 `/api/enterprise-teams/:teamId/members` 在 push 成员时通过 `userMappingService.getUserByGithub` 解析 `adName` 并纳入响应。前端 Teams 展开成员列表改为显示 `adName || login`，tooltip 保留原始 `login`。
- **Cost Center 用户资源 adName 注入** — `routes/costcenter.js` 新增 `enrichResourcesWithAdName` 函数，仅对 `type=user` 的资源注入 `adName` 字段，列表和详情接口统一走同一逻辑。前端 Resources 分组的 Users 标签改为优先显示 `adName`（回退 `name`），tooltip 保留原始 `name`。

### v2.4 — 趋势图数据一致性与全项目 UTC 时区统一

- **趋势图优先使用 `ranking` 聚合数据** — `routes/analytics.js` 的 `/api/analytics/trends` 路由改为优先从 SQLite 的 `ranking` 字段（`per-user-fallback` 模式下的逐用户聚合结果）累加每日请求量，不存在时 fallback 到 `data` 字段（GitHub API 原始响应）。修复了 `per-user-fallback` 模式下趋势图某天数据异常偏低的问题（此前仅 `top-users` 与 `daily-summary` 使用了 `ranking`，`trends` 未使用，导致三处数据不一致）。
- **全项目 UTC 时区一致性修复** — 统一将后端与前端代码中的 `getFullYear()` / `getMonth()` / `getDate()`（本地时间）替换为 `getUTCFullYear()` / `getUTCMonth()` / `getUTCDate()`（UTC 时间），消除东八区等非 UTC 时区下凌晨时段因本地/UTC 跨日不一致导致的日期范围偏差、年月错配等问题。涉及文件：
  - `routes/analytics.js`（3 处日期范围计算）
  - `routes/usage.js`（2 处默认年月与日期标签）
  - `routes/bill.js`（4 处账单周期、查询参数）
  - `routes/costcenter.js`（1 处计费年月）
  - `routes/billing.js`（1 处模型排行查询）
  - `public/script.js`（2 处前端默认年月）
  - `public/billpage.js`（1 处月份选择器默认值）

### v2.3 — 周期聚合数据完整性校验与 UTC 时区修复

- **`buildCycleFromSQLite` 三重完整性校验** — 为"本周期请求量"月度聚合增加数据可信度检查，任一检查不通过即降级到 GitHub API 月度查询兜底，避免本地缓存不完整导致"当日请求量 > 本周期请求量"的显示矛盾：
  1. **覆盖完整性**：查询范围内每一天在 SQLite 中均存在记录；
  2. **近端新鲜度**：最近 3 天的数据必须在 1 小时内刷新，且模式必须为 `per-user-fallback`（排除后台聚合尚未完成的中间态）；
  3. **Ranking 非空**：某天存在原始用量记录但 ranking 为空时视为聚合异常，拒绝使用该周期缓存。
- **修复月末天数 UTC 时区 bug** — 原 `new Date(year, month, 0).getUTCDate()` 在本地时区非 UTC 环境（如 CST/UTC+8）下会因跨日偏移导致月末天数少算一天（例如 4 月算成 29 天而非 30 天），进而漏掉最后一天数据。改为 `new Date(Date.UTC(year, month, 0)).getUTCDate()`，确保无论服务部署在哪个时区，月末天数计算始终正确。

### v2.2 — 数据新鲜度与刷新可靠性

- **`force=true` 强制回源参数** — `POST /api/usage/refresh` 新增 `force` 布尔参数，置 true 时同时跳过内存层 `refreshCache` 与 SQLite TTL 检查，直接调用 GitHub API 并覆盖写入；single-flight 去重仍生效，不会因并发触发重复调用
- **动态 TTL 抖动防护** — `daily_usage` 表的缓存有效期由固定 90 天调整为分段策略：距今 ≤ 3 天的日期使用 1 小时 TTL，更老的日期沿用 90 天 TTL。彻底避免 GitHub Billing API 的 24–48 小时延迟期写入空/不完整数据后被长期缓存锁死
- **内置自动刷新调度器** — 新增 `lib/scheduler.js`，基于 `setTimeout` 自重排实现轻量级调度（不引入新依赖）。默认开启，启动后强制刷新当天数据，每天 03:00 与 12:00 自动强制刷新今天 + 最近 N 天（默认 N=2）。失败仅记录 warn，不影响主流程
- **调度器可配置** — 新增 `SCHED_DISABLED` / `SCHED_DAILY_TIMES` / `SCHED_BACKFILL_DAYS` / `SCHED_STARTUP_DELAY_MS` 四项环境变量，多副本部署时可在非主副本设置 `SCHED_DISABLED=true` 防止重复调用 GitHub
- **按月强制刷新接口** — 新增 `POST /api/bill/refresh`：删除该月所有 `daily_usage` 与 `monthly_bill` 记录后，按 `GITHUB_MAX_CONCURRENT` 节流并发逐日回源，重新计算 Team 月度账单。返回 `refreshedDays` 与 `failedDates` 用于观测
- **`/billpage` 强制刷新按钮** — 账单页新增“强制刷新”按钮：二次 `confirm` 确认后调用上述接口，UI 显示刷新天数与失败日期列表，作为缓存错误、空数据写入、API 数据延迟等问题的兜底解决方案
- **账单页改为隐式入口** — 主页不再展示“Team 月度账单”按钮，需通过手动访问 `/billpage` 进入。后端路由保持不变
- **优雅关闭增强** — `gracefulShutdown` 流程新增 `scheduler.stop()` 调用，清理待执行的定时器，避免进程退出时仍有挂起任务

### v2.1 — 日志体系增强

- **五级日志级别** — pino 日志支持 trace < debug < info < warn < error，按级别输出不同详细程度
- **结构化访问日志** — HTTP 中间件自动记录访问时间、来源 IP、来源主机名、访问页面、业务动作、成功/失败、HTTP 状态码、响应时间(ms)
- **URL-to-Action 映射** — 将 API 路径映射为语义化动作标签（如 `refresh_usage`、`get_seats`、`health_check`）
- **敏感信息自动脱敏** — 日志红字过滤自动遮蔽 Authorization Header、Token、Password、Secret 字段，输出 `[REDACTED]`
- **自定义序列化器** — 请求日志提取 `remoteAddress`/`remoteHostname`/`userAgent`，错误日志捕获完整堆栈追踪
- **Debug 级缓存追踪** — GitHub API LRU 缓存命中/未命中、ETag 条件请求、In-flight 去重、SQLite 缓存命中均输出 debug 日志
- **错误日志增强** — 全局错误中间件输出完整访问上下文（IP、主机名、动作），便于故障定位
- **dotenv 加载顺序修复** — 将 `dotenv.config()` 移至 `server.js` 入口首行，确保 `LOG_LEVEL` 等环境变量在模块初始化前就绪

**日志级别策略：**

| 级别 | 使用场景 | 示例输出 |
|------|----------|----------|
| `trace` | 完整请求/响应体、SQL 语句、GitHub API 原始响应 | （需手动设置 `LOG_LEVEL=trace`） |
| `debug` | 缓存命中/未命中、ETag 条件请求、In-flight 去重、重试次数 | `LRU cache hit`、`ETag conditional request` |
| `info` | HTTP 访问日志（默认生产级别） | 访问时间、IP、页面、动作、成功与否、响应时间 |
| `warn` | API 速率限制接近阈值、重试等待、非关键性恢复 | `GitHub API retry` |
| `error` | 未捕获异常、GitHub API 失败、数据库错误、堆栈追踪 | `Unhandled route error` + stack |

**新增环境变量：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOG_LEVEL` | 开发: `debug` / 生产: `info` | 控制日志输出级别，可选 `trace`、`debug`、`info`、`warn`、`error` |

**开发环境日志示例（`LOG_LEVEL=debug`）：**

```
2026-04-28 21:06:00 INFO: Dashboard running (port=3000)
2026-04-28 21:06:05 INFO: {"time":"2026-04-28T13:06:05Z","remoteAddress":"192.168.1.100","remoteHostname":"unknown","method":"GET","url":"/api/usage","action":"get_usage","success":true,"statusCode":200,"responseTime":12}
2026-04-28 21:06:05 DEBUG: LRU cache hit (pathname=/enterprises/.../copilot/billing/seats)
```

**生产环境日志示例（`LOG_LEVEL=info`）：**

```json
{"level":"info","time":"2026-04-28T13:06:05Z","time":"2026-04-28T13:06:05.000Z","remoteAddress":"192.168.1.100","remoteHostname":"unknown","method":"GET","url":"/api/usage","action":"get_usage","success":true,"statusCode":200,"responseTime":12}
```

### v2 — 架构重构

- **模块化拆分** — `server.js` 从 ~1950 行精简为 ~100 行入口文件，业务逻辑拆分为 7 个路由模块 + 6 个 lib 模块
- **结构化日志** — 引入 pino 日志框架，开发模式 pretty 输出，生产模式 JSON 格式
- **优雅关闭** — SIGTERM/SIGINT 信号处理，10 秒超时强制退出，确保数据库连接正确释放
- **全局错误处理** — Express 错误中间件 + uncaughtException/unhandledRejection 兜底
- **健康检查** — 新增 `/api/health` 端点，便于监控和负载均衡探测
- **LRU 缓存** — GitHub API GET 缓存从 Map 升级为 LRU Cache（max=500），防止内存无限增长
- **SQLite 预编译语句** — 所有查询在构造时 `db.prepare()`，运行时直接执行，减少 SQL 解析开销
- **席位快照清理** — 自动保留最近 20 条快照，避免数据库膨胀
- **文件监听优化** — `fs.watchFile` 轮询改为 `fs.watch` + debounce（300ms），降低 CPU 开销
- **前端 IIFE 封装** — 所有页面脚本包裹在 IIFE 中，消除全局变量污染
- **前端公共模块** — 提取 `common.js` 共享函数（CopilotDashboard 命名空间），消除跨页面代码重复
- **首屏加载优化** — 合并首屏双请求为单次 POST，结合 localStorage 缓存实现秒开
- **数据新鲜度提示** — 分析页显示数据加载时间徽章（新鲜/老化/陈旧三级），30 秒自动更新
- **单元测试** — 引入 vitest 框架，覆盖 date-utils / billing-config / helpers 三个纯函数模块（34 个用例）
- **边界修复** — `toNumber()` 修复 NaN/Infinity 输入返回 0 而非透传

### v1 — 初始版本

- **三层缓存架构** — 引入 SQLite 持久缓存（better-sqlite3），缓存层级从"内存 → GitHub"扩展为"内存（5 分钟） → SQLite（90 天） → GitHub"，API 调用量减少约 97%
- **ETag 条件请求** — 自动缓存 GitHub API 的 ETag 响应头，数据未变化时返回 304 Not Modified，不消耗 rate limit
- **数据分析页面** — 新增 `/analytics` 页面，支持用量趋势图、Top 用户排行柱状图、汇总统计卡片，统计周期可选 30 天 / 90 天 / 1 年
- **缓存命中率展示** — 刷新后页面顶部显示缓存命中百分比
- **Cycle 月度汇总优化** — "按日期查询"中的"本周期请求量"从 SQLite 已有数据聚合，避免每次刷新都触发 per-user fallback
- **并发请求合并（In-flight Dedup）** — 多个浏览器标签页同时刷新时自动复用同一 Promise，防止重复的 per-user fallback
- **排名数据持久化** — `daily_usage.ranking` 列存储 per-user 排名，Analytics 页面纯本地读取，响应 < 10ms
- **用户名映射一致性** — Analytics Top 用户遵循与主页面相同的 AD 名称映射规则（已映射显示 AD 名，未映射显示 GitHub 名）
- **数据分析页缓存** — 所有分析 API 均从 SQLite 读取，不直接调用 GitHub

## License

MIT
