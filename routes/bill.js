/**
 * Bill routes – GET /api/bill
 * Team-level monthly billing with SQLite caching.
 */
const express = require("express");
const logger = require("../lib/logger");
const { PLAN_CONFIG, calcAmount } = require("../lib/billing-config");
const { githubGetJson, MAX_CONCURRENT_GITHUB } = require("../lib/github-api");
const { toNumber, pickUser, writeError, buildQueryParams, buildEndpoint } = require("../lib/helpers");
const { enumerateDays } = require("../lib/date-utils");
const { ensureSeatsData } = require("./seats");

module.exports = function createBillRouter({ usageStore, teamCache, userMappingService, usageRouter }) {
  const router = express.Router();

  /* ── helpers ── */

  function yearMonthKey(year, month) {
    return `${year}-${String(month).padStart(2, "0")}`;
  }

  function lastDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /**
   * Determine bill status and effective date range.
   */
  function resolveBillPeriod(year, month) {
    const now = new Date();
    const todayY = now.getFullYear();
    const todayM = now.getMonth() + 1;
    const todayD = now.getDate();
    const isCurrent = year === todayY && month === todayM;
    const lastDay = lastDayOfMonth(year, month);

    if (isCurrent && todayD <= 2) {
      return {
        status: "aggregating",
        message: "每月前两天为数据汇聚时间，核账中",
        start: null,
        end: null,
      };
    }

    if (isCurrent) {
      // yesterday
      const yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      const endDay = yest.getDate();
      return {
        status: "partial",
        message: "当前账单周期未结束，显示截至昨日数据",
        start: `${year}-${String(month).padStart(2, "0")}-01`,
        end: `${year}-${String(month).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
      };
    }

    return {
      status: "complete",
      message: null,
      start: `${year}-${String(month).padStart(2, "0")}-01`,
      end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  /**
   * Fetch per-user premium request usage for a whole month from GitHub API.
   * Returns Map<login, totalRequests>.
   */
  async function fetchMonthUsage(year, month) {
    const endpoint = buildEndpoint();
    const params = buildQueryParams({ year, month });
    const data = await githubGetJson(endpoint.path, params);
    const usageItems = Array.isArray(data?.usageItems) ? data.usageItems : [];

    const byUser = new Map();
    for (const item of usageItems) {
      const user = pickUser(item);
      if (user === "(unknown)") continue;
      const requests = toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
      byUser.set(user, (byUser.get(user) || 0) + requests);
    }
    return byUser;
  }

  /**
   * Try to build usage map from SQLite daily_usage cache for a date range.
   * Returns Map<login, totalRequests> or null if data is incomplete.
   */
  function buildUsageFromSQLite(startStr, endStr) {
    const rows = usageStore.getDaysInRange(startStr, endStr);
    if (!rows || rows.length === 0) return null;

    // Check completeness: count expected days
    const start = new Date(startStr + "T00:00:00Z");
    const end = new Date(endStr + "T00:00:00Z");
    let expectedDays = 0;
    const cur = new Date(start);
    while (cur <= end) {
      expectedDays++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    // We allow partial coverage — use what we have
    const byUser = new Map();
    for (const row of rows) {
      const ranking = row.ranking ? JSON.parse(row.ranking) : null;
      if (ranking && ranking.length > 0) {
        for (const r of ranking) {
          if (r.user && r.user !== "(unknown)") {
            byUser.set(r.user, (byUser.get(r.user) || 0) + (r.requests || 0));
          }
        }
      } else {
        // Fall back to raw data
        const data = row.data ? JSON.parse(row.data) : null;
        const usageItems = Array.isArray(data?.usageItems) ? data.usageItems : [];
        for (const item of usageItems) {
          const user = pickUser(item);
          if (user === "(unknown)") continue;
          const requests = toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
          byUser.set(user, (byUser.get(user) || 0) + requests);
        }
      }
    }
    return byUser.size > 0 ? byUser : null;
  }

  /**
   * Compute and persist bill rows for a given month.
   * Returns { billRows, hasUsage }.
   */
  async function computeBill(year, month, period) {
    await ensureSeatsData(teamCache, usageStore);
    const seats = teamCache.seatsRaw;
    if (!seats || seats.length === 0) {
      throw new Error("无法获取 Copilot 席位数据");
    }

    // 1. Get usage data: try SQLite first, then GitHub API for the month
    let usageMap;
    if (period.start && period.end) {
      usageMap = buildUsageFromSQLite(period.start, period.end);
    }
    if (!usageMap) {
      usageMap = await fetchMonthUsage(year, month);
    }

    const yearMonth = yearMonthKey(year, month);

    // If no usage data at all for the month, treat as "no bill" (don't charge
    // current seats for a month that has no activity). Also clean up any stale
    // cached bill rows so future queries don't return incorrect data.
    if (!usageMap || usageMap.size === 0) {
      usageStore.deleteBill(yearMonth);
      logger.info({ yearMonth }, "No usage data for month, returning empty bill");
      return { billRows: [], hasUsage: false };
    }

    // 2. Build per-user bill rows
    const computedAt = new Date().toISOString();
    const billRows = [];

    for (const seat of seats) {
      const login = seat.login;
      const team = seat.team || "-";
      const planType = (seat.planType || "business").toLowerCase();
      const cfg = PLAN_CONFIG[planType] || PLAN_CONFIG.business;
      const requests = Math.round((usageMap.get(login) || 0) * 100) / 100;
      const seatCost = cfg.baseCost;
      const overageRequests = Math.round(Math.max(0, requests - cfg.quota) * 100) / 100;
      const overageCost = Math.round(overageRequests * cfg.overagePrice * 10000) / 10000;
      const totalCost = Math.round((seatCost + overageCost) * 10000) / 10000;

      const mapped = userMappingService.getUserByGithub(login);
      billRows.push({
        yearMonth,
        team: team === "-" ? "未分配团队" : team,
        login,
        adName: mapped ? mapped.adName : null,
        planType,
        seatCost,
        requests,
        quota: cfg.quota,
        overageRequests,
        overageCost,
        totalCost,
        computedAt,
      });
    }

    // 3. Persist to SQLite
    usageStore.saveBill(yearMonth, billRows);
    logger.info({ yearMonth, users: billRows.length }, "Computed and saved monthly bill");

    return { billRows, hasUsage: true };
  }

  /**
   * Group flat bill rows into team-level aggregation.
   */
  function groupByTeam(billRows) {
    const teamMap = new Map();
    for (const row of billRows) {
      if (!teamMap.has(row.team)) {
        teamMap.set(row.team, { team: row.team, members: 0, seatCost: 0, overageCost: 0, totalCost: 0, users: [] });
      }
      const t = teamMap.get(row.team);
      t.members += 1;
      t.seatCost = Math.round((t.seatCost + row.seatCost) * 10000) / 10000;
      t.overageCost = Math.round((t.overageCost + row.overageCost) * 10000) / 10000;
      t.totalCost = Math.round((t.totalCost + row.totalCost) * 10000) / 10000;
      t.users.push({
        login: row.login,
        adName: row.adName || null,
        planType: row.planType,
        seatCost: row.seatCost,
        requests: row.requests,
        quota: row.quota,
        overageRequests: row.overageRequests,
        overageCost: row.overageCost,
        totalCost: row.totalCost,
      });
    }

    // Sort teams by name, users within team by login
    const teams = Array.from(teamMap.values()).sort((a, b) => a.team.localeCompare(b.team));
    for (const t of teams) {
      t.users.sort((a, b) => a.login.localeCompare(b.login));
    }
    return teams;
  }

  /* ── Route ── */

  router.get("/api/bill", async (req, res) => {
    try {
      const now = new Date();
      const year = Number(req.query.year) || now.getFullYear();
      const month = Number(req.query.month) || (now.getMonth() + 1);

      if (month < 1 || month > 12) throw new Error("无效的月份");
      if (year < 2020 || year > 2100) throw new Error("无效的年份");

      const ym = yearMonthKey(year, month);
      const period = resolveBillPeriod(year, month);

      // Aggregating status — return immediately with message
      if (period.status === "aggregating") {
        return res.json({
          ok: true,
          yearMonth: ym,
          status: period.status,
          message: period.message,
          dateRange: null,
          teams: [],
          grandTotal: { seatCost: 0, overageCost: 0, totalCost: 0, totalMembers: 0 },
        });
      }

      // Check SQLite cache
      let billRows;
      let noUsage = false;
      const cached = usageStore.hasBill(ym);

      if (cached && period.status === "complete") {
        // Historical month with cached data — use directly
        billRows = usageStore.getBill(ym);
        // Guard: detect stale "empty-month" cache written before the no-usage
        // fix (all rows had seat cost but zero requests). Recompute in that
        // case so the cleanup path runs.
        const totalRequests = billRows.reduce((s, r) => s + (r.requests || 0), 0);
        if (billRows.length > 0 && totalRequests === 0) {
          logger.info({ yearMonth: ym }, "Cached bill has zero usage, recomputing");
          const result = await computeBill(year, month, period);
          billRows = result.billRows;
          noUsage = result.hasUsage === false;
        }
      } else {
        // Current month or no cache — compute
        const result = await computeBill(year, month, period);
        billRows = result.billRows;
        noUsage = result.hasUsage === false;
      }

      const teams = groupByTeam(billRows);
      const grandTotal = {
        seatCost: 0,
        overageCost: 0,
        totalCost: 0,
        totalMembers: 0,
      };
      for (const t of teams) {
        grandTotal.seatCost = Math.round((grandTotal.seatCost + t.seatCost) * 10000) / 10000;
        grandTotal.overageCost = Math.round((grandTotal.overageCost + t.overageCost) * 10000) / 10000;
        grandTotal.totalCost = Math.round((grandTotal.totalCost + t.totalCost) * 10000) / 10000;
        grandTotal.totalMembers += t.members;
      }

      res.json({
        ok: true,
        yearMonth: ym,
        status: period.status,
        message: noUsage ? "该月暂无 Copilot 使用数据" : period.message,
        dateRange: { start: period.start, end: period.end },
        teams,
        grandTotal,
      });
    } catch (error) {
      writeError(res, error);
    }
  });

  /**
   * POST /api/bill/refresh
   * Force-refresh a whole month: drop SQLite daily/monthly cache for the
   * month, re-fetch every day from GitHub, recompute the bill, and return.
   * Body: { year, month }
   */
  router.post("/api/bill/refresh", async (req, res) => {
    try {
      const now = new Date();
      const year = Number(req.body?.year) || now.getFullYear();
      const month = Number(req.body?.month) || (now.getMonth() + 1);
      if (month < 1 || month > 12) throw new Error("无效的月份");
      if (year < 2020 || year > 2100) throw new Error("无效的年份");

      const ym = yearMonthKey(year, month);
      const period = resolveBillPeriod(year, month);

      if (period.status === "aggregating") {
        return res.json({
          ok: true, yearMonth: ym, status: period.status,
          message: period.message, dateRange: null,
          refreshedDays: 0, failedDates: [],
          teams: [], grandTotal: { seatCost: 0, overageCost: 0, totalCost: 0, totalMembers: 0 },
          fetchedAt: new Date().toISOString(),
        });
      }

      const days = enumerateDays(period.start, period.end);
      if (days.length === 0) throw new Error("无效的账单周期范围");

      const forceRefreshDay = usageRouter && usageRouter.forceRefreshDay;
      if (typeof forceRefreshDay !== "function") {
        throw new Error("内部错误：forceRefreshDay 未注入");
      }

      logger.info({ yearMonth: ym, days: days.length }, "Force-refreshing month");

      // 1. Wipe stale cached rows for this month so nothing falls back to them.
      const removedDaily = usageStore.deleteDaysInMonth(year, month);
      usageStore.deleteBill(ym);
      logger.info({ yearMonth: ym, removedDaily }, "Cleared SQLite cache for month");

      // 2. Refresh every day in the period (concurrent, throttled).
      const failedDates = [];
      let refreshedDays = 0;
      for (let i = 0; i < days.length; i += MAX_CONCURRENT_GITHUB) {
        const chunk = days.slice(i, i + MAX_CONCURRENT_GITHUB);
        const results = await Promise.allSettled(
          chunk.map((d) => {
            const dateStr = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
            return forceRefreshDay(dateStr).then(() => dateStr);
          })
        );
        for (let j = 0; j < results.length; j += 1) {
          const r = results[j];
          const d = chunk[j];
          const dateStr = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
          if (r.status === "fulfilled") refreshedDays += 1;
          else { failedDates.push(dateStr); logger.warn({ date: dateStr, err: r.reason && r.reason.message }, "Day refresh failed"); }
        }
      }

      // 3. Recompute the monthly bill from the fresh daily rows.
      const { billRows, hasUsage } = await computeBill(year, month, period);
      const teams = groupByTeam(billRows);
      const grandTotal = { seatCost: 0, overageCost: 0, totalCost: 0, totalMembers: 0 };
      for (const t of teams) {
        grandTotal.seatCost = Math.round((grandTotal.seatCost + t.seatCost) * 10000) / 10000;
        grandTotal.overageCost = Math.round((grandTotal.overageCost + t.overageCost) * 10000) / 10000;
        grandTotal.totalCost = Math.round((grandTotal.totalCost + t.totalCost) * 10000) / 10000;
        grandTotal.totalMembers += t.members;
      }

      res.json({
        ok: true,
        yearMonth: ym,
        status: period.status,
        message: hasUsage ? period.message : "该月暂无 Copilot 使用数据",
        dateRange: { start: period.start, end: period.end },
        refreshedDays,
        failedDates,
        teams,
        grandTotal,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      writeError(res, error);
    }
  });

  return router;
};
