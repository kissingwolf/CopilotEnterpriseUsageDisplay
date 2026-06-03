import { describe, it, expect } from "vitest";
const createBillRouter = require("../routes/bill");

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