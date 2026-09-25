const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { DATA_DIR } = require("./config");

// ---------------------------------------------------------------------
// Private ("Your Photos") galleries.
//
// Any gallery YAML file under galleries/ that sets a non-empty
// `password:` is private: it is never listed publicly, its photos are
// not served from the public /photos URL, and a customer reaches it at
// /your-photos by typing its `directory` name plus that password.
//
// Access is remembered with a signed cookie (no session store). The
// signature covers the directory, an expiry time and a hash of the
// current password, so changing a gallery's password in its YAML file
// immediately revokes every cookie issued for the old one.
// ---------------------------------------------------------------------

const GALLERIES_DIR = path.join(DATA_DIR, "galleries");

// Generated once at process start unless pinned: a restart just means
// customers have to type their password again.
const SECRET = process.env.GALLERY_ACCESS_SECRET || crypto.randomBytes(32).toString("hex");

const ACCESS_COOKIE = "your_photos";
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Brute-force protection for the password form: at most this many
// failed attempts per client IP within the window.
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_ATTEMPTS_WINDOW_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // ip -> { count, resetAt }

function isPrivate(config) {
  return config.password != null && String(config.password) !== "";
}

/**
 * Reads every private gallery config, fresh from disk (like every other
 * YAML file on the site, so edits apply without a restart).
 * Returns [{ configPath, directory, password }].
 */
function listPrivateGalleries() {
  if (!fs.existsSync(GALLERIES_DIR)) return [];
  return fs
    .readdirSync(GALLERIES_DIR)
    .filter((file) => /\.ya?ml$/i.test(file))
    .map((file) => {
      const configPath = path.join("galleries", file);
      try {
        const config = yaml.load(fs.readFileSync(path.join(DATA_DIR, configPath), "utf8")) || {};
        return { configPath, config };
      } catch (err) {
        return null; // a broken file must not take the whole feature down
      }
    })
    .filter((entry) => entry && entry.config.directory && isPrivate(entry.config))
    .map(({ configPath, config }) => ({
      configPath,
      directory: String(config.directory),
      password: String(config.password),
    }));
}

// Customers type the directory name, so match it case-insensitively.
function findPrivateGallery(directory) {
  const wanted = String(directory || "").trim().toLowerCase();
  if (!wanted) return null;
  return listPrivateGalleries().find((g) => g.directory.toLowerCase() === wanted) || null;
}

/**
 * Express middleware for the public /photos static mount: refuses any
 * path that resolves into a private gallery's directory, so those photos
 * are only reachable through the authenticated /your-photos routes.
 */
function blockPrivatePhotos(req, res, next) {
  let relative;
  try {
    relative = path.posix.normalize(decodeURIComponent(req.path)).replace(/^\/+/, "");
  } catch (err) {
    res.sendStatus(400);
    return;
  }
  // Lower-cased so it also holds on case-insensitive filesystems.
  const requested = `${relative.toLowerCase()}/`;
  const isPrivateDir = listPrivateGalleries().some((g) => {
    const dir = path.posix.normalize(g.directory).replace(/^\/+|\/+$/g, "").toLowerCase();
    return requested.startsWith(`${dir}/`);
  });
  if (isPrivateDir) {
    res.sendStatus(404);
    return;
  }
  next();
}

function passwordMatches(given, expected) {
  // Compare fixed-length digests so the check takes the same time
  // whatever the input.
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(directory, expires, password) {
  const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${directory}\n${expires}\n${passwordHash}`)
    .digest("hex");
}

function createAccessCookieValue(gallery) {
  const expires = Date.now() + ACCESS_TTL_MS;
  const dir = Buffer.from(gallery.directory).toString("base64url");
  return `${dir}.${expires}.${sign(gallery.directory, expires, gallery.password)}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True if the request carries a valid, unexpired cookie for `gallery`. */
function hasAccess(req, gallery) {
  const value = readCookie(req, ACCESS_COOKIE);
  if (!value) return false;
  const [dir, expiresStr, signature] = value.split(".");
  if (!dir || !expiresStr || !signature) return false;
  if (Buffer.from(dir, "base64url").toString() !== gallery.directory) return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = Buffer.from(sign(gallery.directory, expires, gallery.password));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/your-photos",
  };
}

function grantAccess(req, res, gallery) {
  res.cookie(ACCESS_COOKIE, createAccessCookieValue(gallery), {
    ...cookieOptions(req),
    maxAge: ACCESS_TTL_MS,
  });
}

function revokeAccess(req, res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions(req));
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

module.exports = {
  isPrivate,
  findPrivateGallery,
  blockPrivatePhotos,
  passwordMatches,
  hasAccess,
  grantAccess,
  revokeAccess,
  isRateLimited,
  recordFailedAttempt,
};
