/**
 * The patient's Messages section against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a conversation belongs to a pharmacy AND to a
 * patient, and naming its id must not be enough to read it (GOLDEN-001).
 * That matters more here than anywhere else in the record, because a
 * transcript is the most directly personal thing this product stores — it is
 * what somebody actually said.
 *
 * Then what this section exists to get right:
 *   - It is a VIEW. It creates no conversation, sends no message, copies no
 *     message body anywhere (§36 of the brief).
 *   - A patient has at most ONE open thread; the rest are history. The Active
 *     list showing two would mean the invariant that dropped 16 live messages
 *     had been broken again (0025, and AGENTS.md's conversationPolicy entry).
 *   - Archiving never deletes: a closed thread is still readable (§19).
 *   - Delivery status is what the provider reported, and nothing else (§8).
 *   - `author` keeps the assistant and the pharmacist apart (§11).
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the patient Messages section was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'msgtest';

let db;
let messages;
let ctx = null;

const { readTopicInput } = require('../services/messaging/messageInput');

let phone = 2349070000000;
async function patient(pharmacyId, name = 'Messages Tester') {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, ${name}, ${name})
    returning id
  `;
  return c.id;
}

/**
 * A conversation, written the way the ingest writes one.
 *
 * Deliberately through the TABLE rather than through a service: this suite is
 * about reading what WhatsApp actually put there, and a helper that went
 * through the ingest would be testing the ingest.
 */
async function conversation(pharmacyId, customerId, { status = 'open', workflowState = null, topic = null, at = null } = {}) {
  // 0024's CHECK: an open thread is open/ai_handling/waiting_for_*, and a
  // closed one is resolved or archived. The default follows the status rather
  // than forcing every caller to remember — the constraint caught this on the
  // first run, which is the constraint doing its job.
  const state = workflowState || (status === 'closed' ? 'resolved' : 'open');
  const [c] = await db`
    insert into conversations (pharmacy_id, customer_id, status, workflow_state, topic, last_message_at, closed_at)
    values (${pharmacyId}, ${customerId}, ${status}, ${state}, ${topic},
            ${at || new Date()}, ${status === 'closed' ? new Date() : null})
    returning id
  `;
  return c.id;
}

async function message(pharmacyId, conversationId, { direction = 'inbound', author = 'customer', body = 'hello', status = null } = {}) {
  const [m] = await db`
    insert into messages (pharmacy_id, conversation_id, direction, author, body, delivery_status)
    values (${pharmacyId}, ${conversationId}, ${direction}, ${author}, ${body}, ${status})
    returning id
  `;
  return m.id;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  messages = require('../services/messaging/patientMessages');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  // A second reader in pharmacy A. Unread is per person, and that cannot
  // be tested with only one person.
  const staffA = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}),
    (${userB}, ${`${TAG}-b-${userB}@example.test`}),
    (${staffA}, ${`${TAG}-s-${staffA}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });
  ctx = { a, b, userA, userB, staffA };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ---------------------------------------------------

test('pharmacy B cannot read, open or relabel a conversation of pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { body: 'I need a refill of my metformin.' });

  const asB = await messages.listPatientConversations(ctx.b.id, p, { filter: 'all' });
  assert.deepEqual(asB.conversations, []);
  assert.equal(asB.counts.all, 0);
  assert.equal(asB.lastContactAt, null);

  // Naming the id is not enough. A transcript is the most personal thing here.
  assert.equal(await messages.getPatientConversation(ctx.b.id, p, conv), null);

  await assert.rejects(
    () => messages.setConversationTopic(ctx.b.id, p, conv, readTopicInput({ topic: 'medication' }), { actorId: ctx.userB }),
    (e) => e.status === 404,
  );

  // And the label really did not change.
  const [row] = await db`select topic from conversations where id = ${conv}`;
  assert.equal(row.topic, null);
});

test('another patient in the SAME pharmacy is refused too', { skip: SKIP && skipReason }, async () => {
  // The tenant boundary is not the only boundary. Two patients of one
  // pharmacy are two people, and a conversation id pasted into the wrong
  // patient's URL must not open their transcript.
  const p1 = await patient(ctx.a.id, 'Patient One');
  const p2 = await patient(ctx.a.id, 'Patient Two');
  const conv = await conversation(ctx.a.id, p1);
  await message(ctx.a.id, conv, { body: 'Something private.' });

  assert.equal(await messages.getPatientConversation(ctx.a.id, p2, conv), null);
  const asP2 = await messages.listPatientConversations(ctx.a.id, p2, { filter: 'all' });
  assert.deepEqual(asP2.conversations, []);
});

// ---- what the section is ---------------------------------------------------

test('a patient has at most ONE active thread, and the rest is history', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const older = await conversation(ctx.a.id, p, { status: 'closed', workflowState: 'resolved', at: new Date('2026-09-01T10:00:00Z') });
  const old = await conversation(ctx.a.id, p, { status: 'closed', workflowState: 'archived', at: new Date('2026-09-10T10:00:00Z') });
  const open = await conversation(ctx.a.id, p, { status: 'open', at: new Date('2026-09-20T10:00:00Z') });

  const active = await messages.listPatientConversations(ctx.a.id, p, { filter: 'active' });
  assert.equal(active.conversations.length, 1, 'the one-open invariant, seen from the screen');
  assert.equal(active.conversations[0].id, open);

  const archived = await messages.listPatientConversations(ctx.a.id, p, { filter: 'archived' });
  assert.deepEqual(archived.conversations.map((c) => c.id), [old, older], 'newest first');

  // The counts are of the PATIENT's threads, not of the filtered list — an
  // empty Active list must not read as "never spoken to".
  // Still an EXACT shape, not a relaxed one: phase 2 added unread (0064), so
  // the object gained two keys and the assertion gained them too. The rule
  // this pins — the counts describe the patient, not the filtered list — is
  // unchanged, and nobody has read this thread, so both are 0.
  assert.deepEqual(active.counts, {
    all: 3, active: 1, archived: 2, awaitingPharmacist: 0, unread: 0, unreadConversations: 0,
  });
  assert.equal(archived.counts.all, 3);
});

test('archiving a thread never loses what was said in it', { skip: SKIP && skipReason }, async () => {
  // §19: do not delete communication history simply because a conversation is
  // no longer active.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p, { status: 'closed', workflowState: 'archived' });
  await message(ctx.a.id, conv, { body: 'Thank you, I will come tomorrow.' });

  const found = await messages.getPatientConversation(ctx.a.id, p, conv);
  assert.equal(found.conversation.status, 'closed');
  assert.equal(found.messages.length, 1);
  assert.equal(found.messages[0].body, 'Thank you, I will come tomorrow.');
});

test('the transcript keeps the patient, the assistant and the pharmacist apart', { skip: SKIP && skipReason }, async () => {
  // §11: "Do not make the AI appear to be a pharmacist." The data has carried
  // this since 0001; the read must not flatten it.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'I need to refill my metformin.' });
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'assistant', body: 'Let me check the pharmacy information.' });
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'staff', body: 'Your refill is ready for pickup.' });
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'system', body: 'Handed to a pharmacist.' });

  const { messages: list } = await messages.getPatientConversation(ctx.a.id, p, conv);
  assert.deepEqual(list.map((m) => m.author), ['customer', 'assistant', 'staff', 'system']);
  // Oldest first: a conversation read bottom-up is a conversation misread.
  assert.equal(list[0].body, 'I need to refill my metformin.');
  assert.equal(list.at(-1).author, 'system');
});

test('a delivery state is what the provider said, and an unknown one is not "sent"', { skip: SKIP && skipReason }, async () => {
  // §8 and §34: a message that may never have arrived must not look like one
  // that did. The honest answer for an outbound message whose status never
  // came back is null, and the screen says nothing rather than "Sent".
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'staff', body: 'Delivered one', status: 'delivered' });
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'staff', body: 'Failed one', status: 'failed' });
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'staff', body: 'Unknown one', status: null });
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'Mine has no status' });

  const { messages: list } = await messages.getPatientConversation(ctx.a.id, p, conv);
  assert.deepEqual(list.map((m) => m.deliveryStatus), ['delivered', 'failed', null, null]);
});

test('a thread waiting on a pharmacist is visible as exactly that', { skip: SKIP && skipReason }, async () => {
  // The one thing on this screen that means somebody is waiting for an answer
  // right now. design.md reserves red for it; the read has to carry it first.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p, { workflowState: 'waiting_for_pharmacist' });

  const { conversations, counts } = await messages.listPatientConversations(ctx.a.id, p, { filter: 'active' });
  assert.equal(conversations[0].id, conv);
  assert.equal(conversations[0].awaitingPharmacist, true);
  assert.equal(counts.awaitingPharmacist, 1);
});

// ---- the topic ------------------------------------------------------------

test('a conversation nobody has labelled says so, and is never called "general"', { skip: SKIP && skipReason }, async () => {
  // Every conversation older than 0063 arrived before topics existed. A
  // default would be this system inventing an answer about thousands of real
  // threads — the "None" on an allergy card nobody was asked about (0058).
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);

  const { conversations } = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all' });
  assert.equal(conversations[0].topic, null);
  assert.equal(conversations[0].topicLabel, null);

  const labelled = await messages.setConversationTopic(
    ctx.a.id, p, conv, readTopicInput({ topic: 'medication_review' }), { actorId: ctx.userA },
  );
  assert.equal(labelled.topic, 'medication_review');
  assert.equal(labelled.topicLabel, 'Medication review');
  assert.ok(labelled.topicSetAt, 'a judgement carries when it was made');

  // And it can be taken off again, back to "nobody has said".
  const cleared = await messages.setConversationTopic(
    ctx.a.id, p, conv, readTopicInput({ topic: null }), { actorId: ctx.userA },
  );
  assert.equal(cleared.topic, null);
  assert.equal(cleared.topicSetAt, null);
});

test('relabelling is on the patient\'s history, and re-saving the same label adds nothing', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);

  await messages.setConversationTopic(ctx.a.id, p, conv, readTopicInput({ topic: 'medication' }), { actorId: ctx.userA });
  await messages.setConversationTopic(ctx.a.id, p, conv, readTopicInput({ topic: 'billing' }), { actorId: ctx.userA });
  // Nothing to do is decided before anything is written (the lesson 0060
  // learned re-saving a finalised test report unchanged).
  await messages.setConversationTopic(ctx.a.id, p, conv, readTopicInput({ topic: 'billing' }), { actorId: ctx.userA });

  const events = await db`
    select metadata, visibility, actor_type, entity_type
    from customer_events
    where customer_id = ${p} and event_type = 'CONVERSATION_TOPIC_SET'
    order by occurred_at, id
  `;
  assert.equal(events.length, 2, 'two real changes, not three');
  assert.deepEqual(events[0].metadata, { from: null, to: 'medication' });
  assert.deepEqual(events[1].metadata, { from: 'medication', to: 'billing' });
  assert.equal(events[0].entity_type, 'conversation');
  // Staff activity about a patient's thread — never shown to the patient.
  assert.equal(events[0].visibility, 'internal');
});

// ---- filtering and search -------------------------------------------------

test('the topic filter narrows to that topic, and search reads what was actually said', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const meds = await conversation(ctx.a.id, p, { status: 'closed', topic: 'medication', at: new Date('2026-09-05T10:00:00Z') });
  const bill = await conversation(ctx.a.id, p, { status: 'closed', topic: 'billing', at: new Date('2026-09-06T10:00:00Z') });
  await message(ctx.a.id, meds, { body: 'I am having some dizziness.' });
  await message(ctx.a.id, bill, { body: 'How much do I owe?' });

  const byTopic = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', topic: 'medication' });
  assert.deepEqual(byTopic.conversations.map((c) => c.id), [meds]);

  const bySearch = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', q: 'dizziness' });
  assert.deepEqual(bySearch.conversations.map((c) => c.id), [meds]);

  // A search that matches nothing returns nothing — not everything.
  const none = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', q: 'penicillin' });
  assert.deepEqual(none.conversations, []);
  // ...while the counts still tell the truth about the patient.
  assert.equal(none.counts.all, 2);
});

test('search cannot reach another patient\'s messages', { skip: SKIP && skipReason }, async () => {
  // A search box is the easiest place in any product to lose a WHERE clause.
  const p1 = await patient(ctx.a.id);
  const p2 = await patient(ctx.a.id);
  const c1 = await conversation(ctx.a.id, p1, { status: 'closed' });
  await message(ctx.a.id, c1, { body: 'a very distinctive phrase zzyzx' });

  const asP2 = await messages.listPatientConversations(ctx.a.id, p2, { filter: 'all', q: 'zzyzx' });
  assert.deepEqual(asP2.conversations, []);
});

// ---- what other screens show ----------------------------------------------

test('the summary other screens show agrees with the section itself', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await conversation(ctx.a.id, p, { status: 'closed', at: new Date('2026-09-01T10:00:00Z') });
  const open = await conversation(ctx.a.id, p, { workflowState: 'waiting_for_pharmacist', at: new Date('2026-09-22T14:30:00Z') });

  const summary = await messages.messagesSummary(ctx.a.id, p);
  const section = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all' });

  assert.deepEqual(summary.counts, section.counts);
  assert.equal(summary.open.id, open, 'the one open thread, which is all there can be');
  assert.equal(summary.open.awaitingPharmacist, true);
  assert.equal(String(summary.lastContactAt), String(section.lastContactAt));

  // A patient who has never been messaged has no last contact — not today's
  // date, and not the day their record was created.
  const fresh = await patient(ctx.a.id);
  const empty = await messages.messagesSummary(ctx.a.id, fresh);
  assert.equal(empty.lastContactAt, null);
  assert.equal(empty.open, null);
  assert.equal(empty.counts.all, 0);
});

// ---- the boundary this module must not cross -------------------------------

test('reading a patient\'s messages creates nothing and sends nothing', { skip: SKIP && skipReason }, async () => {
  // §36: one message store. This section is a VIEW — if opening a patient's
  // Messages tab can write a conversation or a message row, then the screen
  // has become a second source of what was said.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { body: 'Only this one.' });

  const before = await db`
    select (select count(*)::int from conversations where customer_id = ${p}) as convs,
           (select count(*)::int from messages where conversation_id = ${conv}) as msgs
  `;
  await messages.listPatientConversations(ctx.a.id, p, { filter: 'all' });
  await messages.getPatientConversation(ctx.a.id, p, conv);
  await messages.messagesSummary(ctx.a.id, p);
  const after = await db`
    select (select count(*)::int from conversations where customer_id = ${p}) as convs,
           (select count(*)::int from messages where conversation_id = ${conv}) as msgs
  `;
  assert.deepEqual(after[0], before[0]);

  // And the module exports no way to SEND. The one send path is
  // routes/conversations.js; a second one is what §36 forbids.
  assert.deepEqual(
    Object.keys(messages).filter((k) => /send|reply/i.test(k)),
    [],
  );

  // Phase 3 (0066) added the one thing here that creates a conversation, and
  // the assertion was tightened rather than relaxed: it must be the INTERNAL
  // one and nothing else. An export that created a patient-facing thread
  // would be outreach, which this product does not do.
  assert.deepEqual(
    Object.keys(messages).filter((k) => /create|start/i.test(k)),
    ['createInternalThread'],
  );
});

// ---- phase 2: the clinical context (§13) ----------------------------------

test('a link points at a record and is DESCRIBED from the section that owns it', { skip: SKIP && skipReason }, async () => {
  // §13: "Do NOT duplicate those clinical records inside Messages. Store
  // references to them." The proof is that the link row holds no clinical
  // value at all — the label comes from Vitals, on every read.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic, diastolic)
    values (${ctx.a.id}, ${p}, now(), 148, 92) returning id`;

  const links = await messages.addConversationLink(
    ctx.a.id, p, conv, { kind: 'vitals', refId: v.id, note: 'She asked about this reading' },
    { actorId: ctx.userA },
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'vitals');
  assert.equal(links[0].refId, v.id);
  assert.ok(links[0].record, 'the record is described, not copied');

  // The invariant, stated structurally rather than by hunting for '148' in
  // the row — a uuid contains three-digit runs by chance, so that version
  // both failed spuriously and proved nothing. This is the shape care
  // programmes' phase 2 used: the table has nowhere to PUT a clinical value.
  const cols = (await db`
    select column_name from information_schema.columns
    where table_name = 'conversation_links'
  `).map((c) => c.column_name).sort();
  assert.ok(cols.length > 0, 'the table was not found — this assertion would pass on nothing');
  assert.deepEqual(cols, [
    'conversation_id', 'created_at', 'created_by', 'customer_id',
    'id', 'kind', 'note', 'pharmacy_id', 'ref_id',
  ], 'conversation_links grew a column that could hold what a record says');
});

test('pharmacy B cannot attach to, or read the links of, a conversation of ours', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic)
    values (${ctx.a.id}, ${p}, now(), 130) returning id`;

  await assert.rejects(
    () => messages.addConversationLink(ctx.b.id, p, conv, { kind: 'vitals', refId: v.id, note: null }, { actorId: ctx.userB }),
    (e) => e.status === 404,
  );
  assert.deepEqual(await messages.conversationLinks(ctx.b.id, p, conv), []);
});

test('only the records of THIS patient can be attached', { skip: SKIP && skipReason }, async () => {
  // The tenant boundary is not the only one. Attaching another patient's
  // reading would put one person's blood pressure on another person's thread.
  const p1 = await patient(ctx.a.id);
  const p2 = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p1);
  const [theirs] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic)
    values (${ctx.a.id}, ${p2}, now(), 120) returning id`;

  await assert.rejects(
    () => messages.addConversationLink(ctx.a.id, p1, conv, { kind: 'vitals', refId: theirs.id, note: null }, { actorId: ctx.userA }),
    (e) => { assert.equal(e.status, 400); assert.equal(e.code, 'INVALID_REFERENCE'); return true; },
  );
  assert.deepEqual(await messages.conversationLinks(ctx.a.id, p1, conv), []);
});

test('a record deleted from its own section leaves the link SAYING so', { skip: SKIP && skipReason }, async () => {
  // The row vanishing would lose that it was ever attached. The same call
  // care programmes made: the link stays and reports no record.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic)
    values (${ctx.a.id}, ${p}, now(), 150) returning id`;
  await messages.addConversationLink(ctx.a.id, p, conv, { kind: 'vitals', refId: v.id, note: null }, { actorId: ctx.userA });

  await db`delete from patient_vitals where id = ${v.id}`;

  const links = await messages.conversationLinks(ctx.a.id, p, conv);
  assert.equal(links.length, 1, 'the link is kept');
  assert.equal(links[0].record, null, 'and it reports that the record is gone');
  assert.equal(links[0].kind, 'vitals');
});

test('detaching removes the LINK and never the record', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic)
    values (${ctx.a.id}, ${p}, now(), 142) returning id`;

  const added = await messages.addConversationLink(ctx.a.id, p, conv, { kind: 'vitals', refId: v.id, note: null }, { actorId: ctx.userA });
  // Attaching the same record twice is ONE attachment.
  const again = await messages.addConversationLink(ctx.a.id, p, conv, { kind: 'vitals', refId: v.id, note: null }, { actorId: ctx.userA });
  assert.equal(again.length, 1);

  const left = await messages.removeConversationLink(ctx.a.id, p, conv, added[0].id, { actorId: ctx.userA });
  assert.deepEqual(left, []);

  const [still] = await db`select id from patient_vitals where id = ${v.id}`;
  assert.ok(still, 'the reading is still on the record — only the link went');

  // Detaching a link that is not on this conversation is a 404, not a no-op.
  await assert.rejects(
    () => messages.removeConversationLink(ctx.a.id, p, conv, added[0].id, { actorId: ctx.userA }),
    (e) => e.status === 404,
  );
});

test('attaching and detaching are on the history, and stay internal', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic)
    values (${ctx.a.id}, ${p}, now(), 138) returning id`;

  const added = await messages.addConversationLink(ctx.a.id, p, conv, { kind: 'vitals', refId: v.id, note: null }, { actorId: ctx.userA });
  await messages.removeConversationLink(ctx.a.id, p, conv, added[0].id, { actorId: ctx.userA });

  const events = await db`
    select metadata, visibility from customer_events
    where customer_id = ${p} and event_type = 'CONVERSATION_LINK_CHANGED'
    order by occurred_at, id`;
  assert.equal(events.length, 2);
  assert.equal(events[0].metadata.action, 'attached');
  assert.equal(events[1].metadata.action, 'detached');
  // A pointer, never a copy — the event says WHICH record, not what it says.
  assert.equal(events[0].metadata.kind, 'vitals');
  assert.ok(!JSON.stringify(events[0].metadata).includes('138'));
  for (const e of events) assert.equal(e.visibility, 'internal');
});

// §23: a message can RESULT in a follow-up. Nothing creates one automatically;
// this proves the pointer works once a pharmacist has pressed the button.
test('a follow-up can be raised FROM a conversation, and points back at it', { skip: SKIP && skipReason }, async () => {
  const followups = require('../services/clinical/followups');
  const { readFollowupInput } = require('../services/clinical/followupInput');

  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);

  const f = await followups.createFollowup(ctx.a.id, p, readFollowupInput({
    title: 'Repeat blood pressure',
    dueOn: '2026-10-02',
    sourceType: 'conversation',
    sourceId: conv,
  }), { actorId: ctx.userA, actorRole: 'pharmacist' });

  assert.equal(f.sourceType, 'conversation');
  assert.equal(f.sourceId, conv);

  // A conversation of ANOTHER patient is refused as the source — the same
  // check every other source kind gets.
  const other = await patient(ctx.a.id);
  const theirs = await conversation(ctx.a.id, other);
  await assert.rejects(
    () => followups.createFollowup(ctx.a.id, p, readFollowupInput({
      title: 'Wrong thread', sourceType: 'conversation', sourceId: theirs,
    }), { actorId: ctx.userA, actorRole: 'pharmacist' }),
    (e) => e.status === 400,
  );

  // The follow-up can then be attached to the thread it came from, and is
  // described by the follow-up queue rather than copied.
  const links = await messages.addConversationLink(
    ctx.a.id, p, conv, { kind: 'followup', refId: f.id, note: null }, { actorId: ctx.userA },
  );
  assert.equal(links[0].record.label, 'Repeat blood pressure');
});

// ---- phase 2: unread, per person (§17) ------------------------------------

test('unread is PER READER: one pharmacist opening a thread does not clear it for another', { skip: SKIP && skipReason }, async () => {
  // A flag on the message would mean the first person to look clears the
  // badge for the colleague who was about to answer — and that colleague
  // never learns the patient was waiting.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'Are my tablets ready?' });
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'Hello?' });
  await message(ctx.a.id, conv, { direction: 'outbound', author: 'staff', body: 'Checking now.' });

  // Nobody has read it: every INBOUND message is unread for both of them. An
  // outbound message is not unread — we sent it.
  const forA = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  assert.equal(forA.counts.unread, 2);
  assert.equal(forA.counts.unreadConversations, 1);
  assert.equal(forA.conversations[0].unread, 2);

  await messages.markConversationRead(ctx.a.id, p, conv, ctx.userA);

  const afterA = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  assert.equal(afterA.counts.unread, 0);
  assert.equal(afterA.conversations[0].unread, 0);

  // The other pharmacist's badge is untouched.
  const forStaff = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.staffA });
  assert.equal(forStaff.counts.unread, 2);

  // A new inbound message becomes unread again for the person who had read it.
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'Still waiting.' });
  const againA = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  assert.equal(againA.counts.unread, 1);
});

test('nothing is marked read by merely reading it', { skip: SKIP && skipReason }, async () => {
  // §17: "Do not automatically mark messages as read before they are viewed."
  // Listing, opening the transcript and loading the summary must all leave
  // the mark alone — only an explicit call writes one.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'Anyone there?' });

  await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  await messages.getPatientConversation(ctx.a.id, p, conv, { userId: ctx.userA });
  await messages.messagesSummary(ctx.a.id, p, { userId: ctx.userA });

  const marks = await db`select * from conversation_read_marks where conversation_id = ${conv}`;
  assert.equal(marks.length, 0, 'a read wrote a read mark');

  const still = await messages.getPatientConversation(ctx.a.id, p, conv, { userId: ctx.userA });
  assert.equal(still.conversation.unread, 1);
});

test('a reader we cannot identify gets no unread rather than somebody elses', { skip: SKIP && skipReason }, async () => {
  // Unread is a relationship between a message and a READER. With no reader,
  // the honest answer is zero — never the pharmacy-wide count, which would be
  // the per-pharmacy behaviour this deliberately is not.
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p);
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'Hello' });

  const anon = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all' });
  assert.equal(anon.counts.unread, 0);
  assert.equal(anon.conversations[0].unread, 0);

  assert.deepEqual(await messages.markConversationRead(ctx.a.id, p, conv, null), { marked: false });
  assert.equal((await db`select * from conversation_read_marks where conversation_id = ${conv}`).length, 0);

  // A conversation that is not this patient's is still a 404, reader or not.
  const other = await patient(ctx.a.id);
  await assert.rejects(
    () => messages.markConversationRead(ctx.a.id, other, conv, ctx.userA),
    (e) => e.status === 404,
  );
});

test('the summary other screens show carries the unread of THIS reader', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const conv = await conversation(ctx.a.id, p, { workflowState: 'waiting_for_pharmacist' });
  await message(ctx.a.id, conv, { direction: 'inbound', author: 'customer', body: 'I have a question.' });

  const summary = await messages.messagesSummary(ctx.a.id, p, { userId: ctx.userA });
  const section = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  assert.deepEqual(summary.counts, section.counts);
  assert.equal(summary.counts.unread, 1);
  assert.equal(summary.open.awaitingPharmacist, true);
});

test('the transcript carries the links of THAT conversation and not another', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const one = await conversation(ctx.a.id, p, { status: 'closed' });
  const two = await conversation(ctx.a.id, p);
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic)
    values (${ctx.a.id}, ${p}, now(), 134) returning id`;
  await messages.addConversationLink(ctx.a.id, p, one, { kind: 'vitals', refId: v.id, note: null }, { actorId: ctx.userA });

  const first = await messages.getPatientConversation(ctx.a.id, p, one, { userId: ctx.userA });
  const second = await messages.getPatientConversation(ctx.a.id, p, two, { userId: ctx.userA });
  assert.equal(first.links.length, 1);
  assert.deepEqual(second.links, [], 'a transcript showing another thread links is showing the wrong record');
});

// ---- phase 3: internal threads (§14, 0066) --------------------------------

test('an internal thread does not collide with the patient\'s open WhatsApp thread', { skip: SKIP && skipReason }, async () => {
  // 0066 narrowed idx_conversations_one_open to `channel = 'whatsapp'`. The
  // narrowing has to work BOTH ways, and the second half is the one that
  // dropped 16 live messages when it was got wrong (0025).
  const p = await patient(ctx.a.id);
  await conversation(ctx.a.id, p, { status: 'open' });

  const one = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Dose query', note: 'Prescriber wrote 10mg; pack is 5mg.', topic: null },
    { actorId: ctx.userA });
  const two = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Ring the prescriber', note: 'No answer at 10am.', topic: null },
    { actorId: ctx.userA });
  assert.ok(one.id && two.id, 'a patient may have several open internal threads');
  assert.equal(one.channel, 'internal');
  assert.equal(one.subject, 'Dose query');

  // AND the WhatsApp invariant still holds, unchanged. A second open
  // patient-facing thread is still refused by the index.
  await assert.rejects(
    () => db`
      insert into conversations (pharmacy_id, customer_id, status, workflow_state, last_message_at)
      values (${ctx.a.id}, ${p}, 'open', 'open', now())
    `,
    (e) => e.code === '23505',
  );
});

test('an internal thread NEVER appears in the patient\'s own communication history', { skip: SKIP && skipReason }, async () => {
  // §14: the distinction must be obvious. The strongest form of obvious is
  // that a patient-facing read cannot return one at all.
  const p = await patient(ctx.a.id);
  const theirs = await conversation(ctx.a.id, p);
  await message(ctx.a.id, theirs, { body: 'Are my tablets ready?' });
  const internal = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Check the interaction', note: 'Warfarin plus the new NSAID.', topic: null },
    { actorId: ctx.userA });

  const patientFacing = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all' });
  assert.deepEqual(patientFacing.conversations.map((c) => c.id), [theirs]);
  // ...and the counts that feed the summary card are about the patient too.
  assert.equal(patientFacing.counts.all, 1);
  // The internal ones are counted separately, so a screen can badge them
  // without mixing them in.
  assert.equal(patientFacing.internal.threads, 1);

  // The transcript read refuses it outright — nothing that renders a patient
  // conversation can be handed an internal thread by mistake.
  assert.equal(await messages.getPatientConversation(ctx.a.id, p, internal.id), null);

  // Asking for internal explicitly is how you see them.
  const internalList = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', channel: 'internal' });
  assert.deepEqual(internalList.conversations.map((c) => c.id), [internal.id]);
});

// THE ONE THAT MATTERS. GOLDEN-007 asserts the guard exists and runs first;
// this proves it actually refuses, against a real row.
test('the send path REFUSES an internal thread, and an unknown one', { skip: SKIP && skipReason }, async () => {
  const { sendAndRecordOutbound } = require('../services/whatsapp/outboundMessage');
  const { CATEGORIES } = require('../services/whatsapp/communicationPolicy');

  const p = await patient(ctx.a.id);
  const internal = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Private', note: 'Do not tell the patient this.', topic: null },
    { actorId: ctx.userA });

  await assert.rejects(
    () => sendAndRecordOutbound(db, {
      pharmacyId: ctx.a.id, customerId: p, conversationId: internal.id,
      accountId: crypto.randomUUID(), to: '2348000000001@s.whatsapp.net',
      body: 'Do not tell the patient this.', author: 'staff', delay: false,
      category: CATEGORIES.TRANSACTIONAL,
    }),
    (e) => {
      assert.equal(e.code, 'INTERNAL_THREAD');
      assert.ok(e.blocked, 'a refused send must be marked blocked, like a consent refusal');
      return true;
    },
  );

  // Fails CLOSED on a conversation it cannot find — "we could not find it" is
  // not "it is safe to send" (GOLDEN-002c's lesson).
  await assert.rejects(
    () => sendAndRecordOutbound(db, {
      pharmacyId: ctx.a.id, customerId: p, conversationId: crypto.randomUUID(),
      accountId: crypto.randomUUID(), to: '2348000000001@s.whatsapp.net',
      body: 'Anything', author: 'staff', delay: false, category: CATEGORIES.TRANSACTIONAL,
    }),
    (e) => e.code === 'INTERNAL_THREAD',
  );

  // Nothing was written, and above all nothing was sent: no outbound row for
  // the internal thread exists.
  const sent = await db`
    select count(*)::int as n from messages
    where conversation_id = ${internal.id} and direction <> 'internal'
  `;
  assert.equal(sent[0].n, 0);
});

test('the database has nowhere to record an internal note as having been sent', { skip: SKIP && skipReason }, async () => {
  // The schema half of GOLDEN-007, proven against the real constraint. Even
  // with every guard in JavaScript deleted, this is a failed transaction
  // rather than a message on a patient's phone.
  const p = await patient(ctx.a.id);
  const internal = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Private', note: 'Internal only.', topic: null }, { actorId: ctx.userA });

  for (const [column, value] of [
    ['provider_message_id', 'wamid.FAKE'],
    ['delivery_status', 'delivered'],
    ['category', 'transactional'],
  ]) {
    await assert.rejects(
      () => db`
        insert into messages (pharmacy_id, conversation_id, direction, author, body, ${db(column)})
        values (${ctx.a.id}, ${internal.id}, 'internal', 'staff', 'leak', ${value})
      `,
      (e) => e.code === '23514',
      `an internal message was allowed to carry ${column}`,
    );
  }

  // And an internal conversation cannot hold a provider reply window or be
  // left for the assistant to answer.
  await assert.rejects(
    () => db`update conversations set window_expires_at = now() where id = ${internal.id}`,
    (e) => e.code === '23514',
  );
  await assert.rejects(
    () => db`update conversations set mode = 'bot' where id = ${internal.id}`,
    (e) => e.code === '23514',
  );
});

test('a note cannot be written into a conversation with the patient', { skip: SKIP && skipReason }, async () => {
  // The other direction of the same boundary. An internal note landing in a
  // WhatsApp thread would enter the transcript the patient's history is built
  // from — and the range the assistant loads as conversation history.
  const p = await patient(ctx.a.id);
  const theirs = await conversation(ctx.a.id, p);

  await assert.rejects(
    () => messages.addInternalNote(ctx.a.id, p, theirs, { note: 'Private' }, { actorId: ctx.userA }),
    (e) => { assert.equal(e.status, 400); assert.equal(e.code, 'NOT_INTERNAL'); return true; },
  );
  const rows = await db`select count(*)::int as n from messages where conversation_id = ${theirs}`;
  assert.equal(rows[0].n, 0);
});

test('pharmacy B cannot read, start or add to an internal thread of ours', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Ours', note: 'Ours only.', topic: null }, { actorId: ctx.userA });

  assert.equal(await messages.getInternalThread(ctx.b.id, p, mine.id), null);
  await assert.rejects(
    () => messages.addInternalNote(ctx.b.id, p, mine.id, { note: 'theirs' }, { actorId: ctx.userB }),
    (e) => e.status === 404,
  );
  // And B cannot start one about a patient who is not theirs.
  await assert.rejects(
    () => messages.createInternalThread(ctx.b.id, p, { subject: 'x', note: 'y', topic: null }, { actorId: ctx.userB }),
    (e) => e.status === 404,
  );
  const asB = await messages.listPatientConversations(ctx.b.id, p, { filter: 'all', channel: 'internal' });
  assert.deepEqual(asB.conversations, []);
});

test('a thread keeps its notes in order, and says who wrote each', { skip: SKIP && skipReason }, async () => {
  // Colleagues read these, so "who said it" is the point — unlike a
  // patient-facing message, where 'staff' is all the patient needs to know.
  const p = await patient(ctx.a.id);
  const t = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Dose query', note: 'Prescriber wrote 10mg.', topic: null }, { actorId: ctx.userA });
  await messages.addInternalNote(ctx.a.id, p, t.id, { note: 'Rang them, no answer.' }, { actorId: ctx.staffA });
  const read = await messages.addInternalNote(ctx.a.id, p, t.id, { note: 'Confirmed 5mg.' }, { actorId: ctx.userA });

  assert.deepEqual(read.notes.map((n) => n.body),
    ['Prescriber wrote 10mg.', 'Rang them, no answer.', 'Confirmed 5mg.']);
  assert.equal(read.notes[0].authorId, ctx.userA);
  assert.equal(read.notes[1].authorId, ctx.staffA);
  // Read as userA: the middle one is somebody else's.
  const asA = await messages.getInternalThread(ctx.a.id, p, t.id, { userId: ctx.userA });
  assert.deepEqual(asA.notes.map((n) => n.mine), [true, false, true]);
});

test('internal unread counts what COLLEAGUES wrote, never your own notes', { skip: SKIP && skipReason }, async () => {
  // Your own note is not news to you. A badge that counts it is a badge that
  // is wrong the moment you write anything.
  const p = await patient(ctx.a.id);
  const t = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Interaction check', note: 'Starting this.', topic: null }, { actorId: ctx.userA });
  await messages.addInternalNote(ctx.a.id, p, t.id, { note: 'I will ring them.' }, { actorId: ctx.staffA });

  const forA = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  assert.equal(forA.internal.unread, 1, 'only the colleague\'s note');

  const forStaff = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.staffA });
  assert.equal(forStaff.internal.unread, 1, 'only the other one\'s note');

  await messages.markConversationRead(ctx.a.id, p, t.id, ctx.userA);
  const afterA = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.userA });
  assert.equal(afterA.internal.unread, 0);
  // The colleague's badge is untouched, exactly as for patient messages.
  const stillStaff = await messages.listPatientConversations(ctx.a.id, p, { filter: 'all', userId: ctx.staffA });
  assert.equal(stillStaff.internal.unread, 1);
});

test('starting an internal thread records the SUBJECT and never the note', { skip: SKIP && skipReason }, async () => {
  // The patient event log is read by other screens. A staff-to-staff note
  // belongs in the thread, not spread across it.
  const p = await patient(ctx.a.id);
  await messages.createInternalThread(ctx.a.id, p, {
    subject: 'Dose query before dispensing',
    note: 'SECRETNOTEBODY — do not surface this anywhere.',
    topic: null,
  }, { actorId: ctx.userA });

  const events = await db`
    select metadata, visibility from customer_events
    where customer_id = ${p} and event_type = 'INTERNAL_THREAD_STARTED'
  `;
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.subject, 'Dose query before dispensing');
  assert.ok(!JSON.stringify(events[0].metadata).includes('SECRETNOTEBODY'),
    'the note was copied into the patient event log');
  assert.equal(events[0].visibility, 'internal');
});

test('the assistant loads history BY CONVERSATION, so an internal note cannot reach it', { skip: SKIP && skipReason }, async () => {
  // Not a filter that could be forgotten — the internal note is never in the
  // set. This runs the worker's own query shape against real rows.
  const p = await patient(ctx.a.id);
  const theirs = await conversation(ctx.a.id, p);
  await message(ctx.a.id, theirs, { direction: 'inbound', author: 'customer', body: 'Is my dose right?' });
  const internal = await messages.createInternalThread(ctx.a.id, p,
    { subject: 'Dose query', note: 'SECRETNOTEBODY', topic: null }, { actorId: ctx.userA });

  const history = await db`
    select direction, body from messages
    where conversation_id = ${theirs} and body is not null
    order by id desc limit 10
  `;
  assert.equal(history.length, 1);
  assert.ok(!JSON.stringify(history).includes('SECRETNOTEBODY'));

  // And the internal note really is stored — this is not passing because
  // nothing was written.
  const stored = await db`select count(*)::int as n from messages where conversation_id = ${internal.id}`;
  assert.equal(stored[0].n, 1);
});
