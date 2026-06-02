import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { verifyCredentials } from "../lib/auth.js";

describe("verifyCredentials", () => {
  const hash = bcrypt.hashSync("s3cret!", 4); // small cost for fast tests
  const env = { ADMIN_USER: "kevin", ADMIN_PASSWORD_HASH: hash };

  it("returns true when username and password match", () => {
    expect(verifyCredentials("kevin", "s3cret!", env)).toBe(true);
  });

  it("returns false when password is wrong", () => {
    expect(verifyCredentials("kevin", "wrong", env)).toBe(false);
  });

  it("returns false when ADMIN_PASSWORD_HASH is missing (no empty-config bypass)", () => {
    expect(verifyCredentials("kevin", "anything", { ADMIN_USER: "kevin" })).toBe(false);
    expect(verifyCredentials("kevin", "", { ADMIN_USER: "kevin", ADMIN_PASSWORD_HASH: "" })).toBe(false);
  });
});
