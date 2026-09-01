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
const { canSendMessage, withRequiredFooter } = require('./communicationPolicy');
const { recordConversationUsage } = require('../billing/usageMeter');

const ACTOR_BY_AUTHOR = { assistant: 'ai', staff: 'staff', system: 'system' };

/**
 * Store an already-sent message and its MESSAGE_SENT event, together.
 *
 * Split out from sendAndRecordOutbound below for the sites that need the
 * insert to sit inside a larger transaction alongside other statements (e.g.
 * also stamping customers.onboarded_at) — they call sessionManager.sendText
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
  category = null, eligibilityReason = null,
}) {
  const [message] = await sql`
    insert into messages (pharmacy_id, conversation_id, direction, author, body,
                          provider_message_id, delivery_status, category, eligibility_reason)
    values (${pharmacyId}, ${conversationId}, 'outbound', ${author}, ${body},
            ${providerMessageId}, 'sent', ${category || null}, ${eligibilityReason || null})
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

  // Meter the conversation, once, on the first assistant reply in it.
  //
  // HERE BECAUSE THIS IS THE CHOKE POINT. Six call sites across the worker
  // reach an outbound row, and every one of them comes through this
  // function — the same reason the timeline event is written here rather
  // than at each site. A seventh send path added later is metered by
  // existing, which is the only version of this that stays true.
  //
  // In the SAME transaction as the message on purpose: a counted
  // conversation with no message, or a message that was never counted, are
  // both states nobody could reconstruct afterwards. The unique index makes
  // the repeat case a no-op rather than an error, so this cannot fail a
  // reply that would otherwise have gone out.
  await recordConversationUsage(sql, {
    pharmacyId, conversationId, author,
  });

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
  category, footer = null,
}) {
  // ---- consent, before the transport ------------------------------------
  //
  // The check is HERE rather than at each caller because a caller that
  // forgets it produces a message that should never have been sent, and
  // nothing downstream can tell. Putting it in the one function that owns
  // the send means a new outbound site is covered by construction.
  //
  // A send with no category is refused outright. That is what makes
  // "every outbound message declares what it is" enforceable instead of a
  // convention — and refusing is safe, because the failure mode of this
  // check is a message not going out, which is recoverable, while the
  // failure mode of skipping it is a message that cannot be unsent.
  const [customer] = customerId
    ? await sql`
        select status, communication_status,
               comm_transactional, comm_order_notifications, comm_medication, comm_marketing
        from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
      `
    : [null];

  const decision = canSendMessage({ category, customer });
  if (!decision.allowed) {
    const err = new Error(`Message not permitted: ${decision.reason}`);
    err.code = 'NOT_PERMITTED';
    err.reason = decision.reason;
    err.blocked = true;
    throw err;
  }

  // Marketing carries its unsubscribe line whether or not the campaign
  // author remembered it. Added after the consent check so a blocked send
  // never even composes one.
  const finalBody = withRequiredFooter(body, category, footer);

  const sendOpts = delay === undefined ? undefined : { delay };
  const sent = await sessionManager.sendText(accountId, to, finalBody, sendOpts);
  const message = await insertOutboundMessage(sql, {
    pharmacyId, customerId, conversationId, providerMessageId: sent.providerMessageId,
    body: finalBody, author,
    // The decision is stored as a snapshot, never recomputed. Preferences
    // change; this has to keep explaining why the message was legitimate when
    // it went out.
    category, eligibilityReason: decision.reason,
  });
  return { message, sent, decision };
}

module.exports = { sendAndRecordOutbound, insertOutboundMessage };
