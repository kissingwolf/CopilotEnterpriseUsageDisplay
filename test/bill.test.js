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