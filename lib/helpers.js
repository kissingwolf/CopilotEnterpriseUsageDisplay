/**
 * Shared helper functions used across routes and lib modules.
 */

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function pickUser(item) {
  const candidates = [
    item.user, item.username, item.userName, item.login,
    item.actor, item.actorLogin, item.actor_login, item.user_login,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      if (typeof value.login === "string" && value.login.trim()) return value.login.trim();
      if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    }
  }
  return "(unknown)";
}

function writeError(res, error) {
  const { ApiError } = require("./github-api");
  const statusCode = error instanceof ApiError ? error.statusCode : 500;
  const body = { ok: false, message: error instanceof Error ? error.message : "Unknown error" };
  if (error instanceof ApiError && error.rateLimit) body.rateLimit = error.rateLimit;
  res.status(statusCode).json(body);
}

function buildQueryParams(extra = {}) {
  const { requiredEnv } = require("./billing-config");
  const params = new URLSearchParams();
  const now = new Date();
  const year = extra.year || requiredEnv("BILLING_YEAR") || String(now.getFullYear());
  const month = extra.month || requiredEnv("BILLING_MONTH") || String(now.getMonth() + 1);
  const day = extra.day || requiredEnv("BILLING_DAY");
  const product = extra.product || requiredEnv("PRODUCT");
  const model = extra.model || requiredEnv("MODEL");
  const user = extra.user || "";
  const costCenterId = extra.cost_center_id || extra.costCenterId || "";

  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  if (day) params.set("day", String(day));
  if (product) params.set("product", product);
  if (model) params.set("model", model);
  if (user) params.set("user", user);
  if (costCenterId) params.set("cost_center_id", String(costCenterId));
  return params;
}

function buildEndpoint() {
  const { requiredEnv } = require("./billing-config");
  const enterprise = requiredEnv("ENTERPRISE_SLUG");
  const org = requiredEnv("ORG_NAME");

  if (enterprise) {
    return {
      path: `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/premium_request/usage`,
      scope: `enterprise:${enterprise}`,
      kind: "enterprise",
      enterprise,
    };
  }
  if (org) {
    return {
      path: `/organizations/${encodeURIComponent(org)}/settings/billing/premium_request/usage`,
      scope: `org:${org}`,
      kind: "org",
      org,
    };
  }
  throw new Error("Please set ENTERPRISE_SLUG or ORG_NAME in .env");
}

/**
 * Build an array of rows (header + data) for Excel export of the members table.
 * Each data row maps to the 7 columns shown on /user page.
 * @param {Array<{login,team,adName,adMail,planType,lastActivityAt}>} members
 * @returns {Array<string[]>}
 */
function buildMemberExcelRows(members) {
  const HEADERS = ["Github 用户名", "Team", "AD 用户名", "AD 邮箱", "计划", "最后活跃", "映射状态"];
  const rows = [HEADERS];
  for (const m of members) {
    const isMapped = !!(m.adName && m.adName.trim());
    let lastActive = "--";
    if (m.lastActivityAt) {
      const d = new Date(m.lastActivityAt);
      if (!Number.isNaN(d.getTime())) {
        lastActive = d.toLocaleString("zh-CN", { hour12: false });
      }
    }
    rows.push([
      m.login || "--",
      m.team || "--",
      (m.adName && m.adName.trim()) ? m.adName : "--",
      (m.adMail && m.adMail.trim()) ? m.adMail : "--",
      m.planType || "--",
      lastActive,
      isMapped ? "已映射" : "未映射",
    ]);
  }
  return rows;
}

/**
 * Classify members by inactivity duration.
 * @param {Array<{login,team,adName,lastActivityAt}>} members
 * @param {number} nowMs  - current timestamp in ms (injectable for testing)
 * @returns {{ '1~5日不活跃': [], '6~10日不活跃': [], '10日以上不活跃': [], '注册后未活跃': [] }}
 */
function classifyUserActivity(members, nowMs) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const buckets = {
    "1~5日不活跃": [],
    "6~10日不活跃": [],
    "10日以上不活跃": [],
    "注册后未活跃": [],
  };
  for (const m of members) {
    const displayName = (m.adName && m.adName.trim()) ? m.adName : m.login;
    const entry = { displayName, team: m.team || "--", lastActivityAt: m.lastActivityAt };
    if (!m.lastActivityAt) {
      buckets["注册后未活跃"].push(entry);
      continue;
    }
    const daysInactive = Math.floor((nowMs - new Date(m.lastActivityAt).getTime()) / MS_PER_DAY);
    if (daysInactive <= 5) {
      buckets["1~5日不活跃"].push(entry);
    } else if (daysInactive <= 10) {
      buckets["6~10日不活跃"].push(entry);
    } else {
      buckets["10日以上不活跃"].push(entry);
    }
  }
  return buckets;
}

module.exports = { toNumber, pickUser, writeError, buildQueryParams, buildEndpoint, buildMemberExcelRows, classifyUserActivity };
