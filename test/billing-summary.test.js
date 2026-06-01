import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({
  githubGetJson: vi.fn(),
  invalidateCacheByPrefix: vi.fn(),
  ensureSeatsData: vi.fn(async () => {}),
}));

async function withBillingApp(teamCache, run) {
  const githubApiPath = require.resolve("../lib/github-api");
  const seatsPath = require.resolve("../routes/seats");
  require.cache[githubApiPath] = {
    id: githubApiPath,
    filename: githubApiPath,
    loaded: true,
    exports: {
      ApiError: class ApiError extends Error {},
      githubGetJson: mocks.githubGetJson,
      invalidateCacheByPrefix: mocks.invalidateCacheByPrefix,
    },
  };
  require.cache[seatsPath] = {
    id: seatsPath,
    filename: seatsPath,
    loaded: true,
    exports: {
      ensureSeatsData: mocks.ensureSeatsData,
      fetchCopilotSeats: vi.fn(),
    },
  };
  delete require.cache[require.resolve("../routes/billing")];
  const createBillingRouter = require("../routes/billing");
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter({
    usageStore: {},
    teamCache,
    userMappingService: { buildLookup: () => ({}) },
  }));

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

describe("GET /api/billing/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    delete process.env.ORG_NAME;
    delete process.env.BILLING_MODEL;
  });

  afterEach(() => {
    delete process.env.ENTERPRISE_SLUG;
    delete process.env.ORG_NAME;
    delete process.env.BILLING_MODEL;
  });

  it("preserves the legacy PRU summary behavior", async () => {
    process.env.BILLING_MODEL = "legacy_pru";
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        {
          product: "Copilot",
          sku: "Copilot Premium Request",
          quantity: 400,
          pricePerUnit: 0.04,
          grossAmount: 16,
          discountAmount: 4,
          netAmount: 12,
        },
      ],
    });

    const teamCache = {
      seatsRaw: [
        { login: "alice", planType: "business" },
        { login: "bob", planType: "business" },
      ],
      userTeamMap: {},
      fetchedAt: "2026-05-29T00:00:00Z",
    };

    await withBillingApp(teamCache, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/billing/summary?year=2026&month=5`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.billingModel).toBe("legacy_pru");
      expect(body.totalSeatsCost).toBe(38);
      expect(body.totalIncludedQuota).toBe(600);
      expect(body.totalPremiumRequests).toBe(400);
      expect(body.overageCost).toBe(12);
      expect(body.overageCostSource).toBe("api-netAmount");
      expect(body.totalEstimatedCost).toBe(50);
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/usage",
      expect.any(URLSearchParams)
    );
  });

  it("uses Copilot netAmount from enhanced billing summary in AI Credits mode", async () => {
    process.env.BILLING_MODEL = "ai_credits";
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "GitHub AI Credits", unitType: "credits", netAmount: 12.34567 },
        { product: "Actions", sku: "Actions Linux", unitType: "minutes", netAmount: 99 },
        { product: "Copilot", sku: "Copilot Premium Request", grossAmount: 5, discountAmount: 1 },
      ],
    });

    const teamCache = {
      seatsRaw: [
        { login: "alice", planType: "business" },
        { login: "bob", planType: "business" },
      ],
      userTeamMap: {},
      fetchedAt: "2026-06-10T00:00:00Z",
    };

    await withBillingApp(teamCache, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/billing/summary?year=2026&month=6`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.billingModel).toBe("ai_credits");
      expect(body.totalSeatsCost).toBe(38);
      expect(body.includedCreditsPool).toBe(6000);
      expect(body.copilotNetAmount).toBe(16.3457);
      expect(body.copilotBillingItemCount).toBe(2);
      expect(body.amountSources).toEqual(["netAmount", "grossAmount-discountAmount"]);
      expect(body.copilotEstimatedCredits).toBe(1634.57);
      expect(body.totalEstimatedCost).toBe(54.3457);
      expect(body.totalPremiumRequests).toBeUndefined();
      expect(body.overageRequests).toBeUndefined();
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/usage/summary",
      expect.any(URLSearchParams)
    );
    const params = mocks.githubGetJson.mock.calls[0][1];
    expect(params.get("product")).toBe("Copilot");
  });
});

describe("GET /api/billing/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    delete process.env.ORG_NAME;
    delete process.env.BILLING_MODEL;
  });

  afterEach(() => {
    delete process.env.ENTERPRISE_SLUG;
    delete process.env.ORG_NAME;
    delete process.env.BILLING_MODEL;
  });

  it("uses enhanced billing usage details in AI Credits mode", async () => {
    process.env.BILLING_MODEL = "ai_credits";
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", model: "GPT-5.5", netQuantity: 12.345, grossAmount: 1.23456, netAmount: 1.23456, pricePerUnit: 0.1 },
        { product: "Copilot", model: "Claude Opus 4.7", netQuantity: 20, grossAmount: 2, netAmount: 2, pricePerUnit: 0.1 },
        { product: "Copilot", model: "GPT-5.5", grossQuantity: 7, grossAmount: 0.7, netAmount: 0, pricePerUnit: 0.1 },
      ],
    });

    const teamCache = { seatsRaw: [], userTeamMap: {}, fetchedAt: null };

    await withBillingApp(teamCache, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.billingModel).toBe("ai_credits");
      expect(body.models).toEqual([
        { model: "Claude Opus 4.7", quantity: 20, grossQuantity: 20, grossAmount: 2, netAmount: 2, includedCredits: 0, additionalCredits: 20, pricePerUnit: 0.1 },
        { model: "GPT-5.5", quantity: 19.35, grossQuantity: 19.35, grossAmount: 1.9346, netAmount: 1.2346, includedCredits: 7, additionalCredits: 12.35, pricePerUnit: 0.1 },
      ]);
      expect(body.totalQuantity).toBe(39.35);
      expect(body.totalAmount).toBe(3.9346);
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/usage",
      expect.any(URLSearchParams)
    );
    const params = mocks.githubGetJson.mock.calls[0][1];
    expect(params.get("product")).toBe("Copilot");
  });

  it("keeps legacy PRU data source in legacy mode", async () => {
    process.env.BILLING_MODEL = "legacy_pru";
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", model: "GPT-5.5", grossQuantity: 10, grossAmount: 0.4, pricePerUnit: 0.04 },
      ],
    });

    const teamCache = { seatsRaw: [], userTeamMap: {}, fetchedAt: null };

    await withBillingApp(teamCache, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/billing/models?year=2026&month=5`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.billingModel).toBe("legacy_pru");
      expect(body.models).toEqual([
        { model: "GPT-5.5", quantity: 10, grossQuantity: 10, grossAmount: 0.4, netAmount: 0, includedCredits: 10, additionalCredits: 0, pricePerUnit: 0.04 },
      ]);
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/premium_request/usage",
      expect.any(URLSearchParams)
    );
  });

  it("selects the data source from the queried period in auto mode", async () => {
    mocks.githubGetJson.mockResolvedValue({ usageItems: [] });
    const teamCache = { seatsRaw: [], userTeamMap: {}, fetchedAt: null };

    await withBillingApp(teamCache, async (baseUrl) => {
      await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/usage",
      expect.any(URLSearchParams)
    );

    vi.clearAllMocks();
    mocks.githubGetJson.mockResolvedValue({ usageItems: [] });

    await withBillingApp(teamCache, async (baseUrl) => {
      await fetch(`${baseUrl}/api/billing/models?year=2026&month=5`);
    });

    expect(mocks.githubGetJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/premium_request/usage",
      expect.any(URLSearchParams)
    );
  });
});
