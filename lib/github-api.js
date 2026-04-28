/**
 * GitHub API infrastructure – concurrency queue, retry/backoff, GET cache (LRU),
 * ETag conditional requests, single-flight dedup.
 *
 * Extracted from server.js so routes can `require('./github-api')`.
 */

const { LRUCache } = require("lru-cache");
const logger = require("./logger");
const { requiredEnv } = require("./billing-config");

/* ── Shared error class ── */

class ApiError extends Error {
  constructor(message, statusCode = 500, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.rateLimit = extra.rateLimit || null;
  }
}

/* ── Concurrency queue ── */

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
function getLastRateLimit() { return lastRateLimit; }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── GET cache (LRU) ── */

const githubGetCache = new LRUCache({ max: 500, ttl: 0 /* we manage TTL per-key */ });
const githubInflight = new Map(); // key -> Promise

/* ── ETag cache (in-memory mirror of SQLite etag_cache) ── */
// Initialised externally via initEtagCache()
let etagCache = new Map(); // key -> { etag, data, ts }
let _usageStore = null; // will be set via init()

function initEtagCache(usageStore) {
  _usageStore = usageStore;
  const persisted = usageStore.loadAllEtags();
  for (const [key, entry] of Object.entries(persisted)) {
    etagCache.set(key, { etag: entry.etag, data: entry.data, ts: new Date(entry.fetched_at).getTime() });
  }
  logger.info({ count: Object.keys(persisted).length }, "Restored ETag entries from SQLite");
}

/* ── Key / TTL helpers ── */

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

/* ── Low-level fetch ── */

async function githubFetchRaw(method, pathname, searchParams, body, opts = {}) {
  await acquireGithubSlot();
  try {
    const token = requiredEnv("GITHUB_TOKEN");
    if (!token) throw new ApiError("Missing GITHUB_TOKEN in .env", 500);

    const apiBase = requiredEnv("GITHUB_API_BASE") || "https://api.github.com";
    const query = searchParams ? searchParams.toString() : "";
    const url = `${apiBase}${pathname}${query ? `?${query}` : ""}`;

    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    };
    if (body) headers["Content-Type"] = "application/json";
    if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;

    const resp = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

    const etag = resp.headers.get("etag") || null;

    /* Handle 304 Not Modified */
    if (resp.status === 304) {
      return {
        status: 304, ok: true, statusText: "Not Modified",
        data: opts.cachedData, headers: resp.headers,
        rateLimit: { limit: 0, remaining: 0, resetAt: null },
        etagNotModified: true,
      };
    }

    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    const limit = Number(resp.headers.get("x-ratelimit-limit") || 0);
    const remaining = Number(resp.headers.get("x-ratelimit-remaining") || 0);
    const resetEpoch = Number(resp.headers.get("x-ratelimit-reset") || 0);
    const resetAt = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : null;

    if (limit || remaining || resetAt) {
      lastRateLimit = { limit, remaining, resetAt, updatedAt: new Date().toISOString() };
    }

    /* Persist ETag for GET 200 */
    if (method === "GET" && resp.ok && etag) {
      const now = new Date().toISOString();
      const cacheKey = buildCacheKey(method, pathname, searchParams);
      etagCache.set(cacheKey, { etag, data, ts: Date.now() });
      try { if (_usageStore) _usageStore.saveEtag(cacheKey, etag, data, now); } catch { /* noop */ }
    }

    return {
      status: resp.status, ok: resp.ok, statusText: resp.statusText,
      data, headers: resp.headers, rateLimit: { limit, remaining, resetAt }, etag,
    };
  } finally {
    releaseGithubSlot();
  }
}

/* ── Retry wrapper ── */

async function githubRequest(method, pathname, searchParams, body, opts = {}) {
  const withHeaders = Boolean(opts.withHeaders);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_GITHUB_RETRIES + 1; attempt += 1) {
    const fetchOpts = {};
    if (opts.ifNoneMatch) fetchOpts.ifNoneMatch = opts.ifNoneMatch;
    if (opts.cachedData) fetchOpts.cachedData = opts.cachedData;

    const result = await githubFetchRaw(method, pathname, searchParams, body, fetchOpts);

    if (result.etagNotModified || result.ok) {
      return withHeaders
        ? { data: result.data, headers: result.headers, rateLimit: result.rateLimit }
        : result.data;
    }

    const msg = result.data?.message || "GitHub API request failed";
    const isPrimaryLimited = result.status === 429;
    const isSecondaryLimited = result.status === 403 && /secondary rate limit|rate limit/i.test(String(msg));
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
      logger.warn(
        { method, pathname, status: result.status, attempt, waitMs, remaining: result.rateLimit.remaining },
        "GitHub API retry"
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

/* ── Public high-level helpers ── */

async function githubGetJson(pathname, searchParams) {
  const ttl = ttlForPath(pathname);
  const key = buildCacheKey("GET", pathname, searchParams);

  if (ttl > 0) {
    const hit = githubGetCache.get(key);
    if (hit && Date.now() - hit.ts < ttl) {
      logger.debug({ pathname, key }, "LRU cache hit");
      return hit.data;
    }
  }

  if (githubInflight.has(key)) {
    logger.debug({ pathname, key }, "In-flight dedup");
    return githubInflight.get(key);
  }

  const reqOpts = {};
  const etagEntry = etagCache.get(key);
  if (etagEntry) {
    reqOpts.ifNoneMatch = etagEntry.etag;
    reqOpts.cachedData = etagEntry.data;
    logger.debug({ pathname, etag: etagEntry.etag }, "ETag conditional request");
  } else {
    logger.debug({ pathname }, "GitHub API call (no cache)");
  }

  const promise = githubRequest("GET", pathname, searchParams, undefined, reqOpts)
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
  const key = buildCacheKey("GET", pathname, searchParams);
  const reqOpts = { withHeaders: true };
  const etagEntry = etagCache.get(key);
  if (etagEntry) {
    reqOpts.ifNoneMatch = etagEntry.etag;
    reqOpts.cachedData = etagEntry.data;
  }
  const result = await githubRequest("GET", pathname, searchParams, undefined, reqOpts);

  const etag = result.headers?.get?.("etag");
  if (etag && _usageStore) {
    const now = new Date().toISOString();
    etagCache.set(key, { etag, data: result.data, ts: Date.now() });
    _usageStore.saveEtag(key, etag, result.data, now);
  }

  return result;
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

module.exports = {
  ApiError,
  initEtagCache,
  getLastRateLimit,
  githubGetJson,
  githubGetWithHeaders,
  githubPostJson,
  githubDeleteJson,
  githubRequestJson,
  invalidateCacheByPrefix,
  buildCacheKey,
  MAX_CONCURRENT_GITHUB,
};
