/**
 * Product requests — "we don't have that, let me ask the pharmacist".
 *
 * THE RULE THIS FILE ENFORCES
 * The alternative is chosen by a person, from a real catalogue row. The
 * assistant may open a request and relay an answer; it may not decide what
 * substitutes for what. That distinction is the whole point — "drug B works
 * like drug A" is clinical judgement, and the safety filter spends its
 * existence keeping the model away from exactly that kind of claim.
 *
 * Because the suggestion is a catalogue row, the price and stock quoted back
 * to the customer come from the same source as every other number the
 * assistant states. A free-text alternative would have been simpler and
 * would have reintroduced unverifiable prices through a side door.
 */

const { getSql, assertPharmacyId } = require('../db');

/** Requests older than this stop being offered to staff as actionable. */
const EXPIRE_AFTER_HOURS = 48;

/**
 * Record something the catalogue could not supply.
 *
 * Deduplicated per conversation: a customer asking twice in one conversation
 * is one question, and two rows would mean the pharmacist answers the same
 * person twice and the customer receives two suggestions for one need.
 */
async function openRequest(pharmacyId, { conversationId, customerId, requestedText }) {
  assertPharmacyId(pharmacyId);
  const text = String(requestedText || '').trim().slice(0, 300);
  if (!text) throw new Error('requestedText is required to open a product request.');

  const db = getSql();

  const [existing] = await db`
    select id, status from product_requests
    where conversation_id = ${conversationId}
      and status = 'open'
      and lower(requested_text) = lower(${text})
    limit 1
  `;
  if (existing) return { request: existing, created: false };

  const [row] = await db`
    insert into product_requests (pharmacy_id, conversation_id, customer_id, requested_text)
    values (${pharmacyId}, ${conversationId}, ${customerId}, ${text})
    returning *
  `;
  return { request: row, created: true };
}

/** The pharmacist's queue. Oldest first — longest wait gets dealt with first. */
async function listOpen(pharmacyId, { limit = 50 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select r.id, r.requested_text, r.status, r.created_at,
           c.wa_phone, c.display_name, r.conversation_id,
           (select count(*)::int from product_requests r2
              where r2.pharmacy_id = r.pharmacy_id
                and lower(r2.requested_text) = lower(r.requested_text)
                and r2.created_at > now() - interval '30 days') as asked_30d
    from product_requests r
    join customers c on c.id = r.customer_id
    where r.pharmacy_id = ${pharmacyId}
      and r.status = 'open'
      and r.created_at > now() - interval '${db.unsafe(String(EXPIRE_AFTER_HOURS))} hours'
    order by r.created_at
    limit ${limit}
  `;
}

/**
 * Pharmacist offers an alternative.
 *
 * The product must belong to this pharmacy, be active, and have a price. An
 * unpriced suggestion would produce a message the assistant cannot make —
 * it has no figure to quote — so it is rejected here rather than failing
 * later in a place nobody connects back to this action.
 */
async function suggestAlternative(pharmacyId, requestId, { productId, note, userId = null }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [request] = await db`
    select * from product_requests
    where id = ${requestId} and pharmacy_id = ${pharmacyId}
  `;
  if (!request) throw new Error('Request not found.');
  if (request.status !== 'open') throw new Error(`This request is already ${request.status}.`);

  const [product] = await db`
    select id, name, price_kobo, stock_qty, stock_tracked, status
    from products where id = ${productId} and pharmacy_id = ${pharmacyId}
  `;
  if (!product) throw new Error('That product is not in this pharmacy\'s catalogue.');
  if (product.status !== 'active') throw new Error(`${product.name} is not active in the catalogue.`);
  if (product.price_kobo === null) {
    throw new Error(`${product.name} has no price, so the customer cannot be quoted one. Add a price first.`);
  }
  if (product.stock_tracked && (product.stock_qty ?? 0) <= 0) {
    throw new Error(`${product.name} is out of stock — suggesting it would repeat the problem.`);
  }

  const [row] = await db`
    update product_requests
    set status = 'suggested',
        suggested_product_id = ${product.id},
        pharmacist_note = ${note ? String(note).trim().slice(0, 300) : null},
        answered_by = ${userId},
        answered_at = now(),
        updated_at = now()
    where id = ${requestId}
    returning *
  `;

  return { request: row, product };
}

/** Pharmacist says there is nothing suitable. An honest no beats silence. */
async function declineRequest(pharmacyId, requestId, { note, userId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [row] = await db`
    update product_requests
    set status = 'declined',
        pharmacist_note = ${note ? String(note).trim().slice(0, 300) : null},
        answered_by = ${userId},
        answered_at = now(),
        updated_at = now()
    where id = ${requestId} and pharmacy_id = ${pharmacyId} and status = 'open'
    returning *
  `;
  if (!row) throw new Error('Request not found, or it has already been answered.');
  return { request: row };
}

/** Link a suggestion to the order it produced, so it can be judged later. */
async function markAccepted(pharmacyId, requestId, orderId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    update product_requests
    set status = 'accepted', order_id = ${orderId}, updated_at = now()
    where id = ${requestId} and pharmacy_id = ${pharmacyId}
    returning *
  `;
  return row || null;
}

/**
 * What customers asked for and could not get, most-asked first.
 *
 * The reason the raw text is kept. Eleven requests for one drug in a month
 * is a restocking decision, and nobody at the pharmacy is otherwise in a
 * position to notice it.
 */
async function unmetDemand(pharmacyId, { days = 30, limit = 20 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select lower(requested_text) as product, count(*)::int as times_asked,
           max(created_at) as last_asked,
           count(*) filter (where status = 'declined')::int as declined,
           count(*) filter (where status = 'accepted')::int as sold_alternative
    from product_requests
    where pharmacy_id = ${pharmacyId}
      and created_at > now() - interval '${db.unsafe(String(days))} days'
    group by lower(requested_text)
    order by times_asked desc, last_asked desc
    limit ${limit}
  `;
}

module.exports = {
  openRequest, listOpen, suggestAlternative, declineRequest, markAccepted, unmetDemand,
};
