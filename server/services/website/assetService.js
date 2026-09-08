/**
 * Pharmacy image uploads.
 *
 * THE FILE IS IDENTIFIED BY ITS CONTENT, NEVER BY ITS NAME OR ITS HEADER.
 *
 * A browser sends a Content-Type it was told by the operating system, and an
 * extension is whatever the uploader typed. Both are attacker-controlled and
 * neither says anything about what the bytes are. `logo.png` containing HTML
 * is the classic version: stored as image/png, served from a storage origin,
 * and sniffed back into a document by some browser somewhere. So the MIME
 * type is read out of the first few bytes and the declared one is discarded.
 *
 * That is the whole reason this file has a magic-byte table rather than a
 * call to a mime-detection package: it is twelve bytes of comparison, it has
 * no dependency, and it is the security control — worth being able to read.
 *
 * TENANCY IS IN THE PATH. Every object is stored at
 * `<pharmacy_id>/<asset_id>.<ext>`, and that prefix is built here from a
 * verified req.pharmacyId. Nothing a client sends contributes to it.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const store = require('./assetStore');

/**
 * 2 MB.
 *
 * Not a guess: a pharmacy logo is a few tens of kilobytes and a hero
 * photograph straight off a phone is two to four megabytes. Two is generous
 * for the first and forces the second to be resized, which is the right
 * pressure — this product has no image processing, so an unresized phone
 * photo would be shipped to every visitor on a mobile connection exactly as
 * it came off the camera.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** What a pharmacy may use an image for. Mirrors the check on the column. */
const KINDS = Object.freeze(['logo', 'hero', 'gallery', 'service']);

/**
 * Magic bytes → the MIME type we will actually store and serve.
 *
 * Three formats, chosen because they are what a phone or a designer produces
 * and what every browser renders. Deliberately NOT svg: an SVG is a document
 * that can carry script, and permitting one would put an executable file
 * behind an <img> tag on a public page — undoing the `script-src 'none'`
 * guarantee the published site rests on.
 */
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // RIFF....WEBP — the four bytes at offset 8 are what distinguishes a WebP
  // from any other RIFF container (a .wav would otherwise pass).
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.length > 12
      && b.subarray(0, 4).toString('ascii') === 'RIFF'
      && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/**
 * Identify a buffer, or refuse it.
 *
 * PURE, and exported, because it is the security control and it must be
 * testable without a database, a bucket or a network.
 *
 * @returns {{ok:true, mime:string, ext:string} | {ok:false, code:string, error:string}}
 */
function identifyImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', error: 'That file is empty.' };
  }
  if (buffer.length > MAX_BYTES) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: `Images must be ${Math.floor(MAX_BYTES / (1024 * 1024))}MB or smaller. Try resizing it first.`,
    };
  }
  const match = SIGNATURES.find((s) => s.test(buffer));
  if (!match) {
    // Names the accepted formats. "Invalid file" tells an owner nothing about
    // what to do next, and the most common cause here is a HEIC straight off
    // an iPhone.
    return {
      ok: false,
      code: 'UNSUPPORTED_IMAGE',
      error: 'That does not look like a PNG, JPG or WebP image. Save it as one of those and try again.',
    };
  }
  return { ok: true, mime: match.mime, ext: match.ext };
}

function normalizeKind(kind) {
  return KINDS.includes(kind) ? kind : null;
}

/**
 * Is this string shaped like an asset id at all?
 *
 * CHECKED BEFORE ANY QUERY, because `pharmacy_assets.id` is a uuid column and
 * Postgres rejects a malformed value with `invalid input syntax for type
 * uuid` — an unhandled 500 rather than the 404 the caller deserves. A client
 * with a stale or mistyped id would get a server error and a log line that
 * looks like a fault here.
 *
 * Found by a test, not in production: the suite passed 'not-an-id' to
 * ownsAsset and got a database error instead of `false`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAssetId = (value) => typeof value === 'string' && UUID_RE.test(value);

/**
 * Store an uploaded image against a pharmacy.
 *
 * ORDER MATTERS: the object goes to storage FIRST, then the row. If the row
 * insert fails we are left with an unreferenced object — wasted bytes, and
 * invisible. The other order would leave a row pointing at nothing, which the
 * renderer would resolve to an empty image on a live page. Wasting a few
 * kilobytes is the better failure.
 */
async function uploadAsset(pharmacyId, { buffer, kind } = {}) {
  assertPharmacyId(pharmacyId);

  const checkedKind = normalizeKind(kind);
  if (!checkedKind) {
    return { ok: false, code: 'INVALID_KIND', error: `kind must be one of: ${KINDS.join(', ')}` };
  }

  const identified = identifyImage(buffer);
  if (!identified.ok) return identified;

  const id = crypto.randomUUID();
  // The ONLY place a storage path is built. The pharmacy id comes from a
  // verified session and the asset id from crypto — no part of it is
  // client-supplied, so there is nothing to escape and no traversal to
  // defend against.
  const storagePath = `${pharmacyId}/${id}.${identified.ext}`;

  await store.put(storagePath, buffer, identified.mime);

  const db = getSql();
  try {
    const [row] = await db`
      insert into pharmacy_assets (id, pharmacy_id, kind, storage_path, mime, bytes)
      values (${id}, ${pharmacyId}, ${checkedKind}, ${storagePath}, ${identified.mime}, ${buffer.length})
      returning id, kind, storage_path, mime, bytes, created_at
    `;
    return { ok: true, asset: row };
  } catch (err) {
    // Roll the object back so a failed insert does not leave an orphan.
    await store.remove(storagePath).catch(() => {});
    throw err;
  }
}

/** This pharmacy's assets, newest first. Always tenant-scoped. */
async function listAssets(pharmacyId, { kind } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const checkedKind = kind ? normalizeKind(kind) : null;
  return checkedKind
    ? db`
      select id, kind, storage_path, mime, bytes, created_at
        from pharmacy_assets
       where pharmacy_id = ${pharmacyId} and kind = ${checkedKind}
       order by created_at desc
    `
    : db`
      select id, kind, storage_path, mime, bytes, created_at
        from pharmacy_assets
       where pharmacy_id = ${pharmacyId}
       order by created_at desc
    `;
}

/**
 * Every asset this pharmacy owns, as the map the renderer expects.
 *
 * THIS IS THE TENANT BOUNDARY FOR IMAGES. `render.js#assetUrl` resolves a
 * block's asset id against this map and returns '' for anything absent — so
 * because the query is scoped here, a block referencing another pharmacy's
 * asset id renders nothing rather than their file. The isolation is a
 * property of what is in the map, not of a check at render time.
 */
async function assetMapFor(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const rows = await db`
    select id, storage_path, kind, width, height
      from pharmacy_assets
     where pharmacy_id = ${pharmacyId}
     -- Ordered so a gallery renders the same way twice. Map preserves
     -- insertion order, so this ordering IS the display order.
     order by created_at asc, id asc
  `;
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    storage_path: r.storage_path,
    // kind and dimensions travel with the row so a generated page can ask
    // for "the hero photo" without a second query, and can emit width and
    // height on the img — which is what stops the page shifting as images
    // load, the layout half of Core Web Vitals.
    kind: r.kind,
    width: r.width,
    height: r.height,
  }]));
}

/**
 * Delete an asset.
 *
 * Scoped read first: another pharmacy's id finds nothing and returns
 * NOT_FOUND rather than FORBIDDEN, consistent with the rest of the codebase —
 * confirming that an id exists is itself a disclosure.
 *
 * The ROW goes first here, the opposite of upload. A row without an object
 * renders an empty image; an object without a row is invisible and costs
 * only storage. Both orders can fail halfway; this is the direction whose
 * failure a visitor cannot see.
 */
async function deleteAsset(pharmacyId, assetId) {
  assertPharmacyId(pharmacyId);
  if (!isAssetId(assetId)) {
    return { ok: false, code: 'NOT_FOUND', error: 'No such image' };
  }

  const db = getSql();
  const [row] = await db`
    select id, storage_path from pharmacy_assets
     where id = ${assetId} and pharmacy_id = ${pharmacyId}
  `;
  if (!row) return { ok: false, code: 'NOT_FOUND', error: 'No such image' };

  // Clear any profile reference first, or the foreign key would either block
  // the delete or null the column behind the caller's back depending on the
  // constraint. Explicit beats either.
  await db`
    update pharmacy_profile set logo_asset_id = null
     where pharmacy_id = ${pharmacyId} and logo_asset_id = ${assetId}
  `;
  await db`delete from pharmacy_assets where id = ${assetId} and pharmacy_id = ${pharmacyId}`;
  await store.remove(row.storage_path).catch(() => {});

  return { ok: true };
}

/** Does this asset belong to this pharmacy? Used before storing a reference. */
async function ownsAsset(pharmacyId, assetId) {
  assertPharmacyId(pharmacyId);
  if (!isAssetId(assetId)) return false;
  const db = getSql();
  const rows = await db`
    select 1 from pharmacy_assets where id = ${assetId} and pharmacy_id = ${pharmacyId}
  `;
  return rows.length > 0;
}

module.exports = {
  // Re-exported so routes have one import for everything image-related.
  publicBaseUrl: store.publicBaseUrl,
  storageOrigin: store.storageOrigin,
  uploadAsset,
  listAssets,
  assetMapFor,
  deleteAsset,
  ownsAsset,
  // pure, exported for tests
  identifyImage,
  normalizeKind,
  isAssetId,
  MAX_BYTES,
  KINDS,
  SIGNATURES,
};
