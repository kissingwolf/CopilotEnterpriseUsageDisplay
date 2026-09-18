import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import ExcelJS from "exceljs";

const mocks = vi.hoisted(() => ({
  githubPostJson: vi.fn(),
  githubPatchJson: vi.fn(),
  githubGetJson: vi.fn(),
  githubDeleteJson: vi.fn(),
  invalidateCacheByPrefix: vi.fn(),
}));

async function withUserBudgetApp(run) {
  const githubApiPath = require.resolve("../lib/github-api");
  require.cache[githubApiPath] = {
    id: githubApiPath,
    filename: githubApiPath,
    loaded: true,
    exports: mocks,
  };

  delete require.cache[require.resolve("../routes/user-budget")];
  const createUserBudgetRouter = require("../routes/user-budget");
  const app = express();
  app.use(express.json());
  app.use(createUserBudgetRouter({ userMappingService: { buildLookup: () => ({ alice: { adName: "Alice Zhang" } }) } }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("POST /api/user-budgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    mocks.githubPostJson.mockResolvedValue({ message: "Budget created" });
  });

  afterEach(() => {
    delete process.env.ENTERPRISE_SLUG;
  });

  it("sends a future specific expiry date to GitHub", async () => {
    await withUserBudgetApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user-budgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: "alice",
          budgetProductSku: "ai_credits",
          budgetAmount: 30,
          expirationMode: "specific_date",
          expiresAt: "2026-10-01",
        }),
      });

      expect(response.status).toBe(200);
    });

    expect(mocks.githubPostJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/budgets",
      expect.objectContaining({ expires_at: "2026-10-01" })
    );
  });

  it("uses the first day of the next UTC month for the next billing cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
    try {
      await withUserBudgetApp(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/user-budgets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: "alice",
            budgetProductSku: "ai_credits",
            budgetAmount: 30,
            expirationMode: "next_billing_cycle",
          }),
        });

        expect(response.status).toBe(200);
      });
      expect(mocks.githubPostJson).toHaveBeenCalledWith(
        "/enterprises/acme/settings/billing/budgets",
        expect.objectContaining({ expires_at: "2026-10-01" })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PATCH /api/user-budgets/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    mocks.githubPatchJson.mockResolvedValue({ message: "Budget updated" });
  });

  afterEach(() => {
    delete process.env.ENTERPRISE_SLUG;
  });

  it("clears an existing expiry date when the budget is set to never expire", async () => {
    await withUserBudgetApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user-budgets/budget-1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expirationMode: "never" }),
      });

      expect(response.status).toBe(200);
    });

    expect(mocks.githubPatchJson).toHaveBeenCalledWith(
      "/enterprises/acme/settings/billing/budgets/budget-1",
      expect.objectContaining({ expires_at: null, prevent_further_usage: true })
    );
  });
});

describe("GET /api/user-budgets/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENTERPRISE_SLUG = "acme";
    mocks.githubGetJson.mockResolvedValue({
      budgets: [{
        id: "budget-1",
        user: "alice",
        budget_scope: "user",
        budget_product_sku: "ai_credits",
        budget_amount: 30,
        expires_at: "2026-10-01",
      }],
      has_next_page: false,
    });
  });

  afterEach(() => {
    delete process.env.ENTERPRISE_SLUG;
  });

  it("exports the requested User Budget columns as an Excel workbook", async () => {
    await withUserBudgetApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user-budgets/export`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await response.arrayBuffer());
      const worksheet = workbook.getWorksheet("User Budgets");
      expect(worksheet.getRow(1).values.slice(1)).toEqual(["GitHub 登录", "AD 名称", "SKU", "预算", "预算周期"]);
      expect(worksheet.getRow(2).values.slice(1)).toEqual(["alice", "Alice Zhang", "ai_credits", 30, "在指定日期过期（UTC）：2026-10-01"]);
    });
  });
});