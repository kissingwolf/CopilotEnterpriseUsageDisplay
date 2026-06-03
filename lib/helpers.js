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
  return buildCopilotUsageEndpoint({ billingModel: "legacy_pru" });
}

function buildCopilotUsageEndpoint(options = {}) {
  const { requiredEnv } = require("./billing-config");
  const { resolveBillingModel } = require("./billing-config");
  const enterprise = requiredEnv("ENTERPRISE_SLUG");
  const org = requiredEnv("ORG_NAME");
  const period = options.period || {};

  let billingModel = String(options.billingModel || "").toLowerCase();
  if (billingModel !== "legacy_pru" && billingModel !== "ai_credits") {
    billingModel = resolveBillingModel(period);
  }
  const family = billingModel === "ai_credits" ? "ai_credit" : "premium_request";

  if (enterprise) {
    return {
      path: `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/${family}/usage`,
      scope: `enterprise:${enterprise}`,
      kind: "enterprise",
      enterprise,
      billingModel,
      family,
    };
  }
  if (org) {
    return {
      path: `/organizations/${encodeURIComponent(org)}/settings/billing/${family}/usage`,
      scope: `org:${org}`,
      kind: "org",
      org,
      billingModel,
      family,
    };
  }
  throw new Error("Please set ENTERPRISE_SLUG or ORG_NAME in .env");
}

function buildBillingUsageEndpoint(kind = "summary") {
  const { requiredEnv } = require("./billing-config");
  const enterprise = requiredEnv("ENTERPRISE_SLUG");
  const org = requiredEnv("ORG_NAME");
  const suffix = kind === "summary" ? "/summary" : "";

  if (enterprise) {
    return {
      path: `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/usage${suffix}`,
      scope: `enterprise:${enterprise}`,
      kind: "enterprise",
      enterprise,
    };
  }
  if (org) {
    return {
      path: `/organizations/${encodeURIComponent(org)}/settings/billing/usage${suffix}`,
      scope: `org:${org}`,
      kind: "org",
      org,
    };
  }
  throw new Error("Please set ENTERPRISE_SLUG or ORG_NAME in .env");
}

function roundCurrency(value) {
  return Math.round(toNumber(value) * 10000) / 10000;
}

function isCopilotBillingItem(item) {
  const product = String(item?.product || "").trim().toLowerCase();
  if (product !== "copilot") return false;
  const sku = String(item?.sku || "").trim().toLowerCase();
  const unitType = String(item?.unitType || item?.unit_type || "").trim().toLowerCase();
  if (/seat|subscription|license/.test(sku)) return false;
  return /premium[_ ]request|ai credits?|credit|token/.test(sku) || /requests?|credits?|tokens?/.test(unitType) || sku === "";
}

function normalizeBillingAmount(item) {
  if (item?.netAmount != null) {
    return { amount: roundCurrency(item.netAmount), amountSource: "netAmount" };
  }
  if (item?.grossAmount != null && item?.discountAmount != null) {
    return { amount: roundCurrency(toNumber(item.grossAmount) - toNumber(item.discountAmount)), amountSource: "grossAmount-discountAmount" };
  }
  if (item?.grossAmount != null) {
    return { amount: roundCurrency(item.grossAmount), amountSource: "grossAmount" };
  }
  return { amount: 0, amountSource: "none" };
}

/**
 * Check if a list of SKU strings all look like legacy product-level categories
 * (e.g. "Copilot Premium Request", "Copilot Business") rather than actual AI model names.
 * Returns true when every SKU matches the legacy keyword pattern.
 */
function isLegacyProductSkus(skus) {
  if (!Array.isArray(skus) || skus.length === 0) return false;
  const legacyPattern = /copilot|premium request|business|enterprise|ai credits?|credits?/i;
  const modelPattern = /claude|gpt|gemini|llama|mistral|deepseek|qwen|auto\s*:/i;

  let hasLegacyLike = false;
  let hasModelLike = false;
  for (const sku of skus) {
    const key = String(sku || "").trim();
    if (!key || /^unknown$/i.test(key)) continue;
    if (modelPattern.test(key)) {
      hasModelLike = true;
      continue;
    }
    if (legacyPattern.test(key)) {
      hasLegacyLike = true;
    }
  }

  // Treat as product-level when we can identify legacy-style keys
  // and there is no evidence of concrete model names.
  return hasLegacyLike && !hasModelLike;
}

function aggregateCopilotBillingItems(items) {
  const sources = [];
  let amount = 0;
  let itemCount = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!isCopilotBillingItem(item)) continue;
    const normalized = normalizeBillingAmount(item);
    amount += normalized.amount;
    itemCount += 1;
    if (!sources.includes(normalized.amountSource)) sources.push(normalized.amountSource);
  }
  return { amount: roundCurrency(amount), itemCount, amountSources: sources };
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

const QUOTA_USAGE_BUCKET_NAMES = [
  "配额使用小于 5%",
  "配额使用 大于 5% 小于 50%",
  "配额使用 大于 50% 小于 100%",
  "配额使用 大于 100% 小于 200%",
  "配额使用 大于 200%",
];

function getQuotaUsageBucketName(usagePercent) {
  const pct = toNumber(usagePercent);
  if (pct < 5) return QUOTA_USAGE_BUCKET_NAMES[0];
  if (pct < 50) return QUOTA_USAGE_BUCKET_NAMES[1];
  if (pct < 100) return QUOTA_USAGE_BUCKET_NAMES[2];
  if (pct < 200) return QUOTA_USAGE_BUCKET_NAMES[3];
  return QUOTA_USAGE_BUCKET_NAMES[4];
}

function classifyQuotaUsage(users) {
  const buckets = Object.fromEntries(QUOTA_USAGE_BUCKET_NAMES.map((name) => [name, []]));
  for (const user of users) {
    buckets[getQuotaUsageBucketName(user.usagePercent)].push(user);
  }
  return buckets;
}

module.exports = {
  toNumber,
  pickUser,
  isLegacyProductSkus,
  writeError,
  buildQueryParams,
  buildEndpoint,
  buildCopilotUsageEndpoint,
  buildBillingUsageEndpoint,
  isCopilotBillingItem,
  normalizeBillingAmount,
  aggregateCopilotBillingItems,
  buildMemberExcelRows,
  classifyUserActivity,
  QUOTA_USAGE_BUCKET_NAMES,
  getQuotaUsageBucketName,
  classifyQuotaUsage,
};
