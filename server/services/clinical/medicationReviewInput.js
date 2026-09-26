/**
 * The vocabulary of a medication review, and the contract for writing one.
 *
 * PURE. The lists here ARE the review: what a pharmacist may record as a
 * problem, as an intervention, and as an outcome. They are held in one place
 * so the form, the validator and the screen cannot offer or accept three
 * different sets.
 *
 * NOTHING IN THIS FILE RANKS OR SCORES. There is no severity on a problem,
 * no priority on an action, no suggested intervention for a finding. A
 * pharmacist records what they found and what they did; the software does
 * not grade it, and a stored severity would be the software forming a
 * clinical judgement of its own.
 */

/** How the patient is actually taking their medicines, as assessed. */
const ADHERENCE = Object.freeze([
  { value: 'good', label: 'Good' },
  { value: 'partial', label: 'Partial' },
  { value: 'poor', label: 'Poor' },
  // A real answer, and the default. A review that could not establish
  // adherence recorded that — forcing a guess would put "good" against
  // patients nobody managed to ask.
  { value: 'unknown', label: 'Unknown' },
]);

/**
 * Medication-related problems, in the brief's order.
 *
 * `duplicate_therapy` and `therapeutic_duplication` are both here and are
 * not the same thing: the first is two prescriptions for the same medicine,
 * the second is two different medicines doing the same job. Pharmacists
 * distinguish them, so the record does.
 */
const PROBLEMS = Object.freeze([
  { value: 'non_adherence', label: 'Non-adherence' },
  { value: 'incorrect_dose', label: 'Incorrect dose' },
  { value: 'incorrect_frequency', label: 'Incorrect frequency' },
  { value: 'duplicate_therapy', label: 'Duplicate therapy' },
  { value: 'potential_interaction', label: 'Potential interaction' },
  { value: 'adverse_effect', label: 'Adverse effect' },
  { value: 'contraindication_concern', label: 'Contraindication concern' },
  { value: 'unnecessary_medication', label: 'Unnecessary medication' },
  { value: 'therapeutic_duplication', label: 'Therapeutic duplication' },
  { value: 'drug_not_effective', label: 'Drug not effective' },
  { value: 'access_cost', label: 'Access or cost issue' },
  { value: 'patient_misunderstanding', label: 'Patient misunderstanding' },
  { value: 'other', label: 'Other' },
]);

/** What the pharmacist did about it. */
const ACTIONS = Object.freeze([
  { value: 'counselling_provided', label: 'Counselling provided' },
  { value: 'dose_clarification', label: 'Dose clarification' },
  { value: 'adherence_counselling', label: 'Adherence counselling' },
  { value: 'prescriber_contacted', label: 'Prescriber contacted' },
  { value: 'medication_stopped', label: 'Medication stopped' },
  { value: 'medication_changed', label: 'Medication changed' },
  { value: 'referral_made', label: 'Referral made' },
  { value: 'monitoring_recommended', label: 'Monitoring recommended' },
  { value: 'follow_up_scheduled', label: 'Follow-up scheduled' },
]);

/** Where the review left things. */
const OUTCOMES = Object.freeze([
  { value: 'resolved', label: 'Resolved' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'prescriber_follow_up', label: 'Prescriber follow-up required' },
  { value: 'referred', label: 'Patient referred' },
  { value: 'pending', label: 'Pending' },
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROBLEMS = 40;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_REVIEW';
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
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw invalid(field, 'That is not a date.');
  }
  return s;
}

function optionalId(field, raw) {
  const s = text(field, raw, 64);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw invalid(field, `Unknown ${field}.`);
  return s;
}

/**
 * The body of a review — everything except signing, which is its own step.
 *
 * @param {object} body
 * @param {{ today: string, signing?: boolean }} opts  Lagos date, injected
 */
function readReviewInput(body = {}, { today, signing = false } = {}) {
  const reviewedOn = day('reviewedOn', body.reviewedOn) || today || null;
  if (reviewedOn && today && reviewedOn > today) {
    throw invalid('reviewedOn', 'A review cannot have happened in the future.');
  }

  const followUpOn = day('followUpOn', body.followUpOn);
  const followUpReason = text('followUpReason', body.followUpReason, 300);
  // A date with no reason is a date nobody can act on when it arrives; a
  // reason with no date never comes round at all.
  if (followUpOn && !followUpReason) {
    throw invalid('followUpReason', 'Say what the follow-up is for.');
  }
  if (followUpReason && !followUpOn) {
    throw invalid('followUpOn', 'Say when to follow up.');
  }
  if (followUpOn && today && followUpOn < today) {
    throw invalid('followUpOn', 'A follow-up cannot be in the past.');
  }

  const problems = readProblems(body.problems);
  const actions = readActions(body.actions, problems);
  const outcome = oneOf('outcome', body.outcome, OUTCOMES);

  // Signing is the assertion that the review is finished, so it is the only
  // point where the record has to be complete. A draft may be anything —
  // that is what a draft is for.
  if (signing) {
    if (!outcome) throw invalid('outcome', 'Say how the review was left.');
    // A problem found with nothing done about it is an unfinished review,
    // not a finding. "Monitoring recommended" is a valid answer to it.
    if (problems.length > 0 && actions.length === 0) {
      throw invalid('actions', 'Record what you did about the problems you found.');
    }
  }

  return {
    reviewedOn,
    adherence: oneOf('adherence', body.adherence, ADHERENCE) || 'unknown',
    adherenceNotes: text('adherenceNotes', body.adherenceNotes, 1000),
    notes: text('notes', body.notes, 4000),
    outcome,
    followUpOn,
    followUpReason,
    followUpNotes: text('followUpNotes', body.followUpNotes, 1000),
    problems,
    actions,
  };
}

/** The problems found, each optionally about one medicine. */
function readProblems(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('problems', 'Problems must be a list.');
  if (raw.length > MAX_PROBLEMS) throw invalid('problems', `No more than ${MAX_PROBLEMS} problems in one review.`);

  const seen = new Set();
  return raw.map((p, i) => {
    const problem = oneOf('problem', p?.problem, PROBLEMS);
    if (!problem) throw invalid('problems', `Problem ${i + 1} has no type.`);
    const journeyId = optionalId('journeyId', p?.journeyId);
    // The same problem twice against the same medicine in one sitting is a
    // double-click, not two findings.
    const key = `${problem}:${journeyId || ''}`;
    if (seen.has(key)) throw invalid('problems', 'That problem is already recorded against that medicine.');
    seen.add(key);
    return { problem, journeyId, notes: text('notes', p?.notes, 1000), ref: p?.ref ?? i };
  });
}

/**
 * The interventions made. `problemRef` points at a problem in THIS body by
 * its position, because neither has an id until the review is saved — the
 * service turns the reference into a foreign key once the rows exist.
 */
function readActions(raw, problems) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('actions', 'Interventions must be a list.');

  const refs = new Set(problems.map((p) => String(p.ref)));
  const seen = new Set();
  return raw.map((a, i) => {
    const action = oneOf('action', a?.action, ACTIONS);
    if (!action) throw invalid('actions', `Intervention ${i + 1} has no type.`);
    let problemRef = a?.problemRef;
    if (problemRef !== undefined && problemRef !== null && String(problemRef) !== '') {
      problemRef = String(problemRef);
      if (!refs.has(problemRef)) {
        throw invalid('actions', 'That intervention points at a problem this review does not have.');
      }
    } else {
      problemRef = null;
    }
    const key = `${action}:${problemRef || ''}`;
    if (seen.has(key)) throw invalid('actions', 'That intervention is already recorded against that problem.');
    seen.add(key);
    return { action, problemRef, notes: text('notes', a?.notes, 1000) };
  });
}

/** Everything a review form may offer, so it cannot show a refused value. */
function reviewOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    adherence: pick(ADHERENCE),
    problems: pick(PROBLEMS),
    actions: pick(ACTIONS),
    outcomes: pick(OUTCOMES),
  };
}

module.exports = {
  ADHERENCE, PROBLEMS, ACTIONS, OUTCOMES, MAX_PROBLEMS,
  readReviewInput, reviewOptions,
};
