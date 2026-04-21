const express = require("express");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const state = {
  fetchedAt: null,
  ranking: [],
  source: null,
  rawItemsCount: 0,
  mode: "direct",
  queryMode: "default",
};

const teamCache = {
  userTeamMap: {},
  seatsRaw: [],
  fetchedAt: null,
};

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function pickUser(item) {
  const candidates = [
    item.user,
    item.username,
    item.userName,
    item.login,
    item.actor,
    item.actorLogin,
    item.actor_login,
    item.user_login,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      if (typeof value.login === "string" && value.login.trim()) {
        return value.login.trim();
      }
      if (typeof value.name === "string" && value.name.trim()) {
        return value.name.trim();
      }
    }
  }

  return "(unknown)";
}

function buildQueryParams(extra = {}) {
  const params = new URLSearchParams();

  const year = extra.year || requiredEnv("BILLING_YEAR");
  const month = extra.month || requiredEnv("BILLING_MONTH");
  const day = extra.day || requiredEnv("BILLING_DAY");
  const product = extra.product || requiredEnv("PRODUCT");
  const model = extra.model || requiredEnv("MODEL");
  const user = extra.user || "";

  if (year) params.set("year", String(year));
  if (month) params.set("month", String(month));
  if (day) params.set("day", String(day));
  if (product) params.set("product", product);
  if (model) params.set("model", model);
  if (user) params.set("user", user);

  return params;
}

function buildEndpoint() {
  const enterprise = requiredEnv("ENTERPRISE_SLUG");
  const org = requiredEnv("ORG_NAME");

  if (enterprise) {
    return {
      path: `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/premium_request/usage`,
      scope: `enterprise:${enterprise}`,
      kind: "enterprise",
      enterprise,
    };
  }

  if (org) {
    return {
      path: `/organizations/${encodeURIComponent(org)}/settings/billing/premium_request/usage`,
      scope: `org:${org}`,
      kind: "org",
      org,
    };
  }

  throw new Error("Please set ENTERPRISE_SLUG or ORG_NAME in .env");
}

async function githubGetJson(pathname, searchParams) {
  const token = requiredEnv("GITHUB_TOKEN");
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN in .env");
  }

  const apiBase = requiredEnv("GITHUB_API_BASE") || "https://api.github.com";
  const query = searchParams ? searchParams.toString() : "";
  const url = `${apiBase}${pathname}${query ? `?${query}` : ""}`;

  const resp = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });

  const text = await resp.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const msg = data && data.message ? data.message : "GitHub API request failed";
    throw new Error(`${resp.status} ${resp.statusText}: ${msg}`);
  }

  return data;
}

async function fetchUsageFromGitHub(dateOverride) {
  const endpoint = buildEndpoint();
  const extra = dateOverride || {};
  const data = await githubGetJson(endpoint.path, buildQueryParams(extra));
  return { data, endpoint };
}

function aggregateRanking(payload) {
  const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
  const byUser = new Map();

  for (const item of usageItems) {
    const user = pickUser(item);
    const requests =
      toNumber(item.netQuantity) ||
      toNumber(item.grossQuantity) ||
      toNumber(item.quantity) ||
      toNumber(item.requests);

    const amount =
      toNumber(item.netAmount) ||
      toNumber(item.grossAmount) ||
      toNumber(item.amount);

    const current = byUser.get(user) || { user, requests: 0, amount: 0 };
    current.requests += requests;
    current.amount += amount;
    byUser.set(user, current);
  }

  return Array.from(byUser.values())
    .sort((a, b) => b.requests - a.requests)
    .map((row, idx) => ({
      rank: idx + 1,
      user: row.user,
      requests: Math.round(row.requests * 100) / 100,
      amount: Math.round(row.amount * 10000) / 10000,
    }));
}

function hasKnownUsers(ranking) {
  return ranking.some((row) => row.user !== "(unknown)");
}

function aggregateSingleUserUsage(payload) {
  const usageItems = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
  let requests = 0;
  let amount = 0;

  for (const item of usageItems) {
    requests +=
      toNumber(item.netQuantity) ||
      toNumber(item.grossQuantity) ||
      toNumber(item.quantity) ||
      toNumber(item.requests);

    amount +=
      toNumber(item.netAmount) ||
      toNumber(item.grossAmount) ||
      toNumber(item.amount);
  }

  return {
    requests: Math.round(requests * 100) / 100,
    amount: Math.round(amount * 10000) / 10000,
  };
}

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
        const teamObj = seat.assigning_team;
        seats.push({
          login: login.trim(),
          team: teamObj?.name || "-",
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

async function ensureSeatsData() {
  if (teamCache.fetchedAt) return;
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") return;
    const seats = await fetchCopilotSeats(endpoint.enterprise);
    const map = {};
    for (const s of seats) {
      if (!map[s.login]) map[s.login] = [];
      if (s.team !== "-" && !map[s.login].includes(s.team)) {
        map[s.login].push(s.team);
      }
    }
    teamCache.userTeamMap = map;
    teamCache.seatsRaw = seats;
    teamCache.fetchedAt = new Date().toISOString();
    console.log(`Loaded ${seats.length} Copilot seats, ${Object.keys(map).length} users mapped to teams.`);
  } catch (e) {
    console.error("Failed to fetch Copilot seats:", e.message);
  }
}

const PLAN_CONFIG = {
  business:    { quota: 300,  baseCost: 19, overagePrice: 0.04 },
  enterprise:  { quota: 1000, baseCost: 39, overagePrice: 0.04 },
};

function getUserPlanType(login) {
  const seat = teamCache.seatsRaw.find((s) => s.login === login);
  return seat ? seat.planType : "business";
}

function calcAmount(cycleRequests, planType) {
  const cfg = PLAN_CONFIG[planType] || PLAN_CONFIG.business;
  if (cycleRequests <= cfg.quota) return cfg.baseCost;
  return Math.round((cfg.baseCost + (cycleRequests - cfg.quota) * cfg.overagePrice) * 10000) / 10000;
}

function enrichRanking(ranking) {
  return ranking.map((row) => {
    const planType = getUserPlanType(row.user);
    const cfg = PLAN_CONFIG[planType] || PLAN_CONFIG.business;
    const reqsForPct = row.cycleRequests != null ? row.cycleRequests : row.requests;
    const result = {
      user: row.user,
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
  let users = Object.keys(teamCache.userTeamMap);

  if (users.length === 0) {
    throw new Error(
      "No Copilot users discovered. Ensure the token has access to /enterprises/{slug}/copilot/billing/seats."
    );
  }

  const results = [];
  const chunkSize = 8;
  let failedQueries = 0;
  let firstErrorMessage = "";

  for (let i = 0; i < users.length; i += chunkSize) {
    const chunk = users.slice(i, i + chunkSize);

    const chunkResults = await Promise.all(
      chunk.map(async (user) => {
        try {
          const payload = await githubGetJson(endpoint.path, buildQueryParams({ ...dateOverride, user }));
          const summary = aggregateSingleUserUsage(payload);
          return {
            user,
            requests: summary.requests,
            amount: summary.amount,
          };
        } catch (error) {
          failedQueries += 1;
          if (!firstErrorMessage && error instanceof Error) {
            firstErrorMessage = error.message;
          }
          return {
            user,
            requests: 0,
            amount: 0,
          };
        }
      })
    );

    results.push(...chunkResults);
  }

  if (failedQueries === users.length) {
    throw new Error(
      `Per-user usage query failed for all users. ${firstErrorMessage}`
    );
  }

  return results
    .sort((a, b) => b.requests - a.requests)
    .map((row, idx) => ({
      rank: idx + 1,
      user: row.user,
      requests: row.requests,
      amount: row.amount,
    }));
}

app.get("/api/usage", (_req, res) => {
  res.json({
    ok: true,
    fetchedAt: state.fetchedAt,
    source: state.source,
    rawItemsCount: state.rawItemsCount,
    mode: state.mode,
    dateLabel: state.dateLabel || "",
    queryMode: state.queryMode || "default",
    ranking: state.ranking,
  });
});

function parseDateStr(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function enumerateDays(startStr, endStr) {
  const days = [];
  const cur = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return days;
  while (cur <= end) {
    days.push({
      year: cur.getUTCFullYear(),
      month: cur.getUTCMonth() + 1,
      day: cur.getUTCDate(),
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

async function refreshForDateOverride(dateOverride) {
  const { data, endpoint } = await fetchUsageFromGitHub(dateOverride);
  let ranking = aggregateRanking(data);
  let mode = "direct";

  if (!hasKnownUsers(ranking) && Array.isArray(data?.usageItems) && data.usageItems.length > 0) {
    ranking = await buildRankingByUserQueries(endpoint, dateOverride);
    mode = "per-user-fallback";
  }

  return {
    ranking,
    mode,
    rawItemsCount: Array.isArray(data?.usageItems) ? data.usageItems.length : 0,
    source: endpoint.scope,
  };
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
      rank: idx + 1,
      user: row.user,
      requests: Math.round(row.requests * 100) / 100,
      amount: Math.round(row.amount * 10000) / 10000,
    }));
}

app.post("/api/usage/refresh", async (req, res) => {
  try {
    await ensureSeatsData();

    const { queryMode, date, startDate, endDate } = req.body || {};
    let ranking, mode, rawItemsCount, source, dateLabel;

    if (queryMode === "range" && startDate && endDate) {
      const days = enumerateDays(startDate, endDate);
      if (days.length === 0) throw new Error("无效的日期范围");
      if (days.length > 31) throw new Error("日期范围不能超过 31 天");

      const allRankings = [];
      let totalRaw = 0;
      let lastMode = "direct";
      let lastSource = "";

      for (const d of days) {
        const result = await refreshForDateOverride(d);
        allRankings.push(result.ranking);
        totalRaw += result.rawItemsCount;
        lastMode = result.mode;
        lastSource = result.source;
      }

      ranking = mergeRankings(allRankings);
      mode = lastMode;
      rawItemsCount = totalRaw;
      source = lastSource;
      dateLabel = `${startDate} ~ ${endDate} (${days.length}天)`;
    } else if (queryMode === "single" && date) {
      const d = parseDateStr(date);
      if (!d) throw new Error("无效的日期格式，请使用 YYYY-MM-DD");

      const [dailyResult, cycleResult] = await Promise.all([
        refreshForDateOverride(d),
        refreshForDateOverride({ year: d.year, month: d.month }),
      ]);

      const cycleMap = new Map();
      for (const row of cycleResult.ranking) {
        cycleMap.set(row.user, row.requests);
      }

      ranking = dailyResult.ranking.map((row) => ({
        ...row,
        cycleRequests: cycleMap.get(row.user) || 0,
      }));

      mode = dailyResult.mode;
      rawItemsCount = dailyResult.rawItemsCount;
      source = dailyResult.source;
      dateLabel = date;
    } else {
      const result = await refreshForDateOverride({});
      ranking = result.ranking;
      mode = result.mode;
      rawItemsCount = result.rawItemsCount;
      source = result.source;
      dateLabel = `${requiredEnv("BILLING_YEAR")}-${requiredEnv("BILLING_MONTH")}${requiredEnv("BILLING_DAY") ? "-" + requiredEnv("BILLING_DAY") : ""}`;
    }

    ranking = enrichRanking(ranking);

    const resolvedQueryMode = (queryMode === "range" && startDate && endDate) ? "range"
      : (queryMode === "single" && date) ? "single" : "default";

    state.fetchedAt = new Date().toISOString();
    state.source = source;
    state.rawItemsCount = rawItemsCount;
    state.mode = mode;
    state.ranking = ranking;
    state.dateLabel = dateLabel;
    state.queryMode = resolvedQueryMode;

    res.json({
      ok: true,
      fetchedAt: state.fetchedAt,
      source: state.source,
      rawItemsCount: state.rawItemsCount,
      mode: state.mode,
      dateLabel: state.dateLabel,
      queryMode: state.queryMode,
      ranking: state.ranking,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/seats", async (_req, res) => {
  try {
    await ensureSeatsData();
    res.json({
      ok: true,
      fetchedAt: teamCache.fetchedAt,
      totalSeats: teamCache.seatsRaw.length,
      seats: teamCache.seatsRaw,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/billing/summary", async (_req, res) => {
  try {
    await ensureSeatsData();
    const endpoint = buildEndpoint();

    /* 1) billing/usage — seats + premium raw */
    const billingData = await githubGetJson(
      `/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/usage`
    );
    const rawItems = Array.isArray(billingData?.usageItems) ? billingData.usageItems : [];

    /* 2) Seat breakdown from cache */
    const seats = teamCache.seatsRaw;
    const planCounts = {};
    for (const s of seats) {
      const pt = s.planType || "business";
      planCounts[pt] = (planCounts[pt] || 0) + 1;
    }

    /* 3) Compute per-plan summary */
    const planSummary = [];
    let totalSeatsCost = 0;
    let totalIncludedQuota = 0;
    for (const [plan, count] of Object.entries(planCounts)) {
      const cfg = PLAN_CONFIG[plan] || PLAN_CONFIG.business;
      const cost = count * cfg.baseCost;
      const quota = count * cfg.quota;
      totalSeatsCost += cost;
      totalIncludedQuota += quota;
      planSummary.push({ plan, seats: count, baseCost: cfg.baseCost, totalCost: cost, quotaPerSeat: cfg.quota, totalQuota: quota });
    }

    /* 4) Premium request totals from raw billing */
    const premiumItem = rawItems.find((i) => /premium/i.test(i.sku || ""));
    const totalPremiumRequests = premiumItem ? toNumber(premiumItem.quantity) : 0;
    const premiumUnitPrice = premiumItem ? toNumber(premiumItem.pricePerUnit) : 0.04;
    const grossPremiumCost = premiumItem ? toNumber(premiumItem.grossAmount) : 0;
    const discountPremiumCost = premiumItem ? toNumber(premiumItem.discountAmount) : 0;

    /* 5) Overage calculation */
    const overageRequests = Math.max(0, totalPremiumRequests - totalIncludedQuota);
    const overageCost = Math.round(overageRequests * premiumUnitPrice * 10000) / 10000;

    /* 6) Total estimated cost */
    const totalEstimatedCost = Math.round((totalSeatsCost + overageCost) * 10000) / 10000;

    res.json({
      ok: true,
      rawItems,
      planSummary,
      totalSeats: seats.length,
      totalSeatsCost,
      totalIncludedQuota,
      totalPremiumRequests: Math.round(totalPremiumRequests * 100) / 100,
      premiumUnitPrice,
      grossPremiumCost: Math.round(grossPremiumCost * 10000) / 10000,
      discountPremiumCost: Math.round(discountPremiumCost * 10000) / 10000,
      overageRequests: Math.round(overageRequests * 100) / 100,
      overageCost,
      totalEstimatedCost,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/billing/models", async (req, res) => {
  try {
    const endpoint = buildEndpoint();
    const year = req.query.year || requiredEnv("BILLING_YEAR");
    const month = req.query.month || requiredEnv("BILLING_MONTH");
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
      ok: true,
      year: Number(year),
      month: Number(month),
      models: sorted,
      totalQuantity: Math.round(totalQty * 100) / 100,
      totalAmount: Math.round(totalAmount * 10000) / 10000,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/api/teams", (_req, res) => {
  res.json({
    ok: true,
    fetchedAt: teamCache.fetchedAt,
    teams: teamCache.userTeamMap,
  });
});

/* Enterprise Teams with descriptions */
app.get("/api/enterprise-teams", async (_req, res) => {
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") throw new Error("Enterprise mode required");
    const raw = await githubGetJson(
      `/enterprises/${encodeURIComponent(endpoint.enterprise)}/teams`,
      new URLSearchParams({ per_page: "100" })
    );
    const teams = Array.isArray(raw) ? raw : [];
    res.json({
      ok: true,
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        description: t.description || "",
        createdAt: t.created_at || null,
        htmlUrl: t.html_url || "",
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "Unknown error" });
  }
});

/* Enterprise Team members */
app.get("/api/enterprise-teams/:teamId/members", async (req, res) => {
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") throw new Error("Enterprise mode required");
    const teamId = req.params.teamId;
    if (!/^\d+$/.test(teamId)) throw new Error("Invalid team ID");
    const raw = await githubGetJson(
      `/enterprises/${encodeURIComponent(endpoint.enterprise)}/teams/${teamId}/memberships`,
      new URLSearchParams({ per_page: "100" })
    );
    const members = Array.isArray(raw) ? raw : [];
    res.json({
      ok: true,
      members: members.map((m) => ({
        login: m.login,
        avatarUrl: m.avatar_url || "",
        htmlUrl: m.html_url || "",
      })),
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/api/teams/refresh", async (_req, res) => {
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") {
      throw new Error("Teams refresh only supported for enterprise mode.");
    }
    const seats = await fetchCopilotSeats(endpoint.enterprise);
    const map = {};
    for (const s of seats) {
      if (!map[s.login]) map[s.login] = [];
      if (s.team !== "-" && !map[s.login].includes(s.team)) {
        map[s.login].push(s.team);
      }
    }
    teamCache.userTeamMap = map;
    teamCache.fetchedAt = new Date().toISOString();
    res.json({ ok: true, fetchedAt: teamCache.fetchedAt, totalUsers: seats.length, teams: teamCache.userTeamMap });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
