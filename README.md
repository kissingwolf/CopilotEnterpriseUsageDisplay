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
- **自动刷新** — 支持 5 / 15 / 30 / 60 秒定时自动刷新
- **服务端缓存** — 相同查询在缓存时间内直接返回，减少 API 延迟影响
- **排序** — 全部表格列支持升序/降序点击排序
- **用户 & Team 信息** — 查看 Enterprise Teams（名称、描述），点击展开查看 Team 成员
- **整体账单汇总** — 席位订阅费 + Premium Requests 超额计算 + 费用合计
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

## 技术架构

```text
server.js           Express 后端，封装 GitHub REST API 调用
public/
  index.html        页面结构
  script.js         前端交互、排序、模态框
  styles.css        样式
  costcenter.html   Cost center 页面
  costcenter.js     Cost center 交互逻辑
scripts/
  preflight-check.sh  启动前自检（Shell）
  preflight-check.js  启动前自检（Node）
docs/
  github-enterprise-copilot-billing-api-checklist.md
  github-enterprise-copilot-billing-scope-checklist.md
  minimal-env-and-preflight-design.md
deploy/
  copilot-dashboard.service   systemd 服务单元
  nginx-copilot-dashboard.conf  Nginx 反向代理配置
.env                配置（不入库）
.env.example        配置模板
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
| `ENTERPRISE_SLUG` | 是 | Enterprise slug（如 `StarbucksChina`） |
| `BILLING_YEAR` | 否 | 账单年份（默认取当前年） |
| `BILLING_MONTH` | 否 | 账单月份（默认取当前月） |
| `BILLING_DAY` | 否 | 可选，指定具体日期 |
| `PRODUCT` | 否 | 产品过滤，默认 `Copilot` |
| `MODEL` | 否 | 可选，按模型过滤 |
| `INCLUDED_QUOTA` | 否 | 每用户每周期包含请求配额，默认 `300`，用于进度条基线和百分比计算 |
| `CACHE_TTL` | 否 | API 响应缓存时长（秒），默认 `300`（5 分钟），缓存期内相同查询直接返回缓存 |
| `GITHUB_API_BASE` | 否 | API 地址，默认 `https://api.github.com`（GHE.com 需替换） |
| `PORT` | 否 | 服务端口，默认 `3000` |

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

- `docs/github-enterprise-copilot-billing-api-checklist.md`：Copilot/Billing API 设计与字段映射清单
- `docs/github-enterprise-copilot-billing-scope-checklist.md`：按接口逐条对应的角色与 scope 核对表
- `docs/minimal-env-and-preflight-design.md`：最小权限 `.env` 模板与 preflight 设计说明

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
  "teamIds": ["17152814", "17152824"],
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

## License

MIT
