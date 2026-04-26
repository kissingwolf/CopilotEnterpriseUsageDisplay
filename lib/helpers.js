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

  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  if (day) params.set("day", String(day));
  if (product) params.set("product", product);
  if (model) params.set("model", model);
  if (user) params.set("user", user);
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

module.exports = { toNumber, pickUser, writeError, buildQueryParams, buildEndpoint };
