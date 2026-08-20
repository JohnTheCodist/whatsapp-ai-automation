/**
 * The one place a conversation's workflow state is written.
 *
 * WHY THIS EXISTS RATHER THAN `update conversations set workflow_state = ...`
 * scattered across routes
 * Every state in conversationState.js means something to the pharmacist
 * reading the inbox. The moment two places can write the column, they drift:
 * a route sets 'resolved' without closing `status`, a component sets
 * 'ai_handling' on a thread that was archived, and the inbox starts showing
 * states that do not describe reality. Funnelling every write through
 * applyTransition() means an illegal move is refused rather than stored.
 *
 * WHAT A CALLER GETS BACK
 * Never a throw for an illegal transition — a refusal, with a reason. These
 * are called from the inbound message path, where a thrown error means a
 * customer's message goes unanswered. A refused transition is a bug worth
 * logging; it is not worth dropping a message over.
 *
 * Every function scopes on pharmacy_id. A conversation id alone is never
 * enough to move another tenant's thread.
 */

const { getSql, assertPharmacyId } = require('../db');
const { applyTransition, STATES } = require('./conversationState');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

/**
 * Move a conversation to `to`, if the matrix allows it.
 *
 * @param {object} sql       an existing handle, so this can join a caller's transaction
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} args.conversationId
 * @param {string} args.to             target state
 * @param {string} [args.actorType]    'customer' | 'ai' | 'staff' | 'system'
 * @param {string} [args.actorId]
 * @param {string} [args.reason]       why, for the audit trail
 * @returns {Promise<{changed: boolean, from?: string, to?: string, reason: string}>}
 */
async function transitionTo(sql, {
  pharmacyId, conversationId, to, actorType = 'system', actorId = null, reason = null,
}) {
  assertPharmacyId(pharmacyId);

  // Locked, not just read. Two inbound messages arriving together would
  // otherwise both read 'open', both compute a legal move, and the second
  // would overwrite the first's decision using a stale `from`. FOR UPDATE
  // serialises them so the second evaluates against what the first actually
  // wrote — the same reason the ingest path locks before resolving.
  const [current] = await sql`
    select id, customer_id, workflow_state
    from conversations
    where id = ${conversationId} and pharmacy_id = ${pharmacyId}
    for update
  `;
  if (!current) return { changed: false, reason: 'NOT_FOUND' };

  const decision = applyTransition(current.workflow_state, to);
  if (!decision.allowed) {
    return { changed: false, from: current.workflow_state, reason: decision.reason };
  }
  if (decision.reason === 'NO_CHANGE') {
    return { changed: false, from: current.workflow_state, to, reason: 'NO_CHANGE' };
  }

  // Both columns in ONE write. Splitting them would leave a window where the
  // CHECK constraint's invariant is violated, and the constraint would
  // (correctly) reject it anyway.
  await sql`
    update conversations
    set workflow_state = ${decision.state},
        status = ${decision.status},
        closed_at = ${decision.status === 'closed' ? sql`now()` : sql`closed_at`},
        closed_reason = ${decision.status === 'closed' ? (reason || decision.state) : sql`closed_reason`}
    where id = ${conversationId} and pharmacy_id = ${pharmacyId}
  `;

  // Audit. Non-fatal on purpose: failing to record that a thread moved must
  // not undo the move itself, which the customer may already have seen the
  // effect of.
  try {
    await recordEvent(sql, {
      pharmacyId,
      customerId: current.customer_id,
      eventType: PATIENT_EVENTS.CONVERSATION_STATE_CHANGED,
      actorType,
      actorId,
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { from: current.workflow_state, to: decision.state, reason },
      // Timestamped: a thread legitimately moves through the same state more
      // than once (open -> ai_handling -> waiting -> open ...), and the
      // default key would collapse every revisit into the first.
      idempotencyKey: `conv_state:${conversationId}:${decision.state}:${Date.now()}`,
    });
  } catch { /* the transition itself already happened */ }

  return { changed: true, from: current.workflow_state, to: decision.state, reason: 'OK' };
}

// ---------------------------------------------------------------------------
// The automatic transitions — driven by what actually happened, not chosen
// by a component. Each is named for the EVENT, so call sites read as facts
// about the world rather than as state assignments.
// ---------------------------------------------------------------------------

/**
 * A customer sent us something.
 *
 * Goes to AI_HANDLING because the assistant is about to pick it up. From a
 * closed thread the matrix forces OPEN first, so this attempts the reopen and
 * then advances — a customer messaging an archived thread must not silently
 * do nothing.
 */
async function onCustomerMessage(sql, { pharmacyId, conversationId }) {
  const reopened = await transitionTo(sql, {
    pharmacyId, conversationId, to: STATES.OPEN, actorType: 'customer', reason: 'customer_message',
  });
  // Already active: go straight to AI_HANDLING. Newly reopened: same. The
  // only case that stops here is a refusal, which the caller can log.
  if (!reopened.changed && reopened.reason !== 'NO_CHANGE' && reopened.reason !== 'OK') {
    if (reopened.reason === 'NOT_FOUND') return reopened;
  }
  return transitionTo(sql, {
    pharmacyId, conversationId, to: STATES.AI_HANDLING,
    actorType: 'customer', reason: 'customer_message',
  });
}

/** The assistant answered; the ball is with the customer now. */
async function onAssistantReplied(sql, { pharmacyId, conversationId }) {
  return transitionTo(sql, {
    pharmacyId, conversationId, to: STATES.WAITING_FOR_CUSTOMER,
    actorType: 'ai', reason: 'assistant_replied',
  });
}

/**
 * A clinical question was escalated. This is the state the whole inbox
 * hierarchy is built around — the only one that reads as high priority.
 */
async function onHandoffRaised(sql, { pharmacyId, conversationId, actorId = null }) {
  return transitionTo(sql, {
    pharmacyId, conversationId, to: STATES.WAITING_FOR_PHARMACIST,
    actorType: 'system', actorId, reason: 'pharmacist_handoff',
  });
}

/** A pharmacist answered. Back to the customer unless they closed it out. */
async function onPharmacistReplied(sql, { pharmacyId, conversationId, actorId = null, resolved = false }) {
  return transitionTo(sql, {
    pharmacyId,
    conversationId,
    to: resolved ? STATES.RESOLVED : STATES.WAITING_FOR_CUSTOMER,
    actorType: 'staff',
    actorId,
    reason: resolved ? 'pharmacist_resolved' : 'pharmacist_replied',
  });
}

/** Explicit close-out — an order completed, a question answered. */
async function resolve(sql, { pharmacyId, conversationId, actorType = 'system', actorId = null, reason = 'resolved' }) {
  return transitionTo(sql, { pharmacyId, conversationId, to: STATES.RESOLVED, actorType, actorId, reason });
}

/** File it away. The matrix only permits this from RESOLVED. */
async function archive(sql, { pharmacyId, conversationId, actorType = 'system', actorId = null }) {
  return transitionTo(sql, {
    pharmacyId, conversationId, to: STATES.ARCHIVED, actorType, actorId, reason: 'archived',
  });
}

module.exports = {
  transitionTo,
  onCustomerMessage, onAssistantReplied, onHandoffRaised, onPharmacistReplied,
  resolve, archive,
};
