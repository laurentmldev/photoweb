const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const exifr = require("exifr");

// Root directory that holds all photo sub-directories referenced by
// gallery YAML files. Also the directory exposed statically as /photos.
const PHOTOS_ROOT = path.join(__dirname, "..", "photos");

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

/**
 * Tries to read a human-written caption/description embedded in a photo's
 * own file metadata (EXIF "ImageDescription", IPTC "Caption-Abstract", or
 * XMP "description"), so photographers can caption images with any tool
 * that writes metadata (Lightroom, exiftool, ...) instead of editing YAML.
 * Returns null if the file has no such tag, isn't a format exifr supports,
 * or can't be read for any reason.
 */
async function readEmbeddedDescription(filePath, ext) {
  if (!METADATA_EXTENSIONS.has(ext)) return null;
  try {
    const meta = await exifr.parse(filePath, { iptc: true, xmp: true, exif: true });
    if (!meta) return null;
    const candidates = [
      meta.ImageDescription,
      meta.description,
      meta.Description,
      meta.caption,
      meta.Caption,
      meta["Caption-Abstract"],
    ];
    const found = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
    return found ? found.trim() : null;
  } catch (err) {
    // Corrupt/unsupported metadata shouldn't break the gallery.
    return null;
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
 *     images: [{ src, alt }, ...] }
 *
 * Each image's `alt` text is taken from that photo file's own embedded
 * metadata (EXIF/IPTC/XMP description or caption) when present, and falls
 * back to "<gallery title> - <file name>" otherwise.
 *
 * @param {string} configPath - path to the gallery YAML file, relative
 *   to the project root (e.g. "galleries/weddings.yaml") or absolute.
 */
async function loadGallery(configPath) {
  const fullConfigPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(__dirname, "..", configPath);

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
      const embeddedDescription = await readEmbeddedDescription(fullPath, ext);
      const fallbackAlt = `${title || directory} - ${path.parse(file).name}`;
      return {
        // Served by the static middleware mounted at /photos (see server.js)
        src: `/photos/${directory}/${file}`,
        alt: embeddedDescription || fallbackAlt,
      };
    })
  );

  const interval =
    Number.isFinite(Number(config.interval)) && Number(config.interval) > 0
      ? Number(config.interval)
      : DEFAULT_SLIDESHOW_INTERVAL_SECONDS;

  const maxWidth = Number(config.maxWidth) > 0 ? Number(config.maxWidth) : null;
  const maxHeight = Number(config.maxHeight) > 0 ? Number(config.maxHeight) : null;

  return { title, description, mode, directory, interval, maxWidth, maxHeight, images };
}

module.exports = { loadGallery, PHOTOS_ROOT };
