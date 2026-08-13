/**
 * The single write path onto a customer's activity timeline.
 *
 * IDEMPOTENT BY CONSTRAINT, NOT BY CONVENTION
 * `INSERT ... ON CONFLICT (pharmacy_id, event_type, entity_type, entity_id)
 * DO NOTHING`. A worker retry, a Baileys reconnect replaying a message, a
 * duplicate webhook — none of them can produce a second row, because the
 * unique index makes a second attempt a no-op rather than requiring every
 * call site to remember to check first. This is the same shape as
 * inbound_events and messages.provider_message_id elsewhere in this
 * codebase, applied to the same class of problem.
 *
 * TAKES A SQL CLIENT, NOT A CONNECTION OF ITS OWN
 * Most call sites already hold a transaction (`tx`) because the event is
 * recording a fact that just happened inside that same transaction — an
 * order's status changed, a message was inserted. Passing that `tx` through
 * means a rolled-back order creation also rolls back its ORDER_CREATED
 * event; grabbing a fresh top-level connection here would decouple the two
 * and let a phantom event survive a failed write. Sites that are not inside
 * a transaction (a best-effort notification after something already
 * committed) just pass the plain `sql` instance — postgres.js gives both
 * the same tagged-template interface.
 *
 * NEVER THROWS ON A DUPLICATE
 * Returns null when the event already existed rather than raising — a
 * retry finding its own event already recorded is success, not failure.
 */

const {
  isKnownEventType, isKnownActorType, isKnownEntityType, tableForEntity,
} = require('./patientEventTypes');

function toEntityId(id) {
  // entity_id is text (0017) because it spans both bigint (messages,
  // order_status_history) and uuid (orders, handoffs, opt_outs, customers)
  // primary keys. String() is the whole normalisation; the column being
  // text is what makes that safe.
  return id === null || id === undefined ? null : String(id);
}

/**
 * Default uniqueness when a caller does not supply one.
 *
 * Reproduces exactly what 0017's composite constraint enforced, which is
 * right for the events that exist today — all of them are about a single-use
 * entity (this message, this order's confirmation). It is WRONG for anything
 * that can legitimately recur about the same entity, which is why the
 * parameter exists at all: a second PRODUCT_VIEWED for the same product, or
 * next month's REFILL_REQUESTED for the same journey, must pass a key that
 * says what makes it distinct. Nothing here can infer that.
 */
function defaultIdempotencyKey({ eventType, entityType, entityId }) {
  return `${eventType}:${entityType}:${toEntityId(entityId)}`;
}

/**
 * @param {object} sql               a postgres.js sql instance OR an open tx
 * @param {object} event
 * @param {string} event.pharmacyId
 * @param {string} event.customerId
 * @param {string} event.eventType   must be in the PATIENT_EVENTS registry
 * @param {string} event.actorType   'customer'|'ai'|'pharmacist'|'staff'|'system'
 * @param {string} [event.actorId]   only when it adds information beyond actorType
 * @param {string} event.entityType
 * @param {string|number} event.entityId
 * @param {string} [event.idempotencyKey]  what makes THIS event unique. Omit
 *   only when the entity itself is the uniqueness — see defaultIdempotencyKey.
 * @param {Date|string} [event.occurredAt]  defaults to now — pass the real
 *   timestamp of the underlying row (created_at, changed_at, requested_at)
 *   when recording an event after the fact, so ordering stays true even
 *   when this call runs later than the thing it is describing.
 * @param {object} [event.metadata]  structured facts only, never prose
 * @param {boolean} [event.verifyEntity=true]  set false only when the caller
 *   is inside the same transaction that just created the entity and can see
 *   it, but a separate verification query would deadlock or double-read.
 * @returns {Promise<number|null>} the new event id, or null if this exact
 *   event was already recorded (idempotent no-op, not an error)
 */
async function recordEvent(sql, {
  pharmacyId, customerId, eventType, actorType, actorId = null,
  entityType, entityId, occurredAt = new Date(), metadata = {},
  idempotencyKey = null, verifyEntity = true,
}) {
  if (!pharmacyId || !customerId) {
    throw new Error('recordEvent requires pharmacyId and customerId — both are server-controlled, never optional.');
  }
  if (!eventType || !actorType || !entityType || entityId === undefined || entityId === null) {
    throw new Error(`recordEvent missing a required field for ${eventType || '(no event type)'}`);
  }

  // ---- vocabulary, now that the database no longer checks it (0018) -------
  if (!isKnownEventType(eventType)) {
    throw new Error(
      `Unknown event type "${eventType}". Add it to patientEventTypes.js — that registry is the vocabulary, `
      + 'and a typo silently becoming a new event type is exactly what it exists to prevent.'
    );
  }
  if (!isKnownActorType(actorType)) {
    throw new Error(`Unknown actor type "${actorType}" for ${eventType}.`);
  }
  if (!isKnownEntityType(entityType)) {
    throw new Error(`Unknown entity type "${entityType}" for ${eventType}.`);
  }

  // ---- tenancy -----------------------------------------------------------
  //
  // The customer must belong to the pharmacy the event is being filed under.
  // Without this, a caller that mixes up two ids writes one tenant's history
  // onto another tenant's timeline — the one failure this whole layer must
  // not have, and one no downstream read query could detect afterwards.
  const [customer] = await sql`
    select 1 from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) {
    throw new Error(`Customer ${customerId} does not belong to pharmacy ${pharmacyId} — refusing to record ${eventType}.`);
  }

  // ---- the referenced entity --------------------------------------------
  //
  // Same argument, one level out: an event pointing at another pharmacy's
  // order would let the timeline link to it. Skipped when the table does not
  // exist yet (a reserved entity type) or when the caller is inside the
  // transaction that created the row and can vouch for it.
  const table = tableForEntity(entityType);
  if (verifyEntity && table) {
    const [entity] = await sql`
      select 1 from ${sql(table)}
      where id = ${entityType === 'message' || entityType === 'order_status_history'
        ? Number(entityId) : entityId}
        and pharmacy_id = ${pharmacyId}
    `;
    if (!entity) {
      throw new Error(
        `${entityType} ${entityId} was not found in pharmacy ${pharmacyId} — refusing to record ${eventType} against it.`
      );
    }
  }

  const key = idempotencyKey || defaultIdempotencyKey({ eventType, entityType, entityId });

  const [row] = await sql`
    insert into customer_events
      (pharmacy_id, customer_id, event_type, occurred_at, actor_type, actor_id,
       entity_type, entity_id, metadata, idempotency_key)
    values
      (${pharmacyId}, ${customerId}, ${eventType}, ${occurredAt}, ${actorType}, ${actorId},
       ${entityType}, ${toEntityId(entityId)}, ${sql.json(metadata)}, ${key})
    on conflict (pharmacy_id, idempotency_key) do nothing
    returning id
  `;
  return row ? row.id : null;
}

/**
 * Order status transition -> timeline event type.
 *
 * The one non-obvious case: a hold that lapses unconfirmed and a pharmacist
 * rejecting an order both land on to_status='cancelled', but they are
 * different facts a pharmacist reading the timeline needs told apart —
 * "nobody got to it in time" versus "we couldn't supply this". The
 * expiry sweep is the only writer that uses actor_type='system' for a
 * cancellation (orderService.expireStaleHolds); anything else cancelling is
 * a person, and gets the generic label.
 */
function orderEventType(fromStatus, toStatus, actorType) {
  if (fromStatus === null && toStatus === 'pending') return 'ORDER_CREATED';
  if (toStatus === 'cancelled' && actorType === 'system') return 'ORDER_HOLD_EXPIRED';
  const named = { confirmed: 'ORDER_CONFIRMED', rejected: 'ORDER_REJECTED', completed: 'ORDER_COMPLETED', ready: 'ORDER_READY', cancelled: 'ORDER_CANCELLED' };
  return named[toStatus] || `ORDER_${String(toStatus).toUpperCase()}`;
}

module.exports = { recordEvent, orderEventType };
