/**
 * Accept / complete / cancel a clinical handoff — the operations that,
 * before this file, existed only inline inside routes/conversations.js
 * (/:id/takeover, /:id/resolve) and were not callable from anywhere else.
 * Raising a handoff is NOT duplicated here — that already works correctly
 * in whatsapp/handoffService.js (raiseOrConsolidateHandoff), which this
 * module wraps for the clinical case by additionally linking the handoff to
 * its clinical_encounters row.
 *
 * "PENDING ≠ ACTIVE" — REUSED, NOT REBUILT
 * This is the exact rule the hybrid-handoff segment implemented:
 * conversationState.deriveOwnership() already says a handoff being raised
 * does not mute the assistant, and only POST /:id/takeover moving
 * conversations.mode to 'human' does. This module's acceptHandoff() IS
 * that same action, exposed as a callable service function instead of
 * logic trapped inside one route — so a future clinical-specific UI or
 * flow can call it directly, and so it can drive clinical_encounters.status
 * alongside the same conversation mutation, in the same transaction.
 *
 * TWO AXES, NOT ONE COMBINED STATUS
 * The distinction that matters is not ACCEPTED-vs-ACTIVE on a single
 * field — it is that "has a pharmacist been asked for" and "who is
 * replying right now" are independent facts:
 *
 *   handoff_status = PENDING  +  owner = AI     pharmacist requested,
 *                                                assistant still helping
 *   handoff_status = ACTIVE   +  owner = HUMAN  pharmacist took control
 *   handoff_status = PENDING  +  owner = AI     ...and after an idle
 *                                                takeback, back here again
 *                                                WITHOUT losing the request
 *
 * That third line is the whole point of keeping them separate: the AI can
 * resume answering without the pharmacist request being forgotten. A single
 * combined status cannot express it — handing back to the AI would have to
 * either cancel the handoff (losing the escalation) or leave the thread
 * muted (stranding the customer).
 *
 * handoff_status comes from deriveHandoffStatus() here; owner comes from
 * conversationState.deriveOwnership(). Neither is stored twice.
 */

const { getSql, assertPharmacyId } = require('../db');
const { raiseOrConsolidateHandoff } = require('../whatsapp/handoffService');
const { recordClinicalEvent } = require('./clinicalAudit');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const encounters = require('./clinicalEncounterService');

const STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

/** Who is replying right now. The second axis — see the module header. */
const OWNER = Object.freeze({ AI: 'AI', HUMAN: 'HUMAN' });

/**
 * Pure. A handoff row (or null) in, one of the six status values out.
 * cancelled_at (0030) is what distinguishes CANCELLED from COMPLETED — both
 * set resolved_at, only a decline/cancel additionally sets cancelled_at.
 */
function deriveHandoffStatus(handoff) {
  if (!handoff) return STATUS.NOT_REQUIRED;
  if (handoff.resolved_at) {
    return handoff.cancelled_at ? STATUS.CANCELLED : STATUS.COMPLETED;
  }
  if (handoff.accepted_at) return STATUS.ACTIVE;
  return STATUS.PENDING;
}

/**
 * Raise a clinical handoff for an encounter — thin wrapper over the
 * existing, already-correct raiseOrConsolidateHandoff, plus linking
 * handoffs.encounter_id and moving the encounter to
 * PHARMACIST_REVIEW_REQUIRED in the same transaction.
 */
async function raiseClinicalHandoff(pharmacyId, {
  conversationId, customerId, encounterId, reason = 'clinical', category, detail,
}, { actorType = 'ai', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const raised = await db.begin(async (tx) => {
    const result = await raiseOrConsolidateHandoff(tx, {
      pharmacyId, conversationId, customerId, reason, category, detail,
      triggeredBy: actorType === 'ai' ? 'assistant' : 'customer', actorType,
    });
    if (result.isNew && encounterId) {
      await tx`update handoffs set encounter_id = ${encounterId} where id = ${result.handoffId}`;
    }
    return result;
  });

  if (encounterId) {
    await encounters.moveEncounterStatus(pharmacyId, encounterId, encounters.STATES.PHARMACIST_REVIEW_REQUIRED, {
      actorType, actorId, reason: 'handoff_raised',
    });
  }

  return raised;
}

/**
 * A pharmacist claims the handoff. Mirrors POST /:id/takeover exactly
 * (same two writes, same transaction discipline) but ALSO, when the handoff
 * carries an encounter_id, moves that encounter to PHARMACIST_ACTIVE and
 * records HANDOFF_ACCEPTED — the audit event /takeover never had a place
 * to emit, because it was never wrapped as a reusable service function
 * before this.
 */
async function acceptHandoff(pharmacyId, handoffId, { actorId }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [handoff] = await db`
    select id, conversation_id, encounter_id, resolved_at from handoffs
    where id = ${handoffId} and pharmacy_id = ${pharmacyId}
  `;
  if (!handoff) {
    const err = new Error('Handoff not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  if (handoff.resolved_at) {
    const err = new Error('This handoff is already resolved.');
    err.status = 409; err.code = 'ALREADY_RESOLVED';
    throw err;
  }

  await db.begin(async (tx) => {
    await tx`update conversations set mode = 'human' where id = ${handoff.conversation_id} and pharmacy_id = ${pharmacyId}`;
    await tx`
      update handoffs set accepted_by = ${actorId}, accepted_at = now(), handoff_last_activity_at = now()
      where id = ${handoffId} and resolved_at is null and accepted_at is null
    `;
  });

  let customerId = null;
  if (handoff.conversation_id) {
    const [conv] = await db`select customer_id from conversations where id = ${handoff.conversation_id}`;
    customerId = conv?.customer_id || null;
  }

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.HANDOFF_ACCEPTED,
    actorType: 'pharmacist', actorId,
    entityType: 'handoff', entityId: handoffId,
    metadata: { encounterId: handoff.encounter_id },
  });

  if (handoff.encounter_id) {
    await encounters.moveEncounterStatus(pharmacyId, handoff.encounter_id, encounters.STATES.PHARMACIST_ACTIVE, {
      actorType: 'pharmacist', actorId, reason: 'handoff_accepted',
    });
  }

  return { handoffId, status: STATUS.ACTIVE };
}

/**
 * A pharmacist finishes. Mirrors POST /:id/resolve (resolved_at, no
 * `cancelled` flag), and moves the linked encounter to COMPLETED —
 * refused by the encounter's own state matrix unless it is currently
 * PHARMACIST_ACTIVE, which is exactly the guarantee spec §6 asks for:
 * an encounter cannot be marked done while still waiting on review.
 */
async function completeHandoff(pharmacyId, handoffId, { actorId, reason = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [handoff] = await db`
    update handoffs set resolved_at = now()
    where id = ${handoffId} and pharmacy_id = ${pharmacyId} and resolved_at is null
    returning id, conversation_id, encounter_id
  `;
  if (!handoff) {
    const err = new Error('Handoff not found or already resolved.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  let customerId = null;
  if (handoff.conversation_id) {
    const [conv] = await db`select customer_id from conversations where id = ${handoff.conversation_id}`;
    customerId = conv?.customer_id || null;
  }
  await recordEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.PHARMACIST_RESPONDED,
    actorType: 'pharmacist', actorId,
    entityType: 'handoff', entityId: handoffId,
    metadata: { encounterId: handoff.encounter_id, reason },
  });

  if (handoff.encounter_id) {
    await encounters.moveEncounterStatus(pharmacyId, handoff.encounter_id, encounters.STATES.COMPLETED, {
      actorType: 'pharmacist', actorId, reason,
    });
  }

  return { handoffId, status: STATUS.COMPLETED };
}

/**
 * A handoff that never needed a pharmacist after all — the customer
 * declined, or staff judge it moot. Distinguished from completeHandoff by
 * ALSO cancelling the linked encounter (if any), which completeHandoff
 * deliberately does not do — completing and cancelling are not the same
 * fact about what happened.
 */
async function cancelHandoff(pharmacyId, handoffId, { actorId, actorType = 'staff', reason = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [handoff] = await db`
    update handoffs set resolved_at = now(), cancelled_at = now()
    where id = ${handoffId} and pharmacy_id = ${pharmacyId} and resolved_at is null
    returning id, conversation_id, encounter_id
  `;
  if (!handoff) {
    const err = new Error('Handoff not found or already resolved.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  if (handoff.encounter_id) {
    const encounter = await encounters.getEncounter(pharmacyId, handoff.encounter_id);
    // Only cancel states the matrix actually allows landing CANCELLED from.
    // A handoff cancelled after its encounter is already COMPLETED must not
    // try to force an illegal transition — the encounter's own history
    // stands as it is.
    if (encounter && encounters.canTransition(encounter.status, encounters.STATES.CANCELLED).allowed) {
      await encounters.moveEncounterStatus(pharmacyId, handoff.encounter_id, encounters.STATES.CANCELLED, {
        actorType, actorId, reason,
      });
    }
  }

  return { handoffId, status: STATUS.CANCELLED };
}

module.exports = {
  STATUS, deriveHandoffStatus, raiseClinicalHandoff, acceptHandoff, completeHandoff, cancelHandoff,
};
