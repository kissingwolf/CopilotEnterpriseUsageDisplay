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
    const todayY = now.getUTCFullYear();
    const todayM = now.getUTCMonth() + 1;
    const todayD = now.getUTCDate();
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
      yest.setUTCDate(yest.getUTCDate() - 1);
      const endDay = yest.getUTCDate();
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
    const seatLogins = seats.map((s) => s.login);
    const lookup = userMappingService.buildLookup(seatLogins);
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

      const mapped = lookup[login.toLowerCase()] || null;
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

  /**
   * Reusable monthly bill computation, mirroring GET /api/bill but without
   * the HTTP layer. Used by other routers (e.g. cost-center) to align with
   * billpage's "套餐外附加费" (overageCost) numbers.
   *
   * Returns { ok, yearMonth, status, message, dateRange, teams, grandTotal }.
   * Throws on invalid year/month or computation errors.
   */
  async function getMonthlyBillTeams(year, month) {
    if (!Number.isFinite(year) || !Number.isFinite(month)) throw new Error("无效的年份或月份");
    if (month < 1 || month > 12) throw new Error("无效的月份");
    if (year < 2020 || year > 2100) throw new Error("无效的年份");

    const ym = yearMonthKey(year, month);
    const period = resolveBillPeriod(year, month);

    if (period.status === "aggregating") {
      return {
        ok: true, yearMonth: ym, status: period.status, message: period.message,
        dateRange: null, teams: [],
        grandTotal: { seatCost: 0, overageCost: 0, totalCost: 0, totalMembers: 0 },
      };
    }

    let billRows;
    let noUsage = false;
    const cached = usageStore.hasBill(ym);

    if (cached && period.status === "complete") {
      billRows = usageStore.getBill(ym);
      const missingAdLogins = billRows.filter((r) => !r.adName).map((r) => r.login);
      const adLookup = userMappingService.buildLookup(missingAdLogins);
      for (const row of billRows) {
        if (!row.adName) {
          const mapped = adLookup[row.login.toLowerCase()] || null;
          if (mapped) row.adName = mapped.adName;
        }
      }
      const totalRequests = billRows.reduce((s, r) => s + (r.requests || 0), 0);
      if (billRows.length > 0 && totalRequests === 0) {
        logger.info({ yearMonth: ym }, "Cached bill has zero usage, recomputing");
        const result = await computeBill(year, month, period);
        billRows = result.billRows;
        noUsage = result.hasUsage === false;
      }
    } else {
      const result = await computeBill(year, month, period);
      billRows = result.billRows;
      noUsage = result.hasUsage === false;
    }

    const teams = groupByTeam(billRows);
    const grandTotal = { seatCost: 0, overageCost: 0, totalCost: 0, totalMembers: 0 };
    for (const t of teams) {
      grandTotal.seatCost = Math.round((grandTotal.seatCost + t.seatCost) * 10000) / 10000;
      grandTotal.overageCost = Math.round((grandTotal.overageCost + t.overageCost) * 10000) / 10000;
      grandTotal.totalCost = Math.round((grandTotal.totalCost + t.totalCost) * 10000) / 10000;
      grandTotal.totalMembers += t.members;
    }

    return {
      ok: true, yearMonth: ym, status: period.status,
      message: noUsage ? "该月暂无 Copilot 使用数据" : period.message,
      dateRange: { start: period.start, end: period.end },
      teams, grandTotal,
    };
  }

  /* ── Route ── */

  router.get("/api/bill", async (req, res) => {
    try {
      const now = new Date();
      const year = Number(req.query.year) || now.getUTCFullYear();
      const month = Number(req.query.month) || (now.getUTCMonth() + 1);
      const result = await getMonthlyBillTeams(year, month);
      res.json(result);
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
      const year = Number(req.body?.year) || now.getUTCFullYear();
      const month = Number(req.body?.month) || (now.getUTCMonth() + 1);
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

  /* ── Export Excel ── */

  router.get("/api/bill/export", async (req, res) => {
    try {
      const ExcelJS = require("exceljs");

      const now = new Date();
      const year = Number(req.query.year) || now.getUTCFullYear();
      const month = Number(req.query.month) || (now.getUTCMonth() + 1);

      if (month < 1 || month > 12) throw new Error("无效的月份");
      if (year < 2020 || year > 2100) throw new Error("无效的年份");

      const ym = yearMonthKey(year, month);
      const period = resolveBillPeriod(year, month);

      if (period.status === "aggregating") {
        return res.status(400).json({ ok: false, error: "每月前两天为数据汇聚时间，暂不可导出" });
      }

      // Get bill data (same logic as GET /api/bill)
      let billRows;
      const cached = usageStore.hasBill(ym);

      if (cached && period.status === "complete") {
        billRows = usageStore.getBill(ym);
        const missingAdLogins = billRows.filter((r) => !r.adName).map((r) => r.login);
        const adLookup = userMappingService.buildLookup(missingAdLogins);
        for (const row of billRows) {
          if (!row.adName) {
            const mapped = adLookup[row.login.toLowerCase()] || null;
            if (mapped) row.adName = mapped.adName;
          }
        }
      } else {
        const result = await computeBill(year, month, period);
        billRows = result.billRows;
        if (!result.hasUsage) {
          return res.status(400).json({ ok: false, error: "该月暂无账单数据可导出" });
        }
      }

      if (!billRows || billRows.length === 0) {
        return res.status(400).json({ ok: false, error: "该月暂无账单数据可导出" });
      }

      const teams = groupByTeam(billRows);

      // Build Excel workbook
      const workbook = new ExcelJS.Workbook();

      // Per-team sheets
      for (const t of teams) {
        // Excel sheet name max 31 chars, strip invalid chars
        const sheetName = t.team.replace(/[\\/*?:\[\]]/g, "_").slice(0, 31);
        const sheet = workbook.addWorksheet(sheetName);

        sheet.columns = [
          { header: "用户名", key: "userName", width: 20 },
          { header: "TEAM名", key: "teamName", width: 30 },
          { header: "用量信息", key: "usage", width: 25 },
          { header: "套餐外附加费(USD)", key: "extraFee", width: 20 },
          { header: "总费用", key: "total", width: 15 },
        ];

        // Bold header row
        sheet.getRow(1).font = { bold: true };

        for (const u of t.users) {
          const usageStr = `${u.planType} (${u.requests}/${u.quota})`;
          const extraFeeStr = u.overageRequests > 0
            ? `$${u.overageCost.toFixed(2)} (${u.overageRequests} reqs)`
            : "--";
          sheet.addRow({
            userName: u.adName || u.login,
            teamName: t.team,
            usage: usageStr,
            extraFee: extraFeeStr,
            total: `$${u.totalCost.toFixed(2)}`,
          });
        }
      }

      // Total summary sheet
      const totalSheet = workbook.addWorksheet("Total");
      totalSheet.columns = [
        { header: "TEAM", key: "team", width: 35 },
        { header: "成员数", key: "members", width: 10 },
        { header: "席位费(USD)", key: "seatCost", width: 15 },
        { header: "套餐外附加费(USD)", key: "overageCost", width: 20 },
        { header: "总费用(USD)", key: "totalCost", width: 15 },
      ];
      totalSheet.getRow(1).font = { bold: true };

      let grandSeat = 0, grandOverage = 0, grandTotal = 0, grandMembers = 0;
      for (const t of teams) {
        totalSheet.addRow({
          team: t.team,
          members: t.members,
          seatCost: `$${t.seatCost.toFixed(2)}`,
          overageCost: `$${t.overageCost.toFixed(2)}`,
          totalCost: `$${t.totalCost.toFixed(2)}`,
        });
        grandSeat += t.seatCost;
        grandOverage += t.overageCost;
        grandTotal += t.totalCost;
        grandMembers += t.members;
      }

      // Grand total row
      const grandRow = totalSheet.addRow({
        team: "合计",
        members: grandMembers,
        seatCost: `$${grandSeat.toFixed(2)}`,
        overageCost: `$${grandOverage.toFixed(2)}`,
        totalCost: `$${grandTotal.toFixed(2)}`,
      });
      grandRow.font = { bold: true };

      // Write to buffer and send
      const buffer = await workbook.xlsx.writeBuffer();
      const filename = `copilot-bill-${ym}.xlsx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(Buffer.from(buffer));
    } catch (error) {
      writeError(res, error);
    }
  });

  return { router, getMonthlyBillTeams };
};
