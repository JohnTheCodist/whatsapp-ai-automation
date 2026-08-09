/**
 * Inbound message ingestion — socket event to durable rows.
 *
 * PERSIST FIRST, PROCESS SECOND.
 * Under Cloud API a dropped webhook was retried by Meta. Under Baileys
 * nothing retries on our behalf: a message we fail to write is gone, and the
 * customer is simply ignored with no trace. So the very first action is an
 * insert into inbound_events — the raw payload, before any interpretation.
 * Everything after that is derived and can be rebuilt from it.
 *
 * DEDUPE IS NOT OPTIONAL.
 * Baileys re-emits on reconnect and history sync, and the manager reconnects
 * on every transient drop. Without the unique constraint on
 * (provider, provider_message_id) a customer would get answered twice for
 * one question.
 *
 * This module does NOT decide what a message means. It records that one
 * arrived and queues the work. The assistant, safety routing, and orders all
 * read from these rows in later phases.
 */

const { getSql, assertPharmacyId } = require('../db');

/** How long a customer-initiated reply window stays open. */
const REPLY_WINDOW_HOURS = 24;

/**
 * @param {object} msg  the payload emitted by sessionManager 'message'
 * @returns {Promise<{stored: boolean, reason?: string, messageId?: number, conversationId?: string}>}
 */
async function ingest(msg) {
  const {
    pharmacyId, accountId, providerMessageId,
    phoneNumber, text, hasMedia, timestamp, raw,
  } = msg;

  assertPharmacyId(pharmacyId);

  if (!providerMessageId) {
    // Without an id there is no dedupe key, and re-processing on the next
    // reconnect would mean answering the same person twice. Dropping is the
    // safer failure, and it is recorded rather than silent.
    return { stored: false, reason: 'no_provider_message_id' };
  }

  const db = getSql();

  // 1. Durable record of the raw event. `do nothing` makes redelivery a
  //    no-op rather than an error — the constraint is doing the work.
  const [event] = await db`
    insert into inbound_events
      (provider, provider_message_id, pharmacy_id, from_number, payload, status)
    values
      ('baileys', ${providerMessageId}, ${pharmacyId}, ${phoneNumber || null},
       ${db.json(safePayload(raw, msg))}, 'received')
    on conflict (provider, provider_message_id) do nothing
    returning id
  `;

  if (!event) {
    return { stored: false, reason: 'duplicate' };
  }

  try {
    const result = await db.begin(async (tx) => {
      // 2. The customer. last_seen_at moves; first_seen_at does not.
      const [customer] = await tx`
        insert into customers (pharmacy_id, wa_phone, last_seen_at)
        values (${pharmacyId}, ${phoneNumber}, now())
        on conflict (pharmacy_id, wa_phone) do update
          set last_seen_at = now()
        returning id
      `;

      // 3. The conversation. One open thread per customer — a 'closed' one
      //    is history and must not be reopened silently, because reopening
      //    would resurrect stale context ("I want two" referring to a
      //    product discussed last month).
      let [conversation] = await tx`
        select id from conversations
        where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id} and mode <> 'closed'
        order by last_message_at desc
        limit 1
      `;

      if (!conversation) {
        [conversation] = await tx`
          insert into conversations (pharmacy_id, customer_id, mode, last_message_at, window_expires_at)
          values (${pharmacyId}, ${customer.id}, 'bot', now(),
                  now() + interval '${tx.unsafe(String(REPLY_WINDOW_HOURS))} hours')
          returning id
        `;
      } else {
        // An inbound message reopens the reply window.
        await tx`
          update conversations
          set last_message_at = now(),
              window_expires_at = now() + interval '${tx.unsafe(String(REPLY_WINDOW_HOURS))} hours'
          where id = ${conversation.id}
        `;
      }

      // 4. The message itself.
      const [stored] = await tx`
        insert into messages
          (pharmacy_id, conversation_id, direction, author, body, provider_message_id, created_at)
        values
          (${pharmacyId}, ${conversation.id}, 'inbound', 'customer',
           ${text || null}, ${providerMessageId},
           ${timestamp ? new Date(timestamp) : new Date()})
        returning id
      `;

      // 5. Queue the work. Nothing consumes this yet — the assistant lands in
      //    Phase 4 — but the row is what makes that phase a consumer rather
      //    than a rewrite of this one.
      await tx`
        insert into jobs (pharmacy_id, kind, payload)
        values (${pharmacyId}, 'process_inbound',
                ${tx.json({
                  messageId: String(stored.id),
                  conversationId: conversation.id,
                  customerId: customer.id,
                  accountId,
                  hasMedia: Boolean(hasMedia),
                })})
      `;

      await tx`
        update inbound_events
        set status = 'processed', processed_at = now()
        where id = ${event.id}
      `;

      return { messageId: Number(stored.id), conversationId: conversation.id };
    });

    return { stored: true, ...result };
  } catch (err) {
    // The raw event row survives, so this is recoverable rather than lost.
    await db`
      update inbound_events
      set status = 'failed', last_error = ${String(err.message).slice(0, 500)}, attempts = attempts + 1
      where id = ${event.id}
    `.catch(() => { /* the original error is the one worth reporting */ });
    throw err;
  }
}

/**
 * Trim the raw Baileys message before storing it.
 *
 * The full object carries Buffers and protocol internals that bloat the row
 * and serialise unpredictably. Keep what is useful for debugging a real
 * complaint — "the assistant never answered me" — and drop the rest.
 */
function safePayload(raw, msg) {
  return {
    key: raw?.key ?? null,
    messageTimestamp: raw?.messageTimestamp ? String(raw.messageTimestamp) : null,
    pushName: raw?.pushName ?? null,
    messageType: raw?.message ? Object.keys(raw.message)[0] : null,
    text: msg.text ?? null,
    hasMedia: Boolean(msg.hasMedia),
  };
}

module.exports = { ingest, REPLY_WINDOW_HOURS };
