/**
 * Admin authentication routes.
 *
 *  POST /admin/login   { user, password }   → 200 + sets session.isAdmin=true
 *  POST /admin/logout                       → destroys session
 *  GET  /admin/session                      → { authenticated: boolean }
 *
 * Exported as a router factory for symmetry with the rest of routes/*.js.
 */

const express = require("express");
const { verifyCredentials } = require("../lib/auth");

module.exports = function createAuthRouter() {
  const router = express.Router();

  router.post("/admin/login", (req, res) => {
    const user = String(req.body?.user || "");
    const password = String(req.body?.password || "");

    if (!verifyCredentials(user, password, process.env)) {
      return res.status(401).json({ ok: false, message: "Invalid credentials" });
    }

    // Regenerate the session ID on privilege escalation to thwart
    // session-fixation attacks. Falls back gracefully if the store
    // does not support regenerate().
    const finalize = () => {
      req.session.isAdmin = true;
      req.session.adminUser = user;
      res.json({ ok: true, user });
    };
    if (typeof req.session.regenerate === "function") {
      req.session.regenerate((err) => {
        if (err) return res.status(500).json({ ok: false, message: "Session error" });
        finalize();
      });
    } else {
      finalize();
    }
  });

  router.post("/admin/logout", (req, res) => {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ ok: false, message: "Logout failed" });
      res.clearCookie("connect.sid");
      res.json({ ok: true });
    });
  });

  router.get("/admin/session", (req, res) => {
    const authenticated = !!(req.session && req.session.isAdmin);
    res.json({
      authenticated,
      user: authenticated ? req.session.adminUser || null : null,
    });
  });

  return router;
};
