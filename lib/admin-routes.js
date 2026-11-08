const path = require("path");
const express = require("express");
const multer = require("multer");

const auth = require("./admin-auth");
const store = require("./gallery-store");
const { IMAGE_EXTENSIONS } = require("./gallery");
const { createChallenge, verifyChallenge } = require("./captcha");
const { renderQuestionImage } = require("./captcha-image");

// ---------------------------------------------------------------------
// Admin mode: create / configure / delete galleries and manage their
// photos. Mounted at auth.ADMIN_PATH by server.js, only when
// an admin password is configured. Nothing on the public site links here.
// ---------------------------------------------------------------------

const MAX_UPLOAD_MB = Number(process.env.ADMIN_MAX_UPLOAD_MB) > 0 ? Number(process.env.ADMIN_MAX_UPLOAD_MB) : 50;
const MAX_UPLOAD_FILES = 200;

// Short codes in ?notice= / ?error= mapped to fixed text, so a crafted
// link can't make the admin page display arbitrary messages.
const NOTICES = {
  created: "Gallery created. You can now upload its photos.",
  saved: "Gallery settings saved.",
  deleted: "Gallery deleted.",
  uploaded: "Photos uploaded.",
  "photos-deleted": "Selected photos deleted.",
  "none-selected": "No photo selected.",
  "upload-none": "No image file was received (accepted: " + [...IMAGE_EXTENSIONS].join(" ") + ").",
  "upload-too-big": `A file is larger than the ${MAX_UPLOAD_MB} MB limit - nothing over the limit was saved.`,
  "upload-failed": "Upload failed - please try again.",
  "in-use": "This gallery is shown on a page (see \"Shown on\"), so it can't be deleted. Point that page at another gallery first.",
  "bad-request": "The form expired - please try again.",
};

function buildChallenge() {
  const challenge = createChallenge();
  return { ...challenge, imageDataUri: renderQuestionImage(challenge.a, challenge.b) };
}

function adminUrl(suffix = "") {
  return `${auth.ADMIN_PATH}${suffix}`;
}

function galleryUrl(id, suffix = "") {
  return adminUrl(`/galleries/${encodeURIComponent(id)}${suffix}`);
}

function withNotice(url, kind, code) {
  return `${url}${url.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(code)}`;
}

// ---------- Gallery form <-> YAML config ----------

function formValuesFromGallery(gallery) {
  const c = gallery ? gallery.config : {};
  return {
    name: gallery ? gallery.id : "",
    title: c.title || "",
    description: c.description || "",
    mode: c.mode || "thumbnails",
    interval: c.interval != null ? String(c.interval) : "",
    maxWidth: c.maxWidth != null ? String(c.maxWidth) : "",
    maxHeight: c.maxHeight != null ? String(c.maxHeight) : "",
    visibility: gallery && gallery.isPrivate ? "private" : "public",
    password: c.password != null ? String(c.password) : "",
    allowDownload: c.allowDownload === true,
    listed: gallery ? gallery.listed : true,
    slug: gallery && gallery.slug ? gallery.slug : gallery ? gallery.id : "",
  };
}

function formValuesFromBody(body) {
  const s = (k, max = 200) => String(body[k] == null ? "" : body[k]).trim().slice(0, max);
  return {
    name: s("name", 64).toLowerCase(),
    title: s("title"),
    description: s("description", 2000),
    mode: s("mode", 20),
    interval: s("interval", 10),
    maxWidth: s("maxWidth", 10),
    maxHeight: s("maxHeight", 10),
    visibility: s("visibility", 10) === "private" ? "private" : "public",
    password: s("password", 200),
    allowDownload: body.allowDownload === "on",
    listed: body.listed === "on",
    slug: s("slug", 64).toLowerCase(),
  };
}

/**
 * Validates form values and merges them into `baseConfig` (so keys the
 * admin doesn't edit are kept). Returns { config, errors }.
 */
function applyForm(values, baseConfig, { id, isNew, usedBy }) {
  const errors = [];
  const config = { ...baseConfig };

  if (isNew) {
    if (!store.NAME_PATTERN.test(values.name)) {
      errors.push("Name: use lowercase letters, digits, - or _ (e.g. \"smith-wedding\").");
    } else if (values.name === "new") {
      errors.push("\"new\" is reserved - please pick another name.");
    } else if (store.findGallery(values.name)) {
      errors.push(`A gallery named "${values.name}" already exists.`);
    } else if (store.directoryInUse(values.name)) {
      errors.push(`The photo folder "${values.name}" is already used by another gallery.`);
    }
    config.directory = values.name;
  }

  config.title = values.title;
  if (values.description) config.description = values.description;
  else delete config.description;

  if (values.mode !== "slideshow" && values.mode !== "thumbnails") errors.push("Display mode is invalid.");
  config.mode = values.mode;

  const positive = (label, v, key, { integer }) => {
    if (v === "") {
      delete config[key];
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
      errors.push(`${label} must be a positive ${integer ? "whole " : ""}number, or left empty.`);
      return;
    }
    config[key] = n;
  };
  positive("Slideshow interval", values.interval, "interval", { integer: false });
  positive("Max width", values.maxWidth, "maxWidth", { integer: true });
  positive("Max height", values.maxHeight, "maxHeight", { integer: true });

  if (values.visibility === "private") {
    if (values.password.length < 4) errors.push("A private gallery needs a password of at least 4 characters.");
    if (usedBy.length) {
      errors.push(`This gallery is shown on the "${usedBy.join("\", \"")}" page, so it can't be made private.`);
    }
    config.password = values.password;
    if (values.allowDownload) config.allowDownload = true;
    else delete config.allowDownload;
  } else {
    delete config.password;
    delete config.allowDownload;
    if (values.listed) {
      if (!store.NAME_PATTERN.test(values.slug)) {
        errors.push("Page address: use lowercase letters, digits, - or _.");
      } else if (store.slugTaken(values.slug, id)) {
        errors.push(`The address /galleries/${values.slug} is already used by another gallery.`);
      }
    }
  }

  if (!config.title) errors.push("Title is required.");
  return { config, errors };
}

// ---------- Router ----------

function createAdminRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.locals.adminPath = auth.ADMIN_PATH;
    res.locals.adminUrl = adminUrl;
    res.locals.galleryUrl = galleryUrl;
    res.locals.notice = NOTICES[req.query.notice] || null;
    res.locals.errorNotice = NOTICES[req.query.error] || null;
    next();
  });

  // ----- Login / logout -----

  function renderLogin(res, status, error) {
    res.status(status).render("admin/login", {
      page: { title: "Admin" },
      error,
      challenge: buildChallenge(),
    });
  }

  router.post("/login", (req, res) => {
    if (auth.isRateLimited(req.ip)) {
      renderLogin(res, 429, "Too many attempts - please try again in 15 minutes.");
      return;
    }
    const { token, answer, nonce, password } = req.body;
    if (!verifyChallenge(token, answer, nonce)) {
      auth.recordFailedAttempt(req.ip);
      renderLogin(res, 400, "The human check didn't pass - please try again.");
      return;
    }
    if (!auth.passwordMatches(password)) {
      auth.recordFailedAttempt(req.ip);
      console.warn(`[admin] failed login from ${req.ip}`);
      renderLogin(res, 401, "Wrong password.");
      return;
    }
    auth.clearFailedAttempts(req.ip);
    auth.createSession(req, res);
    res.redirect(303, adminUrl("/"));
  });

  // Everything below requires a valid session.
  router.use((req, res, next) => {
    if (auth.validSession(req)) {
      res.locals.csrfToken = auth.csrfToken(req);
      next();
      return;
    }
    if (req.method === "GET" && (req.path === "/" || req.path === "")) {
      renderLogin(res, 200, null);
      return;
    }
    res.redirect(303, adminUrl("/"));
  });

  // CSRF check for every state-changing request. Multipart uploads send
  // the token in the query string so it is checked before any file is
  // written to disk.
  router.use((req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    const given = (req.body && req.body._csrf) || req.query._csrf;
    if (!auth.csrfValid(req, given)) {
      res.status(403).send("Invalid or expired form - go back, reload the page and try again.");
      return;
    }
    next();
  });

  router.post("/logout", (req, res) => {
    auth.destroySession(req, res);
    res.redirect(303, adminUrl("/"));
  });

  // ----- Dashboard -----

  router.get("/", (req, res) => {
    res.render("admin/dashboard", { page: { title: "Admin" }, galleries: store.listGalleries() });
  });

  // ----- Create -----

  router.get("/galleries/new", (req, res) => {
    res.render("admin/gallery-form", {
      page: { title: "New gallery" },
      isNew: true,
      gallery: null,
      values: formValuesFromGallery(null),
      errors: [],
      photos: [],
    });
  });

  router.post("/galleries", (req, res, next) => {
    try {
      const values = formValuesFromBody(req.body);
      const { config, errors } = applyForm(values, {}, { id: values.name, isNew: true, usedBy: [] });
      if (errors.length) {
        res.status(400).render("admin/gallery-form", {
          page: { title: "New gallery" }, isNew: true, gallery: null, values, errors, photos: [],
        });
        return;
      }
      store.createGallery(values.name, config);
      store.setListed(values.name, values.visibility === "public" && values.listed, values.slug);
      res.redirect(303, withNotice(galleryUrl(values.name), "notice", "created"));
    } catch (err) {
      next(err);
    }
  });

  // ----- Per-gallery routes -----

  router.param("id", (req, res, next, id) => {
    const gallery = store.findGallery(id);
    if (!gallery) {
      res.status(404).render("admin/not-found", { page: { title: "Not found" } });
      return;
    }
    req.gallery = gallery;
    next();
  });

  function renderEdit(res, status, gallery, values, errors) {
    let photos = [];
    try {
      photos = gallery.config.directory ? store.listPhotos(gallery.config.directory) : [];
    } catch (err) {
      errors = errors.concat(err.message);
    }
    res.status(status).render("admin/gallery-form", {
      page: { title: gallery.config.title || gallery.id },
      isNew: false,
      gallery,
      values,
      errors,
      photos,
      maxUploadMb: MAX_UPLOAD_MB,
    });
  }

  router.get("/galleries/:id", (req, res) => {
    const errors = req.gallery.error ? [`This gallery's file has a problem: ${req.gallery.error}`] : [];
    renderEdit(res, 200, req.gallery, formValuesFromGallery(req.gallery), errors);
  });

  router.post("/galleries/:id", (req, res, next) => {
    try {
      const gallery = req.gallery;
      const values = formValuesFromBody(req.body);
      values.name = gallery.id;
      const { config, errors } = applyForm(values, gallery.config, {
        id: gallery.id,
        isNew: false,
        usedBy: gallery.usedBy,
      });
      if (errors.length) {
        renderEdit(res, 400, gallery, values, errors);
        return;
      }
      store.saveGalleryConfig(gallery.id, config);
      store.setListed(gallery.id, values.visibility === "public" && values.listed, values.slug);
      res.redirect(303, withNotice(galleryUrl(gallery.id), "notice", "saved"));
    } catch (err) {
      next(err);
    }
  });

  router.post("/galleries/:id/move", (req, res) => {
    store.moveInListing(req.gallery.id, req.body.direction === "up" ? -1 : 1);
    res.redirect(303, adminUrl("/"));
  });

  router.post("/galleries/:id/delete", (req, res, next) => {
    try {
      if (req.gallery.usedBy.length) {
        res.redirect(303, withNotice(galleryUrl(req.gallery.id), "error", "in-use"));
        return;
      }
      if (req.body.confirm !== req.gallery.id) {
        res.redirect(303, withNotice(galleryUrl(req.gallery.id), "error", "bad-request"));
        return;
      }
      store.deleteGallery(req.gallery.id, { deletePhotos: req.body.deletePhotos === "on" });
      res.redirect(303, withNotice(adminUrl("/"), "notice", "deleted"));
    } catch (err) {
      next(err);
    }
  });

  // ----- Photos -----

  // Lets the admin preview every gallery's photos, private ones included.
  router.get("/galleries/:id/photos/:file", (req, res) => {
    const file = req.params.file;
    if (!store.isImageName(file) || !req.gallery.config.directory) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(file, { root: store.photosDir(req.gallery.config.directory) }, (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        try {
          const dir = store.photosDir(req.gallery.config.directory);
          require("fs").mkdirSync(dir, { recursive: true });
          cb(null, dir);
        } catch (err) {
          cb(err);
        }
      },
      filename(req, file, cb) {
        req.reservedNames = req.reservedNames || new Set();
        const dir = store.photosDir(req.gallery.config.directory);
        // Browsers send UTF-8 names that multer decodes as latin1.
        const original = Buffer.from(file.originalname, "latin1").toString("utf8");
        cb(null, store.uniquePhotoName(dir, original, req.reservedNames));
      },
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
    fileFilter(req, file, cb) {
      cb(null, IMAGE_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));
    },
  });

  // A plain visit to the upload address (e.g. a reload) goes back to the gallery.
  router.get("/galleries/:id/photos", (req, res) => {
    res.redirect(303, galleryUrl(req.gallery.id) + "#photos");
  });

  // public/js/admin.js uploads one photo per request and asks for JSON
  // (so a large batch never hits a proxy's request size limit as a
  // whole); without JavaScript the form posts all files at once and
  // gets a redirect back to the gallery page.
  router.post("/galleries/:id/photos", (req, res) => {
    const wantsJson = (req.get("Accept") || "").includes("application/json");
    const done = (status, kind, code, saved = []) => {
      if (wantsJson) {
        res.status(status).json({ ok: kind === "notice", message: NOTICES[code], saved });
      } else {
        res.redirect(303, withNotice(galleryUrl(req.gallery.id), kind, code) + "#photos");
      }
    };
    if (!req.gallery.config.directory) {
      done(400, "error", "upload-failed");
      return;
    }
    upload.array("photos", MAX_UPLOAD_FILES)(req, res, (err) => {
      if (err) {
        // multer removes the partial file of the one that failed.
        const tooBig = err.code === "LIMIT_FILE_SIZE";
        if (!tooBig) console.error("[admin] upload failed:", err);
        done(tooBig ? 413 : 500, "error", tooBig ? "upload-too-big" : "upload-failed");
        return;
      }
      if (!req.files || req.files.length === 0) {
        done(400, "error", "upload-none");
        return;
      }
      done(200, "notice", "uploaded", req.files.map((f) => f.filename));
    });
  });

  router.post("/galleries/:id/photos/delete", (req, res, next) => {
    try {
      const raw = req.body.photo;
      const names = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (!names.length) {
        res.redirect(303, withNotice(galleryUrl(req.gallery.id), "error", "none-selected") + "#photos");
        return;
      }
      store.deletePhotos(req.gallery.config.directory, names);
      res.redirect(303, withNotice(galleryUrl(req.gallery.id), "notice", "photos-deleted") + "#photos");
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAdminRouter };
