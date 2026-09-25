const fs = require("fs");
const path = require("path");
const express = require("express");

const { DATA_DIR, SCRIPT_FALLBACK_FONT_URL, loadSiteConfig, loadYamlFile } = require("./lib/config");
const { loadGallery, PHOTOS_ROOT, IMAGE_EXTENSIONS } = require("./lib/gallery");
const privateGalleries = require("./lib/private-galleries");
const { createChallenge, verifyChallenge } = require("./lib/captcha");
const { renderQuestionImage } = require("./lib/captcha-image");

// Builds the view-ready challenge object: the signed token/difficulty
// from lib/captcha, plus the distorted question image rendered from its
// (never-exposed-as-text) a/b values.
function buildChallenge() {
  const challenge = createChallenge();
  return { ...challenge, imageDataUri: renderQuestionImage(challenge.a, challenge.b) };
}

const app = express();
const PORT = process.env.PORT || 3000;

// Behind the nginx reverse proxy (see docker-compose.yml): trust its
// X-Forwarded-* headers so req.ip / req.secure reflect the real client.
app.set("trust proxy", "loopback, uniquelocal");
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));

// Static assets
app.use("/public", express.static(path.join(__dirname, "public")));
// Private galleries' photos are never served here, only through the
// password-protected /your-photos routes below.
app.use("/photos", privateGalleries.blockPrivatePhotos, express.static(PHOTOS_ROOT));

// Make the (dynamically loaded) global site config available to every view.
app.use((req, res, next) => {
  try {
    res.locals.siteConfig = loadSiteConfig();
    res.locals.currentPath = req.path;
    res.locals.scriptFallbackFontUrl = SCRIPT_FALLBACK_FONT_URL;
  } catch (err) {
    next(err);
    return;
  }
  next();
});

// ---------------------------------------------------------------------
// Home page: a single slideshow gallery
// ---------------------------------------------------------------------
app.get("/", async (req, res, next) => {
  try {
    const home = loadYamlFile("content/home.yaml");
    const gallery = await loadGallery(home.gallery);
    res.render("home", { page: home, gallery });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Galleries page: list of galleries, one thumbnail preview per gallery.
// Read from content/galleries.yaml, or content/projects.yaml on sites
// set up before the page was renamed from "Projects".
// ---------------------------------------------------------------------
function loadGalleriesPage() {
  const current = path.join(DATA_DIR, "content", "galleries.yaml");
  return loadYamlFile(fs.existsSync(current) ? current : "content/projects.yaml");
}

app.get("/galleries", async (req, res, next) => {
  try {
    const page = loadGalleriesPage();
    const galleries = await Promise.all(
      (page.galleries || []).map(async (entry) => {
        const gallery = await loadGallery(entry.config);
        return { slug: entry.slug, ...gallery };
      })
    );
    // Private galleries are only reachable through "Your Photos".
    res.render("galleries", { page, galleries: galleries.filter((g) => !g.isPrivate) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Individual gallery page (uses the reusable gallery component in
// whichever mode - slideshow or thumbnails - its YAML file declares)
// ---------------------------------------------------------------------
app.get("/galleries/:slug", async (req, res, next) => {
  try {
    const page = loadGalleriesPage();
    const entry = (page.galleries || []).find((g) => g.slug === req.params.slug);
    if (!entry) {
      res.status(404);
      res.render("404", { page: { title: "Not found" } });
      return;
    }
    const gallery = await loadGallery(entry.config);
    if (gallery.isPrivate) {
      res.status(404);
      res.render("404", { page: { title: "Not found" } });
      return;
    }
    res.render("gallery", { page: gallery, gallery, slug: entry.slug });
  } catch (err) {
    next(err);
  }
});

// Old "Projects" URLs (bookmarks, search engines) -> the new ones.
app.get(["/projects", "/projects/*"], (req, res) => {
  const query = req.originalUrl.slice(req.path.length);
  res.redirect(301, req.path.replace(/^\/projects/, "/galleries") + query);
});

// ---------------------------------------------------------------------
// "Your Photos": customers' private galleries. A customer types the
// gallery's directory name and the password from its YAML file; a
// signed cookie then grants access to that gallery (see
// lib/private-galleries.js).
// ---------------------------------------------------------------------
const YOUR_PHOTOS_PAGE = { title: "Your Photos" };

function privateGalleryUrl(gallery) {
  return `/your-photos/${encodeURIComponent(gallery.directory)}`;
}

app.get("/your-photos", (req, res) => {
  res.render("your-photos", {
    page: YOUR_PHOTOS_PAGE,
    error: null,
    directory: "",
    challenge: buildChallenge(),
  });
});

app.post("/your-photos", (req, res) => {
  const directory = String(req.body.directory || "").trim();
  const renderError = (status, error) =>
    res.status(status).render("your-photos", {
      page: YOUR_PHOTOS_PAGE,
      error,
      directory,
      challenge: buildChallenge(),
    });

  if (privateGalleries.isRateLimited(req.ip)) {
    renderError(429, "Too many attempts - please try again in a few minutes.");
    return;
  }
  // Same self-hosted human check as the contact page, verified before
  // the password is even looked at.
  const { token, answer, nonce } = req.body;
  if (!verifyChallenge(token, answer, nonce)) {
    // Counted too: the answer is only 2-16, so otherwise a bot could
    // mine one proof of work and then simply try every answer.
    privateGalleries.recordFailedAttempt(req.ip);
    renderError(400, "That didn't check out - please try again.");
    return;
  }
  const gallery = privateGalleries.findPrivateGallery(directory);
  // Always compare a password, even for an unknown gallery, so the
  // response time doesn't reveal which gallery names exist.
  const ok = privateGalleries.passwordMatches(req.body.password, gallery ? gallery.password : "\0");
  if (!gallery || !ok) {
    privateGalleries.recordFailedAttempt(req.ip);
    // Same message either way: don't reveal which gallery names exist.
    renderError(401, "Unknown gallery name or wrong password.");
    return;
  }
  privateGalleries.grantAccess(req, res, gallery);
  res.redirect(303, privateGalleryUrl(gallery));
});

app.post("/your-photos/logout", (req, res) => {
  privateGalleries.revokeAccess(req, res);
  res.redirect(303, "/your-photos");
});

app.get("/your-photos/:directory", async (req, res, next) => {
  try {
    const gallery = privateGalleries.findPrivateGallery(req.params.directory);
    if (!gallery || !privateGalleries.hasAccess(req, gallery)) {
      res.redirect(303, "/your-photos");
      return;
    }
    const loaded = await loadGallery(gallery.configPath, {
      urlPrefix: `${privateGalleryUrl(gallery)}/photos`,
    });
    res.set("Cache-Control", "private, no-store");
    res.render("private-gallery", { page: loaded, gallery: loaded });
  } catch (err) {
    next(err);
  }
});

app.get("/your-photos/:directory/photos/:file", (req, res) => {
  const gallery = privateGalleries.findPrivateGallery(req.params.directory);
  const file = req.params.file;
  if (
    !gallery ||
    !privateGalleries.hasAccess(req, gallery) ||
    file !== path.basename(file) ||
    file.startsWith(".") ||
    !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())
  ) {
    res.sendStatus(404);
    return;
  }
  // `root` keeps sendFile from ever leaving the gallery's directory.
  res.sendFile(file, {
    root: path.join(PHOTOS_ROOT, gallery.directory),
    headers: { "Cache-Control": "private, max-age=3600" },
  }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// ---------------------------------------------------------------------
// Contact page: contact details are only shown after passing a small
// self-hosted "I'm not a robot" check (no third-party CAPTCHA service),
// to cut down on scraping/spam bots. Two layers stack here:
//   1. The question itself is a distorted, non-text image (lib/captcha-
//      image.js) rather than plain HTML text, so it resists naive
//      scraping/OCR.
//   2. Submitting an answer also requires a client-side proof-of-work
//      nonce (lib/captcha.js + public/js/captcha-pow.js), so each
//      attempt costs real CPU time - cheap for one visitor, expensive
//      to do thousands of times a minute.
// ---------------------------------------------------------------------
app.get("/contact", (req, res, next) => {
  try {
    const contact = loadYamlFile("content/contact.yaml");
    res.render("contact", { page: contact, verified: false, challenge: buildChallenge(), error: null });
  } catch (err) {
    next(err);
  }
});

app.post("/contact/verify", (req, res, next) => {
  try {
    const contact = loadYamlFile("content/contact.yaml");
    const { token, answer, nonce } = req.body;
    const ok = verifyChallenge(token, answer, nonce);
    if (ok) {
      res.render("contact", { page: contact, verified: true, challenge: null, error: null });
    } else {
      res.render("contact", {
        page: contact,
        verified: false,
        challenge: buildChallenge(),
        error: "That didn't check out - please try again.",
      });
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Generic content pages: any content/<name>.yaml that declares a
// `gallery:` is served at /<name> (hero text + that gallery), e.g.
// content/weddings.yaml -> /weddings. Lets a new top-level tab be added
// with just a YAML file and a navigation entry in config/site.yaml.
// ---------------------------------------------------------------------
const CONTENT_PAGE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_CONTENT_PAGES = new Set(["home", "galleries", "projects", "contact", "your-photos"]);

app.get("/:page", async (req, res, next) => {
  const slug = req.params.page;
  if (!CONTENT_PAGE_SLUG.test(slug) || RESERVED_CONTENT_PAGES.has(slug)) {
    next();
    return;
  }
  const relPath = path.join("content", `${slug}.yaml`);
  if (!fs.existsSync(path.join(DATA_DIR, relPath))) {
    next();
    return;
  }
  try {
    const page = loadYamlFile(relPath);
    if (!page.gallery) {
      next();
      return;
    }
    const gallery = await loadGallery(page.gallery);
    res.render("page", { page, gallery, slug });
  } catch (err) {
    next(err);
  }
});

// 404
app.use((req, res) => {
  res.status(404).render("404", { page: { title: "Not found" } });
});

// Basic error handler
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).send(`<pre>Server error: ${err.message}</pre>`);
});

app.listen(PORT, () => {
  console.log(`Photographer site running at http://localhost:${PORT}`);
});
