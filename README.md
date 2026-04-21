# Copilot 每用户用量展示

基于 Node.js + Express 的 GitHub Copilot Premium Request 用量可视化仪表盘，面向 GitHub Enterprise 管理员，提供每用户请求量排行、费用估算、Team 管理和账单汇总等功能。

## 功能特性

- **每用户用量排行** — 按日期或日期范围查询每个用户的 Premium Request 请求量
- **当日 / 本周期双列展示** — 按日期查询时同时显示当日请求量和本月累计请求量
- **Premium Requests (%)** — 基于订阅计划额度计算（Business = 300 / Enterprise = 1000）
- **费用估算** — 额度内显示订阅费（Business $19），超额按 $0.04/request 累加
- **自动刷新** — 支持 5 / 15 / 30 / 60 秒定时自动刷新
- **排序** — 全部表格列支持升序/降序点击排序
- **用户 & Team 信息** — 查看 Enterprise Teams（名称、描述），点击展开查看 Team 成员
- **整体账单汇总** — 席位订阅费 + Premium Requests 超额计算 + 费用合计
- **模型使用排行** — 按月查看各 AI 模型的请求量和费用占比

## 技术架构

```
server.js           Express 后端，封装 GitHub REST API 调用
public/
  index.html        页面结构
  script.js         前端交互、排序、模态框
  styles.css        样式
deploy/
  copilot-dashboard.service   systemd 服务单元
  nginx-copilot-dashboard.conf  Nginx 反向代理配置
.env                配置（不入库）
.env.example        配置模板
```

## 使用的 GitHub API

| 端点 | 用途 |
|------|------|
| `GET /enterprises/{enterprise}/copilot/billing/seats` | 用户列表、Team 归属、计划类型、最后活跃时间/编辑器 |
| `GET /enterprises/{enterprise}/settings/billing/premium_request/usage` | 每用户 Premium Request 用量（支持 `?user=`、`?year=`、`?month=`、`?day=` 过滤） |
| `GET /enterprises/{enterprise}/settings/billing/usage` | 企业整体账单（席位费 + Premium Requests 费用） |
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
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
ENTERPRISE_SLUG=YourEnterprise
PRODUCT=Copilot
```

### 启动

```bash
npm start
```

访问 http://localhost:3000

### 开发模式（文件变更自动重启）

```bash
npm run dev
```

## 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | 是 | GitHub PAT，需 Enterprise billing 读取权限 |
| `ENTERPRISE_SLUG` | 是 | Enterprise slug（如 `StarbucksChina`） |
| `BILLING_YEAR` | 否 | 账单年份（默认取当前年） |
| `BILLING_MONTH` | 否 | 账单月份（默认取当前月） |
| `BILLING_DAY` | 否 | 可选，指定具体日期 |
| `PRODUCT` | 否 | 产品过滤，默认 `Copilot` |
| `MODEL` | 否 | 可选，按模型过滤 |
| `GITHUB_API_BASE` | 否 | API 地址，默认 `https://api.github.com`（GHE.com 需替换） |
| `PORT` | 否 | 服务端口，默认 `3000` |

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
|------|------|
| `deploy/copilot-dashboard.service` | systemd 服务单元，以 `www-data` 用户运行，异常自动重启 |
| `deploy/nginx-copilot-dashboard.conf` | Nginx 反向代理，将 80 端口转发到 Node.js 的 3000 端口 |

## 费用计算逻辑

每用户月度费用按以下规则计算：

- **额度内**（请求量 ≤ 计划额度）：费用 = 订阅基础价（Business $19 / Enterprise $39）
- **超额**（请求量 > 计划额度）：费用 = 基础价 + (超出请求数 × $0.04)

| 计划 | 月额度 | 基础价 | 超额单价 |
|------|--------|--------|----------|
| Business | 300 requests | $19 | $0.04/request |
| Enterprise | 1000 requests | $39 | $0.04/request |

## License

MIT
