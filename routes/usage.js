/**
 * Usage routes – GET /api/usage, POST /api/usage/refresh
 */
const express = require("express");
const logger = require("../lib/logger");
const { requiredEnv, INCLUDED_QUOTA, PLAN_CONFIG, calcAmount } = require("../lib/billing-config");
const { githubGetJson } = require("../lib/github-api");
const { toNumber, pickUser, writeError, buildQueryParams, buildEndpoint } = require("../lib/helpers");
const { enumerateDays } = require("../lib/date-utils");

const CACHE_TTL_MS = (Number(requiredEnv("CACHE_TTL")) || 300) * 1000;

module.exports = function createUsageRouter({ usageStore, teamCache, userMappingService }) {
  const router = express.Router();

  /* ── In-memory caches for refresh dedup ── */
  const refreshCache = new Map();
  const refreshInFlight = new Map();

  /* ── State (server-side latest result) ── */
  const state = {
    fetchedAt: null, ranking: [], source: null,
    rawItemsCount: 0, mode: "direct", queryMode: "default",
  };

  /* ── Aggregation helpers ── */

  function aggregateRanking(payload, quiet) {
    const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
    const byUser = new Map();
    for (const item of usageItems) {
      const user = pickUser(item);
      const requests = toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
      const amount = toNumber(item.netAmount) || toNumber(item.grossAmount) || toNumber(item.amount);
      const current = byUser.get(user) || { user, requests: 0, amount: 0 };
      current.requests += requests;
      current.amount += amount;
      byUser.set(user, current);
    }
    const results = Array.from(byUser.values())
      .filter((row) => row.user !== "(unknown)")
      .sort((a, b) => b.requests - a.requests)
      .map((row, idx) => ({
        rank: idx + 1, user: row.user,
        requests: Math.round(row.requests * 100) / 100,
        amount: Math.round(row.amount * 10000) / 10000,
      }));
    const unknownRow = byUser.get("(unknown)");
    if (unknownRow && !quiet) {
      logger.warn({ unknownRequests: unknownRow.requests, totalItems: usageItems.length, knownUsers: results.length }, "Skipped unknown user requests");
    }
    return results;
  }

  function hasKnownUsers(ranking) {
    return ranking.some((row) => row.user !== "(unknown)");
  }

  function aggregateSingleUserUsage(payload) {
    const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
    let requests = 0, amount = 0;
    for (const item of usageItems) {
      requests += toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
      amount += toNumber(item.netAmount) || toNumber(item.grossAmount) || toNumber(item.amount);
    }
    return { requests: Math.round(requests * 100) / 100, amount: Math.round(amount * 10000) / 10000 };
  }

  function getUserPlanType(login) {
    const seat = teamCache.seatsRaw.find((s) => s.login === login);
    return seat ? seat.planType : "business";
  }

  function enrichRanking(ranking) {
    return ranking.map((row) => {
      const planType = getUserPlanType(row.user);
      const cfg = PLAN_CONFIG[planType] || PLAN_CONFIG.business;
      const reqsForPct = row.cycleRequests != null ? row.cycleRequests : row.requests;
      const mapped = userMappingService.getUserByGithub(row.user);
      const result = {
        user: row.user,
        adName: mapped ? mapped.adName : null,
        team: (teamCache.userTeamMap[row.user] || []).join(", ") || "-",
        requests: row.requests,
        percentage: cfg.quota > 0 ? Math.round(reqsForPct / cfg.quota * 10000) / 100 : 0,
        amount: calcAmount(reqsForPct, planType),
      };
      if (row.cycleRequests != null) result.cycleRequests = row.cycleRequests;
      return result;
    });
  }

  async function buildRankingByUserQueries(endpoint, dateOverride = {}) {
    const users = Object.keys(teamCache.userTeamMap);
    if (users.length === 0) throw new Error("No Copilot users discovered.");
    const results = [];
    const chunkSize = 8;
    let failedQueries = 0, firstErrorMessage = "";
    for (let i = 0; i < users.length; i += chunkSize) {
      const chunk = users.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(async (user) => {
        try {
          const payload = await githubGetJson(endpoint.path, buildQueryParams({ ...dateOverride, user }));
          const summary = aggregateSingleUserUsage(payload);
          return { user, requests: summary.requests, amount: summary.amount };
        } catch (error) {
          failedQueries += 1;
          if (!firstErrorMessage && error instanceof Error) firstErrorMessage = error.message;
          return { user, requests: 0, amount: 0 };
        }
      }));
      results.push(...chunkResults);
    }
    if (failedQueries === users.length) throw new Error(`Per-user usage query failed for all users. ${firstErrorMessage}`);
    return results.sort((a, b) => b.requests - a.requests).map((row, idx) => ({
      rank: idx + 1, user: row.user, requests: row.requests, amount: row.amount,
    }));
  }

  /**
   * Build cycle (monthly) ranking by aggregating SQLite-cached daily rows.
   *
   * Returns null (so caller falls back to GitHub API) when the local cache is
   * NOT trustworthy enough to represent the full cycle. Three integrity checks:
   *   1. Coverage: every expected day (startDay..endDay) must exist in SQLite.
   *      - endDay = today (for current month) or last day of that month.
   *      - startDay = COPILOT_START_DATE's day (if same month), else 1.
   *   2. Recency: the most recent 3 days must have been fetched within
   *      RECENT_TTL_MS (1h) — GitHub has 24~48h delay, fresh near-end data is
   *      critical to avoid "daily > cycle" paradox.
   *   3. Non-empty ranking: every day's ranking must be a non-empty array.
   *      A placeholder row with empty ranking means that day's aggregation
   *      failed and cycle totals would under-count.
   */
  function buildCycleFromSQLite(year, month) {
    const RECENT_TTL_MS = 60 * 60 * 1000;
    const RECENT_WINDOW_DAYS = 3;

    /* ── Compute cycle start day ── */
    let cycleStartDay = 1;
    const copilotStartDate = process.env.COPILOT_START_DATE || "";
    if (copilotStartDate) {
      const m = copilotStartDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const startY = Number(m[1]);
        const startM = Number(m[2]);
        const startD = Number(m[3]);
        if (year < startY || (year === startY && month < startM)) {
          // Month is entirely before Copilot started — no data expected
          return null;
        }
        if (year === startY && month === startM) {
          cycleStartDay = startD;
        }
      }
    }

    const now = new Date();
    const isCurrentMonth =
      now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month;
    // Use UTC day-0-of-next-month to get the real last day in UTC, avoiding
    // local-TZ skew (e.g. `new Date(2026, 4, 0)` in CST yields 2026-04-30 00:00
    // local = 2026-04-29 16:00 UTC → getUTCDate() == 29, off-by-one).
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDay = isCurrentMonth
      ? Math.min(now.getUTCDate(), lastDayOfMonth)
      : lastDayOfMonth;
    const expectedDays = endDay - cycleStartDay + 1; // days startDay..endDay

    const pad = (n) => String(n).padStart(2, "0");
    const startStr = `${year}-${pad(month)}-${pad(cycleStartDay)}`;
    const endStr = `${year}-${pad(month)}-${pad(endDay)}`;
    const rows = usageStore.getDaysInRange(startStr, endStr);

    /* Integrity check 1: coverage */
    if (rows.length < expectedDays) {
      logger.info(
        { year, month, startDay: cycleStartDay, endDay, haveDays: rows.length, expectedDays },
        "SQLite cycle incomplete (missing days), falling back to GitHub API"
      );
      return null;
    }

    const rowByDate = new Map(rows.map((r) => [r.date, r]));

    /* Integrity check 2: recency + mode trustworthiness on the last RECENT_WINDOW_DAYS days
     * - must exist in SQLite
     * - fetched_at within RECENT_TTL_MS (1h)
     * - mode must be "per-user-fallback" when raw_count > 0. A direct-mode row
     *   near the end of cycle is usually a mid-state (per-user-fallback still
     *   running in background) and its ranking under-counts known users. Using
     *   it to build the cycle total leads to "daily > cycle" paradox. */
    const freshCutoff = Date.now() - RECENT_TTL_MS;
    for (let i = 0; i < RECENT_WINDOW_DAYS; i += 1) {
      const d = endDay - i;
      if (d < cycleStartDay) break;
      const key = `${year}-${pad(month)}-${pad(d)}`;
      const row = rowByDate.get(key);
      if (!row) {
        logger.info({ missingDate: key }, "SQLite cycle: recent day missing");
        return null;
      }
      const fetchedAtMs = new Date(row.fetched_at).getTime();
      if (isCurrentMonth && (!Number.isFinite(fetchedAtMs) || fetchedAtMs < freshCutoff)) {
        logger.info(
          { date: key, fetched_at: row.fetched_at },
          "SQLite cycle: recent day stale, falling back to GitHub API"
        );
        return null;
      }
      const rawCount = typeof row.raw_count === "number" ? row.raw_count : 0;
      if (isCurrentMonth && rawCount > 0 && row.mode !== "per-user-fallback") {
        logger.info(
          { date: key, mode: row.mode, rawCount },
          "SQLite cycle: recent day not per-user-fallback (likely mid-state), falling back"
        );
        return null;
      }
    }

    /* Integrity check 3: non-empty ranking + aggregate
     * A day with zero raw_count AND empty ranking is a legitimate "no usage"
     * day; we only reject when ranking is empty but raw items exist (i.e.
     * aggregation silently lost users). */
    const byUser = new Map();
    for (const row of rows) {
      const ranking = row.ranking ? JSON.parse(row.ranking) : null;
      if (!ranking || ranking.length === 0) {
        const rawCount = typeof row.raw_count === "number" ? row.raw_count : 0;
        if (rawCount > 0) {
          logger.info(
            { date: row.date, rawCount },
            "SQLite cycle: day has raw items but empty ranking, falling back"
          );
          return null;
        }
        continue;
      }
      for (const entry of ranking) {
        const cur = byUser.get(entry.user) || { user: entry.user, requests: 0, amount: 0 };
        cur.requests += entry.requests;
        cur.amount += entry.amount;
        byUser.set(cur.user, cur);
      }
    }

    const results = Array.from(byUser.values())
      .sort((a, b) => b.requests - a.requests)
      .map((row, idx) => ({
        rank: idx + 1, user: row.user,
        requests: Math.round(row.requests * 100) / 100,
        amount: Math.round(row.amount * 10000) / 10000,
      }));
    return results.length > 0 ? results : null;
  }

  async function refreshForDateOverride(dateOverride, opts) {
    const force = !!(opts && opts.force);
    const cacheKey = JSON.stringify(dateOverride || {});
    if (!force) {
      const cached = refreshCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        logger.debug({ cacheKey, ageMs: Date.now() - cached.ts }, "Refresh cache hit");
        return { result: cached.result, cacheHit: "memory" };
      }
    }
    if (refreshInFlight.has(cacheKey)) return { result: (await refreshInFlight.get(cacheKey)).result, cacheHit: "shared" };
    const promise = _refreshImpl(dateOverride, cacheKey, force);
    refreshInFlight.set(cacheKey, promise);
    try { return await promise; } finally { refreshInFlight.delete(cacheKey); }
  }

  /**
   * Effective TTL for a SQLite-cached daily row.
   * - Within the last 3 days (UTC): 1 hour TTL (GitHub API has 24-48h delay).
   * - Older: USAGE_TTL_MS (90d).
   */
  function getEffectiveTTL(year, month, day) {
    if (!day) return null;
    const RECENT_TTL_MS = 60 * 60 * 1000;
    const { USAGE_TTL_MS } = require("../lib/usage-store");
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const dayUtc = Date.UTC(year, month - 1, day);
    const ageDays = Math.floor((todayUtc - dayUtc) / (24 * 60 * 60 * 1000));
    return ageDays <= 3 ? RECENT_TTL_MS : USAGE_TTL_MS;
  }

  /**
   * Public helper: force refresh a single date string "YYYY-MM-DD".
   * Bypasses memory + SQLite cache, writes fresh result to SQLite.
   */
  async function forceRefreshDay(dateStr) {
    const d = parseDateStr(dateStr);
    if (!d) throw new Error("无效的日期格式: " + dateStr);
    return refreshForDateOverride(d, { force: true });
  }

  async function _refreshImpl(dateOverride, cacheKey, force) {
    const now = new Date();
    const year = dateOverride?.year || Number(requiredEnv("BILLING_YEAR")) || now.getUTCFullYear();
    const month = dateOverride?.month || Number(requiredEnv("BILLING_MONTH")) || (now.getUTCMonth() + 1);
    const day = dateOverride?.day;
    const dateKey = day
      ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : `${year}-${String(month).padStart(2, "0")}`;

    /* Check SQLite cache for single day */
    if (day && !force) {
      const cachedDay = usageStore.getDay(dateKey);
      const effectiveTTL = getEffectiveTTL(year, month, day);
      if (cachedDay && Date.now() - new Date(cachedDay.fetched_at).getTime() < effectiveTTL) {
        logger.debug({ dateKey, source: "sqlite" }, "SQLite cache hit");
        let ranking = cachedDay.ranking || aggregateRanking(cachedDay.data);
        let mode = cachedDay.mode;
        const usageItems = Array.isArray(cachedDay.data?.usageItems) ? cachedDay.data.usageItems : [];
        if (ranking.length === 0 && usageItems.length > 0 && Object.keys(teamCache.userTeamMap).length > 0) {
          logger.info({ dateKey, items: usageItems.length }, "SQLite cached ranking empty, triggering per-user fallback");
          try {
            ranking = await buildRankingByUserQueries(buildEndpoint(), dateOverride);
            mode = "per-user-fallback";
            if (ranking.length > 0) {
              usageStore.saveDay(dateKey, cachedDay.year, cachedDay.month, cachedDay.day, cachedDay.data, mode, cachedDay.raw_count, cachedDay.source, cachedDay.fetched_at, ranking);
            }
          } catch (e) {
            logger.error({ dateKey, err: e.message }, "Per-user fallback failed");
          }
        }
        const result = { ranking, mode, rawItemsCount: cachedDay.raw_count, source: cachedDay.source };
        refreshCache.set(cacheKey, { ts: Date.now(), result });
        return { result, cacheHit: "sqlite" };
      }
    }

    /* Cycle query (no day): try SQLite first */
    if (!day && !force) {
      const sqliteRanking = buildCycleFromSQLite(year, month);
      if (sqliteRanking) {
        const result = { ranking: sqliteRanking, mode: "sqlite-cycle", rawItemsCount: 0, source: buildEndpoint().scope };
        refreshCache.set(cacheKey, { ts: Date.now(), result });
        return { result, cacheHit: "sqlite" };
      }
    }

    /* Fetch from GitHub */
    const endpoint = buildEndpoint();
    const extra = dateOverride || {};
    logger.debug({ dateKey, endpoint: endpoint.path }, "Fetching from GitHub API");
    const data = await githubGetJson(endpoint.path, buildQueryParams(extra));
    let ranking = aggregateRanking(data, !day);
    let mode = "direct";
    if (!hasKnownUsers(ranking) && Array.isArray(data?.usageItems) && data.usageItems.length > 0) {
      if (day) {
        ranking = await buildRankingByUserQueries(endpoint, dateOverride);
        mode = "per-user-fallback";
      }
    }
    const result = {
      ranking, mode,
      rawItemsCount: Array.isArray(data?.usageItems) ? data.usageItems.length : 0,
      source: endpoint.scope,
    };
    if (day) {
      usageStore.saveDay(dateKey, year, month, day, data, mode, result.rawItemsCount, endpoint.scope, new Date().toISOString(), ranking.length > 0 ? ranking : null);
    }
    refreshCache.set(cacheKey, { ts: Date.now(), result });
    return { result, cacheHit: "github" };
  }

  function mergeRankings(list) {
    const byUser = new Map();
    for (const ranking of list) {
      for (const row of ranking) {
        const cur = byUser.get(row.user) || { user: row.user, requests: 0, amount: 0 };
        cur.requests += row.requests;
        cur.amount += row.amount;
        byUser.set(row.user, cur);
      }
    }
    return Array.from(byUser.values())
      .sort((a, b) => b.requests - a.requests)
      .map((row, idx) => ({
        rank: idx + 1, user: row.user,
        requests: Math.round(row.requests * 100) / 100,
        amount: Math.round(row.amount * 10000) / 10000,
      }));
  }

  function parseDateStr(str) {
    if (!str || typeof str !== "string") return null;
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }

  /* ── Routes ── */

  router.get("/api/usage", (_req, res) => {
    res.json({
      ok: true, fetchedAt: state.fetchedAt, source: state.source,
      rawItemsCount: state.rawItemsCount, mode: state.mode,
      dateLabel: state.dateLabel || "", queryMode: state.queryMode || "default",
      ranking: state.ranking, includedQuota: INCLUDED_QUOTA,
    });
  });

  router.post("/api/usage/refresh", async (req, res) => {
    try {
      const { ensureSeatsData } = require("./seats");
      await ensureSeatsData(teamCache, usageStore);

      const { queryMode, date, startDate, endDate, force } = req.body || {};
      const forceRefresh = force === true || force === "true" || force === 1 || force === "1";
      let ranking, mode, rawItemsCount, source, dateLabel;
      let cacheHits = 0, totalDaysQueried = 0;
      const { MAX_CONCURRENT_GITHUB } = require("../lib/github-api");

      if (queryMode === "range" && startDate && endDate) {
        const days = enumerateDays(startDate, endDate);
        if (days.length === 0) throw new Error("无效的日期范围");
        if (days.length > 31) throw new Error("日期范围不能超过 31 天");
        const allRankings = [];
        let totalRaw = 0, lastMode = "direct", lastSource = "";
        for (let i = 0; i < days.length; i += MAX_CONCURRENT_GITHUB) {
          const chunk = days.slice(i, i + MAX_CONCURRENT_GITHUB);
          const chunkResults = await Promise.all(chunk.map((d) => refreshForDateOverride(d, { force: forceRefresh })));
          for (const { result, cacheHit } of chunkResults) {
            allRankings.push(result.ranking);
            totalRaw += result.rawItemsCount;
            lastMode = result.mode; lastSource = result.source;
            totalDaysQueried += 1;
            if (cacheHit === "memory" || cacheHit === "sqlite" || cacheHit === "shared") cacheHits += 1;
          }
        }
        ranking = mergeRankings(allRankings);
        mode = lastMode; rawItemsCount = totalRaw; source = lastSource;
        dateLabel = `${startDate} ~ ${endDate} (${days.length}天)`;
      } else if (queryMode === "single" && date) {
        const d = parseDateStr(date);
        if (!d) throw new Error("无效的日期格式，请使用 YYYY-MM-DD");
        const [dailyResp, cycleResp] = await Promise.all([
          refreshForDateOverride(d, { force: forceRefresh }),
          refreshForDateOverride({ year: d.year, month: d.month }, { force: forceRefresh }),
        ]);
        totalDaysQueried = 2;
        if (dailyResp.cacheHit !== "github") cacheHits += 1;
        if (cycleResp.cacheHit !== "github") cacheHits += 1;
        const cycleMap = new Map();
        for (const row of cycleResp.result.ranking) cycleMap.set(row.user, row.requests);
        ranking = dailyResp.result.ranking.map((row) => ({ ...row, cycleRequests: cycleMap.get(row.user) || 0 }));
        mode = dailyResp.result.mode; rawItemsCount = dailyResp.result.rawItemsCount;
        source = dailyResp.result.source; dateLabel = date;
      } else {
        const resp = await refreshForDateOverride({}, { force: forceRefresh });
        totalDaysQueried = 1;
        if (resp.cacheHit !== "github") cacheHits = 1;
        ranking = resp.result.ranking; mode = resp.result.mode;
        rawItemsCount = resp.result.rawItemsCount; source = resp.result.source;
        const nowLabel = new Date();
        const labelYear = requiredEnv("BILLING_YEAR") || String(nowLabel.getUTCFullYear());
        const labelMonth = requiredEnv("BILLING_MONTH") || String(nowLabel.getUTCMonth() + 1);
        dateLabel = `${labelYear}-${labelMonth}${requiredEnv("BILLING_DAY") ? "-" + requiredEnv("BILLING_DAY") : ""}`;
      }

      ranking = enrichRanking(ranking);
      const resolvedQueryMode = (queryMode === "range" && startDate && endDate) ? "range"
        : (queryMode === "single" && date) ? "single" : "default";
      Object.assign(state, {
        fetchedAt: new Date().toISOString(), source, rawItemsCount,
        mode, ranking, dateLabel, queryMode: resolvedQueryMode,
      });
      res.json({
        ok: true, fetchedAt: state.fetchedAt, source: state.source,
        rawItemsCount: state.rawItemsCount, mode: state.mode,
        dateLabel: state.dateLabel, queryMode: state.queryMode,
        ranking: state.ranking, includedQuota: INCLUDED_QUOTA,
        cacheHitRatio: totalDaysQueried > 0 ? Math.round((cacheHits / totalDaysQueried) * 100) : 0,
      });
    } catch (error) {
      writeError(res, error);
    }
  });

  /* Expose internal helpers for scheduler / other routes to reuse. */
  router.forceRefreshDay = forceRefreshDay;
  router.refreshForDateOverride = refreshForDateOverride;

  return router;
};
