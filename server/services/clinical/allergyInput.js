/**
 * The vocabulary of an allergy record, and the contract for writing one.
 *
 * PURE. The lists here ARE the record: what a pharmacist may say an allergy
 * is, how it presented, and how sure anyone is. One place, so the form, the
 * validator and the screen cannot offer or accept three different sets.
 * The database CHECKs in 0058 hold the same lists as a second line.
 *
 * THE DEFAULTS ARE THE HONEST ONES. A new record is type 'unknown' (not
 * every reaction is an allergy), verification 'unconfirmed' (someone said
 * it; nobody has checked), and no severity or criticality is assumed.
 *
 * NOTHING HERE RANKS, SCORES OR SUGGESTS. Criticality is what a pharmacist
 * judged, not something computed from the reactions.
 */

const { readPartialDate } = require('./partialDate');

const CATEGORIES = Object.freeze([
  { value: 'medication', label: 'Medication' },
  { value: 'food', label: 'Food' },
  { value: 'environmental', label: 'Environmental' },
  { value: 'biologic', label: 'Biologic' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Unknown' },
]);

/** Not every adverse reaction is an allergy (brief §22). */
const TYPES = Object.freeze([
  { value: 'allergy', label: 'Allergy' },
  { value: 'intolerance', label: 'Intolerance' },
  { value: 'unknown', label: 'Unknown' },
]);

/** Is it current? */
const CLINICAL_STATUSES = Object.freeze([
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'resolved', label: 'Resolved' },
]);

/** Is it true? */
const VERIFICATION_STATUSES = Object.freeze([
  { value: 'unconfirmed', label: 'Unconfirmed' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'entered_in_error', label: 'Entered in error' },
]);

/** A record that says it is not true. Never active, always with a reason. */
const UNTRUE = Object.freeze(['refuted', 'entered_in_error']);

/**
 * How dangerous the NEXT exposure could be — not how bad the last one was.
 * That difference is why this and SEVERITIES are two lists.
 */
const CRITICALITIES = Object.freeze([
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'unable_to_assess', label: 'Unable to assess' },
]);

/** How bad the reaction that happened was. */
const SEVERITIES = Object.freeze([
  { value: 'mild', label: 'Mild' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
  { value: 'unknown', label: 'Unknown' },
]);

const EXPOSURE_ROUTES = Object.freeze([
  { value: 'oral', label: 'By mouth' },
  { value: 'topical', label: 'On the skin' },
  { value: 'injection', label: 'Injection' },
  { value: 'inhaled', label: 'Inhaled' },
  { value: 'other', label: 'Other' },
]);

/** Who said so. The person who typed it is recorded separately. */
const SOURCES = Object.freeze([
  { value: 'patient', label: 'Patient reported' },
  { value: 'guardian', label: 'Parent or guardian reported' },
  { value: 'previous_record', label: 'Previous medical record' },
  { value: 'prescriber', label: 'Prescriber' },
  { value: 'pharmacist', label: 'Pharmacist' },
  { value: 'other', label: 'Other' },
]);

/** The brief's list, in its order. */
const MANIFESTATIONS = Object.freeze([
  { value: 'rash', label: 'Rash' },
  { value: 'hives', label: 'Hives' },
  { value: 'itching', label: 'Itching' },
  { value: 'swelling', label: 'Swelling' },
  { value: 'facial_swelling', label: 'Facial swelling' },
  { value: 'lip_tongue_swelling', label: 'Lip or tongue swelling' },
  { value: 'wheezing', label: 'Wheezing' },
  { value: 'shortness_of_breath', label: 'Shortness of breath' },
  { value: 'nausea', label: 'Nausea' },
  { value: 'vomiting', label: 'Vomiting' },
  { value: 'diarrhoea', label: 'Diarrhoea' },
  { value: 'dizziness', label: 'Dizziness' },
  { value: 'fainting', label: 'Fainting' },
  { value: 'anaphylaxis', label: 'Anaphylaxis' },
  { value: 'other', label: 'Other' },
]);

/**
 * Common allergens for the allergen search. A vocabulary, not patient data.
 *
 * Individual medicines come from the NAFDAC register. What the register
 * cannot offer is a DRUG CLASS — and allergies are very often recorded by
 * class ("allergic to penicillins", "sulfa allergy"). Those few classes
 * are here, marked `drugClass`, and no individual medicine is.
 */
const COMMON_ALLERGENS = Object.freeze([
  { key: 'penicillins', label: 'Penicillins (drug class)', category: 'medication', drugClass: true },
  { key: 'cephalosporins', label: 'Cephalosporins (drug class)', category: 'medication', drugClass: true },
  { key: 'sulfonamides', label: 'Sulfonamides / sulfa drugs (drug class)', category: 'medication', drugClass: true },
  { key: 'nsaids', label: 'NSAIDs (drug class)', category: 'medication', drugClass: true },
  { key: 'opioids', label: 'Opioids (drug class)', category: 'medication', drugClass: true },
  { key: 'peanut', label: 'Peanuts', category: 'food' },
  { key: 'tree_nut', label: 'Tree nuts', category: 'food' },
  { key: 'shellfish', label: 'Shellfish', category: 'food' },
  { key: 'fish', label: 'Fish', category: 'food' },
  { key: 'egg', label: 'Eggs', category: 'food' },
  { key: 'milk', label: 'Milk', category: 'food' },
  { key: 'wheat', label: 'Wheat / gluten', category: 'food' },
  { key: 'soya', label: 'Soya', category: 'food' },
  { key: 'latex', label: 'Latex', category: 'environmental' },
  { key: 'pollen', label: 'Pollen', category: 'environmental' },
  { key: 'dust_mite', label: 'Dust mites', category: 'environmental' },
  { key: 'animal_dander', label: 'Animal dander', category: 'environmental' },
  { key: 'insect_sting', label: 'Insect stings', category: 'environmental' },
  { key: 'mould', label: 'Mould', category: 'environmental' },
  { key: 'plaster', label: 'Adhesive plaster', category: 'environmental' },
]);

/**
 * Only a pharmacist or owner may say a record is TRUE or UNTRUE, or that the
 * patient has no known allergies — those are the claims the next person
 * relies on to decide it is safe (ALLERGIES_PLAN.md §7). Anyone on the team
 * may write down what a patient said, as unconfirmed.
 */
const CLINICAL_ROLES = Object.freeze(['owner', 'pharmacist']);
const PHARMACIST_VERIFICATIONS = Object.freeze(['confirmed', 'refuted', 'entered_in_error']);

const MAX_REACTIONS = 15;
// Permissive after the prefix: NAFDAC names carry "&", "%", apostrophes, and
// a few combination vitamins run past 190 characters. The 200-character cap
// on the field (readAllergenCode) is the length limit.
const ALLERGEN_CODE_RE = /^(nafdac|common):[^\r\n]+$/;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_ALLERGY';
  err.field = field;
  return err;
}

function text(field, raw, max) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > max) throw invalid(field, `${field} cannot be longer than ${max} characters.`);
  return s;
}

function oneOf(field, raw, list) {
  const s = text(field, raw, 60);
  if (s === null) return null;
  if (!list.some((o) => o.value === s)) throw invalid(field, `Unknown ${field} "${s}".`);
  return s;
}

/**
 * A date a patient may only half-know.
 *
 *   "2021"        -> { date: '2021-01-01', precision: 'year' }
 *   "2021-03"     -> { date: '2021-03-01', precision: 'month' }
 *   "2021-03-15"  -> { date: '2021-03-15', precision: 'day' }
 *   "" / null     -> { date: null, precision: null }   unknown, a real answer
 *
 * The precision is read from the SHAPE of what was typed, so a form never
 * has to send a second field that can disagree with the first.
 */
function partialDate(field, raw, today) {
  return readPartialDate(field, raw, today, invalid);
}

/** The reactions, each one manifestation. Order kept. */
function readReactions(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('reactions', 'Reactions must be a list.');
  if (raw.length > MAX_REACTIONS) throw invalid('reactions', `No more than ${MAX_REACTIONS} reactions.`);
  const seen = new Set();
  return raw.map((r, i) => {
    // A bare string is accepted — the form's chips send just the code.
    const item = typeof r === 'string' ? { manifestation: r } : (r || {});
    const manifestation = oneOf('reactions', item.manifestation, MANIFESTATIONS);
    if (!manifestation) throw invalid('reactions', `Reaction ${i + 1} has no type.`);
    const description = text('reactions', item.description, 300);
    if (manifestation === 'other' && !description) {
      throw invalid('otherReaction', 'Say what the other reaction was.');
    }
    if (manifestation !== 'other') {
      if (seen.has(manifestation)) throw invalid('reactions', 'That reaction is already listed.');
      seen.add(manifestation);
    }
    return { manifestation, description };
  });
}

function readAllergenCode(raw) {
  const s = text('allergenCode', raw, 200);
  if (s === null) return null;
  if (!ALLERGEN_CODE_RE.test(s)) throw invalid('allergenCode', 'Unknown allergen code.');
  return s;
}

/**
 * The status rules that hold for any complete record, create or edit.
 * Kept in one place so a patch cannot reach a state a create could not.
 */
function checkStatus(rec) {
  if (UNTRUE.includes(rec.verificationStatus)) {
    // A record that is not true is not a current allergy.
    if (rec.clinicalStatus === 'active') rec.clinicalStatus = 'inactive';
    if (!rec.statusReason) {
      throw invalid('statusReason', rec.verificationStatus === 'refuted'
        ? 'Say why this allergy was refuted.'
        : 'Say why this was entered in error.');
    }
  }
  return rec;
}

/**
 * A new allergy.
 *
 * @param {object} body
 * @param {{ today: string }} opts  Lagos date, injected
 */
function readAllergyInput(body = {}, { today } = {}) {
  const allergenName = text('allergenName', body.allergenName, 200);
  if (!allergenName) throw invalid('allergenName', 'Say what the patient reacts to.');
  const onset = partialDate('onset', body.onset, today);
  const last = partialDate('lastOccurrence', body.lastOccurrence, today);
  if (onset.date && last.date && last.date < onset.date) {
    throw invalid('lastOccurrence', 'The last reaction cannot be before the first.');
  }

  return checkStatus({
    allergenName,
    allergenCode: readAllergenCode(body.allergenCode),
    category: oneOf('category', body.category, CATEGORIES) || 'unknown',
    type: oneOf('type', body.type, TYPES) || 'unknown',
    clinicalStatus: oneOf('clinicalStatus', body.clinicalStatus, CLINICAL_STATUSES) || 'active',
    verificationStatus: oneOf('verificationStatus', body.verificationStatus, VERIFICATION_STATUSES) || 'unconfirmed',
    criticality: oneOf('criticality', body.criticality, CRITICALITIES),
    severity: oneOf('severity', body.severity, SEVERITIES),
    exposureRoute: oneOf('exposureRoute', body.exposureRoute, EXPOSURE_ROUTES),
    onsetDate: onset.date,
    onsetPrecision: onset.precision,
    lastOccurrenceDate: last.date,
    lastOccurrencePrecision: last.precision,
    source: oneOf('source', body.source, SOURCES) || 'patient',
    notes: text('notes', body.notes, 2000),
    statusReason: text('statusReason', body.statusReason, 500),
    reactions: readReactions(body.reactions),
  });
}

/**
 * An edit. Only what is present in the body changes; `reactions`, when
 * present, replaces the list wholesale (a removed reaction must not linger).
 *
 * The status rules are checked by the service against the MERGED record —
 * see mergeForCheck — because "refuted with no reason" can only be judged
 * once the stored reason is known.
 */
const PATCHABLE = Object.freeze({
  allergenName: (v) => {
    const s = text('allergenName', v, 200);
    if (!s) throw invalid('allergenName', 'Say what the patient reacts to.');
    return s;
  },
  allergenCode: readAllergenCode,
  category: (v) => oneOf('category', v, CATEGORIES) || 'unknown',
  type: (v) => oneOf('type', v, TYPES) || 'unknown',
  clinicalStatus: (v) => oneOf('clinicalStatus', v, CLINICAL_STATUSES) || 'active',
  verificationStatus: (v) => oneOf('verificationStatus', v, VERIFICATION_STATUSES) || 'unconfirmed',
  criticality: (v) => oneOf('criticality', v, CRITICALITIES),
  severity: (v) => oneOf('severity', v, SEVERITIES),
  exposureRoute: (v) => oneOf('exposureRoute', v, EXPOSURE_ROUTES),
  source: (v) => oneOf('source', v, SOURCES) || 'patient',
  notes: (v) => text('notes', v, 2000),
  statusReason: (v) => text('statusReason', v, 500),
  reactions: readReactions,
});

function readAllergyPatch(body = {}, { today } = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'onset')) {
    const d = partialDate('onset', body.onset, today);
    patch.onsetDate = d.date;
    patch.onsetPrecision = d.precision;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'lastOccurrence')) {
    const d = partialDate('lastOccurrence', body.lastOccurrence, today);
    patch.lastOccurrenceDate = d.date;
    patch.lastOccurrencePrecision = d.precision;
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

/**
 * The stored record with the patch applied, run through the same status
 * rules as a create. Returns the patch — possibly with clinicalStatus moved
 * off 'active' — or throws.
 */
function mergeForCheck(before, patch) {
  const merged = checkStatus({ ...before, ...patch });
  if (merged.onsetDate && merged.lastOccurrenceDate && merged.lastOccurrenceDate < merged.onsetDate) {
    throw invalid('lastOccurrence', 'The last reaction cannot be before the first.');
  }
  // Correcting a record back to true clears a reason that no longer applies.
  const out = { ...patch, clinicalStatus: merged.clinicalStatus };
  if (!UNTRUE.includes(merged.verificationStatus) && UNTRUE.includes(before.verificationStatus)
      && !Object.prototype.hasOwnProperty.call(patch, 'statusReason')) {
    out.statusReason = null;
  }
  return out;
}

/**
 * Does writing this need a pharmacist or owner?
 *
 * @param {object} next    the fields being written (create input or patch)
 * @param {object} [before] the stored record, for an edit
 */
function needsClinicalRole(next, before = null) {
  const v = next.verificationStatus;
  if (!v) return false;
  if (before && before.verificationStatus === v) return false;
  return PHARMACIST_VERIFICATIONS.includes(v);
}

function hasClinicalRole(role) {
  return CLINICAL_ROLES.includes(role);
}

/** Everything a form may offer, so it cannot show a value the server refuses. */
function allergyOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    categories: pick(CATEGORIES),
    types: pick(TYPES),
    clinicalStatuses: pick(CLINICAL_STATUSES),
    verificationStatuses: pick(VERIFICATION_STATUSES),
    criticalities: pick(CRITICALITIES),
    severities: pick(SEVERITIES),
    exposureRoutes: pick(EXPOSURE_ROUTES),
    sources: pick(SOURCES),
    manifestations: pick(MANIFESTATIONS),
  };
}

module.exports = {
  CATEGORIES, TYPES, CLINICAL_STATUSES, VERIFICATION_STATUSES, UNTRUE, CRITICALITIES,
  SEVERITIES, EXPOSURE_ROUTES, SOURCES, MANIFESTATIONS, COMMON_ALLERGENS, CLINICAL_ROLES,
  readAllergyInput, readAllergyPatch, mergeForCheck, needsClinicalRole, hasClinicalRole,
  allergyOptions, partialDate,
};
