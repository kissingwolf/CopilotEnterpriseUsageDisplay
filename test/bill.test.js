import { describe, it, expect, vi } from "vitest";
import express from "express";
const createBillRouter = require("../routes/bill");

async function withBillApp(deps, githubGetJson, run) {
  const githubApiPath = require.resolve("../lib/github-api");
  require.cache[githubApiPath] = {
    id: githubApiPath,
    filename: githubApiPath,
    loaded: true,
    exports: {
      githubGetJson,
      MAX_CONCURRENT_GITHUB: 3,
    },
  };
  delete require.cache[require.resolve("../routes/bill")];
  const createTestBillRouter = require("../routes/bill");
  const app = express();
  app.use(express.json());
  app.use(createTestBillRouter(deps).router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("bill team aggregation", () => {
  it("prefers direct spent over computed overageCost for team totals", () => {
    const { groupByTeam } = createBillRouter.__testables;
    const billRows = [
      {
        team: "PlatformEngineeringTeam",
        login: "alice",
        adName: null,
        planType: "business",
        seatCost: 19,
        requests: 520,
        quota: 300,
        overageRequests: 220,
        overageCost: 8.8,
        totalCost: 27.8,
      },
    ];
    const directSpentMap = new Map([["platformengineeringteam", 200]]);

    const teams = groupByTeam(billRows, directSpentMap);

    expect(teams).toHaveLength(1);
    expect(teams[0].team).toBe("PlatformEngineeringTeam");
    expect(teams[0].overageCost).toBe(200);
    expect(teams[0].totalCost).toBe(219);
    expect(teams[0].users[0].overageCost).toBe(8.8);
  });
});

describe("computeUserOverage", () => {
  const { computeUserOverage } = createBillRouter.__testables;

  it("prices overage at AI_CREDIT_PRICE_FALLBACK in ai_credits mode (business)", () => {
    // INCLUDED_QUOTA default 300; AI_CREDIT_PRICE_FALLBACK default 0.01.
    const result = computeUserOverage(520, "business", "ai_credits");
    expect(result.overageRequests).toBe(220);
    expect(result.overageCost).toBe(2.2);
    expect(result.unitPrice).toBe(0.01);
  });

  it("prices overage at AI_CREDIT_PRICE_FALLBACK in ai_credits mode (enterprise)", () => {
    const result = computeUserOverage(1200, "enterprise", "ai_credits");
    expect(result.overageRequests).toBe(200);
    expect(result.overageCost).toBe(2);
    expect(result.unitPrice).toBe(0.01);
  });

  it("keeps legacy $0.04 pricing in legacy_pru mode", () => {
    const result = computeUserOverage(520, "business", "legacy_pru");
    expect(result.overageRequests).toBe(220);
    expect(result.overageCost).toBe(8.8);
    expect(result.unitPrice).toBe(0.04);
  });

  it("returns zero overage when under quota", () => {
    const result = computeUserOverage(100, "business", "ai_credits");
    expect(result.overageRequests).toBe(0);
    expect(result.overageCost).toBe(0);
  });
});

describe("monthly bill period completeness", () => {
  it("falls back to monthly GitHub usage when SQLite is missing a billing date", async () => {
    process.env.ENTERPRISE_SLUG = "acme";
    const githubGetJson = vi.fn(async (pathname) => {
      if (pathname.includes("premium_request/usage")) {
        return { usageItems: [{ user: "alice", netQuantity: 500 }] };
      }
      if (pathname.includes("cost-centers")) return { costCenters: [] };
      throw new Error(`Unexpected GitHub path: ${pathname}`);
    });
    const usageStore = {
      getDaysInRange: () => [
        { date: "2025-04-01", ranking: JSON.stringify([{ user: "alice", requests: 10 }]) },
        { date: "2025-04-03", ranking: JSON.stringify([{ user: "alice", requests: 10 }]) },
      ],
      hasBill: () => null,
      deleteBill: vi.fn(),
      saveBill: vi.fn(),
    };
    const teamCache = {
      seatsRaw: [{ login: "alice", team: "-", planType: "business" }],
      userTeamMap: {},
      fetchedAt: "2025-04-30T00:00:00Z",
    };

    try {
      await withBillApp({
        usageStore,
        teamCache,
        userMappingService: { buildLookup: () => ({}) },
        usageRouter: {},
      }, githubGetJson, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/bill?year=2025&month=4`);
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.teams[0].users[0].requests).toBe(500);
      });
    } finally {
      delete process.env.ENTERPRISE_SLUG;
    }

    expect(githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/premium_request/usage",
      expect.any(URLSearchParams)
    );
  });

  it("keeps the previous bill when any forced-refresh date fails", async () => {
    process.env.ENTERPRISE_SLUG = "acme";
    let dailyRows = [
      { date: "2025-04-01", ranking: JSON.stringify([{ user: "alice", requests: 10 }]) },
    ];
    const usageStore = {
      deleteDaysInMonth: vi.fn(),
      deleteBill: vi.fn(),
      saveBill: vi.fn(),
      getDaysInRange: () => structuredClone(dailyRows),
      restoreDaysInRange: vi.fn((_start, _end, rows) => {
        dailyRows = structuredClone(rows);
      }),
    };
    const usageRouter = {
      forceRefreshDay: vi.fn(async (dateStr) => {
        if (dateStr === "2025-04-02") throw new Error("upstream unavailable");
        if (dateStr === "2025-04-01") {
          dailyRows = [
            { date: "2025-04-01", ranking: JSON.stringify([{ user: "alice", requests: 999 }]) },
          ];
        }
        return { result: {} };
      }),
    };

    try {
      await withBillApp({
        usageStore,
        teamCache: {
          seatsRaw: [{ login: "alice", team: "-", planType: "business" }],
          userTeamMap: {},
          fetchedAt: "2025-04-30T00:00:00Z",
        },
        userMappingService: { buildLookup: () => ({}) },
        usageRouter,
      }, vi.fn(), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/bill/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ year: 2025, month: 4 }),
        });
        const body = await response.json();
        expect(response.status).toBe(502);
        expect(body.failedDates).toEqual(["2025-04-02"]);
      });
    } finally {
      delete process.env.ENTERPRISE_SLUG;
    }

    expect(usageStore.deleteDaysInMonth).not.toHaveBeenCalled();
    expect(usageStore.deleteBill).not.toHaveBeenCalled();
    expect(usageStore.saveBill).not.toHaveBeenCalled();
    expect(JSON.parse(dailyRows[0].ranking)[0].requests).toBe(10);
  });
});