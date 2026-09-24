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
npm start
# -> http://localhost:3000
```

`npm run dev` restarts automatically on file changes (Node's built-in `--watch`).

## Project structure

```
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
  config.js            # loads config/site.yaml + generic YAML content loader
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

## Global / graphic configuration

`config/site.yaml` is reloaded on every request (no restart needed) and
drives:

- site title / tagline / logo text
- color palette ("charte graphique"): primary, secondary, accent, muted, border, header background, footer background
- fonts (heading / body), optional Google Fonts URL
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
  `config/`, `content/`, `galleries/` and `photos/` are **not** — those
  are the four external volumes.
- **`docker-compose.yml`** — builds the image and bind-mounts
  `CONFIG_DIR` → `/app/config`, `CONTENT_DIR` → `/app/content`,
  `GALLERIES_DIR` → `/app/galleries`, `PHOTOS_DIR` → `/app/photos` (all
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
the server never overwrites them. The top-level `config/`, `content/`,
`galleries/` and `photos/` folders stay in git as the sample seed data
baked into the image.

## Notes

- Sample images are placeholder SVGs so the site runs out of the box;
  replace them with real JPG/PNG/WebP files in `photos/`.
- Supported image extensions: `.jpg .jpeg .png .webp .gif .svg`.
