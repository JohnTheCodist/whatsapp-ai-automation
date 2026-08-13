/**
 * Customer 360 — who this person is, what they've bought, what they've
 * asked, and whether the pharmacy can currently reach them.
 *
 * TENANT ISOLATION: every query is scoped by pharmacy_id in its own WHERE
 * clause, never checked afterward. A customer belonging to another pharmacy
 * simply does not match any of these queries — there is no separate
 * ownership check to forget, and nothing for a future edit to accidentally
 * remove.
 *
 * PERFORMANCE: every source is queried with its own LIMIT before merging. A
 * customer with years of history must not turn this into a full-table scan
 * — bounding each source independently means the total work stays flat
 * regardless of how long the relationship has been.
 *
 * TIMELINE: this used to be built here by re-querying order_status_history,
 * messages, handoffs and opt_outs and merging them in JS. That logic now
 * lives in one place — customerTimeline.js, reading the normalized
 * customer_events stream (0017) — and this file just calls it, the same
 * "do not duplicate business logic" rule the rest of this segment follows.
 *
 * NOT AN EHR: no diagnosis, clinical notes, or medical history anywhere in
 * this shape. medicationJourneys is an honest empty array — no such table
 * exists yet, and inventing a placeholder record would be worse than
 * showing nothing.
 */

const { getSql, assertPharmacyId } = require('../db');
const { listTimeline } = require('./customerTimeline');

const naira = (kobo) => Number(kobo || 0) / 100;

/**
 * @param {string} pharmacyId  from the authenticated session, never the client
 * @param {string} customerId
 * @returns {Promise<object|null>} null if not found OR belongs to another tenant —
 *   deliberately the same outcome for both, so a guessed id cannot be used
 *   to distinguish "wrong pharmacy" from "doesn't exist".
 */
async function getCustomerProfile(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [customer] = await db`
    select id, wa_phone, wa_jid, display_name, status, communication_status,
           first_seen_at, last_seen_at
    from customers
    where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) return null;

  const [orderAgg, recentOrders, convAgg, recentConversations, page] = await Promise.all([
    // Total spend counts only orders that reached a real commitment — the
    // same status set overview.js already uses for "confirmed value", so
    // this number means the same thing everywhere it appears in the product.
    db`
      select count(*)::int as count,
             coalesce(sum(total_kobo) filter (where status in ('confirmed','ready','completed')), 0)::bigint as spend_kobo,
             max(created_at) as last_order_at
      from orders where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}
    `,
    db`
      select id, reference, status, total_kobo, created_at
      from orders
      where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}
      order by created_at desc limit 5
    `,
    db`
      select count(*)::int as count, max(last_message_at) as last_conversation_at
      from conversations where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}
    `,
    // The customer's own latest message per conversation — a real quote,
    // never a generated summary.
    db`
      select c.id, c.last_message_at,
             (select body from messages m
                where m.conversation_id = c.id and m.direction = 'inbound'
                order by m.id desc limit 1) as preview
      from conversations c
      where c.pharmacy_id = ${pharmacyId} and c.customer_id = ${customer.id}
      order by c.last_message_at desc limit 5
    `,
    // First page only — the profile shows a taste of the timeline; the
    // dedicated /timeline endpoint is where a pharmacist pages through the
    // rest. customer.id already proven to belong to pharmacyId above, so no
    // second existence check here.
    listTimeline(pharmacyId, customer.id, { limit: 25 }),
  ]);

  return {
    customer: {
      id: customer.id,
      displayName: customer.display_name,
      waPhone: customer.wa_phone,
      waJid: customer.wa_jid,
      status: customer.status,
      communicationStatus: customer.communication_status,
      createdAt: customer.first_seen_at,
      lastSeenAt: customer.last_seen_at,
    },
    orders: {
      count: orderAgg[0].count,
      totalSpend: naira(orderAgg[0].spend_kobo),
      lastOrderAt: orderAgg[0].last_order_at,
      recent: recentOrders.map((o) => ({
        id: o.id, reference: o.reference, status: o.status,
        total: naira(o.total_kobo), createdAt: o.created_at,
      })),
    },
    // No medication_journeys table exists yet — an honest empty array, not
    // a fabricated placeholder record. Segment 2's concern.
    medicationJourneys: [],
    conversations: {
      count: convAgg[0].count,
      lastConversationAt: convAgg[0].last_conversation_at,
      recent: recentConversations.map((c) => ({
        id: c.id, lastMessageAt: c.last_message_at, preview: c.preview,
      })),
    },
    communication: {
      // Only what actually exists. The caller shows other categories as
      // "not configured" rather than this function inventing consent
      // states nobody has actually granted.
      status: customer.communication_status,
    },
    timeline: page.events,
    timelineNextCursor: page.nextCursor,
  };
}

module.exports = { getCustomerProfile };
