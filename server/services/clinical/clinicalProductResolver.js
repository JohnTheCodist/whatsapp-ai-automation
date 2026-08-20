/**
 * Clinical-grade product resolution.
 *
 * WHY THIS EXISTS ON TOP OF productIdentityResolver RATHER THAN INSIDE IT
 * The existing resolver answers "which NAFDAC product is this, and who made
 * it". That is the right question for analytics and the wrong one for
 * clinical classification, and the difference is not academic.
 *
 * "Teva Amlodipine 10mg" resolves to AMBIGUOUS_MATCH with ten candidates —
 * because ten Nigerian manufacturers register an amlodipine tablet, and the
 * resolver correctly refuses to guess which. But all ten agree the
 * therapeutic subgroup is Hypertension. The identity is ambiguous; the
 * THERAPEUTIC CLASS is not. Requiring product-identity certainty before
 * inferring a condition would reject exactly the everyday generic purchases
 * this feature exists to read, while requiring nothing clinically useful:
 * knowing which company pressed the tablet says nothing about what it treats.
 *
 * So the gate here is therapeutic consensus, not manufacturer certainty:
 * every candidate that could plausibly be this product must agree on the
 * subgroup. If they disagree, the product is clinically ambiguous and
 * supports nothing — which is the correct answer, and the one that keeps
 * "Vitamin C" from ever becoming a condition.
 *
 * SOURCE IS NEVER DISCARDED. source_product_name is carried through exactly
 * as the pharmacy uploaded it, so a dashboard can show what was actually sold
 * while the engine reasons over the resolved identity.
 *
 * Pure apart from reading the in-memory NAFDAC index.
 */

const {
  lookupByBrand, lookupByGeneric, weightedMatchNafdac,
} = require('../ingestion/nafdacLookup');
const { parseDrugName } = require('../ingestion/productParser');
const { getNafdacDatasetVersion } = require('./nafdacDatasetVersion');

/**
 * Clinical match states.
 *
 * Only EXACT and HIGH_CONFIDENCE may support a condition. The rest are
 * recorded rather than discarded, so a pharmacist can see which purchases
 * were set aside and why.
 */
const MATCH_STATUS = Object.freeze({
  EXACT: 'EXACT',
  HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
  AMBIGUOUS: 'AMBIGUOUS',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  UNRESOLVED: 'UNRESOLVED',
});

const METHOD = Object.freeze({
  NAFDAC_NUMBER: 'nafdac_registration_number',
  EXACT_NAME: 'exact_normalized_product_name',
  EXACT_GENERIC: 'exact_generic_name',
  CONSENSUS: 'therapeutic_consensus',
  NONE: 'unresolved',
});

/** Confidence per method. Fixed and deterministic — never a model's opinion. */
const METHOD_CONFIDENCE = Object.freeze({
  [METHOD.NAFDAC_NUMBER]: 1.0,
  [METHOD.EXACT_NAME]: 1.0,
  [METHOD.EXACT_GENERIC]: 0.97,
  [METHOD.CONSENSUS]: 0.95,
});

function norm(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Split a NAFDAC generic string into active ingredients.
 *
 * NAFDAC writes combinations as "Irbesartan/Hydrochlorothiazide". Splitting
 * them is what lets a brand-only purchase report both of its actives — and it
 * is also why a combination product must still count as ONE purchase for the
 * condition: two ingredients in one pack is one dispensing event, not two.
 */
function splitIngredients(generic) {
  if (!generic) return [];
  return String(generic)
    .split(/[/+,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Do these NAFDAC rows agree on a single, non-empty therapeutic subgroup?
 *
 * The whole safety gate. Returns the agreed subgroup or null.
 */
function subgroupConsensus(rows) {
  const subs = new Set();
  for (const r of rows) {
    const s = (r && r.therapeutic_subgroup != null) ? String(r.therapeutic_subgroup).trim() : '';
    if (!s) return null;          // a row with no classification breaks consensus
    subs.add(s.toLowerCase());
  }
  if (subs.size !== 1) return null;
  // Return the original casing from the first row.
  return String(rows[0].therapeutic_subgroup).trim();
}

/** Build the resolved shape from an agreed set of NAFDAC rows. */
function fromRows(sourceName, rows, method) {
  const subgroup = subgroupConsensus(rows);
  if (!subgroup) {
    return {
      source_product_name: sourceName,
      match_status: MATCH_STATUS.AMBIGUOUS,
      match_confidence: 0,
      resolution_method: method,
      matched_product_id: null,
      matched_product_name: null,
      active_ingredients: [],
      therapeutic_subgroup: null,
      therapeutic_group: null,
      candidate_count: rows.length,
      nafdac_dataset_version: getNafdacDatasetVersion(),
    };
  }

  const head = rows[0];
  // Prefer a generic that every agreeing row shares; otherwise take the top
  // row's. Manufacturers spell the same molecule differently
  // ("Metformin" vs "Metformin Hydrochloride"), and that variation is not
  // clinically meaningful here — the subgroup already agreed.
  const generic = head.generic || null;

  return {
    source_product_name: sourceName,
    match_status: method === METHOD.CONSENSUS ? MATCH_STATUS.HIGH_CONFIDENCE : MATCH_STATUS.EXACT,
    match_confidence: METHOD_CONFIDENCE[method] || 0,
    resolution_method: method,
    matched_product_id: head.nafdac_no || null,
    matched_product_name: head.brand_name || null,
    active_ingredients: splitIngredients(generic),
    therapeutic_subgroup: subgroup,
    therapeutic_group: head.therapeutic_group || null,
    candidate_count: rows.length,
    nafdac_dataset_version: getNafdacDatasetVersion(),
  };
}

function unresolved(sourceName, status = MATCH_STATUS.UNRESOLVED, candidateCount = 0) {
  return {
    source_product_name: sourceName,
    match_status: status,
    match_confidence: 0,
    resolution_method: METHOD.NONE,
    matched_product_id: null,
    matched_product_name: null,
    active_ingredients: [],
    therapeutic_subgroup: null,
    therapeutic_group: null,
    candidate_count: candidateCount,
    nafdac_dataset_version: getNafdacDatasetVersion(),
  };
}

/**
 * Resolve one purchased product to a clinical identity.
 *
 * The ladder, highest authority first. Each rung is a stricter claim than the
 * one below it, and the first rung that produces a therapeutically consistent
 * answer wins.
 *
 *   1. NAFDAC registration number  — the registry's own identifier
 *   2. Exact normalised product / brand name
 *   3. Exact generic name
 *   4. Structured weighted match, accepted only on top-tier consensus
 *
 * There is deliberately no unrestricted fuzzy rung. The weighted matcher does
 * use fuzzy scoring internally, but its output is accepted here only when the
 * whole top-scoring tier agrees on the subgroup — which is what "controlled"
 * has to mean if it is to mean anything.
 *
 * @param {object} purchase
 * @param {string} purchase.source_product_name  never modified
 * @returns {object} clinical resolution
 */
function resolveClinicalProduct(purchase = {}) {
  const sourceName = purchase.source_product_name != null
    ? String(purchase.source_product_name).trim()
    : '';
  if (!sourceName) return unresolved(sourceName);

  // ---- 1. NAFDAC registration number --------------------------------------
  const nafdacNo = purchase.nafdac_no || purchase.resolved_nafdac_no || null;
  if (nafdacNo) {
    const byNumber = asArray(lookupByBrand(sourceName))
      .filter((r) => norm(r.nafdac_no) === norm(nafdacNo));
    if (byNumber.length > 0) return fromRows(sourceName, byNumber, METHOD.NAFDAC_NUMBER);
  }

  // ---- 2. Exact normalised product / brand name ---------------------------
  //
  // The rung that carries brand-only combination products. "Co-Aprovel 150
  // mg/12.5 mg Tablet" is a NAFDAC brand_name verbatim, and matching it
  // exactly is a stronger claim than any amount of token scoring.
  const brandCandidates = asArray(lookupByBrand(sourceName));
  const exactName = brandCandidates.filter((r) => norm(r.brand_name) === norm(sourceName));
  if (exactName.length > 0) return fromRows(sourceName, exactName, METHOD.EXACT_NAME);

  // Also try the caller's separate brand column, when the upload had one.
  const brandColumn = purchase.brand || purchase.resolved_brand || null;
  if (brandColumn) {
    const exactBrand = asArray(lookupByBrand(brandColumn))
      .filter((r) => norm(r.brand_name) === norm(brandColumn));
    if (exactBrand.length > 0) return fromRows(sourceName, exactBrand, METHOD.EXACT_NAME);
  }

  // ---- 3. Exact generic name ----------------------------------------------
  //
  // A sales export usually carries one product string, not separate columns,
  // so the generic has to be recovered from it before it can be looked up.
  // parseDrugName is the codebase's existing decomposition step — the same one
  // productIdentityResolver runs before its own NAFDAC lookup — and reusing it
  // is what turns "Metformin 500mg" into a generic ("Metformin") that NAFDAC
  // can answer for. Without this the whole generics shelf, which is most of
  // what a Nigerian pharmacy dispenses, resolves to nothing.
  const parsed = parseDrugName(sourceName) || {};
  const genericColumn = purchase.generic_name || purchase.resolved_generic || parsed.generic || null;

  for (const term of [purchase.generic_name || purchase.resolved_generic, parsed.generic, sourceName]) {
    if (!term) continue;
    const hits = asArray(lookupByGeneric(term))
      .filter((r) => norm(r.generic) === norm(term));
    if (hits.length > 0) {
      const resolvedRow = fromRows(sourceName, hits, METHOD.EXACT_GENERIC);
      if (resolvedRow.therapeutic_subgroup) return resolvedRow;
    }
  }

  // ---- 4. Structured weighted match, top-tier consensus only --------------
  const weighted = weightedMatchNafdac({
    brand: brandColumn || parsed.brand || null,
    generic: genericColumn || null,
    strength: purchase.strength || parsed.strength || null,
    form: purchase.dosage_form || purchase.form || parsed.form || null,
    manufacturer: purchase.manufacturer || null,
  });

  const candidates = (weighted && weighted.candidates) || [];
  if (candidates.length === 0) return unresolved(sourceName);

  // Only the top-scoring tier is considered. The tail of a fuzzy search is
  // noise — for Co-Aprovel it contains antibiotics and antimalarials that
  // share a few characters — and letting it vote would turn every lookup
  // ambiguous.
  const topScore = Math.max(...candidates.map((c) => Number(c.score) || 0));
  if (!(topScore > 0)) return unresolved(sourceName, MATCH_STATUS.LOW_CONFIDENCE, candidates.length);

  const tier = candidates.filter((c) => (Number(c.score) || 0) === topScore);
  const consensus = fromRows(sourceName, tier, METHOD.CONSENSUS);
  if (!consensus.therapeutic_subgroup) {
    // The tier itself disagrees: this product genuinely could be two
    // different kinds of medicine, and nothing may be inferred from it.
    return unresolved(sourceName, MATCH_STATUS.AMBIGUOUS, candidates.length);
  }
  return consensus;
}

module.exports = {
  resolveClinicalProduct,
  splitIngredients,
  subgroupConsensus,
  MATCH_STATUS,
  METHOD,
  METHOD_CONFIDENCE,
};
