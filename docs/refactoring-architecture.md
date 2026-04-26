# v2 重构架构设计文档

> 本文档记录项目从单体架构到模块化分层架构的重构思路、技术决策及实施方案。

## 一、重构背景与动机

### 1.1 原有架构问题

项目在 v1 阶段将全部后端逻辑（路由定义、GitHub API 调用、数据聚合、缓存管理、文件上传处理等）集中在单一 `server.js` 文件中，达到约 1950 行。前端同样存在跨页面函数重复、全局变量污染等问题。

| 维度 | 问题描述 |
| --- | --- |
| **可维护性** | 单文件 1950+ 行，职责混杂，新增功能或修复 Bug 时认知负担高 |
| **可测试性** | 业务逻辑与 Express 路由耦合，无法对纯函数进行单元测试 |
| **可靠性** | 无优雅关闭机制，进程被杀时数据库连接可能未正确释放 |
| **性能** | SQLite 查询未使用预编译语句；内存缓存使用 Map 无上限；文件监听使用轮询模式 |
| **代码复用** | 前端 4 个 JS 文件中 `escapeHtml`、`setError`、`apiFetchJson` 等函数重复定义 |
| **可观测性** | 日志使用 `console.log`，无结构化输出，生产环境难以对接日志采集系统 |

### 1.2 重构目标

- **不改变外部行为**：所有 API 端点、页面路由、前端交互保持兼容
- **模块化分层**：按职责拆分为入口 → 路由 → 服务 → 数据四层
- **可测试**：纯函数模块可独立单元测试
- **生产就绪**：优雅关闭、健康检查、结构化日志、全局错误兜底

## 二、架构设计

### 2.1 分层架构总览

```
┌─────────────────────────────────────────────┐
│                 server.js                   │
│  Express 入口 (~100 行)                      │
│  • 挂载路由  • 优雅关闭  • 全局错误处理         │
│  • 健康检查  • 进程信号捕获                    │
├─────────────────────────────────────────────┤
│              routes/*.js                     │
│  Express Router 模式，每个路由模块为工厂函数     │
│  接收依赖注入 → 返回 Router 实例               │
│  usage | billing | teams | costcenter        │
│  analytics | user-mapping | seats (shared)    │
├─────────────────────────────────────────────┤
│               lib/*.js                       │
│  github-api   – API 基础设施 (LRU/ETag/重试)  │
│  usage-store  – SQLite 数据层 (预编译语句)      │
│  user-mapping – 文件映射服务 (fs.watch)         │
│  billing-config / date-utils / helpers        │
│  logger       – pino 结构化日志                │
├─────────────────────────────────────────────┤
│             public/*.js                      │
│  common.js   – CopilotDashboard 命名空间      │
│  各页面脚本   – IIFE 封装，引用 common.js       │
└─────────────────────────────────────────────┘
```

### 2.2 后端模块划分原则

| 原则 | 说明 |
| --- | --- |
| **单一职责** | 每个路由文件只处理一个功能域的 HTTP 端点 |
| **依赖注入** | 路由模块导出工厂函数 `module.exports = function(deps) { ... }`，由 server.js 统一注入 `usageStore`、`teamCache`、`userMappingService` 等单例 |
| **避免循环依赖** | `billing-config`、`date-utils`、`helpers` 为纯函数模块，不依赖任何有状态模块 |
| **共享模块** | `routes/seats.js` 作为非路由的共享逻辑模块，被 `usage.js` 和 `billing.js` 复用 |

### 2.3 前端模块划分

```
common.js (IIFE → CopilotDashboard 全局命名空间)
  ├── escapeHtml / formatTs / setError
  ├── apiFetchJson (含 rate limit 友好提示)
  ├── toNumber / formatUsd
  ├── renderSkeletonRows / setMetaRefreshing
  └── getCachedData / setCachedData (localStorage 封装)

script.js / costcenter.js / analytics.js / user.js
  └── 各自 IIFE 内部通过 var C = CopilotDashboard; 引用公共函数
```

**设计决策**：选择 IIFE + 命名空间而非 ES Module，因为项目前端无构建工具（无 Webpack/Vite），需要直接在浏览器中通过 `<script>` 标签加载。IIFE 是零配置消除全局变量污染的最佳方案。

## 三、关键技术决策

### 3.1 结构化日志 — pino

**选择理由**：
- pino 是 Node.js 生态中性能最高的日志库（JSON 序列化零开销设计）
- 开发模式自动启用 `pino-pretty` 人类可读格式
- 生产模式输出 JSON，可直接对接 ELK / Loki 等日志采集系统
- 支持子 logger（`logger.child({ module: "xxx" })`），便于按模块追踪

**实现**：
```javascript
// lib/logger.js
const pino = require("pino");
const isDev = process.env.NODE_ENV !== "production";
module.exports = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  ...(isDev && { transport: { target: "pino-pretty", options: { colorize: true } } }),
});
```

### 3.2 GitHub API 服务层 — LRU + ETag + 并发控制

**问题**：原始实现使用 `Map` 作为缓存，无上限限制，长期运行有内存泄漏风险。

**方案**：
- 引入 `lru-cache`（v10），设置 `max: 500` 条目上限
- ETag 条件请求减少 API 配额消耗
- 并发队列（默认 max=3）防止触发 GitHub Secondary Rate Limit
- 指数退避重试（默认 3 次，初始 1s → 2s → 4s）
- Single-flight 去重：相同 URL 的并发请求自动合并为一个 Promise

```
请求流程:
  GET /api/xxx
    → 检查 LRU 缓存 (内存)
    → 检查 ETag 缓存 → 发送 If-None-Match
    → 304: 返回缓存  /  200: 更新缓存
    → 429/5xx: 指数退避重试
    → 并发队列等待 slot
    → single-flight 复用已有 Promise
```

### 3.3 SQLite 预编译语句

**问题**：每次查询都调用 `db.prepare(sql).get(params)`，重复解析 SQL 字符串。

**方案**：在 `UsageStore` 构造函数中一次性 prepare 所有语句：

```javascript
this._stmts = {
  getDay:    this.db.prepare("SELECT ... WHERE year=? AND month=? AND day=?"),
  upsertDay: this.db.prepare("INSERT OR REPLACE INTO daily_usage ..."),
  getEtag:   this.db.prepare("SELECT ... FROM etag_cache WHERE cache_key=?"),
  // ...
};
```

运行时直接调用 `this._stmts.getDay.get(year, month, day)`，避免重复编译。

### 3.4 文件监听优化 — fs.watch + debounce

**问题**：`fs.watchFile` 使用轮询机制（默认间隔 5007ms），CPU 开销大且延迟高。

**方案**：
- 改用 `fs.watch`（基于操作系统 inotify/FSEvents 事件驱动）
- 添加 300ms debounce，防止文件保存时触发多次 reload
- 原子化 reload：先构建完整的新 Map，再整体赋值 `this.userMap = newMap`，避免中间状态
- watcher 错误时优雅降级，不影响服务继续运行

### 3.5 优雅关闭

**实现要点**：
1. 监听 `SIGTERM` 和 `SIGINT` 信号
2. 调用 `server.close()` 停止接收新连接
3. 等待进行中的请求完成
4. 关闭 SQLite 数据库和文件 watcher
5. 设置 10 秒超时强制退出，防止连接泄漏导致进程挂起

```javascript
function gracefulShutdown(signal) {
  logger.info({ signal }, "Received signal, shutting down...");
  server.close(() => {
    try { usageStore.close(); } catch {}
    try { userMappingService.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
```

### 3.6 全局错误处理

三层防护：
1. **Express 错误中间件**：捕获路由处理函数中的同步/异步错误，返回统一 JSON 错误响应
2. **`uncaughtException`**：记录未捕获异常后退出（Node.js 文档推荐做法）
3. **`unhandledRejection`**：记录未处理的 Promise 拒绝

### 3.7 前端首屏加载优化

**问题**：原实现首屏发两个请求——先 GET 加载缓存数据，再 POST 触发刷新。

**优化方案**：
1. 优先从 localStorage 读取缓存数据（5 分钟 TTL），有缓存则立即渲染
2. 无论是否有缓存，统一只发一个 POST `/api/usage/refresh` 后台刷新
3. 刷新完成后更新页面和 localStorage 缓存

效果：首屏从 2 个请求减少为 1 个，有缓存时实现"秒开"。

### 3.8 数据新鲜度提示

分析页面新增数据新鲜度徽章，每 30 秒自动更新：

| 状态 | 条件 | 样式 |
| --- | --- | --- |
| 新鲜 | < 2 分钟 | 绿色 `✓ 已是最新` |
| 老化 | 2–10 分钟 | 黄色 `N 分钟前加载` |
| 陈旧 | > 10 分钟 | 红色 `⚠ N 分钟前加载，建议刷新` |

## 四、席位快照清理策略

**问题**：`seats_snapshot` 表随时间无限增长。

**方案**：每次写入新快照后，自动删除超出最近 20 条的旧记录：

```sql
DELETE FROM seats_snapshot
WHERE id NOT IN (SELECT id FROM seats_snapshot ORDER BY fetched_at DESC LIMIT 20)
```

## 五、测试策略

### 5.1 测试框架选择

选择 **vitest** 作为测试框架：
- 与 Vite 生态一致，零配置即可运行
- 兼容 Jest API，学习成本低
- 执行速度快（~250ms 完成 34 个用例）

### 5.2 测试覆盖范围

| 模块 | 测试文件 | 用例数 | 覆盖内容 |
| --- | --- | --- | --- |
| `date-utils` | `test/date-utils.test.js` | 13 | 日期解析、日期枚举、日期键构建、边界条件 |
| `billing-config` | `test/billing-config.test.js` | 9 | 计划配置结构、费用计算（额度内/超额/未知计划） |
| `helpers` | `test/helpers.test.js` | 12 | 数值转换、用户名提取（多种字段/嵌套对象/空值） |

### 5.3 测试原则

- 优先测试**纯函数模块**（无副作用、无外部依赖）
- 每个函数覆盖**正常路径 + 边界条件 + 异常输入**
- 测试用例发现了 `toNumber(NaN)` 返回 NaN 的 bug，已同步修复

## 六、重构前后对比

| 指标 | 重构前 | 重构后 |
| --- | --- | --- |
| `server.js` 行数 | ~1950 行 | ~100 行 |
| 后端模块数 | 3 个文件 | 15 个文件（7 路由 + 7 lib + 1 入口） |
| 前端公共函数 | 各文件重复定义 | 统一 `common.js` 模块 |
| 全局变量污染 | 存在 | IIFE 消除 |
| 日志系统 | `console.log` | pino 结构化日志 |
| API 缓存 | `Map`（无上限） | LRU Cache（max=500） |
| SQLite 查询 | 每次 `prepare()` | 预编译语句复用 |
| 文件监听 | `fs.watchFile`（轮询） | `fs.watch`（事件驱动）+ debounce |
| 优雅关闭 | 无 | SIGTERM/SIGINT + 10s 超时 |
| 全局错误处理 | 无 | 三层防护 |
| 健康检查 | 无 | `/api/health` |
| 单元测试 | 无 | 34 个用例（vitest） |
| 首屏请求数 | 2 个 | 1 个 |

## 七、依赖变更

### 新增生产依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `pino` | ^9.6.0 | 结构化日志 |
| `pino-pretty` | ^13.0.0 | 开发模式日志美化 |
| `lru-cache` | ^10.4.3 | 有界内存缓存 |

### 新增开发依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `vitest` | ^3.1.3 | 单元测试框架 |

## 八、后续优化方向

以下为本次重构范围外、可在后续迭代中考虑的改进：

1. **安全加固**：添加 Helmet 中间件、CSRF 防护、API 认证鉴权
2. **前端构建工具链**：引入 Vite 实现 Tree-shaking、代码分割、资源指纹
3. **集成测试**：使用 supertest 对 API 端点进行集成测试
4. **CI/CD 流水线**：自动化测试 + 代码质量检查 + 自动部署
5. **容器化部署**：提供 Dockerfile 和 docker-compose 配置
6. **监控告警**：接入 Prometheus metrics 或 OpenTelemetry 链路追踪
