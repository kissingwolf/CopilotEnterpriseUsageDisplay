const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const logger = require("./lib/logger");
const { UsageStore } = require("./lib/usage-store");
const UserMappingService = require("./lib/user-mapping");
const { initEtagCache } = require("./lib/github-api");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

/* ── Mount route modules ── */
const deps = { usageStore, teamCache, userMappingService };

app.use(require("./routes/usage")(deps));
app.use(require("./routes/billing")(deps));
app.use(require("./routes/teams")(deps));
app.use(require("./routes/costcenter")());
app.use(require("./routes/analytics")(deps));
app.use(require("./routes/user-mapping")(deps));

/* ── Health check endpoint ── */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString(),
  });
});

/* ── Wildcard fallback (SPA) ── */
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ── Global error-handling middleware ── */
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled route error");
  const status = err.statusCode || err.status || 500;
  res.status(status).json({ ok: false, message: err.message || "Internal Server Error" });
});

/* ── Start server ── */
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "Dashboard running");
});

/* ── Graceful shutdown ── */
function gracefulShutdown(signal) {
  logger.info({ signal }, "Received signal, shutting down gracefully...");

  server.close(() => {
    logger.info("HTTP server closed");
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
