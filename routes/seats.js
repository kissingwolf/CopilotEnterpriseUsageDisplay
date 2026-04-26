/**
 * Seats data loader – shared between usage and billing routes.
 */
const logger = require("../lib/logger");
const { githubGetJson } = require("../lib/github-api");
const { buildEndpoint } = require("../lib/helpers");
const { SEATS_TTL_MS } = require("../lib/usage-store");

async function fetchCopilotSeats(enterprise) {
  const seats = [];
  let page = 1;
  while (true) {
    const data = await githubGetJson(
      `/enterprises/${encodeURIComponent(enterprise)}/copilot/billing/seats`,
      new URLSearchParams({ per_page: "100", page: String(page) })
    );
    const batch = Array.isArray(data?.seats) ? data.seats : [];
    for (const seat of batch) {
      const login = seat?.assignee?.login;
      if (typeof login === "string" && login.trim()) {
        seats.push({
          login: login.trim(),
          team: seat.assigning_team?.name || "-",
          planType: seat.plan_type || "-",
          lastActivityAt: seat.last_activity_at || null,
          lastActivityEditor: seat.last_activity_editor || "-",
          createdAt: seat.created_at || null,
        });
      }
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return seats;
}

async function ensureSeatsData(teamCache, usageStore, forceRefresh = false) {
  if (!forceRefresh && teamCache.fetchedAt) return;

  /* Try SQLite */
  if (!forceRefresh) {
    const snapshot = usageStore.getLatestSeatsSnapshot();
    if (snapshot && Date.now() - new Date(snapshot.fetched_at).getTime() < SEATS_TTL_MS) {
      const seats = snapshot.data;
      const map = {};
      for (const s of seats) {
        if (!map[s.login]) map[s.login] = [];
        if (s.team !== "-" && !map[s.login].includes(s.team)) map[s.login].push(s.team);
      }
      teamCache.userTeamMap = map;
      teamCache.seatsRaw = seats;
      teamCache.fetchedAt = snapshot.fetched_at;
      logger.info({ count: seats.length }, "Restored Copilot seats from SQLite");
      return;
    }
  }

  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") return;
    const seats = await fetchCopilotSeats(endpoint.enterprise);
    const map = {};
    for (const s of seats) {
      if (!map[s.login]) map[s.login] = [];
      if (s.team !== "-" && !map[s.login].includes(s.team)) map[s.login].push(s.team);
    }
    teamCache.userTeamMap = map;
    teamCache.seatsRaw = seats;
    teamCache.fetchedAt = new Date().toISOString();
    usageStore.saveSeatsSnapshot(seats, teamCache.fetchedAt);
    logger.info({ seats: seats.length, users: Object.keys(map).length }, "Loaded Copilot seats");
  } catch (e) {
    logger.error({ err: e.message }, "Failed to fetch Copilot seats");
  }
}

module.exports = { fetchCopilotSeats, ensureSeatsData };
