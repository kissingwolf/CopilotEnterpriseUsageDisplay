const pino = require("pino");

const isDev = process.env.NODE_ENV !== "production";

/**
 * Tiered verbosity strategy:
 *   trace  - Full request/response bodies, SQL, raw GitHub API responses
 *   debug  - Route matching, cache hit/miss, GitHub API URLs, retries
 *   info   - Access logs: time, IP, hostname, page, action, success, status, responseTime
 *   warn   - Rate limit approaching, cache expiring, non-critical recovery
 *   error  - Uncaught exceptions, GitHub API failures, DB errors, stack traces
 */
const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),

  redact: {
    paths: ["headers.authorization", "req.headers.authorization", "githubToken", "token", "password", "secret"],
    censor: "[REDACTED]",
  },

  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      remoteAddress: req.socket?.remoteAddress || "unknown",
      remoteHostname: req.socket?.remoteHostname || "unknown",
      userAgent: req.headers?.["user-agent"] || "unknown",
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err,
  },

  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:yyyy-mm-dd HH:MM:ss", ignore: "pid,hostname" } }
    : undefined,
});

module.exports = logger;
