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
const { resolveConversation } = require('./conversationPolicy');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { resolveCustomer } = require('../customers/customerIdentity');
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
      // 2. Who is this? Identity resolution lives in customerIdentity.js
      //    rather than inline here, because it is now called from more than
      //    one place and a second copy of "find the customer by phone" is
      //    how two call sites end up disagreeing about who someone is.
      //
      //    It is atomic by constraint — one INSERT ... ON CONFLICT against
      //    the unique index — so two first messages arriving on overlapping
      //    connections cannot create two customers.
      const { customerId, created } = await resolveCustomer(tx, {
        pharmacyId,
        phone: phoneNumber,
        lid,
        jid: replyJid,
        displayName,
        defaultCountry: env.defaultCountry,
      });

      if (created) {
        // Exactly once in a customer's lifetime — resolveCustomer reports
        // whether this call was the INSERT branch of the upsert, which is
        // the only way to tell a genuinely new person from a returning one
        // in a single statement.
        const [{ first_seen_at: firstSeenAt }] = await tx`
          select first_seen_at from customers where id = ${customerId}
        `;
        await recordEvent(tx, {
          pharmacyId, customerId, eventType: PATIENT_EVENTS.PATIENT_CREATED,
          occurredAt: firstSeenAt, actorType: 'system',
          entityType: 'customer', entityId: customerId,
          // The row was created microseconds ago inside this same
          // transaction; a separate verification query would only re-read it.
          verifyEntity: false,
        });
      }

      const customer = { id: customerId };

      // 3. The conversation. One open thread per customer — a 'closed' one
      //    is history and must not be reopened silently, because reopening
      //    would resurrect stale context ("I want two" referring to a
      //    product discussed last month).
      // The segmentation rule lives in conversationPolicy, not here. It used
      // to be the inline clause `mode <> 'closed'` — and because nothing ever
      // wrote 'closed', it always matched: one patient accumulated a single
      // conversation of 143 messages across five days. Moving the decision to
      // a pure function is what makes the boundary testable and tunable
      // without editing the write path.
      //
      // `for update` on the row is what makes this safe under concurrency.
      // Two messages arriving together would otherwise both read "no active
      // conversation" and both insert one; the lock makes the second wait and
      // see the first one's decision.
      const [latest] = await tx`
        select id, status, last_message_at from conversations
        where pharmacy_id = ${pharmacyId} and customer_id = ${customer.id}
        order by last_message_at desc
        limit 1
        for update
      `;

      const decision = resolveConversation({ latest: latest || null });
      let conversation = decision.action === 'reuse' ? { id: decision.conversationId } : null;

      if (!conversation) {
        [conversation] = await tx`
          insert into conversations (pharmacy_id, customer_id, mode, last_message_at, window_expires_at)
          values (${pharmacyId}, ${customer.id}, 'bot', now(),
                  now() + interval '${tx.unsafe(String(REPLY_WINDOW_HOURS))} hours')
          returning id
        `;
        await recordEvent(tx, {
          pharmacyId, customerId: customer.id, eventType: PATIENT_EVENTS.CONVERSATION_STARTED,
          actorType: 'customer', entityType: 'conversation', entityId: conversation.id,
        });
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
      const messageAt = timestamp ? new Date(timestamp) : new Date();
      const [stored] = await tx`
        insert into messages
          (pharmacy_id, conversation_id, direction, author, body, provider_message_id, created_at)
        values
          (${pharmacyId}, ${conversation.id}, 'inbound', 'customer',
           ${text || null}, ${providerMessageId}, ${messageAt})
        returning id
      `;

      // entity_id is this message's own row, not providerMessageId — the
      // uuid/bigint each entity_type actually uses, consistently, is the
      // thing 0017's idempotency constraint keys on.
      await recordEvent(tx, {
        pharmacyId, customerId: customer.id, eventType: PATIENT_EVENTS.MESSAGE_RECEIVED,
        occurredAt: messageAt, actorType: 'customer',
        entityType: 'message', entityId: stored.id,
        // A preview only — the message row is the source of truth, never
        // duplicated in full here. See customerEvents.js.
        metadata: { preview: (text || '').slice(0, 200), conversationId: conversation.id },
      });

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
