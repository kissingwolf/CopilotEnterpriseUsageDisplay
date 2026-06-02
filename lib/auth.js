/**
 * Admin authentication helpers.
 *
 * Pure-function core (`verifyCredentials`) makes the auth decision
 * easy to unit-test without spinning up Express or sessions.
 *
 * Express middleware below depends on req.session (provided by
 * `express-session`) so the wiring layer stays slim.
 */

const bcrypt = require("bcryptjs");

/**
 * Verify supplied admin credentials against the configured env vars.
 *
 * @param {string} user
 * @param {string} password
 * @param {{ADMIN_USER?: string, ADMIN_PASSWORD_HASH?: string}} env
 * @returns {boolean}
 */
function verifyCredentials(user, password, env = process.env) {
  const expectedUser = env.ADMIN_USER;
  const expectedHash = env.ADMIN_PASSWORD_HASH;

  // Refuse to authenticate when the deployment is not configured.
  // This prevents an empty .env from silently allowing any login.
  if (!expectedUser || !expectedHash) return false;
  if (typeof user !== "string" || typeof password !== "string") return false;
  if (user !== expectedUser) return false;
  if (password.length === 0) return false;

  try {
    return bcrypt.compareSync(password, expectedHash);
  } catch {
    return false;
  }
}

/**
 * Page guard — for HTML routes. If the visitor is not an admin,
 * redirect to the login page (with a `next` hint so we can bounce them
 * back after login). Used by `/user`, `/billpage`, `/costcenter`.
 */
function requireAdminPage(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  const next_ = encodeURIComponent(req.originalUrl || "/");
  res.redirect(302, `/admin?next=${next_}`);
}

/**
 * API guard — for JSON routes. Returns 401 instead of redirecting.
 */
function requireAdminApi(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ ok: false, message: "Admin authentication required" });
}

module.exports = {
  verifyCredentials,
  requireAdminPage,
  requireAdminApi,
};
