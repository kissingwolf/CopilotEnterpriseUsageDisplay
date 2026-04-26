import { describe, it, expect } from "vitest";
const { toNumber, pickUser } = require("../lib/helpers");

describe("toNumber", () => {
  it("returns the number for a number input", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-3.14)).toBe(-3.14);
  });

  it("parses numeric strings", () => {
    expect(toNumber("100")).toBe(100);
    expect(toNumber("3.14")).toBe(3.14);
    expect(toNumber("  42  ")).toBe(42);
  });

  it("returns 0 for non-numeric strings", () => {
    expect(toNumber("abc")).toBe(0);
    expect(toNumber("")).toBe(0);
    expect(toNumber("  ")).toBe(0);
  });

  it("returns 0 for null / undefined / NaN", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(NaN)).toBe(0);
    expect(toNumber(Infinity)).toBe(0);
  });
});

describe("pickUser", () => {
  it("picks user from .user field", () => {
    expect(pickUser({ user: "alice" })).toBe("alice");
  });

  it("picks from .login field", () => {
    expect(pickUser({ login: "bob" })).toBe("bob");
  });

  it("picks from .username field", () => {
    expect(pickUser({ username: "charlie" })).toBe("charlie");
  });

  it("picks from nested object with .login", () => {
    expect(pickUser({ user: { login: "dave" } })).toBe("dave");
  });

  it("picks from nested object with .name", () => {
    expect(pickUser({ user: { name: "eve" } })).toBe("eve");
  });

  it("returns (unknown) when no field matches", () => {
    expect(pickUser({})).toBe("(unknown)");
    expect(pickUser({ foo: "bar" })).toBe("(unknown)");
  });

  it("skips empty strings", () => {
    expect(pickUser({ user: "", login: "frank" })).toBe("frank");
    expect(pickUser({ user: "  ", login: "grace" })).toBe("grace");
  });

  it("prioritizes user over login", () => {
    expect(pickUser({ user: "first", login: "second" })).toBe("first");
  });
});
