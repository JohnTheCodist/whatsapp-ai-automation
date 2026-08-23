/**
 * Cross-catalogue near-duplicate review — names too close to be sure they're
 * different products, but not found anywhere in NAFDAC to confirm they're
 * the SAME one either.
 *
 * WHY THIS IS SEPARATE FROM THE IMPORT-TIME NAFDAC ANCHOR
 * productBuilder already collapses a typo when one spelling resolves to a
 * real NAFDAC generic and the misspelling is close enough to be that same
 * typo — see the natural_key comment there. This module is for what NAFDAC
 * cannot settle: the registry doesn't list every drug sold in Nigeria, so
 * two genuinely unrecognised names that look alike could be a typo, or they
 * could be two real, different products NAFDAC has simply never heard of
 * either. Guessing wrong either way is a mistake a pharmacist can catch in
 * seconds and this code cannot — so it surfaces the pair and stops there,
 * for the Inventory screen to show under the product list.
 */

const { levenshtein, normalizeProductText } = require('../ingestion/productNormalizer');
const { getSql, assertPharmacyId, readWithRetry } = require('../db');

function normaliseStrength(s) {
  return s ? String(s).toLowerCase().replace(/\s+/g, '') : '';
}

/** Close enough to need a human's eyes, not identical and not unrelated. */
function looksLikeTypo(a, b) {
  if (a === b) return false;
  const maxLen = Math.max(a.length, b.length);
  // Below this, a couple of edits reaches unrelated short words too easily
  // ("Zinc" vs "Zafi") to mean anything.
  if (maxLen < 6) return false;
  const maxDist = maxLen >= 10 ? 2 : 1;
  if (Math.abs(a.length - b.length) > maxDist) return false;
  return levenshtein(a, b) <= maxDist;
}

// A bucket this large means "same strength" isn't discriminating anything
// (e.g. hundreds of untracked items all missing a real strength value) —
// comparing every pair would be O(n^2) for a grouping that tells us nothing.
const MAX_BUCKET = 200;

/**
 * Pairs of active products, sharing a strength, both unrecognised by any
 * reference (brand KB or NAFDAC), whose names are one or two edits apart.
 *
 * Never merged automatically — this is advisory only, for a person to
 * resolve by editing their source file and re-uploading.
 */
async function findUnverifiedDuplicates(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const rows = await readWithRetry(() => db`
    select id, name, strength, form
    from products
    where pharmacy_id = ${pharmacyId}
      and status != 'archived'
      and data_flags @> '["unrecognised_product"]'::jsonb
  `);

  const buckets = new Map();
  for (const row of rows) {
    const key = normaliseStrength(row.strength);
    // No strength to bucket on — too noisy to compare safely, would just be
    // "every unrecognised product in the catalogue" in one group.
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const pairs = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > MAX_BUCKET) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      const a = bucket[i];
      const aText = normalizeProductText(a.name);
      for (let j = i + 1; j < bucket.length; j += 1) {
        const b = bucket[j];
        const bText = normalizeProductText(b.name);
        if (looksLikeTypo(aText, bText)) {
          pairs.push({
            a: { id: a.id, name: a.name, strength: a.strength, form: a.form },
            b: { id: b.id, name: b.name, strength: b.strength, form: b.form },
            distance: levenshtein(aText, bText),
          });
        }
      }
    }
  }

  return pairs;
}

module.exports = { findUnverifiedDuplicates };
