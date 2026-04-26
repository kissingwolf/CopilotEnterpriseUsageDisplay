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

function calcAmount(cycleRequests, planType) {
  const cfg = PLAN_CONFIG[planType] || PLAN_CONFIG.business;
  if (cycleRequests <= cfg.quota) return cfg.baseCost;
  return Math.round((cfg.baseCost + (cycleRequests - cfg.quota) * cfg.overagePrice) * 10000) / 10000;
}

module.exports = { INCLUDED_QUOTA, PLAN_CONFIG, calcAmount, requiredEnv };
