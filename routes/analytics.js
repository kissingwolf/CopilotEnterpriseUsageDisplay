/**
 * Analytics routes – /api/analytics/trends, top-users, daily-summary
 */
const express = require("express");
const { toNumber, pickUser, writeError } = require("../lib/helpers");

module.exports = function createAnalyticsRouter({ usageStore, userMappingService, teamCache }) {
  const router = express.Router();

  router.get("/api/analytics/trends", async (req, res) => {
    try {
      const range = Number(req.query.range) || 30;
      if (![30, 90, 365].includes(range)) return res.status(400).json({ ok: false, message: "range must be 30, 90, or 365" });
      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setUTCDate(startDate.getUTCDate() - range + 1);
      const startStr = startDate.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      const days = usageStore.getDaysInRange(startStr, endStr);
      const trend = days.map(function (d) {
        let requests = 0, amount = 0;
        if (d.ranking) {
          const ranking = typeof d.ranking === "string" ? JSON.parse(d.ranking) : d.ranking;
          for (const row of ranking) {
            requests += row.requests;
            amount += row.amount;
          }
        } else {
          const payload = typeof d.data === "string" ? JSON.parse(d.data) : d.data;
          const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
          for (const item of usageItems) {
            requests += toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
            amount += toNumber(item.netAmount) || toNumber(item.grossAmount) || toNumber(item.amount);
          }
        }
        return { date: d.date, requests: Math.round(requests * 100) / 100, amount: Math.round(amount * 10000) / 10000 };
      });

      res.json({ ok: true, range, trend, cachedCount: trend.length });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/analytics/top-users", async (req, res) => {
    try {
      const range = Number(req.query.range) || 30;
      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setUTCDate(startDate.getUTCDate() - range + 1);
      const days = usageStore.getDaysInRange(startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10));
      const byUser = new Map();
      for (const d of days) {
        if (d.ranking) {
          const ranking = typeof d.ranking === "string" ? JSON.parse(d.ranking) : d.ranking;
          for (const row of ranking) {
            const cur = byUser.get(row.user) || { user: row.user, requests: 0, amount: 0 };
            cur.requests += row.requests; cur.amount += row.amount;
            byUser.set(row.user, cur);
          }
          continue;
        }
        const payload = typeof d.data === "string" ? JSON.parse(d.data) : d.data;
        const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
        for (const item of usageItems) {
          const user = pickUser(item);
          if (user === "(unknown)") continue;
          const requests = toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
          const amount = toNumber(item.netAmount) || toNumber(item.grossAmount) || toNumber(item.amount);
          const cur = byUser.get(user) || { user, requests: 0, amount: 0 };
          cur.requests += requests; cur.amount += amount;
          byUser.set(user, cur);
        }
      }

      const top = Array.from(byUser.values())
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 20)
        .map((row, idx) => {
          const mapped = userMappingService.getUserByGithub(row.user);
          return {
            rank: idx + 1,
            user: mapped ? mapped.adName : row.user,
            adName: mapped ? mapped.adName : null,
            requests: Math.round(row.requests * 100) / 100,
            amount: Math.round(row.amount * 10000) / 10000,
          };
        });

      res.json({ ok: true, range, topUsers: top });
    } catch (error) { writeError(res, error); }
  });

  /**
   * GET /api/analytics/team-view
   * Query params:
   *   range  – 30 | 90 | 365  (default 30)
   *   team   – team name (optional). If omitted/empty → return per-team avg requests.
   *            If provided → return Top-20 members of that team.
   */
  router.get("/api/analytics/team-view", async (req, res) => {
    try {
      const range = Number(req.query.range) || 30;
      const teamFilter = (req.query.team || "").trim();

      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setUTCDate(startDate.getUTCDate() - range + 1);
      const startStr = startDate.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      // ── 1. Aggregate requests per GitHub login from daily_usage cache ──
      const days = usageStore.getDaysInRange(startStr, endStr);
      const byLogin = new Map(); // login → totalRequests
      for (const d of days) {
        if (d.ranking) {
          const ranking = typeof d.ranking === "string" ? JSON.parse(d.ranking) : d.ranking;
          for (const row of ranking) {
            byLogin.set(row.user, (byLogin.get(row.user) || 0) + row.requests);
          }
        } else {
          const payload = typeof d.data === "string" ? JSON.parse(d.data) : d.data;
          const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
          for (const item of usageItems) {
            const user = pickUser(item);
            if (user === "(unknown)") continue;
            const requests = toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
            byLogin.set(user, (byLogin.get(user) || 0) + requests);
          }
        }
      }

      // ── 2. Build team → members map from seats snapshot ──
      const seats = (teamCache && teamCache.seatsRaw) || [];
      const teamMembers = new Map(); // teamName → [{ login, adName }]
      for (const seat of seats) {
        const teamName = seat.team || "未分配团队";
        const mapped = userMappingService.getUserByGithub(seat.login);
        const entry = { login: seat.login, adName: mapped ? mapped.adName : null };
        if (!teamMembers.has(teamName)) teamMembers.set(teamName, []);
        teamMembers.get(teamName).push(entry);
      }

      if (teamFilter === "") {
        // ── 全选模式: per-team avg requests ──
        const teamStats = [];
        for (const [teamName, members] of teamMembers) {
          let total = 0;
          for (const m of members) total += byLogin.get(m.login) || 0;
          const avg = members.length > 0 ? Math.round(total / members.length * 100) / 100 : 0;
          teamStats.push({ team: teamName, members: members.length, totalRequests: Math.round(total * 100) / 100, avgRequests: avg });
        }
        teamStats.sort((a, b) => b.avgRequests - a.avgRequests);
        return res.json({ ok: true, range, mode: "teams", teamStats });
      }

      // ── 明细模式: Top-20 members of selected team ──
      const members = teamMembers.get(teamFilter) || [];
      const memberRows = members.map((m) => ({
        login: m.login,
        user: m.adName || m.login,
        requests: Math.round((byLogin.get(m.login) || 0) * 100) / 100,
      }));
      memberRows.sort((a, b) => b.requests - a.requests);
      const top20 = memberRows.slice(0, 20).map((r, i) => ({ rank: i + 1, user: r.user, requests: r.requests }));
      res.json({ ok: true, range, mode: "members", team: teamFilter, teamMembers: top20 });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/analytics/daily-summary", async (req, res) => {
    try {
      const range = Number(req.query.range) || 30;
      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setUTCDate(startDate.getUTCDate() - range + 1);
      const days = usageStore.getDaysInRange(startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10));
      let totalRequests = 0, totalAmount = 0, daysWithData = 0;
      for (const d of days) {
        if (d.ranking) {
          const ranking = typeof d.ranking === "string" ? JSON.parse(d.ranking) : d.ranking;
          if (ranking.length === 0) continue;
          daysWithData += 1;
          for (const row of ranking) { totalRequests += row.requests; totalAmount += row.amount; }
          continue;
        }
        const payload = typeof d.data === "string" ? JSON.parse(d.data) : d.data;
        const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
        if (usageItems.length === 0) continue;
        daysWithData += 1;
        for (const item of usageItems) {
          totalRequests += toNumber(item.netQuantity) || toNumber(item.grossQuantity) || toNumber(item.quantity) || toNumber(item.requests);
          totalAmount += toNumber(item.netAmount) || toNumber(item.grossAmount) || toNumber(item.amount);
        }
      }

      res.json({
        ok: true, range,
        totalRequests: Math.round(totalRequests * 100) / 100,
        totalAmount: Math.round(totalAmount * 10000) / 10000,
        avgDailyRequests: daysWithData > 0 ? Math.round(totalRequests / daysWithData * 100) / 100 : 0,
        avgDailyAmount: daysWithData > 0 ? Math.round(totalAmount / daysWithData * 10000) / 10000 : 0,
        daysWithData, totalDaysInRange: days.length,
      });
    } catch (error) { writeError(res, error); }
  });

  return router;
};
