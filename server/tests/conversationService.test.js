/**
 * The transition service against a real database.
 *
 * conversationState.test.js already proves the matrix. What can only be shown
 * here is that the matrix is actually ENFORCED on the way to disk, and that
 * the two columns move together — an illegal transition must leave the row
 * untouched, and a legal one must never write workflow_state without the
 * matching status.
 *
 * The tenancy case matters as much as the state cases: a conversation id is
 * a uuid someone could hold, and it must never be enough on its own to move
 * another pharmacy's thread.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — conversation transitions were NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const { STATES } = require('../services/whatsapp/conversationState');
const svc = require('../services/whatsapp/conversationService');

let db;
let ctx = {};

/**
 * A fresh conversation in a known state, on its OWN customer.
 *
 * The separate customer is required, not tidiness: idx_conversations_one_open
 * permits at most one open conversation per customer. An earlier version of
 * this helper reused a single customer and every test after the first failed
 * on that unique index — which is how the 0025 bug was found, since the index
 * was keyed on `mode` and blocked even a CLOSED customer's next conversation.
 */
async function newConversation(state = STATES.OPEN) {
  const status = ['resolved', 'archived'].includes(state) ? 'closed' : 'open';
  const key = `23490700${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 900 + 100)}`;
  const [cust] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name, name_verified, name_source)
    values (${ctx.a.id}, ${key}, ${key}, ${`${key}@s.whatsapp.net`}, 'State Tester',
            'State Tester', true, 'customer_provided')
    returning id
  `;
  const [c] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, status, workflow_state, last_message_at, window_expires_at)
    values (${ctx.a.id}, ${cust.id}, 'bot', ${status}, ${state}, now(), now() + interval '24 hours')
    returning id
  `;
  return c.id;
}

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Conv A', ${`conv-a-${Date.now()}`}, 'active')
    returning id
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('Conv B', ${`conv-b-${Date.now()}`}, 'active')
    returning id
  `;
  const [cust] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name, name_verified, name_source)
    values (${a.id}, '2349070000001', '2349070000001', '2349070000001@s.whatsapp.net', 'State Tester',
            'State Tester', true, 'customer_provided')
    returning id
  `;
  ctx = { a, b, customerId: cust.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id in (${ctx.a?.id}, ${ctx.b?.id})`.catch(() => {});
});

// ---- the matrix is enforced on the way to disk --------------------------

test('a legal transition writes both columns together', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.AI_HANDLING);
  const r = await svc.transitionTo(db, {
    pharmacyId: ctx.a.id, conversationId: id, to: STATES.RESOLVED,
  });
  assert.equal(r.changed, true);

  const [row] = await db`select workflow_state, status, closed_at from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'resolved');
  assert.equal(row.status, 'closed', 'status must move in the same write, never lag behind');
  assert.ok(row.closed_at, 'closing must stamp closed_at');
});

test('an illegal transition leaves the row completely untouched', { skip: SKIP && skipReason }, async () => {
  // The safety rule, proven end to end: a thread waiting on a pharmacist
  // cannot be archived out of the inbox.
  const id = await newConversation(STATES.WAITING_FOR_PHARMACIST);
  const r = await svc.transitionTo(db, {
    pharmacyId: ctx.a.id, conversationId: id, to: STATES.ARCHIVED,
  });
  assert.equal(r.changed, false);
  assert.match(r.reason, /ILLEGAL_TRANSITION/);

  const [row] = await db`select workflow_state, status from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'waiting_for_pharmacist', 'a refused move must not partially apply');
  assert.equal(row.status, 'open');
});

test('a no-op transition is not an error and changes nothing', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.AI_HANDLING);
  const r = await svc.transitionTo(db, {
    pharmacyId: ctx.a.id, conversationId: id, to: STATES.AI_HANDLING,
  });
  assert.equal(r.reason, 'NO_CHANGE');
  assert.equal(r.changed, false);
});

// ---- tenancy ------------------------------------------------------------

test('a conversation id alone cannot move another pharmacy\'s thread', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.OPEN);
  const r = await svc.transitionTo(db, {
    pharmacyId: ctx.b.id, conversationId: id, to: STATES.RESOLVED,
  });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'NOT_FOUND', 'cross-tenant must read as not-found, never as a refusal that confirms it exists');

  const [row] = await db`select workflow_state from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'open');
});

// ---- the named event helpers -------------------------------------------

test('a handoff puts the thread in the pharmacist queue', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.AI_HANDLING);
  await svc.onHandoffRaised(db, { pharmacyId: ctx.a.id, conversationId: id });
  const [row] = await db`select workflow_state from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'waiting_for_pharmacist');
});

test('a pharmacist replying hands the thread back to the customer', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.WAITING_FOR_PHARMACIST);
  await svc.onPharmacistReplied(db, { pharmacyId: ctx.a.id, conversationId: id });
  const [row] = await db`select workflow_state, status from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'waiting_for_customer',
    'a thread whose pharmacist has answered must leave the pharmacist queue');
  assert.equal(row.status, 'open');
});

test('the assistant replying hands the thread back to the customer', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.AI_HANDLING);
  await svc.onAssistantReplied(db, { pharmacyId: ctx.a.id, conversationId: id });
  const [row] = await db`select workflow_state from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'waiting_for_customer');
});

test('a customer message reopens a resolved thread and gives it to the assistant', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.RESOLVED);
  await svc.onCustomerMessage(db, { pharmacyId: ctx.a.id, conversationId: id });
  const [row] = await db`select workflow_state, status from conversations where id = ${id}`;
  assert.equal(row.workflow_state, 'ai_handling', 'resolved -> open -> ai_handling in one call');
  assert.equal(row.status, 'open', 'reopening must reopen the lifecycle too');
});

// ---- archiving ----------------------------------------------------------

test('archiving is only reachable from resolved', { skip: SKIP && skipReason }, async () => {
  const live = await newConversation(STATES.WAITING_FOR_CUSTOMER);
  const refused = await svc.archive(db, { pharmacyId: ctx.a.id, conversationId: live });
  assert.equal(refused.changed, false, 'a live thread must not be archivable');

  const done = await newConversation(STATES.RESOLVED);
  const ok = await svc.archive(db, { pharmacyId: ctx.a.id, conversationId: done });
  assert.equal(ok.changed, true);
});

// ---- the 0025 regression ------------------------------------------------

test('a returning customer can start a NEW conversation once the last one closed',
  { skip: SKIP && skipReason }, async () => {
    // THE BUG THIS PROTECTS AGAINST
    // idx_conversations_one_open was keyed on `mode <> 'closed'`. Migration
    // 0023 moved closing onto `status` and left `mode` alone, so nothing
    // wrote mode='closed' any more and the predicate matched every row — the
    // index quietly became "one conversation per customer, forever", which is
    // exactly what 0023 was written to end. The idle sweep closed threads,
    // resolveConversation asked for a new one, and the INSERT failed.
    //
    // Reproduced on production data before 0025 fixed it. This test is the
    // thing that stops it returning as a silent unique violation inside the
    // ingest transaction.
    const first = await newConversation(STATES.WAITING_FOR_CUSTOMER);
    const [{ customer_id: customerId }] = await db`
      select customer_id from conversations where id = ${first}
    `;

    await svc.resolve(db, { pharmacyId: ctx.a.id, conversationId: first, reason: 'idle_expired' });

    const [second] = await db`
      insert into conversations (pharmacy_id, customer_id, mode, last_message_at, window_expires_at)
      values (${ctx.a.id}, ${customerId}, 'bot', now(), now() + interval '24 hours')
      returning id
    `;
    assert.ok(second?.id, 'a customer coming back must be able to start a second conversation');

    const [{ n }] = await db`
      select count(*)::int as n from conversations where customer_id = ${customerId}
    `;
    assert.equal(n, 2, 'the patient should now own two distinct conversations');
  });

test('a customer still cannot hold TWO open conversations at once', { skip: SKIP && skipReason }, async () => {
  // The other half: the invariant is worth keeping. Two messages arriving
  // together must not produce two threads for one person.
  const open = await newConversation(STATES.OPEN);
  const [{ customer_id: customerId }] = await db`
    select customer_id from conversations where id = ${open}
  `;
  await assert.rejects(
    () => db`
      insert into conversations (pharmacy_id, customer_id, mode, last_message_at, window_expires_at)
      values (${ctx.a.id}, ${customerId}, 'bot', now(), now() + interval '24 hours')
    `,
    /idx_conversations_one_open/,
  );
});

// ---- audit --------------------------------------------------------------

test('every transition is recorded, including repeats of the same state', { skip: SKIP && skipReason }, async () => {
  const id = await newConversation(STATES.OPEN);
  await svc.transitionTo(db, { pharmacyId: ctx.a.id, conversationId: id, to: STATES.AI_HANDLING });
  await svc.transitionTo(db, { pharmacyId: ctx.a.id, conversationId: id, to: STATES.WAITING_FOR_CUSTOMER });
  await svc.transitionTo(db, { pharmacyId: ctx.a.id, conversationId: id, to: STATES.AI_HANDLING });

  const [{ n }] = await db`
    select count(*)::int as n from customer_events
    where entity_type = 'conversation' and entity_id = ${id}
      and event_type = 'CONVERSATION_STATE_CHANGED'
  `;
  // Three, not two: a thread legitimately revisits AI_HANDLING, and the
  // default idempotency key would have collapsed the second visit into the
  // first — losing the fact that the customer came back.
  assert.equal(n, 3, 'revisiting a state must record a new event, not deduplicate');
});
