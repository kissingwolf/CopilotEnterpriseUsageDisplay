/**
 * Billing routes – GET /api/seats, /api/billing/summary, /api/billing/models
 */
const express = require("express");
const { requiredEnv, PLAN_CONFIG } = require("../lib/billing-config");
const { githubGetJson, invalidateCacheByPrefix } = require("../lib/github-api");
const { toNumber, writeError, buildEndpoint } = require("../lib/helpers");
const { ensureSeatsData, fetchCopilotSeats } = require("./seats");

module.exports = function createBillingRouter({ usageStore, teamCache, userMappingService }) {
  const router = express.Router();

  // Non-destructive adName enrichment: never mutates teamCache.seatsRaw.
  const enrichSeatsWithAdName = (seats, lookup) => {
    if (!Array.isArray(seats)) return [];
    if (!lookup) return seats;
    return seats.map((s) => {
      const mapped = lookup[(s.login || "").trim().toLowerCase()] || null;
      return mapped && mapped.adName ? { ...s, adName: mapped.adName } : { ...s, adName: "" };
    });
  };

  router.get("/api/seats", async (req, res) => {
    try {
      const shouldRefresh = String(req.query.refresh || "").toLowerCase();
      const forceRefresh = shouldRefresh === "1" || shouldRefresh === "true";
      await ensureSeatsData(teamCache, usageStore, forceRefresh);
      const seatLogins = teamCache.seatsRaw.map((s) => s.login);
      const lookup = userMappingService.buildLookup(seatLogins);
      const seats = enrichSeatsWithAdName(teamCache.seatsRaw, lookup);
      res.json({ ok: true, fetchedAt: teamCache.fetchedAt, totalSeats: seats.length, seats });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/billing/summary", async (req, res) => {
    try {
      const forceStr = String(req.query.force || "").toLowerCase();
      const force = forceStr === "1" || forceStr === "true";
      const yearParam = req.query.year ? Number(req.query.year) : null;
      const monthParam = req.query.month ? Number(req.query.month) : null;
      const hasPeriod =
        Number.isInteger(yearParam) && yearParam > 2000 &&
        Number.isInteger(monthParam) && monthParam >= 1 && monthParam <= 12;

      // Force mode: also refresh seats snapshot and drop LRU for billing/usage
      await ensureSeatsData(teamCache, usageStore, force);
      if (force) {
        invalidateCacheByPrefix("/settings/billing/usage");
      }

      const endpoint = buildEndpoint();
      const params = new URLSearchParams();
      if (hasPeriod) {
        params.set("year", String(yearParam));
        params.set("month", String(monthParam));
      }
      const billingData = await githubGetJson(
        `/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/usage`,
        hasPeriod ? params : null
      );
      const rawItems = Array.isArray(billingData?.usageItems) ? billingData.usageItems : [];
      const seats = teamCache.seatsRaw;
      const planCounts = {};
      for (const s of seats) { const pt = s.planType || "business"; planCounts[pt] = (planCounts[pt] || 0) + 1; }

      const planSummary = [];
      let totalSeatsCost = 0, totalIncludedQuota = 0;
      for (const [plan, count] of Object.entries(planCounts)) {
        const cfg = PLAN_CONFIG[plan] || PLAN_CONFIG.business;
        const cost = count * cfg.baseCost;
        const quota = count * cfg.quota;
        totalSeatsCost += cost; totalIncludedQuota += quota;
        planSummary.push({ plan, seats: count, baseCost: cfg.baseCost, totalCost: cost, quotaPerSeat: cfg.quota, totalQuota: quota });
      }

      const premiumItem = rawItems.find((i) => /premium/i.test(i.sku || ""));
      const totalPremiumRequests = premiumItem ? toNumber(premiumItem.quantity) : 0;
      const premiumUnitPrice = premiumItem ? toNumber(premiumItem.pricePerUnit) : 0.04;
      const grossPremiumCost = premiumItem ? toNumber(premiumItem.grossAmount) : 0;
      const discountPremiumCost = premiumItem ? toNumber(premiumItem.discountAmount) : 0;
      const netPremiumCost = premiumItem ? toNumber(premiumItem.netAmount) : 0;
      const overageRequests = Math.max(0, totalPremiumRequests - totalIncludedQuota);
      const localOverageCost = Math.round(overageRequests * premiumUnitPrice * 10000) / 10000;
      // Prefer API-authoritative netAmount (matches GitHub billing statement);
      // fall back to locally computed overage only when premium row is absent.
      const hasApiNet = premiumItem && premiumItem.netAmount != null;
      const overageCost = hasApiNet
        ? Math.round(netPremiumCost * 10000) / 10000
        : localOverageCost;
      const overageCostSource = hasApiNet ? "api-netAmount" : "local-formula";
      const totalEstimatedCost = Math.round((totalSeatsCost + overageCost) * 10000) / 10000;

      const now = new Date();
      res.json({
        ok: true,
        year: hasPeriod ? yearParam : now.getUTCFullYear(),
        month: hasPeriod ? monthParam : (now.getUTCMonth() + 1),
        isCurrentMonth: !hasPeriod,
        force,
        rawItems, planSummary, totalSeats: seats.length,
        totalSeatsCost, totalIncludedQuota,
        totalPremiumRequests: Math.round(totalPremiumRequests * 100) / 100,
        premiumUnitPrice,
        grossPremiumCost: Math.round(grossPremiumCost * 10000) / 10000,
        discountPremiumCost: Math.round(discountPremiumCost * 10000) / 10000,
        netPremiumCost: Math.round(netPremiumCost * 10000) / 10000,
        overageRequests: Math.round(overageRequests * 100) / 100,
        localOverageCost,
        overageCost, overageCostSource,
        totalEstimatedCost,
      });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/billing/models", async (req, res) => {
    try {
      const endpoint = buildEndpoint();
      const nowM = new Date();
      const year = req.query.year || requiredEnv("BILLING_YEAR") || String(nowM.getUTCFullYear());
      const month = req.query.month || requiredEnv("BILLING_MONTH") || String(nowM.getUTCMonth() + 1);
      const params = new URLSearchParams();
      if (year) params.set("year", String(year));
      if (month) params.set("month", String(month));
      params.set("product", "Copilot");

      const data = await githubGetJson(endpoint.path, params);
      const items = Array.isArray(data?.usageItems) ? data.usageItems : [];
      const models = {};
      for (const item of items) {
        const model = item.model || "Unknown";
        if (!models[model]) models[model] = { model, grossQuantity: 0, grossAmount: 0, pricePerUnit: item.pricePerUnit || 0 };
        models[model].grossQuantity += toNumber(item.grossQuantity);
        models[model].grossAmount += toNumber(item.grossAmount);
      }

      const sorted = Object.values(models)
        .sort((a, b) => b.grossQuantity - a.grossQuantity)
        .map((m) => ({
          model: m.model,
          grossQuantity: Math.round(m.grossQuantity * 100) / 100,
          grossAmount: Math.round(m.grossAmount * 10000) / 10000,
          pricePerUnit: m.pricePerUnit,
        }));
      const totalQty = sorted.reduce((s, m) => s + m.grossQuantity, 0);
      const totalAmount = sorted.reduce((s, m) => s + m.grossAmount, 0);

      res.json({
        ok: true, year: Number(year), month: Number(month), models: sorted,
        totalQuantity: Math.round(totalQty * 100) / 100,
        totalAmount: Math.round(totalAmount * 10000) / 10000,
      });
    } catch (error) { writeError(res, error); }
  });

  return router;
};
