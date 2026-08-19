/**
 * Which NAFDAC dataset produced a given condition inference.
 *
 * WHY A CONTENT HASH RATHER THAN A HAND-WRITTEN VERSION STRING
 * Every condition on a patient's profile is only as good as the reference data
 * that classified the drug. When the NAFDAC extract is replaced — a product
 * reclassified, a subgroup corrected — conclusions drawn under the old extract
 * may no longer follow. The stored version is what makes that discoverable
 * later instead of invisible.
 *
 * A hand-maintained constant would be wrong the first time someone swapped the
 * CSV without editing it, and would be wrong silently, which is the failure
 * mode that matters. Hashing the file's own bytes cannot drift from the file.
 *
 * NAFDAC_DATASET_VERSION overrides it when set, so a deployment that tracks
 * official releases can record "2026-08" instead of a hash. The label is
 * recorded verbatim; nothing here validates that it corresponds to the file,
 * because a deployment that sets it is asserting exactly that.
 *
 * Computed once per process. The file does not change under a running server —
 * nafdacLookup loads it into memory at startup and never re-reads it.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAFDAC_CSV_PATH = path.join(__dirname, '..', '..', 'data', 'pharma_nafdac_dataset.csv');

let cached = null;

function computeVersion() {
  const override = (process.env.NAFDAC_DATASET_VERSION || '').trim();
  if (override) {
    return { version: override, source: 'env', csvPath: NAFDAC_CSV_PATH };
  }

  try {
    const buf = fs.readFileSync(NAFDAC_CSV_PATH);
    // Twelve hex characters. Long enough that two different extracts colliding
    // is not a practical concern, short enough to read in a log line or an
    // audit record without wrapping.
    const digest = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    return { version: `sha256:${digest}`, source: 'content_hash', csvPath: NAFDAC_CSV_PATH };
  } catch (err) {
    // A condition inferred without knowing which reference data classified the
    // drug is one nobody can audit later. Recording that the version is
    // unavailable is honest; inventing one would not be.
    return { version: 'unavailable', source: `error:${err.code || err.message}`, csvPath: NAFDAC_CSV_PATH };
  }
}

function getNafdacDatasetVersion() {
  if (!cached) cached = computeVersion();
  return cached.version;
}

function getNafdacDatasetVersionInfo() {
  if (!cached) cached = computeVersion();
  return { ...cached };
}

/** Testing seam — forces the next read to recompute. */
function resetNafdacDatasetVersionCache() {
  cached = null;
}

module.exports = {
  getNafdacDatasetVersion,
  getNafdacDatasetVersionInfo,
  resetNafdacDatasetVersionCache,
  NAFDAC_CSV_PATH,
};
