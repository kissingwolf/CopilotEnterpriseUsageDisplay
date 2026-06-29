import { describe, it, expect, beforeEach, afterEach } from "vitest";

let helpers;

function loadHelpers() {
  delete require.cache[require.resolve("../lib/helpers")];
  helpers = require("../lib/helpers");
  return helpers;
}

beforeEach(() => {
  delete process.env.ENTERPRISE_SLUG;
  delete process.env.ORG_NAME;
  delete process.env.PRODUCT;
  delete process.env.MODEL;
  delete process.env.BILLING_YEAR;
  delete process.env.BILLING_MONTH;
  delete process.env.BILLING_DAY;
  loadHelpers();
});

afterEach(() => {
  delete process.env.ENTERPRISE_SLUG;
  delete process.env.ORG_NAME;
  delete process.env.PRODUCT;
  delete process.env.MODEL;
  delete process.env.BILLING_YEAR;
  delete process.env.BILLING_MONTH;
  delete process.env.BILLING_DAY;
});

describe("toNumber", () => {
  it("returns the number for a number input", () => {
    const { toNumber } = helpers;
    expect(toNumber(42)).toBe(42);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-3.14)).toBe(-3.14);
  });

  it("parses numeric strings", () => {
    const { toNumber } = helpers;
    expect(toNumber("100")).toBe(100);
    expect(toNumber("3.14")).toBe(3.14);
    expect(toNumber("  42  ")).toBe(42);
  });

  it("returns 0 for non-numeric strings", () => {
    const { toNumber } = helpers;
    expect(toNumber("abc")).toBe(0);
    expect(toNumber("")).toBe(0);
    expect(toNumber("  ")).toBe(0);
  });

  it("returns 0 for null / undefined / NaN", () => {
    const { toNumber } = helpers;
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(NaN)).toBe(0);
    expect(toNumber(Infinity)).toBe(0);
  });
});

describe("pickUser", () => {
  it("picks user from .user field", () => {
    const { pickUser } = helpers;
    expect(pickUser({ user: "alice" })).toBe("alice");
  });

  it("picks from .login field", () => {
    const { pickUser } = helpers;
    expect(pickUser({ login: "bob" })).toBe("bob");
  });

  it("picks from .username field", () => {
    const { pickUser } = helpers;
    expect(pickUser({ username: "charlie" })).toBe("charlie");
  });

  it("picks from nested object with .login", () => {
    const { pickUser } = helpers;
    expect(pickUser({ user: { login: "dave" } })).toBe("dave");
  });

  it("picks from nested object with .name", () => {
    const { pickUser } = helpers;
    expect(pickUser({ user: { name: "eve" } })).toBe("eve");
  });

  it("returns (unknown) when no field matches", () => {
    const { pickUser } = helpers;
    expect(pickUser({})).toBe("(unknown)");
    expect(pickUser({ foo: "bar" })).toBe("(unknown)");
  });

  it("skips empty strings", () => {
    const { pickUser } = helpers;
    expect(pickUser({ user: "", login: "frank" })).toBe("frank");
    expect(pickUser({ user: "  ", login: "grace" })).toBe("grace");
  });

  it("prioritizes user over login", () => {
    const { pickUser } = helpers;
    expect(pickUser({ user: "first", login: "second" })).toBe("first");
  });
});

describe("buildQueryParams", () => {
  it("passes through cost_center_id for cost-center scoped queries", () => {
    const { buildQueryParams } = helpers;
    const params = buildQueryParams({ year: 2026, month: 5, cost_center_id: "cc-123" });
    expect(params.get("year")).toBe("2026");
    expect(params.get("month")).toBe("5");
    expect(params.get("cost_center_id")).toBe("cc-123");
  });
});

describe("billing endpoints", () => {
  it("builds the legacy enterprise premium request endpoint", () => {
    process.env.ENTERPRISE_SLUG = "Acme Enterprise";
    loadHelpers();
    const endpoint = helpers.buildEndpoint();

    expect(endpoint).toMatchObject({
      kind: "enterprise",
      enterprise: "Acme Enterprise",
      scope: "enterprise:Acme Enterprise",
      path: "/enterprises/Acme%20Enterprise/settings/billing/premium_request/usage",
    });
  });

  it("builds the organization billing usage summary endpoint", () => {
    process.env.ORG_NAME = "octo-org";
    loadHelpers();
    const endpoint = helpers.buildBillingUsageEndpoint("summary");

    expect(endpoint).toMatchObject({
      kind: "org",
      org: "octo-org",
      scope: "org:octo-org",
      path: "/organizations/octo-org/settings/billing/usage/summary",
    });
  });

  it("builds enterprise billing usage endpoint for raw reports", () => {
    process.env.ENTERPRISE_SLUG = "StarbucksChina";
    loadHelpers();
    const endpoint = helpers.buildBillingUsageEndpoint("report");

    expect(endpoint.path).toBe("/enterprises/StarbucksChina/settings/billing/usage");
  });

  it("builds ai_credit usage endpoint when billing model is ai_credits", () => {
    process.env.ENTERPRISE_SLUG = "Acme Enterprise";
    loadHelpers();
    const endpoint = helpers.buildCopilotUsageEndpoint({ billingModel: "ai_credits" });

    expect(endpoint).toMatchObject({
      billingModel: "ai_credits",
      family: "ai_credit",
      path: "/enterprises/Acme%20Enterprise/settings/billing/ai_credit/usage",
    });
  });

  it("builds premium_request usage endpoint when billing model is legacy_pru", () => {
    process.env.ENTERPRISE_SLUG = "Acme Enterprise";
    loadHelpers();
    const endpoint = helpers.buildCopilotUsageEndpoint({ billingModel: "legacy_pru" });

    expect(endpoint).toMatchObject({
      billingModel: "legacy_pru",
      family: "premium_request",
      path: "/enterprises/Acme%20Enterprise/settings/billing/premium_request/usage",
    });
  });

  it("resolves auto mode by billing period", () => {
    process.env.ENTERPRISE_SLUG = "Acme Enterprise";
    loadHelpers();
    const endpoint = helpers.buildCopilotUsageEndpoint({ period: { year: 2026, month: 6 } });

    expect(endpoint).toMatchObject({
      billingModel: "ai_credits",
      family: "ai_credit",
      path: "/enterprises/Acme%20Enterprise/settings/billing/ai_credit/usage",
    });
  });
});

describe("Copilot billing usage items", () => {
  it("recognizes legacy premium request usage as Copilot billing", () => {
    expect(helpers.isCopilotBillingItem({ product: "Copilot", sku: "Copilot Premium Request" })).toBe(true);
  });

  it("recognizes future Copilot AI Credits usage without relying on premium request SKU", () => {
    expect(helpers.isCopilotBillingItem({ product: "Copilot", sku: "GitHub AI Credits", unitType: "credits" })).toBe(true);
  });

  it("excludes non-Copilot usage items", () => {
    expect(helpers.isCopilotBillingItem({ product: "Actions", sku: "Actions Linux", unitType: "minutes" })).toBe(false);
  });

  it("recognizes usage/summary AI units SKU (copilot_ai_unit)", () => {
    expect(helpers.isCopilotBillingItem({ product: "Copilot", sku: "copilot_ai_unit", unitType: "ai-units" })).toBe(true);
  });

  it("excludes seat subscription SKU (copilot_for_business)", () => {
    expect(helpers.isCopilotBillingItem({ product: "Copilot", sku: "copilot_for_business", unitType: "user-months" })).toBe(false);
  });

  it("prefers netAmount when normalizing billed amount", () => {
    expect(helpers.normalizeBillingAmount({ netAmount: 7, grossAmount: 10, discountAmount: 3 })).toEqual({ amount: 7, amountSource: "netAmount" });
  });

  it("falls back to gross minus discount when netAmount is absent", () => {
    expect(helpers.normalizeBillingAmount({ grossAmount: 10, discountAmount: 2.34567 })).toEqual({ amount: 7.6543, amountSource: "grossAmount-discountAmount" });
  });

  it("sums only Copilot billing items with auditable amount sources", () => {
    const result = helpers.aggregateCopilotBillingItems([
      { product: "Copilot", sku: "GitHub AI Credits", netAmount: 12.34567 },
      { product: "Actions", sku: "Actions Linux", netAmount: 99 },
      { product: "Copilot", sku: "Copilot Premium Request", grossAmount: 5, discountAmount: 1 },
    ]);

    expect(result).toEqual({ amount: 16.3457, itemCount: 2, amountSources: ["netAmount", "grossAmount-discountAmount"] });
  });
});

describe("quota usage buckets", () => {
  it("classifies quota usage with inclusive lower bounds", () => {
    const { getQuotaUsageBucketName } = helpers;
    expect(getQuotaUsageBucketName(0)).toBe("配额使用小于 5%");
    expect(getQuotaUsageBucketName(4.99)).toBe("配额使用小于 5%");
    expect(getQuotaUsageBucketName(5)).toBe("配额使用 大于 5% 小于 50%");
    expect(getQuotaUsageBucketName(49.99)).toBe("配额使用 大于 5% 小于 50%");
    expect(getQuotaUsageBucketName(50)).toBe("配额使用 大于 50% 小于 100%");
    expect(getQuotaUsageBucketName(99.99)).toBe("配额使用 大于 50% 小于 100%");
    expect(getQuotaUsageBucketName(100)).toBe("配额使用 大于 100% 小于 200%");
    expect(getQuotaUsageBucketName(199.99)).toBe("配额使用 大于 100% 小于 200%");
    expect(getQuotaUsageBucketName(200)).toBe("配额使用 大于 200%");
  });

  it("returns all buckets when classifying users", () => {
    const { QUOTA_USAGE_BUCKET_NAMES, classifyQuotaUsage } = helpers;
    const buckets = classifyQuotaUsage([
      { user: "alice", usagePercent: 0 },
      { user: "bob", usagePercent: 25 },
      { user: "cora", usagePercent: 75 },
      { user: "drew", usagePercent: 125 },
      { user: "erin", usagePercent: 225 },
    ]);

    expect(Object.keys(buckets)).toEqual(QUOTA_USAGE_BUCKET_NAMES);
    expect(buckets["配额使用小于 5%"].map((u) => u.user)).toEqual(["alice"]);
    expect(buckets["配额使用 大于 5% 小于 50%"].map((u) => u.user)).toEqual(["bob"]);
    expect(buckets["配额使用 大于 50% 小于 100%"].map((u) => u.user)).toEqual(["cora"]);
    expect(buckets["配额使用 大于 100% 小于 200%"].map((u) => u.user)).toEqual(["drew"]);
    expect(buckets["配额使用 大于 200%"].map((u) => u.user)).toEqual(["erin"]);
  });
});

describe("isLegacyProductSkus", () => {
  it("returns true for product-level Copilot SKUs", () => {
    expect(helpers.isLegacyProductSkus(["Copilot Premium Request", "Copilot Business"])).toBe(true);
    expect(helpers.isLegacyProductSkus(["Copilot Enterprise"])).toBe(true);
    expect(helpers.isLegacyProductSkus(["GitHub AI Credits", "Unknown"])).toBe(true);
  });

  it("returns false for actual AI model names", () => {
    expect(helpers.isLegacyProductSkus(["Claude Sonnet 4.6", "GPT-5.5"])).toBe(false);
    expect(helpers.isLegacyProductSkus(["Auto: GPT-5.3-Codex"])).toBe(false);
  });

  it("returns false for empty or missing arrays", () => {
    expect(helpers.isLegacyProductSkus([])).toBe(false);
    expect(helpers.isLegacyProductSkus(null)).toBe(false);
    expect(helpers.isLegacyProductSkus(undefined)).toBe(false);
  });

  it("returns false when mixed with legacy and model names", () => {
    expect(helpers.isLegacyProductSkus(["Copilot Business", "Claude Sonnet 4.6"])).toBe(false);
  });

  it("returns true when all non-empty keys are product-level and unknown placeholders", () => {
    expect(helpers.isLegacyProductSkus(["Unknown", "Copilot Premium Request", "  "])).toBe(true);
  });

  it("returns false when model-like keys are present even with product-level keys", () => {
    expect(helpers.isLegacyProductSkus(["Copilot Premium Request", "Auto: GPT-5.3-Codex"])).toBe(false);
  });
});
