/**
 * Teams routes – GET /api/teams, /api/enterprise-teams, /api/enterprise-teams/:teamId/members, POST /api/teams/refresh
 */
const express = require("express");
const { githubGetJson } = require("../lib/github-api");
const { writeError, buildEndpoint } = require("../lib/helpers");
const { fetchCopilotSeats } = require("./seats");

const teamMemberCountCache = new Map();
const TEAM_MEMBER_COUNT_TTL = 10 * 60 * 1000;

async function fetchEnterpriseTeamMemberCount(enterprise, teamId) {
  const pathname = `/enterprises/${encodeURIComponent(enterprise)}/teams/${teamId}/memberships`;
  let page = 1, count = 0;
  while (true) {
    const data = await githubGetJson(pathname, new URLSearchParams({ per_page: "100", page: String(page) }));
    const batch = Array.isArray(data) ? data : [];
    count += batch.length;
    if (batch.length < 100) break;
    page += 1;
  }
  return count;
}

async function getTeamMemberCountCached(enterprise, teamId) {
  const key = String(teamId);
  const hit = teamMemberCountCache.get(key);
  if (hit && Date.now() - hit.ts < TEAM_MEMBER_COUNT_TTL) return hit.count;
  try {
    const count = await fetchEnterpriseTeamMemberCount(enterprise, teamId);
    teamMemberCountCache.set(key, { ts: Date.now(), count });
    return count;
  } catch { return null; }
}

module.exports = function createTeamsRouter({ teamCache, userMappingService }) {
  const resolveAdName = (login) => {
    if (!userMappingService || !login) return "";
    try {
      const mapped = userMappingService.getUserByGithub(login);
      return mapped && mapped.adName ? mapped.adName : "";
    } catch { return ""; }
  };

  const router = express.Router();

  router.get("/api/teams", (_req, res) => {
    res.json({ ok: true, fetchedAt: teamCache.fetchedAt, teams: teamCache.userTeamMap });
  });

  router.get("/api/enterprise-teams", async (_req, res) => {
    try {
      const endpoint = buildEndpoint();
      if (endpoint.kind !== "enterprise") throw new Error("Enterprise mode required");
      const raw = await githubGetJson(
        `/enterprises/${encodeURIComponent(endpoint.enterprise)}/teams`,
        new URLSearchParams({ per_page: "100" })
      );
      const teams = Array.isArray(raw) ? raw : [];
      const counts = await Promise.all(teams.map((t) => getTeamMemberCountCached(endpoint.enterprise, t.id)));
      res.json({
        ok: true,
        teams: teams.map((t, idx) => ({
          id: t.id, name: t.name, slug: t.slug, description: t.description || "",
          membersCount: typeof t.members_count === "number" ? t.members_count : counts[idx] != null ? counts[idx] : null,
          createdAt: t.created_at || null, htmlUrl: t.html_url || "",
        })),
      });
    } catch (error) { writeError(res, error); }
  });

  router.get("/api/enterprise-teams/:teamId/members", async (req, res) => {
    try {
      const endpoint = buildEndpoint();
      if (endpoint.kind !== "enterprise") throw new Error("Enterprise mode required");
      const teamId = req.params.teamId;
      if (!/^\d+$/.test(teamId)) throw new Error("Invalid team ID");
      const allMembers = [];
      let page = 1;
      while (true) {
        const raw = await githubGetJson(
          `/enterprises/${encodeURIComponent(endpoint.enterprise)}/teams/${teamId}/memberships`,
          new URLSearchParams({ per_page: "100", page: String(page) })
        );
        const batch = Array.isArray(raw) ? raw : [];
        for (const m of batch) {
          const login = m.login || "";
          allMembers.push({ login, adName: resolveAdName(login), avatarUrl: m.avatar_url || "", htmlUrl: m.html_url || "" });
        }
        if (batch.length < 100) break;
        page += 1;
      }
      res.json({ ok: true, totalMembers: allMembers.length, members: allMembers });
    } catch (error) { writeError(res, error); }
  });

  router.post("/api/teams/refresh", async (_req, res) => {
    try {
      const endpoint = buildEndpoint();
      if (endpoint.kind !== "enterprise") throw new Error("Teams refresh only supported for enterprise mode.");
      const seats = await fetchCopilotSeats(endpoint.enterprise);
      const map = {};
      for (const s of seats) {
        if (!map[s.login]) map[s.login] = [];
        if (s.team !== "-" && !map[s.login].includes(s.team)) map[s.login].push(s.team);
      }
      teamCache.userTeamMap = map;
      teamCache.fetchedAt = new Date().toISOString();
      res.json({ ok: true, fetchedAt: teamCache.fetchedAt, totalUsers: seats.length, teams: teamCache.userTeamMap });
    } catch (error) { writeError(res, error); }
  });

  return router;
};
