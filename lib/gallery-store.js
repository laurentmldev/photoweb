const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { DATA_DIR } = require("./config");
const { PHOTOS_ROOT, IMAGE_EXTENSIONS } = require("./gallery");

// ---------------------------------------------------------------------
// Read/write access to the gallery files, used by the admin mode.
//
// A gallery is identified by its YAML file name ("id"): galleries/<id>.yaml.
// Galleries created from the admin use the same name for the id, the
// photos/ sub-directory and (for public ones) the /galleries/<slug> URL.
// Edits rewrite the YAML file with js-yaml, so comments in an edited file
// are not kept; keys the admin doesn't know about are preserved.
// ---------------------------------------------------------------------

const GALLERIES_DIR = path.join(DATA_DIR, "galleries");
const CONTENT_DIR = path.join(DATA_DIR, "content");
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8")) || {};
}

// Write to a temp file then rename, so a crash never leaves half a file.
function writeYaml(file, data, header) {
  const text = (header || "") + yaml.dump(data, { lineWidth: 100, noRefs: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function configPathFor(id) {
  return `galleries/${id}.yaml`;
}

// ---------- Galleries page listing (content/galleries.yaml) ----------

function listingFile() {
  const current = path.join(CONTENT_DIR, "galleries.yaml");
  const legacy = path.join(CONTENT_DIR, "projects.yaml");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

function readListing() {
  const file = listingFile();
  const page = fs.existsSync(file) ? readYaml(file) : { title: "Galleries" };
  if (!Array.isArray(page.galleries)) page.galleries = [];
  return page;
}

function writeListing(page) {
  writeYaml(listingFile(), page);
}

function sameConfig(a, b) {
  return path.posix.normalize(String(a || "")) === path.posix.normalize(b);
}

function listingEntry(page, id) {
  return page.galleries.find((g) => sameConfig(g.config, configPathFor(id))) || null;
}

/** Adds/updates (listed=true) or removes (listed=false) a gallery on the Galleries page. */
function setListed(id, listed, slug) {
  const page = readListing();
  const entry = listingEntry(page, id);
  if (listed) {
    if (entry) entry.slug = slug;
    else page.galleries.push({ slug, config: configPathFor(id) });
  } else if (entry) {
    page.galleries = page.galleries.filter((g) => g !== entry);
  } else {
    return;
  }
  writeListing(page);
}

function slugTaken(slug, exceptId) {
  return readListing().galleries.some(
    (g) => g.slug === slug && !sameConfig(g.config, configPathFor(exceptId))
  );
}

/** Moves a listed gallery one place up (-1) or down (+1) on the Galleries page. */
function moveInListing(id, delta) {
  const page = readListing();
  const from = page.galleries.findIndex((g) => sameConfig(g.config, configPathFor(id)));
  const to = from + delta;
  if (from === -1 || to < 0 || to >= page.galleries.length) return;
  const [entry] = page.galleries.splice(from, 1);
  page.galleries.splice(to, 0, entry);
  writeListing(page);
}

// ---------- Pages showing a gallery (home.yaml, other content pages) ----------

/** Content pages whose `gallery:` points at this gallery, e.g. ["home"]. */
function pagesUsing(id) {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => /\.ya?ml$/i.test(f))
    .filter((f) => {
      try {
        return sameConfig(readYaml(path.join(CONTENT_DIR, f)).gallery, configPathFor(id));
      } catch (err) {
        return false;
      }
    })
    .map((f) => f.replace(/\.ya?ml$/i, ""));
}

// ---------- Photos ----------

function photosDir(directory) {
  const dir = path.resolve(PHOTOS_ROOT, String(directory));
  if (dir !== PHOTOS_ROOT && !dir.startsWith(PHOTOS_ROOT + path.sep)) {
    throw new Error(`Invalid photo directory "${directory}"`);
  }
  return dir;
}

function isImageName(name) {
  return (
    typeof name === "string" &&
    name === path.basename(name) &&
    !name.startsWith(".") &&
    IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
  );
}

function listPhotos(directory) {
  const dir = photosDir(directory);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isImageName)
    .sort()
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, mtime: stat.mtime };
    });
}

function deletePhotos(directory, names) {
  const dir = photosDir(directory);
  let count = 0;
  for (const name of names) {
    if (!isImageName(name)) continue;
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      count++;
    }
  }
  return count;
}

/** Turns an uploaded file name into a safe one not already used in `dir`. */
function uniquePhotoName(dir, originalName, reserved) {
  const ext = path.extname(originalName).toLowerCase();
  let base = path
    .basename(originalName, path.extname(originalName))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|-+$/g, "")
    .slice(0, 80) || "photo";
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)) || reserved.has(name); i++) {
    name = `${base}-${i}${ext}`;
  }
  reserved.add(name);
  return name;
}

// ---------- Galleries ----------

function galleryFile(id) {
  return path.join(GALLERIES_DIR, `${id}.yaml`);
}

/** Every gallery YAML file, with what the admin dashboard needs to show. */
function listGalleries() {
  if (!fs.existsSync(GALLERIES_DIR)) return [];
  const listing = readListing();
  return fs
    .readdirSync(GALLERIES_DIR)
    .filter((f) => /\.yaml$/i.test(f) && !f.startsWith("."))
    .map((f) => {
      const id = f.replace(/\.yaml$/i, "");
      let config = {};
      let error = null;
      try {
        config = readYaml(path.join(GALLERIES_DIR, f));
      } catch (err) {
        error = err.message;
      }
      const entry = listingEntry(listing, id);
      let photoCount = 0;
      try {
        photoCount = config.directory ? listPhotos(config.directory).length : 0;
      } catch (err) {
        error = error || err.message;
      }
      return {
        id,
        config,
        error,
        isPrivate: config.password != null && String(config.password) !== "",
        listed: Boolean(entry),
        slug: entry ? entry.slug : null,
        listingIndex: entry ? listing.galleries.indexOf(entry) : -1,
        usedBy: pagesUsing(id),
        photoCount,
      };
    })
    .sort((a, b) => {
      // Listed galleries first, in Galleries-page order; then the rest by name.
      if (a.listed !== b.listed) return a.listed ? -1 : 1;
      if (a.listed) return a.listingIndex - b.listingIndex;
      return a.id.localeCompare(b.id);
    });
}

function findGallery(id) {
  return listGalleries().find((g) => g.id === id) || null;
}

function directoryInUse(directory, exceptId) {
  return listGalleries().some((g) => g.id !== exceptId && g.config.directory === directory);
}

function saveGalleryConfig(id, config) {
  fs.mkdirSync(GALLERIES_DIR, { recursive: true });
  writeYaml(galleryFile(id), config, "# Managed from the admin mode. Edits by hand are fine too.\n");
}

function createGallery(id, config) {
  fs.mkdirSync(photosDir(config.directory), { recursive: true });
  saveGalleryConfig(id, config);
}

function deleteGallery(id, { deletePhotos: removePhotos }) {
  const gallery = findGallery(id);
  if (!gallery) return;
  setListed(id, false);
  fs.unlinkSync(galleryFile(id));
  const dir = gallery.config.directory;
  if (removePhotos && dir && !directoryInUse(dir, id)) {
    const full = photosDir(dir);
    if (full !== PHOTOS_ROOT) fs.rmSync(full, { recursive: true, force: true });
  }
}

module.exports = {
  NAME_PATTERN,
  configPathFor,
  listGalleries,
  findGallery,
  directoryInUse,
  saveGalleryConfig,
  createGallery,
  deleteGallery,
  setListed,
  slugTaken,
  moveInListing,
  photosDir,
  listPhotos,
  deletePhotos,
  isImageName,
  uniquePhotoName,
};
