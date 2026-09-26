/**
 * The vocabulary of a condition record (the problem list), and the contract
 * for writing one.
 *
 * PURE. One place for the lists, so the form, the validator and the screen
 * cannot drift. The database CHECKs in 0059 hold the same lists.
 *
 * THE DEFAULTS ARE THE HONEST ONES. A new condition is 'unconfirmed' until
 * someone says otherwise — writing down "the patient says they have asthma"
 * is not the same as a pharmacist confirming it, and the record must not
 * read as though it were.
 *
 * NOTHING HERE DIAGNOSES. The catalogue is a list to pick from, not a
 * suggestion engine. The symptom and allergy hints are words shown to the
 * pharmacist, never a refusal and never an automatic change.
 */

const { readPartialDate } = require('./partialDate');

const CATEGORIES = Object.freeze([
  { value: 'problem_list', label: 'Problem list' },
  { value: 'chronic', label: 'Chronic' },
  { value: 'acute', label: 'Acute' },
  // FHIR's "encounter-diagnosis": recorded for one consultation, not
  // necessarily a long-term problem.
  { value: 'encounter_diagnosis', label: 'Diagnosis at a consultation' },
  { value: 'other', label: 'Other' },
]);

/** The six FHIR clinical statuses. The screen groups them — see GROUPS. */
const CLINICAL_STATUSES = Object.freeze([
  { value: 'active', label: 'Active' },
  { value: 'recurrence', label: 'Recurrence' },
  { value: 'relapse', label: 'Relapse' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'remission', label: 'In remission' },
  { value: 'resolved', label: 'Resolved' },
]);

/** Statuses that mean "affecting the patient now". */
const CURRENT_STATUSES = Object.freeze(['active', 'recurrence', 'relapse']);
/** Statuses that may carry a resolution / remission date. */
const ABATED_STATUSES = Object.freeze(['inactive', 'remission', 'resolved']);

const VERIFICATION_STATUSES = Object.freeze([
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'provisional', label: 'Provisional' },
  { value: 'unconfirmed', label: 'Unconfirmed' },
  { value: 'differential', label: 'Differential' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'entered_in_error', label: 'Entered in error' },
]);

/** A record that says it is not true. Never current, always with a reason. */
const UNTRUE = Object.freeze(['refuted', 'entered_in_error']);
/** Certain enough to read without a qualifier. Everything else is shown as uncertain. */
const CERTAIN = Object.freeze(['confirmed']);

const SEVERITIES = Object.freeze([
  { value: 'mild', label: 'Mild' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'severe', label: 'Severe' },
  { value: 'unknown', label: 'Unknown' },
]);

const SOURCES = Object.freeze([
  { value: 'patient', label: 'Patient reported' },
  { value: 'previous_record', label: 'Previous medical record' },
  { value: 'prescriber', label: 'Prescriber' },
  { value: 'pharmacist', label: 'Pharmacist' },
  { value: 'laboratory', label: 'Laboratory or diagnostic result' },
  { value: 'other', label: 'Other' },
]);

/**
 * Common community-pharmacy conditions, to pick from. NOT a limit: free text
 * is always accepted, and a terminology service can replace this list
 * without a schema change (code_system + code are plain columns).
 *
 * Codes are WHO ICD-10 categories. `local` is the house code the purchase
 * engine and medication indications already use, where one exists, so a
 * recorded condition can be matched to them without being merged.
 */
const CATALOGUE = Object.freeze([
  { name: 'Hypertension', code: 'I10', local: 'HYPERTENSION', category: 'chronic' },
  { name: 'Type 2 diabetes mellitus', code: 'E11', local: 'DIABETES', category: 'chronic' },
  { name: 'Type 1 diabetes mellitus', code: 'E10', local: 'DIABETES', category: 'chronic' },
  { name: 'Gestational diabetes', code: 'O24.4', local: 'DIABETES', category: 'chronic' },
  { name: 'Asthma', code: 'J45', local: 'ASTHMA_OR_COPD', category: 'chronic' },
  { name: 'Chronic obstructive pulmonary disease (COPD)', code: 'J44.9', local: 'ASTHMA_OR_COPD', category: 'chronic' },
  { name: 'Hyperlipidaemia', code: 'E78.5', local: 'DYSLIPIDEMIA', category: 'chronic' },
  { name: 'Osteoarthritis', code: 'M19.9', category: 'chronic' },
  { name: 'Rheumatoid arthritis', code: 'M06.9', category: 'chronic' },
  { name: 'Gout', code: 'M10.9', category: 'chronic' },
  { name: 'Osteoporosis', code: 'M81.9', category: 'chronic' },
  { name: 'Migraine', code: 'G43.9', category: 'chronic' },
  { name: 'Epilepsy', code: 'G40.9', category: 'chronic' },
  { name: 'Peptic ulcer disease', code: 'K27.9', category: 'chronic' },
  { name: 'Gastro-oesophageal reflux disease (GORD)', code: 'K21.9', category: 'chronic' },
  { name: 'Irritable bowel syndrome', code: 'K58.9', category: 'chronic' },
  { name: 'Haemorrhoids', code: 'K64.9', category: 'chronic' },
  { name: 'Sickle cell disease', code: 'D57.1', category: 'chronic' },
  { name: 'Iron deficiency anaemia', code: 'D50.9', category: 'chronic' },
  { name: 'Hypothyroidism', code: 'E03.9', category: 'chronic' },
  { name: 'Hyperthyroidism', code: 'E05.9', category: 'chronic' },
  { name: 'Obesity', code: 'E66.9', category: 'chronic' },
  { name: 'Heart failure', code: 'I50.9', category: 'chronic' },
  { name: 'Ischaemic heart disease', code: 'I25.9', category: 'chronic' },
  { name: 'Atrial fibrillation', code: 'I48.9', category: 'chronic' },
  { name: 'Stroke (history of)', code: 'I64', category: 'chronic' },
  { name: 'Chronic kidney disease', code: 'N18.9', category: 'chronic' },
  { name: 'Benign prostatic hyperplasia', code: 'N40', category: 'chronic' },
  { name: 'Glaucoma', code: 'H40.9', category: 'chronic' },
  { name: 'Depression', code: 'F32.9', category: 'chronic' },
  { name: 'Anxiety disorder', code: 'F41.9', category: 'chronic' },
  { name: 'Allergic rhinitis', code: 'J30.4', category: 'chronic' },
  { name: 'Eczema (atopic dermatitis)', code: 'L20.9', category: 'chronic' },
  { name: 'Psoriasis', code: 'L40.9', category: 'chronic' },
  { name: 'HIV infection', code: 'B24', category: 'chronic' },
  { name: 'Chronic hepatitis B', code: 'B18.1', category: 'chronic' },
  { name: 'Tuberculosis', code: 'A16.9', category: 'acute' },
  { name: 'Malaria', code: 'B54', category: 'acute' },
  { name: 'Typhoid fever', code: 'A01.0', category: 'acute' },
  { name: 'Gastroenteritis', code: 'A09', category: 'acute' },
  { name: 'Urinary tract infection', code: 'N39.0', category: 'acute' },
]);

/**
 * Words that usually name a SYMPTOM, not an established condition (brief
 * §20). Matching one shows a hint to the pharmacist and nothing else.
 */
const SYMPTOM_WORDS = Object.freeze([
  'headache', 'fever', 'cough', 'nausea', 'vomiting', 'diarrhoea', 'diarrhea', 'dizziness',
  'pain', 'ache', 'rash', 'itching', 'sore throat', 'catarrh', 'runny nose', 'fatigue',
  'tiredness', 'weakness', 'body pain', 'chest pain', 'stomach ache', 'cold',
]);

/**
 * Only a pharmacist or owner may say a diagnosis is CONFIRMED, list it as a
 * DIFFERENTIAL, or say a record is untrue. Anyone may write down what a
 * patient or a letter said, as unconfirmed or provisional. The same line as
 * the allergy record (CONDITIONS_PLAN.md §7).
 */
const CLINICAL_ROLES = Object.freeze(['owner', 'pharmacist']);
const PHARMACIST_VERIFICATIONS = Object.freeze(['confirmed', 'differential', 'refuted', 'entered_in_error']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_CODE_RE = /^[A-Z][A-Z0-9_]{1,59}$/;
const MAX_EVIDENCE = 20;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_CONDITION';
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

const date = (field, raw, today) => readPartialDate(field, raw, today, invalid);

function optionalId(field, raw) {
  const s = text(field, raw, 64);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw invalid(field, `Unknown ${field}.`);
  return s;
}

function readCode(body) {
  const system = text('codeSystem', body.codeSystem, 20);
  const code = text('code', body.code, 40);
  if (Boolean(system) !== Boolean(code)) throw invalid('code', 'A code needs its code system, and the other way round.');
  if (system && !['icd10', 'snomed', 'other'].includes(system)) throw invalid('codeSystem', `Unknown code system "${system}".`);
  const local = text('localCode', body.localCode, 60);
  if (local && !LOCAL_CODE_RE.test(local)) throw invalid('localCode', 'Unknown house condition code.');
  return { codeSystem: system, code, localCode: local };
}

function readEvidence(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('evidenceVitalsIds', 'Supporting readings must be a list.');
  if (raw.length > MAX_EVIDENCE) throw invalid('evidenceVitalsIds', `No more than ${MAX_EVIDENCE} supporting readings.`);
  return [...new Set(raw.map((v) => optionalId('evidenceVitalsIds', v)).filter(Boolean))];
}

/**
 * The status rules for a complete record — create, or an edit merged onto
 * what is stored. One function, so an edit cannot reach a state a create
 * could not.
 */
function checkStatus(rec) {
  if (UNTRUE.includes(rec.verificationStatus)) {
    if (CURRENT_STATUSES.includes(rec.clinicalStatus)) rec.clinicalStatus = 'inactive';
    if (!rec.statusReason) {
      throw invalid('statusReason', rec.verificationStatus === 'refuted'
        ? 'Say why this condition was refuted.'
        : 'Say why this was entered in error.');
    }
  }
  // A current condition has not resolved. Making one active again drops the
  // stale resolution date rather than refusing — see mergeForCheck.
  if (rec.abatementDate && !ABATED_STATUSES.includes(rec.clinicalStatus)) {
    throw invalid('abatement', 'Only a resolved, in-remission or inactive condition has a resolution date.');
  }
  if (rec.onsetDate && rec.abatementDate && rec.abatementDate < rec.onsetDate) {
    throw invalid('abatement', 'It cannot have resolved before it started.');
  }
  return rec;
}

/**
 * A new condition.
 *
 * @param {object} body
 * @param {{ today: string }} opts  Lagos date, injected
 */
function readProblemInput(body = {}, { today } = {}) {
  const conditionName = text('conditionName', body.conditionName, 200);
  if (!conditionName) throw invalid('conditionName', 'Say what the condition is.');
  const onset = date('onset', body.onset, today);
  const abatement = date('abatement', body.abatement, today);

  return checkStatus({
    conditionName,
    ...readCode(body),
    category: oneOf('category', body.category, CATEGORIES) || 'problem_list',
    clinicalStatus: oneOf('clinicalStatus', body.clinicalStatus, CLINICAL_STATUSES) || 'active',
    verificationStatus: oneOf('verificationStatus', body.verificationStatus, VERIFICATION_STATUSES) || 'unconfirmed',
    severity: oneOf('severity', body.severity, SEVERITIES),
    bodySite: text('bodySite', body.bodySite, 100),
    onsetDate: onset.date,
    onsetPrecision: onset.precision,
    onsetNote: text('onsetNote', body.onsetNote, 100),
    abatementDate: abatement.date,
    abatementPrecision: abatement.precision,
    source: oneOf('source', body.source, SOURCES) || 'patient',
    assertedByName: text('assertedByName', body.assertedByName, 200),
    encounterId: optionalId('encounterId', body.encounterId),
    notes: text('notes', body.notes, 2000),
    statusReason: text('statusReason', body.statusReason, 500),
    evidenceVitalsIds: readEvidence(body.evidenceVitalsIds),
    // "Continue anyway" on the duplicate prompt. Recorded in the audit event.
    allowDuplicate: body.allowDuplicate === true,
  });
}

const PATCHABLE = Object.freeze({
  conditionName: (v) => {
    const s = text('conditionName', v, 200);
    if (!s) throw invalid('conditionName', 'Say what the condition is.');
    return s;
  },
  category: (v) => oneOf('category', v, CATEGORIES) || 'problem_list',
  clinicalStatus: (v) => oneOf('clinicalStatus', v, CLINICAL_STATUSES) || 'active',
  verificationStatus: (v) => oneOf('verificationStatus', v, VERIFICATION_STATUSES) || 'unconfirmed',
  severity: (v) => oneOf('severity', v, SEVERITIES),
  bodySite: (v) => text('bodySite', v, 100),
  onsetNote: (v) => text('onsetNote', v, 100),
  source: (v) => oneOf('source', v, SOURCES) || 'patient',
  assertedByName: (v) => text('assertedByName', v, 200),
  encounterId: (v) => optionalId('encounterId', v),
  notes: (v) => text('notes', v, 2000),
  statusReason: (v) => text('statusReason', v, 500),
  evidenceVitalsIds: readEvidence,
});

/** An edit: only what is present changes. Code fields travel together. */
function readProblemPatch(body = {}, { today } = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  if (['codeSystem', 'code', 'localCode'].some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    Object.assign(patch, readCode(body));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'onset')) {
    const d = date('onset', body.onset, today);
    patch.onsetDate = d.date;
    patch.onsetPrecision = d.precision;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'abatement')) {
    const d = date('abatement', body.abatement, today);
    patch.abatementDate = d.date;
    patch.abatementPrecision = d.precision;
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

/**
 * The stored record with the patch applied, through the same rules as a
 * create. Returns the patch, adjusted: an untrue record moved off a current
 * status, a stale resolution date dropped when a condition becomes current
 * again, a stale reason dropped when a record is corrected back to true.
 */
function mergeForCheck(before, patch) {
  const next = { ...before, ...patch };
  const adjusted = { ...patch };
  // "Make active again" on a resolved condition: the old resolution date no
  // longer describes it. Dropped, not refused — unless the caller set a new
  // one in the same edit, which checkStatus will then refuse.
  if (CURRENT_STATUSES.includes(next.clinicalStatus) && next.abatementDate
      && !Object.prototype.hasOwnProperty.call(patch, 'abatementDate')) {
    next.abatementDate = null;
    next.abatementPrecision = null;
    adjusted.abatementDate = null;
    adjusted.abatementPrecision = null;
  }
  const merged = checkStatus(next);
  adjusted.clinicalStatus = merged.clinicalStatus;
  if (!UNTRUE.includes(merged.verificationStatus) && UNTRUE.includes(before.verificationStatus)
      && !Object.prototype.hasOwnProperty.call(patch, 'statusReason')) {
    adjusted.statusReason = null;
  }
  return adjusted;
}

function needsClinicalRole(next, before = null) {
  const v = next.verificationStatus;
  if (!v) return false;
  if (before && before.verificationStatus === v) return false;
  return PHARMACIST_VERIFICATIONS.includes(v);
}

function hasClinicalRole(role) {
  return CLINICAL_ROLES.includes(role);
}

/**
 * The words a pharmacist should see before saving — hints, never refusals.
 *   symptom  this reads like a symptom; it may belong in the consultation
 *   allergy  allergies have their own record
 */
function conditionHints(name) {
  const s = String(name || '').toLowerCase().trim();
  if (!s) return [];
  const hints = [];
  if (/\ballerg/.test(s)) hints.push('allergy');
  const inCatalogue = CATALOGUE.some((c) => c.name.toLowerCase() === s);
  if (!inCatalogue && SYMPTOM_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(s))) hints.push('symptom');
  return hints;
}

/** Search the catalogue: starts-with first, then a word start, then anywhere. */
function searchCatalogue(query, { limit = 12 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const score = (name) => {
    const l = name.toLowerCase();
    if (l === q) return 0;
    if (l.startsWith(q)) return 1;
    if (l.split(/[\s()/,-]+/).some((w) => w.startsWith(q))) return 2;
    if (l.includes(q)) return 3;
    return null;
  };
  return CATALOGUE
    .map((c) => ({ c, s: score(c.name) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map(({ c }) => ({
      name: c.name, codeSystem: 'icd10', code: c.code, localCode: c.local || null, category: c.category,
    }));
}

/** Everything a form may offer. */
function problemOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    categories: pick(CATEGORIES),
    clinicalStatuses: pick(CLINICAL_STATUSES),
    verificationStatuses: pick(VERIFICATION_STATUSES),
    severities: pick(SEVERITIES),
    sources: pick(SOURCES),
  };
}

module.exports = {
  CATEGORIES, CLINICAL_STATUSES, CURRENT_STATUSES, ABATED_STATUSES, VERIFICATION_STATUSES,
  UNTRUE, CERTAIN, SEVERITIES, SOURCES, CATALOGUE, SYMPTOM_WORDS, CLINICAL_ROLES,
  readProblemInput, readProblemPatch, mergeForCheck, needsClinicalRole, hasClinicalRole,
  conditionHints, searchCatalogue, problemOptions,
};
