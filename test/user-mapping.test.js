import { describe, it, expect } from "vitest";
const { buildMemberExcelRows } = require("../lib/helpers");

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
