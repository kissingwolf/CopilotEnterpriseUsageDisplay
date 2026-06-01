import { describe, it, expect, beforeEach, afterEach } from "vitest";

function loadGithubApi() {
  delete require.cache[require.resolve("../lib/github-api")];
  return require("../lib/github-api");
}

describe("GitHub API version", () => {
  beforeEach(() => {
    delete process.env.GITHUB_API_VERSION;
  });

  afterEach(() => {
    delete process.env.GITHUB_API_VERSION;
  });

  it("defaults to the current pinned API version", () => {
    const { getGithubApiVersion } = loadGithubApi();

    expect(getGithubApiVersion()).toBe("2026-03-10");
  });

  it("allows the API version to be configured for future GitHub releases", () => {
    process.env.GITHUB_API_VERSION = "2026-06-01";
    const { getGithubApiVersion } = loadGithubApi();

    expect(getGithubApiVersion()).toBe("2026-06-01");
  });
});
