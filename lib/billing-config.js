/**
 * Billing / plan configuration – extracted from server.js so that
 * routes, helpers, and tests can share it without circular deps.
 */

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

const INCLUDED_QUOTA = Number(requiredEnv("INCLUDED_QUOTA")) || 300;

const PLAN_CONFIG = {
  business:   { quota: INCLUDED_QUOTA, baseCost: 19, overagePrice: 0.04 },
  enterprise: { quota: 1000,           baseCost: 39, overagePrice: 0.04 },
};

const AI_CREDITS_PLAN_CONFIG = {
  business: {
    includedCredits: 1900,
    promotionalIncludedCredits: 3000,
    baseCost: 19,
  },
  enterprise: {
    includedCredits: 3900,
    promotionalIncludedCredits: 7000,
    baseCost: 39,
  },
};

function isAiCreditsPeriod(period = {}) {
  const year = Number(period.year);
  const month = Number(period.month);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return false;
  return year > 2026 || (year === 2026 && month >= 6);
}

function isPromotionalAiCreditsPeriod(period = {}) {
  const year = Number(period.year);
  const month = Number(period.month);
  return year === 2026 && month >= 6 && month <= 8;
}

function resolveBillingModel(period = {}) {
  const configured = requiredEnv("BILLING_MODEL").toLowerCase();
  if (configured === "legacy_pru" || configured === "ai_credits") return configured;
  return isAiCreditsPeriod(period) ? "ai_credits" : "legacy_pru";
}

function getIncludedCreditsPerSeat(planType, period = {}) {
  const cfg = AI_CREDITS_PLAN_CONFIG[String(planType || "").toLowerCase()] || AI_CREDITS_PLAN_CONFIG.business;
  return isPromotionalAiCreditsPeriod(period) ? cfg.promotionalIncludedCredits : cfg.includedCredits;
}

function calcAmount(cycleRequests, planType) {
  const cfg = PLAN_CONFIG[planType] || PLAN_CONFIG.business;
  if (cycleRequests <= cfg.quota) return cfg.baseCost;
  return Math.round((cfg.baseCost + (cycleRequests - cfg.quota) * cfg.overagePrice) * 10000) / 10000;
}

module.exports = {
  INCLUDED_QUOTA,
  PLAN_CONFIG,
  AI_CREDITS_PLAN_CONFIG,
  calcAmount,
  getIncludedCreditsPerSeat,
  resolveBillingModel,
  requiredEnv,
};
