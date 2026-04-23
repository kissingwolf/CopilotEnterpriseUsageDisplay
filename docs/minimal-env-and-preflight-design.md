# 最小权限 .env 模板 + 启动前自动自检脚本设计说明

## 1. 最小权限 .env 模板

说明：
- 此模板以“只读看板能力”作为最小集。
- Token 推荐使用 PAT classic，并确保具备最小 scope（见下方说明）。
- 不在仓库中保存真实 Token。

```env
# ===== Required =====
GITHUB_TOKEN=ghp_xxx_replace_me
ENTERPRISE_SLUG=your-enterprise-slug

# ===== Optional but recommended =====
GITHUB_API_BASE=https://api.github.com
PORT=3000

# Dashboard behavior
CACHE_TTL=300
INCLUDED_QUOTA=300

# Optional query defaults
PRODUCT=Copilot
MODEL=
```

## 2. Token 最小权限建议

用于“只读看板”建议最小 scope：

1. `manage_billing:copilot`
2. `read:enterprise`

如果后续要做写操作（例如创建预算、维护 cost center、调整 seat）：

1. 增加 `admin:enterprise`
2. 组织级写操作补充 `admin:org`

## 3. 启动前自动自检脚本设计说明

### 3.1 目标

在服务启动前快速判断“是否可用”，避免应用启动后才报 401/403/404。

### 3.2 建议文件

1. `scripts/preflight-check.sh`（Shell 版，CI/服务器都可直接跑）
2. `scripts/preflight-check.js`（Node 版，可复用项目里统一请求头和日志）

推荐先实现 Shell 版，后续再升级到 Node 版。

### 3.3 检查项（按顺序）

1. 基础环境变量检查
- 是否存在：`GITHUB_TOKEN`、`ENTERPRISE_SLUG`
- 可选变量是否为合法数值：`CACHE_TTL`、`INCLUDED_QUOTA`、`PORT`

2. DNS 与网络连通性检查
- 目标：`api.github.com`（或 `GITHUB_API_BASE` 指定域名）
- 检查：DNS 解析、443 端口可达

3. Token 基本有效性检查
- 调用：`GET /user` 或 `GET /meta`
- 期望：返回 200

4. Enterprise 基础权限检查（只读）
- 调用：`GET /enterprises/{enterprise}/copilot/billing/seats`
- 期望：200；若 403，提示“角色或 scope 不足”

5. Premium usage 检查
- 调用：`GET /enterprises/{enterprise}/settings/billing/premium_request/usage?year=YYYY&month=M`
- 期望：200

6. Cost center 能力探测（可选）
- 调用：`GET /enterprises/{enterprise}/settings/billing/cost-centers`
- 若 404：提示“未启用增强计费平台或功能不可用”

7. Budget 能力探测（可选）
- 调用：`GET /enterprises/{enterprise}/settings/billing/budgets`
- 若 404：提示“预算能力未启用”

### 3.4 输出规范

建议统一输出为三类：

1. `PASS`：检查通过
2. `WARN`：可启动但功能受限
3. `FAIL`：禁止启动

示例：

```text
[PASS] ENV: required vars present
[PASS] NET: api.github.com reachable
[PASS] AUTH: token valid
[PASS] API: seats endpoint accessible
[WARN] API: budgets endpoint 404 (feature not enabled)
[FAIL] API: premium usage endpoint 403 (insufficient permission)
```

### 3.5 退出码约定

1. `0`：全部通过（或仅 WARN）
2. `1`：存在 FAIL

### 3.6 错误映射建议

1. `401`：Token 无效或过期
2. `403`：角色/权限不足（scope 或 enterprise role）
3. `404`：企业 slug 错误或功能未启用
4. `422`：参数不合法
5. `5xx`：GitHub 侧暂时故障，建议重试

### 3.7 集成方式建议

1. 本地开发：`npm run preflight` 手动执行
2. 生产部署：在 systemd `ExecStartPre` 中执行
3. CI/CD：部署前 gate，失败则阻断发布

## 4. 建议的 npm scripts

```json
{
  "scripts": {
    "preflight": "bash scripts/preflight-check.sh",
    "start:safe": "npm run preflight && node server.js"
  }
}
```

## 5. 可选增强

1. 自检结果写入 `logs/preflight.json`
2. 自检耗时统计与慢项提示
3. Token scope 解析与精确缺失提示
4. 支持 `--strict`（WARN 也按 FAIL 处理）
