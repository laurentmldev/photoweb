const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const exifr = require("exifr");
const { DATA_DIR } = require("./config");

// Root directory that holds all photo sub-directories referenced by
// gallery YAML files. Also the directory exposed statically as /photos.
const PHOTOS_ROOT = path.join(DATA_DIR, "photos");

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",
]);

// Formats exifr can actually read metadata from (SVG/GIF have no EXIF/IPTC).
const METADATA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tiff", ".heic"]);

const VALID_MODES = new Set(["slideshow", "thumbnails"]);

const DEFAULT_SLIDESHOW_INTERVAL_SECONDS = 3;

// Title/caption read from file metadata, cached per file until it
// changes (size/mtime), so a gallery of hundreds of photos isn't
// re-parsed on every page view. filePath -> { size, mtimeMs, value }
const metadataCache = new Map();

const NO_METADATA = { title: null, caption: null };

/**
 * Reads the human-written title and caption embedded in a photo's own
 * file metadata, so photographers can label images with any tool that
 * writes metadata (Lightroom, exiftool, ...) instead of editing YAML:
 *   - title:   XMP dc:title (Lightroom "Title"), IPTC "Object Name",
 *              Windows "Title" (XPTitle)
 *   - caption: EXIF "ImageDescription", XMP dc:description, IPTC
 *              "Caption-Abstract" (Lightroom "Caption")
 * Returns { title, caption }, each null when absent, when the format has
 * no metadata (SVG/GIF), or when the file can't be read.
 */
async function readEmbeddedMetadata(filePath, ext) {
  if (!METADATA_EXTENSIONS.has(ext)) return NO_METADATA;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return NO_METADATA;
  }
  const cached = metadataCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.value;
  }
  const value = await parseEmbeddedMetadata(filePath);
  metadataCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

// Metadata text comes back as a plain string, or - for XMP language
// alternatives such as dc:title / dc:description - as { lang, value } or
// an array of those. Normalizes to a trimmed string, or null.
function metadataText(v) {
  if (Array.isArray(v)) {
    const preferred = v.find((x) => x && x.lang === "x-default") || v[0];
    return metadataText(preferred);
  }
  if (v && typeof v === "object" && "value" in v) return metadataText(v.value);
  if (typeof v !== "string") return null;
  const text = v.trim();
  return text.length > 0 ? text : null;
}

function firstText(candidates) {
  for (const v of candidates) {
    const text = metadataText(v);
    if (text) return text;
  }
  return null;
}

async function parseEmbeddedMetadata(filePath) {
  try {
    const meta = await exifr.parse(filePath, { iptc: true, xmp: true, exif: true });
    if (!meta) return NO_METADATA;
    const title = firstText([meta.title, meta.ObjectName, meta.XPTitle]);
    let caption = firstText([
      meta.ImageDescription,
      meta.description,
      meta.Description,
      meta.caption,
      meta.Caption,
      meta["Caption-Abstract"],
    ]);
    // Some tools copy the title into the description too: show it once.
    if (caption && caption === title) caption = null;
    return { title, caption };
  } catch (err) {
    // Corrupt/unsupported metadata shouldn't break the gallery.
    return NO_METADATA;
  }
}

/**
 * Reusable "photo gallery" building block.
 *
 * Reads a gallery YAML config file with the shape:
 *   directory: "weddings"        # relative to photos/
 *   mode: "slideshow"            # or "thumbnails"
 *   title: "Weddings"
 *   description: "..."
 *   interval: 4                  # slideshow auto-rotate delay, in seconds (default 3)
 *   maxWidth: 1200                # optional, caps the displayed image width in px
 *   maxHeight: 800                 # optional, caps the displayed image height in px
 *
 * and returns a plain object ready to hand to a view:
 *   { title, description, mode, directory, interval, maxWidth, maxHeight,
 *     images: [{ src, alt, title, caption }, ...] }
 *
 * Each image's `title` and `caption` come from that photo file's own
 * embedded metadata (see readEmbeddedMetadata), null when absent. Its
 * `alt` text is "<title> - <caption>" (whichever exist), falling back to
 * "<gallery title> - <file name>".
 *
 * A gallery with a non-empty `password:` is private (see
 * lib/private-galleries.js): the result then has `isPrivate: true`, and
 * the password itself is never included.
 *
 * @param {string} configPath - path to the gallery YAML file, relative
 *   to DATA_DIR (e.g. "galleries/weddings.yaml") or absolute.
 * @param {object} [options]
 * @param {string} [options.urlPrefix] - URL prefix for image `src`s,
 *   default "/photos/<directory>" (the public static mount).
 */
async function loadGallery(configPath, options = {}) {
  const fullConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(DATA_DIR, configPath);

  const raw = fs.readFileSync(fullConfigPath, "utf8");
  const config = yaml.load(raw) || {};

  const { directory, mode = "thumbnails", title = "", description = "" } = config;

  if (!directory) {
    throw new Error(`Gallery config "${configPath}" is missing a "directory" field.`);
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Gallery config "${configPath}" has invalid mode "${mode}". Expected "slideshow" or "thumbnails".`
    );
  }

  const urlPrefix = options.urlPrefix || `/photos/${directory}`;
  const photosDir = path.join(PHOTOS_ROOT, directory);
  if (!fs.existsSync(photosDir) || !fs.statSync(photosDir).isDirectory()) {
    throw new Error(
      `Gallery config "${configPath}" points to a missing directory: photos/${directory}`
    );
  }

  const files = fs
    .readdirSync(photosDir)
    .filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();

  const images = await Promise.all(
    files.map(async (file) => {
      const ext = path.extname(file).toLowerCase();
      const fullPath = path.join(photosDir, file);
      const embedded = await readEmbeddedMetadata(fullPath, ext);
      const fallbackAlt = `${title || directory} - ${path.parse(file).name}`;
      return {
        // By default served by the static middleware mounted at /photos
        // (see server.js); private galleries pass their own prefix.
        src: `${urlPrefix}/${encodeURIComponent(file)}`,
        alt: [embedded.title, embedded.caption].filter(Boolean).join(" - ") || fallbackAlt,
        // Shown in the lightbox (title as a heading, caption below).
        title: embedded.title,
        caption: embedded.caption,
      };
    })
  );

  const interval =
    Number.isFinite(Number(config.interval)) && Number(config.interval) > 0
      ? Number(config.interval)
      : DEFAULT_SLIDESHOW_INTERVAL_SECONDS;

  const maxWidth = Number(config.maxWidth) > 0 ? Number(config.maxWidth) : null;
  const maxHeight = Number(config.maxHeight) > 0 ? Number(config.maxHeight) : null;

  const isPrivate = config.password != null && String(config.password) !== "";

  return { title, description, mode, directory, interval, maxWidth, maxHeight, images, isPrivate };
}

module.exports = { loadGallery, PHOTOS_ROOT, IMAGE_EXTENSIONS };
