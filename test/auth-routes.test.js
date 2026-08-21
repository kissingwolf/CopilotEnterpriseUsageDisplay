import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";
import path from "path";

import createAuthRouter from "../routes/auth.js";
import { requireAdminPage, requireAdminMutation } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true },
    }),
  );
  app.use(createAuthRouter());
  app.use(requireAdminMutation);

  app.get("/api/example", (_req, res) => res.json({ ok: true }));
  app.post("/api/usage/refresh", (_req, res) => res.json({ ok: true }));
  app.post("/api/bill/refresh", (_req, res) => res.json({ ok: true }));

  // Wire up a guarded page so we can test the middleware end-to-end.
  app.get("/user", requireAdminPage, (req, res) => res.status(200).send("USER PAGE"));
  app.get("/billpage", requireAdminPage, (req, res) => res.status(200).send("BILL PAGE"));
  app.get("/costcenter", requireAdminPage, (req, res) => res.status(200).send("COSTCENTER PAGE"));

  // Open routes
  app.get("/", (_req, res) => res.status(200).send("HOME"));
  app.get("/admin", (_req, res) => res.status(200).send("ADMIN LOGIN PAGE"));

  return app;
}

async function withApp(run) {
  const app = buildApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function getCookie(res) {
  const raw = res.headers.get("set-cookie") || "";
  return raw.split(";")[0]; // "connect.sid=..."
}

describe("admin auth routes", () => {
  beforeEach(() => {
    process.env.ADMIN_USER = "kevin";
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("s3cret!", 4);
  });
  afterEach(() => {
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASSWORD_HASH;
  });

  it("POST /admin/login with correct credentials returns 200 and marks session as admin", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "kevin", password: "s3cret!" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Session is now authenticated — guarded page should be reachable
      const cookie = getCookie(res);
      expect(cookie).toMatch(/^connect\.sid=/);
      const r2 = await fetch(`${base}/user`, { headers: { Cookie: cookie }, redirect: "manual" });
      expect(r2.status).toBe(200);
    });
  });

  it("POST /admin/login with wrong password returns 401 and session stays unauthenticated", async () => {
    await withApp(async (base) => {
      const res = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "kevin", password: "wrong" }),
      });
      expect(res.status).toBe(401);

      const cookie = getCookie(res);
      const r2 = await fetch(`${base}/user`, {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: "manual",
      });
      expect(r2.status).toBe(302);
      expect(r2.headers.get("location")).toMatch(/^\/admin/);
    });
  });

  it("GET /admin/session reports authenticated true after login, false after logout", async () => {
    await withApp(async (base) => {
      // Pre-login → false
      const r0 = await fetch(`${base}/admin/session`);
      expect((await r0.json()).authenticated).toBe(false);

      // Login
      const login = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "kevin", password: "s3cret!" }),
      });
      const cookie = getCookie(login);

      // Now → true
      const r1 = await fetch(`${base}/admin/session`, { headers: { Cookie: cookie } });
      expect((await r1.json()).authenticated).toBe(true);

      // Logout → session cleared
      const r2 = await fetch(`${base}/admin/logout`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(r2.status).toBe(200);

      // Use the same cookie afterwards: session destroyed → false
      const cookie2 = getCookie(r2) || cookie;
      const r3 = await fetch(`${base}/admin/session`, { headers: { Cookie: cookie2 } });
      expect((await r3.json()).authenticated).toBe(false);
    });
  });
});

describe("page guard middleware", () => {
  beforeEach(() => {
    process.env.ADMIN_USER = "kevin";
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("s3cret!", 4);
  });
  afterEach(() => {
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASSWORD_HASH;
  });

  it.each(["/user", "/billpage", "/costcenter"])(
    "unauthenticated GET %s redirects (302) to /admin",
    async (route) => {
      await withApp(async (base) => {
        const res = await fetch(`${base}${route}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        const loc = res.headers.get("location") || "";
        expect(loc.startsWith("/admin")).toBe(true);
        expect(loc).toContain(`next=${encodeURIComponent(route)}`);
      });
    },
  );

  it("authenticated GET /user returns 200 with page content", async () => {
    await withApp(async (base) => {
      const login = await fetch(`${base}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "kevin", password: "s3cret!" }),
      });
      const cookie = getCookie(login);
      const res = await fetch(`${base}/user`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("USER PAGE");
    });
  });

  it("anyone can access / and /admin without authentication", async () => {
    await withApp(async (base) => {
      const home = await fetch(`${base}/`);
      expect(home.status).toBe(200);
      const admin = await fetch(`${base}/admin`);
      expect(admin.status).toBe(200);
    });
  });
});

describe("admin mutation authorization seam", () => {
  it("keeps dashboard refresh public and rejects unauthenticated admin mutations", async () => {
    await withApp(async (base) => {
      const read = await fetch(`${base}/api/example`);
      expect(read.status).toBe(200);

      const refresh = await fetch(`${base}/api/usage/refresh`, { method: "POST" });
      expect(refresh.status).toBe(200);

      const adminOperations = [
        ["POST", "/api/bill/refresh"],
        ["POST", "/api/cost-centers/123/add-users-from-teams"],
        ["POST", "/api/user-budgets"],
        ["PATCH", "/api/user-budgets/123"],
        ["DELETE", "/api/user-budgets/123"],
        ["POST", "/user/upload-members"],
        ["POST", "/user/reload-mapping"],
      ];
      for (const [method, pathname] of adminOperations) {
        const mutation = await fetch(`${base}${pathname}`, { method });
        expect(mutation.status, `${method} ${pathname}`).toBe(401);
        expect(await mutation.json()).toEqual({
          ok: false,
          message: "Admin authentication required",
        });
      }
    });
  });

  it("allows business mutations after admin login", async () => {
    process.env.ADMIN_USER = "kevin";
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("s3cret!", 4);
    try {
      await withApp(async (base) => {
        const login = await fetch(`${base}/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: "kevin", password: "s3cret!" }),
        });
        const cookie = getCookie(login);

        const mutation = await fetch(`${base}/api/bill/refresh`, {
          method: "POST",
          headers: { Cookie: cookie },
        });
        expect(mutation.status).toBe(200);
        expect(await mutation.json()).toEqual({ ok: true });
      });
    } finally {
      delete process.env.ADMIN_USER;
      delete process.env.ADMIN_PASSWORD_HASH;
    }
  });
});
