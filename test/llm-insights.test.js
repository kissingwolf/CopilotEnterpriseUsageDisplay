import { describe, expect, it } from "vitest";

const {
  mergeInsights,
  isLlmConfigured,
  __testables: { extractJsonArray, sanitizeRecommendations },
} = require("../lib/llm-insights");

describe("extractJsonArray", () => {
  it("parses a bare JSON array", () => {
    expect(extractJsonArray('[{"title":"a"}]')).toEqual([{ title: "a" }]);
  });

  it("strips ```json code fences", () => {
    const text = "```json\n[{\"title\":\"a\"}]\n```";
    expect(extractJsonArray(text)).toEqual([{ title: "a" }]);
  });

  it("returns [] when no array present", () => {
    expect(extractJsonArray("no json here")).toEqual([]);
  });
});

describe("sanitizeRecommendations", () => {
  it("normalizes invalid severity to low and tags source llm", () => {
    const out = sanitizeRecommendations([{ title: "x", severity: "critical" }]);
    expect(out[0].severity).toBe("low");
    expect(out[0].source).toBe("llm");
  });

  it("drops empty entries and caps to 6", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}` }));
    items.push({});
    expect(sanitizeRecommendations(items)).toHaveLength(6);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeRecommendations(null)).toEqual([]);
  });
});

describe("mergeInsights", () => {
  it("puts llm first, tags rule source, and sorts by severity", () => {
    const rule = [{ title: "r", severity: "high" }];
    const llm = [{ title: "l", severity: "low", source: "llm" }];
    const merged = mergeInsights(rule, llm);
    expect(merged.map((i) => i.severity)).toEqual(["high", "low"]);
    expect(merged.find((i) => i.title === "r").source).toBe("rule");
  });
});

describe("isLlmConfigured", () => {
  it("is false when disabled", () => {
    expect(isLlmConfigured({ enabled: false, url: "u", apiKey: "k", model: "m" })).toBe(false);
  });

  it("is false when any field missing", () => {
    expect(isLlmConfigured({ enabled: true, url: "", apiKey: "k", model: "m" })).toBe(false);
  });

  it("is true when fully configured", () => {
    expect(isLlmConfigured({ enabled: true, url: "u", apiKey: "k", model: "m" })).toBe(true);
  });
});
