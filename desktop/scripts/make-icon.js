#!/usr/bin/env node
/**
 * Turn a base64 PNG of the brand mark into assets/icon.ico.
 *
 * WHY AN ICO IS BUILT HERE RATHER THAN CHECKED IN AS ART
 * The mark is a rounded tile with an R on it, defined by the same accent
 * values as the sign-in screen and the favicon. Deriving it means the three
 * places a person meets this brand cannot drift apart, and nobody has to
 * remember to re-export a file when the accent changes.
 *
 * ICO files may embed PNG data directly (Vista onward), so this is a 22-byte
 * header wrapped around a PNG rather than a real image encoder — which is why
 * it can be done in plain Node with no dependency.
 *
 * Usage:  node scripts/make-icon.js <path-to-base64-file>
 */

const fs = require('node:fs');
const path = require('node:path');

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/make-icon.js <file containing base64 PNG>');
  process.exit(1);
}

// The tool-result file is JSON ([{type,text}]) when it comes from the browser,
// or a bare base64 string when produced any other way. Accept both rather than
// making the caller care.
const raw = fs.readFileSync(src, 'utf8').trim();
let b64;
try {
  const parsed = JSON.parse(raw);
  b64 = Array.isArray(parsed) ? parsed[0].text : parsed.text;
} catch {
  b64 = raw;
}
b64 = String(b64).replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '');

const png = Buffer.from(b64, 'base64');
// PNG magic. A truncated or mis-decoded payload would otherwise produce an
// .ico that Windows silently refuses to show, with nothing to debug.
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  console.error('That is not a PNG — check the base64 input.');
  process.exit(1);
}

const SIZE = 256;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // 1 = icon
header.writeUInt16LE(1, 4);   // one image in this file

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);       // width  0 means 256
entry.writeUInt8(0, 1);       // height 0 means 256
entry.writeUInt8(0, 2);       // palette size
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // colour planes
entry.writeUInt16LE(32, 6);   // bits per pixel
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);  // offset: 6 header + 16 entry

const out = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, entry, png]));

console.log(`wrote ${out}`);
console.log(`  ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB`);
