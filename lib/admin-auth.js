const crypto = require("crypto");
const fs = require("fs");

// ---------------------------------------------------------------------
// Admin mode authentication.
//
// - Disabled unless an admin password is configured (at least
//   MIN_PASSWORD_LENGTH characters): the admin URL then simply 404s like
//   any unknown page. The password is read from the file named by
//   ADMIN_PASSWORD_FILE (e.g. a Docker secret, /run/secrets/admin_password)
//   or, failing that, from the ADMIN_PASSWORD variable.
// - Reachable only by typing its URL: nothing on the public site links
//   to it. ADMIN_PATH (default "/admin") picks that URL, so it can be
//   made harder to guess.
// - Login = password + the same self-hosted human check as the contact
//   page (lib/captcha.js), with per-IP rate limiting of failures.
// - The session is a signed cookie (no session store), scoped to
//   ADMIN_PATH, SameSite=Strict, valid SESSION_TTL_MS. The signature
//   covers a hash of the current password, so changing the password
//   signs every admin out.
// - Every state-changing request also carries a CSRF token derived from
//   the session cookie.
// ---------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 10;
/**
 * Reads the admin password once at start-up: from ADMIN_PASSWORD_FILE if
 * set (trailing newline stripped, as `echo` adds one), else from
 * ADMIN_PASSWORD. An unreadable file disables admin mode rather than
 * falling back, so a mount mistake can't silently use another password.
 */
function readPassword() {
  const file = process.env.ADMIN_PASSWORD_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    } catch (err) {
      console.error(`[admin] can't read ADMIN_PASSWORD_FILE (${file}): ${err.code || err.message} - admin mode stays disabled`);
      return "";
    }
  }
  return process.env.ADMIN_PASSWORD || "";
}

const PASSWORD = readPassword();
const SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const SESSION_COOKIE = "photo_admin";
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPTS_WINDOW_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // ip -> { count, resetAt }

function normalizeAdminPath(value) {
  const raw = String(value || "/admin").trim().replace(/\/+$/, "");
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(withSlash)) {
    console.warn(`[admin] ADMIN_PATH "${value}" is not a valid path (letters, digits, - and _ only) - using /admin`);
    return "/admin";
  }
  return withSlash;
}

const ADMIN_PATH = normalizeAdminPath(process.env.ADMIN_PATH);

function isEnabled() {
  return PASSWORD.length >= MIN_PASSWORD_LENGTH;
}

if (PASSWORD && !isEnabled()) {
  console.warn(`[admin] the admin password is shorter than ${MIN_PASSWORD_LENGTH} characters - admin mode stays disabled`);
}

function hmac(data) {
  return crypto.createHmac("sha256", SECRET).update(data).digest("hex");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function passwordMatches(given) {
  // Fixed-length digests: same timing whatever the input length.
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return isEnabled() && crypto.timingSafeEqual(a, b);
}

function passwordFingerprint() {
  return crypto.createHash("sha256").update(PASSWORD).digest("hex");
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookieOptions(req) {
  return { httpOnly: true, sameSite: "strict", secure: req.secure, path: ADMIN_PATH };
}

function createSession(req, res) {
  const expires = Date.now() + SESSION_TTL_MS;
  const value = `${expires}.${hmac(`admin\n${expires}\n${passwordFingerprint()}`)}`;
  res.cookie(SESSION_COOKIE, value, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
}

function destroySession(req, res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

/** Returns the raw session cookie value if it is valid, else null. */
function validSession(req) {
  if (!isEnabled()) return null;
  const value = readCookie(req, SESSION_COOKIE);
  if (!value) return null;
  const [expiresStr, signature] = value.split(".");
  const expires = Number(expiresStr);
  if (!signature || !Number.isFinite(expires) || expires < Date.now()) return null;
  return safeEqual(signature, hmac(`admin\n${expires}\n${passwordFingerprint()}`)) ? value : null;
}

function csrfToken(req) {
  const session = validSession(req);
  return session ? hmac(`csrf\n${session}`) : "";
}

function csrfValid(req, given) {
  const expected = csrfToken(req);
  return Boolean(expected) && safeEqual(given || "", expected);
}

function isRateLimited(ip) {
  const entry = failedAttempts.get(ip);
  return Boolean(entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILED_ATTEMPTS);
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  if (failedAttempts.size > 10000) {
    for (const [key, entry] of failedAttempts) if (entry.resetAt <= now) failedAttempts.delete(key);
  }
  const entry = failedAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    failedAttempts.set(ip, { count: 1, resetAt: now + FAILED_ATTEMPTS_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

module.exports = {
  ADMIN_PATH,
  isEnabled,
  passwordMatches,
  createSession,
  destroySession,
  validSession,
  csrfToken,
  csrfValid,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
};
