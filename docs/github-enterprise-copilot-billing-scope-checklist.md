# GitHub Enterprise Copilot Billing API 权限 Scope 核对表

本文用于上线前快速校验：
- 账号角色是否满足
- Token 类型是否被端点支持
- classic PAT scope 是否满足最小权限

说明：
- 以下以 Enterprise Cloud REST API（2026-03-10）为参考。
- 很多 Billing / Cost Center / Budget 企业级端点不支持 fine-grained PAT 或 GitHub App token，优先使用 PAT classic。

---

## 一、推荐基线（可覆盖大多数只读场景）

- 账号角色：Enterprise owner 或 Billing manager
- Token 类型：PAT classic
- 建议 scope：manage_billing:copilot + read:enterprise

如果涉及写操作（创建/更新/删除、分配座位、预算变更），通常还需要更高管理权限（如 admin:enterprise 或对应组织级 admin:org）。

---

## 二、Copilot Usage Metrics 报表接口

| 接口 | 用途 | 账号角色 | PAT classic scope（常见） | Fine-grained / App token |
|---|---|---|---|---|
| GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest | 企业级 28 天聚合指标下载链接 | Enterprise owner / Billing manager / 授权用户 | manage_billing:copilot 或 read:enterprise | 支持（需 Enterprise Copilot metrics: read） |
| GET /enterprises/{enterprise}/copilot/metrics/reports/users-28-day/latest | 企业级 28 天用户指标下载链接 | Enterprise owner / Billing manager / 授权用户 | manage_billing:copilot 或 read:enterprise | 支持（需 Enterprise Copilot metrics: read） |
| GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-1-day?day=YYYY-MM-DD | 企业级指定日期聚合指标 | 同上 | 同上 | 支持 |
| GET /enterprises/{enterprise}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD | 企业级指定日期用户指标 | 同上 | 同上 | 支持 |

备注：
- 返回的是 download_links（签名 URL），需要二次下载。
- 这些接口依赖企业策略中 Copilot usage metrics 功能已启用。

---

## 三、Copilot Seat / User Management（活跃状态相关）

| 接口 | 用途 | 账号角色 | PAT classic scope（常见） | Fine-grained / App token |
|---|---|---|---|---|
| GET /enterprises/{enterprise}/copilot/billing/seats | 获取企业全部 Copilot 座位与最近活跃 | Enterprise owner / Billing manager | manage_billing:copilot 或 read:enterprise | 不支持（文档标注不支持 FG/App） |
| GET /enterprises/{enterprise}/members/{username}/copilot | 获取企业单用户 Copilot seat 详情 | Enterprise owner | manage_billing:copilot 或 read:org | 不支持（文档标注不支持 FG/App） |
| POST /enterprises/{enterprise}/copilot/billing/selected_users | 给企业用户分配 Copilot seat | Enterprise owner | manage_billing:copilot 或 admin:enterprise | 不支持（文档标注不支持 FG/App） |
| DELETE /enterprises/{enterprise}/copilot/billing/selected_users | 回收企业用户 seat（pending cancellation） | Enterprise owner | manage_billing:copilot 或 admin:enterprise | 不支持（文档标注不支持 FG/App） |
| POST /enterprises/{enterprise}/copilot/billing/selected_enterprise_teams | 给企业团队分配 seat | Enterprise owner | manage_billing:copilot 或 admin:enterprise | 不支持（文档标注不支持 FG/App） |
| DELETE /enterprises/{enterprise}/copilot/billing/selected_enterprise_teams | 回收企业团队 seat | Enterprise owner | manage_billing:copilot 或 admin:enterprise | 不支持（文档标注不支持 FG/App） |

备注：
- last_activity_at 依赖 IDE telemetry，上报关闭时可能不完整。

---

## 四、Billing Usage（高级模型 / Premium Request）

| 接口 | 用途 | 账号角色 | PAT classic scope（常见） | Fine-grained / App token |
|---|---|---|---|---|
| GET /enterprises/{enterprise}/settings/billing/premium_request/usage | 查询高级模型请求与金额（支持 user/org/model/product/cost_center 过滤） | Enterprise owner / Billing manager | manage_billing:copilot 或 read:enterprise | 不支持（文档标注不支持 FG/App） |
| GET /enterprises/{enterprise}/settings/billing/usage | 查询企业使用明细（含 cost center 维度） | Enterprise owner / Billing manager | read:enterprise（建议配 manage_billing:copilot） | 不支持（文档标注不支持 FG/App） |
| GET /enterprises/{enterprise}/settings/billing/usage/summary | 查询企业使用汇总 | Enterprise owner / Billing manager | read:enterprise（建议配 manage_billing:copilot） | 不支持（文档标注不支持 FG/App） |

备注：
- premium_request/usage 与 usage/summary 通常可查最近 24 个月窗口内数据（按文档说明）。

---

## 五、Cost Centers（企业计费增强能力）

| 接口 | 用途 | 账号角色 | PAT classic scope（建议） | Fine-grained / App token |
|---|---|---|---|---|
| GET /enterprises/{enterprise}/settings/billing/cost-centers | 列出 cost center | Enterprise owner / Billing manager / Org owner | read:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| POST /enterprises/{enterprise}/settings/billing/cost-centers | 创建 cost center | Enterprise owner | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| GET /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id} | 查询 cost center 详情 | Enterprise owner / Billing manager / Org owner | read:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| PATCH /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id} | 更新 cost center 名称 | Enterprise owner | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id} | 删除（归档）cost center | Enterprise owner | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| POST /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource | 添加 users/orgs/repos 到 cost center | Enterprise owner | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| DELETE /enterprises/{enterprise}/settings/billing/cost-centers/{cost_center_id}/resource | 从 cost center 移除资源 | Enterprise owner | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |

---

## 六、Budgets（含 cost center scope）

| 接口 | 用途 | 账号角色 | PAT classic scope（建议） | Fine-grained / App token |
|---|---|---|---|---|
| GET /enterprises/{enterprise}/settings/billing/budgets | 列出预算（可按 scope 过滤） | Enterprise owner / Billing manager | read:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| POST /enterprises/{enterprise}/settings/billing/budgets | 创建预算 | Enterprise owner / Org admin / Billing manager | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| GET /enterprises/{enterprise}/settings/billing/budgets/{budget_id} | 查询预算详情 | Enterprise owner / Billing manager | read:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| PATCH /enterprises/{enterprise}/settings/billing/budgets/{budget_id} | 更新预算 | Enterprise owner / Org admin / Billing manager | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |
| DELETE /enterprises/{enterprise}/settings/billing/budgets/{budget_id} | 删除预算 | Enterprise owner | admin:enterprise（建议） | 不支持（文档标注不支持 FG/App） |

---

## 七、上线前权限核对步骤（建议执行）

1. 确认账号角色：是否为 Enterprise owner 或 Billing manager。
2. 确认 token 类型：优先 PAT classic。
3. 确认 PAT classic scopes：
   - 只读看板：manage_billing:copilot + read:enterprise
   - 含写操作：补充 admin:enterprise（组织级接口补充 admin:org）
4. 确认企业能力：Enhanced Billing、Copilot usage metrics policy 已启用。
5. 用最小探活接口验证：
   - GET /enterprises/{enterprise}/copilot/billing/seats
   - GET /enterprises/{enterprise}/settings/billing/premium_request/usage
   - GET /enterprises/{enterprise}/settings/billing/cost-centers
   - GET /enterprises/{enterprise}/settings/billing/budgets

---

## 八、参考文档

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
