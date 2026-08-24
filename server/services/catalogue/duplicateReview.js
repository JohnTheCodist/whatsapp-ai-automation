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

const { levenshtein, normalizeProductText, normalizeProductName } = require('../ingestion/productNormalizer');
const { fuzzyResolveGeneric } = require('../ingestion/nafdacLookup');
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
 * Can NAFDAC put a name to this product at all?
 *
 * NOT the `unrecognised_product` data flag, which was what this module
 * filtered on first and which answers a different question. That flag is set
 * when there is no generic worth DISPLAYING — including when the generic is
 * simply already contained in the product name — so "Omeprazole 20mg", a
 * drug NAFDAC knows perfectly well, carries it. Filtering on it put pairs in
 * front of a pharmacist under a heading promising the opposite, and quietly
 * broke the safety argument: the reason a look-alike pair cannot reach this
 * panel is that both halves resolve, which the flag does not test.
 *
 * Asked live rather than read from import time, so the answer reflects the
 * NAFDAC data loaded now instead of whatever was true when the row was
 * written.
 */
function resolvesInNafdac(name, cache) {
  if (cache.has(name)) return cache.get(name);
  const identity = normalizeProductName(name);
  const hit = Boolean(fuzzyResolveGeneric(identity.generic || name));
  cache.set(name, hit);
  return hit;
}

/**
 * Near-identical product names sharing a strength, split by whether anything
 * can settle them.
 *
 * @returns {Promise<{pairs: object[], willMergeOnReimport: number}>}
 *   `pairs` — NAFDAC cannot name at least one side, so no automatic answer
 *   exists and a person has to look. Never merged here; the caller shows
 *   them and stops.
 *   `willMergeOnReimport` — a count of pairs NAFDAC names on BOTH sides.
 *   productBuilder's natural_key anchor already collapses those, so they are
 *   rows predating that behaviour and re-uploading resolves them.
 */
async function findUnverifiedDuplicates(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const rows = await readWithRetry(() => db`
    select id, name, strength, form
    from products
    where pharmacy_id = ${pharmacyId}
      and status != 'archived'
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
  // Seen by NAME PAIR, not by row id. A catalogue that already holds two rows
  // called "Ciprofloxacin 500mg" and two called "Cirpofloxacin 500mg"
  // produces four id-combinations of one question, and asking a pharmacist
  // the same question four times is how a review panel stops being read.
  const seen = new Set();
  // Resolution is looked up lazily and memoised: fuzzyResolveGeneric walks
  // every registered generic, so doing it for the whole catalogue up front
  // would be thousands of edit-distance passes to answer a question that
  // only matters for names already sitting in a candidate pair.
  const cache = new Map();
  let willMergeOnReimport = 0;

  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > MAX_BUCKET) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      const a = bucket[i];
      const aText = normalizeProductText(a.name);
      for (let j = i + 1; j < bucket.length; j += 1) {
        const b = bucket[j];
        const bText = normalizeProductText(b.name);
        if (!looksLikeTypo(aText, bText)) continue;

        // Keyed on the sorted PAIR itself, not on the two names glued together
        // with a separator. Any separator has to be a character normalised
        // product text cannot contain — otherwise "ab" + "c d" and "ab c" + "d"
        // key the same — and the obvious safe choice, a NUL, cannot appear in
        // source without making the file binary to grep, diff and review tools.
        const key = JSON.stringify([aText, bText].sort());
        if (seen.has(key)) continue;
        seen.add(key);

        // BOTH resolve: productBuilder's natural_key anchor already collapses
        // these, so they are rows left over from before that existed rather
        // than a question anyone needs to answer. Telling someone to "check
        // by hand" would be wrong advice — re-uploading fixes them.
        if (resolvesInNafdac(a.name, cache) && resolvesInNafdac(b.name, cache)) {
          willMergeOnReimport += 1;
          continue;
        }

        // Neither resolves, or exactly one does. The one-sided case reaches
        // here only when the other name was too far or too AMBIGUOUS for
        // NAFDAC to name — the look-alike guard refusing to choose — which
        // is precisely a pair a person should look at.
        pairs.push({
          a: { id: a.id, name: a.name, strength: a.strength, form: a.form },
          b: { id: b.id, name: b.name, strength: b.strength, form: b.form },
          distance: levenshtein(aText, bText),
        });
      }
    }
  }

  return { pairs, willMergeOnReimport };
}

module.exports = {
  findUnverifiedDuplicates,
  // Exported for tests. This is the whole "is this pair worth a human's
  // eyes" rule, pure and DB-free, and it is the part where being slightly
  // too eager or slightly too shy changes what a pharmacist is asked to
  // check — worth pinning directly rather than only through a live query.
  looksLikeTypo,
};
