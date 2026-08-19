/**
 * Condition mapping and evidence configuration.
 *
 * EVERYTHING TUNABLE ABOUT THE CONDITION ENGINE LIVES HERE.
 * The engine itself contains no medication names, no subgroup strings and no
 * threshold numbers. That separation is the point: adding a condition, or
 * deciding that two purchases is enough to confirm one, is a config change a
 * pharmacist can reason about — not a code change buried in an if-statement.
 *
 * THE MAPPING IS AN ALLOWLIST, AND THAT IS A SAFETY PROPERTY
 * A therapeutic subgroup produces a condition only if it appears below.
 * Everything else produces nothing. The NAFDAC dataset is real-world data and
 * contains genuine noise in this column — strengths ("5mg"), years ("2021"),
 * and raw ingredient lists all appear as subgroup values in the current
 * extract. An allowlist rejects all of it by construction, which is the
 * behaviour the false-positive rule asks for: "Vitamin C" cannot become
 * DIABETES unless something explicitly maps it there, and nothing does.
 *
 * SUBGROUP STRINGS ARE MATCHED CASE- AND SPACING-INSENSITIVELY
 * The values below are the literal strings NAFDAC uses, normalised through
 * normaliseSubgroup() so that "Asthma / COPD Agent", "asthma/copd agent" and
 * "Asthma / COPD  Agent" all resolve to the same key. They are matched whole —
 * never as substrings — so "Diabetes" cannot be found inside some longer,
 * unrelated classification string.
 */

/**
 * NAFDAC therapeutic subgroup -> RxNaija condition.
 *
 * Several subgroups may map to one condition, which is what makes the mapping
 * a table rather than a pair of enums. Nothing maps to two conditions: a
 * subgroup that genuinely implied two would need its own condition code, not
 * a fan-out that quietly doubles a patient's profile.
 */
const SUBGROUP_CONDITION_MAP = Object.freeze({
  // Antidiabetics. NAFDAC labels the subgroup with the condition name itself.
  diabetes: 'DIABETES',

  // Antihypertensives, likewise.
  hypertension: 'HYPERTENSION',

  // Asthma and COPD are NOT separated. NAFDAC classifies the agents together,
  // and the drugs genuinely overlap — a salbutamol inhaler is dispensed for
  // both. Splitting them here would mean inventing a distinction the source
  // data does not support and then displaying it as though it were known.
  'asthma / copd agent': 'ASTHMA_OR_COPD',

  'lipid-lowering': 'DYSLIPIDEMIA',
});

/** Display names. Kept beside the mapping so a new condition needs one edit. */
const CONDITION_NAMES = Object.freeze({
  DIABETES: 'Diabetes',
  HYPERTENSION: 'Hypertension',
  ASTHMA_OR_COPD: 'Asthma or COPD',
  DYSLIPIDEMIA: 'Dyslipidemia',
});

/**
 * Clinical match states a purchase must be in before it may support a
 * condition. These are clinicalProductResolver's states, not the analytics
 * resolver's.
 *
 * EXACT           — NAFDAC's own registration number, or an exact product /
 *                   brand / generic name, with the matched rows agreeing on
 *                   one therapeutic subgroup.
 * HIGH_CONFIDENCE — structured match whose entire top-scoring tier agrees on
 *                   the subgroup.
 *
 * Everything else is excluded: AMBIGUOUS (candidates disagree about what kind
 * of medicine this is), LOW_CONFIDENCE, UNRESOLVED. A wrong drug identity is
 * worse than no identity, and a condition built on a guess is a wrong drug
 * identity with a person's name attached to it.
 *
 * WHAT IS DELIBERATELY *NOT* REQUIRED: knowing which manufacturer made it.
 * Ten Nigerian companies register an amlodipine tablet and the analytics
 * resolver rightly calls that ambiguous — but all ten agree it treats
 * hypertension. Demanding manufacturer certainty would reject the ordinary
 * generic purchases this feature exists to read while proving nothing
 * clinical. See clinicalProductResolver's header.
 */
const ACCEPTED_MATCH_STATUSES = Object.freeze(['EXACT', 'HIGH_CONFIDENCE']);

/**
 * Floor on match confidence, applied on top of the status allowlist above.
 * Belt and braces: those states are only reachable with strong evidence, but
 * stating the requirement here means it does not depend on another module's
 * internals staying as they are.
 */
const MIN_MATCH_CONFIDENCE = 0.9;

/**
 * Evidence thresholds, per condition.
 *
 * Read as: to reach this level, a patient needs at least `purchases`
 * DEDUPLICATED qualifying transactions, and — where stated — at least
 * `distinctMedications` different qualifying medicines, or a purchase history
 * spanning at least `spanDays`.
 *
 * WHY ONE PURCHASE IS NOT A CONDITION
 * A single amlodipine purchase is genuinely ambiguous: it may be a chronic
 * patient, someone collecting for a relative, or a one-off. Confirming a
 * lifelong condition from it would be the single easiest way to fill this
 * system with false positives. One purchase therefore lands at WEAK and the
 * profile reads PENDING_PURCHASE_EVIDENCE, which is an honest description of
 * what a pharmacy actually knows at that point.
 *
 * `confirmAt` names the level at which status becomes CONFIRMED_BY_PURCHASE.
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  WEAK: { purchases: 1 },
  MODERATE: { purchases: 2 },
  STRONG: { purchases: 3, anyOf: { distinctMedications: 2, spanDays: 60 } },
  CONFIRMED: { purchases: 4, spanDays: 60 },
  confirmAt: 'STRONG',
});

/**
 * A single qualifying purchase confirms the condition immediately —
 * confirmAt: 'WEAK' instead of the default 'STRONG'. Chosen deliberately for
 * diabetes and hypertension only: a pharmacy dispensing amlodipine or
 * metformin at all is a meaningful signal on its own, and the product owner
 * wants these two tracked from the first purchase rather than waiting on
 * repeat evidence. Asthma/COPD and dyslipidemia keep the general, more
 * cautious default until a similar decision is made for them.
 */
const ONE_PURCHASE_CONFIRMS = Object.freeze({
  ...DEFAULT_THRESHOLDS,
  confirmAt: 'WEAK',
});

/**
 * Per-condition overrides. The lookup goes through here so tuning one
 * condition never means copying the whole table.
 */
const CONDITION_THRESHOLDS = Object.freeze({
  DIABETES: ONE_PURCHASE_CONFIRMS,
  HYPERTENSION: ONE_PURCHASE_CONFIRMS,
  // Joins the one-purchase group. A salbutamol inhaler or a steroid preventer
  // is not something a household buys casually — the signal is as strong as
  // metformin, and holding asthma to three purchases meant it effectively
  // never confirmed: the register showed nobody with asthma while inhalers
  // were going out of the door, which is worse than an over-eager count
  // because it reads as "we checked, there are none".
  ASTHMA_OR_COPD: ONE_PURCHASE_CONFIRMS,
  // Deliberately left at the cautious default. Statins are dispensed on a
  // single prescription for reasons that are not always ongoing lipid
  // management, and nobody has asked to track dyslipidemia yet.
  // Brought in line with the other three. A statin is not something a
  // pharmacy dispenses casually — one purchase is as meaningful a signal here
  // as an amlodipine purchase is for hypertension, and leaving this at STRONG
  // meant the register showed nothing for dyslipidemia while the underlying
  // purchases were sitting there unconfirmed.
  DYSLIPIDEMIA: ONE_PURCHASE_CONFIRMS,
});

/**
 * Confidence weights. Must sum to 1.
 *
 * Confidence answers "how strong is the PURCHASE EVIDENCE", not "how sure is
 * the model" — no LLM output feeds this. Each component is a number the
 * pharmacy's own records can produce, and the formula is a plain weighted sum
 * so that a pharmacist asking "why 0.82?" gets an arithmetic answer.
 */
const CONFIDENCE_WEIGHTS = Object.freeze({
  // How certain we are the purchased product is the drug we think it is.
  // Taken as the WEAKEST supporting match, not the average: one shaky
  // identification should not hide behind four solid ones.
  productMatch: 0.30,
  // How certain the therapeutic classification is. 1.0 when the subgroup came
  // from NAFDAC and is explicitly mapped; there is no partial credit, because
  // the mapping is an allowlist.
  therapeuticMatch: 0.20,
  // More qualifying purchases, more evidence. Saturating — see targets below.
  purchaseVolume: 0.20,
  // Several different qualifying medicines is stronger evidence than the same
  // one repeatedly: it looks like a treatment regimen rather than a repeat buy.
  medicationDiversity: 0.15,
  // Purchases spread over time look like management of a chronic condition.
  consistency: 0.10,
  // Recent evidence describes the patient now; old evidence describes history.
  recency: 0.05,
});

/**
 * Saturation points for the count-based components. Reaching the target scores
 * 1.0; there is no extra credit beyond it, so a patient with forty purchases
 * is not reported as more certainly hypertensive than one with six.
 */
const CONFIDENCE_TARGETS = Object.freeze({
  purchases: 6,
  distinctMedications: 3,
  spanDays: 180,
  // Recency decays linearly to zero across this window.
  recencyWindowDays: 365,
});

/**
 * A purchase older than this contributes to history but not to "currently
 * buying". Drives purchase_status, never status: a patient who stopped
 * collecting their medicine is a patient who stopped collecting their
 * medicine, not a patient who stopped having the condition.
 */
const RECENT_PURCHASE_DAYS = 180;

/**
 * Below-threshold evidence older than this is marked
 * INACTIVE_PURCHASE_EVIDENCE rather than left pending forever. Deliberately
 * only applies to evidence that never reached confirmation — a CONFIRMED
 * condition is never downgraded by the passage of time.
 */
const STALE_PENDING_DAYS = 730;

/** Bumped when the scoring or threshold semantics change. Stored on every evaluation. */
const ENGINE_VERSION = 'condition-engine/1.0.0';

/** Normalise a NAFDAC subgroup string for whole-value lookup. */
function normaliseSubgroup(value) {
  if (value == null) return null;
  const key = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  return key || null;
}

/**
 * The condition a therapeutic subgroup maps to, or null.
 *
 * Whole-value match only. Substring matching here would be a false-positive
 * generator: "Diabetes" appears inside plenty of strings that are not the
 * diabetes subgroup.
 */
function conditionForSubgroup(subgroup) {
  const key = normaliseSubgroup(subgroup);
  if (!key) return null;
  return SUBGROUP_CONDITION_MAP[key] || null;
}

function conditionName(code) {
  return CONDITION_NAMES[code] || code;
}

function thresholdsFor(conditionCode) {
  return CONDITION_THRESHOLDS[conditionCode] || DEFAULT_THRESHOLDS;
}

module.exports = {
  SUBGROUP_CONDITION_MAP,
  CONDITION_NAMES,
  ACCEPTED_MATCH_STATUSES,
  MIN_MATCH_CONFIDENCE,
  DEFAULT_THRESHOLDS,
  ONE_PURCHASE_CONFIRMS,
  CONDITION_THRESHOLDS,
  CONFIDENCE_WEIGHTS,
  CONFIDENCE_TARGETS,
  RECENT_PURCHASE_DAYS,
  STALE_PENDING_DAYS,
  ENGINE_VERSION,
  normaliseSubgroup,
  conditionForSubgroup,
  conditionName,
  thresholdsFor,
};
