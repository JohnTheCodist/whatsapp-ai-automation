/**
 * The customer must never be stranded because a pharmacist got pulled away.
 *
 * THE ASSERTION THIS FILE EXISTS FOR
 * After the takeback, the handoff is STILL OPEN. The assistant resumes
 * (mode 'bot'), but the pharmacist request is not cancelled, not resolved,
 * and not downgraded — the thread stays WAITING_FOR_PHARMACIST and stays at
 * the top of the inbox. That combination, handoff PENDING with owner AI, is
 * only expressible because handoff status and conversation ownership are two
 * separate axes; a single combined status would have to either forget the
 * escalation or keep the customer muted.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the idle takeback was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const { sweepIdlePharmacistHandoffs, PHARMACIST_IDLE_TAKEBACK_MINUTES } = require('../services/worker');
const { deriveHandoffStatus, STATUS } = require('../services/clinical/pharmacistHandoffService');
const { deriveOwnership } = require('../services/whatsapp/conversationState');

let db;
let ctx = {};

/** A conversation with an accepted handoff, idle for `idleMinutes`. */
async function seedAcceptedHandoff(idleMinutes) {
  await db`
    update conversations set status = 'closed', workflow_state = 'resolved'
    where customer_id = ${ctx.customerId} and status = 'open'
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, workflow_state, status, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'human', 'waiting_for_pharmacist', 'open', now())
    returning id
  `;
  const [handoff] = await db`
    insert into handoffs
      (pharmacy_id, conversation_id, reason, category, detail, triggered_by,
       accepted_at, handoff_last_activity_at)
    values
      (${ctx.pharmacyId}, ${conv.id}, 'clinical', 'symptoms', 'TEST', 'assistant',
       now() - make_interval(mins => ${idleMinutes}),
       now() - make_interval(mins => ${idleMinutes}))
    returning id
  `;
  return { conversationId: conv.id, handoffId: handoff.id };
}

/**
 * Sweep until THIS test's conversation has actually been processed.
 *
 * The sweep is global (every pharmacy) and takes `limit 10` per pass. Under
 * the full suite, other files create idle accepted handoffs concurrently, so
 * a single pass can fill its batch with other tests' rows and never reach
 * this one — which failed here as a phantom "takeback did not happen".
 *
 * Bounded, and it does NOT assert: callers still make their own assertions,
 * so a genuine failure to take back still fails the test rather than
 * spinning here.
 */
async function sweepUntilProcessed(conversationId, maxPasses = 12) {
  for (let i = 0; i < maxPasses; i += 1) {
    await sweepIdlePharmacistHandoffs(db);
    const [conv] = await db`select mode from conversations where id = ${conversationId}`;
    if (conv?.mode === 'bot') return;
  }
}

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Takeback Test', ${`takeback-${Date.now()}`}, 'active')
    returning id
  `;
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${p.id}, '2349140000001', '2349140000001', '2349140000001@s.whatsapp.net', 'Takeback Tester')
    returning id
  `;
  ctx = { pharmacyId: p.id, customerId: customer.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

test('a pharmacist still within the window is NOT taken back', { skip: SKIP && skipReason }, async () => {
  const { conversationId } = await seedAcceptedHandoff(PHARMACIST_IDLE_TAKEBACK_MINUTES - 2);
  await sweepIdlePharmacistHandoffs(db);

  const [conv] = await db`select mode from conversations where id = ${conversationId}`;
  assert.equal(conv.mode, 'human', 'a pharmacist mid-conversation must not be cut off underneath them');
});

test('a pharmacist idle past the window hands back to the assistant', { skip: SKIP && skipReason }, async () => {
  const { conversationId, handoffId } = await seedAcceptedHandoff(PHARMACIST_IDLE_TAKEBACK_MINUTES + 5);
  await sweepUntilProcessed(conversationId);

  const [conv] = await db`select mode, workflow_state from conversations where id = ${conversationId}`;
  assert.equal(conv.mode, 'bot', 'the assistant must resume so the customer is not left in silence');

  // THE POINT: the escalation survives the takeback.
  const [handoff] = await db`
    select accepted_at, resolved_at, cancelled_at from handoffs where id = ${handoffId}
  `;
  assert.equal(handoff.resolved_at, null, 'the handoff must NOT be resolved — a pharmacist is still needed');
  assert.equal(handoff.cancelled_at, null, 'nor cancelled');
  assert.equal(
    conv.workflow_state, 'waiting_for_pharmacist',
    'the thread must stay top-of-inbox — the request was not withdrawn, only the muting',
  );
});

test('after takeback the two axes read exactly as intended: handoff PENDING, owner AI', { skip: SKIP && skipReason }, async () => {
  const { conversationId, handoffId } = await seedAcceptedHandoff(PHARMACIST_IDLE_TAKEBACK_MINUTES + 5);
  await sweepUntilProcessed(conversationId);

  const [conv] = await db`select mode, workflow_state from conversations where id = ${conversationId}`;
  const [handoff] = await db`
    select accepted_at, resolved_at, cancelled_at from handoffs where id = ${handoffId}
  `;

  // accepted_at is deliberately left set — it is a true historical fact that
  // a pharmacist DID take this once. deriveHandoffStatus therefore still
  // reads ACTIVE; what changed is ownership, which is the separate axis.
  assert.equal(deriveHandoffStatus(handoff), STATUS.ACTIVE);
  assert.equal(
    deriveOwnership({ mode: conv.mode, workflowState: conv.workflow_state }), 'HUMAN_PENDING',
    'a human is still wanted, but is not currently replying — which is what HUMAN_PENDING means',
  );
});

test('the sweep is idempotent — a second pass does not re-log or re-flip', { skip: SKIP && skipReason }, async () => {
  const { conversationId, handoffId } = await seedAcceptedHandoff(PHARMACIST_IDLE_TAKEBACK_MINUTES + 5);
  await sweepUntilProcessed(conversationId);
  await sweepIdlePharmacistHandoffs(db);

  const [handoff] = await db`select handoff_last_activity_at from handoffs where id = ${handoffId}`;
  assert.equal(handoff.handoff_last_activity_at, null, 'the claim marker stops a second pass picking it up again');

  const [conv] = await db`select mode from conversations where id = ${conversationId}`;
  assert.equal(conv.mode, 'bot');
});

test('a handoff nobody ever accepted is not "idle" — there is nothing to take back from', { skip: SKIP && skipReason }, async () => {
  await db`
    update conversations set status = 'closed', workflow_state = 'resolved'
    where customer_id = ${ctx.customerId} and status = 'open'
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, workflow_state, status, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'bot', 'waiting_for_pharmacist', 'open', now())
    returning id
  `;
  await db`
    insert into handoffs (pharmacy_id, conversation_id, reason, category, detail, triggered_by)
    values (${ctx.pharmacyId}, ${conv.id}, 'clinical', 'symptoms', 'never accepted', 'assistant')
  `;

  await assert.doesNotReject(() => sweepIdlePharmacistHandoffs(db));
  const [after2] = await db`select mode from conversations where id = ${conv.id}`;
  assert.equal(after2.mode, 'bot', 'it was never muted, so nothing to restore');
});

test('a resolved handoff is never taken back, however old', { skip: SKIP && skipReason }, async () => {
  const { conversationId, handoffId } = await seedAcceptedHandoff(PHARMACIST_IDLE_TAKEBACK_MINUTES + 60);
  await db`update handoffs set resolved_at = now() where id = ${handoffId}`;
  // Staff may deliberately stay in a thread after resolving the clinical
  // question — that is their call, not the sweep's to override.
  await sweepIdlePharmacistHandoffs(db);

  const [conv] = await db`select mode from conversations where id = ${conversationId}`;
  assert.equal(conv.mode, 'human');
});
