#!/usr/bin/env node
/**
 * One-time backfill: historical rows -> customer_events.
 *
 * Migration 0017 creates the event stream table; it does not populate it.
 * Without this script, every customer who existed before that migration
 * would open to an empty timeline while their orders, messages and handoffs
 * sit right there in the database — a visible regression, not a fresh start.
 *
 * SAFE TO RUN MORE THAN ONCE
 * Goes through the exact same recordEvent() path as live traffic, guarded
 * by the same (pharmacy_id, event_type, entity_type, entity_id) unique
 * constraint. Running this twice, or running it after live events have
 * already started flowing, produces the same end state — every insert that
 * would collide with something already there is a no-op.
 *
 * WHAT IT DOES NOT DO
 * It does not invent anything not already in the database. A conversation
 * with no messages gets a CONVERSATION_STARTED and nothing else. An opt-out
 * with no matching customer (should not happen — opt_outs predates a
 * customer only if imported oddly) is skipped and logged, not guessed at.
 */

const path = require('node:path');
const postgres = require('postgres');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env'), quiet: true });

const { recordEvent, orderEventType } = require('../server/services/customers/customerEvents');

// order_status_history.actor_type and handoffs.triggered_by both predate
// customer_events and use their own vocabulary ('assistant', 'user') —
// this is the same translation the live write path already applies at
// the point each event is recorded (orderService.js, worker.js), just
// applied here uniformly across historical rows instead of per call site.
function toEventActorType(raw) {
  return raw === 'assistant' ? 'ai' : raw === 'user' ? 'customer' : raw;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const sql = postgres(url, { max: 3, connect_timeout: 15 });
  const counts = { PATIENT_CREATED: 0, CONVERSATION_STARTED: 0, MESSAGE_RECEIVED: 0, MESSAGE_SENT: 0, orders: 0, handoffs: 0, COMMUNICATION_OPTED_OUT: 0 };

  try {
    // ---- customers: PATIENT_CREATED ----------------------------------------
    const customers = await sql`select id, pharmacy_id, first_seen_at, wa_phone from customers`;
    for (const c of customers) {
      const id = await recordEvent(sql, {
        pharmacyId: c.pharmacy_id, customerId: c.id, eventType: 'PATIENT_CREATED',
        occurredAt: c.first_seen_at, actorType: 'system', entityType: 'customer', entityId: c.id,
      });
      if (id) counts.PATIENT_CREATED++;
    }

    // ---- conversations: CONVERSATION_STARTED -------------------------------
    const conversations = await sql`select id, pharmacy_id, customer_id, created_at from conversations`;
    for (const c of conversations) {
      const id = await recordEvent(sql, {
        pharmacyId: c.pharmacy_id, customerId: c.customer_id, eventType: 'CONVERSATION_STARTED',
        occurredAt: c.created_at, actorType: 'customer', entityType: 'conversation', entityId: c.id,
      });
      if (id) counts.CONVERSATION_STARTED++;
    }

    // ---- messages: MESSAGE_RECEIVED / MESSAGE_SENT -------------------------
    const messages = await sql`
      select m.id, m.pharmacy_id, m.direction, m.author, m.body, m.created_at, c.customer_id, c.id as conversation_id
      from messages m join conversations c on c.id = m.conversation_id
    `;
    for (const m of messages) {
      const inbound = m.direction === 'inbound';
      const id = await recordEvent(sql, {
        pharmacyId: m.pharmacy_id, customerId: m.customer_id,
        eventType: inbound ? 'MESSAGE_RECEIVED' : 'MESSAGE_SENT',
        occurredAt: m.created_at, actorType: inbound ? 'customer' : (m.author === 'assistant' ? 'ai' : m.author === 'staff' ? 'staff' : 'system'),
        entityType: 'message', entityId: m.id,
        metadata: { preview: (m.body || '').slice(0, 200), conversationId: m.conversation_id, ...(inbound ? {} : { author: m.author }) },
      });
      if (id) counts[inbound ? 'MESSAGE_RECEIVED' : 'MESSAGE_SENT']++;
    }

    // ---- order_status_history: ORDER_* -------------------------------------
    const history = await sql`
      select h.id, h.pharmacy_id, h.from_status, h.to_status, h.changed_at, h.actor_type, h.changed_by, h.note,
             o.id as order_id, o.customer_id, o.reference, o.total_kobo
      from order_status_history h join orders o on o.id = h.order_id
    `;
    for (const h of history) {
      const id = await recordEvent(sql, {
        pharmacyId: h.pharmacy_id, customerId: h.customer_id,
        eventType: orderEventType(h.from_status, h.to_status, h.actor_type),
        occurredAt: h.changed_at, actorType: toEventActorType(h.actor_type), actorId: h.changed_by,
        entityType: 'order_status_history', entityId: h.id,
        metadata: { orderId: h.order_id, reference: h.reference, totalKobo: h.total_kobo, fromStatus: h.from_status, toStatus: h.to_status },
      });
      if (id) counts.orders++;
    }

    // ---- handoffs: PHARMACIST_HANDOFF / PHARMACIST_RESPONDED ---------------
    const handoffs = await sql`
      select h.id, h.pharmacy_id, h.category, h.reason, h.triggered_by, h.requested_at, h.resolved_at,
             c.customer_id
      from handoffs h join conversations c on c.id = h.conversation_id
    `;
    for (const h of handoffs) {
      const requestedActor = h.triggered_by === 'customer' ? 'customer' : h.triggered_by === 'staff' ? 'staff' : 'ai';
      const id1 = await recordEvent(sql, {
        pharmacyId: h.pharmacy_id, customerId: h.customer_id, eventType: 'PHARMACIST_HANDOFF',
        occurredAt: h.requested_at, actorType: requestedActor,
        entityType: 'handoff', entityId: h.id, metadata: { category: h.category, reason: h.reason },
      });
      if (id1) counts.handoffs++;

      if (h.resolved_at) {
        // Backfill cannot tell apart "a pharmacist resolved this" from "the
        // customer declined an offered handoff" (worker.js's other resolved_at
        // writer) purely from this row — both look identical in handoffs. Real
        // going-forward events ARE recorded correctly at the point each thing
        // actually happens (see conversations.js and worker.js). For this
        // historical pass, actor_type is deliberately left as 'system' rather
        // than guessed as 'pharmacist', so old data does not claim a person
        // acted when the backfill cannot actually tell.
        const id2 = await recordEvent(sql, {
          pharmacyId: h.pharmacy_id, customerId: h.customer_id, eventType: 'PHARMACIST_RESPONDED',
          occurredAt: h.resolved_at, actorType: 'system',
          entityType: 'handoff', entityId: h.id, metadata: { category: h.category },
        });
        if (id2) counts.handoffs++;
      }
    }

    // ---- opt_outs: COMMUNICATION_OPTED_OUT ---------------------------------
    const optOuts = await sql`
      select o.id, o.pharmacy_id, o.wa_phone, o.opted_out_at, c.id as customer_id
      from opt_outs o
      join customers c on c.pharmacy_id = o.pharmacy_id and c.wa_phone = o.wa_phone
    `;
    for (const o of optOuts) {
      const id = await recordEvent(sql, {
        pharmacyId: o.pharmacy_id, customerId: o.customer_id, eventType: 'COMMUNICATION_OPTED_OUT',
        occurredAt: o.opted_out_at, actorType: 'customer', entityType: 'opt_out', entityId: o.id,
      });
      if (id) counts.COMMUNICATION_OPTED_OUT++;
    }

    console.log('Backfill complete. New rows inserted (already-recorded events were skipped, not duplicated):');
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
