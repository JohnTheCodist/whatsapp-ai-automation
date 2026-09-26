/**
 * One patient's communication history.
 *
 * See MESSAGES_PLAN.md. This is a VIEW of `conversations` and `messages` —
 * the tables this product has had since 0001 and which receive every live
 * patient's WhatsApp traffic. It creates nothing, sends nothing and copies
 * nothing, because §36 of the brief says what happens when a messaging
 * feature keeps its own copy of the messages: three stores and three answers
 * to "what did she actually say".
 *
 * WHAT A "CONVERSATION" IS HERE
 * A session, not a synonym for the patient (0023). A patient has at most ONE
 * open thread at a time — `idx_conversations_one_open` — and everything
 * earlier is a closed session. So the Active list holds one thread or none,
 * and the rest is history. That is not a limitation worked around; it is the
 * invariant that stopped one patient's 143 messages being a single
 * undifferentiated thread, and the one whose violation dropped 16 messages
 * from a live patient for three days.
 *
 * WHAT THIS MODULE MAY NOT DO
 * Reply and archive are NOT here. They live in routes/conversations.js, which
 * owns the one send path (`sendAndRecordOutbound`), the WhatsApp connection
 * check and the handoff clock. The patient screen calls those endpoints. A
 * second send path is exactly what §36 forbids, and it is also how a message
 * gets sent without the conduct rules that stop this product looking like
 * spam.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id AND customer_id IN ITS OWN WHERE
 * CLAUSE — GOLDEN-001. A conversation id is not a capability: naming one that
 * belongs to another pharmacy, or to another patient in this pharmacy, is a
 * 404 and not a transcript.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { topicLabel, linkKindLabel } = require('./messageInput');
const { assertRecord, describeRecord } = require('../clinical/clinicalRefs');

/**
 * The shape a conversation takes on a screen.
 *
 * `status` and `workflow_state` are both carried because they answer
 * different questions (0023, 0024): whether the thread is still running, and
 * whose turn it is. The screen needs both — "closed" is not "resolved", and a
 * thread waiting on a pharmacist is the one that matters most.
 */
function shapeConversation(row) {
  return {
    id: row.id,
    // whatsapp | internal (0066). A different KIND of thread, not a flagged
    // one — and the screen must never have to infer which.
    channel: row.channel || 'whatsapp',
    // An internal thread's subject lives in `summary`, which 0023 added for
    // exactly this kind of staff-side label and which no patient ever sees.
    subject: row.channel === 'internal' ? (row.summary || null) : null,
    status: row.status,
    workflowState: row.workflow_state,
    // Who is replying: the assistant, or a person. §11 — the patient is
    // talking to one or the other and the screen must not blur them.
    mode: row.mode,
    topic: row.topic || null,
    topicLabel: topicLabel(row.topic),
    topicSetAt: row.topic_set_at || null,
    assignedTo: row.assigned_to || null,
    lastMessageAt: row.last_message_at,
    startedAt: row.created_at,
    closedAt: row.closed_at || null,
    closedReason: row.closed_reason || null,
    messageCount: Number(row.message_count || 0),
    // How many INBOUND messages this reader has not seen (§17, 0064). Counted
    // on read from their own mark, never stored — so one pharmacist opening a
    // thread does not clear the badge for the colleague about to answer it.
    // A reader with no mark has read nothing, which is why every inbound
    // message counts until they open it.
    unread: Number(row.unread || 0),
    // The last thing said, for the list. Trimmed on the way out rather than
    // in the query, so the transcript and the preview cannot disagree.
    lastMessage: row.last_body == null ? null : {
      body: String(row.last_body).slice(0, 160),
      author: row.last_author,
      direction: row.last_direction,
    },
    // A thread still waiting on a pharmacist is the one thing on this screen
    // that means somebody is waiting for an answer right now.
    awaitingPharmacist: row.workflow_state === 'waiting_for_pharmacist',
  };
}

// Unaliased on purpose: this list is used inside `from conversations c`,
// where the alias exists, AND inside an UPDATE ... RETURNING, where it does
// not. Prefixing it with `c.` made the second one fail with "missing
// FROM-clause entry for table c" — found by the database on the first run.
const CONVERSATION_SELECT = `
  id, status, workflow_state, mode, topic, topic_set_at, channel, summary,
  assigned_to, last_message_at, created_at, closed_at, closed_reason
`;

/**
 * A patient's threads.
 *
 * `filter` is active | archived | all. "Archived" is every closed session,
 * which is the brief's Archived list: §19 says communication history is never
 * deleted because a conversation stopped being active, and nothing here
 * deletes anything.
 */
async function listPatientConversations(pharmacyId, customerId, { filter = 'active', topic = null, q = null, userId = null, channel = 'whatsapp' } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const rows = await db`
    select
      ${db.unsafe(CONVERSATION_SELECT)},
      (select count(*)::int from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}) as message_count,
      (select m.body from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
        order by m.id desc limit 1) as last_body,
      (select m.author from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
        order by m.id desc limit 1) as last_author,
      (select m.direction from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
        order by m.id desc limit 1) as last_direction,
      ${userId ? db`(
        select count(*)::int from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
          and m.direction = 'inbound'
          and m.created_at > coalesce((
            select r.last_read_at from conversation_read_marks r
            where r.conversation_id = c.id and r.user_id = ${userId}
          ), '-infinity'::timestamptz)
      )` : db`0`} as unread
    from conversations c
    where c.pharmacy_id = ${pharmacyId}
      and c.customer_id = ${customerId}
      ${channel === 'all' ? db`` : db`and c.channel = ${channel}`}
      ${filter === 'active' ? db`and c.status = 'open'` : db``}
      ${filter === 'archived' ? db`and c.status = 'closed'` : db``}
      ${topic ? db`and c.topic = ${topic}` : db``}
      ${q ? db`and exists (
        select 1 from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
          and m.body ilike ${'%' + q + '%'}
      )` : db``}
    order by c.last_message_at desc
  `;

  // The counts are of the PATIENT's threads, not of the filtered list — a
  // pharmacist looking at an empty Active list still needs to know that nine
  // archived conversations exist, or they will conclude this patient has
  // never been spoken to.
  const [counts] = await db`
    select
      count(*)::int as all,
      count(*) filter (where status = 'open')::int as active,
      count(*) filter (where status = 'closed')::int as archived,
      count(*) filter (where workflow_state = 'waiting_for_pharmacist')::int as awaiting_pharmacist,
      max(last_message_at) as last_contact_at
    from conversations
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      ${channel === 'all' ? db`` : db`and channel = ${channel}`}
  `;

  // Unread across the patient's threads, for this reader. A separate query
  // because the one above counts CONVERSATIONS and this counts MESSAGES, and
  // one statement doing both is how a count starts meaning neither.
  const [unread] = userId ? await db`
    select
      count(*)::int as messages,
      count(distinct m.conversation_id)::int as conversations
    from messages m
    join conversations c on c.id = m.conversation_id
    where m.pharmacy_id = ${pharmacyId}
      and c.pharmacy_id = ${pharmacyId}
      and c.customer_id = ${customerId}
      and m.direction = 'inbound'
      ${channel === 'all' ? db`` : db`and c.channel = ${channel}`}
      and m.created_at > coalesce((
        select r.last_read_at from conversation_read_marks r
        where r.conversation_id = c.id and r.user_id = ${userId}
      ), '-infinity'::timestamptz)
  ` : [{ messages: 0, conversations: 0 }];

  // Internal threads, counted separately and ALWAYS — so the screen can badge
  // its Internal view without a second request, and so the patient-facing
  // counts above stay about the patient. An internal note written by the
  // reader themselves is not unread to them.
  const [internal] = userId ? await db`
    select
      count(distinct c.id)::int as threads,
      count(*) filter (
        where m.direction = 'internal'
          and m.author_user_id is distinct from ${userId}
          and m.created_at > coalesce((
            select r.last_read_at from conversation_read_marks r
            where r.conversation_id = c.id and r.user_id = ${userId}
          ), '-infinity'::timestamptz)
      )::int as unread
    from conversations c
    left join messages m on m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
    where c.pharmacy_id = ${pharmacyId}
      and c.customer_id = ${customerId}
      and c.channel = 'internal'
  ` : await db`
    select count(*)::int as threads, 0 as unread
    from conversations
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and channel = 'internal'
  `;

  return {
    conversations: rows.map(shapeConversation),
    counts: {
      all: Number(counts?.all || 0),
      active: Number(counts?.active || 0),
      archived: Number(counts?.archived || 0),
      awaitingPharmacist: Number(counts?.awaiting_pharmacist || 0),
      unread: Number(unread?.messages || 0),
      unreadConversations: Number(unread?.conversations || 0),
    },
    // §4's "Last contact". Null when there has never been any, which the
    // screen says as "No messages" rather than as a date it made up.
    lastContactAt: counts?.last_contact_at || null,
    // What the Internal view holds, so its badge needs no second request.
    internal: {
      threads: Number(internal?.threads || 0),
      unread: Number(internal?.unread || 0),
    },
  };
}

/**
 * One thread, with what was said in it.
 *
 * NOTHING IS REWRITTEN ON THE WAY OUT (§31). `body` is what was sent or
 * received. `deliveryStatus` is what the provider reported and nothing else —
 * an outbound message whose status never came back reports null, not "sent",
 * because §34 is explicit that a message which did not arrive must never look
 * like one that did.
 */
async function getPatientConversation(pharmacyId, customerId, conversationId, { userId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [row] = await db`
    select
      ${db.unsafe(CONVERSATION_SELECT)},
      (select count(*)::int from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}) as message_count,
      ${userId ? db`(
        select count(*)::int from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}
          and m.direction = 'inbound'
          and m.created_at > coalesce((
            select r.last_read_at from conversation_read_marks r
            where r.conversation_id = c.id and r.user_id = ${userId}
          ), '-infinity'::timestamptz)
      )` : db`0`} as unread,
      null as last_body, null as last_author, null as last_direction
    from conversations c
    where c.id = ${conversationId}
      and c.pharmacy_id = ${pharmacyId}
      and c.customer_id = ${customerId}
      and c.channel = 'whatsapp'
  `;
  // An internal thread is not a transcript with a patient and is not served
  // here. It has its own read, which shapes NOTES — so nothing that renders a
  // patient conversation can be handed one by mistake.
  if (!row) return null;

  const messages = await db`
    select id, direction, author, body, media_url, delivery_status,
           delivery_error, created_at
    from messages
    where conversation_id = ${conversationId} and pharmacy_id = ${pharmacyId}
    order by id asc
  `;

  // The records this thread was about (§13). Read here so a screen showing a
  // transcript cannot be showing links from a different conversation.
  const links = await conversationLinks(pharmacyId, customerId, conversationId, { sql: db });

  return {
    conversation: shapeConversation(row),
    links,
    messages: messages.map((m) => ({
      id: String(m.id),
      direction: m.direction,
      // customer | assistant | staff | system — §11's Patient / AI /
      // Pharmacist distinction, which this table has carried since 0001. The
      // screen must never render `assistant` as a pharmacist.
      author: m.author,
      body: m.body,
      // Inbound media WhatsApp already stored. Nothing new is uploaded
      // anywhere: the only file store in this product is a PUBLIC bucket, and
      // a patient's attachment cannot live at a guessable public URL
      // (MESSAGES_PLAN.md §6, the same wall Tests hit in 0060).
      mediaUrl: m.media_url || null,
      deliveryStatus: m.delivery_status || null,
      deliveryError: m.delivery_error || null,
      at: m.created_at,
    })),
  };
}

/**
 * Say what a conversation was about.
 *
 * The ONLY write in phase 1, and it writes a label — never a word of what was
 * said. Clearing it back to "not labelled" is allowed: a pharmacist who
 * mislabelled a thread should be able to take the label off rather than leave
 * a wrong one standing.
 */
async function setConversationTopic(pharmacyId, customerId, conversationId, { topic }, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const [existing] = await tx`
      select id, topic from conversations
      where id = ${conversationId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
      for update
    `;
    if (!existing) {
      const err = new Error('Conversation not found.');
      err.status = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Nothing to do is decided BEFORE anything is written, so re-saving the
    // label a thread already has does not add a second identical line to the
    // patient's history (the lesson 0060 learned re-saving a finalised test).
    if ((existing.topic || null) === (topic || null)) {
      const [unchanged] = await tx`
        select ${tx.unsafe(CONVERSATION_SELECT)}, 0 as message_count,
               null as last_body, null as last_author, null as last_direction
        from conversations c where c.id = ${conversationId}
      `;
      return shapeConversation(unchanged);
    }

    // The moment of the change, held in JS so it can be BOTH the stored
    // stamp and the thing that makes this event unique — see below.
    const changedAt = new Date();

    const [updated] = await tx`
      update conversations
      set topic = ${topic},
          topic_set_at = ${topic ? changedAt : null},
          topic_set_by = ${topic ? (actor.actorId || null) : null}
      where id = ${conversationId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
      returning ${tx.unsafe(CONVERSATION_SELECT)}, 0 as message_count,
                null as last_body, null as last_author, null as last_direction
    `;

    await recordEvent(tx, {
      pharmacyId,
      customerId,
      eventType: PATIENT_EVENTS.CONVERSATION_TOPIC_SET,
      actorType: 'staff',
      actorId: actor.actorId || null,
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { from: existing.topic || null, to: topic || null },
      // WITHOUT THIS, A PATIENT'S SECOND RELABEL DISAPPEARS.
      // recordEvent's default key is eventType:entityType:entityId, which is
      // right when the entity itself is the uniqueness — a conversation is
      // started once. A topic is a judgement that can be revised, so the
      // default deduped the second change as "already recorded" and the
      // history showed one label change where two had happened. Found by the
      // test that asserts two changes leave two lines.
      //
      // A retried request cannot double-record: an identical retry that
      // already committed is caught by the no-op guard above, and one that
      // did not commit gets a new stamp and records exactly once.
      idempotencyKey: `CONVERSATION_TOPIC_SET:${conversationId}:${changedAt.toISOString()}`,
      // Staff activity about a patient's thread, not something the patient
      // did. The patient is never shown it.
      visibility: 'internal',
    });

    return shapeConversation(updated);
  });
}

/**
 * What this conversation was about — the records a pharmacist attached (§13).
 *
 * NOTHING CLINICAL IS READ OUT OF THIS TABLE. It holds a kind and an id;
 * `describeRecord` turns those into a label by reading the section that owns
 * the record. So a dose changed in Medications shows here on the next load,
 * and a conversation can never display a value that is no longer true.
 *
 * A record deleted from its own section keeps its link and says so, rather
 * than the row vanishing — which would lose that it was ever attached. The
 * same call care programmes made in their phase 2.
 */
async function conversationLinks(pharmacyId, customerId, conversationId, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();

  const rows = await db`
    select id, kind, ref_id, note, created_at
    from conversation_links
    where pharmacy_id = ${pharmacyId}
      and customer_id = ${customerId}
      and conversation_id = ${conversationId}
    order by created_at, id
  `;

  return Promise.all(rows.map(async (row) => {
    const found = await describeRecord(db, pharmacyId, customerId, row.kind, row.ref_id);
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: linkKindLabel(row.kind),
      refId: row.ref_id,
      note: row.note || null,
      at: row.created_at,
      // The record as its OWN section describes it today — or null, which the
      // screen says as "No longer on the record".
      record: found,
    };
  }));
}

/**
 * Attach a record to a conversation.
 *
 * `assertRecord` refuses an id that is not THIS patient's, in THIS pharmacy,
 * before anything is written — the check is the guarantee, because the target
 * is one of eight tables and cannot be a foreign key.
 */
async function addConversationLink(pharmacyId, customerId, conversationId, { kind, refId, note }, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const [conv] = await tx`
      select id from conversations
      where id = ${conversationId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    `;
    if (!conv) {
      const err = new Error('Conversation not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }

    await assertRecord(tx, pharmacyId, customerId, kind, refId, 'refId');

    await tx`
      insert into conversation_links (pharmacy_id, conversation_id, customer_id, kind, ref_id, note, created_by)
      values (${pharmacyId}, ${conversationId}, ${customerId}, ${kind}, ${refId}, ${note}, ${actor.actorId || null})
      on conflict (conversation_id, kind, ref_id) do nothing
    `;

    await recordEvent(tx, {
      pharmacyId,
      customerId,
      eventType: PATIENT_EVENTS.CONVERSATION_LINK_CHANGED,
      actorType: 'staff',
      actorId: actor.actorId || null,
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { action: 'attached', kind, refId },
      // Attaching the same record twice is one attachment, so the key carries
      // WHAT was attached rather than the clock — which would record a no-op.
      idempotencyKey: `CONVERSATION_LINK_ATTACHED:${conversationId}:${kind}:${refId}`,
      visibility: 'internal',
    });

    // Read back INSIDE the transaction. Care programmes' `addLink` returned a
    // read on a FRESH connection from inside its own transaction, so attaching
    // answered with the list as it was and the screen looked like it had done
    // nothing. Fixed there; not repeated here.
    return conversationLinks(pharmacyId, customerId, conversationId, { sql: tx });
  });
}

/**
 * Detach a record.
 *
 * Removes the LINK only. The condition, the reading or the follow-up stays
 * exactly where it is — this says the conversation was not about it after all,
 * not that it never happened.
 */
async function removeConversationLink(pharmacyId, customerId, conversationId, linkId, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const [gone] = await tx`
      delete from conversation_links
      where id = ${linkId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
        and conversation_id = ${conversationId}
      returning kind, ref_id
    `;
    if (!gone) {
      const err = new Error('That link is not on this conversation.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }

    await recordEvent(tx, {
      pharmacyId,
      customerId,
      eventType: PATIENT_EVENTS.CONVERSATION_LINK_CHANGED,
      actorType: 'staff',
      actorId: actor.actorId || null,
      entityType: 'conversation',
      entityId: conversationId,
      metadata: { action: 'detached', kind: gone.kind, refId: gone.ref_id },
      idempotencyKey: `CONVERSATION_LINK_DETACHED:${conversationId}:${gone.kind}:${gone.ref_id}:${Date.now()}`,
      visibility: 'internal',
    });

    return conversationLinks(pharmacyId, customerId, conversationId, { sql: tx });
  });
}

/**
 * This person has now read this conversation (§17).
 *
 * Called by a screen that has actually rendered the transcript, never as a
 * side effect of a GET — §17: "Do not automatically mark messages as read
 * before they are viewed." A GET that wrote here would also mark a thread read
 * for whoever happened to load a summary.
 *
 * A caller with no user id (the dev bypass) marks nothing rather than writing
 * a row keyed on a user that does not exist.
 */
async function markConversationRead(pharmacyId, customerId, conversationId, userId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [conv] = await db`
    select id from conversations
    where id = ${conversationId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
  `;
  if (!conv) {
    const err = new Error('Conversation not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  if (!userId) return { marked: false };

  await db`
    insert into conversation_read_marks (pharmacy_id, conversation_id, user_id, last_read_at)
    values (${pharmacyId}, ${conversationId}, ${userId}, now())
    on conflict (conversation_id, user_id) do update set last_read_at = now()
  `;
  return { marked: true };
}

/**
 * What the patient summary and the clinical context show (§28).
 *
 * The SAME read the section uses, trimmed — so the card, any brief and the
 * Messages tab cannot disagree about whether somebody is waiting for an
 * answer. The pattern care programmes and follow-ups both settled on.
 */
async function messagesSummary(pharmacyId, customerId, { userId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const { counts, lastContactAt, conversations } = await listPatientConversations(
    pharmacyId, customerId, { filter: 'all', userId },
  );
  return {
    counts,
    lastContactAt,
    // The open thread, if there is one. At most one exists by construction.
    open: conversations.find((c) => c.status === 'open') || null,
  };
}

/**
 * Start an internal thread about this patient (§14, 0066).
 *
 * THE FIRST THING IN MESSAGES THAT CREATES A CONVERSATION — and it is allowed
 * to, where starting a patient conversation is not, because an internal thread
 * never leaves the pharmacy. Starting one is not outreach.
 *
 * It cannot collide with the patient's WhatsApp thread: `idx_conversations_one_open`
 * now applies `where status = 'open' and channel = 'whatsapp'` (0066), so a
 * patient may have one open WhatsApp thread and any number of internal ones.
 * That is a narrowing of where the rule applies, never a weakening of it.
 *
 * `mode = 'human'` is not decoration. The worker takes up threads whose mode
 * is 'bot', so an internal thread in bot mode is one the assistant would try
 * to answer — and 0066's CHECK refuses to store one.
 */
async function createInternalThread(pharmacyId, customerId, { subject, note, topic }, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    // The patient must be this pharmacy's. An internal thread is ABOUT
    // somebody, and it must not be about somebody else's patient.
    const [customer] = await tx`
      select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
    `;
    if (!customer) {
      const err = new Error('Patient not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }

    const [conv] = await tx`
      insert into conversations
        (pharmacy_id, customer_id, channel, status, workflow_state, mode, topic,
         topic_set_at, topic_set_by, summary, last_message_at)
      values
        (${pharmacyId}, ${customerId}, 'internal', 'open', 'open', 'human', ${topic},
         ${topic ? tx`now()` : null}, ${topic ? (actor.actorId || null) : null},
         ${subject}, now())
      returning ${tx.unsafe(CONVERSATION_SELECT)}, 0 as message_count, 0 as unread,
                null as last_body, null as last_author, null as last_direction
    `;

    await insertInternalNote(tx, pharmacyId, conv.id, note, actor);

    await recordEvent(tx, {
      pharmacyId,
      customerId,
      eventType: PATIENT_EVENTS.INTERNAL_THREAD_STARTED,
      actorType: 'staff',
      actorId: actor.actorId || null,
      entityType: 'conversation',
      entityId: conv.id,
      // The SUBJECT, never the note. An internal note is staff-to-staff and
      // belongs in the thread, not spread across the patient's event log.
      metadata: { subject },
      visibility: 'internal',
      // The entity was created in this same transaction.
      verifyEntity: false,
    });

    return shapeConversation({ ...conv, summary: subject });
  });
}

/**
 * The insert for an internal note, shared by creating a thread and adding to
 * one.
 *
 * `direction = 'internal'` because the note travelled neither to nor from the
 * patient, and recording it as 'outbound' would make it indistinguishable — in
 * the one column that answers "did this go to the patient" — from a message
 * that did. 0066's CHECK then guarantees it carries no provider id, no
 * delivery status and no category: there is nowhere to record it as sent.
 */
async function insertInternalNote(tx, pharmacyId, conversationId, note, actor) {
  const [row] = await tx`
    insert into messages
      (pharmacy_id, conversation_id, direction, author, author_user_id, body)
    values
      (${pharmacyId}, ${conversationId}, 'internal', 'staff', ${actor.actorId || null}, ${note})
    returning id, created_at
  `;
  await tx`
    update conversations set last_message_at = now() where id = ${conversationId}
  `;
  return row;
}

/**
 * Add a note to an internal thread.
 *
 * Refuses a patient-facing conversation outright. Writing an internal note
 * into a WhatsApp thread would put it in the transcript the patient's own
 * history is built from, and — worse — in the range the assistant loads as
 * conversation history when it next replies.
 */
async function addInternalNote(pharmacyId, customerId, conversationId, { note }, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const [conv] = await tx`
      select id, channel, status from conversations
      where id = ${conversationId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
      for update
    `;
    if (!conv) {
      const err = new Error('Conversation not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    if (conv.channel !== 'internal') {
      const err = new Error('That is a conversation with the patient. Notes can only be added to an internal thread.');
      err.status = 400;
      err.code = 'NOT_INTERNAL';
      throw err;
    }

    await insertInternalNote(tx, pharmacyId, conversationId, note, actor);
    return getInternalThread(pharmacyId, customerId, conversationId, { sql: tx, userId: actor.actorId || null });
  });
}

/** One internal thread and its notes. Shares the transcript read. */
async function getInternalThread(pharmacyId, customerId, conversationId, { sql = null, userId = null } = {}) {
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(CONVERSATION_SELECT)},
      (select count(*)::int from messages m
        where m.conversation_id = c.id and m.pharmacy_id = ${pharmacyId}) as message_count,
      0 as unread, null as last_body, null as last_author, null as last_direction
    from conversations c
    where c.id = ${conversationId}
      and c.pharmacy_id = ${pharmacyId}
      and c.customer_id = ${customerId}
      and c.channel = 'internal'
  `;
  if (!row) return null;

  const notes = await db`
    select m.id, m.body, m.created_at, m.author_user_id, u.email as author_email
    from messages m
    left join auth.users u on u.id = m.author_user_id
    where m.conversation_id = ${conversationId}
      and m.pharmacy_id = ${pharmacyId}
      and m.direction = 'internal'
    order by m.id asc
  `;

  return {
    conversation: shapeConversation(row),
    notes: notes.map((n) => ({
      id: String(n.id),
      body: n.body,
      at: n.created_at,
      // Who wrote it. Colleagues read this, so "who said it" is the point —
      // unlike a patient-facing message, where 'staff' is all the patient
      // needs to know.
      authorId: n.author_user_id || null,
      authorEmail: n.author_email || null,
      mine: Boolean(userId && n.author_user_id === userId),
    })),
  };
}

module.exports = {
  listPatientConversations,
  getPatientConversation,
  setConversationTopic,
  conversationLinks,
  addConversationLink,
  removeConversationLink,
  markConversationRead,
  createInternalThread,
  addInternalNote,
  getInternalThread,
  messagesSummary,
};
