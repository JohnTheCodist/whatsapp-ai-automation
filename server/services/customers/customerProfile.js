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
// Priority is derived from workflow state in one place, so the profile and the
// inbox can never disagree about what counts as urgent.
const { priorityFor } = require('../whatsapp/conversationState');

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
    select id, wa_phone, wa_jid, display_name, full_name, status, communication_status,
           comm_transactional, comm_order_notifications, comm_medication, comm_marketing,
           marketing_consent_source, marketing_consent_at,
           first_seen_at, last_seen_at
    from customers
    where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) return null;

  const [orderAgg, recentOrders, convAgg, recentConversations, crmCounts, activeConv, page] = await Promise.all([
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
      select count(*)::int as count,
             count(*) filter (where workflow_state not in ('resolved','archived'))::int as active,
             max(last_message_at) as last_conversation_at
      from conversations where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}
    `,
    // The customer's own latest message per conversation — a real quote,
    // never a generated summary.
    //
    // workflow_state comes through per conversation so the history reads as
    // "resolved / archived / waiting on a pharmacist" rather than a list of
    // undifferentiated threads. Message counts are per row and bounded by the
    // LIMIT 5, so this stays five cheap lookups however long the relationship.
    db`
      select c.id, c.last_message_at, c.workflow_state, c.created_at,
             (select body from messages m
                where m.conversation_id = c.id and m.direction = 'inbound'
                order by m.id desc limit 1) as preview,
             (select count(*)::int from messages m where m.conversation_id = c.id) as message_count
      from conversations c
      where c.pharmacy_id = ${pharmacyId} and c.customer_id = ${customer.id}
      order by c.last_message_at desc limit 5
    `,
    // CRM counts only — never the note bodies. This shape is assembled by a
    // staff-authenticated route, but the counts are all the profile header
    // needs, and not selecting the text here means there is no path by which
    // a note could ride along into somewhere it should not be. The notes
    // themselves load from /notes, which crmBoundary.test.js guards.
    db`
      select
        (select count(*)::int from patient_notes
           where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}) as notes,
        (select count(*)::int from patient_tags
           where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}) as tags
    `,
    // The one conversation that is actually live, with the last thing said in
    // it — the "what is happening with this person right now" line at the top
    // of the profile. At most one row: idx_conversations_one_open permits a
    // single open conversation per customer (see 0025).
    //
    // The preview is the genuine last message in either direction, not just
    // the customer's, because "we replied, waiting on them" and "they asked
    // something and nobody has answered" are different situations and the
    // profile has to show which one this is.
    db`
      select c.id, c.workflow_state, c.last_message_at, c.mode,
             (select body from messages m
                where m.conversation_id = c.id order by m.id desc limit 1) as preview,
             (select direction from messages m
                where m.conversation_id = c.id order by m.id desc limit 1) as preview_direction,
             (select count(*)::int from handoffs h
                where h.conversation_id = c.id and h.resolved_at is null) as open_handoffs
      from conversations c
      where c.pharmacy_id = ${pharmacyId} and c.customer_id = ${customer.id}
        and c.status = 'open'
      order by c.last_message_at desc limit 1
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
      // Both, deliberately. full_name is what the customer told the pharmacy
      // and is what belongs on a package; display_name is whatever they set
      // on their own phone ("John's iPhone") and is only useful for
      // recognising them in the inbox. Collapsing them would put the wrong
      // one on an order.
      fullName: customer.full_name,
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
    // Same treatment, same reason. Refills are driven by medication journeys,
    // so there is nothing to count until that engine exists.
    //
    // Zeroes rather than a fabricated "1 due": a pharmacist who sees a refill
    // marked due will act on it — ring the customer, pull the stock. A
    // placeholder here is not a harmless mock, it is a false instruction to
    // do clinical work. The empty state says plainly that the feature is not
    // built, which is the one thing a real number could never say.
    refills: { due: 0, completed: 0 },
    conversations: {
      count: convAgg[0].count,
      active: convAgg[0].active,
      lastConversationAt: convAgg[0].last_conversation_at,
      recent: recentConversations.map((c) => ({
        id: c.id,
        lastMessageAt: c.last_message_at,
        startedAt: c.created_at,
        preview: c.preview,
        messageCount: c.message_count,
        workflowState: c.workflow_state,
      })),
    },
    // The live thread, or null. Deliberately separate from `conversations`:
    // "what needs attention now" is a different question from "what has this
    // person discussed before", and merging them is how a profile ends up
    // showing an eight-month-old thread as though it were current.
    activeConversation: activeConv[0]
      ? {
        id: activeConv[0].id,
        workflowState: activeConv[0].workflow_state,
        priority: priorityFor(activeConv[0].workflow_state),
        mode: activeConv[0].mode,
        lastMessageAt: activeConv[0].last_message_at,
        preview: activeConv[0].preview,
        previewDirection: activeConv[0].preview_direction,
        awaitingPharmacist: activeConv[0].open_handoffs > 0,
      }
      : null,
    // Counts only. The bodies live behind /notes and /tags — see the query
    // comment above and crmBoundary.test.js.
    crm: {
      noteCount: crmCounts[0].notes,
      tagCount: crmCounts[0].tags,
    },
    communication: {
      // The channel-level answer: has this customer told us to stop. Kept
      // distinct from the per-category preferences below, because an opt-out
      // overrides all of them and collapsing the two would hide that.
      status: customer.communication_status,
      // Real values now (0022), not placeholders. Each is independently
      // meaningful: declining marketing must not suppress a refill reminder.
      preferences: {
        transactional: customer.comm_transactional,
        orderNotifications: customer.comm_order_notifications,
        medication: customer.comm_medication,
        marketing: customer.comm_marketing,
      },
      // Evidence for the one category that requires explicit consent.
      marketingConsent: customer.comm_marketing
        ? { source: customer.marketing_consent_source, at: customer.marketing_consent_at }
        : null,
    },
    timeline: page.events,
    timelineNextCursor: page.nextCursor,
  };
}

module.exports = { getCustomerProfile };
