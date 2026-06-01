import { describe, it, expect, beforeEach } from "vitest";

// We need to control the env before requiring the module
describe("billing-config", () => {
  let calcAmount, PLAN_CONFIG, INCLUDED_QUOTA, AI_CREDITS_PLAN_CONFIG, resolveBillingModel, getIncludedCreditsPerSeat, AI_CREDIT_PRICE_FALLBACK, BUSINESS_SEAT_BASE_COST, ENTERPRISE_SEAT_BASE_COST;

  beforeEach(() => {
    delete process.env.BILLING_MODEL;
    delete process.env.AI_CREDIT_PRICE_FALLBACK;
    delete process.env.BUSINESS_SEAT_BASE_COST;
    delete process.env.ENTERPRISE_SEAT_BASE_COST;
    delete require.cache[require.resolve("../lib/billing-config")];
    // Re-import fresh module for each test
    // Note: INCLUDED_QUOTA reads env at module load time, so we test calcAmount logic
    const mod = require("../lib/billing-config");
    calcAmount = mod.calcAmount;
    PLAN_CONFIG = mod.PLAN_CONFIG;
    INCLUDED_QUOTA = mod.INCLUDED_QUOTA;
    AI_CREDITS_PLAN_CONFIG = mod.AI_CREDITS_PLAN_CONFIG;
    resolveBillingModel = mod.resolveBillingModel;
    getIncludedCreditsPerSeat = mod.getIncludedCreditsPerSeat;
    AI_CREDIT_PRICE_FALLBACK = mod.AI_CREDIT_PRICE_FALLBACK;
    BUSINESS_SEAT_BASE_COST = mod.BUSINESS_SEAT_BASE_COST;
    ENTERPRISE_SEAT_BASE_COST = mod.ENTERPRISE_SEAT_BASE_COST;
  });

  describe("PLAN_CONFIG", () => {
    it("has business and enterprise plans", () => {
      expect(PLAN_CONFIG).toHaveProperty("business");
      expect(PLAN_CONFIG).toHaveProperty("enterprise");
    });

    it("business plan has expected structure", () => {
      expect(PLAN_CONFIG.business).toEqual({
        quota: INCLUDED_QUOTA,
        baseCost: BUSINESS_SEAT_BASE_COST,
        overagePrice: 0.04,
      });
    });

    it("enterprise plan has expected structure", () => {
      expect(PLAN_CONFIG.enterprise).toEqual({
        quota: 1000,
        baseCost: ENTERPRISE_SEAT_BASE_COST,
        overagePrice: 0.04,
      });
    });
  });

  describe("calcAmount", () => {
    it("returns baseCost when under quota (business)", () => {
      expect(calcAmount(100, "business")).toBe(19);
    });

    it("returns baseCost when exactly at quota (business)", () => {
      expect(calcAmount(INCLUDED_QUOTA, "business")).toBe(19);
    });

    it("calculates overage correctly (business)", () => {
      const over = 50;
      const expected = Math.round((19 + over * 0.04) * 10000) / 10000;
      expect(calcAmount(INCLUDED_QUOTA + over, "business")).toBe(expected);
    });

    it("calculates enterprise plan", () => {
      expect(calcAmount(500, "enterprise")).toBe(39);
      // 200 over quota
      const expected = Math.round((39 + 200 * 0.04) * 10000) / 10000;
      expect(calcAmount(1200, "enterprise")).toBe(expected);
    });

    it("falls back to business for unknown plan type", () => {
      expect(calcAmount(100, "unknown")).toBe(19);
    });

    it("handles zero requests", () => {
      expect(calcAmount(0, "business")).toBe(19);
    });
  });

  describe("billing model", () => {
    it("keeps legacy_pru when explicitly configured", () => {
      process.env.BILLING_MODEL = "legacy_pru";
      expect(resolveBillingModel({ year: 2026, month: 6 })).toBe("legacy_pru");
    });

    it("uses ai_credits when explicitly configured", () => {
      process.env.BILLING_MODEL = "ai_credits";
      expect(resolveBillingModel({ year: 2026, month: 5 })).toBe("ai_credits");
    });

    it("switches auto mode at the June 2026 billing period", () => {
      process.env.BILLING_MODEL = "auto";
      expect(resolveBillingModel({ year: 2026, month: 5 })).toBe("legacy_pru");
      expect(resolveBillingModel({ year: 2026, month: 6 })).toBe("ai_credits");
    });

    it("defaults to auto mode when BILLING_MODEL is not set", () => {
      expect(resolveBillingModel({ year: 2026, month: 5 })).toBe("legacy_pru");
      expect(resolveBillingModel({ year: 2026, month: 6 })).toBe("ai_credits");
    });

    it("falls back to auto mode for unknown values", () => {
      process.env.BILLING_MODEL = "surprise";
      expect(resolveBillingModel({ year: 2026, month: 6 })).toBe("ai_credits");
    });
  });

  describe("AI Credits plan config", () => {
    it("defines standard included credits and base cost", () => {
      expect(AI_CREDITS_PLAN_CONFIG.business).toMatchObject({ includedCredits: 1900, baseCost: 19 });
      expect(AI_CREDITS_PLAN_CONFIG.enterprise).toMatchObject({ includedCredits: 3900, baseCost: 39 });
    });

    it("uses promotional included credits from June through August 2026", () => {
      expect(getIncludedCreditsPerSeat("business", { year: 2026, month: 6 })).toBe(3000);
      expect(getIncludedCreditsPerSeat("enterprise", { year: 2026, month: 8 })).toBe(7000);
      expect(getIncludedCreditsPerSeat("business", { year: 2026, month: 9 })).toBe(1900);
    });

    it("falls back to business credits for unknown plans", () => {
      expect(getIncludedCreditsPerSeat("unknown", { year: 2026, month: 9 })).toBe(1900);
    });
  });

  describe("AI credit price fallback", () => {
    it("uses 0.01 by default", () => {
      expect(AI_CREDIT_PRICE_FALLBACK).toBe(0.01);
    });

    it("supports env override", () => {
      process.env.AI_CREDIT_PRICE_FALLBACK = "0.0125";
      delete require.cache[require.resolve("../lib/billing-config")];
      const mod = require("../lib/billing-config");
      expect(mod.AI_CREDIT_PRICE_FALLBACK).toBe(0.0125);
    });
  });

  describe("seat base cost overrides", () => {
    it("uses default seat base costs", () => {
      expect(BUSINESS_SEAT_BASE_COST).toBe(19);
      expect(ENTERPRISE_SEAT_BASE_COST).toBe(39);
    });

    it("supports env overrides", () => {
      process.env.BUSINESS_SEAT_BASE_COST = "21";
      process.env.ENTERPRISE_SEAT_BASE_COST = "45";
      delete require.cache[require.resolve("../lib/billing-config")];
      const mod = require("../lib/billing-config");
      expect(mod.BUSINESS_SEAT_BASE_COST).toBe(21);
      expect(mod.ENTERPRISE_SEAT_BASE_COST).toBe(45);
      expect(mod.PLAN_CONFIG.business.baseCost).toBe(21);
      expect(mod.PLAN_CONFIG.enterprise.baseCost).toBe(45);
    });
  });
});
