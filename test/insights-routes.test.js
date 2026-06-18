import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({
  githubGetJson: vi.fn(),
}));

async function withInsightsApp(run) {
  const githubApiPath = require.resolve("../lib/github-api");
  require.cache[githubApiPath] = {
    id: githubApiPath,
    filename: githubApiPath,
    loaded: true,
    exports: {
      ApiError: class ApiError extends Error {},
      githubGetJson: mocks.githubGetJson,
    },
  };

  delete require.cache[require.resolve("../routes/insights")];
  const createInsightsRouter = require("../routes/insights");
  const app = express();
  app.use(express.json());
  app.use(createInsightsRouter({ usageStore: {}, teamCache: {}, userMappingService: {} }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("GET /api/insights", () => {
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ENTERPRISE_SLUG;
  });

  it("fetches the enterprise metrics report and maps it into dashboard data", async () => {
    globalThis.fetch = vi.fn((url, options) => {
      if (String(url) === "https://signed.example/reports/enterprise-28-day.ndjson") {
        return Promise.resolve(new Response(JSON.stringify({
          report_start_day: "2026-05-21",
          report_end_day: "2026-06-17",
          day_totals: [
            { day: "2026-06-17", monthly_active_users: 21, daily_active_users: 10, weekly_active_users: 23, user_initiated_interaction_count: 75, loc_added_sum: 140, loc_deleted_sum: 30, totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 100, code_acceptance_activity_count: 25, loc_suggested_to_add_sum: 140, loc_added_sum: 30 }] },
            { day: "2026-06-16", monthly_active_users: 20, daily_active_users: 7, weekly_active_users: 20, user_initiated_interaction_count: 28, loc_added_sum: 100, loc_deleted_sum: 25, totals_by_feature: [{ feature: "code_completion", code_generation_activity_count: 50, code_acceptance_activity_count: 10, loc_suggested_to_add_sum: 100, loc_added_sum: 20 }] },
          ],
        }), { status: 200, headers: { "content-type": "application/octet-stream" } }));
      }
      return originalFetch(url, options);
    });

    mocks.githubGetJson
      .mockResolvedValueOnce({
        download_links: ["https://signed.example/reports/enterprise-28-day.ndjson"],
        report_start_day: "2026-05-21",
        report_end_day: "2026-06-17",
      })
      .mockResolvedValueOnce({ usageItems: [{ product: "Copilot", model: "GPT-5.3-Codex", netQuantity: 12 }] });

    await withInsightsApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/insights?range=28`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.meta.source).toBe("github-reports");
      expect(body.data.tabs.usage.metrics.ideActiveUsers).toBe(21);
      expect(body.data.tabs.usage.charts.dailyActiveUsers).toEqual([
        { date: "2026-06-16", users: 7 },
        { date: "2026-06-17", users: 10 },
      ]);
      expect(body.data.tabs.usage.charts.averageChatRequests).toEqual([
        { date: "2026-06-16", requests: 4 },
        { date: "2026-06-17", requests: 7.5 },
      ]);
      expect(body.data.tabs.usage.charts.codeCompletions).toEqual([
        { date: "2026-06-16", suggested: 50, accepted: 10 },
        { date: "2026-06-17", suggested: 100, accepted: 25 },
      ]);
      expect(body.data.tabs.usage.charts.completionAcceptanceRate.series).toEqual([
        { date: "2026-06-16", rate: 20 },
        { date: "2026-06-17", rate: 25 },
      ]);
      expect(body.data.tabs.codeGeneration.charts.dailyLinesChanged).toEqual([
        { date: "2026-06-16", added: 100, deleted: 25 },
        { date: "2026-06-17", added: 140, deleted: 30 },
      ]);
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/copilot/metrics/reports/enterprise-28-day/latest",
      null
    );
    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/ai_credit/usage",
      expect.any(URLSearchParams)
    );
  });

  it("returns partial live data with warnings when the Copilot usage endpoint is unavailable", async () => {
    const notFound = new Error("404 : Not Found");
    notFound.statusCode = 404;
    mocks.githubGetJson
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ usageItems: [{ product: "Copilot", model: "Claude Sonnet 4.6", netQuantity: 24 }] });

    await withInsightsApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/insights?range=28`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.meta.source).toBe("github-partial");
      expect(body.data.meta.warnings).toEqual([
        "Copilot usage endpoint unavailable: 404 : Not Found",
      ]);
      expect(body.data.tabs.codeGeneration.charts.modelEfficiency[0].label).toBe("Claude Sonnet 4.6");
    });
  });
});