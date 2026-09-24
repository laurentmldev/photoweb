const crypto = require("crypto");

// Renders the "a + b" question as a hand-wobbled SVG drawing rather than
// as text. Every digit/operator is built from line SEGMENTS (a tiny
// stroke-font), not an SVG <text> element, so a scraper reading the raw
// markup finds coordinate soup, not "4 + 7". Combined with per-render
// jitter, rotation and overlapping noise strokes, this also makes plain
// OCR meaningfully harder while staying readable to a person.
//
// Deliberate scope note: this trades some accessibility (a screen reader
// gets no text alternative for the question) for bot-resistance. That's
// the standard tradeoff visual CAPTCHAs make; if accessibility matters
// more than spam-resistance for a given deployment, pair this with an
// alternate contact path (e.g. a plain mailto: link) rather than trying
// to make the image both readable-by-machine and hard-to-OCR.

// Simple 7-segment layout on a 10 (w) x 16 (h) grid.
const SEGMENTS = {
  top: [[1, 0], [9, 0]],
  topLeft: [[1, 0], [1, 8]],
  topRight: [[9, 0], [9, 8]],
  middle: [[1, 8], [9, 8]],
  bottomLeft: [[1, 8], [1, 16]],
  bottomRight: [[9, 8], [9, 16]],
  bottom: [[1, 16], [9, 16]],
};

const DIGIT_SEGMENTS = {
  0: ["top", "topLeft", "topRight", "bottomLeft", "bottomRight", "bottom"],
  1: ["topRight", "bottomRight"],
  2: ["top", "topRight", "middle", "bottomLeft", "bottom"],
  3: ["top", "topRight", "middle", "bottomRight", "bottom"],
  4: ["topLeft", "topRight", "middle", "bottomRight"],
  5: ["top", "topLeft", "middle", "bottomRight", "bottom"],
  6: ["top", "topLeft", "middle", "bottomLeft", "bottomRight", "bottom"],
  7: ["top", "topRight", "bottomRight"],
  8: ["top", "topLeft", "topRight", "middle", "bottomLeft", "bottomRight", "bottom"],
  9: ["top", "topLeft", "topRight", "middle", "bottomRight", "bottom"],
};

// '+' as two crossing strokes, on the same 10x16 grid.
const PLUS_SEGMENTS = {
  vertical: [[5, 4], [5, 12]],
  horizontal: [[1, 8], [9, 8]],
};

function rand(rng, min, max) {
  return min + rng() * (max - min);
}

// Small deterministic-per-call PRNG seeded from crypto so each image is
// unpredictable without pulling in a dependency.
function makeRng() {
  let seed = crypto.randomBytes(4).readUInt32LE(0);
  return function () {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
}

// Turns a list of [x,y] points into a wobbly SVG path "d" string, adding
// a small random offset per point so straight segments look hand-drawn
// rather than machine-perfect (which also defeats naive template-matching
// OCR tuned to crisp seven-segment shapes).
function wobblyPath(points, rng, wobble) {
  const jittered = points.map(([x, y]) => [
    x + rand(rng, -wobble, wobble),
    y + rand(rng, -wobble, wobble),
  ]);
  return jittered.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

function renderGlyph(segmentMap, activeSegments, rng, cellX, strokeColor) {
  const wobble = rand(rng, 0.3, 0.9);
  const strokeWidth = rand(rng, 1.1, 1.7);
  const rotation = rand(rng, -18, 18);
  const skew = rand(rng, -10, 10);
  const scale = rand(rng, 0.9, 1.2);
  const dy = rand(rng, -1.5, 1.5);

  const strokes = activeSegments
    .map((name) => {
      const d = wobblyPath(segmentMap[name], rng, wobble);
      return `<path d="${d}" stroke="${strokeColor}" stroke-width="${strokeWidth.toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`;
    })
    .join("");

  return `<g transform="translate(${cellX},${8 + dy}) rotate(${rotation.toFixed(1)}) skewX(${skew.toFixed(1)}) scale(${scale.toFixed(2)}) translate(-5,-8)">${strokes}</g>`;
}

function randomNoiseColor(rng) {
  const l = Math.round(rand(rng, 120, 190));
  return `rgb(${l},${l},${l})`;
}

function buildNoise(rng, width, height, count) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const x1 = rand(rng, 0, width);
    const y1 = rand(rng, 0, height);
    const x2 = rand(rng, 0, width);
    const y2 = rand(rng, 0, height);
    const cx = rand(rng, 0, width);
    const cy = rand(rng, 0, height);
    out += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" stroke="${randomNoiseColor(rng)}" stroke-width="${rand(rng, 0.6, 1.3).toFixed(2)}" fill="none" opacity="${rand(rng, 0.35, 0.6).toFixed(2)}" />`;
  }
  return out;
}

function buildSpeckle(rng, width, height, count) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const x = rand(rng, 0, width);
    const y = rand(rng, 0, height);
    const r = rand(rng, 0.4, 1.1);
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${randomNoiseColor(rng)}" opacity="${rand(rng, 0.3, 0.55).toFixed(2)}" />`;
  }
  return out;
}

/**
 * Builds a self-contained "data:image/svg+xml;base64,..." URI drawing the
 * question "a + b" as distorted strokes. No <text> element is used
 * anywhere, so the digits are not present as machine-readable text.
 */
function renderQuestionImage(a, b) {
  const width = 180;
  const height = 70;
  const rng = makeRng();

  const cellWidth = 50;
  const startX = 20;
  const strokeColor = "#2b2b2b";

  const glyphA = renderGlyph(SEGMENTS, DIGIT_SEGMENTS[a], rng, startX, strokeColor);
  const glyphPlus = renderGlyph(PLUS_SEGMENTS, ["vertical", "horizontal"], rng, startX + cellWidth, strokeColor);
  const glyphB = renderGlyph(SEGMENTS, DIGIT_SEGMENTS[b], rng, startX + cellWidth * 2, strokeColor);

  const backNoise = buildNoise(rng, width, height, 6);
  const speckle = buildSpeckle(rng, width, height, 70);
  const frontNoise = buildNoise(rng, width, height, 3);

  const bandY = rand(rng, height * 0.3, height * 0.5);
  const wavyBand = `<path d="M0,${bandY.toFixed(1)} Q${width / 4},${(bandY + rand(rng, -10, 10)).toFixed(1)} ${width / 2},${bandY.toFixed(1)} T${width},${bandY.toFixed(1)}" stroke="#dcd8cf" stroke-width="6" fill="none" opacity="0.5" />`;

  const svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="visual security question">` +
    `<rect width="${width}" height="${height}" fill="#f4f1ea" />` +
    wavyBand +
    backNoise +
    speckle +
    glyphA +
    glyphPlus +
    glyphB +
    frontNoise +
    `</svg>`;

  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}

module.exports = { renderQuestionImage };
