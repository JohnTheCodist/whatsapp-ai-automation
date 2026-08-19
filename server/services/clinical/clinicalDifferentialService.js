/**
 * Pharmacist-only AI differential — "what might this be" for a human to
 * weigh, never a diagnosis and never anything a patient sees.
 *
 * WHY THIS IS A SEPARATE MODULE FROM RECOMMENDATIONS
 * recommendationService + safetyGate exist to let a SOURCED, PHARMACIST-
 * AUTHORED conclusion reach a patient automatically, and they refuse
 * anything else — that is the entire point of the evidence gate. This is
 * the opposite shape on purpose: an UNSOURCED, MODEL-GENERATED opinion that
 * can never reach a patient, requested on demand by a human who will read
 * it critically. Mixing the two would let an unvalidated guess borrow the
 * gate's credibility; keeping them apart is what makes the gate meaningful.
 *
 * WHY ON DEMAND, NOT AUTOMATIC ON ESCALATION
 * clinicalWorkflow.escalate() is awaited before a patient's reply is sent —
 * for a red-flag case, that reply says "seek care immediately". Adding an
 * LLM call to that path would delay the one message that most needs to be
 * fast. This is called separately, by a pharmacist choosing to ask, with no
 * effect on anything patient-facing.
 *
 * WHAT THIS NEVER DOES (mirrors the constraint the whole clinical build
 * follows): no drug name, no dose, no "you have X" — a ranked list of
 * possible causes and nothing that could be mistaken for a treatment plan.
 */

const { getSql, assertPharmacyId } = require('../db');
const engine = require('./protocolExecutionService');
const { chat, isConfigured } = require('../ai/llmClient');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

const DISCLAIMER = 'AI-SUGGESTED DIFFERENTIAL — unvalidated, not a diagnosis, for pharmacist '
  + 'reference only. Not sourced, not evidence-gated, and not seen by the patient. '
  + 'Clinical judgement remains yours.';

const SYSTEM_PROMPT = `You are assisting a licensed pharmacist reviewing an escalated case. You are
NOT talking to the patient and NOTHING you write will be shown to them.

Given the collected clinical facts, list up to 5 possible causes a pharmacist
might consider, ordered most to least likely, each with one short line of
reasoning grounded ONLY in the facts given.

Hard rules:
- Never name a drug, a dose, or any treatment.
- Never state a diagnosis as settled fact ("this is X") — every line is a
  possibility for a human to weigh, not a conclusion.
- If the facts are too sparse to say anything useful, say so plainly instead
  of guessing.
- Do not address the patient. Write for the pharmacist reading this.

Format: a plain numbered list, one line each. No preamble, no closing advice.`;

/**
 * @param {string} pharmacyId
 * @param {string} executionId  the protocol_execution being reviewed
 * @param {object} args
 * @param {string} [args.actorType] 'pharmacist' | 'staff' — who asked
 * @param {string} [args.actorId]
 * @param {string} [args.customerId] for the audit trail
 * @returns {Promise<{text:string, disclaimer:string, generatedAt:string, protocolSlug:string, protocolVersion:string}>}
 */
async function suggestLikelyCauses(pharmacyId, executionId, {
  actorType = 'pharmacist', actorId = null, customerId = null,
} = {}) {
  assertPharmacyId(pharmacyId);

  if (!isConfigured()) {
    const err = new Error('The AI assistant is not configured.');
    err.status = 503; err.code = 'LLM_UNAVAILABLE';
    throw err;
  }

  const state = await engine.getExecutionState(pharmacyId, executionId);
  const facts = state.facts.filter((f) => f.status !== 'superseded');

  const factLines = facts.length
    ? facts.map((f) => `- ${f.concept}: ${f.value}${f.unit ? ` ${f.unit}` : ''} (${f.source})`).join('\n')
    : '(no facts recorded)';

  const userPrompt = `Protocol: ${state.protocolSlug} v${state.protocolVersion}\n\n`
    + `Collected clinical facts:\n${factLines}`;

  let response;
  try {
    response = await chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      // The provider is a reasoning model: completion_tokens covers its
      // internal reasoning AND the visible answer, and the two share one
      // budget. At 400 a real request spent all 400 on reasoning and
      // returned an EMPTY completion — finishReason 'length' with zero
      // visible content, not a truncated-but-readable answer. 1200 leaves
      // headroom for both on a 5-item list; verified against a live call
      // (270 reasoning + 164 content, finishReason 'stop').
      maxTokens: 1200,
      temperature: 0.2,
    });
  } catch (err) {
    const wrapped = new Error('Could not generate a differential right now.');
    wrapped.status = 503; wrapped.code = 'DIFFERENTIAL_UNAVAILABLE'; wrapped.cause = err;
    throw wrapped;
  }

  const suggestion = {
    text: (response.content || '').trim() || '(the model returned nothing usable)',
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
    protocolSlug: state.protocolSlug,
    protocolVersion: state.protocolVersion,
  };

  // The differential itself already succeeded at this point — nothing
  // downstream depends on this write the way protocol state depends on
  // markQuestionPresented, so a failed audit write does not cost the
  // pharmacist their result. It does get logged loudly rather than
  // swallowed, because "who asked an AI for an opinion, and when" is exactly
  // the kind of record this system's audit trail exists to keep.
  try {
    const db = getSql();
    await recordClinicalEvent(db, {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.DIFFERENTIAL_SUGGESTED,
      actorType, actorId,
      entityType: 'protocol_execution', entityId: executionId,
      metadata: { protocolSlug: state.protocolSlug, protocolVersion: state.protocolVersion },
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'differential audit write failed', executionId, error: err.message,
    }));
  }

  return suggestion;
}

module.exports = { suggestLikelyCauses, DISCLAIMER };
