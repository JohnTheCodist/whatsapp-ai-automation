/**
 * Finding today's export and sending it.
 *
 * WHY THE NEWEST FILE RATHER THAN A FIXED NAME
 * POS software names its exports however it likes — stock.csv, STOCK_2026-08-24.xlsx,
 * export(3).csv — and asking a pharmacist to guarantee a filename is asking
 * them to remember something they will eventually get wrong. The newest
 * spreadsheet in the folder is what "today's export" means to the person who
 * just clicked Export.
 *
 * NOTHING IS DELETED. Ever. The pharmacy's own files are theirs; an agent that
 * tidied up after itself would eventually delete the one file somebody still
 * needed, and it would do it silently on a machine nobody is watching.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXTS = new Set(['.xlsx', '.xls', '.csv']);

/** 10MB, matching the server. Rejecting here saves an upload that cannot succeed. */
const MAX_BYTES = 10 * 1024 * 1024;

function newestExport(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A folder that has been moved or renamed is the single most likely
    // real-world failure, so it gets its own message rather than an ENOENT.
    const e = new Error(`Cannot read the export folder: ${dir}`);
    e.code = 'NO_FOLDER';
    e.cause = err;
    throw e;
  }

  const files = entries
    .filter((e) => e.isFile() && EXTS.has(path.extname(e.name).toLowerCase()))
    // Files a POS is midway through writing, and Excel's lock files, which
    // start with ~$ and are not spreadsheets however they are named.
    .filter((e) => !e.name.startsWith('~$') && !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(dir, e.name);
      try {
        return { name: e.name, path: full, stat: fs.statSync(full) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  return files[0] || null;
}

/**
 * Is this file still being written?
 *
 * A POS writing a large export is a file whose size is still climbing. Reading
 * it mid-write uploads a truncated catalogue, which imports as "half your
 * products vanished" — and on a re-upload that REPLACES price and stock, a
 * truncated file is not a partial success, it is a corrupted catalogue.
 *
 * Cheap and good enough: a file untouched for a few seconds is finished. This
 * is not a distributed-consensus problem, it is a shop PC writing a CSV.
 */
function looksSettled(file, minAgeMs = 5000) {
  return Date.now() - file.stat.mtimeMs > minAgeMs;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Send one file.
 *
 * Returns the server's own verdict rather than a boolean, because "imported"
 * and "uploaded, but someone has to check the columns" are both successes for
 * the agent and completely different facts for the pharmacy.
 */
async function upload({ apiUrl, token, filePath, fileName }) {
  const buf = fs.readFileSync(filePath);
  if (buf.length > MAX_BYTES) {
    const e = new Error(`${fileName} is ${(buf.length / 1048576).toFixed(1)}MB — larger than the 10MB limit.`);
    e.code = 'TOO_BIG';
    throw e;
  }

  const form = new FormData();
  form.append('file', new Blob([buf]), fileName);

  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/sync/catalogue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });

  const body = await res.json().catch(() => ({}));

  if (res.status === 401) {
    const e = new Error(body.error || 'This computer is no longer paired.');
    e.code = 'UNPAIRED';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(body.error || `Upload failed (HTTP ${res.status}).`);
    e.code = body.code || 'UPLOAD_FAILED';
    throw e;
  }
  return body;
}

async function heartbeat({ apiUrl, token }) {
  try {
    await fetch(`${apiUrl.replace(/\/$/, '')}/api/sync/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    // Best effort. A missed heartbeat shows in the dashboard as a quiet agent,
    // which is exactly what it is.
  }
}

module.exports = { newestExport, looksSettled, hashFile, upload, heartbeat, EXTS, MAX_BYTES };
