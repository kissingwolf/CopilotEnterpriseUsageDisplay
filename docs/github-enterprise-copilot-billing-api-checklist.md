# GitHub Enterprise Copilot & Billing 集成清单

本文档汇总了当前项目后续扩展所需的 API 设计清单、字段映射、环境变量建议和实施顺序，覆盖以下能力：

1. Copilot 28 天指标下载与解析
2. Copilot Seat 最近活跃状态
3. Enterprise 高级模型（Premium Request）计费用量
4. Cost Center 管理
5. Budget 管理（含 cost center scope）

---

## 一、后端 API 设计清单（建议）

### 1) Copilot 指标报表下载与解析

- 接口：`GET /api/copilot/metrics/users-28d`
- 行为：优先返回缓存；缓存失效自动刷新
- 数据来源：
  - `GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest`
- 处理流程：
  1. 调 GitHub API 获取 `download_links`
  2. 下载链接中的 JSON 文件
  3. 合并并标准化为统一 `users_metrics_28d` 结构
  4. 写入本地缓存（内存或文件）
- 可选参数：`force=true`（强制刷新）
- 建议返回：`report_start_day`, `report_end_day`, `users[]`

### 2) 指定日期用户指标（可选）

- 接口：`GET /api/copilot/metrics/users-1d?day=YYYY-MM-DD`
- 数据来源：
  - `GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day?day=...`
- 用途：定位某一天的异常峰值与回归

### 3) Copilot Seat 活跃信息

- 接口：`GET /api/copilot/seats/activity`
- 数据来源：
  - `GET /enterprises/{enterprise}/copilot/billing/seats`
- 关键字段：
  - `last_activity_at`
  - `last_activity_editor`
  - `last_authenticated_at`
  - `plan_type`
  - `assigning_team`
- 建议后端计算字段：
  - `active_status`（active/inactive）
  - `inactive_days`

### 4) 高级模型用量（计费口径）

- 接口：`GET /api/billing/premium/models?year=&month=&day=&team=&user=&cost_center_id=`
- 数据来源：
  - `GET /enterprises/{enterprise}/settings/billing/premium_request/usage`
- 建议处理：
  - 按 `model` 聚合 `requests / amount`
  - 支持 `user/team` 二次聚合与筛选

### 5) Cost Center 管理

- 列表：`GET /api/billing/cost-centers`
- 创建：`POST /api/billing/cost-centers`
- 详情：`GET /api/billing/cost-centers/:id`
- 更新名称：`PATCH /api/billing/cost-centers/:id`
- 删除：`DELETE /api/billing/cost-centers/:id`
- 添加资源：`POST /api/billing/cost-centers/:id/resources`
- 移除资源：`DELETE /api/billing/cost-centers/:id/resources`
- 对应 GitHub 端点：`/enterprises/{enterprise}/settings/billing/cost-centers` 系列

### 6) Budget 管理（含 cost center）

- 列表：`GET /api/billing/budgets?scope=cost_center|enterprise|organization|repository`
- 创建：`POST /api/billing/budgets`
- 详情：`GET /api/billing/budgets/:id`
- 更新：`PATCH /api/billing/budgets/:id`
- 删除：`DELETE /api/billing/budgets/:id`
- 关键字段：
  - `budget_scope`（支持 `cost_center`）
  - `budget_entity_name`
  - `budget_amount`
  - `prevent_further_usage`
  - `budget_alerting`

---

## 二、统一响应结构建议

### 成功

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "source": "github",
    "fetchedAt": "2026-04-23T12:34:56Z",
    "cached": true,
    "cacheTtlSec": 300
  }
}
```

### 失败

```json
{
  "ok": false,
  "error": {
    "code": "GITHUB_403",
    "message": "Forbidden",
    "details": {}
  }
}
```

---

## 三、环境变量补充建议

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `METRICS_CACHE_TTL` | `3600` | Copilot metrics 报表缓存时长（秒） |
| `METRICS_DOWNLOAD_TIMEOUT_MS` | `15000` | 指标下载链接请求超时（毫秒） |
| `METRICS_MAX_DOWNLOAD_LINKS` | `10` | 单次最多下载链接数量 |
| `ACTIVITY_INACTIVE_DAYS` | `7` | 活跃/非活跃阈值天数 |
| `PREMIUM_USAGE_CACHE_TTL` | `300` | Premium usage 缓存时长（秒） |
| `COST_CENTER_CACHE_TTL` | `300` | Cost center 缓存时长（秒） |
| `BUDGET_CACHE_TTL` | `300` | Budget 缓存时长（秒） |

---

## 四、前端字段映射表

### 1) 用户活跃与使用总览

| 前端字段 | 后端字段 | GitHub 来源字段 | 说明 |
|---|---|---|---|
| 用户 | `user.login` | `assignee.login` | 用户名 |
| Team | `user.team` | `assigning_team.name` | 无则显示 `-` |
| 最近活跃时间 | `user.lastActivityAt` | `last_activity_at` | 依赖 IDE telemetry |
| 最近活跃客户端 | `user.lastActivityEditor` | `last_activity_editor` | 例如 `vscode/...` |
| 活跃状态 | `user.activeStatus` | 推导 | 基于阈值天数 |
| 28 天活跃天数 | `user.activeDays28d` | users metrics 聚合 | 报表解析得到 |
| 28 天请求量 | `user.requests28d` | users metrics 聚合 | 指标口径 |
| 高级模型请求量 | `user.premiumRequests` | premium usage + user filter | 计费口径 |
| 高级模型金额 | `user.premiumAmount` | `netAmount/grossAmount` 聚合 | 美元 |

### 2) 模型使用排行

| 前端字段 | 后端字段 | GitHub 来源字段 |
|---|---|---|
| 模型 | `model.name` | `usageItems[].model` |
| 请求量 | `model.requests` | `usageItems[].netQuantity/grossQuantity` |
| 金额 | `model.amount` | `usageItems[].netAmount/grossAmount` |
| 占比 | `model.percentage` | 后端聚合计算 |

### 3) Cost Center 管理

| 前端字段 | 后端字段 | GitHub 来源字段 |
|---|---|---|
| Cost Center ID | `costCenter.id` | `id` |
| 名称 | `costCenter.name` | `name` |
| 状态 | `costCenter.state` | `state` |
| 资源数 | `costCenter.resourceCount` | `resources.length` |
| 资源明细 | `costCenter.resources` | `resources[]` |

### 4) Budget 监控

| 前端字段 | 后端字段 | GitHub 来源字段 |
|---|---|---|
| Budget ID | `budget.id` | `id` |
| Scope | `budget.scope` | `budget_scope` |
| Scope 实体 | `budget.entityName` | `budget_entity_name` |
| 预算金额 | `budget.amount` | `budget_amount` |
| 是否超限阻断 | `budget.preventFurtherUsage` | `prevent_further_usage` |
| 告警开关 | `budget.willAlert` | `budget_alerting.will_alert` |
| 告警接收人 | `budget.recipients` | `budget_alerting.alert_recipients` |

---

## 五、权限与令牌检查清单（上线前）

1. Token 是否可访问 Copilot metrics 报表端点
2. 账号是否具备 enterprise owner 或 billing manager 权限
3. Enterprise policy 中是否启用 Copilot usage metrics
4. 企业是否已启用 Enhanced Billing（cost centers / budgets 相关）

---

## 六、建议实施顺序（低风险）

1. 接入 `users-28-day` 报表下载与解析（只读）
2. 融合 seats 活跃字段，输出用户健康度
3. 接入 premium model 计费聚合
4. 接入 cost center + budget 的管理接口
5. 前端增加预算风险看板（75/90/100 阈值）

---

## 七、文档来源（官方）

- Copilot usage metrics:
  - https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-usage-metrics?apiVersion=2026-03-10
- Copilot user management:
  - https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-user-management?apiVersion=2026-03-10
- Billing usage:
  - https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage?apiVersion=2026-03-10
- Cost centers:
  - https://docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers?apiVersion=2026-03-10
- Budgets:
  - https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets?apiVersion=2026-03-10
