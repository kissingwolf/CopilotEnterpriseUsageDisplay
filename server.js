const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs");
const UserMappingService = require("./lib/user-mapping");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── User mapping service (singleton, auto-watches data/user_mapping.json) ──
const userMappingService = new UserMappingService();

// ── Multer config for file uploads ──
const uploadStorage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (_req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (_req, file, cb) {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ];
    if (allowed.includes(file.mimetype) || /\.xlsx?$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("仅支持 .xlsx / .xls 文件"));
    }
  },
});

const userDataDir = path.join(__dirname, "data");

function convertXlsxToJson(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excel 文件中没有工作表");

  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
  if (!rows.length) throw new Error("文件中没有数据行");

  const normalized = rows.map((row) => ({
    "AD-name": (row["AD-name"] || "").toString().trim(),
    "AD-mail": (row["AD-mail"] || "").toString().trim(),
    "Github-name": (row["Github-name"] || "").toString().trim(),
    "Github-mail": (row["Github-mail"] || "").toString().trim(),
  }));

  return normalized;
}

const state = {
  fetchedAt: null,
  ranking: [],
  source: null,
  rawItemsCount: 0,
  mode: "direct",
  queryMode: "default",
};

class ApiError extends Error {
  constructor(message, statusCode = 500, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.rateLimit = extra.rateLimit || null;
  }
}

const CACHE_TTL = (Number(requiredEnv("CACHE_TTL")) || 300) * 1000; // ms
const refreshCache = new Map(); // key -> { ts, result }

const teamCache = {
  userTeamMap: {},
  seatsRaw: [],
  fetchedAt: null,
};

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function writeError(res, error) {
  const statusCode = error instanceof ApiError ? error.statusCode : 500;
  const body = {
    ok: false,
    message: error instanceof Error ? error.message : "Unknown error",
  };
  if (error instanceof ApiError && error.rateLimit) {
    body.rateLimit = error.rateLimit;
  }
  res.status(statusCode).json(body);
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

  const now = new Date();
  const year = extra.year || requiredEnv("BILLING_YEAR") || String(now.getFullYear());
  const month = extra.month || requiredEnv("BILLING_MONTH") || String(now.getMonth() + 1);
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

/* ── GitHub API infrastructure: concurrency queue + retry/backoff + GET cache + single-flight ── */

const MAX_CONCURRENT_GITHUB = Math.max(1, Number(process.env.GITHUB_MAX_CONCURRENT || 3));
const MAX_GITHUB_RETRIES = Math.max(0, Number(process.env.GITHUB_MAX_RETRIES || 3));
const MAX_RETRY_WAIT_MS = 60 * 1000;

let githubRunning = 0;
const githubQueue = [];

function acquireGithubSlot() {
  if (githubRunning < MAX_CONCURRENT_GITHUB) {
    githubRunning += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    githubQueue.push(resolve);
  }).then(() => {
    githubRunning += 1;
  });
}

function releaseGithubSlot() {
  githubRunning = Math.max(0, githubRunning - 1);
  const next = githubQueue.shift();
  if (next) next();
}

let lastRateLimit = { limit: 0, remaining: 0, resetAt: null, updatedAt: null };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const githubGetCache = new Map(); // key -> { ts, data }
const githubInflight = new Map(); // key -> Promise

function buildCacheKey(method, pathname, searchParams) {
  const qs = searchParams
    ? Array.from(new URLSearchParams(searchParams.toString()))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";
  return `${method} ${pathname}?${qs}`;
}

function ttlForPath(pathname) {
  if (/copilot\/billing\/seats/.test(pathname)) return 10 * 60 * 1000;
  if (/\/memberships(\b|\?|$)/.test(pathname)) return 10 * 60 * 1000;
  if (/\/teams(\/|\?|$)/.test(pathname)) return 10 * 60 * 1000;
  if (/\/budgets(\b|\?|$)/.test(pathname)) return 15 * 60 * 1000;
  if (/premium_request\/usage/.test(pathname)) return 3 * 60 * 1000;
  if (/\/billing\/usage\/summary/.test(pathname)) return 3 * 60 * 1000;
  if (/\/billing\/usage(\b|\?|$)/.test(pathname)) return 3 * 60 * 1000;
  if (/cost-centers/.test(pathname)) return 3 * 60 * 1000;
  return 0;
}

function invalidateCacheByPrefix(prefix) {
  for (const key of Array.from(githubGetCache.keys())) {
    if (key.includes(prefix)) githubGetCache.delete(key);
  }
}

function parseLastPageFromLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? Number(match[1]) : null;
}

async function githubFetchRaw(method, pathname, searchParams, body) {
  await acquireGithubSlot();
  try {
    const token = requiredEnv("GITHUB_TOKEN");
    if (!token) throw new ApiError("Missing GITHUB_TOKEN in .env", 500);

    const apiBase = requiredEnv("GITHUB_API_BASE") || "https://api.github.com";
    const query = searchParams ? searchParams.toString() : "";
    const url = `${apiBase}${pathname}${query ? `?${query}` : ""}`;

    const resp = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    const limit = Number(resp.headers.get("x-ratelimit-limit") || 0);
    const remaining = Number(resp.headers.get("x-ratelimit-remaining") || 0);
    const resetEpoch = Number(resp.headers.get("x-ratelimit-reset") || 0);
    const resetAt = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : null;

    if (limit || remaining || resetAt) {
      lastRateLimit = { limit, remaining, resetAt, updatedAt: new Date().toISOString() };
    }

    return {
      status: resp.status,
      ok: resp.ok,
      statusText: resp.statusText,
      data,
      headers: resp.headers,
      rateLimit: { limit, remaining, resetAt },
    };
  } finally {
    releaseGithubSlot();
  }
}

async function githubRequest(method, pathname, searchParams, body, opts = {}) {
  const withHeaders = Boolean(opts.withHeaders);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_GITHUB_RETRIES + 1; attempt += 1) {
    const result = await githubFetchRaw(method, pathname, searchParams, body);

    if (result.ok) {
      return withHeaders
        ? { data: result.data, headers: result.headers, rateLimit: result.rateLimit }
        : result.data;
    }

    const msg = result.data && result.data.message ? result.data.message : "GitHub API request failed";
    const isPrimaryLimited = result.status === 429;
    const isSecondaryLimited =
      result.status === 403 && /secondary rate limit|rate limit/i.test(String(msg));
    const isQuotaZero = result.rateLimit.remaining === 0 && result.status === 403;
    const isRateLimited = isPrimaryLimited || isSecondaryLimited || isQuotaZero;
    const is5xx = result.status >= 500 && result.status < 600;

    if ((isRateLimited || is5xx) && attempt <= MAX_GITHUB_RETRIES) {
      const retryAfterSec = Number(result.headers.get("retry-after") || 0);
      let waitMs;
      if (retryAfterSec > 0) {
        waitMs = retryAfterSec * 1000;
      } else if (isRateLimited && result.rateLimit.resetAt) {
        waitMs = Math.max(0, new Date(result.rateLimit.resetAt).getTime() - Date.now());
      } else {
        waitMs = Math.min(2 ** attempt * 500, 8000);
      }
      waitMs = Math.min(waitMs, MAX_RETRY_WAIT_MS);
      console.warn(
        `[github] ${method} ${pathname} -> ${result.status}; retry #${attempt} in ${waitMs}ms (remaining=${result.rateLimit.remaining})`
      );
      await sleep(waitMs);
      lastError = new ApiError(msg, result.status, {
        rateLimit: { ...result.rateLimit, limitExceeded: isRateLimited },
      });
      continue;
    }

    if (isRateLimited) {
      throw new ApiError("GitHub API 速率限制已触发，请稍后再试。", 429, {
        rateLimit: { ...result.rateLimit, limitExceeded: true },
      });
    }
    throw new ApiError(`${result.status} ${result.statusText}: ${msg}`, result.status);
  }

  throw lastError || new ApiError("GitHub API request failed after retries", 500);
}

async function githubGetJson(pathname, searchParams) {
  const ttl = ttlForPath(pathname);
  const key = buildCacheKey("GET", pathname, searchParams);

  if (ttl > 0) {
    const hit = githubGetCache.get(key);
    if (hit && Date.now() - hit.ts < ttl) return hit.data;
  }

  if (githubInflight.has(key)) return githubInflight.get(key);

  const promise = githubRequest("GET", pathname, searchParams)
    .then((data) => {
      if (ttl > 0) githubGetCache.set(key, { ts: Date.now(), data });
      return data;
    })
    .finally(() => {
      githubInflight.delete(key);
    });

  githubInflight.set(key, promise);
  return promise;
}

async function githubGetWithHeaders(pathname, searchParams) {
  return githubRequest("GET", pathname, searchParams, undefined, { withHeaders: true });
}

async function githubPostJson(pathname, body) {
  const data = await githubRequest("POST", pathname, undefined, body);
  invalidateCacheByPrefix("settings/billing/cost-centers");
  return data;
}

async function githubDeleteJson(pathname, body) {
  const data = await githubRequest("DELETE", pathname, undefined, body);
  invalidateCacheByPrefix("settings/billing/cost-centers");
  return data;
}

async function githubRequestJson(method, pathname, searchParams, body) {
  return githubRequest(method, pathname, searchParams, body);
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

async function ensureSeatsData(forceRefresh = false) {
  if (!forceRefresh && teamCache.fetchedAt) return;
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

const INCLUDED_QUOTA = Number(requiredEnv("INCLUDED_QUOTA")) || 300;

const PLAN_CONFIG = {
  business:    { quota: INCLUDED_QUOTA, baseCost: 19, overagePrice: 0.04 },
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
    includedQuota: INCLUDED_QUOTA,
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
  const cacheKey = JSON.stringify(dateOverride || {});
  const cached = refreshCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  const { data, endpoint } = await fetchUsageFromGitHub(dateOverride);
  let ranking = aggregateRanking(data);
  let mode = "direct";

  if (!hasKnownUsers(ranking) && Array.isArray(data?.usageItems) && data.usageItems.length > 0) {
    ranking = await buildRankingByUserQueries(endpoint, dateOverride);
    mode = "per-user-fallback";
  }

  const result = {
    ranking,
    mode,
    rawItemsCount: Array.isArray(data?.usageItems) ? data.usageItems.length : 0,
    source: endpoint.scope,
  };

  refreshCache.set(cacheKey, { ts: Date.now(), result });
  return result;
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
      const nowLabel = new Date();
      const labelYear = requiredEnv("BILLING_YEAR") || String(nowLabel.getFullYear());
      const labelMonth = requiredEnv("BILLING_MONTH") || String(nowLabel.getMonth() + 1);
      dateLabel = `${labelYear}-${labelMonth}${requiredEnv("BILLING_DAY") ? "-" + requiredEnv("BILLING_DAY") : ""}`;
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
      includedQuota: INCLUDED_QUOTA,
    });
  } catch (error) {
    writeError(res, error);
  }
});

app.get("/api/seats", async (req, res) => {
  try {
    const shouldRefresh = String(req.query.refresh || "").toLowerCase();
    const forceRefresh = shouldRefresh === "1" || shouldRefresh === "true";
    await ensureSeatsData(forceRefresh);
    res.json({
      ok: true,
      fetchedAt: teamCache.fetchedAt,
      totalSeats: teamCache.seatsRaw.length,
      seats: teamCache.seatsRaw,
    });
  } catch (error) {
    writeError(res, error);
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
    writeError(res, error);
  }
});

app.get("/api/billing/models", async (req, res) => {
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
      ok: true,
      year: Number(year),
      month: Number(month),
      models: sorted,
      totalQuantity: Math.round(totalQty * 100) / 100,
      totalAmount: Math.round(totalAmount * 10000) / 10000,
    });
  } catch (error) {
    writeError(res, error);
  }
});

app.get("/api/teams", (_req, res) => {
  res.json({
    ok: true,
    fetchedAt: teamCache.fetchedAt,
    teams: teamCache.userTeamMap,
  });
});

/* Fetch a team's total member count via the Link header trick (per_page=1). */
async function fetchEnterpriseTeamMemberCount(enterprise, teamId) {
  const pathname = `/enterprises/${encodeURIComponent(enterprise)}/teams/${teamId}/memberships`;
  const params = new URLSearchParams({ per_page: "1", page: "1" });
  const { data, headers } = await githubGetWithHeaders(pathname, params);
  const lastPage = parseLastPageFromLink(headers.get("link"));
  if (lastPage && Number.isFinite(lastPage)) return lastPage;
  return Array.isArray(data) ? data.length : 0;
}

const teamMemberCountCache = new Map(); // teamId -> { ts, count }
const TEAM_MEMBER_COUNT_TTL = 10 * 60 * 1000;

async function getTeamMemberCountCached(enterprise, teamId) {
  const key = String(teamId);
  const hit = teamMemberCountCache.get(key);
  if (hit && Date.now() - hit.ts < TEAM_MEMBER_COUNT_TTL) return hit.count;
  try {
    const count = await fetchEnterpriseTeamMemberCount(enterprise, teamId);
    teamMemberCountCache.set(key, { ts: Date.now(), count });
    return count;
  } catch {
    return null;
  }
}

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

    const counts = await Promise.all(
      teams.map((t) => getTeamMemberCountCached(endpoint.enterprise, t.id))
    );

    res.json({
      ok: true,
      teams: teams.map((t, idx) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        description: t.description || "",
        membersCount:
          typeof t.members_count === "number"
            ? t.members_count
            : counts[idx] != null ? counts[idx] : null,
        createdAt: t.created_at || null,
        htmlUrl: t.html_url || "",
      })),
    });
  } catch (error) {
    writeError(res, error);
  }
});

/* Enterprise Team members — paginated to fetch ALL */
app.get("/api/enterprise-teams/:teamId/members", async (req, res) => {
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
        allMembers.push({
          login: m.login || "",
          avatarUrl: m.avatar_url || "",
          htmlUrl: m.html_url || "",
        });
      }
      if (batch.length < 100) break;
      page += 1;
    }

    res.json({
      ok: true,
      totalMembers: allMembers.length,
      members: allMembers,
    });
  } catch (error) {
    writeError(res, error);
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
    writeError(res, error);
  }
});

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
      if (Array.isArray(budget?.budget_product_skus)) {
        skuList.push(...budget.budget_product_skus);
      }
      if (typeof budget?.budget_product_sku === "string") {
        skuList.push(budget.budget_product_sku);
      }
      for (const sku of skuList) {
        const normalizedSku = String(sku || "").trim().toLowerCase();
        if (normalizedSku) prev.skus.add(normalizedSku);
      }

      byName.set(key, prev);
    }

    const hasNextPage = Boolean(data?.has_next_page);
    if (!hasNextPage) break;
    page += 1;
  }

  return byName;
}

function getBillingYearMonthForCostCenter() {
  const now = new Date();
  return {
    year: requiredEnv("BILLING_YEAR") || String(now.getFullYear()),
    month: requiredEnv("BILLING_MONTH") || String(now.getMonth() + 1),
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

async function fetchCostCenterSpentMap(enterprise, costCenters, budgetByName) {
  const byName = new Map();
  if (!Array.isArray(costCenters) || costCenters.length === 0) return byName;

  const { year, month } = getBillingYearMonthForCostCenter();
  const chunkSize = 6;

  for (let i = 0; i < costCenters.length; i += chunkSize) {
    const chunk = costCenters.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(
      chunk.map(async (cc) => {
        const ccId = cc?.id;
        const ccName = String(cc?.name || "").trim();
        if (!ccId || !ccName) return;

        const budgetInfo = budgetByName instanceof Map
          ? budgetByName.get(ccName.toLowerCase())
          : null;
        const allowedSkus = budgetInfo?.skus instanceof Set ? budgetInfo.skus : new Set();

        try {
          const params = new URLSearchParams();
          params.set("year", String(year));
          params.set("month", String(month));
          params.set("cost_center_id", String(ccId));

          const usage = await githubGetJson(
            `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/usage/summary`,
            params
          );

          byName.set(ccName.toLowerCase(), summarizeUsageItemsAmount(usage, allowedSkus));
        } catch {
          byName.set(ccName.toLowerCase(), null);
        }
      })
    );
    void chunkResults;
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
      if (typeof m?.login === "string" && m.login.trim()) {
        members.push(m.login.trim());
      }
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return members;
}

app.get("/api/cost-centers", async (req, res) => {
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") {
      throw new Error("Cost center API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
    }

    const stateFilter = String(req.query.state || "").toLowerCase();
    const params = new URLSearchParams();
    if (stateFilter === "active" || stateFilter === "deleted") {
      params.set("state", stateFilter);
    }

    const data = await githubGetJson(
      `/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers`,
      params
    );

    const costCenters = Array.isArray(data?.costCenters) ? data.costCenters : [];
    const budgetByName = await fetchCostCenterBudgetMap(endpoint.enterprise);
    const spentByName = await fetchCostCenterSpentMap(endpoint.enterprise, costCenters, budgetByName);
    const seatBaseCost = PLAN_CONFIG.business.baseCost;

    const normalized = costCenters.map((cc) => {
      const resources = Array.isArray(cc.resources) ? cc.resources : [];
      const nameKey = String(cc.name || "").trim().toLowerCase();
      const budgetInfo = budgetByName.get(nameKey) || null;
      return {
        id: cc.id || "",
        name: cc.name || "-",
        seatBaseCost,
        budgetAmount: budgetInfo ? budgetInfo.amount : null,
        spentAmount: spentByName.get(nameKey) ?? null,
        state: cc.state || "-",
        azureSubscription: cc.azure_subscription || "",
        resources,
      };
    });

    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      enterprise: endpoint.enterprise,
      seatBaseCost,
      total: normalized.length,
      costCenters: normalized,
    });
  } catch (error) {
    writeError(res, error);
  }
});

app.get("/api/cost-centers/by-name/:name", async (req, res) => {
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") {
      throw new Error("Cost center API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
    }

    const rawName = req.params.name || "";
    const targetName = decodeURIComponent(rawName).trim();
    if (!targetName) {
      throw new Error("缺少 cost center 名称。");
    }

    const data = await githubGetJson(
      `/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers`
    );

    const costCenters = Array.isArray(data?.costCenters) ? data.costCenters : [];
    const found = costCenters.find((cc) => {
      const name = typeof cc?.name === "string" ? cc.name.trim() : "";
      return name.toLowerCase() === targetName.toLowerCase();
    });

    if (!found) {
      res.status(404).json({
        ok: false,
        message: `未找到名为 \"${targetName}\" 的 cost center。`,
      });
      return;
    }

    const budgetByName = await fetchCostCenterBudgetMap(endpoint.enterprise);
    const spentByName = await fetchCostCenterSpentMap(endpoint.enterprise, [found], budgetByName);

    const nameKey = String(found.name || "").trim().toLowerCase();
    const budgetInfo = budgetByName.get(nameKey) || null;
    const seatBaseCost = PLAN_CONFIG.business.baseCost;
    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      enterprise: endpoint.enterprise,
      seatBaseCost,
      costCenter: {
        id: found.id || "",
        name: found.name || "-",
        seatBaseCost,
        budgetAmount: budgetInfo ? budgetInfo.amount : null,
        spentAmount: spentByName.get(nameKey) ?? null,
        state: found.state || "-",
        azureSubscription: found.azure_subscription || "",
        resources: Array.isArray(found.resources) ? found.resources : [],
      },
    });
  } catch (error) {
    writeError(res, error);
  }
});

app.post("/api/cost-centers/:id/add-users-from-teams", async (req, res) => {
  try {
    const endpoint = buildEndpoint();
    if (endpoint.kind !== "enterprise") {
      throw new Error("Cost center API 仅支持 enterprise 模式。请设置 ENTERPRISE_SLUG。");
    }

    const costCenterId = String(req.params.id || "").trim();
    if (!costCenterId) throw new Error("缺少 cost center ID。");

    const teamIds = Array.isArray(req.body?.teamIds)
      ? req.body.teamIds.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v))
      : [];
    const dryRun = Boolean(req.body?.dryRun);
    const removeMissingUsers = Boolean(req.body?.removeMissingUsers);

    if (teamIds.length === 0) {
      throw new Error("请至少选择一个 Team。");
    }

    const [ccList, teamsRaw] = await Promise.all([
      githubGetJson(`/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers`),
      githubGetJson(
        `/enterprises/${encodeURIComponent(endpoint.enterprise)}/teams`,
        new URLSearchParams({ per_page: "100" })
      ),
    ]);

    const allCostCenters = Array.isArray(ccList?.costCenters) ? ccList.costCenters : [];
    const target = allCostCenters.find((cc) => String(cc?.id || "") === costCenterId);
    if (!target) {
      res.status(404).json({ ok: false, message: "未找到指定的 cost center。" });
      return;
    }

    const teams = Array.isArray(teamsRaw) ? teamsRaw : [];
    const teamById = new Map(teams.map((t) => [String(t.id), t]));

    const unresolvedTeams = teamIds.filter((id) => !teamById.has(id));
    const resolvedTeamIds = teamIds.filter((id) => teamById.has(id));

    const memberResults = await Promise.all(
      resolvedTeamIds.map(async (id) => {
        const members = await fetchEnterpriseTeamMembers(endpoint.enterprise, id);
        return { id, members };
      })
    );

    const requestedUsersSet = new Set();
    for (const tr of memberResults) {
      for (const login of tr.members) {
        requestedUsersSet.add(login.toLowerCase());
      }
    }

    const existingUsersSet = new Set(
      (Array.isArray(target.resources) ? target.resources : [])
        .filter((r) => String(r?.type || "").toLowerCase() === "user")
        .map((r) => String(r.name || "").trim().toLowerCase())
        .filter(Boolean)
    );

    const existingUsers = [];
    const newUsers = [];
    for (const u of requestedUsersSet) {
      if (existingUsersSet.has(u)) existingUsers.push(u);
      else newUsers.push(u);
    }

    const usersToRemove = [];
    for (const u of existingUsersSet) {
      if (!requestedUsersSet.has(u)) usersToRemove.push(u);
    }

    // GitHub 限制每次请求最多 50 个 resources，需按批次提交
    const RESOURCE_BATCH_SIZE = 50;
    const resourcePath = `/enterprises/${encodeURIComponent(endpoint.enterprise)}/settings/billing/cost-centers/${encodeURIComponent(costCenterId)}/resource`;

    let addedBatches = 0;
    let removedBatches = 0;

    if (!dryRun && newUsers.length > 0) {
      for (let i = 0; i < newUsers.length; i += RESOURCE_BATCH_SIZE) {
        const chunk = newUsers.slice(i, i + RESOURCE_BATCH_SIZE);
        await githubPostJson(resourcePath, { users: chunk });
        addedBatches += 1;
      }
    }

    if (!dryRun && removeMissingUsers && usersToRemove.length > 0) {
      for (let i = 0; i < usersToRemove.length; i += RESOURCE_BATCH_SIZE) {
        const chunk = usersToRemove.slice(i, i + RESOURCE_BATCH_SIZE);
        await githubDeleteJson(resourcePath, { users: chunk });
        removedBatches += 1;
      }
    }

    res.json({
      ok: true,
      dryRun,
      removeMissingUsers,
      costCenter: {
        id: target.id || "",
        name: target.name || "-",
      },
      selectedTeams: resolvedTeamIds.map((id) => ({ id, name: teamById.get(id)?.name || id })),
      unresolvedTeams,
      requestedUsersCount: requestedUsersSet.size,
      existingUsersCount: existingUsers.length,
      newUsersCount: newUsers.length,
      usersToRemoveCount: usersToRemove.length,
      existingUsers,
      newUsers,
      usersToRemove,
      addedBatches,
      removedBatches,
      batchSize: RESOURCE_BATCH_SIZE,
    });
  } catch (error) {
    writeError(res, error);
  }
});

app.get("/costcenter", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "costcenter.html"));
});

app.get("/costcenter/:name", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "costcenter.html"));
});

// ── User mapping page ──
app.get("/user", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "user.html"));
});

// ── Upload mapping file ──
app.post("/user/upload-members", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ ok: false, message: "没有收到上传文件" });
      return;
    }

    const jsonData = convertXlsxToJson(req.file.path);
    // Clean up uploaded file
    try { fs.unlinkSync(req.file.path); } catch {}

    // Save to data/user_mapping.json
    const outPath = path.join(userDataDir, "user_mapping.json");
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(jsonData, null, 2), "utf8");

    // watcher triggers reload automatically
    const validRows = jsonData.filter((r) => r["AD-name"] && r["Github-name"]).length;
    const skipped = jsonData.length - validRows;
    res.json({
      ok: true,
      message: `成功 ${validRows} 条，跳过 ${skipped} 条`,
      totalRows: jsonData.length,
      validRows,
      skipped,
      fileName: req.file.originalname,
    });
  } catch (error) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    writeError(res, error);
  }
});

// ── Manual reload mapping from file ──
app.post("/user/reload-mapping", (_req, res) => {
  try {
    userMappingService.reload();
    res.json({
      ok: true,
      message: "映射数据已加载",
      count: userMappingService.getSize(),
      fetchedAt: userMappingService.getFetchedAt(),
    });
  } catch (error) {
    writeError(res, error);
  }
});

// ── Enriched Copilot members list ──
app.get("/api/user/members", async (_req, res) => {
  try {
    await ensureSeatsData();
    const seats = teamCache.seatsRaw;

    const members = seats.map((seat) => {
      const githubLogin = seat.login;
      const mapped = userMappingService.getUserByGithub(githubLogin);
      return {
        login: githubLogin,
        team: (teamCache.userTeamMap[githubLogin] || []).join(", ") || "-",
        adName: mapped ? mapped.adName : null,
        adMail: mapped ? mapped.adMail : null,
        planType: seat.planType || "-",
        lastActivityAt: seat.lastActivityAt || null,
      };
    });

    res.json({
      ok: true,
      loadedAt: new Date().toISOString(),
      total: members.length,
      mappedCount: members.filter((m) => m.adName !== null).length,
      members,
    });
  } catch (error) {
    writeError(res, error);
  }
});

// ── Lookup AD user by GitHub login (for other pages/APIs to call) ──
app.get("/api/user/info", (req, res) => {
  const githubName = String(req.query.github || "").trim();
  if (!githubName) {
    res.status(400).json({ ok: false, message: "缺少 github 参数" });
    return;
  }
  const mapped = userMappingService.getADUserByGithubName(githubName);
  if (mapped) {
    res.json({ ok: true, githubName: mapped.githubName, adName: mapped.adName, adMail: mapped.adMail, githubMail: mapped.githubMail });
  } else {
    res.json({ ok: false, message: "未找到映射记录", githubName });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
