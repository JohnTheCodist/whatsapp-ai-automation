/**
 * The event vocabulary for the whole CRM — one file, one source of truth.
 *
 * WHY THIS IS A MODULE AND NOT A DATABASE CHECK CONSTRAINT
 * 0017 put the allowed event types in a CHECK constraint. That is stricter,
 * and it is the wrong strictness: it means every future feature that wants
 * to record a new kind of event needs a migration before it can write a
 * single row. The explicit requirement for this layer is that Segment 2 can
 * call `recordEvent({ eventType: MEDICATION_STARTED })` without touching the
 * schema, so the vocabulary has to live where a feature module can extend
 * it — here.
 *
 * What is NOT given up by moving it: nothing writes to customer_events
 * directly. Every insert goes through recordEvent(), which validates against
 * this registry and rejects anything unknown. The check moved layer, it did
 * not disappear.
 *
 * ADDING AN EVENT TYPE
 * Add it below, in its domain's block. That is the entire process — no
 * migration, no timeline change. The UI renders an unrecognised type from
 * its own name rather than breaking (see CustomerTimeline.jsx), so a new
 * event is visible on the timeline the day it is first recorded, and only
 * needs a renderer entry when it deserves a nicer label or a detail line.
 */

const PATIENT_EVENTS = Object.freeze({
  // ---- identity ----
  PATIENT_CREATED: 'PATIENT_CREATED',

  // ---- conversation ----
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  CONVERSATION_STARTED: 'CONVERSATION_STARTED',
  CONVERSATION_RESOLVED: 'CONVERSATION_RESOLVED',

  // ---- catalogue ----
  PRODUCT_VIEWED: 'PRODUCT_VIEWED',

  // ---- orders ----
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_STOCK_HELD: 'ORDER_STOCK_HELD',
  ORDER_SENT_TO_PHARMACY: 'ORDER_SENT_TO_PHARMACY',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_READY: 'ORDER_READY',
  ORDER_COMPLETED: 'ORDER_COMPLETED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_HOLD_EXPIRED: 'ORDER_HOLD_EXPIRED',

  // ---- pharmacist ----
  PHARMACIST_HANDOFF: 'PHARMACIST_HANDOFF',
  PHARMACIST_RESPONDED: 'PHARMACIST_RESPONDED',

  // ---- profile ----
  CUSTOMER_NAME_CAPTURED: 'CUSTOMER_NAME_CAPTURED',

  // ---- communication preferences ----
  COMMUNICATION_OPTED_OUT: 'COMMUNICATION_OPTED_OUT',

  // ---- RESERVED: no writer exists yet -------------------------------------
  //
  // Declared so the feature that implements them adds a caller, not a
  // migration and not an entry here. Nothing emits these today, and the
  // timeline will simply never show one until something does — which is the
  // correct behaviour for a fact that has not happened.
  //
  // Medication journeys (Segment 2)
  MEDICATION_STARTED: 'MEDICATION_STARTED',
  MEDICATION_REMINDER_SCHEDULED: 'MEDICATION_REMINDER_SCHEDULED',
  MEDICATION_REMINDER_SENT: 'MEDICATION_REMINDER_SENT',
  MEDICATION_REMINDER_RESPONDED: 'MEDICATION_REMINDER_RESPONDED',
  MEDICATION_COMPLETED: 'MEDICATION_COMPLETED',

  // Refills (Segment 3)
  REFILL_DUE: 'REFILL_DUE',
  REFILL_REQUESTED: 'REFILL_REQUESTED',
  REFILL_CONFIRMED: 'REFILL_CONFIRMED',
  REFILL_COMPLETED: 'REFILL_COMPLETED',

  // Delivery
  DELIVERY_REQUESTED: 'DELIVERY_REQUESTED',
  DELIVERY_DISPATCHED: 'DELIVERY_DISPATCHED',
  DELIVERY_COMPLETED: 'DELIVERY_COMPLETED',

  // Payments
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
});

/** Who caused an event. */
const ACTOR_TYPES = Object.freeze(['customer', 'ai', 'pharmacist', 'staff', 'system']);

/**
 * Entity types an event may point back to, and the table each one lives in.
 *
 * The table name is what lets recordEvent() verify that a referenced entity
 * actually exists AND belongs to the same pharmacy — the check that stops one
 * tenant's timeline from ever referencing another tenant's order. An entity
 * type with no table here is structurally unverifiable, so it is not allowed.
 *
 * `medication_journey`, `refill` and `payment` are listed with null tables:
 * the type is accepted so a future module can reference it, but until the
 * table exists there is nothing to verify against and recordEvent says so
 * rather than silently skipping the check.
 */
const ENTITY_TABLES = Object.freeze({
  customer: 'customers',
  message: 'messages',
  order: 'orders',
  order_status_history: 'order_status_history',
  conversation: 'conversations',
  handoff: 'handoffs',
  opt_out: 'opt_outs',
  product: 'products',
  // reserved, no table yet
  medication_journey: null,
  refill: null,
  payment: null,
  delivery: null,
});

const EVENT_TYPE_SET = new Set(Object.values(PATIENT_EVENTS));

function isKnownEventType(t) {
  return EVENT_TYPE_SET.has(t);
}

function isKnownActorType(t) {
  return ACTOR_TYPES.includes(t);
}

function isKnownEntityType(t) {
  return Object.prototype.hasOwnProperty.call(ENTITY_TABLES, t);
}

/** The table to verify an entity against, or null when there is not one yet. */
function tableForEntity(t) {
  return ENTITY_TABLES[t] ?? null;
}

module.exports = {
  PATIENT_EVENTS, ACTOR_TYPES, ENTITY_TABLES,
  isKnownEventType, isKnownActorType, isKnownEntityType, tableForEntity,
};
