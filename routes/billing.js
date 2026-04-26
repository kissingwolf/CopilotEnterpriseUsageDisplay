/**
 * Billing routes – GET /api/seats, /api/billing/summary, /api/billing/models
 */
const express = require("express");
const { requiredEnv, PLAN_CONFIG } = require("../lib/billing-config");
const { githubGetJson } = require("../lib/github-api");
const { toNumber, writeError, buildEndpoint } = require("../lib/helpers");
const { ensureSeatsData, fetchCopilotSeats } = require("./seats");

module.exports = function createBillingRouter({ usageStore, teamCache }) {
  const router = express.Router();

  router.get("/api/seats", async (req, res) => {
    try {
      const shouldRefresh = String(req.query.refresh || "").toLowerCase();
      const forceRefresh = shouldRefresh === "1" || shouldRefresh === "true";
      await ensureSeatsData(teamCache, usageStore, forceRefresh);
      res.json({ ok: true, fetchedAt: teamCache.fetchedAt, totalSeats: teamCache.seatsRaw.length, seats: teamCache.seatsRaw });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/billing/summary", async (_req, res) => {
    try {
      await ensureSeatsData(teamCache, usageStore);
      const endpoint = buildEndpoint();
      const billingData = await githubGetJson(`/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/usage`);
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
      const overageRequests = Math.max(0, totalPremiumRequests - totalIncludedQuota);
      const overageCost = Math.round(overageRequests * premiumUnitPrice * 10000) / 10000;
      const totalEstimatedCost = Math.round((totalSeatsCost + overageCost) * 10000) / 10000;

      res.json({
        ok: true, rawItems, planSummary, totalSeats: seats.length,
        totalSeatsCost, totalIncludedQuota,
        totalPremiumRequests: Math.round(totalPremiumRequests * 100) / 100,
        premiumUnitPrice,
        grossPremiumCost: Math.round(grossPremiumCost * 10000) / 10000,
        discountPremiumCost: Math.round(discountPremiumCost * 10000) / 10000,
        overageRequests: Math.round(overageRequests * 100) / 100,
        overageCost, totalEstimatedCost,
      });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/billing/models", async (req, res) => {
    try {
      const endpoint = buildEndpoint();
      const nowM = new Date();
      const year = req.query.year || requiredEnv("BILLING_YEAR") || String(nowM.getFullYear());
      const month = req.query.month || requiredEnv("BILLING_MONTH") || String(nowM.getMonth() + 1);
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
