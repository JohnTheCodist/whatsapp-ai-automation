/**
 * Purchase-based condition inference.
 *
 * PURE. Takes resolved purchases, returns condition findings. No database, no
 * network, no clock of its own — `now` is injected so a recency calculation is
 * testable on any day. Everything it decides is reproducible from its inputs,
 * which is what makes an audit record meaningful rather than decorative.
 *
 * WHAT THIS IS ALLOWED TO CONCLUDE
 * That a patient's purchase history is consistent with a condition, for
 * pharmacy tracking. Not that they have been diagnosed with it. The status
 * value carries that distinction — CONFIRMED_BY_PURCHASE, never CONFIRMED —
 * so the evidence basis cannot be lost between here and a screen.
 *
 * THE CHAIN, WHICH IS THE WHOLE DESIGN
 *   transaction -> source product -> NAFDAC match -> active ingredients
 *              -> therapeutic subgroup -> condition -> evidence level
 * Each link is recorded on the finding, so "why is this patient classified
 * under hypertension" is answered by reading the finding rather than by
 * re-deriving it and hoping the derivation still matches.
 *
 * NO DRUG NAMES LIVE IN THIS FILE. The only thing that turns a product into a
 * condition is the configured subgroup mapping. That is deliberate: a
 * medication name in here would be a clinical rule nobody could review as
 * configuration.
 */

const {
  ACCEPTED_MATCH_STATUSES,
  MIN_MATCH_CONFIDENCE,
  CONFIDENCE_WEIGHTS,
  CONFIDENCE_TARGETS,
  RECENT_PURCHASE_DAYS,
  STALE_PENDING_DAYS,
  ENGINE_VERSION,
  conditionForSubgroup,
  conditionName,
  thresholdsFor,
} = require('../../config/conditionMappings');

const EVIDENCE_LEVELS = Object.freeze(['NONE', 'WEAK', 'MODERATE', 'STRONG', 'CONFIRMED']);

const STATUS = Object.freeze({
  PENDING: 'PENDING_PURCHASE_EVIDENCE',
  CONFIRMED: 'CONFIRMED_BY_PURCHASE',
  INACTIVE: 'INACTIVE_PURCHASE_EVIDENCE',
});

/** Why a purchase was not allowed to support any condition. */
const REJECTED = Object.freeze({
  NO_SUBGROUP: 'NO_THERAPEUTIC_SUBGROUP',
  UNMAPPED_SUBGROUP: 'SUBGROUP_NOT_MAPPED_TO_CONDITION',
  MATCH_STATUS: 'MATCH_STATUS_NOT_ACCEPTED',
  LOW_CONFIDENCE: 'MATCH_CONFIDENCE_BELOW_MINIMUM',
  DUPLICATE: 'DUPLICATE_TRANSACTION',
});

const DAY_MS = 86400000;

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / DAY_MS));
}

/**
 * The transaction identity used for deduplication.
 *
 * Mirrors the rule the analytics layer already counts transactions by
 * (services/db.js): a receipt is `invoice_ref` on a given date, and a row
 * without an invoice reference is its own transaction because nothing else
 * can distinguish it. Reusing that rule matters — two parts of the product
 * disagreeing about what "a transaction" means is how the same import gets
 * counted once on a dashboard and twice in a condition profile.
 *
 * The product is part of the key: one receipt listing amlodipine AND
 * metformin is two qualifying purchases, one per condition, not one.
 */
function transactionKey(purchase) {
  const invoice = purchase.invoice_ref == null ? '' : String(purchase.invoice_ref).trim();
  const product = purchase.product_id == null
    ? (purchase.source_product_name || '')
    : String(purchase.product_id);
  if (invoice) return `inv:${invoice}|${purchase.sale_date || ''}|p:${product}`;
  // No invoice reference: fall back to the row's own identity, which is the
  // same thing the analytics count does.
  const rowId = purchase.sale_id == null ? '' : String(purchase.sale_id);
  return `row:${rowId}|${purchase.sale_date || ''}|p:${product}`;
}

/**
 * Is this purchase resolved well enough to carry clinical weight?
 *
 * Returns the rejection reason, or null when the purchase qualifies. Reasons
 * are returned rather than logged so the caller can show a pharmacist exactly
 * which purchases were set aside and why — a silently ignored purchase looks
 * identical to one that was never uploaded.
 */
function rejectionReason(purchase) {
  const status = purchase.match_status || purchase.resolution_status || null;
  if (!ACCEPTED_MATCH_STATUSES.includes(status)) return REJECTED.MATCH_STATUS;

  const confidence = Number(
    purchase.match_confidence != null ? purchase.match_confidence : purchase.resolution_confidence,
  );
  // NaN fails this comparison, which is the intended direction: an unreadable
  // confidence is not a high one.
  if (!(confidence >= MIN_MATCH_CONFIDENCE)) return REJECTED.LOW_CONFIDENCE;

  const subgroup = purchase.therapeutic_subgroup || null;
  if (!subgroup) return REJECTED.NO_SUBGROUP;
  if (!conditionForSubgroup(subgroup)) return REJECTED.UNMAPPED_SUBGROUP;

  return null;
}

/** Saturating 0..1 score. Reaching `target` scores 1; there is no bonus past it. */
function saturate(value, target) {
  if (!target || target <= 0) return 0;
  return Math.min(1, Math.max(0, value / target));
}

function round(n, places = 4) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Deterministic confidence in the PURCHASE EVIDENCE.
 *
 * A plain weighted sum of six numbers the pharmacy's own records produce. No
 * model output is an input here, by design: a language model's stated
 * certainty about a classification it just generated is not evidence about a
 * patient.
 */
function computeConfidence({ purchases, distinctMedications, spanDays, daysSinceLast, minMatchConfidence }) {
  const w = CONFIDENCE_WEIGHTS;
  const t = CONFIDENCE_TARGETS;

  // The weakest link, not the average — see the weight's comment in config.
  const productMatch = Math.min(1, Math.max(0, minMatchConfidence));
  // The mapping is an allowlist, so a mapped subgroup is a certain
  // classification. There is no partial credit to give.
  const therapeuticMatch = 1;
  const volume = saturate(purchases, t.purchases);
  const diversity = saturate(distinctMedications, t.distinctMedications);
  const consistency = saturate(spanDays == null ? 0 : spanDays, t.spanDays);
  const recency = daysSinceLast == null
    ? 0
    : Math.max(0, 1 - (daysSinceLast / t.recencyWindowDays));

  const score = (w.productMatch * productMatch)
    + (w.therapeuticMatch * therapeuticMatch)
    + (w.purchaseVolume * volume)
    + (w.medicationDiversity * diversity)
    + (w.consistency * consistency)
    + (w.recency * recency);

  return {
    confidence: round(Math.min(1, Math.max(0, score))),
    components: {
      productMatch: round(productMatch),
      therapeuticMatch: round(therapeuticMatch),
      purchaseVolume: round(volume),
      medicationDiversity: round(diversity),
      consistency: round(consistency),
      recency: round(recency),
    },
  };
}

/** Does this evidence meet one threshold rung? */
function meetsRung(rung, { purchases, distinctMedications, spanDays }) {
  if (!rung) return false;
  if (purchases < (rung.purchases || 0)) return false;
  if (rung.distinctMedications && distinctMedications < rung.distinctMedications) return false;
  if (rung.spanDays && (spanDays == null || spanDays < rung.spanDays)) return false;
  if (rung.anyOf) {
    const byMeds = rung.anyOf.distinctMedications
      && distinctMedications >= rung.anyOf.distinctMedications;
    const bySpan = rung.anyOf.spanDays
      && spanDays != null && spanDays >= rung.anyOf.spanDays;
    if (!byMeds && !bySpan) return false;
  }
  return true;
}

/** The highest evidence level this patient's qualifying purchases reach. */
function evidenceLevelFor(conditionCode, stats) {
  const thresholds = thresholdsFor(conditionCode);
  let level = 'NONE';
  for (const candidate of ['WEAK', 'MODERATE', 'STRONG', 'CONFIRMED']) {
    if (meetsRung(thresholds[candidate], stats)) level = candidate;
  }
  return level;
}

function atLeast(level, floor) {
  return EVIDENCE_LEVELS.indexOf(level) >= EVIDENCE_LEVELS.indexOf(floor);
}

/**
 * A readable statement of why, generated from the same numbers that made the
 * decision. Deterministic on purpose: an explanation produced separately from
 * the decision is an explanation that can contradict it.
 */
function buildReason({ conditionCode, status, level, stats, subgroups, products, datasetVersion }) {
  const name = conditionName(conditionCode);
  if (status === STATUS.CONFIRMED) {
    return `Patient has ${stats.purchases} deduplicated high-confidence pharmacy `
      + `transaction${stats.purchases === 1 ? '' : 's'} for ${stats.distinctMedications} `
      + `distinct medicine${stats.distinctMedications === 1 ? '' : 's'} resolved to the `
      + `${subgroups.join(', ')} therapeutic subgroup${subgroups.length === 1 ? '' : 's'}, `
      + `spanning ${stats.spanDays == null ? 0 : stats.spanDays} days. Evidence level ${level}, `
      + `which meets the configured confirmation threshold for ${name}. `
      + `Supporting products: ${products.join('; ')}. NAFDAC dataset: ${datasetVersion}.`;
  }
  if (status === STATUS.INACTIVE) {
    return `Patient has ${stats.purchases} qualifying pharmacy transaction`
      + `${stats.purchases === 1 ? '' : 's'} for ${name}, below the configured confirmation `
      + `threshold, and the most recent is ${stats.daysSinceLast} days old. Recorded as `
      + `historical purchase evidence rather than a confirmed condition.`;
  }
  return `Patient has ${stats.purchases} qualifying pharmacy transaction`
    + `${stats.purchases === 1 ? '' : 's'} for ${name} (evidence level ${level}), which is below `
    + `the configured confirmation threshold. More purchase evidence is needed before this is `
    + `treated as a tracked condition.`;
}

/**
 * Evaluate one patient's purchases.
 *
 * @param {object[]} purchases  resolved purchase rows. Expected fields:
 *   sale_id, invoice_ref, sale_date, product_id,
 *   source_product_name, matched_product_name, matched_product_id,
 *   active_ingredients (string[]), therapeutic_subgroup,
 *   match_status, match_confidence, resolution_method
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @param {string} [options.nafdacDatasetVersion]
 * @returns {{findings: object[], rejected: object[], evaluatedAt: string, engineVersion: string}}
 */
function evaluatePatient(purchases = [], { now = new Date(), nafdacDatasetVersion = null } = {}) {
  const seen = new Set();
  const byCondition = new Map();
  const rejected = [];

  for (const purchase of purchases) {
    const key = transactionKey(purchase);

    // Deduplication runs BEFORE qualification, so an import that landed twice
    // cannot inflate a count. This is the same identity the analytics layer
    // counts by — see transactionKey.
    if (seen.has(key)) {
      rejected.push({
        transaction_key: key,
        sale_id: purchase.sale_id ?? null,
        source_product_name: purchase.source_product_name ?? null,
        reason: REJECTED.DUPLICATE,
      });
      continue;
    }
    seen.add(key);

    const reason = rejectionReason(purchase);
    if (reason) {
      rejected.push({
        transaction_key: key,
        sale_id: purchase.sale_id ?? null,
        source_product_name: purchase.source_product_name ?? null,
        therapeutic_subgroup: purchase.therapeutic_subgroup ?? null,
        match_status: purchase.match_status ?? purchase.resolution_status ?? null,
        match_confidence: purchase.match_confidence ?? purchase.resolution_confidence ?? null,
        reason,
      });
      continue;
    }

    const conditionCode = conditionForSubgroup(purchase.therapeutic_subgroup);
    if (!byCondition.has(conditionCode)) byCondition.set(conditionCode, []);

    // ONE contribution per purchase per condition, even for a combination
    // product whose ingredients all belong to the same therapeutic domain.
    // Co-Aprovel is irbesartan AND hydrochlorothiazide, both antihypertensive;
    // counting it twice would let a single pack look like a treatment regimen.
    byCondition.get(conditionCode).push({
      transaction_key: key,
      sale_id: purchase.sale_id ?? null,
      invoice_ref: purchase.invoice_ref ?? null,
      sale_date: purchase.sale_date ?? null,
      // Never discarded. The dashboard shows what the pharmacy actually sold;
      // the engine reasons over the resolved identity.
      source_product_name: purchase.source_product_name ?? null,
      matched_product_id: purchase.matched_product_id ?? null,
      matched_product_name: purchase.matched_product_name ?? null,
      active_ingredients: Array.isArray(purchase.active_ingredients)
        ? purchase.active_ingredients
        : (purchase.active_ingredients ? [purchase.active_ingredients] : []),
      therapeutic_subgroup: purchase.therapeutic_subgroup,
      match_status: purchase.match_status ?? purchase.resolution_status ?? null,
      match_confidence: Number(
        purchase.match_confidence != null ? purchase.match_confidence : purchase.resolution_confidence,
      ),
      resolution_method: purchase.resolution_method ?? null,
    });
  }

  const findings = [];

  for (const [conditionCode, supporting] of byCondition) {
    const dates = supporting.map((s) => toDate(s.sale_date)).filter(Boolean).sort((a, b) => a - b);
    const first = dates.length ? dates[0] : null;
    const last = dates.length ? dates[dates.length - 1] : null;
    const spanDays = daysBetween(first, last);
    const daysSinceLast = last ? daysBetween(last, now) : null;

    // "Distinct medications" counts distinct ACTIVE INGREDIENT SETS, not
    // distinct product rows. Two brands of amlodipine are one medicine; buying
    // both is a repeat purchase, not a second agent. Counting products here
    // would let brand-switching masquerade as combination therapy.
    const medicationKeys = new Set(
      supporting.map((s) => (s.active_ingredients.length
        ? s.active_ingredients.map((i) => String(i).trim().toLowerCase()).sort().join('+')
        : String(s.matched_product_name || s.source_product_name || '').toLowerCase())),
    );

    const stats = {
      purchases: supporting.length,
      distinctMedications: medicationKeys.size,
      spanDays,
      daysSinceLast,
    };

    const level = evidenceLevelFor(conditionCode, stats);
    const thresholds = thresholdsFor(conditionCode);
    const confirmed = atLeast(level, thresholds.confirmAt);

    let status;
    if (confirmed) {
      // Never downgraded by time. A patient who stopped collecting their
      // medicine is not a patient who stopped having the condition; that is
      // what purchase_status is for.
      status = STATUS.CONFIRMED;
    } else if (daysSinceLast != null && daysSinceLast > STALE_PENDING_DAYS) {
      status = STATUS.INACTIVE;
    } else {
      status = STATUS.PENDING;
    }

    const minMatchConfidence = supporting.reduce(
      (min, s) => Math.min(min, Number.isFinite(s.match_confidence) ? s.match_confidence : 0),
      1,
    );
    const { confidence, components } = computeConfidence({ ...stats, minMatchConfidence });

    const subgroups = [...new Set(supporting.map((s) => s.therapeutic_subgroup))];
    const ingredients = [...new Set(supporting.flatMap((s) => s.active_ingredients).map((i) => String(i).trim()))]
      .filter(Boolean);
    const productNames = [...new Set(supporting.map((s) => s.source_product_name).filter(Boolean))];

    findings.push({
      condition_code: conditionCode,
      condition_name: conditionName(conditionCode),
      status,
      evidence_type: 'PHARMACY_PURCHASE',
      evidence_strength: level,
      // Purchase exposure, not adherence. A dispensing record cannot say
      // whether anyone took the medicine.
      purchase_status: (daysSinceLast != null && daysSinceLast <= RECENT_PURCHASE_DAYS)
        ? 'ACTIVE_PURCHASE'
        : 'NO_RECENT_PURCHASE',
      first_observed: first ? first.toISOString().slice(0, 10) : null,
      last_observed: last ? last.toISOString().slice(0, 10) : null,
      days_since_last_purchase: daysSinceLast,
      supporting_transaction_count: stats.purchases,
      supporting_product_count: productNames.length,
      supporting_products: productNames,
      supporting_ingredients: ingredients,
      therapeutic_subgroups: subgroups,
      confidence,
      confidence_components: components,
      // The full chain, per supporting transaction. This is what makes the
      // finding reconstructable rather than merely reported.
      evidence_chain: supporting,
      thresholds_applied: thresholds,
      nafdac_dataset_version: nafdacDatasetVersion,
      engine_version: ENGINE_VERSION,
      reason: buildReason({
        conditionCode, status, level, stats, subgroups,
        products: productNames, datasetVersion: nafdacDatasetVersion || 'unknown',
      }),
    });
  }

  // Stable order, so two runs over the same data produce byte-identical
  // output and a diff between evaluations means something changed.
  findings.sort((a, b) => a.condition_code.localeCompare(b.condition_code));

  return {
    findings,
    rejected,
    evaluatedAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    nafdacDatasetVersion,
  };
}

module.exports = {
  evaluatePatient,
  computeConfidence,
  evidenceLevelFor,
  transactionKey,
  rejectionReason,
  buildReason,
  EVIDENCE_LEVELS,
  STATUS,
  REJECTED,
};
