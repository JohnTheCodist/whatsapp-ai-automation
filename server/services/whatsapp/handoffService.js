/**
 * Raising a handoff, without letting three clinical questions in five
 * minutes become three separate pharmacist notifications about one
 * situation.
 *
 * THE PROBLEM THIS SOLVES
 * Once the assistant stays active during HUMAN_PENDING (see
 * conversationState.deriveOwnership), a customer waiting on a pharmacist is
 * free to keep talking — and if their next message ALSO needs a pharmacist,
 * the naive behaviour is to raise a second handoff, send a second full
 * "I've alerted our pharmacist" message, and ping staff a second time about
 * a conversation they were already told about. That is worse than silence:
 * it reads as the system not remembering what it just did, and it fragments
 * one clinical picture across N disconnected alerts.
 *
 * THE RULE
 * At most ONE open (unresolved) handoff per conversation. A second reason to
 * escalate while one is already open is not a new handoff — it is more
 * context for the one already waiting. The pharmacist opening Consultations
 * sees everything the customer has said since the first escalation, in one
 * place, not one alert per sentence.
 *
 * WHY THIS IS ITS OWN MODULE
 * Two call sites in worker.js need this — the clinical filter's handoff
 * path, and the "speak to the pharmacist" menu choice — and both used to
 * duplicate the insert-handoff-and-notify logic. Centralising it means a
 * third future trigger (a complaint keyword, a payment issue) gets the
 * consolidation behaviour for free, the same reason conversationPolicy and
 * conversationState are their own modules rather than inline in worker.js.
 */

const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { onHandoffRaised } = require('./conversationService');

/**
 * @param {object} tx  an open transaction — this always runs inside one, so
 *   the handoff row, the event, and the workflow-state move land together
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} args.conversationId
 * @param {string} [args.customerId]     for the recorded event
 * @param {string} args.reason           handoffs.reason — human-readable category label
 * @param {string} args.category         handoffs.category — the machine key (e.g. 'drug_interaction')
 * @param {string} args.detail           what triggered THIS escalation
 * @param {string} args.triggeredBy      'assistant' | 'customer'
 * @param {string} [args.actorType]      for the event — 'ai' | 'customer'
 * @returns {Promise<{handoffId: string, isNew: boolean}>}
 */
async function raiseOrConsolidateHandoff(tx, {
  pharmacyId, conversationId, customerId = null, reason, category, detail, triggeredBy, actorType,
}) {
  const [existing] = await tx`
    select id from handoffs
    where conversation_id = ${conversationId} and resolved_at is null
    order by requested_at desc
    limit 1
  `;

  if (existing) {
    // Appended, not overwritten — the pharmacist needs the FIRST reason this
    // thread escalated as much as the newest one. A timestamped line per
    // addition is what turns "three fragmented messages" (§13) into one
    // readable timeline inside a single handoff record.
    await tx`
      update handoffs
      set detail = detail || E'\n\n[' || to_char(now(), 'HH24:MI') || '] ' || ${detail}
      where id = ${existing.id}
    `;
    await recordEvent(tx, {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.PHARMACIST_HANDOFF,
      actorType,
      entityType: 'handoff', entityId: existing.id,
      // consolidated:true is what a caller/analytics reads to know this did
      // NOT create a new pharmacist-facing alert.
      metadata: { reason, category, consolidated: true },
    });
    return { handoffId: existing.id, isNew: false };
  }

  const [handoff] = await tx`
    insert into handoffs (pharmacy_id, conversation_id, reason, category, detail, triggered_by)
    values (${pharmacyId}, ${conversationId}, ${reason}, ${category}, ${detail}, ${triggeredBy})
    returning id, requested_at
  `;
  await recordEvent(tx, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.PHARMACIST_HANDOFF, occurredAt: handoff.requested_at,
    actorType,
    entityType: 'handoff', entityId: handoff.id,
    metadata: { reason, category },
  });
  // The workflow axis moves regardless of `mode` — see conversationState's
  // header on this file's sibling. A handoff existing is what makes the
  // inbox show high priority; whether the assistant is muted is a separate
  // question decided by deriveOwnership.
  await onHandoffRaised(tx, { pharmacyId, conversationId });

  return { handoffId: handoff.id, isNew: true };
}

module.exports = { raiseOrConsolidateHandoff };
