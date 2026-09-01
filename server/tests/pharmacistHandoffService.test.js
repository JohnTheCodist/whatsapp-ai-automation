/**
 * Clinical handoffs: raising one moves the encounter to
 * PHARMACIST_REVIEW_REQUIRED but does NOT mute the assistant (reusing the
 * hybrid-handoff segment's own rule — HANDOFF ≠ AI SILENCE); only
 * acceptHandoff() does, exactly like POST /:id/takeover already does for
 * non-clinical handoffs. That is the one assertion this whole file exists
 * to protect: conversations.mode stays 'bot' through PENDING, and flips to
 * 'human' only at the moment a pharmacist actually accepts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — clinical handoffs were NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const handoffs = require('../services/clinical/pharmacistHandoffService');
const encounters = require('../services/clinical/clinicalEncounterService');

let db;
let ctx = {};

// ---- pure: deriveHandoffStatus --------------------------------------------

test('no handoff at all is NOT_REQUIRED', () => {
  assert.equal(handoffs.deriveHandoffStatus(null), 'NOT_REQUIRED');
});

test('raised but untouched is PENDING', () => {
  assert.equal(handoffs.deriveHandoffStatus({ accepted_at: null, resolved_at: null }), 'PENDING');
});

test('accepted and not yet resolved is ACTIVE', () => {
  assert.equal(handoffs.deriveHandoffStatus({ accepted_at: new Date(), resolved_at: null }), 'ACTIVE');
});

test('resolved with no cancellation marker is COMPLETED', () => {
  assert.equal(
    handoffs.deriveHandoffStatus({ accepted_at: new Date(), resolved_at: new Date(), cancelled_at: null }),
    'COMPLETED',
  );
});

test('resolved WITH a cancellation marker is CANCELLED, not COMPLETED', () => {
  assert.equal(
    handoffs.deriveHandoffStatus({ accepted_at: null, resolved_at: new Date(), cancelled_at: new Date() }),
    'CANCELLED',
  );
});

// ---- integration ------------------------------------------------------

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Handoff Clinical Test', ${`clin-handoff-${Date.now()}`}, 'active')
    returning id
  `;
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349120000001', '2349120000001', '2349120000001@s.whatsapp.net', 'Clinical Handoff Tester')
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

test('raising a clinical handoff moves the encounter to review-required but does NOT mute the assistant', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyId, ctx.customerId, {
    conversationId: ctx.conversationId, presentingComplaint: 'Fever and headache',
  }, { actorType: 'ai' });

  await handoffs.raiseClinicalHandoff(ctx.pharmacyId, {
    conversationId: ctx.conversationId, customerId: ctx.customerId, encounterId: enc.id,
    category: 'symptoms', detail: 'symptoms: fever and headache, wants a recommendation',
  }, { actorType: 'ai' });

  const encAfter = await encounters.getEncounter(ctx.pharmacyId, enc.id);
  assert.equal(encAfter.status, encounters.STATES.PHARMACIST_REVIEW_REQUIRED);

  const [conv] = await db`select mode from conversations where id = ${ctx.conversationId}`;
  assert.equal(conv.mode, 'bot', 'raising a handoff must never mute the assistant on its own');

  ctx.encounterId = enc.id;
});

test('acceptHandoff moves the encounter to pharmacist-active AND flips conversation mode to human', { skip: SKIP && skipReason }, async () => {
  const [handoff] = await db`
    select id from handoffs where conversation_id = ${ctx.conversationId} and resolved_at is null
  `;
  await handoffs.acceptHandoff(ctx.pharmacyId, handoff.id, { actorId: null });

  const enc = await encounters.getEncounter(ctx.pharmacyId, ctx.encounterId);
  assert.equal(enc.status, encounters.STATES.PHARMACIST_ACTIVE);

  const [conv] = await db`select mode from conversations where id = ${ctx.conversationId}`;
  assert.equal(conv.mode, 'human', 'accepting IS the action that mutes the assistant — the only one');

  ctx.handoffId = handoff.id;
});

test('acceptHandoff recorded HANDOFF_ACCEPTED — the audit gap /takeover used to leave open', { skip: SKIP && skipReason }, async () => {
  const [event] = await db`
    select event_type, visibility, actor_type from customer_events
    where customer_id = ${ctx.customerId} and event_type = 'HANDOFF_ACCEPTED'
    order by id desc limit 1
  `;
  assert.ok(event, 'HANDOFF_ACCEPTED must be recorded');
  assert.equal(event.visibility, 'internal');
  assert.equal(event.actor_type, 'pharmacist');
});

test('completeHandoff moves the encounter to COMPLETED — refused if it were still review-required', { skip: SKIP && skipReason }, async () => {
  await handoffs.completeHandoff(ctx.pharmacyId, ctx.handoffId, { actorId: null, reason: 'Advised paracetamol; no red flags.' });

  const enc = await encounters.getEncounter(ctx.pharmacyId, ctx.encounterId);
  assert.equal(enc.status, encounters.STATES.COMPLETED);
  assert.ok(enc.completed_at);
});

test('a second complete on the same handoff is refused, not silently accepted', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => handoffs.completeHandoff(ctx.pharmacyId, ctx.handoffId, {}),
    /not found or already resolved/i,
  );
});

// ---- the cancellation path, tested separately with its own encounter -----

test('a full PENDING -> CANCELLED path leaves the encounter cancelled, distinguishable from completed', { skip: SKIP && skipReason }, async () => {
  // A customer has at most one OPEN conversation (idx_conversations_one_open,
  // 0025) — close the previous one first, the same way a real new session
  // starts, rather than testing a state production never allows.
  await db`
    update conversations set status = 'closed', workflow_state = 'resolved'
    where customer_id = ${ctx.customerId} and status = 'open'
  `;
  const [conv2] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'bot', now())
    returning id
  `;
  const enc = await encounters.createEncounter(ctx.pharmacyId, ctx.customerId, {
    conversationId: conv2.id, presentingComplaint: 'Will be cancelled',
  });

  const raised = await handoffs.raiseClinicalHandoff(ctx.pharmacyId, {
    conversationId: conv2.id, customerId: ctx.customerId, encounterId: enc.id,
    category: 'symptoms', detail: 'symptoms: to be cancelled',
  }, { actorType: 'ai' });
  assert.equal(raised.isNew, true);

  const [handoffRow] = await db`select id from handoffs where conversation_id = ${conv2.id}`;
  const before2 = handoffs.deriveHandoffStatus(
    (await db`select accepted_at, resolved_at, cancelled_at from handoffs where id = ${handoffRow.id}`)[0],
  );
  assert.equal(before2, 'PENDING');

  await handoffs.cancelHandoff(ctx.pharmacyId, handoffRow.id, { actorType: 'staff', reason: 'duplicate report' });

  const afterRow = (await db`select accepted_at, resolved_at, cancelled_at from handoffs where id = ${handoffRow.id}`)[0];
  assert.equal(handoffs.deriveHandoffStatus(afterRow), 'CANCELLED');

  const encAfter = await encounters.getEncounter(ctx.pharmacyId, enc.id);
  assert.equal(encAfter.status, encounters.STATES.CANCELLED);
});

test('cancelling a handoff whose encounter already completed does not throw or corrupt the encounter', { skip: SKIP && skipReason }, async () => {
  // The encounter finished at test 6 above (ctx.encounterId, now COMPLETED).
  // A late cancel on some other handoff pointed at it must not attempt an
  // illegal COMPLETED -> CANCELLED transition — it should simply leave the
  // encounter's real history alone.
  await db`
    update conversations set status = 'closed', workflow_state = 'resolved'
    where customer_id = ${ctx.customerId} and status = 'open'
  `;
  const [conv3] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'bot', now())
    returning id
  `;
  const [lateHandoff] = await db`
    insert into handoffs (pharmacy_id, conversation_id, reason, category, detail, triggered_by, encounter_id)
    values (${ctx.pharmacyId}, ${conv3.id}, 'clinical', 'symptoms', 'late, unrelated', 'assistant', ${ctx.encounterId})
    returning id
  `;

  await assert.doesNotReject(() => handoffs.cancelHandoff(ctx.pharmacyId, lateHandoff.id, { actorType: 'staff' }));

  const enc = await encounters.getEncounter(ctx.pharmacyId, ctx.encounterId);
  assert.equal(enc.status, encounters.STATES.COMPLETED, 'the encounter\'s real outcome must not be overwritten');
});
