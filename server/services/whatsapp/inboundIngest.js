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
const { shouldIngest } = require('./ingestionPolicy');
const { env } = require('../../config/env');

/** How long a customer-initiated reply window stays open. */
const REPLY_WINDOW_HOURS = 24;

/**
 * @param {object} msg  the payload emitted by sessionManager 'message'
 * @returns {Promise<{stored: boolean, reason?: string, messageId?: number, conversationId?: string}>}
 */
async function ingest(msg) {
  const {
    pharmacyId, accountId, providerMessageId,
    phoneNumber, lid, replyJid, displayName,
    text, hasMedia, timestamp, raw,
  } = msg;

  assertPharmacyId(pharmacyId);

  if (!providerMessageId) {
    // Without an id there is no dedupe key, and re-processing on the next
    // reconnect would mean answering the same person twice. Dropping is the
    // safer failure, and it is recorded rather than silent.
    return { stored: false, reason: 'no_provider_message_id' };
  }

  if (!replyJid) {
    // wa_jid is now the customer identity key (0016) and is NOT NULL at the
    // database level. In real traffic this should never happen — Baileys
    // always carries msg.key.remoteJid — so this guard exists to fail with a
    // clear reason rather than let a malformed event hit the NOT NULL
    // constraint and surface as an opaque insert error three lines down.
    return { stored: false, reason: 'no_reply_jid' };
  }

  const db = getSql();

  // 0. SCOPE GATE — before the first insert, on purpose.
  //
  //    Baileys sees every conversation on the account, not just customers.
  //    Filtering this later, at display time, would leave the owner's private
  //    messages sitting in our database, which is the part that actually
  //    matters. A message refused here leaves no row anywhere — not even the
  //    sender's number.
  //
  //    Note what is NOT logged below: the message body, and in the personal
  //    case the number too. Recording "we discarded a private message from
  //    +234..." would defeat most of the point.
  const [scope] = await db`
    select
      ph.ingest_mode,
      coalesce(array(select wa_phone from outbound_allowlist where pharmacy_id = ph.id), '{}') as allowlist,
      coalesce(array(select wa_phone from blocked_senders where pharmacy_id = ph.id), '{}') as blocked
    from pharmacies ph where ph.id = ${pharmacyId}
  `;

  const decision = shouldIngest({
    ingestMode: scope?.ingest_mode || 'all',
    phone: phoneNumber,
    allowlist: scope?.allowlist || [],
    blocked: scope?.blocked || [],
    fromMe: Boolean(msg.fromMe),
    defaultCountryCode: env.defaultCountryCode,
  });

  if (!decision.ingest) {
    return { stored: false, reason: `not_in_scope:${decision.reason}` };
  }

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
      // 2. The customer. Atomic find-or-create: a single statement guarded by
      //    the (pharmacy_id, wa_jid) unique index, not a SELECT-then-INSERT.
      //    Two inbound messages from a brand-new sender arriving on
      //    overlapping connections cannot produce two customer rows — the
      //    second insert blocks on the index, sees the first one committed,
      //    and updates it instead. This is what makes patient identity safe
      //    under real concurrency rather than merely safe in the common case.
      //
      //    wa_jid is the identity key (0016) and is never in the SET clause:
      //    it is the conflict target, so by definition it already equals
      //    what is stored. A message that genuinely carries a DIFFERENT jid
      //    is a different customer and inserts a new row — it does not, and
      //    must not, silently take over an existing one.
      //
      //    wa_phone and wa_lid are best-effort and DO get refreshed: a later
      //    message can resolve a real phone number where an earlier one
      //    could not, and there is no reason to keep the worse value once a
      //    better one arrives. last_seen_at moves; first_seen_at does not.
      const [customer] = await tx`
        insert into customers (pharmacy_id, wa_phone, wa_lid, wa_jid, display_name, last_seen_at)
        values (${pharmacyId}, ${phoneNumber}, ${lid || null}, ${replyJid},
                ${displayName || null}, now())
        on conflict (pharmacy_id, wa_jid) do update
          set last_seen_at  = now(),
              wa_phone      = coalesce(excluded.wa_phone, customers.wa_phone),
              wa_lid        = coalesce(excluded.wa_lid, customers.wa_lid),
              display_name  = coalesce(excluded.display_name, customers.display_name)
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
