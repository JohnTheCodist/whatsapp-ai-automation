/**
 * The one place an outbound WhatsApp message becomes a stored row AND a
 * timeline event, together.
 *
 * WHY THIS EXISTS
 * Nine call sites across worker.js, orders.js, requests.js and
 * conversations.js each independently called sessionManager.sendText() and
 * then hand-wrote an insert into messages. Nine near-identical blocks is
 * nine chances to add a tenth later and forget the MESSAGE_SENT event —
 * exactly the kind of silent gap this segment exists to close. Centralising
 * the pairing means a new outbound site gets timeline recording for free by
 * construction, not by remembering to add it.
 *
 * WHY THE EVENT IS RECORDED ONLY AFTER A SUCCESSFUL INSERT
 * "Do not record it as sent if WhatsApp delivery/send failed" — sendText()
 * throws on failure, before the messages row or the event ever get written.
 * There is no path here that records MESSAGE_SENT for a send that didn't
 * happen.
 *
 * NOT WRAPPED IN A DB TRANSACTION WITH THE SEND ITSELF
 * The WhatsApp send is a real network side effect that cannot be rolled
 * back. Wrapping it in the same transaction as the row insert would invite
 * exactly the wrong failure mode — a message genuinely delivered to the
 * customer, then "undone" by a later statement in the same transaction
 * failing. The insert (and the event within it) happens strictly after the
 * send succeeds, matching how every one of the nine original call sites
 * already worked.
 */

const { sessionManager } = require('./sessionManager');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

const ACTOR_BY_AUTHOR = { assistant: 'ai', staff: 'staff', system: 'system' };

/**
 * Store an already-sent message and its MESSAGE_SENT event, together.
 *
 * Split out from sendAndRecordOutbound below for the sites that need the
 * insert to sit inside a larger transaction alongside other statements (e.g.
 * also stamping conversations.greeted_at) — they call sessionManager.sendText
 * themselves first, same as always, then call this inside their own
 * `db.begin`. Every site still gets the event recorded through one shared
 * path rather than nine hand-written inserts.
 *
 * @param {object} sql              a postgres.js sql instance or open tx
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} [args.customerId]  for the MESSAGE_SENT event. Omit only
 *   when genuinely unavailable — the message still gets stored, it just
 *   won't appear on a customer timeline.
 * @param {string} args.conversationId
 * @param {string} args.providerMessageId
 * @param {string} args.body
 * @param {'assistant'|'staff'|'system'} [args.author]
 * @returns {Promise<object>} the stored message row (id, created_at)
 */
async function insertOutboundMessage(sql, {
  pharmacyId, customerId, conversationId, providerMessageId, body, author = 'system',
}) {
  const [message] = await sql`
    insert into messages (pharmacy_id, conversation_id, direction, author, body,
                          provider_message_id, delivery_status)
    values (${pharmacyId}, ${conversationId}, 'outbound', ${author}, ${body},
            ${providerMessageId}, 'sent')
    returning id, created_at
  `;

  if (customerId) {
    await recordEvent(sql, {
      pharmacyId, customerId, eventType: PATIENT_EVENTS.MESSAGE_SENT,
      occurredAt: message.created_at,
      actorType: ACTOR_BY_AUTHOR[author] || 'system',
      entityType: 'message', entityId: message.id,
      metadata: { author, conversationId, preview: (body || '').slice(0, 200) },
    });
  }

  return message;
}

/**
 * Send, then store + record, in one call — for the simple, common case where
 * nothing else needs to share the transaction.
 *
 * WHY THIS IS NOT ONE TRANSACTION SPANNING THE SEND
 * The WhatsApp send is a real network side effect that cannot be rolled
 * back. The insert happens strictly after sendText resolves, matching every
 * one of the call sites this replaces — a failed send throws before either
 * the message row or its event exist, so "record it as sent" and "it was
 * actually sent" can never disagree.
 *
 * @param {object} sql
 * @param {object} args  see insertOutboundMessage, plus:
 * @param {string} args.accountId  the Baileys account to send from
 * @param {string} args.to         JID or phone-derived JID to send to
 * @param {boolean} [args.delay]   passed through to sessionManager.sendText
 * @returns {Promise<{message: object, sent: object}>}
 */
async function sendAndRecordOutbound(sql, {
  pharmacyId, customerId, conversationId, accountId, to, body, author = 'system', delay,
}) {
  const sendOpts = delay === undefined ? undefined : { delay };
  const sent = await sessionManager.sendText(accountId, to, body, sendOpts);
  const message = await insertOutboundMessage(sql, {
    pharmacyId, customerId, conversationId, providerMessageId: sent.providerMessageId, body, author,
  });
  return { message, sent };
}

module.exports = { sendAndRecordOutbound, insertOutboundMessage };
