import { describe, it, expect } from "vitest";
const { buildMemberExcelRows, classifyUserActivity } = require("../lib/helpers");

describe("buildMemberExcelRows", () => {
  const HEADERS = [
    "Github 用户名",
    "Team",
    "AD 用户名",
    "AD 邮箱",
    "计划",
    "最后活跃",
    "映射状态",
  ];

  it("first row is the 7-column header", () => {
    const rows = buildMemberExcelRows([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(HEADERS);
  });

  it("maps a fully-populated member to correct columns", () => {
    const member = {
      login: "alice",
      team: "TeamA",
      adName: "Alice Li",
      adMail: "alice@corp.com",
      planType: "enterprise",
      lastActivityAt: "2026-05-01T10:00:00Z",
    };
    const rows = buildMemberExcelRows([member]);
    expect(rows).toHaveLength(2);
    const data = rows[1];
    expect(data[0]).toBe("alice");
    expect(data[1]).toBe("TeamA");
    expect(data[2]).toBe("Alice Li");
    expect(data[3]).toBe("alice@corp.com");
    expect(data[4]).toBe("enterprise");
    // lastActivityAt 格式化后应含日期字符
    expect(typeof data[5]).toBe("string");
    expect(data[5]).not.toBe("--");
    expect(data[6]).toBe("已映射");
  });

  it("fills null/undefined fields with '--'", () => {
    const member = {
      login: "bob",
      team: null,
      adName: null,
      adMail: null,
      planType: null,
      lastActivityAt: null,
    };
    const rows = buildMemberExcelRows([member]);
    const data = rows[1];
    expect(data[0]).toBe("bob");
    expect(data[1]).toBe("--");
    expect(data[2]).toBe("--");
    expect(data[3]).toBe("--");
    expect(data[4]).toBe("--");
    expect(data[5]).toBe("--");
    expect(data[6]).toBe("未映射");
  });

  it("marks member as '未映射' when adName is empty string", () => {
    const member = { login: "carol", team: "T", adName: "", adMail: "", planType: "business", lastActivityAt: null };
    const rows = buildMemberExcelRows([member]);
    expect(rows[1][6]).toBe("未映射");
    expect(rows[1][2]).toBe("--");
  });

  it("handles multiple members producing header + N data rows", () => {
    const members = [
      { login: "u1", team: "A", adName: "U1 Name", adMail: "u1@x.com", planType: "enterprise", lastActivityAt: null },
      { login: "u2", team: "B", adName: null, adMail: null, planType: "business", lastActivityAt: null },
    ];
    const rows = buildMemberExcelRows(members);
    expect(rows).toHaveLength(3);
    expect(rows[1][6]).toBe("已映射");
    expect(rows[2][6]).toBe("未映射");
  });
});

describe("classifyUserActivity", () => {
  // Fixed reference: 2026-05-11T00:00:00Z
  const NOW = new Date("2026-05-11T00:00:00Z").getTime();

  function makeMembers(overrides) {
    return overrides.map((o) => ({
      login: o.login || "userA",
      team: o.team || "TeamA",
      adName: o.adName ?? null,
      lastActivityAt: o.lastActivityAt ?? null,
    }));
  }

  it("returns 4 empty buckets for empty input", () => {
    const result = classifyUserActivity([], NOW);
    expect(result["1~5日不活跃"]).toEqual([]);
    expect(result["6~10日不活跃"]).toEqual([]);
    expect(result["10日以上不活跃"]).toEqual([]);
    expect(result["注册后未活跃"]).toEqual([]);
  });

  it("classifies null lastActivityAt as '注册后未活跃'", () => {
    const members = makeMembers([{ login: "u1", adName: null, lastActivityAt: null }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["注册后未活跃"]).toHaveLength(1);
    expect(result["注册后未活跃"][0].displayName).toBe("u1");
  });

  it("uses adName as displayName when mapped", () => {
    const members = makeMembers([{ login: "u1", adName: "Alice Li", lastActivityAt: null }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["注册后未活跃"][0].displayName).toBe("Alice Li");
  });

  it("classifies daysInactive=0 (today active) as '1~5日不活跃'", () => {
    const members = makeMembers([{ login: "u2", lastActivityAt: "2026-05-11T00:00:00Z" }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["1~5日不活跃"]).toHaveLength(1);
  });

  it("classifies daysInactive=5 as '1~5日不活跃'", () => {
    const members = makeMembers([{ login: "u3", lastActivityAt: "2026-05-06T00:00:00Z" }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["1~5日不活跃"]).toHaveLength(1);
  });

  it("classifies daysInactive=6 as '6~10日不活跃'", () => {
    const members = makeMembers([{ login: "u4", lastActivityAt: "2026-05-05T00:00:00Z" }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["6~10日不活跃"]).toHaveLength(1);
  });

  it("classifies daysInactive=10 as '6~10日不活跃'", () => {
    const members = makeMembers([{ login: "u5", lastActivityAt: "2026-05-01T00:00:00Z" }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["6~10日不活跃"]).toHaveLength(1);
  });

  it("classifies daysInactive=11 as '10日以上不活跃'", () => {
    const members = makeMembers([{ login: "u6", lastActivityAt: "2026-04-30T00:00:00Z" }]);
    const result = classifyUserActivity(members, NOW);
    expect(result["10日以上不活跃"]).toHaveLength(1);
  });

  it("each bucket entry has displayName, team, lastActivityAt fields", () => {
    const members = makeMembers([{ login: "u7", team: "TeamX", adName: "X Li", lastActivityAt: "2026-05-09T12:00:00Z" }]);
    const result = classifyUserActivity(members, NOW);
    const entry = result["1~5日不活跃"][0];
    expect(entry).toHaveProperty("displayName", "X Li");
    expect(entry).toHaveProperty("team", "TeamX");
    expect(entry).toHaveProperty("lastActivityAt", "2026-05-09T12:00:00Z");
  });

  it("correctly distributes multiple members across buckets", () => {
    const members = makeMembers([
      { login: "a", lastActivityAt: "2026-05-11T00:00:00Z" }, // 0 days → 1~5
      { login: "b", lastActivityAt: "2026-05-06T00:00:00Z" }, // 5 days → 1~5
      { login: "c", lastActivityAt: "2026-05-05T00:00:00Z" }, // 6 days → 6~10
      { login: "d", lastActivityAt: "2026-05-01T00:00:00Z" }, // 10 days → 6~10
      { login: "e", lastActivityAt: "2026-04-30T00:00:00Z" }, // 11 days → 10+
      { login: "f", lastActivityAt: null },                   // null → 注册后未活跃
    ]);
    const result = classifyUserActivity(members, NOW);
    expect(result["1~5日不活跃"]).toHaveLength(2);
    expect(result["6~10日不活跃"]).toHaveLength(2);
    expect(result["10日以上不活跃"]).toHaveLength(1);
    expect(result["注册后未活跃"]).toHaveLength(1);
  });
});
