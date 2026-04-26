import { describe, it, expect, beforeEach } from "vitest";

// We need to control the env before requiring the module
describe("billing-config", () => {
  let calcAmount, PLAN_CONFIG, INCLUDED_QUOTA;

  beforeEach(() => {
    // Re-import fresh module for each test
    // Note: INCLUDED_QUOTA reads env at module load time, so we test calcAmount logic
    const mod = require("../lib/billing-config");
    calcAmount = mod.calcAmount;
    PLAN_CONFIG = mod.PLAN_CONFIG;
    INCLUDED_QUOTA = mod.INCLUDED_QUOTA;
  });

  describe("PLAN_CONFIG", () => {
    it("has business and enterprise plans", () => {
      expect(PLAN_CONFIG).toHaveProperty("business");
      expect(PLAN_CONFIG).toHaveProperty("enterprise");
    });

    it("business plan has expected structure", () => {
      expect(PLAN_CONFIG.business).toEqual({
        quota: INCLUDED_QUOTA,
        baseCost: 19,
        overagePrice: 0.04,
      });
    });

    it("enterprise plan has expected structure", () => {
      expect(PLAN_CONFIG.enterprise).toEqual({
        quota: 1000,
        baseCost: 39,
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
});
