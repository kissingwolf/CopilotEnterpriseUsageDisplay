import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { UsageStore } = require("../lib/usage-store");

describe("UsageStore billing period snapshots", () => {
  it("restores previous rows and removes rows added after the snapshot", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-usage-store-"));
    const store = new UsageStore(dataDir);
    try {
      store.saveDay(
        "2025-04-01", 2025, 4, 1, { usageItems: [] }, "direct", 1,
        "enterprise:acme|premium_request", "2025-04-02T00:00:00.000Z",
        [{ user: "alice", requests: 10 }]
      );
      const snapshot = store.getDaysInRange("2025-04-01", "2025-04-30");

      store.saveDay(
        "2025-04-01", 2025, 4, 1, { usageItems: [] }, "direct", 1,
        "enterprise:acme|premium_request", "2025-04-03T00:00:00.000Z",
        [{ user: "alice", requests: 999 }]
      );
      store.saveDay(
        "2025-04-02", 2025, 4, 2, { usageItems: [] }, "direct", 1,
        "enterprise:acme|premium_request", "2025-04-03T00:00:00.000Z",
        [{ user: "alice", requests: 20 }]
      );

      store.restoreDaysInRange("2025-04-01", "2025-04-30", snapshot);

      expect(store.getDay("2025-04-01").ranking[0].requests).toBe(10);
      expect(store.getDay("2025-04-02")).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});