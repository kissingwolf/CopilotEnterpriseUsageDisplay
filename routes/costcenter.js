/**
 * Cost Center routes
 */
const express = require("express");
const { PLAN_CONFIG } = require("../lib/billing-config");
const { githubGetJson, githubPostJson, githubDeleteJson } = require("../lib/github-api");
const { toNumber, writeError, buildEndpoint } = require("../lib/helpers");
const { requiredEnv } = require("../lib/billing-config");

function getBillingYearMonthForCostCenter() {
  const now = new Date();
  return {
    year: requiredEnv("BILLING_YEAR") || String(now.getUTCFullYear()),
    month: requiredEnv("BILLING_MONTH") || String(now.getUTCMonth() + 1),
  };
}

function summarizeUsageItemsAmount(payload, allowedSkus) {
  const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
  let spent = 0;
  for (const item of usageItems) {
    if (allowedSkus && allowedSkus.size > 0) {
      const itemSku = String(item?.sku || "").trim().toLowerCase();
      if (!itemSku || !allowedSkus.has(itemSku)) continue;
    }
    spent += toNumber(item.netAmount) || toNumber(item.grossAmount) || toNumber(item.amount);
  }
  return Math.round(spent * 10000) / 10000;
}

async function fetchCostCenterBudgetMap(enterprise) {
  const byName = new Map();
  let page = 1;
  while (true) {
    const data = await githubGetJson(
      `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets`,
      new URLSearchParams({ scope: "cost_center", per_page: "100", page: String(page) })
    );
    const budgets = Array.isArray(data?.budgets) ? data.budgets : [];
    for (const budget of budgets) {
      const scope = String(budget?.budget_scope || "").toLowerCase();
      if (scope !== "cost_center") continue;
      const name = String(budget?.budget_entity_name || "").trim();
      if (!name) continue;
      const amount = toNumber(budget?.budget_amount);
      const key = name.toLowerCase();
      const prev = byName.get(key) || { amount: 0, skus: new Set() };
      prev.amount += amount;
      const skuList = [];
      if (Array.isArray(budget?.budget_product_skus)) skuList.push(...budget.budget_product_skus);
      if (typeof budget?.budget_product_sku === "string") skuList.push(budget.budget_product_sku);
      for (const sku of skuList) {
        const ns = String(sku || "").trim().toLowerCase();
        if (ns) prev.skus.add(ns);
      }
      byName.set(key, prev);
    }
    if (!data?.has_next_page) break;
    page += 1;
  }
  return byName;
}

async function fetchCostCenterSpentMap(enterprise, costCenters, budgetByName) {
  const byName = new Map();
  if (!Array.isArray(costCenters) || costCenters.length === 0) return byName;
  const { year, month } = getBillingYearMonthForCostCenter();
  const chunkSize = 6;
  for (let i = 0; i < costCenters.length; i += chunkSize) {
    const chunk = costCenters.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async (cc) => {
      const ccId = cc?.id;
      const ccName = String(cc?.name || "").trim();
      if (!ccId || !ccName) return;
      const budgetInfo = budgetByName instanceof Map ? budgetByName.get(ccName.toLowerCase()) : null;
      const allowedSkus = budgetInfo?.skus instanceof Set ? budgetInfo.skus : new Set();
      try {
        const params = new URLSearchParams();
        params.set("year", String(year));
        params.set("month", String(month));
        params.set("cost_center_id", String(ccId));
        const usage = await githubGetJson(
          `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/usage/summary`, params
        );
        byName.set(ccName.toLowerCase(), summarizeUsageItemsAmount(usage, allowedSkus));
      } catch { byName.set(ccName.toLowerCase(), null); }
    }));
  }
  return byName;
}

async function fetchEnterpriseTeamMembers(enterprise, teamId) {
  const members = [];
  let page = 1;
  while (true) {
    const raw = await githubGetJson(
      `/enterprises/${encodeURIComponent(enterprise)}/teams/${teamId}/memberships`,
      new URLSearchParams({ per_page: "100", page: String(page) })
    );
    const batch = Array.isArray(raw) ? raw : [];
    for (const m of batch) {
      if (typeof m?.login === "string" && m.login.trim()) members.push(m.login.trim());
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return members;
}

module.exports = function createCostCenterRouter() {
  const router = express.Router();

  router.get("/api/cost-centers", async (req, res) => {
    try {
      const endpoint = buildEndpoint();
      if (endpoint.kind !== "enterprise") throw new Error("Cost center API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
      const stateFilter = String(req.query.state || "").toLowerCase();
      const params = new URLSearchParams();
      if (stateFilter === "active" || stateFilter === "deleted") params.set("state", stateFilter);

      const data = await githubGetJson(`/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers`, params);
      const costCenters = Array.isArray(data?.costCenters) ? data.costCenters : [];
      const budgetByName = await fetchCostCenterBudgetMap(endpoint.enterprise);
      const spentByName = await fetchCostCenterSpentMap(endpoint.enterprise, costCenters, budgetByName);
      const seatBaseCost = PLAN_CONFIG.business.baseCost;

      const normalized = costCenters.map((cc) => {
        const resources = Array.isArray(cc.resources) ? cc.resources : [];
        const nameKey = String(cc.name || "").trim().toLowerCase();
        const budgetInfo = budgetByName.get(nameKey) || null;
        return {
          id: cc.id || "", name: cc.name || "-", seatBaseCost,
          budgetAmount: budgetInfo ? budgetInfo.amount : null,
          spentAmount: spentByName.get(nameKey) ?? null,
          state: cc.state || "-", azureSubscription: cc.azure_subscription || "", resources,
        };
      });

      res.json({ ok: true, fetchedAt: new Date().toISOString(), enterprise: endpoint.enterprise, seatBaseCost, total: normalized.length, costCenters: normalized });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/cost-centers/by-name/:name", async (req, res) => {
    try {
      const endpoint = buildEndpoint();
      if (endpoint.kind !== "enterprise") throw new Error("Cost center API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
      const targetName = decodeURIComponent(req.params.name || "").trim();
      if (!targetName) throw new Error("缺少 cost center 名称。");

      const data = await githubGetJson(`/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers`);
      const costCenters = Array.isArray(data?.costCenters) ? data.costCenters : [];
      const found = costCenters.find((cc) => (cc?.name || "").trim().toLowerCase() === targetName.toLowerCase());
      if (!found) { res.status(404).json({ ok: false, message: `未找到名为 "${targetName}" 的 cost center。` }); return; }

      const budgetByName = await fetchCostCenterBudgetMap(endpoint.enterprise);
      const spentByName = await fetchCostCenterSpentMap(endpoint.enterprise, [found], budgetByName);
      const nameKey = String(found.name || "").trim().toLowerCase();
      const budgetInfo = budgetByName.get(nameKey) || null;
      const seatBaseCost = PLAN_CONFIG.business.baseCost;
      res.json({
        ok: true, fetchedAt: new Date().toISOString(), enterprise: endpoint.enterprise, seatBaseCost,
        costCenter: {
          id: found.id || "", name: found.name || "-", seatBaseCost,
          budgetAmount: budgetInfo ? budgetInfo.amount : null,
          spentAmount: spentByName.get(nameKey) ?? null,
          state: found.state || "-", azureSubscription: found.azure_subscription || "",
          resources: Array.isArray(found.resources) ? found.resources : [],
        },
      });
    } catch (error) { writeError(res, error); }
  });

  router.post("/api/cost-centers/:id/add-users-from-teams", async (req, res) => {
    try {
      const endpoint = buildEndpoint();
      if (endpoint.kind !== "enterprise") throw new Error("Cost center API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
      const costCenterId = String(req.params.id || "").trim();
      if (!costCenterId) throw new Error("缺少 cost center ID。");
      const teamIds = Array.isArray(req.body?.teamIds) ? req.body.teamIds.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v)) : [];
      const dryRun = Boolean(req.body?.dryRun);
      const removeMissingUsers = Boolean(req.body?.removeMissingUsers);
      if (teamIds.length === 0) throw new Error("请至少选择一个 Team。");

      const [ccList, teamsRaw] = await Promise.all([
        githubGetJson(`/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers`),
        githubGetJson(`/enterprises/${encodeURIComponent(endpoint.enterprise)}/teams`, new URLSearchParams({ per_page: "100" })),
      ]);

      const allCostCenters = Array.isArray(ccList?.costCenters) ? ccList.costCenters : [];
      const target = allCostCenters.find((cc) => String(cc?.id || "") === costCenterId);
      if (!target) { res.status(404).json({ ok: false, message: "未找到指定的 cost center。" }); return; }

      const teams = Array.isArray(teamsRaw) ? teamsRaw : [];
      const teamById = new Map(teams.map((t) => [String(t.id), t]));
      const unresolvedTeams = teamIds.filter((id) => !teamById.has(id));
      const resolvedTeamIds = teamIds.filter((id) => teamById.has(id));

      const memberResults = await Promise.all(resolvedTeamIds.map(async (id) => {
        const members = await fetchEnterpriseTeamMembers(endpoint.enterprise, id);
        return { id, members };
      }));

      const requestedUsersSet = new Set();
      for (const tr of memberResults) for (const login of tr.members) requestedUsersSet.add(login.toLowerCase());

      const existingUsersSet = new Set(
        (Array.isArray(target.resources) ? target.resources : [])
          .filter((r) => String(r?.type || "").toLowerCase() === "user")
          .map((r) => String(r.name || "").trim().toLowerCase())
          .filter(Boolean)
      );

      const existingUsers = [], newUsers = [];
      for (const u of requestedUsersSet) { if (existingUsersSet.has(u)) existingUsers.push(u); else newUsers.push(u); }
      const usersToRemove = [];
      for (const u of existingUsersSet) { if (!requestedUsersSet.has(u)) usersToRemove.push(u); }

      const RESOURCE_BATCH_SIZE = 50;
      const resourcePath = `/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers/${encodeURIComponent(costCenterId)}/resource`;
      let addedBatches = 0, removedBatches = 0;

      if (!dryRun && newUsers.length > 0) {
        for (let i = 0; i < newUsers.length; i += RESOURCE_BATCH_SIZE) {
          await githubPostJson(resourcePath, { users: newUsers.slice(i, i + RESOURCE_BATCH_SIZE) });
          addedBatches += 1;
        }
      }
      if (!dryRun && removeMissingUsers && usersToRemove.length > 0) {
        for (let i = 0; i < usersToRemove.length; i += RESOURCE_BATCH_SIZE) {
          await githubDeleteJson(resourcePath, { users: usersToRemove.slice(i, i + RESOURCE_BATCH_SIZE) });
          removedBatches += 1;
        }
      }

      res.json({
        ok: true, dryRun, removeMissingUsers,
        costCenter: { id: target.id || "", name: target.name || "-" },
        selectedTeams: resolvedTeamIds.map((id) => ({ id, name: teamById.get(id)?.name || id })),
        unresolvedTeams,
        requestedUsersCount: requestedUsersSet.size,
        existingUsersCount: existingUsers.length,
        newUsersCount: newUsers.length,
        usersToRemoveCount: usersToRemove.length,
        existingUsers, newUsers, usersToRemove,
        addedBatches, removedBatches, batchSize: RESOURCE_BATCH_SIZE,
      });
    } catch (error) { writeError(res, error); }
  });

  return router;
};
