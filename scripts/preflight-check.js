#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const dotenv = require("dotenv");

const strictMode = process.argv.includes("--strict");

const counters = {
  pass: 0,
  warn: 0,
  fail: 0,
};

function log(type, message) {
  if (type === "PASS") counters.pass += 1;
  if (type === "WARN") counters.warn += 1;
  if (type === "FAIL") counters.fail += 1;
  console.log(`[${type}] ${message}`);
}

function statusLabel(status) {
  if (status === 401) return "token invalid or expired";
  if (status === 403) return "permission denied (role or scope)";
  if (status === 404) return "resource not found (slug or feature)";
  if (status === 422) return "validation error";
  if (status >= 500) return "github server error";
  if (status === 0) return "network or timeout error";
  return "unexpected status";
}

function isIntString(value) {
  return /^\d+$/.test(String(value));
}

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

async function requestStatus(url, token, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
      signal: controller.signal,
    });
    return resp.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

(async function main() {
  loadEnv();

  const token = process.env.GITHUB_TOKEN || "";
  const enterprise = process.env.ENTERPRISE_SLUG || "";
  const apiBase = process.env.GITHUB_API_BASE || "https://api.github.com";

  // 1) Env checks
  if (!token) log("FAIL", "ENV: GITHUB_TOKEN is required");
  if (!enterprise) log("FAIL", "ENV: ENTERPRISE_SLUG is required");

  for (const [name, value] of Object.entries({
    CACHE_TTL: process.env.CACHE_TTL,
    INCLUDED_QUOTA: process.env.INCLUDED_QUOTA,
    PORT: process.env.PORT,
  })) {
    if (value != null && value !== "" && !isIntString(value)) {
      log("FAIL", `ENV: ${name} must be an integer`);
    }
  }

  if (counters.fail === 0) log("PASS", "ENV: required vars present");

  let apiHost = "";
  try {
    const u = new URL(apiBase);
    apiHost = u.hostname;
  } catch {
    log("FAIL", "ENV: GITHUB_API_BASE is invalid");
  }

  // 2) DNS and connectivity
  if (apiHost) {
    try {
      await dns.lookup(apiHost);
      log("PASS", `NET: DNS resolved for ${apiHost}`);
    } catch {
      log("FAIL", `NET: DNS resolution failed for ${apiHost}`);
    }

    const netStatus = await requestStatus(`${apiBase}/meta`, token, 12000);
    if (netStatus > 0) {
      log("PASS", `NET: ${apiHost}:443 reachable`);
    } else {
      log("FAIL", `NET: cannot reach ${apiHost}:443`);
    }
  }

  if (counters.fail > 0) {
    console.log(`\nSummary: PASS=${counters.pass} WARN=${counters.warn} FAIL=${counters.fail}`);
    process.exit(1);
  }

  // 3) Token validity
  let status = await requestStatus(`${apiBase}/user`, token);
  if (status === 200) {
    log("PASS", "AUTH: token valid");
  } else {
    const metaStatus = await requestStatus(`${apiBase}/meta`, token);
    if (metaStatus === 200) {
      log("PASS", "AUTH: token works on /meta");
    } else {
      log("FAIL", `AUTH: /user=${status}, /meta=${metaStatus} (${statusLabel(status)})`);
    }
  }

  // 4) Seats (required)
  status = await requestStatus(`${apiBase}/enterprises/${enterprise}/copilot/billing/seats`, token);
  if (status === 200) {
    log("PASS", "API: seats endpoint accessible");
  } else {
    log("FAIL", `API: seats endpoint status=${status} (${statusLabel(status)})`);
  }

  // 5) Premium usage (required)
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  status = await requestStatus(
    `${apiBase}/enterprises/${enterprise}/settings/billing/premium_request/usage?year=${year}&month=${month}`,
    token
  );
  if (status === 200) {
    log("PASS", "API: premium usage endpoint accessible");
  } else {
    log("FAIL", `API: premium usage endpoint status=${status} (${statusLabel(status)})`);
  }

  // 6) Cost centers (optional)
  status = await requestStatus(`${apiBase}/enterprises/${enterprise}/settings/billing/cost-centers`, token);
  if (status === 200) {
    log("PASS", "API: cost-centers feature available");
  } else if (status === 404) {
    log("WARN", "API: cost-centers feature not enabled (404)");
  } else if (status === 403) {
    log("WARN", "API: cost-centers permission denied (403)");
  } else {
    log("WARN", `API: cost-centers check status=${status} (${statusLabel(status)})`);
  }

  // 7) Budgets (optional)
  status = await requestStatus(`${apiBase}/enterprises/${enterprise}/settings/billing/budgets`, token);
  if (status === 200) {
    log("PASS", "API: budgets feature available");
  } else if (status === 404) {
    log("WARN", "API: budgets feature not enabled (404)");
  } else if (status === 403) {
    log("WARN", "API: budgets permission denied (403)");
  } else {
    log("WARN", `API: budgets check status=${status} (${statusLabel(status)})`);
  }

  console.log(`\nSummary: PASS=${counters.pass} WARN=${counters.warn} FAIL=${counters.fail}`);

  if (counters.fail > 0) {
    process.exit(1);
  }
  if (strictMode && counters.warn > 0) {
    console.log("Strict mode enabled: WARN treated as FAIL");
    process.exit(1);
  }
  process.exit(0);
})();
