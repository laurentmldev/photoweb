const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

// ---------------------------------------------------------------------
// Visit and download statistics, shown in the admin mode's Stats tab.
//
// Privacy-friendly by design - no cookie, no third-party service, no IP
// address stored:
//   - a visitor is recognised within one day by a hash of a random daily
//     salt + IP + User-Agent. The salt is replaced every day, so the same
//     person can't be followed from one day to the next, and the hash
//     can't be turned back into an IP;
//   - once a day is over only its counts are kept: unique visitors and
//     page views, globally and per page, and zip downloads per gallery;
//   - obvious bots (crawlers, link previews, scripts) are not counted.
//
// Everything lives in <DATA_DIR>/stats/: stats.json (daily counts, about
// 400 days kept, plus all-time download totals) and today.json (today's
// salt and visitor hashes, so a restart doesn't count people twice).
// Written every 30 s when something changed, and on shutdown.
// ---------------------------------------------------------------------

const STATS_DIR = path.join(DATA_DIR, "stats");
const STATS_FILE = path.join(STATS_DIR, "stats.json");
const TODAY_FILE = path.join(STATS_DIR, "today.json");
const KEEP_DAYS = 400;
const FLUSH_INTERVAL_MS = 30 * 1000;
const TIMEZONE = process.env.STATS_TIMEZONE || "Europe/Paris";

const BOT_PATTERN =
  /bot|crawl|spider|slurp|preview|fetch|monitor|scan|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|phantom|lighthouse|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;

let dateFormat;
try {
  dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
} catch (err) {
  console.warn(`[stats] unknown STATS_TIMEZONE "${TIMEZONE}" - using UTC`);
  dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
}

/** "YYYY-MM-DD" in the stats time zone. */
function dayOf(date = new Date()) {
  return dateFormat.format(date);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[stats] can't read ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ---------- State ----------

// stats.json: { firstDay, days: { "YYYY-MM-DD": Day }, downloadsAllTime: { key: n } }
// Day = { visitors, views, pages: { key: { visitors, views } }, downloads: { key: n } }
let stats = readJson(STATS_FILE, null) || { firstDay: null, days: {}, downloadsAllTime: {} };
stats.days = stats.days || {};
stats.downloadsAllTime = stats.downloadsAllTime || {};

// today.json, in memory with Sets: { day, salt, visitors: Set, pages: { key: { visitors: Set, views } }, views, downloads }
let dirty = false;
let today = loadToday();

function newToday(day) {
  return { day, salt: crypto.randomBytes(16).toString("hex"), visitors: new Set(), pages: {}, views: 0, downloads: {} };
}

function loadToday() {
  const saved = readJson(TODAY_FILE, null);
  if (!saved || !saved.day || !saved.salt) return newToday(dayOf());
  const pages = {};
  for (const [key, p] of Object.entries(saved.pages || {})) {
    pages[key] = { visitors: new Set(p.visitors || []), views: p.views || 0 };
  }
  const restored = {
    day: saved.day,
    salt: saved.salt,
    visitors: new Set(saved.visitors || []),
    pages,
    views: saved.views || 0,
    downloads: saved.downloads || {},
  };
  // Saved on an earlier day (server was down at midnight): close it now.
  if (restored.day !== dayOf()) {
    closeDay(restored);
    return newToday(dayOf());
  }
  return restored;
}

/** Moves a finished day into the daily counts (no hashes kept) and prunes old days. */
function closeDay(t) {
  const pages = {};
  for (const [key, p] of Object.entries(t.pages)) pages[key] = { visitors: p.visitors.size, views: p.views };
  if (t.views > 0 || Object.keys(t.downloads).length > 0) {
    stats.days[t.day] = { visitors: t.visitors.size, views: t.views, pages, downloads: t.downloads };
    if (!stats.firstDay || t.day < stats.firstDay) stats.firstDay = t.day;
  }
  const cutoff = dayOf(new Date(Date.now() - KEEP_DAYS * 86400000));
  for (const day of Object.keys(stats.days)) if (day < cutoff) delete stats.days[day];
  dirty = true;
}

function rollOver() {
  const now = dayOf();
  if (today.day !== now) {
    closeDay(today);
    today = newToday(now);
  }
}

function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(STATS_DIR, { recursive: true });
    writeJson(STATS_FILE, stats);
    const pages = {};
    for (const [key, p] of Object.entries(today.pages)) pages[key] = { visitors: [...p.visitors], views: p.views };
    writeJson(TODAY_FILE, {
      day: today.day,
      salt: today.salt,
      visitors: [...today.visitors],
      pages,
      views: today.views,
      downloads: today.downloads,
    });
    dirty = false;
  } catch (err) {
    console.error(`[stats] can't save statistics in ${STATS_DIR}: ${err.message}`);
  }
}

setInterval(() => {
  rollOver();
  flush();
}, FLUSH_INTERVAL_MS).unref();

// ---------- Recording ----------

function isBot(req) {
  const ua = req.get("User-Agent") || "";
  return !ua || BOT_PATTERN.test(ua) || req.get("Purpose") === "prefetch" || req.get("Sec-Purpose") === "prefetch";
}

/** Counts one page view of `pageKey` (e.g. "/galleries/weddings"). */
function recordView(req, pageKey) {
  if (req.method !== "GET" || isBot(req)) return;
  rollOver();
  const visitor = crypto
    .createHash("sha256")
    .update(`${today.salt}\n${req.ip}\n${req.get("User-Agent")}`)
    .digest("hex")
    .slice(0, 16);
  today.visitors.add(visitor);
  today.views++;
  const page = today.pages[pageKey] || (today.pages[pageKey] = { visitors: new Set(), views: 0 });
  page.visitors.add(visitor);
  page.views++;
  dirty = true;
}

/** Counts one zip download of a private gallery (key: its directory). */
function recordDownload(req, galleryKey) {
  if (isBot(req)) return;
  rollOver();
  today.downloads[galleryKey] = (today.downloads[galleryKey] || 0) + 1;
  stats.downloadsAllTime[galleryKey] = (stats.downloadsAllTime[galleryKey] || 0) + 1;
  if (!stats.firstDay) stats.firstDay = today.day;
  dirty = true;
}

// ---------- Reporting ----------

const PERIODS = [
  { key: "week", label: "Past week", days: 7 },
  { key: "month", label: "Past month", days: 30 },
  { key: "year", label: "Past year", days: 365 },
];

/** Today's counts, in the same shape as a closed day. */
function todayAsDay() {
  const pages = {};
  for (const [key, p] of Object.entries(today.pages)) pages[key] = { visitors: p.visitors.size, views: p.views };
  return { visitors: today.visitors.size, views: today.views, pages, downloads: today.downloads };
}

function lastDays(n) {
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(dayOf(new Date(now - i * 86400000)));
  return [...new Set(out)];
}

/**
 * Everything the Stats tab shows. For each period (last 7 / 30 / 365
 * days, today included): average daily unique visitors and total page
 * views, globally and per page; zip downloads per gallery. Averages are
 * over the days since counting started when that's shorter than the
 * period, so a new site isn't diluted by days with no data.
 */
function summary() {
  rollOver();
  const todayKey = today.day;
  const dayData = (d) => (d === todayKey ? todayAsDay() : stats.days[d]);
  const firstDay = stats.firstDay && stats.firstDay < todayKey ? stats.firstDay : todayKey;

  const periods = PERIODS.map((p) => {
    const days = lastDays(p.days).filter((d) => d >= firstDay);
    const n = Math.max(days.length, 1);
    const global = { visitors: 0, views: 0, downloads: 0 };
    const pages = {};
    const downloads = {};
    for (const d of days) {
      const data = dayData(d);
      if (!data) continue;
      global.visitors += data.visitors;
      global.views += data.views;
      for (const [key, pg] of Object.entries(data.pages || {})) {
        const acc = pages[key] || (pages[key] = { visitors: 0, views: 0 });
        acc.visitors += pg.visitors;
        acc.views += pg.views;
      }
      for (const [key, count] of Object.entries(data.downloads || {})) {
        downloads[key] = (downloads[key] || 0) + count;
        global.downloads += count;
      }
    }
    const avg = (v) => v / n;
    return {
      ...p,
      daysCounted: n,
      avgVisitors: avg(global.visitors),
      views: global.views,
      downloads: global.downloads,
      pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, { avgVisitors: avg(v.visitors), views: v.views }])),
      downloadsByGallery: downloads,
    };
  });

  const daily = lastDays(30).map((d) => {
    const data = d >= firstDay ? dayData(d) : null;
    return { day: d, visitors: data ? data.visitors : 0, views: data ? data.views : 0 };
  });

  const downloadsAllTime = Object.values(stats.downloadsAllTime).reduce((a, b) => a + b, 0);

  return {
    firstDay: stats.firstDay || todayKey,
    timezone: TIMEZONE,
    periods,
    daily,
    downloadsAllTime,
    downloadsAllTimeByGallery: { ...stats.downloadsAllTime },
    visitorsToday: today.visitors.size,
  };
}

module.exports = { recordView, recordDownload, summary, flush, isBot };
