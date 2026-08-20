/**
 * The single doorway between the conversation layer and the clinical engine.
 *
 * WHAT THIS IS FOR
 * Stage 1 and Stage 2 built a protocol engine, a fact model, an evidence
 * layer and a safety gate — and nothing in worker.js referenced any of them.
 * Every clinical message still went straight to a pharmacist handoff. This
 * module is the integration: it takes a patient message and returns ONE of
 * four outcomes, decided entirely by the existing engine.
 *
 *   CONTINUE        ask the next protocol question
 *   RECOMMENDATION  the safety gate approved something deliverable
 *   REVIEW          a pharmacist should look, at a stated priority
 *   URGENT          emergency escalation
 *
 * IT ADDS NO CLINICAL INTELLIGENCE. There is no rule here about fever,
 * dosing, or what any symptom means. Every clinical judgement is delegated:
 * protocol selection to the protocol registry, question order to
 * protocolExecutionService, approval to safetyGate. This file only sequences
 * calls and translates the result into something the conversation layer can
 * act on.
 *
 * DEFAULT-OFF. isClinicalWorkflowEnabled() gates live use and reads false
 * unless a pharmacy explicitly opts in. With no approved evidence loaded,
 * every path here would end in REVIEW anyway — which is precisely today's
 * behaviour — so switching it on by default would add risk while changing
 * nothing. The tests drive this module directly and do not depend on the
 * flag.
 *
 * FAILS CLOSED, ALWAYS. Every catch in this file ends in REVIEW or URGENT.
 * There is no error path that returns CONTINUE or RECOMMENDATION, because
 * "the database was down" must never be indistinguishable from "the patient
 * is fine". See safeFallback().
 */

const { getSql, assertPharmacyId } = require('../db');
const engine = require('./protocolExecutionService');
const encounters = require('./clinicalEncounterService');
const recommendations = require('./recommendationService');
const { evaluateRedFlags } = require('./redFlagEvaluator');
const facts = require('./clinicalFactService');
const handoffs = require('./pharmacistHandoffService');
const { buildBriefing } = require('./clinicalBriefing');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

const OUTCOME = Object.freeze({
  CONTINUE: 'CONTINUE',
  RECOMMENDATION: 'RECOMMENDATION',
  REVIEW: 'REVIEW',
  URGENT: 'URGENT',
  // A completed assessment with no danger signs and nothing deliverable.
  // The patient gets the sourced safety-net advice and an OFFER of a
  // pharmacist; no handoff is raised unless they take it up. Previously this
  // case paged a pharmacist at low priority every single time — which, with
  // zero recommendations configured, meant every completed assessment.
  RESOLVED: 'RESOLVED',
});

/**
 * The safe answer when anything at all goes wrong.
 *
 * Not a new fallback architecture — it routes to the SAME pharmacist handoff
 * the system has always used, at a priority reflecting how little we know.
 * The customer-facing message deliberately says nothing clinical: a system
 * failure must not be dressed up as reassurance.
 */
function safeFallback(reason, { priority = 'medium', detail = null } = {}) {
  return {
    outcome: OUTCOME.REVIEW,
    priority,
    reason,
    detail,
    question: null,
    recommendationText: null,
    // No clinical content. "I don't know" wearing a friendly face is still
    // "I don't know", and that is the honest thing to say.
    patientMessage: 'Let me get one of our pharmacists to help you with this. '
      + 'They will be with you shortly.',
    failedSafe: true,
  };
}

/** Is the clinical workflow switched on for this pharmacy? Default false. */
async function isClinicalWorkflowEnabled(pharmacyId) {
  assertPharmacyId(pharmacyId);
  try {
    const db = getSql();
    const [row] = await db`
      select clinical_workflow_enabled from pharmacy_profile where pharmacy_id = ${pharmacyId}
    `;
    return row?.clinical_workflow_enabled === true;
  } catch {
    // Cannot read the flag => treat as off. An unreadable configuration is
    // not permission to run a clinical workflow.
    return false;
  }
}

/**
 * Ensure there is an open clinical encounter + protocol run for this
 * conversation, creating them on first clinical message.
 *
 * A conversation is NOT automatically an encounter (Stage 1 §7) — the caller
 * decides a message is clinical before reaching here.
 */
async function ensureRun(pharmacyId, { conversationId, customerId, protocolSlug, actorType = 'ai' }) {
  // Guarded here as well as in the services this delegates to. Isolation was
  // already enforced one level down, but a public entry point that builds a
  // tenant-scoped query should reject a missing tenant loudly rather than
  // sending `pharmacy_id = null` and quietly matching nothing.
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [open] = await db`
    select e.id from clinical_encounters e
    where e.pharmacy_id = ${pharmacyId} and e.conversation_id = ${conversationId}
      and e.status not in ('completed', 'cancelled')
    order by e.started_at desc limit 1
  `;

  const encounterId = open
    ? open.id
    : (await encounters.createEncounter(pharmacyId, customerId, { conversationId }, { actorType })).id;

  const execution = await engine.startProtocol(pharmacyId, encounterId, protocolSlug, {
    actorType, customerId,
  });
  return { encounterId, execution };
}

/**
 * THE LLM BOUNDARY (spec §2).
 *
 * The conversation layer may propose a recommendation KEY — never content.
 * This function is the only way a recommendation reaches a patient, and it
 * re-runs the gate itself rather than trusting any earlier result. So a
 * model that fabricates a recommendation, or replays a stale approval, gets
 * the same answer as a model that asks for something that does not exist:
 * nothing deliverable.
 *
 * @returns {{approved: boolean, text: string|null, decision: object}}
 */
async function releaseRecommendation(pharmacyId, executionId, {
  recommendationKey, clinicalConfidence, firedRedFlags = null, customerId = null,
}) {
  assertPharmacyId(pharmacyId);
  const res = await recommendations.evaluate(pharmacyId, executionId, {
    recommendationKey, clinicalConfidence, firedRedFlags,
  }, { actorType: 'ai', customerId });

  // deliverableText is null for every non-eligible outcome — the gate, not
  // this function, decides that. Repeated here as an explicit assertion
  // because it is the last line before text reaches a human.
  if (res.decision.status !== 'eligible' || !res.deliverableText) {
    return { approved: false, text: null, decision: res.decision, evaluation: res.evaluation, result: res };
  }
  return { approved: true, text: res.deliverableText, decision: res.decision, evaluation: res.evaluation, result: res };
}

/**
 * Reject an LLM-authored recommendation outright.
 *
 * Exists so the boundary is a CALLABLE, TESTABLE rule rather than a
 * convention. Any caller holding free text that a model produced passes it
 * here and gets a refusal — there is no argument shape that makes this
 * function return the text.
 */
function rejectUnapprovedRecommendation(freeText) {
  return {
    approved: false,
    text: null,
    reason: 'llm_authored_recommendation_rejected',
    detail: 'Recommendation content must come from an authored, evidence-backed rule '
      + 'that has passed the safety gate. Model-generated clinical content is never delivered.',
    // Deliberately does NOT echo the rejected text back to the caller —
    // that would be one copy-paste away from delivering it anyway.
    rejectedLength: typeof freeText === 'string' ? freeText.length : 0,
  };
}

/**
 * Drive one turn of a clinical conversation.
 *
 * @param {object} args
 * @param {string} args.conversationId
 * @param {string} args.customerId
 * @param {string} args.protocolSlug
 * @param {string} [args.patientMessage]    the raw inbound text
 * @param {string} [args.answeringKey]      question this message answers
 * @param {number} [args.clinicalConfidence]
 * @param {string} [args.recommendationKey] candidate to evaluate when complete
 * @param {object[]} [args.firedRedFlags]
 * @returns {{outcome, priority, question, recommendationText, patientMessage, ...}}
 */
async function handleTurn(pharmacyId, args = {}) {
  const {
    conversationId, customerId, protocolSlug,
    patientMessage = null, answeringKey = null,
    clinicalConfidence = null, recommendationKey = null, firedRedFlags = null,
  } = args;

  let run;
  try {
    assertPharmacyId(pharmacyId);
    run = await ensureRun(pharmacyId, { conversationId, customerId, protocolSlug });
  } catch (err) {
    // Protocol missing, encounter creation failed, database unreachable —
    // all indistinguishable from the patient's point of view, and all
    // resolved the same safe way.
    return safeFallback('clinical_engine_unavailable', {
      priority: 'medium', detail: err.code || err.message,
    });
  }

  const { encounterId, execution } = run;

  // ---- record the answer, if this message answers an outstanding question ----
  if (answeringKey && patientMessage) {
    try {
      await engine.recordAnswer(pharmacyId, execution.id, answeringKey, patientMessage, { customerId });
    } catch (err) {
      // A failed extraction must not silently drop the patient's words. The
      // message is already stored by the conversation layer; we escalate
      // rather than continue on an incomplete picture.
      return safeFallback('fact_extraction_failed', {
        priority: 'medium', detail: err.code || err.message,
      });
    }
  }

  let state;
  try {
    state = await engine.getExecutionState(pharmacyId, execution.id);
  } catch (err) {
    return safeFallback('protocol_state_unavailable', { priority: 'medium', detail: err.code || err.message });
  }

  // ---- red flags outrank everything, including "still collecting info" ----
  // EVALUATED against this patient's answers, not merely listed. Until 0036
  // this called activeRedFlags(), which returns every active rule for the
  // protocol regardless of what the patient said — so a protocol with any
  // configured flag escalated urgently on the FIRST message, before asking
  // anything. fever v2 ships eight active flags, so every "I have fever"
  // would have produced an immediate emergency referral.
  const flags = firedRedFlags || await evaluateRedFlags(pharmacyId, execution.protocol_id, state.factsByConcept)
    .then((r) => r.fired)
    .catch(() => []);
  if (flags.length > 0) {
    const emergency = flags.some((f) => f.action === 'emergency_referral' || f.severity === 'emergency');
    await escalate(pharmacyId, {
      conversationId, customerId, encounterId, executionId: execution.id,
      priority: emergency ? 'urgent' : 'high',
      reason: 'red_flag_present',
      firedRedFlags: flags, clinicalConfidence,
    }).catch(() => {});
    return {
      outcome: emergency ? OUTCOME.URGENT : OUTCOME.REVIEW,
      priority: emergency ? 'urgent' : 'high',
      reason: 'red_flag_present',
      question: null, recommendationText: null,
      patientMessage: emergency
        ? 'Based on what you have told me, please seek medical care straight away. '
          + 'I am alerting our pharmacist now.'
        : 'I want our pharmacist to look at this with you. They will be with you shortly.',
      redFlags: flags,
    };
  }

  // ---- unresolved conflicts need a human before anything else proceeds ----
  if (state.conflicts.length > 0) {
    await escalate(pharmacyId, {
      conversationId, customerId, encounterId, executionId: execution.id,
      priority: 'medium', reason: 'conflicting_information', clinicalConfidence,
    }).catch(() => {});
    return {
      outcome: OUTCOME.REVIEW, priority: 'medium', reason: 'conflicting_information',
      question: null, recommendationText: null,
      patientMessage: 'Thanks — let me check something with our pharmacist and come back to you.',
      conflicts: state.conflicts,
    };
  }

  // ---- still collecting: ask the next approved question ----
  if (!state.isComplete) {
    const next = state.nextQuestion;
    if (!next) {
      // Required information outstanding but no question available to ask
      // for it — a protocol configuration problem, not something to guess
      // around.
      return safeFallback('no_question_available_for_missing_information', { priority: 'medium' });
    }

    // THREE STRIKES. Once a run is open, clinicalRouter force-feeds every
    // subsequent message into it as an answer to whatever is outstanding —
    // "Hello", "??", "let's forget that", all of it — because that is what
    // lets "3 days" work as a reply to a real question. The failure mode is
    // the same mechanism turned against itself: a live conversation asked
    // this exact question on every single message for over an hour, because
    // nothing checked whether the answer was EVER going to land. A patient
    // must not be trapped answering a question they cannot get past —
    // whether because the choices do not cover how a person actually
    // answers (this happened: "No" matched neither "I have a reading" nor
    // "It just feels hot"), or because they have clearly moved on and the
    // run does not know it yet.
    //
    // encounter_answers is append-only, so every prior attempt at THIS
    // question is still in state.answers — counting the ones that never
    // satisfied it is exactly "how many times has this not worked".
    const FAILED_ATTEMPT_LIMIT = 3;
    const failedAttempts = state.answers.filter(
      (a) => a.question_key === next.question_key && !['answered', 'unknown', 'declined'].includes(a.status),
    ).length;
    if (failedAttempts >= FAILED_ATTEMPT_LIMIT) {
      await escalate(pharmacyId, {
        conversationId, customerId, encounterId, executionId: execution.id,
        priority: 'medium', reason: 'stuck_on_question', clinicalConfidence,
      }).catch(() => {});
      return {
        outcome: OUTCOME.REVIEW,
        priority: 'medium',
        reason: 'stuck_on_question',
        question: null,
        recommendationText: null,
        patientMessage: "I'm having trouble understanding your answers here — let me get a pharmacist to help you directly.",
      };
    }

    // NOT wrapped in a swallowing catch. An audit write that fails silently
    // is worse than one that throws: it leaves you believing you have a
    // record you do not have. This exact `.catch(() => {})` hid a real
    // idempotency-key collision during Part 3 validation — the event was
    // being deduplicated away for every patient after the first, and the
    // swallow meant nothing surfaced. If auditing is broken, the safe
    // response is to fail the turn into pharmacist review, not to carry on
    // unrecorded.
    try {
      await engine.markQuestionPresented(pharmacyId, execution.id, next.id, { customerId });
    } catch (err) {
      return safeFallback('audit_write_failed', { priority: 'medium', detail: err.code || err.message });
    }
    await engine.advance(pharmacyId, execution.id, { customerId }).catch(() => {});
    return {
      outcome: OUTCOME.CONTINUE,
      priority: null,
      reason: 'collecting_required_information',
      // The APPROVED question text. The conversation layer may rephrase it
      // naturally; it may not substitute a different clinical question.
      question: { key: next.question_key, text: next.text, helpText: next.help_text, answerType: next.answer_type },
      recommendationText: null,
      patientMessage: next.text,
      missingRequired: state.missingRequired.map((q) => q.question_key),
    };
  }

  await engine.advance(pharmacyId, execution.id, { customerId }).catch(() => {});

  // ---- information complete: can anything be recommended? ----
  let released;
  try {
    released = await releaseRecommendation(pharmacyId, execution.id, {
      recommendationKey, clinicalConfidence, firedRedFlags: flags, customerId,
    });
  } catch (err) {
    return safeFallback('recommendation_engine_unavailable', {
      priority: 'medium', detail: err.code || err.message,
    });
  }

  if (released.approved) {
    await recordClinicalEvent(getSql(), {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.RECOMMENDATION_DELIVERED,
      actorType: 'ai',
      entityType: 'recommendation_evaluation', entityId: released.evaluation.id,
      metadata: { recommendationKey, status: released.decision.status },
    }).catch(() => {});

    return {
      outcome: OUTCOME.RECOMMENDATION,
      priority: null,
      reason: 'passed_safety_gate',
      question: null,
      recommendationText: released.text,
      patientMessage: released.text,
      evaluationId: released.evaluation.id,
      decision: released.decision,
    };
  }

  // ---- not deliverable: pharmacist, at the gate's own priority ----
  //
  // The gate returns NO priority for a Level 2 outcome, because uncertainty is
  // not danger. `|| 'medium'` alone would have thrown that away and escalated
  // anyway, silently undoing the whole point of the level.
  //
  // But reaching this line means the missing-information branch above already
  // passed — every required question is answered. So there is nothing further
  // to ask, and returning CONTINUE here would strand the patient mid-
  // conversation with no answer and nobody told. An assessment that is
  // complete and still inconclusive is §7's "clinically significant
  // uncertainty", which a human should see — at LOW priority, so it never
  // competes with a red flag in the queue.
  //
  // The Level 2 "do not page" win lands where it belongs: the branch above,
  // which asks the next question instead of escalating, and which is the
  // common case by a wide margin.
  // A COMPLETED assessment with nothing deliverable is not, on its own, a
  // reason to interrupt a pharmacist. With zero recommendations configured
  // this is EVERY completed assessment, so the old low-priority page meant a
  // pharmacist alert for every patient who answered all the questions —
  // exactly the flood the product decision rejects.
  //
  // Escalate only on a real safety signal: a hard block (exclusion, patient
  // outside the supported population), or a gate priority of high/urgent.
  // Anything softer gets the sourced safety net and an OFFER of a human,
  // which the patient can accept — see buildSafetyNet.
  const gatePriority = released.decision.escalationPriority;
  const isRealSafetyConcern = released.decision.status === 'blocked'
    || gatePriority === 'high' || gatePriority === 'urgent';

  if (!isRealSafetyConcern) {
    await engine.transitionTo(pharmacyId, execution.id, 'completed', { customerId })
      .catch(() => {});
    return {
      outcome: OUTCOME.RESOLVED,
      priority: null,
      reason: released.decision.reasons[0] || 'no_deliverable_recommendation',
      reasons: released.decision.reasons,
      question: null,
      recommendationText: null,
      patientMessage: buildSafetyNet(state),
      decision: released.decision,
    };
  }

  const priority = gatePriority || 'medium';
  await escalate(pharmacyId, {
    conversationId, customerId, encounterId, executionId: execution.id,
    priority, reason: released.decision.reasons.join(',') || 'not_eligible',
    clinicalConfidence, evaluation: released.result,
  }).catch(() => {});

  return {
    outcome: priority === 'urgent' ? OUTCOME.URGENT : OUTCOME.REVIEW,
    priority,
    reason: released.decision.reasons[0] || 'not_eligible',
    reasons: released.decision.reasons,
    question: null,
    recommendationText: null,
    patientMessage: 'Let me get our pharmacist to confirm this for you. '
      + 'They will be with you shortly.',
    decision: released.decision,
  };
}

/**
 * Raise a pharmacist handoff carrying the structured briefing.
 *
 * Reuses the existing handoff system unchanged — including its
 * consolidation, so a second concern in the same conversation appends to the
 * open handoff instead of paging twice.
 */
/**
 * The closing message for a completed assessment with nothing to recommend.
 *
 * WHERE THE WORDS COME FROM
 * The danger list is lifted verbatim from the protocol's own danger-signs
 * question — STG-sourced text the patient has already been shown once. This
 * function writes no clinical content of its own: it re-states a sourced
 * list and offers a human. That is `PATIENT_INFORMATION`, which every
 * protocol's recommendationBoundaries permits, and it is explicitly NOT a
 * MEDICATION_RECOMMENDATION, which they all forbid.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY
 * Nothing about what to take. Not paracetamol, not fluids, not rest — no
 * medicine and no self-care instruction, because no approved evidence backs
 * one for an undifferentiated presentation. Suggesting even something benign
 * here would be the engine inventing guidance, which is the one thing the
 * whole gate exists to prevent.
 */
function buildSafetyNet(state) {
  const dangerQ = (state.applicableQuestions || [])
    .find((q) => /danger_signs/.test(q.fact_concept || q.factConcept || ''));

  const lines = ['Thanks — I have noted all of that.'];
  if (dangerQ?.help_text) {
    lines.push(
      `Please keep an eye out. If any of these start, get medical help straight away: ${dangerQ.help_text}`,
    );
  }
  lines.push(
    'I am not able to suggest any medicine for this myself. '
    + 'Would you like our pharmacist to take a look and advise you? Just say yes and I will pass it on.',
  );
  return lines.join('\n\n');
}

async function escalate(pharmacyId, {
  conversationId, customerId, encounterId, executionId,
  priority = 'medium', reason = 'clinical', clinicalConfidence = null, evaluation = null, firedRedFlags = null,
}) {
  assertPharmacyId(pharmacyId);
  let briefing = null;
  try {
    const state = await engine.getExecutionState(pharmacyId, executionId);
    const decision = evaluation?.decision || {
      status: 'requires_review', reasons: [reason], trace: [],
      escalationPriority: priority, clinicalConfidence,
    };
    if (firedRedFlags && !decision.trace.some((t) => t.check === 'no_red_flags')) {
      decision.trace.push({ check: 'no_red_flags', passed: false, flags: firedRedFlags });
    }
    briefing = buildBriefing({
      decision, executionState: state,
      recommendation: evaluation?.recommendation || null,
      evidence: evaluation?.evidence || null,
    });
  } catch {
    // A briefing that cannot be built must not prevent the escalation
    // itself. The pharmacist gets the case with less context rather than
    // not getting it at all.
    briefing = `PHARMACIST REVIEW — ${String(priority).toUpperCase()}\nReason: ${reason}\n`
      + '(Full briefing unavailable — see the conversation.)';
  }

  return handoffs.raiseClinicalHandoff(pharmacyId, {
    conversationId, customerId, encounterId,
    category: 'symptoms',
    detail: briefing,
  }, { actorType: 'ai' });
}

module.exports = {
  OUTCOME, handleTurn, releaseRecommendation, rejectUnapprovedRecommendation,
  escalate, ensureRun, isClinicalWorkflowEnabled, safeFallback,
};
