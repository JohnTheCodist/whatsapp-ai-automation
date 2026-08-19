/**
 * raiseOrConsolidateHandoff: at most one open handoff per conversation.
 *
 * Segment's Test 7 (§13): three related messages before a pharmacist
 * responds must produce ONE consolidated handoff a pharmacist can read as a
 * timeline, not three disconnected notifications. These tests prove that at
 * the data layer — the same discipline as customerNameGate.test.js, because
 * a rule this load-bearing has to be checked against the table it actually
 * writes, not a mock of it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — handoff consolidation was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const { raiseOrConsolidateHandoff } = require('../services/whatsapp/handoffService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Handoff Test', ${`handoff-${Date.now()}`}, 'active')
    returning id
  `;
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349080000001', '2349080000001', '2349080000001@s.whatsapp.net', 'Handoff Tester')
    returning id
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${a.id}, ${customer.id}, 'bot', now())
    returning id
  `;

  ctx = { pharmacyId: a.id, customerId: customer.id, conversationId: conv.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

test('the first escalation on a conversation creates a new handoff', { skip: SKIP && skipReason }, async () => {
  const r = await db.begin((tx) => raiseOrConsolidateHandoff(tx, {
    pharmacyId: ctx.pharmacyId, conversationId: ctx.conversationId, customerId: ctx.customerId,
    reason: 'clinical', category: 'drug_interaction',
    detail: 'drug_interaction: can I take amlodipine with this?',
    triggeredBy: 'assistant', actorType: 'ai',
  }));
  assert.equal(r.isNew, true);

  const rows = await db`select count(*)::int n from handoffs where conversation_id = ${ctx.conversationId}`;
  assert.equal(rows[0].n, 1);
});

test('a second escalation while the first is still open consolidates, not duplicates', { skip: SKIP && skipReason }, async () => {
  const r = await db.begin((tx) => raiseOrConsolidateHandoff(tx, {
    pharmacyId: ctx.pharmacyId, conversationId: ctx.conversationId, customerId: ctx.customerId,
    reason: 'clinical', category: 'adverse_reaction',
    detail: 'adverse_reaction: customer reports feeling dizzy',
    triggeredBy: 'assistant', actorType: 'ai',
  }));
  assert.equal(r.isNew, false, 'a second open handoff on the same conversation must not be created');

  const rows = await db`select count(*)::int n from handoffs where conversation_id = ${ctx.conversationId}`;
  assert.equal(rows[0].n, 1, 'still exactly one row, not two');
});

test('the pharmacist sees BOTH reasons in one place — nothing was dropped', { skip: SKIP && skipReason }, async () => {
  // Test 7's actual requirement: complete context, not fragments. Checked by
  // reading the row itself, not the return value — a caller could return
  // isNew:false and still silently discard the new information; only the
  // stored detail proves it did not.
  const [handoff] = await db`select detail from handoffs where conversation_id = ${ctx.conversationId}`;
  assert.match(handoff.detail, /amlodipine/i, 'the first reason must survive');
  assert.match(handoff.detail, /dizzy/i, 'the second reason must be appended, not overwrite');
});

test('a third overlapping escalation still consolidates into the same row', { skip: SKIP && skipReason }, async () => {
  const before2 = await db`select id from handoffs where conversation_id = ${ctx.conversationId}`;
  const r = await db.begin((tx) => raiseOrConsolidateHandoff(tx, {
    pharmacyId: ctx.pharmacyId, conversationId: ctx.conversationId, customerId: ctx.customerId,
    reason: 'clinical', category: 'dosage', detail: 'dosage: is dizziness normal at this dose?',
    triggeredBy: 'assistant', actorType: 'ai',
  }));
  assert.equal(r.isNew, false);
  assert.equal(r.handoffId, before2[0].id, 'must be the SAME handoff row, not a new one');
});

test('once resolved, the NEXT escalation opens a genuinely new handoff', { skip: SKIP && skipReason }, async () => {
  await db`update handoffs set resolved_at = now() where conversation_id = ${ctx.conversationId} and resolved_at is null`;

  const r = await raiseOrConsolidateHandoff(db, {
    pharmacyId: ctx.pharmacyId, conversationId: ctx.conversationId, customerId: ctx.customerId,
    reason: 'clinical', category: 'pregnancy', detail: 'pregnancy: a new, unrelated question weeks later',
    triggeredBy: 'assistant', actorType: 'ai',
  });
  assert.equal(r.isNew, true, 'a resolved handoff must not be reopened by a later, unrelated question');

  const rows = await db`select count(*)::int n from handoffs where conversation_id = ${ctx.conversationId}`;
  assert.equal(rows[0].n, 2, 'the resolved one plus this new one');
});

test('a different conversation gets its own handoff, never sharing another\'s', { skip: SKIP && skipReason }, async () => {
  // A customer has at most one OPEN conversation (idx_conversations_one_open,
  // 0025) — the same real constraint conversationPolicy relies on. Closing
  // the first before opening a second here mirrors how a new session
  // actually starts, rather than testing a state production never allows.
  // status and workflow_state move together or not at all
  // (conversations_workflow_matches_status) — the same pairing
  // conversationState.applyTransition() enforces in real code.
  await db`update conversations set status = 'closed', workflow_state = 'resolved' where id = ${ctx.conversationId}`;
  const [otherConv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'bot', now())
    returning id
  `;
  const r = await raiseOrConsolidateHandoff(db, {
    pharmacyId: ctx.pharmacyId, conversationId: otherConv.id, customerId: ctx.customerId,
    reason: 'clinical', category: 'symptoms', detail: 'symptoms: a question in a different session entirely',
    triggeredBy: 'assistant', actorType: 'ai',
  });
  assert.equal(r.isNew, true);

  const rows = await db`select count(*)::int n from handoffs where conversation_id = ${otherConv.id}`;
  assert.equal(rows[0].n, 1);
});

test('a new handoff moves the conversation to WAITING_FOR_PHARMACIST', { skip: SKIP && skipReason }, async () => {
  await db`
    update conversations set status = 'closed', workflow_state = 'resolved'
    where customer_id = ${ctx.customerId} and status = 'open'
  `;
  const [otherConv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, workflow_state, status, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'bot', 'ai_handling', 'open', now())
    returning id
  `;
  await raiseOrConsolidateHandoff(db, {
    pharmacyId: ctx.pharmacyId, conversationId: otherConv.id, customerId: ctx.customerId,
    reason: 'clinical', category: 'prescription', detail: 'prescription: needs review',
    triggeredBy: 'assistant', actorType: 'ai',
  });
  const [row] = await db`select workflow_state, mode from conversations where id = ${otherConv.id}`;
  assert.equal(row.workflow_state, 'waiting_for_pharmacist');
  // The load-bearing assertion for this whole ticket: raising a handoff
  // must NOT touch mode. Only POST /:id/takeover (conversations.js) may.
  assert.equal(row.mode, 'bot', 'a handoff must never mute the assistant on its own');
});
