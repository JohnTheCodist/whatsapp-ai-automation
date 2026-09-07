#!/usr/bin/env node
/**
 * Generate the real favicon files Google needs.
 *
 * WHY THIS EXISTS
 * home.html declared its favicon two ways, and search engines could use
 * neither:
 *
 *   1. a data:image/svg+xml URI — Google's favicon crawler explicitly
 *      requires a CRAWLABLE URL. It never fetches a data URI, so this is
 *      invisible to Search however well it renders in a browser tab.
 *   2. <link rel="icon" href="/favicon-32.png"> — pointing at a file that
 *      does not exist. A 404.
 *
 * With no usable favicon, Search falls back to the generic globe. That is
 * the whole bug: not a caching delay, not a crawl problem, just no file.
 *
 * WHY IT IS DERIVED RATHER THAN CHECKED IN
 * Same reasoning as desktop/scripts/make-icon.js: the mark is a rounded tile
 * with an R, defined by the accent value the rest of the brand uses. Deriving
 * it means the tab icon, the installer icon and the dashboard's canvas mark
 * cannot drift apart, and nobody has to remember to re-export a PNG when the
 * accent changes.
 *
 * NO DEPENDENCIES. A PNG is a signature, three chunks, and a zlib stream —
 * all of which Node has built in. Pulling in an image library to draw one
 * letter would be a dependency on a pharmacy's deploy path forever.
 *
 *   node scripts/make-favicons.js [outDir]      default: client/public
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Brand. sRGB equivalents of the site's oklch tokens — see home.html.
//   --color-accent    oklch(72% 0.132 165)
//   --color-on-accent oklch(21% 0.030 165)
const TILE = [0x3c, 0xbe, 0x90];
const INK  = [0x09, 0x1d, 0x15];

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba  size*size*4 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // truecolour + alpha
  // 10,11,12 = compression, filter, interlace — all 0

  // Filter byte 0 (None) per scanline. Real encoders pick a filter per row for
  // compression; at 512px and smaller the saving is not worth the code.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size * 4; x++) raw[o++] = rgba[y * size * 4 + x];
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark, drawn analytically
//
// Coordinates are a 0..1 unit square so one description serves every size.
// Coverage is sampled 4x4 per pixel — a letterform without anti-aliasing at
// 16px is a smear, and this is the cheapest way to get clean edges without a
// rasteriser.
// ---------------------------------------------------------------------------

const inBox = (px, py, x0, y0, x1, y1) => px >= x0 && px <= x1 && py >= y0 && py <= y1;

/** Distance from a point to a segment — used to give the leg its thickness. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Is this unit-square point inside the letter R? */
function inR(x, y) {
  // stem
  if (inBox(x, y, 0.200, 0.155, 0.335, 0.845)) return true;

  // the bowl's two horizontal bars, which join the stem to the arc
  if (inBox(x, y, 0.200, 0.155, 0.430, 0.250)) return true;
  if (inBox(x, y, 0.200, 0.442, 0.430, 0.537)) return true;

  // bowl — right half of an annulus, closing the two bars into a loop
  const cx = 0.410, cy = 0.346;
  if (x >= cx) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= 0.191 && d >= 0.096) return true;
  }

  // leg
  //
  // Starts at y 0.530, not 0.500. The segment is drawn with round caps of
  // radius 0.068, so a start at 0.500 put the top of the cap at 0.432 —
  // four thousandths INSIDE the counter, whose lower edge is at 0.442. That
  // read as a small bite taken out of the bowl's hole, which at 512px is
  // obvious and at 16px turns the counter into mush. Starting lower puts the
  // whole cap clear of it while still meeting the bottom bar at x 0.430.
  if (segDist(x, y, 0.430, 0.530, 0.610, 0.845) <= 0.068) return true;

  return false;
}

/** Rounded-tile coverage, so the corner radius is anti-aliased too. */
function inTile(x, y, radius) {
  if (radius <= 0) return true;
  const r = radius;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/**
 * @param {number} size
 * @param {boolean} square  true for the maskable / Open Graph versions, which
 *   must bleed to the edge because the platform applies its own mask and a
 *   pre-rounded tile inside it reads as a shrunken sticker.
 */
function render(size, square) {
  const rgba = new Uint8Array(size * size * 4);
  const radius = square ? 0 : 0.22;
  const SS = 4, inv = 1 / (SS * SS);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0, ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (px + (sx + 0.5) / SS) / size;
          const uy = (py + (sy + 0.5) / SS) / size;
          if (inTile(ux, uy, radius)) {
            tile++;
            if (inR(ux, uy)) ink++;
          }
        }
      }
      const a = tile * inv;
      const k = ink * inv;
      const i = (py * size + px) * 4;
      if (a > 0) {
        // Ink composited over tile, then the whole thing carries the tile's
        // own coverage as alpha — so the rounded corner stays transparent
        // rather than being filled with a guessed background colour.
        const m = k / a;
        rgba[i]     = Math.round(TILE[0] * (1 - m) + INK[0] * m);
        rgba[i + 1] = Math.round(TILE[1] * (1 - m) + INK[1] * m);
        rgba[i + 2] = Math.round(TILE[2] * (1 - m) + INK[2] * m);
        rgba[i + 3] = Math.round(a * 255);
      }
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// ICO — a 22-byte header around a PNG. Vista onward reads embedded PNG, and
// /favicon.ico is still the path some crawlers and older browsers try first.
// ---------------------------------------------------------------------------

function ico(png, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);          // reserved
  head.writeUInt16LE(1, 2);          // type: icon
  head.writeUInt16LE(1, 4);          // one image
  head[6] = size >= 256 ? 0 : size;  // 0 means 256
  head[7] = size >= 256 ? 0 : size;
  head[8] = 0;                       // palette
  head[9] = 0;
  head.writeUInt16LE(1, 10);         // colour planes
  head.writeUInt16LE(32, 12);        // bits per pixel
  head.writeUInt32BE(0, 14);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);        // offset
  return Buffer.concat([head, png]);
}

// ---------------------------------------------------------------------------

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'client', 'public'));
fs.mkdirSync(outDir, { recursive: true });

// 48 and its multiples are what Google documents for Search. The rest are for
// browsers, iOS and Open Graph.
const FILES = [
  ['favicon-16.png',      16,  false],
  ['favicon-32.png',      32,  false],
  ['favicon-48.png',      48,  false],
  ['favicon-96.png',      96,  false],
  ['favicon-144.png',     144, false],
  ['apple-touch-icon.png', 180, true],
  ['icon-192.png',        192, false],
  ['icon-512.png',        512, false],
  ['og-mark-512.png',     512, true],
];

for (const [name, size, square] of FILES) {
  const png = encodePng(size, render(size, square));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`  ${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

const ico48 = encodePng(48, render(48, false));
fs.writeFileSync(path.join(outDir, 'favicon.ico'), ico(ico48, 48));
console.log(`  ${'favicon.ico'.padEnd(22)} 48x48  ${(ico48.length / 1024).toFixed(1)} KB`);

console.log(`\nwritten to ${outDir}`);
