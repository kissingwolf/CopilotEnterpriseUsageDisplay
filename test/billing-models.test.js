import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";

const mocks = vi.hoisted(() => ({
  githubGetJson: vi.fn(),
  invalidateCacheByPrefix: vi.fn(),
  ensureSeatsData: vi.fn(async () => {}),
}));

async function withBillingApp(run) {
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
    teamCache: { seatsRaw: [], userTeamMap: {}, fetchedAt: null },
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

describe("GET /api/billing/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    delete process.env.ORG_NAME;
    process.env.BILLING_MODEL = "ai_credits";
  });

  afterEach(() => {
    delete process.env.ENTERPRISE_SLUG;
    delete process.env.ORG_NAME;
    delete process.env.BILLING_MODEL;
  });

  it("aggregates usage items by sku, summing quantity / grossAmount / netAmount", async () => {
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "Claude Sonnet 4.6", model: "claude-sonnet-4.6",
          quantity: 1000, pricePerUnit: 0.01, grossAmount: 10, netAmount: 0 },
        { product: "Copilot", sku: "Claude Sonnet 4.6", model: "claude-sonnet-4.6",
          quantity: 500, pricePerUnit: 0.01, grossAmount: 5, netAmount: 0 },
        { product: "Copilot", sku: "GPT-5.5", model: "gpt-5.5",
          quantity: 200, pricePerUnit: 0.01, grossAmount: 2, netAmount: 0 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
      const body = await res.json();
      expect(res.status).toBe(200);
      const sonnet = body.models.find((m) => m.model === "Claude Sonnet 4.6");
      const gpt = body.models.find((m) => m.model === "GPT-5.5");
      expect(sonnet.quantity).toBe(1500);
      expect(sonnet.grossAmount).toBe(15);
      expect(sonnet.netAmount).toBe(0);
      expect(gpt.quantity).toBe(200);
      expect(gpt.grossAmount).toBe(2);
    });
  });

  it("derives includedCredits and additionalCredits from quantity and netAmount", async () => {
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "GPT-5.5",
          quantity: 1000, pricePerUnit: 0.01, grossAmount: 10, netAmount: 4 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
      const body = await res.json();
      const row = body.models[0];
      // additionalCredits = netAmount / pricePerUnit = 4 / 0.01 = 400
      expect(row.additionalCredits).toBe(400);
      // includedCredits = quantity - additionalCredits = 600
      expect(row.includedCredits).toBe(600);
    });
  });

  it("sorts models by grossAmount descending", async () => {
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "Small", quantity: 50, pricePerUnit: 0.01, grossAmount: 0.5, netAmount: 0 },
        { product: "Copilot", sku: "Big", quantity: 100, pricePerUnit: 0.1, grossAmount: 10, netAmount: 0 },
        { product: "Copilot", sku: "Medium", quantity: 200, pricePerUnit: 0.01, grossAmount: 2, netAmount: 0 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
      const body = await res.json();
      expect(body.models.map((m) => m.model)).toEqual(["Big", "Medium", "Small"]);
    });
  });

  it("keeps grossQuantity as alias of quantity for backward compatibility", async () => {
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "GPT-5.5", quantity: 1500, pricePerUnit: 0.01, grossAmount: 15, netAmount: 0 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
      const body = await res.json();
      const row = body.models[0];
      expect(row.grossQuantity).toBe(row.quantity);
      expect(row.grossQuantity).toBe(1500);
    });
  });
});
