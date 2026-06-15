/**
 * User Budget routes — manage user-scoped enterprise budgets via GitHub Billing API.
 *
 * Endpoints:
 *   GET    /api/user-budgets         — list all user-scope budgets (with adName)
 *   GET    /api/user-budgets/:id     — get one (includes consumed_amount)
 *   POST   /api/user-budgets         — create a user-scope budget
 *   PATCH  /api/user-budgets/:id     — update amount / alerting
 *   DELETE /api/user-budgets/:id     — delete
 */
const express = require("express");
const logger = require("../lib/logger");
const { requiredEnv } = require("../lib/billing-config");
const {
  githubGetJson,
  githubPostJson,
  githubPatchJson,
  githubDeleteJson,
  invalidateCacheByPrefix,
} = require("../lib/github-api");
const { toNumber, writeError } = require("../lib/helpers");

const ALLOWED_SKUS = new Set(["ai_credits", "premium_requests"]);

function getEnterprise() {
  const enterprise = requiredEnv("ENTERPRISE_SLUG");
  if (!enterprise) throw new Error("User Budget API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
  return enterprise;
}

function resolveBudgetType(sku) {
  return "BundlePricing";
}

function normalizeBudget(raw, lookup) {
  const login = String(raw?.user || "").trim();
  const key = login.toLowerCase();
  const mapped = login && lookup ? lookup[key] || null : null;
  const alerting = raw?.budget_alerting || {};
  return {
    id: String(raw?.id || ""),
    user: login,
    adName: mapped && mapped.adName ? mapped.adName : "",
    budgetScope: String(raw?.budget_scope || ""),
    budgetEntityName: String(raw?.budget_entity_name || ""),
    budgetProductSku: String(raw?.budget_product_sku || ""),
    budgetType: String(raw?.budget_type || ""),
    budgetAmount: toNumber(raw?.budget_amount),
    preventFurtherUsage: Boolean(raw?.prevent_further_usage),
    willAlert: Boolean(alerting?.will_alert),
    alertRecipients: Array.isArray(alerting?.alert_recipients) ? alerting.alert_recipients.slice() : [],
  };
}

async function fetchUserBudgets(enterprise) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await githubGetJson(
      `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets`,
      new URLSearchParams({ scope: "user", per_page: "100", page: String(page) })
    );
    const budgets = Array.isArray(data?.budgets) ? data.budgets : [];
    for (const b of budgets) {
      if (String(b?.budget_scope || "").toLowerCase() !== "user") continue;
      all.push(b);
    }
    if (!data?.has_next_page) break;
    page += 1;
    if (page > 100) break; // safety
  }
  return all;
}

function validateCreatePayload(body) {
  const user = String(body?.user || "").trim();
  const sku = String(body?.budgetProductSku || body?.sku || "").trim().toLowerCase();
  const amount = Number(body?.budgetAmount);
  const willAlert = Boolean(body?.willAlert);
  const alertRecipients = Array.isArray(body?.alertRecipients)
    ? body.alertRecipients.map((s) => String(s || "").trim()).filter(Boolean)
    : [];

  if (!user) throw new Error("缺少 GitHub 登录名 (user)。");
  if (!ALLOWED_SKUS.has(sku)) throw new Error(`budget_product_sku 仅支持: ${[...ALLOWED_SKUS].join(", ")}`);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("预算金额必须为正整数。");
  if (!Number.isInteger(amount)) throw new Error("预算金额必须为整数（USD 整数美元）。");
  if (willAlert && alertRecipients.length === 0) throw new Error("启用警告时必须至少填写一名接收人。");

  return { user, sku, amount, willAlert, alertRecipients };
}

function validateUpdatePayload(body) {
  const out = {};
  if (body?.budgetAmount != null) {
    const amount = Number(body.budgetAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
      throw new Error("预算金额必须为正整数。");
    }
    out.budget_amount = amount;
  }
  if (body?.willAlert != null || body?.alertRecipients != null) {
    const willAlert = Boolean(body.willAlert);
    const alertRecipients = Array.isArray(body.alertRecipients)
      ? body.alertRecipients.map((s) => String(s || "").trim()).filter(Boolean)
      : [];
    if (willAlert && alertRecipients.length === 0) throw new Error("启用警告时必须至少填写一名接收人。");
    out.budget_alerting = { will_alert: willAlert, alert_recipients: alertRecipients };
  }
  // user scope must keep prevent_further_usage = true; never allow false here
  out.prevent_further_usage = true;
  if (Object.keys(out).length === 1 && "prevent_further_usage" in out) {
    throw new Error("无可更新的字段（金额或警告设置至少需修改一项）。");
  }
  return out;
}

module.exports = function createUserBudgetRouter({ userMappingService } = {}) {
  const router = express.Router();

  router.get("/api/user-budgets", async (req, res) => {
    try {
      const enterprise = getEnterprise();
      const rawBudgets = await fetchUserBudgets(enterprise);
      const logins = rawBudgets.map((b) => b?.user).filter(Boolean);
      const lookup = userMappingService ? userMappingService.buildLookup(logins) : {};
      const budgets = rawBudgets.map((b) => normalizeBudget(b, lookup));
      res.json({
        ok: true,
        fetchedAt: new Date().toISOString(),
        enterprise,
        total: budgets.length,
        budgets,
      });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/user-budgets/:id", async (req, res) => {
    try {
      const enterprise = getEnterprise();
      const id = String(req.params.id || "").trim();
      if (!id) throw new Error("缺少 budget id。");
      const raw = await githubGetJson(
        `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets/${encodeURIComponent(id)}`
      );
      const lookup = userMappingService && raw?.user ? userMappingService.buildLookup([raw.user]) : {};
      const budget = normalizeBudget(raw, lookup);
      // GitHub returns effective_budget on this endpoint (per docs sometimes), include if present
      const consumedAmount = raw?.effective_budget?.consumed_amount;
      if (consumedAmount != null) budget.consumedAmount = toNumber(consumedAmount);
      res.json({ ok: true, fetchedAt: new Date().toISOString(), enterprise, budget });
    } catch (error) { writeError(res, error); }
  });

  router.post("/api/user-budgets", async (req, res) => {
    try {
      const enterprise = getEnterprise();
      const { user, sku, amount, willAlert, alertRecipients } = validateCreatePayload(req.body);
      const payload = {
        budget_amount: amount,
        prevent_further_usage: true,
        budget_scope: "user",
        budget_entity_name: "",
        budget_type: resolveBudgetType(sku),
        budget_product_sku: sku,
        budget_alerting: { will_alert: willAlert, alert_recipients: alertRecipients },
        user,
      };
      const result = await githubPostJson(
        `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets`,
        payload
      );
      invalidateCacheByPrefix("settings/billing/budgets");
      logger.info({ user, sku, amount, willAlert }, "user-budget created");
      res.json({ ok: true, message: result?.message || "Budget created", budget: result?.budget || null });
    } catch (error) { writeError(res, error); }
  });

  router.patch("/api/user-budgets/:id", async (req, res) => {
    try {
      const enterprise = getEnterprise();
      const id = String(req.params.id || "").trim();
      if (!id) throw new Error("缺少 budget id。");
      const payload = validateUpdatePayload(req.body || {});
      const result = await githubPatchJson(
        `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets/${encodeURIComponent(id)}`,
        payload
      );
      logger.info({ id, payload }, "user-budget updated");
      res.json({ ok: true, message: result?.message || "Budget updated", budget: result?.budget || null });
    } catch (error) { writeError(res, error); }
  });

  router.delete("/api/user-budgets/:id", async (req, res) => {
    try {
      const enterprise = getEnterprise();
      const id = String(req.params.id || "").trim();
      if (!id) throw new Error("缺少 budget id。");
      const result = await githubDeleteJson(
        `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets/${encodeURIComponent(id)}`
      );
      invalidateCacheByPrefix("settings/billing/budgets");
      logger.info({ id }, "user-budget deleted");
      res.json({ ok: true, message: result?.message || "Budget deleted", id: result?.id || id });
    } catch (error) { writeError(res, error); }
  });

  return router;
};
