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

  it("aggregates usage items by model, summing quantity / grossAmount / netAmount", async () => {
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "Copilot Premium Request", model: "Claude Sonnet 4.6",
          quantity: 1000, pricePerUnit: 0.01, grossAmount: 10, netAmount: 0 },
        { product: "Copilot", sku: "Copilot Premium Request", model: "Claude Sonnet 4.6",
          quantity: 500, pricePerUnit: 0.01, grossAmount: 5, netAmount: 0 },
        { product: "Copilot", sku: "Copilot Premium Request", model: "GPT-5.5",
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

  it("falls back to AI Credits API when legacy returns product-level SKUs", async () => {
    // Force legacy_pru mode (month=5 is before the ai_credits threshold)
    delete process.env.BILLING_MODEL;

    // First call (legacy) returns product-level SKUs
    mocks.githubGetJson.mockResolvedValueOnce({
      usageItems: [
        { product: "Copilot", sku: "Copilot Premium Request", quantity: 458, pricePerUnit: 0.04, grossAmount: 18.35, netAmount: 0 },
        { product: "Copilot", sku: "Copilot Business", quantity: 0.19, pricePerUnit: 0.04, grossAmount: 3.68, netAmount: 3.68 },
      ],
    });
    // Second call (AI Credits) returns actual model names
    mocks.githubGetJson.mockResolvedValueOnce({
      usageItems: [
        { product: "Copilot", sku: "Claude Sonnet 4.6", quantity: 300, pricePerUnit: 0.01, grossAmount: 3, netAmount: 0 },
        { product: "Copilot", sku: "GPT-5.5", quantity: 158, pricePerUnit: 0.01, grossAmount: 19.03, netAmount: 3.68 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=5`);
      const body = await res.json();
      expect(res.status).toBe(200);
      // Should have actual model names, not product-level categories
      const modelNames = body.models.map((m) => m.model);
      expect(modelNames).toContain("Claude Sonnet 4.6");
      expect(modelNames).toContain("GPT-5.5");
      expect(modelNames).not.toContain("Copilot Premium Request");
      expect(modelNames).not.toContain("Copilot Business");
      // billingModel should reflect the fallback
      expect(body.billingModel).toBe("ai_credits");
      // Should have called githubGetJson twice (legacy + fallback)
      expect(mocks.githubGetJson).toHaveBeenCalledTimes(2);
    });
  });

  it("does not fall back when AI Credits API returns model-level SKUs directly", async () => {
    // Force ai_credits mode
    process.env.BILLING_MODEL = "ai_credits";

    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "Claude Sonnet 4.6", quantity: 1000, pricePerUnit: 0.01, grossAmount: 10, netAmount: 0 },
        { product: "Copilot", sku: "GPT-5.5", quantity: 500, pricePerUnit: 0.01, grossAmount: 5, netAmount: 0 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=6`);
      const body = await res.json();
      expect(res.status).toBe(200);
      // Should have real model names
      expect(body.models.map((m) => m.model)).toEqual(["Claude Sonnet 4.6", "GPT-5.5"]);
      expect(body.billingModel).toBe("ai_credits");
      // Only one API call (no fallback needed)
      expect(mocks.githubGetJson).toHaveBeenCalledTimes(1);
    });
  });

  it("reverse fallback: when ai_credits returns product-level SKUs, tries legacy API for model names", async () => {
    // Force ai_credits mode (as user's .env has BILLING_MODEL=ai_credits)
    process.env.BILLING_MODEL = "ai_credits";

    // First call (AI Credits) returns product-level SKUs
    mocks.githubGetJson.mockResolvedValueOnce({
      usageItems: [
        { product: "Copilot", sku: "Copilot Premium Request", quantity: 458, pricePerUnit: 0.04, grossAmount: 18.35, netAmount: 0 },
        { product: "Copilot", sku: "Copilot Business", quantity: 0.19, pricePerUnit: 0.04, grossAmount: 3.68, netAmount: 3.68 },
      ],
    });
    // Second call (legacy PRU) returns actual model names
    mocks.githubGetJson.mockResolvedValueOnce({
      usageItems: [
        { product: "Copilot", sku: "Claude Sonnet 4.6", quantity: 300, pricePerUnit: 0.01, grossAmount: 3, netAmount: 0 },
        { product: "Copilot", sku: "GPT-5.5", quantity: 158, pricePerUnit: 0.01, grossAmount: 19.03, netAmount: 3.68 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=5`);
      const body = await res.json();
      expect(res.status).toBe(200);
      // Should have real model names from legacy fallback
      const modelNames = body.models.map((m) => m.model);
      expect(modelNames).toContain("Claude Sonnet 4.6");
      expect(modelNames).toContain("GPT-5.5");
      expect(modelNames).not.toContain("Copilot Premium Request");
      // billingModel should reflect the fallback to legacy_pru
      expect(body.billingModel).toBe("legacy_pru");
      // Should have called githubGetJson twice (ai_credits + legacy fallback)
      expect(mocks.githubGetJson).toHaveBeenCalledTimes(2);
    });
  });

  it("prefers `model` over `sku` when legacy /premium_request/usage returns product-level sku with real model field", async () => {
    // Real-world shape from /enterprises/{slug}/settings/billing/premium_request/usage:
    //   sku is always "Copilot Premium Request" (product-level)
    //   model holds the actual AI model name ("Auto: Claude Haiku 4.5", etc.)
    process.env.BILLING_MODEL = "ai_credits";

    // Primary call (AI Credits /usage) returns aggregated product-level data WITHOUT model field
    mocks.githubGetJson.mockResolvedValueOnce({
      usageItems: [
        { product: "copilot", sku: "Copilot Premium Request", quantity: 458, pricePerUnit: 0.04, grossAmount: 18.35, netAmount: 0 },
        { product: "copilot", sku: "Copilot Business", quantity: 0.19, pricePerUnit: 0.04, grossAmount: 3.68, netAmount: 3.68 },
      ],
    });
    // Fallback call (legacy /premium_request/usage) returns model-level data via `model` field
    mocks.githubGetJson.mockResolvedValueOnce({
      usageItems: [
        { product: "Copilot", sku: "Copilot Premium Request", model: "Claude Opus 4.7",
          grossQuantity: 9205.71, netQuantity: 9205.71, pricePerUnit: 0.04, grossAmount: 1055.78, netAmount: 368.22 },
        { product: "Copilot", sku: "Copilot Premium Request", model: "GPT-5.5",
          grossQuantity: 2639.09, netQuantity: 2639.09, pricePerUnit: 0.04, grossAmount: 502.04, netAmount: 105.56 },
        { product: "Copilot", sku: "Copilot Premium Request", model: "Claude Sonnet 4.6",
          grossQuantity: 256.03, netQuantity: 256.03, pricePerUnit: 0.04, grossAmount: 128.48, netAmount: 10.24 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=5`);
      const body = await res.json();
      expect(res.status).toBe(200);
      const modelNames = body.models.map((m) => m.model);
      // Real model names should appear, NOT the product-level sku
      expect(modelNames).toContain("Claude Opus 4.7");
      expect(modelNames).toContain("GPT-5.5");
      expect(modelNames).toContain("Claude Sonnet 4.6");
      expect(modelNames).not.toContain("Copilot Premium Request");
      expect(body.billingModel).toBe("legacy_pru");
      // Sorted by grossAmount desc
      expect(modelNames[0]).toBe("Claude Opus 4.7");
    });
  });

  it("keeps primary result when both APIs return product-level SKUs", async () => {
    // Force ai_credits mode
    process.env.BILLING_MODEL = "ai_credits";

    // Both APIs return product-level SKUs
    mocks.githubGetJson.mockResolvedValue({
      usageItems: [
        { product: "Copilot", sku: "Copilot Premium Request", quantity: 458, pricePerUnit: 0.04, grossAmount: 18.35, netAmount: 0 },
        { product: "Copilot", sku: "Copilot Business", quantity: 0.19, pricePerUnit: 0.04, grossAmount: 3.68, netAmount: 3.68 },
      ],
    });

    await withBillingApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/models?year=2026&month=5`);
      const body = await res.json();
      expect(res.status).toBe(200);
      // Keeps original product-level data since neither API has model-level info
      const modelNames = body.models.map((m) => m.model);
      expect(modelNames).toContain("Copilot Premium Request");
      expect(modelNames).toContain("Copilot Business");
      // billingModel stays as ai_credits (no successful fallback)
      expect(body.billingModel).toBe("ai_credits");
      // Should have tried both APIs
      expect(mocks.githubGetJson).toHaveBeenCalledTimes(2);
    });
  });
});
