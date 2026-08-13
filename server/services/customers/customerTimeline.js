/**
 * Read side of the customer event stream — one indexed query, cursor-paginated.
 *
 * WHY A CURSOR AND NOT OFFSET
 * offset/limit re-scans everything before the page on every request; a
 * cursor on (occurred_at, id) picks up exactly where the last page ended
 * regardless of how many events exist before it. The architecture needs to
 * work identically for a customer with 10 events and one with 10,000 — see
 * 0017's own reasoning for why the table exists instead of a read-time
 * merge.
 *
 * WHY (occurred_at, id) AND NOT occurred_at ALONE
 * occurred_at is not guaranteed unique — two events can share a timestamp
 * (an order transition and its notification, genuinely simultaneous). id is
 * the tiebreaker so pagination is stable rather than occasionally skipping
 * or repeating a row that ties with the cursor boundary.
 */

const { getSql, assertPharmacyId } = require('../db');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * @param {string} pharmacyId
 * @param {string} customerId
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.cursor]      opaque, from a previous call's nextCursor
 * @param {string} [opts.eventType]   filter to one event_type, or a category —
 *   see EVENT_CATEGORIES below
 * @returns {Promise<{events: object[], nextCursor: string|null}|null>} null
 *   if the customer does not exist under this pharmacy — tenant isolation
 *   is enforced here, not left to the caller to remember.
 */
async function listTimeline(pharmacyId, customerId, { limit = DEFAULT_LIMIT, cursor = null, eventType = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const boundedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  const [customer] = await db`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) return null;

  let cursorClause = db``;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      cursorClause = db`and (occurred_at, id) < (${decoded.occurredAt}, ${decoded.id})`;
    }
  }

  const typeFilter = eventTypeFilter(eventType);
  const typeClause = typeFilter ? db`and event_type = any(${typeFilter})` : db``;

  const rows = await db`
    select id, event_type, occurred_at, actor_type, actor_id, entity_type, entity_id, metadata
    from customer_events
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      ${cursorClause} ${typeClause}
    order by occurred_at desc, id desc
    limit ${boundedLimit + 1}
  `;

  const hasMore = rows.length > boundedLimit;
  const page = hasMore ? rows.slice(0, boundedLimit) : rows;
  const last = page[page.length - 1];

  return {
    events: page.map((e) => ({
      id: String(e.id),
      eventType: e.event_type,
      occurredAt: e.occurred_at,
      actorType: e.actor_type,
      actorId: e.actor_id,
      entityType: e.entity_type,
      entityId: e.entity_id,
      metadata: e.metadata,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.occurred_at, last.id) : null,
  };
}

/**
 * Lightweight filter categories for the UI — All / Orders / Messages /
 * Pharmacist / System. Not stored anywhere; just a name -> event_type list
 * mapping, so the filter bar's five buttons don't need to know the full
 * vocabulary.
 */
const EVENT_CATEGORIES = {
  orders: ['ORDER_CREATED', 'ORDER_STOCK_HELD', 'ORDER_SENT_TO_PHARMACY', 'ORDER_CONFIRMED',
    'ORDER_REJECTED', 'ORDER_READY', 'ORDER_COMPLETED', 'ORDER_CANCELLED', 'ORDER_HOLD_EXPIRED'],
  messages: ['MESSAGE_RECEIVED', 'MESSAGE_SENT'],
  pharmacist: ['PHARMACIST_HANDOFF', 'PHARMACIST_RESPONDED'],
  system: ['PATIENT_CREATED', 'CONVERSATION_STARTED', 'CONVERSATION_RESOLVED', 'COMMUNICATION_OPTED_OUT'],
};

function eventTypeFilter(eventType) {
  if (!eventType || eventType === 'all') return null;
  if (EVENT_CATEGORIES[eventType]) return EVENT_CATEGORIES[eventType];
  // A single explicit event_type, e.g. ?event_type=ORDER_CONFIRMED — passed
  // through as a one-item filter rather than rejected, useful for linking
  // straight to "just this kind of thing" later.
  return [eventType];
}

function encodeCursor(occurredAt, id) {
  return Buffer.from(JSON.stringify({ o: new Date(occurredAt).toISOString(), i: String(id) })).toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const { o, i } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!o || !i) return null;
    return { occurredAt: o, id: i };
  } catch {
    // A malformed cursor is treated as "start from the top" rather than an
    // error — a stale or tampered-with cursor should degrade gracefully,
    // not break the page.
    return null;
  }
}

module.exports = { listTimeline, EVENT_CATEGORIES };
