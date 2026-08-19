/**
 * Runs a versioned protocol inside an encounter — deterministically, and
 * entirely from application code.
 *
 * WHAT "DETERMINISTIC" MEANS HERE, CONCRETELY
 * Given the same protocol version and the same collected facts, nextQuestion()
 * returns the same question every time. It does not consult a model, and the
 * ordering (priority, then question_key) is total, so it never depends on row
 * insertion order or on which row Postgres happened to return first.
 *
 * WHAT THE LLM MAY AND MAY NOT DO
 * May: phrase the question text conversationally, and hand a raw patient
 * reply to recordAnswer() for parsing.
 * May NOT: choose which question comes next, decide an answer is good
 * enough, set a state, or write a fact. Every one of those is a function in
 * this file, callable only by application code. There is no code path from a
 * model's output to a state transition — that is the safety boundary this
 * whole stage exists to build.
 *
 * NO TREATMENT INTELLIGENCE. This engine knows whether a required question
 * has been answered. It has no idea what any answer means clinically, and
 * ready_for_review means exactly "the protocol's questions are done" —
 * never "the system reached a conclusion".
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { normaliseAnswer, validateParsed } = require('./answerNormaliser');
const facts = require('./clinicalFactService');

const STATES = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  AWAITING_INFORMATION: 'awaiting_information',
  READY_FOR_REVIEW: 'ready_for_review',
  ESCALATED: 'escalated',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

/**
 * Legal moves. Same shape and discipline as clinicalEncounterService's matrix.
 *
 * THE EDGE THAT IS DELIBERATELY ABSENT: nothing reaches COMPLETED except
 * from READY_FOR_REVIEW or ESCALATED. A run cannot be closed while questions
 * are still outstanding — the structural half of "missing information is
 * never silently accepted".
 */
const TRANSITIONS = Object.freeze({
  [STATES.NOT_STARTED]: [STATES.IN_PROGRESS, STATES.CANCELLED],
  [STATES.IN_PROGRESS]: [STATES.AWAITING_INFORMATION, STATES.READY_FOR_REVIEW, STATES.ESCALATED, STATES.CANCELLED],
  [STATES.AWAITING_INFORMATION]: [STATES.IN_PROGRESS, STATES.READY_FOR_REVIEW, STATES.ESCALATED, STATES.CANCELLED],
  [STATES.READY_FOR_REVIEW]: [STATES.ESCALATED, STATES.COMPLETED, STATES.CANCELLED],
  [STATES.ESCALATED]: [STATES.COMPLETED, STATES.CANCELLED],
  [STATES.COMPLETED]: [],
  [STATES.CANCELLED]: [],
});

function canTransition(from, to) {
  if (!(from in TRANSITIONS)) return { allowed: false, reason: 'UNKNOWN_FROM_STATE' };
  if (!Object.values(STATES).includes(to)) return { allowed: false, reason: 'UNKNOWN_TO_STATE' };
  if (from === to) return { allowed: true, reason: 'NO_CHANGE' };
  if (!TRANSITIONS[from].includes(to)) {
    return { allowed: false, reason: `ILLEGAL_TRANSITION_${from}_TO_${to}`.toUpperCase() };
  }
  return { allowed: true, reason: 'OK' };
}

/**
 * Is a question applicable given what has been collected?
 *
 * A CLOSED vocabulary, evaluated here — not an expression language, and
 * emphatically not something a model can extend. Unknown operators return
 * false (not applicable) rather than throwing or guessing: a question whose
 * condition cannot be understood must not be asked, and must not silently
 * count as satisfied either.
 *
 *   {}                                        always applicable
 *   {all_of: [{concept, equals|contains|min|max|exists}...]}  every clause must hold
 *   {any_of: [...]}                           at least one must hold
 */
function isApplicable(applicability, factsByConcept) {
  if (!applicability || Object.keys(applicability).length === 0) return true;

  const clauseHolds = (clause) => {
    if (!clause || typeof clause !== 'object' || !clause.concept) return false;
    const fact = factsByConcept.get(clause.concept);

    // `exists` is handled BEFORE the absence guard below, because it is the one
    // clause whose whole purpose is to ask about absence. Previously
    // `exists: false` fell through the `if (!fact) return false` short-circuit
    // and could never be satisfied, which made "only ask if we do not already
    // know this" inexpressible — the exact rule needed to avoid re-asking a
    // patient something they already volunteered.
    if ('exists' in clause) {
      const present = !!fact && fact.status === 'active';
      return clause.exists === true ? present : !present;
    }

    if (!fact) return false;
    // A conflicted or declined fact is not a usable basis for branching.
    if (fact.status !== 'active') return false;

    if ('equals' in clause) return String(fact.value) === String(clause.equals);
    // A multi_choice answer is stored comma-joined (answerNormaliser.parseChoice),
    // so membership is an EXACT TOKEN match after splitting — never a substring
    // test. `contains: 'none'` must not be satisfied by a value of
    // 'none_of_the_above', and `contains: 'cough'` must not match 'coughing_blood'.
    if ('contains' in clause) {
      return String(fact.value).split(',').map((s) => s.trim()).includes(String(clause.contains));
    }
    if ('min' in clause) return fact.value_number !== null && Number(fact.value_number) >= clause.min;
    if ('max' in clause) return fact.value_number !== null && Number(fact.value_number) <= clause.max;
    return false;
  };

  if (Array.isArray(applicability.all_of)) return applicability.all_of.every(clauseHolds);
  if (Array.isArray(applicability.any_of)) return applicability.any_of.some(clauseHolds);
  return false;
}

/**
 * Start (or resume) a protocol run for an encounter.
 *
 * Resolves the ACTIVE version at start time and pins it on the execution row.
 * A later activation of a newer version does not move an in-flight run —
 * spec §1 and test 8.
 */
async function startProtocol(pharmacyId, encounterId, slug, { actorType = 'system', actorId = null, customerId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [protocol] = await db`
    select id, slug, version from clinical_protocols
    where pharmacy_id = ${pharmacyId} and slug = ${slug} and status = 'active'
  `;
  if (!protocol) {
    const err = new Error(`No active protocol named "${slug}".`);
    err.status = 404; err.code = 'NO_ACTIVE_PROTOCOL';
    throw err;
  }

  const [existing] = await db`
    select * from protocol_executions
    where encounter_id = ${encounterId} and protocol_id = ${protocol.id}
  `;
  if (existing) return existing;

  const [row] = await db`
    insert into protocol_executions
      (pharmacy_id, encounter_id, protocol_id, protocol_slug, protocol_version, state, started_at)
    values
      (${pharmacyId}, ${encounterId}, ${protocol.id}, ${protocol.slug}, ${protocol.version},
       'in_progress', now())
    returning *
  `;

  for (const eventType of [PATIENT_EVENTS.PROTOCOL_SELECTED, PATIENT_EVENTS.PROTOCOL_STARTED]) {
    await recordClinicalEvent(db, {
      pharmacyId, customerId, eventType, actorType, actorId,
      entityType: 'protocol_execution', entityId: row.id,
      metadata: { slug: protocol.slug, version: protocol.version, encounterId },
    });
  }

  // Bring across what is already known, so the patient is not asked for
  // information the pharmacy already holds (spec §6).
  await facts.seedFromProfile(pharmacyId, encounterId, { actorType, actorId, customerId });

  return row;
}

async function getExecution(pharmacyId, executionId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select * from protocol_executions where id = ${executionId} and pharmacy_id = ${pharmacyId}
  `;
  return row || null;
}

/**
 * Everything the engine knows right now — the shape spec §4 asks for.
 * Read-only; computes nothing that is not derivable from stored rows.
 */
async function getExecutionState(pharmacyId, executionId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const execution = await getExecution(pharmacyId, executionId);
  if (!execution) {
    const err = new Error('Protocol execution not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const questions = await db`
    select * from protocol_questions where protocol_id = ${execution.protocol_id}
    order by priority, question_key
  `;
  const collected = await facts.listFacts(pharmacyId, execution.encounter_id);
  const answers = await db`
    select * from encounter_answers where execution_id = ${executionId} order by answered_at
  `;

  const factsByConcept = new Map();
  for (const f of collected) {
    // First wins: listFacts orders collected_at desc, so this is the newest.
    if (!factsByConcept.has(f.concept)) factsByConcept.set(f.concept, f);
  }
  // WHICH ANSWERS ACTUALLY SATISFY A QUESTION
  //
  // 'unparsable' does NOT. The patient replied, but nothing usable came out
  // of it — a severity of "45" on a 1-10 scale, say. Counting that as
  // answered would let a run reach ready_for_review with a required value
  // never collected, which is precisely the silent gap §5 and §8 exist to
  // prevent. It stays outstanding and gets asked again.
  //
  // 'unknown' and 'declined' DO satisfy it. "I don't know how long" is a
  // real, recorded answer — it produces a fact the pharmacist can see —
  // and re-asking a question the patient has already declined would badger
  // them forever over information they have said they cannot give.
  const SATISFYING = new Set(['answered', 'unknown', 'declined']);
  const answeredKeys = new Set(
    answers.filter((a) => SATISFYING.has(a.status)).map((a) => a.question_key)
  );

  const applicable = questions.filter((q) => isApplicable(q.applicability, factsByConcept));
  const unanswered = applicable.filter((q) => !answeredKeys.has(q.question_key));
  const missingRequired = unanswered.filter((q) => q.required);
  const conflicts = collected.filter((f) => f.status === 'conflicted');

  return {
    execution,
    protocolSlug: execution.protocol_slug,
    protocolVersion: execution.protocol_version,
    state: execution.state,
    facts: collected,
    factsByConcept,
    answers,
    applicableQuestions: applicable,
    unansweredQuestions: unanswered,
    missingRequired,
    conflicts,
    // "Every applicable required question has an answer" — nothing more.
    isComplete: missingRequired.length === 0,
    nextQuestion: unanswered[0] || null,
  };
}

/** The next question to put to the patient, or null when none applies. */
async function nextQuestion(pharmacyId, executionId) {
  const state = await getExecutionState(pharmacyId, executionId);
  return state.nextQuestion;
}

/** Record that a question was put to the patient (spec §9 QUESTION_PRESENTED). */
async function markQuestionPresented(pharmacyId, executionId, questionId, { actorType = 'ai', actorId = null, customerId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.QUESTION_ASKED,
    actorType, actorId,
    entityType: 'protocol_question', entityId: questionId,
    // WITHOUT THIS KEY THE EVENT IS RECORDED ONCE, EVER, PER QUESTION.
    // recordEvent's default idempotency key is (eventType, entityType,
    // entityId) — and entityId here is the PROTOCOL QUESTION, which every
    // patient shares. The first patient ever asked "how long have you had
    // this" would record the event and every patient afterwards would be
    // silently deduplicated away, leaving an audit trail that cannot show a
    // question was put to them. Keyed per execution, per ask.
    idempotencyKey: `question_asked:${executionId}:${questionId}:${Date.now()}`,
    metadata: { executionId },
  });
}

/**
 * Take a raw patient reply, parse it against the question's declared type,
 * store BOTH forms, and derive the fact.
 *
 * An unparsable answer is still recorded — with its original text and
 * status 'unparsable' — and does NOT satisfy the question. The patient gets
 * asked again rather than the system inventing a value (spec §8).
 */
async function recordAnswer(pharmacyId, executionId, questionKey, rawResponse, {
  // 'customer', not 'patient'. The codebase's actor vocabulary
  // (patientEventTypes.ACTOR_TYPES) has said 'customer' since Segment 1.5,
  // and introducing a second word for the same actor would split the audit
  // trail across two spellings of one idea.
  actorType = 'customer', actorId = null, customerId = null, now = new Date(),
} = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const execution = await getExecution(pharmacyId, executionId);
  if (!execution) {
    const err = new Error('Protocol execution not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const [question] = await db`
    select * from protocol_questions
    where protocol_id = ${execution.protocol_id} and question_key = ${questionKey}
  `;
  if (!question) {
    const err = new Error(`No question "${questionKey}" in ${execution.protocol_slug} v${execution.protocol_version}.`);
    err.status = 404; err.code = 'UNKNOWN_QUESTION';
    throw err;
  }

  const parsed = normaliseAnswer(question.answer_type, rawResponse, {
    choices: question.choices || [], now, validation: question.validation || {},
  });
  const check = validateParsed(parsed, question.validation || {});
  const status = check.ok ? parsed.status : 'unparsable';

  const [answer] = await db`
    insert into encounter_answers
      (pharmacy_id, execution_id, question_id, question_key, raw_response,
       normalized_value, normalized_number, unit, status, answered_at)
    values
      (${pharmacyId}, ${executionId}, ${question.id}, ${questionKey}, ${rawResponse},
       ${status === 'answered' ? parsed.value : null},
       ${status === 'answered' ? parsed.number : null},
       ${parsed.unit || question.unit || null}, ${status}, now())
    returning *
  `;

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.PATIENT_RESPONSE_RECEIVED,
    actorType, actorId,
    entityType: 'encounter_answer', entityId: answer.id,
    // Parse OUTCOME, never the answer's content.
    metadata: { questionKey, answerStatus: status, rejected: check.ok ? null : check.reason },
  });

  let fact = null;
  if (status === 'answered' || status === 'unknown' || status === 'declined') {
    const res = await facts.recordFact(pharmacyId, execution.encounter_id, {
      concept: question.fact_concept,
      value: status === 'answered' ? parsed.value : status,
      valueNumber: status === 'answered' ? parsed.number : null,
      unit: parsed.unit || question.unit || null,
      source: 'patient_reported',
      status: status === 'answered' ? 'active' : status,
      answerId: answer.id,
    }, { actorType, actorId, customerId });
    fact = res.fact;
  }

  return { answer, fact, parsed, accepted: status === 'answered' };
}

/**
 * Move the run's state. The ONLY writer of protocol_executions.state.
 * Refuses an illegal move rather than storing it.
 */
async function transitionTo(pharmacyId, executionId, to, { actorType = 'system', actorId = null, customerId = null, reason = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const execution = await getExecution(pharmacyId, executionId);
  if (!execution) {
    const err = new Error('Protocol execution not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const check = canTransition(execution.state, to);
  if (!check.allowed) {
    const err = new Error(`Cannot move protocol run from ${execution.state} to ${to}: ${check.reason}`);
    err.status = 409; err.code = check.reason;
    throw err;
  }
  if (check.reason === 'NO_CHANGE') return execution;

  const terminal = to === STATES.COMPLETED || to === STATES.CANCELLED;
  const [row] = await db`
    update protocol_executions
    set state = ${to}, updated_at = now() ${terminal ? db`, completed_at = now()` : db``}
    where id = ${executionId} and pharmacy_id = ${pharmacyId}
    returning *
  `;

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: to === STATES.COMPLETED ? PATIENT_EVENTS.PROTOCOL_COMPLETED : PATIENT_EVENTS.PROTOCOL_STATE_CHANGED,
    actorType, actorId,
    entityType: 'protocol_execution', entityId: executionId,
    // Same collision as QUESTION_ASKED, one level down: entityId is the
    // execution, so every state change after the first would deduplicate
    // against it and the run's history would collapse to a single
    // transition. A sequence that cannot show its steps is not a sequence.
    idempotencyKey: `protocol_state:${executionId}:${execution.state}:${to}:${Date.now()}`,
    metadata: { from: execution.state, to, reason },
  });

  return row;
}

/**
 * Recompute state from what has actually been collected, and move if the
 * facts say so. Called after an answer lands.
 *
 * Never reaches COMPLETED on its own — that requires a human closing the
 * review. The furthest this goes unaided is READY_FOR_REVIEW, which means
 * "the questions are done", not "the case is resolved".
 */
async function advance(pharmacyId, executionId, opts = {}) {
  const state = await getExecutionState(pharmacyId, executionId);
  const { execution, isComplete } = state;

  if (execution.state === STATES.COMPLETED || execution.state === STATES.CANCELLED) return execution;

  const target = isComplete ? STATES.READY_FOR_REVIEW : STATES.AWAITING_INFORMATION;
  if (execution.state === target) return execution;

  // awaiting_information -> ready_for_review is legal; so is in_progress ->
  // either. Anything else (escalated, say) is left alone deliberately: a run
  // a human escalated must not be walked back by an automatic recompute.
  if (!canTransition(execution.state, target).allowed) return execution;

  return transitionTo(pharmacyId, executionId, target, { ...opts, reason: 'recomputed_from_facts' });
}

/**
 * Classify every question the active protocol defines (spec §1).
 *
 * The point is to ask the MINIMUM clinically necessary set: a question whose
 * condition is unmet is NOT_APPLICABLE and must never be put to the patient,
 * and one already answered is KNOWN and must not be asked again.
 *
 * REQUIRES_CONFIRMATION is the interesting one. It covers information the
 * system HAS but should not simply rely on: a value carried in from the
 * profile that this episode has not confirmed, and anything currently in
 * conflict. Both are "known" in the sense that a value exists, and neither
 * is safe to treat as settled — collapsing them into KNOWN is exactly how a
 * stale profile age silently becomes this encounter's truth.
 *
 * @returns {Map<string, {status, question, fact}>} keyed by question_key
 */
async function getInformationStatus(pharmacyId, executionId) {
  const state = await getExecutionState(pharmacyId, executionId);
  const answeredKeys = new Set(state.answers
    .filter((a) => ['answered', 'unknown', 'declined'].includes(a.status))
    .map((a) => a.question_key));

  const out = new Map();
  const allQuestions = await getSql()`
    select * from protocol_questions where protocol_id = ${state.execution.protocol_id}
    order by priority, question_key
  `;

  for (const q of allQuestions) {
    const applicable = isApplicable(q.applicability, state.factsByConcept);
    const fact = state.factsByConcept.get(q.fact_concept) || null;
    let status;

    if (!applicable) {
      status = 'NOT_APPLICABLE';
    } else if (fact && fact.status === 'conflicted') {
      status = 'REQUIRES_CONFIRMATION';
    } else if (!answeredKeys.has(q.question_key) && fact && fact.source === 'profile_reused') {
      // We hold a value, but from the profile rather than from this
      // conversation. Usable as a starting point, not as an answer.
      status = 'REQUIRES_CONFIRMATION';
    } else if (answeredKeys.has(q.question_key)) {
      status = 'KNOWN';
    } else if (q.required) {
      status = 'REQUIRED';
    } else {
      status = 'OPTIONAL';
    }

    out.set(q.question_key, { status, question: q, fact });
  }
  return out;
}

module.exports = {
  STATES, canTransition, isApplicable,
  startProtocol, getExecution, getExecutionState, nextQuestion,
  markQuestionPresented, recordAnswer, transitionTo, advance,
  getInformationStatus,
};
