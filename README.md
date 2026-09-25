# Photographer Website (Node.js)

A small Node.js/Express website for a photographer, built around a
reusable **photo gallery** component configured entirely through YAML
files. No database — everything is driven by files on disk, so a
non-technical photographer can update content by editing YAML and
dropping images into folders.

## Stack

- **Node.js + Express** — web server / routing
- **EJS** — server-rendered templates
- **js-yaml** — YAML parsing
- Plain CSS + a small vanilla-JS slideshow (no build step)

## Getting started

```bash
npm install
cp -r sample/. data/     # first time only: start from the sample data
npm start
# -> http://localhost:3000
```

`npm run dev` restarts automatically on file changes (Node's built-in `--watch`).

The app reads all site data (`config/`, `content/`, `galleries/`,
`photos/`) from `./data/`. Set `DATA_DIR` to read from somewhere else,
e.g. `DATA_DIR=sample npm start` to run straight off the sample data.

## Project structure

```
sample/                # sample site data, tracked in git (copied into data/ on first run)
data/                  # live site data, git-ignored - same layout as sample/:
  config/
    site.yaml            # global config: title, colors, fonts, nav, footer
  content/
    home.yaml            # home page text + which gallery to show
    projects.yaml        # projects page text + list of galleries
    contact.yaml         # contact page text
  galleries/
    featured.yaml        # reusable gallery configs (one per gallery)
    weddings.yaml
    portraits.yaml
    travel.yaml
  photos/
    featured/ weddings/ portraits/ travel/   # actual image files
lib/
  config.js            # loads data/config/site.yaml + generic YAML content loader
  gallery.js            # the reusable "photo gallery" component logic
views/
  partials/gallery.ejs           # gallery component entry point
  partials/gallery-slideshow.ejs # slideshow rendering
  partials/gallery-thumbnails.ejs# thumbnail grid rendering
  home.ejs / projects.ejs / gallery.ejs / contact.ejs
public/
  css/style.css        # theme, driven by CSS variables from site.yaml
  js/gallery.js         # slideshow behaviour (autoplay, arrows, dots)
server.js               # Express app & routes
```

## The reusable "gallery" component

Any gallery is defined by one YAML file:

```yaml
# galleries/weddings.yaml
directory: "weddings"     # sub-folder of photos/ to read images from
mode: "slideshow"         # "slideshow" or "thumbnails"
title: "Weddings"
description: "Candid, light-driven coverage of weddings ..."
interval: 4                # slideshow auto-rotate delay, in seconds (default 3)
maxWidth: 1200               # optional, caps the displayed image width, in px
maxHeight: 800                # optional, caps the displayed image height, in px
```

`lib/gallery.js` reads that file, lists the images found in
`photos/<directory>/`, and returns a plain object:

```js
{ title, description, mode, directory, interval, maxWidth, maxHeight,
  images: [{ src, alt }, ...] }
```

The view partial `views/partials/gallery.ejs` takes that object and
renders either the slideshow or the thumbnail-grid partial depending on
`mode` — so the exact same component powers:

- the **home page** slideshow (`content/home.yaml` → `galleries/featured.yaml`)
- each **project's** page at `/projects/:slug` (`galleries/weddings.yaml`, etc.)

To add a new gallery: create `galleries/my-gallery.yaml`, drop images
into `photos/my-gallery/`, and reference it from `content/home.yaml`
or add an entry to `content/projects.yaml`.

### Auto-rotating slideshow

In `mode: slideshow`, slides advance automatically every `interval`
seconds (default **3s** if omitted). Hovering the slideshow pauses
autoplay; arrows and dots are still available and reset the timer.

### Max display size

`maxWidth` / `maxHeight` (in pixels) cap how large the gallery's images
are shown on the page (slideshow viewport / thumbnail cells). Leave
them out to let images fill the available layout width responsively,
as before.

### Click-to-enlarge (lightbox overlay)

Clicking any image — a slide or a thumbnail — opens it enlarged in an
on-page overlay (lightbox), not a new browser tab. The overlay supports
arrow keys / on-screen arrows to move between the gallery's images,
click-outside or `Escape` to close, and shows the image's caption
underneath (see next section).

### Captions from image metadata

Each image's caption (used as its `alt` text and shown under it in the
lightbox) is read from that photo file's own embedded metadata —
EXIF `ImageDescription`, or an IPTC/XMP caption/description tag — using
the `exifr` library. This lets a photographer caption images directly
from Lightroom, `exiftool`, or similar tools instead of editing YAML.
Supported for JPEG, PNG, WebP, TIFF and HEIC; if a file has no such tag
(or is a format with no metadata, like SVG/GIF), the caption falls back
to `"<gallery title> - <file name>"`.

## Pages

| Route              | Content source                          | Description |
|---------------------|------------------------------------------|--------------|
| `/`                 | `content/home.yaml`                     | Hero text + one slideshow gallery |
| `/projects`         | `content/projects.yaml`                 | Grid of galleries, one thumbnail preview each |
| `/projects/:slug`   | entry in `content/projects.yaml`        | Full gallery (slideshow or thumbnails, per its own YAML) |
| `/contact`          | `content/contact.yaml`                  | Contact details & social links |
| `/<name>`           | `content/<name>.yaml` (with a `gallery:` key) | Extra top-level page: hero text + one gallery. E.g. `content/weddings.yaml` → `/weddings`; add it to `navigation` in `config/site.yaml` to show it as a tab |
| `/your-photos`      | any `galleries/*.yaml` with a `password` | Customer login (gallery name + password) for private galleries |

## Private customer galleries ("Your Photos")

Give a gallery YAML file a `password` to make it private:

```yaml
# galleries/smith-wedding.yaml
directory: "smith-wedding"   # photos/smith-wedding/ - also the "gallery name" the customer types
password: "choose-a-good-one"
mode: "thumbnails"
title: "Anna & Marc - 14 June"
```

- It never appears on the public site: not in the Projects list (even if
  `content/projects.yaml` references it), and `/projects/<slug>` returns 404.
- Its photos are **not** served from the public `/photos/...` URLs, only
  through `/your-photos/<directory>/photos/...` to a visitor who logged in.
- Customers click **Your Photos** on the Projects page, type the directory
  name (case-insensitive) and the password. Access is kept for 12 hours by
  a signed cookie; changing the password in the YAML file revokes it
  immediately. The form also has the same human check as the contact page
  (see below), and repeated wrong passwords are rate-limited per IP (10 per
  15 minutes).
- The cookie signing secret is random per server start (customers log in
  again after a restart). Set `GALLERY_ACCESS_SECRET` to pin it.

## Image save protection

On every page, right-click / "Save image as...", dragging images out and
the iOS long-press menu are disabled for images (`public/js/gallery.js`,
`public/css/style.css`). This only deters casual copying: whatever a
browser displays can still be captured with a screenshot or the
developer tools.

## Global / graphic configuration

`config/site.yaml` is reloaded on every request (no restart needed) and
drives:

- site title / tagline / logo text
- color palette ("charte graphique"): primary, secondary, accent, muted, border, header background, footer background
- fonts (heading / body / logo / gallery titles), optional Google Fonts URL.
  `galleryTitleFont` also applies to the page `heading:` text (home page and
  other content pages). `logoFont` and `galleryTitleFont` default to Mistral, falling back to the
  look-alike Google font Kaushan Script (loaded automatically when used)
- optional logo image (`site.logoImage`, `site.logoImageHeight`) shown
  instead of `logoText`; e.g. put the file in `photos/branding/logo.png`
  and set `logoImage: "/photos/branding/logo.png"`
- top navigation links
- footer text & social links

These are exposed as CSS custom properties (`--color-primary`, `--font-heading`,
etc.) in `views/partials/layout-top.ejs`, so `public/css/style.css` picks
them up automatically.

## Contact page anti-spam check

`/contact` doesn't show the email/phone/social links until the visitor
answers a tiny arithmetic question ("what is 4 + 7?"). This is a fully
self-hosted "I'm not a robot" check (`lib/captcha.js`) — no reCAPTCHA,
hCaptcha or other third-party service, no database or session store:
the expected answer and an expiry timestamp are HMAC-signed into an
opaque token carried in a hidden form field, and verified on submit
(`POST /contact/verify`). This is enough to stop most scraping bots
without adding any external dependency or tracking. For stronger
protection against determined bots, consider adding rate-limiting
(e.g. `express-rate-limit`) on `/contact/verify`.

## Running with Docker Compose

The app is also packaged to run in Docker, with **all editable data —
site config, page content, gallery definitions and photos — kept in
external volumes on the host** rather than baked into the image. That
means updating the site (swap a photo, tweak `site.yaml`, add a
gallery) never requires rebuilding or redeploying the container.

```bash
cp .env.example .env
# edit .env: point CONFIG_DIR / CONTENT_DIR / GALLERIES_DIR / PHOTOS_DIR
# at real paths on your host (defaults to ./data/* for a quick try),
# and set PUID/PGID to the host user that should own those files.

docker compose up -d --build
# -> http://localhost:3000  (or $HOST_PORT)
```

What this sets up:

- **`Dockerfile`** — multi-stage build (Node 20 Alpine). The app code
  (`server.js`, `lib/`, `public/`, `views/`) is baked into the image;
  the sample data (`sample/`) is copied in at `/app/sample`; the live
  `config/`, `content/`, `galleries/` and `photos/` under `/app/data/`
  are **not** in the image — those are the four external volumes.
- **`docker-compose.yml`** — builds the image and bind-mounts
  `CONFIG_DIR` → `/app/data/config`, `CONTENT_DIR` → `/app/data/content`,
  `GALLERIES_DIR` → `/app/data/galleries`, `PHOTOS_DIR` → `/app/data/photos` (all
  overridable via `.env`, defaulting to `./data/*`).
- **`docker-entrypoint.sh`** — on first run, seeds any of those four
  volumes that's completely empty with the sample config/content/photos
  shipped in the image, so `docker compose up` shows a working site
  immediately on a fresh host. A volume you've already put content into
  is left untouched. It also re-owns the container's user to match the
  `PUID`/`PGID` you set, so files stay editable from the host side too.
- **`.env.example`** — copy to `.env` to set the host paths, port,
  PUID/PGID, and optionally pin `CAPTCHA_SECRET` / `CAPTCHA_POW_BITS`
  (see `lib/captcha.js`) instead of using their defaults.

To update the live site's content, just edit files under the host
directories you pointed `CONFIG_DIR`/`CONTENT_DIR`/`GALLERIES_DIR`/
`PHOTOS_DIR` at (`config/site.yaml` is re-read on every request; adding
a gallery or photo needs no restart either — routes read gallery/photo
folders fresh on each request too). Rebuilding the image
(`docker compose up -d --build`) is only needed after changing the
application code itself.

`.env` and the contents of `./data/` are git-ignored: they are the
per-host settings and live site data of a deployment, so `git pull` on
the server never overwrites them. The `sample/` folder stays in git as
the starting data baked into the image: edit it only to change what a
brand-new install starts with.

## Notes

- Sample images are placeholder SVGs so the site runs out of the box;
  replace them with real JPG/PNG/WebP files in `data/photos/`.
- Supported image extensions: `.jpg .jpeg .png .webp .gif .svg`.
