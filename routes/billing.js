/**
 * Billing routes – GET /api/seats, /api/billing/summary, /api/billing/models
 */
const express = require("express");
const { requiredEnv, PLAN_CONFIG, resolveBillingModel, getIncludedCreditsPerSeat } = require("../lib/billing-config");
const { githubGetJson, invalidateCacheByPrefix } = require("../lib/github-api");
const { toNumber, writeError, buildEndpoint, buildBillingUsageEndpoint, aggregateCopilotBillingItems } = require("../lib/helpers");
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
      const now = new Date();
      const responseYear = hasPeriod ? yearParam : now.getUTCFullYear();
      const responseMonth = hasPeriod ? monthParam : (now.getUTCMonth() + 1);
      const billingModel = resolveBillingModel({ year: responseYear, month: responseMonth });

      // Force mode: also refresh seats snapshot and drop LRU for billing/usage
      await ensureSeatsData(teamCache, usageStore, force);
      if (force) {
        invalidateCacheByPrefix("/settings/billing/usage");
      }

      const seats = teamCache.seatsRaw;
      const planCounts = {};
      for (const s of seats) { const pt = s.planType || "business"; planCounts[pt] = (planCounts[pt] || 0) + 1; }

      if (billingModel === "ai_credits") {
        const endpoint = buildBillingUsageEndpoint("summary");
        const params = new URLSearchParams();
        if (hasPeriod) {
          params.set("year", String(yearParam));
          params.set("month", String(monthParam));
        }
        params.set("product", "Copilot");

        const billingData = await githubGetJson(endpoint.path, params);
        const rawItems = Array.isArray(billingData?.usageItems) ? billingData.usageItems : [];

        const planSummary = [];
        let totalSeatsCost = 0, includedCreditsPool = 0;
        for (const [plan, count] of Object.entries(planCounts)) {
          const legacyCfg = PLAN_CONFIG[plan] || PLAN_CONFIG.business;
          const includedCreditsPerSeat = getIncludedCreditsPerSeat(plan, { year: responseYear, month: responseMonth });
          const cost = count * legacyCfg.baseCost;
          totalSeatsCost += cost;
          includedCreditsPool += count * includedCreditsPerSeat;
          planSummary.push({
            plan,
            seats: count,
            baseCost: legacyCfg.baseCost,
            totalCost: cost,
            includedCreditsPerSeat,
            totalIncludedCredits: count * includedCreditsPerSeat,
          });
        }

        const copilotBilling = aggregateCopilotBillingItems(rawItems);
        const copilotNetAmount = copilotBilling.amount;
        const totalEstimatedCost = Math.round((totalSeatsCost + copilotNetAmount) * 10000) / 10000;

        res.json({
          ok: true,
          billingModel,
          year: responseYear,
          month: responseMonth,
          isCurrentMonth: !hasPeriod,
          force,
          rawItems,
          planSummary,
          totalSeats: seats.length,
          totalSeatsCost,
          includedCreditsPool,
          copilotNetAmount,
          copilotBillingItemCount: copilotBilling.itemCount,
          amountSources: copilotBilling.amountSources,
          copilotEstimatedCredits: Math.round(copilotNetAmount * 100 * 100) / 100,
          totalEstimatedCost,
        });
        return;
      }

      const endpoint = buildBillingUsageEndpoint("report");
      const params = new URLSearchParams();
      if (hasPeriod) {
        params.set("year", String(yearParam));
        params.set("month", String(monthParam));
      }
      const billingData = await githubGetJson(
        endpoint.path,
        hasPeriod ? params : null
      );
      const rawItems = Array.isArray(billingData?.usageItems) ? billingData.usageItems : [];

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

      res.json({
        ok: true,
        billingModel,
        year: responseYear,
        month: responseMonth,
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
      const nowM = new Date();
      const year = req.query.year || requiredEnv("BILLING_YEAR") || String(nowM.getUTCFullYear());
      const month = req.query.month || requiredEnv("BILLING_MONTH") || String(nowM.getUTCMonth() + 1);
      const billingModel = resolveBillingModel({ year, month });
      const endpoint = billingModel === "ai_credits" ? buildBillingUsageEndpoint("report") : buildEndpoint();
      const params = new URLSearchParams();
      if (year) params.set("year", String(year));
      if (month) params.set("month", String(month));
      params.set("product", "Copilot");

      const data = await githubGetJson(endpoint.path, params);
      const items = Array.isArray(data?.usageItems) ? data.usageItems : [];
      const models = {};
      for (const item of items) {
        const key = item.sku || item.model || "Unknown";
        const quantity = toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
        const grossAmount = toNumber(item.grossAmount);
        const netAmount = toNumber(item.netAmount);
        if (!models[key]) models[key] = { model: key, quantity: 0, grossAmount: 0, netAmount: 0, pricePerUnit: toNumber(item.pricePerUnit) };
        models[key].quantity += quantity;
        models[key].grossAmount += grossAmount;
        models[key].netAmount += netAmount;
        if (!models[key].pricePerUnit && item.pricePerUnit) models[key].pricePerUnit = toNumber(item.pricePerUnit);
      }

      const sorted = Object.values(models)
        .sort((a, b) => b.grossAmount - a.grossAmount)
        .map((m) => {
          const quantity = Math.round(m.quantity * 100) / 100;
          const grossAmount = Math.round(m.grossAmount * 10000) / 10000;
          const netAmount = Math.round(m.netAmount * 10000) / 10000;
          const additionalCredits = m.pricePerUnit > 0
            ? Math.round((m.netAmount / m.pricePerUnit) * 100) / 100
            : 0;
          const includedCredits = Math.round((quantity - additionalCredits) * 100) / 100;
          return {
            model: m.model,
            quantity,
            grossQuantity: quantity, // backward-compat alias
            grossAmount,
            netAmount,
            includedCredits,
            additionalCredits,
            pricePerUnit: m.pricePerUnit,
          };
        });
      const totalQty = sorted.reduce((s, m) => s + m.quantity, 0);
      const totalAmount = sorted.reduce((s, m) => s + m.grossAmount, 0);

      res.json({
        ok: true, billingModel, year: Number(year), month: Number(month), models: sorted,
        totalQuantity: Math.round(totalQty * 100) / 100,
        totalAmount: Math.round(totalAmount * 10000) / 10000,
      });
    } catch (error) { writeError(res, error); }
  });

  return router;
};
