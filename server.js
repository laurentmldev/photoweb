const fs = require("fs");
const path = require("path");
const express = require("express");

const { DATA_DIR, SCRIPT_FALLBACK_FONT_URL, loadSiteConfig, loadYamlFile } = require("./lib/config");
const { loadGallery, PHOTOS_ROOT } = require("./lib/gallery");
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

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));

// Static assets
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/photos", express.static(PHOTOS_ROOT));

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
// Projects page: list of galleries, one thumbnail preview per gallery
// ---------------------------------------------------------------------
app.get("/projects", async (req, res, next) => {
  try {
    const projects = loadYamlFile("content/projects.yaml");
    const galleries = await Promise.all(
      (projects.galleries || []).map(async (entry) => {
        const gallery = await loadGallery(entry.config);
        return { slug: entry.slug, ...gallery };
      })
    );
    res.render("projects", { page: projects, galleries });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Individual project gallery page (uses the reusable gallery component
// in whichever mode - slideshow or thumbnails - its YAML file declares)
// ---------------------------------------------------------------------
app.get("/projects/:slug", async (req, res, next) => {
  try {
    const projects = loadYamlFile("content/projects.yaml");
    const entry = (projects.galleries || []).find((g) => g.slug === req.params.slug);
    if (!entry) {
      res.status(404);
      res.render("404", { page: { title: "Not found" } });
      return;
    }
    const gallery = await loadGallery(entry.config);
    res.render("gallery", { page: gallery, gallery, slug: entry.slug });
  } catch (err) {
    next(err);
  }
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
const RESERVED_CONTENT_PAGES = new Set(["home", "projects", "contact"]);

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
