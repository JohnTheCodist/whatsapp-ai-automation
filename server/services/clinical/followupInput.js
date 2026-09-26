/**
 * The contract for a follow-up: what needs to happen next for this patient.
 *
 * PURE. One place for the lists, so the form, the validator and the screen
 * cannot drift; the CHECKs in 0062 hold the same lists.
 *
 * IT SHARES THE TASK VOCABULARY IT DID NOT NEED TO REINVENT. The kinds, the
 * statuses and the recurrence rules come from `careProgramInput` because 0062
 * made a care-programme activity and a standalone follow-up the same row. A
 * second copy of "what does completed mean" is exactly the duplication the
 * brief (§22) says not to build.
 *
 * NOTHING HERE DECIDES CARE (§27). It does not read a blood pressure and
 * schedule a repeat, or turn a result into a task. A pharmacist says what
 * needs to happen; this checks that what they typed is a thing the record can
 * hold, and the queue keeps track of it afterwards.
 *
 * TWO STATUSES ARE NOT STORED. "Due" and "Overdue" are derived from the due
 * date against the Lagos day (§5), because a status somebody has to remember
 * to update is a status that will be wrong.
 */

const {
  ACTIVITY_KINDS, ACTIVITY_STATUSES, ACTIVITY_OPEN, ACTIVITY_DROPPED,
  LINK_KINDS, RECURRENCE_UNITS, CLINICAL_ROLES,
  readRecurrence, nextDue, nextOccurrence, hasClinicalRole,
} = require('./careProgramInput');
const { isIsoDate } = require('../refills/refillSchedule');
const { VITALS } = require('./vitalRanges');

/** What kind of thing this is (§6). The task vocabulary, unchanged. */
const FOLLOWUP_TYPES = ACTIVITY_KINDS;

/** What is stored. Due and Overdue are derived — see the header. */
const FOLLOWUP_STATUSES = ACTIVITY_STATUSES;
const FOLLOWUP_OPEN = ACTIVITY_OPEN;
const FOLLOWUP_DROPPED = ACTIVITY_DROPPED;

const PRIORITIES = Object.freeze([
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
]);

/**
 * What raised it (§8). Distinct from what it PRODUCED, which is the link — a
 * follow-up can carry both: raised by the consultation on the 6th, produced
 * the reading on the 24th.
 */
const SOURCE_TYPES = Object.freeze([
  { value: 'consultation', label: 'Consultation' },
  { value: 'medication_review', label: 'Medication review' },
  { value: 'care_program', label: 'Care programme' },
  { value: 'test', label: 'Test' },
  { value: 'vitals', label: 'Vitals reading' },
  { value: 'condition', label: 'Condition' },
  // A patient said something in a message and a pharmacist decided it needed
  // doing (0065, the brief's §23). Nothing raises one automatically — this
  // records WHERE it came from, the same way a signed review's follow-up
  // date does.
  { value: 'conversation', label: 'Conversation' },
  { value: 'triage', label: 'Pharmacist triage' },
  { value: 'manual', label: 'Raised by hand' },
  { value: 'other', label: 'Other' },
]);

/** The sources that name a specific record, and the table each one means. */
const SOURCE_WITH_RECORD = Object.freeze(['consultation', 'medication_review', 'care_program', 'test', 'vitals', 'condition', 'conversation']);

/**
 * How it turned out (§13).
 *
 * Only ever set by the person completing it. Nothing here is computed from a
 * reading: "improved" is a judgement, and this product does not make those.
 */
const OUTCOMES = Object.freeze([
  { value: 'completed', label: 'Completed' },
  { value: 'improved', label: 'Improved' },
  { value: 'stable', label: 'Stable' },
  { value: 'no_improvement', label: 'No improvement' },
  { value: 'worsened', label: 'Worsened' },
  { value: 'unable_to_assess', label: 'Unable to assess' },
  { value: 'did_not_attend', label: 'Patient did not attend' },
  { value: 'referred', label: 'Referred' },
  { value: 'needs_further_followup', label: 'Needs further follow-up' },
  { value: 'other', label: 'Other' },
]);

/** Why it will not happen (§15). The row is kept either way. */
const CANCEL_REASONS = Object.freeze([
  { value: 'no_longer_required', label: 'Patient no longer requires follow-up' },
  { value: 'transferred_care', label: 'Transferred care' },
  { value: 'completed_elsewhere', label: 'Follow-up completed elsewhere' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'other', label: 'Other' },
]);

/** The filters across the top (§25). Each one is derived, never stored. */
const FOLLOWUP_FILTERS = Object.freeze([
  { value: '', label: 'All', count: 'all' },
  { value: 'today', label: 'Due today', count: 'today' },
  { value: 'overdue', label: 'Overdue', count: 'overdue' },
  { value: 'upcoming', label: 'Upcoming', count: 'upcoming' },
  { value: 'completed', label: 'Completed', count: 'completed' },
  { value: 'cancelled', label: 'Cancelled', count: 'cancelled' },
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_FOLLOWUP';
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

function day(field, raw) {
  const s = text(field, raw, 32);
  if (s === null) return null;
  if (!isIsoDate(s)) throw invalid(field, 'That is not a date.');
  return s;
}

/** "14:30", or "14:30:00" from a database round trip. Never a guess. */
function clock(field, raw) {
  const s = text(field, raw, 8);
  if (s === null) return null;
  if (!TIME_RE.test(s)) throw invalid(field, 'That is not a time of day.');
  return s.slice(0, 5);
}

function optionalId(field, raw) {
  const s = text(field, raw, 64);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw invalid(field, `Unknown ${field}.`);
  return s;
}

/** Where it came from (§8), and — separately — what it produced (§12). */
function readSource(body) {
  const sourceType = oneOf('sourceType', body.sourceType, SOURCE_TYPES);
  const sourceId = optionalId('sourceId', body.sourceId);
  // An id with no kind points at nothing anybody can resolve. A KIND with no
  // id is fine: "raised at a consultation" is true even when nobody said which.
  if (sourceId && !sourceType) throw invalid('sourceType', 'Say what kind of record raised this.');
  return { sourceType: sourceType || (sourceId ? null : sourceType), sourceId };
}

function readLinked(body) {
  const linkedType = oneOf('linkedType', body.linkedType, LINK_KINDS);
  const linkedId = optionalId('linkedId', body.linkedId);
  if (linkedType && !linkedId) throw invalid('linkedId', 'Say which record this points at.');
  if (linkedId && !linkedType) throw invalid('linkedType', 'Say what kind of record this is.');
  return { linkedType, linkedId };
}

/**
 * The rules that hold for any follow-up, create or edit — so an edit cannot
 * reach a state a create could not. The same rules are CHECKs in 0061/0062;
 * this is where they get a sentence a pharmacist can act on.
 */
function checkFollowup(rec) {
  if (FOLLOWUP_DROPPED.includes(rec.status) && !rec.statusReason) {
    throw invalid('statusReason', rec.status === 'skipped'
      ? 'Say why this was skipped.'
      : 'Say why this follow-up was cancelled.');
  }
  // A repeat with no first date never appears in a queue and never comes
  // round, which makes it a note rather than a plan.
  if (rec.recurrence && !rec.dueOn) {
    throw invalid('dueOn', 'A repeating follow-up needs a first due date.');
  }
  // A time of day with no day is not a due date.
  if (rec.dueTime && !rec.dueOn) {
    throw invalid('dueOn', 'Say which day, as well as the time.');
  }
  if (rec.outcome && !['completed', 'skipped'].includes(rec.status)) {
    throw invalid('outcome', 'An outcome belongs to a follow-up that was done, or deliberately not done.');
  }
  if (!FOLLOWUP_DROPPED.includes(rec.status) && rec.status !== 'completed') rec.statusReason = null;
  return rec;
}

/**
 * A new follow-up (§7).
 *
 * A DUE DATE IS OPTIONAL, deliberately. "Review the HbA1c when the result
 * comes back" is a real follow-up with no date anybody can name yet (§10), and
 * refusing it would make the pharmacist invent one.
 */
function readFollowupInput(body = {}) {
  const title = text('title', body.title, 200);
  if (!title) throw invalid('title', 'Say what needs to happen.');
  const source = readSource(body);
  const linked = readLinked(body);

  return checkFollowup({
    title,
    description: text('description', body.description, 1000),
    kind: oneOf('kind', body.kind, FOLLOWUP_TYPES) || 'follow_up',
    status: oneOf('status', body.status, FOLLOWUP_STATUSES) || 'not_started',
    priority: oneOf('priority', body.priority, PRIORITIES) || 'routine',
    reason: text('reason', body.reason, 500),
    dueOn: day('dueOn', body.dueOn),
    dueTime: clock('dueTime', body.dueTime),
    assignedToUserId: optionalId('assignedToUserId', body.assignedToUserId),
    assignedToName: text('assignedToName', body.assignedToName, 200),
    recurrence: readRecurrence(body.recurrence),
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    linkedType: linked.linkedType,
    linkedId: linked.linkedId,
    outcome: oneOf('outcome', body.outcome, OUTCOMES),
    outcomeNote: text('outcomeNote', body.outcomeNote, 1000),
    statusReason: text('statusReason', body.statusReason, 500),
    notes: text('notes', body.notes, 1000),
    position: 0,
  });
}

const PATCHABLE = Object.freeze({
  title: (v) => {
    const s = text('title', v, 200);
    if (!s) throw invalid('title', 'Say what needs to happen.');
    return s;
  },
  description: (v) => text('description', v, 1000),
  kind: (v) => oneOf('kind', v, FOLLOWUP_TYPES) || 'follow_up',
  status: (v) => oneOf('status', v, FOLLOWUP_STATUSES) || 'not_started',
  priority: (v) => oneOf('priority', v, PRIORITIES) || 'routine',
  reason: (v) => text('reason', v, 500),
  dueOn: (v) => day('dueOn', v),
  dueTime: (v) => clock('dueTime', v),
  assignedToUserId: (v) => optionalId('assignedToUserId', v),
  assignedToName: (v) => text('assignedToName', v, 200),
  recurrence: readRecurrence,
  outcome: (v) => oneOf('outcome', v, OUTCOMES),
  outcomeNote: (v) => text('outcomeNote', v, 1000),
  statusReason: (v) => text('statusReason', v, 500),
  notes: (v) => text('notes', v, 1000),
});

function readFollowupPatch(body = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sourceType')
      || Object.prototype.hasOwnProperty.call(body, 'sourceId')) {
    Object.assign(patch, readSource(body));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'linkedType')
      || Object.prototype.hasOwnProperty.call(body, 'linkedId')) {
    Object.assign(patch, readLinked(body));
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

function mergeForCheck(before, patch) {
  const next = checkFollowup({ ...before, ...patch });
  return { ...patch, statusReason: next.statusReason };
}

/**
 * Completing one (§12).
 *
 * The outcome is required, because "what happened" is the whole reason a
 * completed follow-up is worth keeping. The RESULT is a link to the record the
 * follow-up produced — a reading, a test, a consultation — and never a value
 * copied onto the follow-up itself.
 */
function readCompletion(body = {}, { today } = {}) {
  const outcome = oneOf('outcome', body.outcome, OUTCOMES);
  if (!outcome) throw invalid('outcome', 'Say how the follow-up turned out.');
  const completedOn = day('completedOn', body.completedOn) || today || null;
  if (completedOn && today && completedOn > today) {
    throw invalid('completedOn', 'A follow-up cannot have been done in the future.');
  }
  const linked = readLinked(body);
  // A reading taken at the counter (§12). It is NOT validated here — the
  // Vitals contract (vitalsInput) is the one definition of a valid reading,
  // and the route runs it, so a follow-up cannot invent a second idea of what
  // a plausible blood pressure is.
  if (body.reading && linked.linkedId) {
    throw invalid('reading', 'Record a reading, or point at one — not both.');
  }
  return {
    // Deliberately not 'skipped': a pharmacist who says the patient did not
    // attend has still DONE the follow-up — they tried, and recorded it.
    status: 'completed',
    outcome,
    outcomeNote: text('outcomeNote', body.outcomeNote, 1000),
    completedOn,
    linkedType: linked.linkedType,
    linkedId: linked.linkedId,
    // Filled in by the route, from the Vitals contract.
    reading: null,
  };
}

/**
 * Moving one (§14).
 *
 * The new date, and why. Nothing is overwritten silently: the service records
 * the move, counts it, and the audit trail keeps the date it had before.
 */
function readReschedule(body = {}, { today } = {}) {
  const dueOn = day('dueOn', body.dueOn);
  if (!dueOn) throw invalid('dueOn', 'Say the new due date.');
  if (today && dueOn < today) throw invalid('dueOn', 'A new due date cannot be in the past.');
  return {
    dueOn,
    dueTime: clock('dueTime', body.dueTime),
    reason: text('reason', body.reason, 500),
  };
}

/** Cancelling one (§15). A reason, from a short list, plus anything to add. */
function readCancellation(body = {}) {
  const reason = oneOf('reason', body.reason, CANCEL_REASONS);
  if (!reason) throw invalid('reason', 'Say why this follow-up is being cancelled.');
  const note = text('note', body.note, 400);
  const label = CANCEL_REASONS.find((r) => r.value === reason).label;
  return {
    reason,
    note,
    // What the row itself will say. The code travels with the audit event, so
    // "how many were cancelled as duplicates" stays answerable without giving
    // the table a column that no screen filters on.
    statusReason: note ? `${label} — ${note}` : label,
  };
}

/** Only a pharmacist or owner may cancel planned care. Anyone may do the work. */
const needsClinicalRole = (status) => status === 'cancelled';

function followupOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    types: pick(FOLLOWUP_TYPES),
    statuses: pick(FOLLOWUP_STATUSES),
    priorities: pick(PRIORITIES),
    sourceTypes: pick(SOURCE_TYPES),
    outcomes: pick(OUTCOMES),
    cancelReasons: pick(CANCEL_REASONS),
    linkKinds: pick(LINK_KINDS),
    recurrenceUnits: pick(RECURRENCE_UNITS),
    // What a completion panel may record on the spot (§12). Straight from
    // vitalRanges, so the boxes, their units and their order are the Vitals
    // screen's — this section defines no measurement of its own.
    vitalsFields: VITALS.map((v) => ({ key: v.key, label: v.label, unit: v.unit, step: v.step || 1 })),
    filters: FOLLOWUP_FILTERS.map(({ value, label, count }) => ({ value, label, count })),
  };
}

module.exports = {
  FOLLOWUP_TYPES, FOLLOWUP_STATUSES, FOLLOWUP_OPEN, FOLLOWUP_DROPPED,
  PRIORITIES, SOURCE_TYPES, SOURCE_WITH_RECORD, OUTCOMES, CANCEL_REASONS,
  FOLLOWUP_FILTERS, CLINICAL_ROLES,
  readFollowupInput, readFollowupPatch, mergeForCheck,
  readCompletion, readReschedule, readCancellation,
  needsClinicalRole, hasClinicalRole, nextDue, nextOccurrence, followupOptions,
};
