/**
 * The event stream itself — recordEvent's idempotency, listTimeline's
 * tenant isolation and pagination, and true chronological ordering.
 *
 * "The same event must not be recorded multiple times... do not blindly
 * insert a new timeline event every time the same processing code runs."
 * That guarantee lives entirely in the unique constraint from 0017
 * (pharmacy_id, event_type, entity_type, entity_id) — recordEvent has no
 * application-level "check first" logic to get wrong. The test that matters
 * most here fires the exact same call twice and asserts one row.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — customer events NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'eventstest';

let db;
let recordEvent;
let listTimeline;
let ctx = null;

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  ({ recordEvent } = require('../services/customers/customerEvents'));
  ({ listTimeline } = require('../services/customers/customerTimeline'));

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349070000001', '2349070000001', '2349070000001@s.whatsapp.net', 'Events Tester')
    returning id
  `;

  ctx = { userA, userB, a, b, customer };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- idempotency: the requirement called "extremely important" ----

test('recording the identical event twice produces exactly one row', { skip: SKIP && skipReason }, async () => {
  const args = {
    pharmacyId: ctx.a.id, customerId: ctx.customer.id, eventType: 'ORDER_CONFIRMED',
    actorType: 'pharmacist', entityType: 'order_status_history', entityId: 999001, verifyEntity: false,
    metadata: { orderId: 'x' },
  };
  const id1 = await recordEvent(db, args);
  const id2 = await recordEvent(db, args);

  assert.ok(id1, 'the first call must actually record something');
  assert.equal(id2, null, 'a duplicate call returns null — a retry finding its own work already done is success, not an error');

  const rows = await db`
    select id from customer_events
    where pharmacy_id = ${ctx.a.id} and event_type = 'ORDER_CONFIRMED' and entity_type = 'order_status_history' and entity_id = '999001'
  `;
  assert.equal(rows.length, 1);
});

test('ten concurrent attempts at the same event still produce exactly one row', { skip: SKIP && skipReason }, async () => {
  // The scenario named explicitly in the spec: worker retries, reconnect
  // replays, duplicate webhooks — all landing at roughly the same time.
  const args = {
    pharmacyId: ctx.a.id, customerId: ctx.customer.id, eventType: 'MESSAGE_SENT',
    actorType: 'ai', entityType: 'message', entityId: 999002, verifyEntity: false,
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => recordEvent(db, args)));
  const successes = results.filter((r) => r !== null);
  assert.equal(successes.length, 1, 'exactly one of ten concurrent attempts should have actually inserted');

  const rows = await db`
    select id from customer_events
    where pharmacy_id = ${ctx.a.id} and event_type = 'MESSAGE_SENT' and entity_type = 'message' and entity_id = '999002'
  `;
  assert.equal(rows.length, 1);
});

test('the same entity_id under a DIFFERENT event_type is a separate, allowed event', { skip: SKIP && skipReason }, async () => {
  // A handoff genuinely produces two events against the same entity_id —
  // PHARMACIST_HANDOFF then PHARMACIST_RESPONDED. The unique constraint
  // includes event_type specifically so this is not mistaken for a duplicate.
  const base = { pharmacyId: ctx.a.id, customerId: ctx.customer.id, entityType: 'handoff', entityId: 999003, verifyEntity: false };
  const id1 = await recordEvent(db, { ...base, eventType: 'PHARMACIST_HANDOFF', actorType: 'ai' });
  const id2 = await recordEvent(db, { ...base, eventType: 'PHARMACIST_RESPONDED', actorType: 'pharmacist' });
  assert.ok(id1);
  assert.ok(id2);
  assert.notEqual(id1, id2);
});

// ---- tenant isolation on the timeline itself ----

test('a customer belonging to pharmacy A returns no timeline when asked for under pharmacy B', { skip: SKIP && skipReason }, async () => {
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: ctx.customer.id, eventType: 'PATIENT_CREATED',
    actorType: 'system', entityType: 'customer', entityId: ctx.customer.id,
  });

  const asOwner = await listTimeline(ctx.a.id, ctx.customer.id);
  assert.ok(asOwner, 'sanity check: the timeline exists for the pharmacy that owns the customer');
  assert.ok(asOwner.events.length > 0);

  const asOther = await listTimeline(ctx.b.id, ctx.customer.id);
  assert.equal(asOther, null, 'a known customer id from another tenant must return nothing, not an empty list');
});

// ---- chronological ordering: the point of Test 9 in the spec ----

test('events are ordered by occurred_at, not by insertion order or id', { skip: SKIP && skipReason }, async () => {
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.a.id}, '2349070000002', '2349070000002', '2349070000002@s.whatsapp.net', 'Order Test')
    returning id
  `;

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  const evenEarlier = new Date(now.getTime() - 120_000);

  // Inserted NEWEST-occurred first, deliberately — simulating exactly what
  // the spec warns about: async processing persisting an early event late.
  // If the timeline sorted on insertion order or id, this would come back
  // in the order written, not the order it happened.
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: customer.id, eventType: 'MESSAGE_RECEIVED',
    occurredAt: now, actorType: 'customer', entityType: 'message', entityId: 998001, verifyEntity: false,
  });
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: customer.id, eventType: 'ORDER_CREATED',
    occurredAt: evenEarlier, actorType: 'ai', entityType: 'order_status_history', entityId: 998002, verifyEntity: false,
  });
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: customer.id, eventType: 'PATIENT_CREATED',
    occurredAt: earlier, actorType: 'system', entityType: 'customer', entityId: customer.id,
  });

  const page = await listTimeline(ctx.a.id, customer.id);
  const types = page.events.map((e) => e.eventType);
  assert.deepEqual(types, ['MESSAGE_RECEIVED', 'PATIENT_CREATED', 'ORDER_CREATED'],
    'newest occurred_at first, regardless of the order the rows were written in');
});

// ---- pagination ----

test('cursor pagination covers every event exactly once across pages', { skip: SKIP && skipReason }, async () => {
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.a.id}, '2349070000003', '2349070000003', '2349070000003@s.whatsapp.net', 'Pagination Test')
    returning id
  `;

  const base = Date.now();
  for (let i = 0; i < 25; i++) {
    await recordEvent(db, {
      pharmacyId: ctx.a.id, customerId: customer.id, eventType: 'MESSAGE_RECEIVED',
      occurredAt: new Date(base + i * 1000), actorType: 'customer',
      entityType: 'message', entityId: 900000 + i, verifyEntity: false,
    });
  }

  const page1 = await listTimeline(ctx.a.id, customer.id, { limit: 10 });
  assert.equal(page1.events.length, 10);
  assert.ok(page1.nextCursor, 'more than a page exists, so a cursor must be offered');

  const page2 = await listTimeline(ctx.a.id, customer.id, { limit: 10, cursor: page1.nextCursor });
  assert.equal(page2.events.length, 10);

  const page3 = await listTimeline(ctx.a.id, customer.id, { limit: 10, cursor: page2.nextCursor });
  assert.equal(page3.events.length, 5);
  assert.equal(page3.nextCursor, null, 'the last page reports no further cursor');

  const allIds = [...page1.events, ...page2.events, ...page3.events].map((e) => e.id);
  assert.equal(new Set(allIds).size, 25, 'every event appears exactly once across all pages — no gaps, no repeats');
});

test('a filtered category only returns events in that category', { skip: SKIP && skipReason }, async () => {
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.a.id}, '2349070000004', '2349070000004', '2349070000004@s.whatsapp.net', 'Filter Test')
    returning id
  `;
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: customer.id, eventType: 'MESSAGE_RECEIVED',
    actorType: 'customer', entityType: 'message', entityId: 900100, verifyEntity: false,
  });
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: customer.id, eventType: 'ORDER_CREATED',
    actorType: 'ai', entityType: 'order_status_history', entityId: 900101, verifyEntity: false,
  });

  const orders = await listTimeline(ctx.a.id, customer.id, { eventType: 'orders' });
  assert.deepEqual(orders.events.map((e) => e.eventType), ['ORDER_CREATED']);

  const messages = await listTimeline(ctx.a.id, customer.id, { eventType: 'messages' });
  assert.deepEqual(messages.events.map((e) => e.eventType), ['MESSAGE_RECEIVED']);
});
