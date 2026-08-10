/**
 * Staff inbox — the other half of the safety design.
 *
 * The clinical filter escalates by writing a `handoffs` row and muting the
 * assistant. Until this route existed that was where it ended: a customer
 * asking about a drug interaction got silence, and the escalation sat in a
 * table nobody could read. A handoff nobody sees is not a handoff — it is a
 * dropped customer with better paperwork.
 *
 *   GET  /api/conversations              inbox, most urgent first
 *   GET  /api/conversations/:id          full thread
 *   POST /api/conversations/:id/takeover assistant muted, staff replying
 *   POST /api/conversations/:id/reply    staff sends, as staff
 *   POST /api/conversations/:id/release  hand back to the assistant
 *   POST /api/conversations/:id/resolve  close the open handoff
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { sessionManager } = require('../services/whatsapp/sessionManager');

const router = express.Router();

/**
 * Inbox ordering is the product decision in this file.
 *
 * Sorting by recency would bury a two-hour-old clinical escalation under
 * chatter about opening times. Anything waiting on a human sorts first, and
 * within that, oldest first — the person who has been ignored longest is the
 * most urgent, which is the opposite of a normal message list.
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const rows = await db`
      select
        c.id, c.mode, c.last_message_at,
        cust.wa_phone, cust.display_name,
        h.id as handoff_id, h.reason as handoff_reason, h.detail as handoff_detail,
        h.requested_at as handoff_at,
        (select body from messages m where m.conversation_id = c.id order by m.id desc limit 1) as last_body,
        (select direction from messages m where m.conversation_id = c.id order by m.id desc limit 1) as last_direction,
        (select count(*)::int from messages m where m.conversation_id = c.id) as message_count
      from conversations c
      join customers cust on cust.id = c.customer_id
      -- Only OPEN handoffs. A resolved one is history and must not keep a
      -- conversation pinned to the top of the queue forever.
      left join lateral (
        select id, reason, detail, requested_at from handoffs
        where conversation_id = c.id and resolved_at is null
        order by requested_at limit 1
      ) h on true
      where c.pharmacy_id = ${req.pharmacyId}
      order by
        (h.id is not null) desc,
        h.requested_at asc nulls last,
        c.last_message_at desc
      limit 100
    `;

    const [counts] = await db`
      select
        count(*) filter (where resolved_at is null)::int as open_handoffs,
        count(*)::int as total_handoffs
      from handoffs where pharmacy_id = ${req.pharmacyId}
    `;

    res.json({ counts, conversations: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const [conversation] = await db`
      select c.id, c.mode, c.context, c.last_message_at,
             cust.id as customer_id, cust.wa_phone, cust.wa_jid, cust.display_name
      from conversations c
      join customers cust on cust.id = c.customer_id
      where c.id = ${req.params.id} and c.pharmacy_id = ${req.pharmacyId}
    `;
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });

    const [messages, handoffs, orders] = await Promise.all([
      db`select id, direction, author, body, delivery_status, created_at
         from messages where conversation_id = ${req.params.id}
         order by id asc limit 200`,
      db`select id, reason, detail, requested_at, accepted_at, resolved_at
         from handoffs where conversation_id = ${req.params.id}
         order by requested_at desc`,
      db`select id, reference, status, total_kobo, created_at
         from orders where conversation_id = ${req.params.id}
         order by created_at desc`,
    ]);

    res.json({ conversation, messages, handoffs, orders });
  } catch (err) {
    next(err);
  }
});

/** Mute the assistant. The worker checks `mode` before every reply. */
router.post('/:id/takeover', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const [updated] = await db`
      update conversations set mode = 'human'
      where id = ${req.params.id} and pharmacy_id = ${req.pharmacyId}
      returning id, mode
    `;
    if (!updated) return res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });

    // Claim the handoff so two staff do not both start typing.
    await db`
      update handoffs set accepted_by = ${req.user?.id || null}, accepted_at = now()
      where conversation_id = ${req.params.id} and resolved_at is null and accepted_at is null
    `;

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Staff reply. Sends over the same socket the assistant uses.
 *
 * Recorded with author='staff' so the difference between what a person said
 * and what the assistant said stays legible — for auditing a complaint, and
 * for never training on staff text as if it were assistant output.
 */
router.post('/:id/reply', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'A reply cannot be empty.', code: 'EMPTY' });

    const db = getSql();
    const [conversation] = await db`
      select c.id, cust.wa_jid, cust.wa_phone
      from conversations c join customers cust on cust.id = c.customer_id
      where c.id = ${req.params.id} and c.pharmacy_id = ${req.pharmacyId}
    `;
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });

    const [account] = await db`
      select id from whatsapp_accounts
      where pharmacy_id = ${req.pharmacyId} and provider = 'baileys' and status = 'connected'
      limit 1
    `;
    if (!account) {
      return res.status(409).json({ error: 'WhatsApp is not connected.', code: 'NOT_CONNECTED' });
    }

    // No conduct check here, deliberately. Those rules exist to stop an
    // AUTOMATED system behaving like spam. A person choosing to answer a
    // customer who wrote to them is the behaviour the rules are protecting;
    // quiet hours should not stop staff replying to someone waiting.
    const sent = await sessionManager.sendText(
      account.id,
      conversation.wa_jid || `${conversation.wa_phone}@s.whatsapp.net`,
      text,
      { delay: false },
    );

    const [message] = await db`
      insert into messages (pharmacy_id, conversation_id, direction, author, body,
                            provider_message_id, delivery_status)
      values (${req.pharmacyId}, ${conversation.id}, 'outbound', 'staff', ${text},
              ${sent.providerMessageId}, 'sent')
      returning id, direction, author, body, created_at
    `;
    await db`update conversations set last_message_at = now() where id = ${conversation.id}`;

    res.json({ ok: true, message });
  } catch (err) {
    next(err);
  }
});

/** Hand back to the assistant. */
router.post('/:id/release', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const [updated] = await db`
      update conversations set mode = 'bot'
      where id = ${req.params.id} and pharmacy_id = ${req.pharmacyId}
      returning id, mode
    `;
    if (!updated) return res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Close the handoff.
 *
 * Kept separate from `release` on purpose: a clinical question can be
 * answered and closed while staff stay in the conversation, and a
 * conversation can be handed back without pretending the escalation was
 * dealt with.
 */
router.post('/:id/resolve', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const rows = await db`
      update handoffs set resolved_at = now()
      where conversation_id = ${req.params.id} and pharmacy_id = ${req.pharmacyId} and resolved_at is null
      returning id
    `;
    res.json({ ok: true, resolved: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
