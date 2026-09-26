/**
 * The vocabulary of a care programme, and the contract for recording one.
 *
 * PURE. One place for the lists, so the form, the validator and the screen
 * cannot drift; the CHECKs in 0061 hold the same lists.
 *
 * NOTHING HERE DECIDES CARE. It does not choose a programme for a patient,
 * generate a goal, infer that a goal was met, or score a programme. It checks
 * that what a pharmacist typed is a thing the record can hold, and it expands
 * a template the pharmacist chose into rows they can then edit or delete.
 *
 * THE TWO PIECES OF ARITHMETIC, both deliberate and both dumb:
 *   - `nextDue` adds a recurrence interval to a date. That is how a repeating
 *     task gets its next occurrence, and it is the only scheduling in the
 *     feature.
 *   - `progressFrom` COUNTS goals and activities. Counts, never a percentage:
 *     "8 of 12 tasks done" is a fact about admin, and a percentage beside a
 *     patient's name reads as a statement about the patient.
 *
 * Dates come from refillSchedule's Lagos calendar, because this product must
 * not grow a second idea of what day it is.
 */

const { VITALS, vital } = require('./vitalRanges');
const { addDays, isIsoDate } = require('../refills/refillSchedule');

/** Where a programme is in its life. */
const PROGRAM_STATUSES = Object.freeze([
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'discontinued', label: 'Discontinued' },
  { value: 'cancelled', label: 'Cancelled' },
]);

/** Being followed, or about to be. */
const OPEN_STATUSES = Object.freeze(['planned', 'active', 'on_hold']);
/** Over. Each one says how it ended, and the row is kept forever. */
const ENDED_STATUSES = Object.freeze(['completed', 'discontinued', 'cancelled']);
/**
 * Ending a course of care is a clinical statement, so only a pharmacist or
 * owner may make it — the same rule as confirming an allergy (0058) or
 * finalising a report (0060). Anyone may enrol, plan and tick off tasks.
 */
const CLOSING_STATUSES = Object.freeze(['completed', 'discontinued', 'cancelled']);
const CLINICAL_ROLES = Object.freeze(['owner', 'pharmacist']);

/** How it ended, when it ended well enough to say. */
const OUTCOMES = Object.freeze([
  { value: 'achieved', label: 'Goals achieved' },
  { value: 'partially_achieved', label: 'Partly achieved' },
  { value: 'not_achieved', label: 'Not achieved' },
  { value: 'transferred', label: 'Care transferred' },
  { value: 'other', label: 'Other' },
]);

const DISCONTINUATION_REASONS = Object.freeze([
  { value: 'patient_withdrew', label: 'Patient withdrew' },
  { value: 'transferred_care', label: 'Transferred to another provider' },
  { value: 'no_longer_applicable', label: 'No longer applicable' },
  { value: 'lost_to_follow_up', label: 'Lost to follow-up' },
  { value: 'clinical_decision', label: 'Clinical decision' },
  { value: 'other', label: 'Other' },
]);

const GOAL_STATUSES = Object.freeze([
  { value: 'planned', label: 'Planned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'achieved', label: 'Achieved' },
  { value: 'not_achieved', label: 'Not achieved' },
  { value: 'cancelled', label: 'Cancelled' },
]);
const GOAL_SETTLED = Object.freeze(['achieved', 'not_achieved']);

/**
 * What kind of thing a task is — ONE list, used by the care plan and by the
 * Follow-up queue (0062 holds the same sixteen in its CHECK).
 *
 * The first nine came from the care plan; the rest are the follow-up brief's
 * types (§6). They are one vocabulary because "what kind of thing is this" is
 * one question: a programme activity may perfectly well be a medication
 * review, and a follow-up may perfectly well be a vaccination. One label per
 * value, so two screens cannot name the same kind two ways.
 */
const ACTIVITY_KINDS = Object.freeze([
  { value: 'assessment', label: 'Assessment' },
  { value: 'review', label: 'Review' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'counselling', label: 'Counselling' },
  { value: 'test', label: 'Test or lab review' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'vaccination', label: 'Vaccination' },
  { value: 'referral', label: 'Referral follow-up' },
  { value: 'clinical_review', label: 'Clinical review' },
  { value: 'medication_review', label: 'Medication review' },
  { value: 'condition_monitoring', label: 'Condition monitoring' },
  { value: 'adherence', label: 'Adherence follow-up' },
  { value: 'lifestyle', label: 'Lifestyle follow-up' },
  { value: 'care_program_review', label: 'Care programme review' },
  { value: 'appointment', label: 'Appointment follow-up' },
  { value: 'other', label: 'Other' },
]);

const ACTIVITY_STATUSES = Object.freeze([
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'cancelled', label: 'Cancelled' },
]);
/** Still to do. What the task list shows and what "overdue" is counted from. */
const ACTIVITY_OPEN = Object.freeze(['not_started', 'in_progress']);
/** Not doing it. Both say why. */
const ACTIVITY_DROPPED = Object.freeze(['skipped', 'cancelled']);

const RECURRENCE_UNITS = Object.freeze([
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
]);

/** What an activity produced, or what a pharmacist attached to a programme. */
const LINK_KINDS = Object.freeze([
  { value: 'condition', label: 'Condition' },
  { value: 'medication', label: 'Medicine' },
  { value: 'test', label: 'Test' },
  { value: 'vitals', label: 'Vitals reading' },
  { value: 'encounter', label: 'Consultation' },
]);

/** Where a goal's current value is READ FROM. Never where it is stored. */
const MEASURE_SOURCES = Object.freeze([
  { value: 'vitals', label: 'Vitals reading' },
  { value: 'test', label: 'Test result' },
]);

/** BMI is derived in the vitals read (0054), so a goal may name it. */
const VITALS_CODES = Object.freeze([...VITALS.map((v) => v.key), 'bmi']);

/**
 * What a vital sign is measured in, from the one place that knows — the same
 * table the Vitals screen labels its columns from.
 *
 * A NUMBER WITHOUT ITS UNIT IS NOT A READING ANYBODY CAN ACT ON, and a
 * monitoring panel showing a bare "148" is exactly that. BMI has no row in
 * VITALS because it is derived rather than recorded, so its unit is named here.
 */
function vitalsUnit(code) {
  if (code === 'bmi') return 'kg/m²';
  const v = vital(code);
  return v && v.unit ? v.unit : null;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEMPLATE_ROWS = 40;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_CARE_PROGRAM';
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

function number(field, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw invalid(field, 'That is not a number.');
  if (Math.abs(n) > 1e9) throw invalid(field, 'That number is too large.');
  return n;
}

function day(field, raw) {
  const s = text(field, raw, 32);
  if (s === null) return null;
  if (!isIsoDate(s)) throw invalid(field, 'That is not a date.');
  return s;
}

function optionalId(field, raw) {
  const s = text(field, raw, 64);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw invalid(field, `Unknown ${field}.`);
  return s;
}

/**
 * Add whole months to a date, clamping the day to the month's length: one
 * month after 31 January is 28 or 29 February, not 3 March. A monthly BP
 * check must not drift a day later every time it repeats.
 */
function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, (m - 1) + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const iso = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
  return iso.toISOString().slice(0, 10);
}

/**
 * When a repeating activity comes round again. `from` is the day it was last
 * due, or the day it was done — whichever the caller decided was the anchor.
 */
function nextDue(from, recurrence) {
  if (!from || !recurrence) return null;
  const { every, unit } = recurrence;
  if (!Number.isInteger(every) || every < 1) return null;
  if (unit === 'month') return addMonths(from, every);
  if (unit === 'week') return addDays(from, every * 7);
  if (unit === 'day') return addDays(from, every);
  return null;
}

/**
 * How often something repeats: { every, unit }. Null means once.
 *
 * The shape is also held by a CHECK in 0061, because a shape nothing can read
 * should not be storable at all — but the NUMBERS are checked here, where the
 * message can say which box was wrong.
 */
function readRecurrence(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('recurrence', 'That is not a repeat.');
  const unit = oneOf('recurrence', raw.unit, RECURRENCE_UNITS);
  if (!unit) throw invalid('recurrence', 'Say whether it repeats in days, weeks or months.');
  const every = number('recurrence', raw.every);
  if (every === null) throw invalid('recurrence', 'Say how often it repeats.');
  if (!Number.isInteger(every) || every < 1) throw invalid('recurrence', 'A repeat is a whole number of days, weeks or months.');
  if (every > 52) throw invalid('recurrence', 'That repeat is too far apart to be a plan.');
  return { every, unit };
}

/**
 * A record a pharmacist attaches to a programme by hand (phase 2, §14).
 *
 * Only the kind and the id. What the record SAYS is never copied here — the
 * service checks the id against its own table and this patient, and every
 * screen reads the record itself.
 */
function readLinkInput(body = {}) {
  const kind = oneOf('kind', body.kind, LINK_KINDS);
  if (!kind) throw invalid('kind', 'Say what kind of record this is.');
  const refId = optionalId('refId', body.refId);
  if (!refId) throw invalid('refId', 'Say which record to attach.');
  return { kind, refId, note: text('note', body.note, 300) };
}

/**
 * What this programme watches: the definition's monitoring list, plus every
 * goal that reads a measurement, with nothing listed twice.
 *
 * A GOAL THAT READS A NUMBER IS A THING BEING MONITORED — that is why this
 * needs no column of its own. A programme typed by hand, with no template,
 * gets a monitoring panel as soon as somebody writes a goal that measures
 * something.
 *
 * An entry naming a vital sign this product does not record is SKIPPED, not
 * guessed at: a panel row that can never show a value is worse than no row,
 * because it reads as a measurement nobody has taken.
 */
function monitoringSpec(definitionMonitoring, goals = []) {
  const out = [];
  const seen = new Set();
  const add = (source, code, label, unit) => {
    if (!source || !code) return;
    // The source has to be one of the two sections that hold numbers. Without
    // this, an unknown source fell through both checks below and was read as a
    // test code — a query for a result that could never exist.
    if (!MEASURE_SOURCES.some((s) => s.value === source)) return;
    if (source === 'vitals' && !VITALS_CODES.includes(code)) return;
    if (source === 'test' && !CODE_RE.test(code)) return;
    const key = `${source}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      source,
      code,
      label: label || code,
      unit: unit || (source === 'vitals' ? vitalsUnit(code) : null),
    });
  };

  for (const row of Array.isArray(definitionMonitoring) ? definitionMonitoring : []) {
    if (!row || typeof row !== 'object') continue;
    add(row.source, row.code, row.label, row.unit);
  }
  for (const goal of goals) {
    add(goal.measureSource, goal.measureCode, goal.measure || goal.title, goal.unit);
  }
  return out;
}

/** What an activity produced, or a record attached to a programme. */
function readLink(body, prefix = 'linked') {
  const kindKey = `${prefix}Type`;
  const idKey = `${prefix}Id`;
  const kind = oneOf(kindKey, body[kindKey], LINK_KINDS);
  const id = optionalId(idKey, body[idKey]);
  // Half a link points at nothing, and is worse than none: it looks like a
  // record exists.
  if (kind && !id) throw invalid(idKey, 'Say which record this points at.');
  if (id && !kind) throw invalid(kindKey, 'Say what kind of record this is.');
  return { kind, id };
}

// ---------------------------------------------------------------------------
// The programme
// ---------------------------------------------------------------------------

/**
 * The rules that hold for any programme, create or edit — so an edit cannot
 * reach a state a create could not. The same rules are CHECKs in 0061; this
 * is where they get a sentence a pharmacist can act on.
 */
function checkProgram(rec) {
  if (rec.status === 'completed') {
    if (!rec.outcome) throw invalid('outcome', 'Say how the programme ended.');
    if (!rec.endDate) throw invalid('endDate', 'Say when the programme ended.');
  }
  if (rec.status === 'discontinued') {
    if (!rec.discontinuationReason) throw invalid('discontinuationReason', 'Say why the programme was stopped.');
    if (!rec.endDate) throw invalid('endDate', 'Say when the programme was stopped.');
  }
  if (rec.status === 'cancelled') {
    if (!rec.statusReason) throw invalid('statusReason', 'Say why the programme was cancelled.');
    if (!rec.endDate) throw invalid('endDate', 'Say when the programme was cancelled.');
  }
  if (rec.status === 'on_hold' && !rec.statusReason) {
    throw invalid('statusReason', 'Say why the programme is on hold.');
  }
  // A programme that is still running has not ended. Reopening one clears the
  // end date rather than leaving a contradiction in the row.
  if (OPEN_STATUSES.includes(rec.status)) rec.endDate = null;
  if (rec.endDate && rec.startDate && rec.endDate < rec.startDate) {
    throw invalid('endDate', 'The programme cannot have ended before it started.');
  }
  return rec;
}

/**
 * Enrolling a patient.
 *
 * @param {object} body
 * @param {{ today: string, definition?: object }} opts
 *   `definition` is the catalogue row the pharmacist picked, already read from
 *   the database by the service. Its name is SNAPSHOTTED here, so renaming a
 *   template later never rewrites what this patient was enrolled in.
 */
function readProgramInput(body = {}, { today, definition = null } = {}) {
  const programName = text('programName', body.programName, 120)
    || (definition ? definition.name : null);
  if (!programName) throw invalid('programName', 'Say which programme this is.');

  const startDate = day('startDate', body.startDate) || today || null;
  const reviewDays = definition && definition.defaultReviewDays ? definition.defaultReviewDays : null;
  const nextReviewOn = day('nextReviewOn', body.nextReviewOn)
    || (startDate && reviewDays ? addDays(startDate, reviewDays) : null);

  return checkProgram({
    definitionId: definition ? definition.id : optionalId('definitionId', body.definitionId),
    programCode: definition ? definition.code : text('programCode', body.programCode, 40),
    programName,
    conditionCode: definition
      ? definition.conditionCode
      : conditionCode('conditionCode', body.conditionCode),
    status: oneOf('status', body.status, PROGRAM_STATUSES) || 'active',
    enrolledOn: day('enrolledOn', body.enrolledOn) || today || null,
    startDate,
    nextReviewOn,
    endDate: day('endDate', body.endDate),
    responsibleUserId: optionalId('responsibleUserId', body.responsibleUserId),
    responsibleName: text('responsibleName', body.responsibleName, 200),
    reason: text('reason', body.reason, 500),
    notes: text('notes', body.notes, 2000),
    outcome: oneOf('outcome', body.outcome, OUTCOMES),
    outcomeNotes: text('outcomeNotes', body.outcomeNotes, 2000),
    followUpRecommendation: text('followUpRecommendation', body.followUpRecommendation, 1000),
    discontinuationReason: oneOf('discontinuationReason', body.discontinuationReason, DISCONTINUATION_REASONS),
    statusReason: text('statusReason', body.statusReason, 500),
  });
}

function conditionCode(field, raw) {
  const s = text(field, raw, 60);
  if (s === null) return null;
  if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(s)) throw invalid(field, `Unknown ${field}.`);
  return s;
}

const PROGRAM_PATCHABLE = Object.freeze({
  programName: (v) => {
    const s = text('programName', v, 120);
    if (!s) throw invalid('programName', 'Say which programme this is.');
    return s;
  },
  status: (v) => oneOf('status', v, PROGRAM_STATUSES) || 'active',
  startDate: (v) => day('startDate', v),
  nextReviewOn: (v) => day('nextReviewOn', v),
  endDate: (v) => day('endDate', v),
  responsibleUserId: (v) => optionalId('responsibleUserId', v),
  responsibleName: (v) => text('responsibleName', v, 200),
  reason: (v) => text('reason', v, 500),
  notes: (v) => text('notes', v, 2000),
  outcome: (v) => oneOf('outcome', v, OUTCOMES),
  outcomeNotes: (v) => text('outcomeNotes', v, 2000),
  followUpRecommendation: (v) => text('followUpRecommendation', v, 1000),
  discontinuationReason: (v) => oneOf('discontinuationReason', v, DISCONTINUATION_REASONS),
  statusReason: (v) => text('statusReason', v, 500),
});

function readProgramPatch(body = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(PROGRAM_PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

/**
 * The stored programme with the patch applied, through the same rules as a
 * create. Ending a programme with no end date supplied ends it TODAY rather
 * than refusing: the pharmacist pressing "Complete" has said when.
 */
function mergeProgramForCheck(before, patch, { today } = {}) {
  const merged = { ...before, ...patch };
  const closing = ENDED_STATUSES.includes(merged.status) && !ENDED_STATUSES.includes(before.status);
  if (closing && !merged.endDate) merged.endDate = today || null;
  const next = checkProgram(merged);
  const adjusted = { ...patch, endDate: next.endDate };
  // Reopening a programme drops the reason it had stopped, which no longer
  // describes anything. The audit trail keeps what it said.
  if (OPEN_STATUSES.includes(next.status) && ENDED_STATUSES.includes(before.status)) {
    if (!Object.prototype.hasOwnProperty.call(patch, 'outcome')) adjusted.outcome = null;
    if (!Object.prototype.hasOwnProperty.call(patch, 'discontinuationReason')) adjusted.discontinuationReason = null;
  }
  return adjusted;
}

/** Closing a course of care needs a pharmacist. Everything else does not. */
function needsClinicalRole(next, before = null) {
  const s = next.status;
  if (!s) return false;
  if (before && before.status === s) return false;
  return CLOSING_STATUSES.includes(s);
}

const hasClinicalRole = (role) => CLINICAL_ROLES.includes(role);

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function checkGoal(rec) {
  if ((rec.measureSource === null) !== (rec.measureCode === null)) {
    throw invalid('measureCode', 'Say both what is measured and where it is read from.');
  }
  if (rec.measureSource === 'vitals' && !VITALS_CODES.includes(rec.measureCode)) {
    throw invalid('measureCode', `"${rec.measureCode}" is not a vital sign this product records.`);
  }
  if (rec.measureSource === 'test' && !CODE_RE.test(rec.measureCode)) {
    throw invalid('measureCode', 'That is not a test code.');
  }
  if (GOAL_SETTLED.includes(rec.status) && !rec.achievedOn) {
    throw invalid('achievedOn', 'Say when the goal was settled.');
  }
  if (!GOAL_SETTLED.includes(rec.status)) rec.achievedOn = null;
  return rec;
}

function readGoalInput(body = {}, { today } = {}) {
  const title = text('title', body.title, 200);
  if (!title) throw invalid('title', 'Say what the goal is.');
  const status = oneOf('status', body.status, GOAL_STATUSES) || 'planned';
  return checkGoal({
    title,
    description: text('description', body.description, 1000),
    status,
    measure: text('measure', body.measure, 120),
    measureSource: oneOf('measureSource', body.measureSource, MEASURE_SOURCES),
    measureCode: text('measureCode', body.measureCode, 40),
    unit: text('unit', body.unit, 20),
    baselineValue: number('baselineValue', body.baselineValue),
    baselineOn: day('baselineOn', body.baselineOn),
    targetValue: number('targetValue', body.targetValue),
    targetText: text('targetText', body.targetText, 300),
    targetDate: day('targetDate', body.targetDate),
    achievedOn: day('achievedOn', body.achievedOn)
      || (GOAL_SETTLED.includes(status) ? (today || null) : null),
    statusReason: text('statusReason', body.statusReason, 500),
    position: Math.max(0, Math.trunc(number('position', body.position) || 0)),
    notes: text('notes', body.notes, 1000),
  });
}

const GOAL_PATCHABLE = Object.freeze({
  title: (v) => {
    const s = text('title', v, 200);
    if (!s) throw invalid('title', 'Say what the goal is.');
    return s;
  },
  description: (v) => text('description', v, 1000),
  status: (v) => oneOf('status', v, GOAL_STATUSES) || 'planned',
  measure: (v) => text('measure', v, 120),
  measureSource: (v) => oneOf('measureSource', v, MEASURE_SOURCES),
  measureCode: (v) => text('measureCode', v, 40),
  unit: (v) => text('unit', v, 20),
  baselineValue: (v) => number('baselineValue', v),
  baselineOn: (v) => day('baselineOn', v),
  targetValue: (v) => number('targetValue', v),
  targetText: (v) => text('targetText', v, 300),
  targetDate: (v) => day('targetDate', v),
  achievedOn: (v) => day('achievedOn', v),
  statusReason: (v) => text('statusReason', v, 500),
  position: (v) => Math.max(0, Math.trunc(number('position', v) || 0)),
  notes: (v) => text('notes', v, 1000),
});

function readGoalPatch(body = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(GOAL_PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

function mergeGoalForCheck(before, patch, { today } = {}) {
  const merged = { ...before, ...patch };
  if (GOAL_SETTLED.includes(merged.status) && !merged.achievedOn) merged.achievedOn = today || null;
  const next = checkGoal(merged);
  return { ...patch, achievedOn: next.achievedOn };
}

// ---------------------------------------------------------------------------
// Activities — the care plan, and the task list
// ---------------------------------------------------------------------------

function checkActivity(rec) {
  if (ACTIVITY_DROPPED.includes(rec.status) && !rec.statusReason) {
    throw invalid('statusReason', rec.status === 'skipped'
      ? 'Say why this was skipped.'
      : 'Say why this was cancelled.');
  }
  // A repeat with no first date never appears in a task list and never comes
  // round, which makes it a note rather than a plan.
  if (rec.recurrence && !rec.dueOn) {
    throw invalid('dueOn', 'A repeating task needs a first due date.');
  }
  if (!ACTIVITY_DROPPED.includes(rec.status) && rec.status !== 'completed') rec.statusReason = null;
  return rec;
}

function readActivityInput(body = {}) {
  const title = text('title', body.title, 200);
  if (!title) throw invalid('title', 'Say what needs to be done.');
  const link = readLink(body);
  return checkActivity({
    goalId: optionalId('goalId', body.goalId),
    title,
    description: text('description', body.description, 1000),
    kind: oneOf('kind', body.kind, ACTIVITY_KINDS) || 'other',
    status: oneOf('status', body.status, ACTIVITY_STATUSES) || 'not_started',
    dueOn: day('dueOn', body.dueOn),
    assignedToUserId: optionalId('assignedToUserId', body.assignedToUserId),
    assignedToName: text('assignedToName', body.assignedToName, 200),
    outcomeNote: text('outcomeNote', body.outcomeNote, 1000),
    recurrence: readRecurrence(body.recurrence),
    linkedType: link.kind,
    linkedId: link.id,
    statusReason: text('statusReason', body.statusReason, 500),
    position: Math.max(0, Math.trunc(number('position', body.position) || 0)),
    notes: text('notes', body.notes, 1000),
  });
}

const ACTIVITY_PATCHABLE = Object.freeze({
  goalId: (v) => optionalId('goalId', v),
  title: (v) => {
    const s = text('title', v, 200);
    if (!s) throw invalid('title', 'Say what needs to be done.');
    return s;
  },
  description: (v) => text('description', v, 1000),
  kind: (v) => oneOf('kind', v, ACTIVITY_KINDS) || 'other',
  status: (v) => oneOf('status', v, ACTIVITY_STATUSES) || 'not_started',
  dueOn: (v) => day('dueOn', v),
  assignedToUserId: (v) => optionalId('assignedToUserId', v),
  assignedToName: (v) => text('assignedToName', v, 200),
  outcomeNote: (v) => text('outcomeNote', v, 1000),
  recurrence: readRecurrence,
  statusReason: (v) => text('statusReason', v, 500),
  position: (v) => Math.max(0, Math.trunc(number('position', v) || 0)),
  notes: (v) => text('notes', v, 1000),
});

function readActivityPatch(body = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(ACTIVITY_PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'linkedType')
      || Object.prototype.hasOwnProperty.call(body, 'linkedId')) {
    const link = readLink(body);
    patch.linkedType = link.kind;
    patch.linkedId = link.id;
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

function mergeActivityForCheck(before, patch) {
  const next = checkActivity({ ...before, ...patch });
  return { ...patch, statusReason: next.statusReason };
}

/**
 * The occurrence that follows a completed repeating activity: the same task,
 * one interval later, everything else carried over.
 *
 * EXACTLY ONE. Nothing here loops, and nothing schedules ahead of time, so a
 * programme cannot grow rows nobody asked for. The anchor is the day it was
 * due — not the day it was done — so a task ticked off three days late does
 * not push the whole schedule three days later. When the new date would still
 * be in the past (a task done weeks late), it rolls forward until it is not.
 */
function nextOccurrence(activity, { today } = {}) {
  if (!activity || !activity.recurrence || !activity.dueOn) return null;
  let due = nextDue(activity.dueOn, activity.recurrence);
  if (!due) return null;
  let guard = 0;
  while (today && due < today && guard < 120) {
    const rolled = nextDue(due, activity.recurrence);
    if (!rolled) break;
    due = rolled;
    guard += 1;
  }
  return {
    goalId: activity.goalId || null,
    title: activity.title,
    description: activity.description || null,
    kind: activity.kind,
    status: 'not_started',
    dueOn: due,
    assignedToUserId: activity.assignedToUserId || null,
    assignedToName: activity.assignedToName || null,
    outcomeNote: null,
    recurrence: activity.recurrence,
    recurrenceOf: activity.id || null,
    linkedType: null,
    linkedId: null,
    statusReason: null,
    position: activity.position || 0,
    notes: null,
  };
}

// ---------------------------------------------------------------------------
// Progress — counted, never stored, and never a percentage
// ---------------------------------------------------------------------------

/**
 * What is done and what is not. Every number here traces to rows somebody
 * wrote: goals settled out of goals set, tasks done out of tasks planned, and
 * how many are past their date.
 *
 * There is deliberately NO percentage and NO score. A percentage over tasks
 * answers "how much of the admin is finished", and printed beside a patient's
 * name it reads as a claim about the patient (the plan, question 3).
 */
function progressFrom(goals = [], activities = [], { today } = {}) {
  const g = { total: goals.length, achieved: 0, notAchieved: 0, open: 0 };
  for (const goal of goals) {
    if (goal.status === 'achieved') g.achieved += 1;
    else if (goal.status === 'not_achieved') g.notAchieved += 1;
    else if (goal.status !== 'cancelled') g.open += 1;
  }

  const a = { total: 0, completed: 0, open: 0, overdue: 0, dropped: 0 };
  let next = null;
  for (const act of activities) {
    if (ACTIVITY_DROPPED.includes(act.status)) { a.dropped += 1; continue; }
    a.total += 1;
    if (act.status === 'completed') { a.completed += 1; continue; }
    a.open += 1;
    if (today && act.dueOn && act.dueOn < today) a.overdue += 1;
    if (act.dueOn && (!next || !next.dueOn || act.dueOn < next.dueOn)) {
      next = { id: act.id || null, title: act.title, dueOn: act.dueOn };
    }
  }
  return { goals: g, activities: a, nextDue: next };
}

// ---------------------------------------------------------------------------
// Expanding a template
// ---------------------------------------------------------------------------

/**
 * A definition's goals and activities as rows for this patient, dated from the
 * day the programme starts.
 *
 * Every row goes through the SAME contract a typed one does, so a template
 * with a bad row fails at enrolment with a sentence, rather than storing
 * something no screen can read. Once created they are the patient's own: the
 * pharmacist edits or deletes any of them, and the template is never consulted
 * again (the plan, question 1).
 */
function planFromDefinition(definition, { today, startDate } = {}) {
  const anchor = startDate || today || null;
  const goalRows = Array.isArray(definition && definition.goals) ? definition.goals : [];
  const activityRows = Array.isArray(definition && definition.activities) ? definition.activities : [];
  if (goalRows.length + activityRows.length > MAX_TEMPLATE_ROWS) {
    throw invalid('definitionId', 'That programme template is too large.');
  }

  const goals = goalRows.map((row, i) => readGoalInput({
    title: row.title,
    description: row.description,
    measure: row.measure,
    measureSource: row.source,
    measureCode: row.code,
    unit: row.unit,
    targetValue: row.targetValue,
    targetText: row.targetText,
    targetDate: anchor && Number.isFinite(Number(row.targetDays))
      ? addDays(anchor, Math.trunc(Number(row.targetDays)))
      : null,
    position: i,
  }, { today }));

  const activities = activityRows.map((row, i) => readActivityInput({
    title: row.title,
    description: row.description,
    kind: row.kind,
    dueOn: anchor && Number.isFinite(Number(row.offsetDays))
      ? addDays(anchor, Math.trunc(Number(row.offsetDays)))
      : null,
    recurrence: row.recurrence,
    position: i,
  }));

  return { goals, activities };
}

function careProgramOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    statuses: pick(PROGRAM_STATUSES),
    outcomes: pick(OUTCOMES),
    discontinuationReasons: pick(DISCONTINUATION_REASONS),
    goalStatuses: pick(GOAL_STATUSES),
    activityKinds: pick(ACTIVITY_KINDS),
    activityStatuses: pick(ACTIVITY_STATUSES),
    recurrenceUnits: pick(RECURRENCE_UNITS),
    linkKinds: pick(LINK_KINDS),
    measureSources: pick(MEASURE_SOURCES),
    vitalsCodes: VITALS_CODES.slice(),
  };
}

module.exports = {
  PROGRAM_STATUSES, OPEN_STATUSES, ENDED_STATUSES, CLOSING_STATUSES, CLINICAL_ROLES,
  OUTCOMES, DISCONTINUATION_REASONS, GOAL_STATUSES, GOAL_SETTLED,
  ACTIVITY_KINDS, ACTIVITY_STATUSES, ACTIVITY_OPEN, ACTIVITY_DROPPED,
  RECURRENCE_UNITS, LINK_KINDS, MEASURE_SOURCES, VITALS_CODES,
  readProgramInput, readProgramPatch, mergeProgramForCheck,
  readGoalInput, readGoalPatch, mergeGoalForCheck,
  readActivityInput, readActivityPatch, mergeActivityForCheck,
  readRecurrence, readLink, readLinkInput, monitoringSpec, vitalsUnit, nextDue, addMonths, nextOccurrence,
  progressFrom, planFromDefinition, careProgramOptions,
  needsClinicalRole, hasClinicalRole,
};
