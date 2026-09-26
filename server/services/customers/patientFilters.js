/**
 * The patient search's filters: what each one accepts, what it is called,
 * and how a query string becomes a validated filter set.
 *
 * PURE. No database, no clock the caller did not pass. The search service
 * (patientSearch.js) turns the result into SQL; the options endpoint sends
 * the same labels to the dashboard, so a filter is named in exactly one
 * place and the screen cannot offer a value the server would refuse.
 *
 * AN UNKNOWN VALUE IS A 400, NEVER IGNORED. A filter silently dropped
 * returns MORE patients than asked for — "risk: lapsed" misspelt would show
 * everyone, and a pharmacist working through that list would ring people
 * who are fine while believing they had found the ones who are not.
 */

const AGE_BANDS = Object.freeze([
  { value: 'under18', label: 'Under 18', min: 0, max: 17 },
  { value: '18-39', label: '18–39', min: 18, max: 39 },
  { value: '40-59', label: '40–59', min: 40, max: 59 },
  { value: '60plus', label: '60 and over', min: 60, max: null },
  { value: 'unknown', label: 'Not recorded', min: null, max: null },
]);

const GENDERS = Object.freeze([
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'unknown', label: 'Not recorded' },
]);

/**
 * "Last visit" is the most recent of: a WhatsApp message, an order, or a
 * dispense. Windows are in whole Lagos days before today.
 */
const LAST_VISIT = Object.freeze([
  { value: '7d', label: 'In the last 7 days', withinDays: 7 },
  { value: '30d', label: 'In the last 30 days', withinDays: 30 },
  { value: '90d', label: 'In the last 90 days', withinDays: 90 },
  { value: 'over90', label: 'More than 90 days ago', olderThanDays: 90 },
]);

/** Same bands as refillSchedule.refillStatus, so the list and the call list agree. */
const FOLLOW_UP = Object.freeze([
  { value: 'any', label: 'Any refill due' },
  { value: 'due', label: 'Due soon' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'lapsed', label: 'Lapsed' },
]);

/**
 * Three signals the system already records — no score is invented:
 *   red_flag   a danger sign detected in a consultation in the last 90 days
 *   lapsed     out of a followed medicine for 7 days or more
 *   follow_up  tagged "Pharmacist follow-up" by staff
 */
const RISK = Object.freeze([
  { value: 'any', label: 'Any risk flag' },
  { value: 'red_flag', label: 'Danger sign in a consultation' },
  { value: 'lapsed', label: 'Lapsed on a medicine' },
  { value: 'follow_up', label: 'Tagged for pharmacist follow-up' },
]);

/**
 * The chronic switch on the patients screen: one toggle for the two
 * conditions this pharmacy follows over years rather than days.
 *
 * It is NOT a medical definition of "chronic". It is the set of condition
 * codes the purchase engine actually confirms today, which is why the codes
 * live here beside the engine's own identifiers rather than in the
 * dashboard. When the engine learns a third — asthma is the likely one — it
 * is added here and the switch covers it everywhere at once.
 *
 * Deliberately separate from the Condition filter. Condition answers "who
 * has diabetes"; this answers "show me the people I follow", which is the
 * state a pharmacist works in all morning, and the two must be able to
 * narrow each other rather than overwrite one another.
 */
const CHRONIC_CONDITIONS = Object.freeze(['DIABETES', 'HYPERTENSION']);

const RED_FLAG_WINDOW_DAYS = 90;
const MAX_TEXT = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Condition codes are the engine's own identifiers (DIABETES, HYPERTENSION).
const CONDITION_RE = /^[A-Z][A-Z0-9_]{1,59}$/;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_FILTER';
  err.field = field;
  return err;
}

function textOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  return s || null;
}

function oneOf(field, value, options) {
  if (value === null) return null;
  if (!options.some((o) => o.value === value)) {
    throw invalid(field, `Unknown ${field} filter "${value}".`);
  }
  return value;
}

/**
 * Query string → validated filters. Every key is optional; absent and empty
 * both mean "not filtering on this".
 *
 * @param {object} query  e.g. req.query
 * @returns {{
 *   q: string|null, age: string|null, gender: string|null, condition: string|null,
 *   chronic: boolean,
 *   medication: string|null, lastVisit: string|null, followUp: string|null,
 *   pharmacist: string|null, risk: string|null, limit: number
 * }}
 */
function readPatientFilters(query = {}) {
  const q = textOrNull(query.q);
  if (q && q.length > MAX_TEXT) throw invalid('q', `Search text cannot be longer than ${MAX_TEXT} characters.`);

  const medication = textOrNull(query.medication);
  if (medication && medication.length > MAX_TEXT) {
    throw invalid('medication', `Medication cannot be longer than ${MAX_TEXT} characters.`);
  }

  const condition = textOrNull(query.condition);
  if (condition && !CONDITION_RE.test(condition)) throw invalid('condition', `Unknown condition "${condition}".`);

  // A pharmacist is a user id, or "unassigned".
  const pharmacist = textOrNull(query.pharmacist);
  if (pharmacist && pharmacist !== 'unassigned' && !UUID_RE.test(pharmacist)) {
    throw invalid('pharmacist', 'Unknown pharmacist.');
  }

  // A switch, so only its ON value is spellable. Anything else is a 400 for
  // the same reason as every other filter here: "chronic=yes" quietly
  // ignored would show the whole list while the switch read as on.
  const rawChronic = textOrNull(query.chronic);
  if (rawChronic !== null && rawChronic !== 'on') {
    throw invalid('chronic', `chronic must be "on" or absent, not "${rawChronic}".`);
  }
  const chronic = rawChronic === 'on';

  let limit = DEFAULT_LIMIT;
  const rawLimit = textOrNull(query.limit);
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1) throw invalid('limit', 'limit must be a whole number, 1 or more.');
    limit = Math.min(n, MAX_LIMIT);
  }

  return {
    q,
    age: oneOf('age', textOrNull(query.age), AGE_BANDS),
    gender: oneOf('gender', textOrNull(query.gender), GENDERS),
    condition,
    chronic,
    medication,
    lastVisit: oneOf('lastVisit', textOrNull(query.lastVisit), LAST_VISIT),
    followUp: oneOf('followUp', textOrNull(query.followUp), FOLLOW_UP),
    pharmacist,
    risk: oneOf('risk', textOrNull(query.risk), RISK),
    limit,
  };
}

/** The age band's inclusive bounds; null max means open-ended. */
function ageBand(value) {
  return AGE_BANDS.find((b) => b.value === value) || null;
}

/** Labels for the fixed filters, as sent to the dashboard. */
function fixedOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    age: pick(AGE_BANDS),
    gender: pick(GENDERS),
    lastVisit: pick(LAST_VISIT),
    followUp: pick(FOLLOW_UP),
    risk: pick(RISK),
  };
}

module.exports = {
  AGE_BANDS, GENDERS, LAST_VISIT, FOLLOW_UP, RISK, CHRONIC_CONDITIONS,
  RED_FLAG_WINDOW_DAYS, DEFAULT_LIMIT, MAX_LIMIT,
  readPatientFilters, ageBand, fixedOptions,
};
