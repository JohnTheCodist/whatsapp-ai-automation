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
const { priorityFor } = require('../services/whatsapp/conversationState');
const conversationService = require('../services/whatsapp/conversationService');
const { sendAndRecordOutbound } = require('../services/whatsapp/outboundMessage');
const { CATEGORIES } = require('../services/whatsapp/communicationPolicy');
const { recordEvent } = require('../services/customers/customerEvents');
const { PATIENT_EVENTS } = require('../services/customers/patientEventTypes');
const { buildBriefing } = require('../services/safety/consultationBriefing');
const differential = require('../services/clinical/clinicalDifferentialService');

const router = express.Router();

/**
 * GET /waiting — the pharmacist's consultation queue.
 *
 * Separate from the Inbox on purpose. The Inbox is every conversation; this
 * is only the people who need a pharmacist, with enough of the situation
 * visible on the card that they can triage without opening anything.
 *
 * The briefing is assembled from data, never paraphrased by a model — see
 * consultationBriefing.js. A pharmacist acts clinically on what they read
 * here, and a summary that turns three months old into three years old reads
 * perfectly and causes harm.
 *
 * Ordered urgent first, then longest wait. Not newest: the person ignored
 * longest is the most urgent, which is the opposite of a message list.
 */
router.get('/waiting', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const rows = await db`
      select
        c.id as conversation_id, c.mode, c.context,
        cust.wa_phone, cust.display_name,
        h.id as handoff_id, h.category, h.reason, h.detail, h.requested_at
      from handoffs h
      join conversations c on c.id = h.conversation_id
      join customers cust on cust.id = c.customer_id
      where h.pharmacy_id = ${req.pharmacyId} and h.resolved_at is null
      order by h.requested_at
      limit 50
    `;

    // One query for every conversation's recent messages rather than one per
    // card. Fifty cards would otherwise be fifty round trips to a pooler that
    // has already been exhausted once in this project.
    const ids = rows.map((r) => r.conversation_id);
    const messages = ids.length
      ? await db`
          select conversation_id, direction, body, created_at
          from (
            select conversation_id, direction, body, created_at,
                   row_number() over (partition by conversation_id order by id desc) as rn
            from messages
            -- ::uuid[] is required. postgres.js sends a JS string array as
            -- text[], and Postgres will not compare a uuid against a text
            -- array — it fails with 22P02 rather than quietly returning
            -- nothing, which at least surfaces immediately.
            where conversation_id = any(${ids}::uuid[])
          ) ranked
          where rn <= 12
          order by conversation_id, created_at
        `
      : [];

    const byConversation = new Map();
    for (const m of messages) {
      if (!byConversation.has(m.conversation_id)) byConversation.set(m.conversation_id, []);
      byConversation.get(m.conversation_id).push(m);
    }

    const waiting = rows.map((r) => ({
      handoffId: r.handoff_id,
      conversationId: r.conversation_id,
      customer: r.display_name || r.wa_phone,
      phone: r.wa_phone,
      mode: r.mode,
      requestedAt: r.requested_at,
      ...buildBriefing({
        category: r.category,
        requestedAt: r.requested_at,
        messages: byConversation.get(r.conversation_id) || [],
        context: r.context || {},
      }),
    }));

    // Urgent to the top regardless of age — a two-minute-old possible
    // overdose outranks an hour-old question about which painkiller is best.
    waiting.sort((a, b) => (b.urgent - a.urgent) || (b.waitingMinutes - a.waitingMinutes));

    res.json({
      counts: {
        total: waiting.length,
        urgent: waiting.filter((w) => w.urgent).length,
        clinical: waiting.filter((w) => !w.technical).length,
        technical: waiting.filter((w) => w.technical).length,
      },
      waiting,
    });
  } catch (err) {
    next(err);
  }
});

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

    // The workflow filter. `all` (the default) keeps the previous behaviour
    // so nothing that already calls this route changes shape; `active` is the
    // working inbox — everything not resolved or archived.
    const filter = String(req.query.state || 'all');

    const rows = await db`
      select
        c.id, c.mode, c.last_message_at, c.workflow_state, c.created_at as started_at,
        cust.wa_phone, cust.display_name, cust.full_name,
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
        ${filter === 'all' ? db`` : filter === 'active'
          ? db`and c.workflow_state not in ('resolved', 'archived')`
          : db`and c.workflow_state = ${filter}`}
      order by
        -- Someone waiting on a pharmacist outranks everything, including an
        -- older thread. This is the same judgement priorityFor() encodes:
        -- the clinical queue is the one that can actually harm someone, so it
        -- is never sorted behind general recency.
        (c.workflow_state = 'waiting_for_pharmacist') desc,
        (h.id is not null) desc,
        h.requested_at asc nulls last,
        c.last_message_at desc
      limit 100
    `;

    // Counts per state, for the inbox headings. A separate aggregate rather
    // than counting the 100-row page: "WAITING FOR PHARMACIST 3" has to be
    // the true total, not however many happened to fit on this page.
    const stateCounts = await db`
      select workflow_state, count(*)::int as n
      from conversations
      where pharmacy_id = ${req.pharmacyId}
      group by workflow_state
    `;

    const [counts] = await db`
      select
        count(*) filter (where resolved_at is null)::int as open_handoffs,
        count(*)::int as total_handoffs
      from handoffs where pharmacy_id = ${req.pharmacyId}
    `;

    // Priority is derived from the workflow state, never stored and never
    // chosen by the model or the UI — so two screens cannot disagree about
    // what is urgent.
    res.json({
      counts,
      byState: Object.fromEntries(stateCounts.map((r) => [r.workflow_state, r.n])),
      conversations: rows.map((c) => ({ ...c, priority: priorityFor(c.workflow_state) })),
    });
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

/**
 * A pharmacist explicitly takes the conversation. THE ONLY THING THAT MUTES
 * THE ASSISTANT — raising a handoff no longer does (see
 * conversationState.deriveOwnership): HUMAN_PENDING keeps the assistant
 * answering within its safety boundaries, and only this route moves the
 * thread to HUMAN_ACTIVE.
 */
router.post('/:id/takeover', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    // DEV_AUTH_BYPASS hands out an all-zeroes placeholder id that does not
    // exist in auth.users, and handoffs.accepted_by is a real foreign key.
    // Writing it raw threw a 500 AFTER the mode update had already
    // committed — the conversation went silent while the pharmacist saw an
    // error and reasonably assumed the takeover had not happened. Same
    // guard the other four routes already use.
    const actorId = req.user?.id && req.user.id !== '00000000-0000-0000-0000-000000000000'
      ? req.user.id
      : null;

    // Both writes in one transaction. They are a single decision — "this
    // human now owns this thread" — and the failure above is exactly what
    // splitting them costs: a muted conversation with no one recorded as
    // having claimed it.
    const [updated] = await db.begin(async (tx) => {
      const [conv] = await tx`
        update conversations set mode = 'human'
        where id = ${req.params.id} and pharmacy_id = ${req.pharmacyId}
        returning id, mode
      `;
      if (!conv) return [null];

      // Claim the handoff so two staff do not both start typing.
      // handoff_last_activity_at starts the idle clock (0031): from here on,
      // silence means the customer is waiting on a human who may have been
      // pulled away, and the sweep in worker.js hands back to the assistant
      // rather than leaving the thread mute.
      await tx`
        update handoffs
        set accepted_by = ${actorId}, accepted_at = now(), handoff_last_activity_at = now()
        where conversation_id = ${req.params.id} and resolved_at is null and accepted_at is null
      `;
      return [conv];
    });

    if (!updated) return res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
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
      select c.id, cust.id as customer_id, cust.wa_jid, cust.wa_phone
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
    const { message } = await sendAndRecordOutbound(db, {
      pharmacyId: req.pharmacyId, customerId: conversation.customer_id, conversationId: conversation.id,
      accountId: account.id, to: conversation.wa_jid || `${conversation.wa_phone}@s.whatsapp.net`,
      body: text, author: 'staff', delay: false, category: CATEGORIES.TRANSACTIONAL,
    });
    await db`update conversations set last_message_at = now() where id = ${conversation.id}`;

    // A staff reply is the clearest possible signal that a human is still
    // engaged — resets the idle-takeback clock (0031) so a pharmacist
    // mid-conversation is never handed back to the assistant underneath them.
    await db`
      update handoffs set handoff_last_activity_at = now()
      where conversation_id = ${conversation.id} and resolved_at is null
    `;

    // A pharmacist answered, so the thread is waiting on the customer — not
    // still sitting in the pharmacist queue. Without this the inbox would keep
    // showing it as needing a human that has already replied, which is the
    // single most misleading state the inbox can be in.
    await conversationService.onPharmacistReplied(db, {
      pharmacyId: req.pharmacyId,
      conversationId: conversation.id,
      actorId: req.user?.id || null,
    });

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
      update handoffs h set resolved_at = now()
      from conversations c
      where h.conversation_id = c.id
        and h.conversation_id = ${req.params.id} and h.pharmacy_id = ${req.pharmacyId} and h.resolved_at is null
      returning h.id, h.resolved_at, h.category, c.customer_id
    `;
    // This is the one genuine "a pharmacist dealt with it" moment in the
    // codebase — worker.js also sets resolved_at, but only when the
    // CUSTOMER declines an offered handoff, which is the opposite fact and
    // must never produce this event.
    for (const h of rows) {
      await recordEvent(db, {
        pharmacyId: req.pharmacyId, customerId: h.customer_id,
        eventType: PATIENT_EVENTS.PHARMACIST_RESPONDED, occurredAt: h.resolved_at, actorType: 'pharmacist',
        actorId: req.user?.id || null,
        entityType: 'handoff', entityId: h.id,
        metadata: { category: h.category },
      });
    }
    // Only move the workflow state if a handoff was actually resolved.
    // Calling this unconditionally would mark a thread RESOLVED on a
    // double-click that resolved nothing.
    if (rows.length) {
      await conversationService.resolve(db, {
        pharmacyId: req.pharmacyId,
        conversationId: req.params.id,
        actorType: 'staff',
        actorId: req.user?.id || null,
        reason: 'pharmacist_resolved',
      });
    }

    res.json({ ok: true, resolved: rows.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/archive — file a resolved thread away.
 *
 * Its own route rather than a generic "set state" endpoint, because a generic
 * one would let the UI drive the machine directly and the matrix would stop
 * being the authority. The matrix permits archiving only from RESOLVED, so an
 * attempt to archive a live thread comes back refused with a reason rather
 * than quietly succeeding.
 */
router.post('/:id/archive', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const result = await conversationService.archive(getSql(), {
      pharmacyId: req.pharmacyId,
      conversationId: req.params.id,
      actorType: 'staff',
      actorId: req.user?.id || null,
    });
    if (!result.changed) {
      return res.status(409).json({
        error: 'That conversation cannot be archived from its current state.',
        code: result.reason,
        state: result.from,
      });
    }
    res.json({ ok: true, from: result.from, to: result.to });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /:id/differential — a pharmacist asks the AI for possible causes.
 *
 * Deliberately separate from everything else in this file: every other
 * route here moves a conversation through the handoff matrix or sends a
 * message a customer will read. This does neither. It calls the LLM,
 * returns an unsourced, clearly-labelled opinion to the DASHBOARD ONLY, and
 * never touches conversations, messages, or handoffs. See
 * clinicalDifferentialService.js for why this exists as a separate module
 * from the evidence-gated recommendation path.
 */
router.post('/:id/differential', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const [target] = await db`
      select pe.id as execution_id, c.customer_id
      from clinical_encounters e
      join protocol_executions pe on pe.encounter_id = e.id
      join conversations c on c.id = e.conversation_id
      where e.conversation_id = ${req.params.id} and e.pharmacy_id = ${req.pharmacyId}
      order by pe.started_at desc
      limit 1
    `;
    if (!target) {
      return res.status(404).json({
        error: 'No clinical assessment found for this conversation.', code: 'NO_ASSESSMENT',
      });
    }

    const actorId = req.user?.id && req.user.id !== '00000000-0000-0000-0000-000000000000'
      ? req.user.id
      : null;

    const suggestion = await differential.suggestLikelyCauses(req.pharmacyId, target.execution_id, {
      actorType: 'pharmacist', actorId, customerId: target.customer_id,
    });

    res.json(suggestion);
  } catch (err) {
    if (err.code === 'LLM_UNAVAILABLE' || err.code === 'DIFFERENTIAL_UNAVAILABLE') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

module.exports = router;
