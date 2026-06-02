require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const path = require("path");
const logger = require("./lib/logger");
const { UsageStore } = require("./lib/usage-store");
const UserMappingService = require("./lib/user-mapping");
const { initEtagCache } = require("./lib/github-api");
const { requireAdminPage } = require("./lib/auth");
const createAuthRouter = require("./routes/auth");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ── Session middleware (must be mounted before static + auth-protected routes) ── */
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === "production") {
    logger.fatal("SESSION_SECRET is required in production. Refusing to start.");
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString("hex");
  logger.warn("SESSION_SECRET not set, generated an ephemeral secret (dev only). Sessions will NOT survive restart.");
}
app.use(session({
  name: "connect.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8, /* 8 hours */
  },
}));

/* ── Admin auth routes (login / logout / session) — MUST be before static ── */
app.use(createAuthRouter());

/* ── Admin login/console page — explicit route so /admin works without .html ── */
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ── Admin page guards: protect /user /billpage /costcenter (and their .html variants)
      Must be mounted BEFORE express.static so that direct .html access is also guarded. ── */
const adminGuardedPages = [
  "/user",
  "/user.html",
  "/billpage",
  "/billpage.html",
  "/costcenter",
  "/costcenter.html",
  "/costcenter/:name",
];
app.get(adminGuardedPages, requireAdminPage, (_req, res, next) => next());

app.use(express.static(path.join(__dirname, "public")));

/* ── HTTP Access Logging Middleware ── */
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const responseTime = Date.now() - start;
    const isSuccess = res.statusCode >= 200 && res.statusCode < 400;

    logger.info({
      time: new Date().toISOString(),
      remoteAddress: req.socket?.remoteAddress || "unknown",
      remoteHostname: req.socket?.remoteHostname || "unknown",
      method: req.method,
      url: req.url,
      action: mapUrlToAction(req.url, req.method),
      success: isSuccess,
      statusCode: res.statusCode,
      responseTime,
    });
  });

  next();
});

/* ── Singletons ── */
const userMappingService = new UserMappingService();
const usageStore = new UsageStore();

const teamCache = {
  userTeamMap: {},
  seatsRaw: [],
  fetchedAt: null,
};

/* Restore persisted ETags into in-memory LRU cache */
initEtagCache(usageStore);

/* ── URL-to-Action Mapping ── */
function mapUrlToAction(url, method) {
  const routeMap = {
    "POST /api/usage/refresh": "refresh_usage",
    "GET /api/seats": "get_seats",
    "GET /api/teams": "get_teams",
    "GET /api/cost-centers": "list_cost_centers",
    "GET /api/cost-centers/": "get_cost_center_detail",
    "POST /api/cost-centers/": "add_users_to_cost_center",
    "GET /api/analytics/trends": "get_analytics_trends",
    "GET /api/analytics/top-users": "get_top_users",
    "GET /api/analytics/daily-summary": "get_daily_summary",
    "GET /api/bill": "get_monthly_bill",
    "POST /api/bill/refresh": "force_refresh_monthly_bill",
    "GET /api/health": "health_check",
    "GET /billpage": "view_bill_page",
    "POST /user/upload-members": "upload_mapping",
    "POST /user/reload-mapping": "reload_mapping",
    "GET /api/user/members": "get_user_members",
    "GET /api/user/info": "get_user_info",
    "GET /": "view_dashboard",
    "GET /user": "view_mapping_page",
    "GET /analytics": "view_analytics_page",
    "GET /costcenter": "view_costcenter_page",
  };

  for (const [key, action] of Object.entries(routeMap)) {
    const [routeMethod, routePath] = key.split(" ");
    if (method === routeMethod && url === routePath) return action;
    if (method === routeMethod && url.startsWith(routePath) && routePath.endsWith("/")) return action;
  }

  return `${method.toLowerCase()}${url}`;
}

/* ── Mount route modules ── */
const deps = { usageStore, teamCache, userMappingService };

const usageRouter = require("./routes/usage")(deps);
app.use(usageRouter);
app.use(require("./routes/billing")(deps));
app.use(require("./routes/teams")(deps));
const billModule = require("./routes/bill")({ ...deps, usageRouter });
app.use(require("./routes/costcenter")({ ...deps, getMonthlyBillTeams: billModule.getMonthlyBillTeams }));
app.use(require("./routes/analytics")(deps));
app.use(require("./routes/user-mapping")(deps));
app.use(billModule.router);

/* ── Health check endpoint ── */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString(),
  });
});

/* ── Page routes ── */
app.get("/billpage", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "billpage.html"));
});

/* ── Wildcard fallback (SPA) ── */
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ── Global error-handling middleware ── */
app.use((err, req, res, _next) => {
  logger.error({
    err: {
      message: err.message,
      stack: err.stack,
    },
    time: new Date().toISOString(),
    remoteAddress: req.socket?.remoteAddress || "unknown",
    remoteHostname: req.socket?.remoteHostname || "unknown",
    method: req.method,
    url: req.url,
    action: mapUrlToAction(req.url, req.method),
    success: false,
    statusCode: err.statusCode || err.status || 500,
  }, "Unhandled route error");

  const status = err.statusCode || err.status || 500;
  res.status(status).json({ ok: false, message: err.message || "Internal Server Error" });
});

/* ── Start server ── */
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "Dashboard running");
});

/* ── Scheduler: daily auto-refresh of recent days (enabled by default) ── */
const { startScheduler } = require("./lib/scheduler");
const scheduler = startScheduler({ forceRefreshDay: usageRouter.forceRefreshDay });

/* ── Graceful shutdown ── */
function gracefulShutdown(signal) {
  logger.info({ signal }, "Received signal, shutting down gracefully...");

  server.close(() => {
    logger.info("HTTP server closed");
    try { scheduler.stop(); } catch { /* noop */ }
    try { usageStore.close(); } catch { /* noop */ }
    try { userMappingService.close(); } catch { /* noop */ }
    logger.info("Resources released, exiting");
    process.exit(0);
  });

  /* Force exit after 10 seconds */
  setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

/* ── Catch uncaught errors ── */
process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "Uncaught exception");
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason: String(reason) }, "Unhandled rejection");
});
