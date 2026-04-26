import { describe, it, expect } from "vitest";
const { parseDateStr, enumerateDays, buildDateKey } = require("../lib/date-utils");

describe("parseDateStr", () => {
  it("parses a valid YYYY-MM-DD string", () => {
    expect(parseDateStr("2025-03-15")).toEqual({ year: 2025, month: 3, day: 15 });
  });

  it("parses first day of month", () => {
    expect(parseDateStr("2024-01-01")).toEqual({ year: 2024, month: 1, day: 1 });
  });

  it("returns null for null / undefined / empty", () => {
    expect(parseDateStr(null)).toBeNull();
    expect(parseDateStr(undefined)).toBeNull();
    expect(parseDateStr("")).toBeNull();
  });

  it("returns null for invalid formats", () => {
    expect(parseDateStr("2025-3-5")).toBeNull();
    expect(parseDateStr("2025/03/15")).toBeNull();
    expect(parseDateStr("not-a-date")).toBeNull();
    expect(parseDateStr("20251301")).toBeNull();
  });

  it("returns null for non-string inputs", () => {
    expect(parseDateStr(12345)).toBeNull();
    expect(parseDateStr({})).toBeNull();
  });
});

describe("enumerateDays", () => {
  it("enumerates a single day", () => {
    const result = enumerateDays("2025-04-10", "2025-04-10");
    expect(result).toEqual([{ year: 2025, month: 4, day: 10 }]);
  });

  it("enumerates multiple days", () => {
    const result = enumerateDays("2025-04-01", "2025-04-03");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ year: 2025, month: 4, day: 1 });
    expect(result[2]).toEqual({ year: 2025, month: 4, day: 3 });
  });

  it("handles month boundary", () => {
    const result = enumerateDays("2025-01-30", "2025-02-02");
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual({ year: 2025, month: 1, day: 31 });
    expect(result[2]).toEqual({ year: 2025, month: 2, day: 1 });
  });

  it("returns empty array for reversed range", () => {
    expect(enumerateDays("2025-04-10", "2025-04-01")).toEqual([]);
  });

  it("returns empty array for invalid dates", () => {
    expect(enumerateDays("bad", "dates")).toEqual([]);
  });
});

describe("buildDateKey", () => {
  it("builds YYYY-MM-DD when day is provided", () => {
    expect(buildDateKey(2025, 3, 5)).toBe("2025-03-05");
  });

  it("builds YYYY-MM when day is omitted", () => {
    expect(buildDateKey(2025, 12)).toBe("2025-12");
  });

  it("pads single-digit month/day", () => {
    expect(buildDateKey(2025, 1, 9)).toBe("2025-01-09");
  });
});
