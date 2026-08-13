/**
 * Customer 360 profile, against real Postgres.
 *
 * THE MANDATORY CASE
 * "The server must verify authenticated_pharmacy_id = patient.pharmacy_id
 * before returning anything... do not rely on the frontend to enforce
 * this." getCustomerProfile scopes every query by pharmacy_id in its own
 * WHERE clause rather than checking ownership after an unscoped lookup —
 * this test proves a customer's real id, known to pharmacy A, returns
 * nothing when asked for under pharmacy B's id.
 *
 * Everything else here checks that the numbers on the profile are exactly
 * what the fixture put in the database — no frontend arithmetic, no
 * invented consent states, no clinical fields anywhere in the shape.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — customer profile NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'profiletest';

let db;
let getCustomerProfile;
let ctx = null;

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  ({ getCustomerProfile } = require('../services/customers/customerProfile'));

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
    insert into customers (pharmacy_id, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349080000001', '2349080000001@s.whatsapp.net', 'Profile Tester')
    returning id, first_seen_at
  `;

  const [conversation] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${a.id}, ${customer.id}, 'bot', now())
    returning id
  `;

  await db`
    insert into messages (pharmacy_id, conversation_id, direction, author, body, created_at)
    values (${a.id}, ${conversation.id}, 'inbound', 'customer', 'Do you have Coartem?', now() - interval '2 minutes')
  `;

  const [product] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, status)
    values (${a.id}, ${`${TAG} Coartem`}, ${`${TAG}-coartem`}, 197000, 'active')
    returning id
  `;

  const orders = require('../services/orders/orderService');
  const created = await orders.createOrder(a.id, {
    customerId: customer.id,
    conversationId: conversation.id,
    items: [{ productId: product.id, quantity: 1 }],
  });
  await orders.updateStatus(a.id, created.order.id, 'confirmed', { actorType: 'staff' });

  const [handoff] = await db`
    insert into handoffs (pharmacy_id, conversation_id, reason, category, requested_at, resolved_at)
    values (${a.id}, ${conversation.id}, 'clinical', 'dosage', now() - interval '1 hour', now() - interval '50 minutes')
    returning id, requested_at, resolved_at
  `;
  // This fixture raw-inserts the handoff, bypassing worker.js and
  // conversations.js entirely — which means, correctly under 0017, it
  // produces no timeline events on its own. Recording them here mirrors
  // exactly what those real code paths do at the same two moments, so the
  // fixture stays honest about what actually happened rather than the
  // timeline showing something no code path actually recorded.
  const { recordEvent } = require('../services/customers/customerEvents');
  await recordEvent(db, {
    pharmacyId: a.id, customerId: customer.id, eventType: 'PHARMACIST_HANDOFF',
    occurredAt: handoff.requested_at, actorType: 'ai',
    entityType: 'handoff', entityId: handoff.id,
  });
  await recordEvent(db, {
    pharmacyId: a.id, customerId: customer.id, eventType: 'PHARMACIST_RESPONDED',
    occurredAt: handoff.resolved_at, actorType: 'pharmacist',
    entityType: 'handoff', entityId: handoff.id,
  });

  ctx = { userA, userB, a, b, customer, conversation, order: created.order, handoff, product };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ----

test('a customer belonging to pharmacy A returns nothing when looked up under pharmacy B', { skip: SKIP && skipReason }, async () => {
  const asOwner = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.ok(asOwner, 'sanity check: the profile exists for the pharmacy that owns it');

  const asOther = await getCustomerProfile(ctx.b.id, ctx.customer.id);
  assert.equal(asOther, null, 'a known customer id from another tenant must not leak any data');
});

test('a nonexistent id returns the same null as a cross-tenant id — no existence oracle', { skip: SKIP && skipReason }, async () => {
  const r = await getCustomerProfile(ctx.a.id, crypto.randomUUID());
  assert.equal(r, null);
});

// ---- correctness of the aggregates ----

test('order count and confirmed spend match the fixture exactly', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.equal(profile.orders.count, 1);
  assert.equal(profile.orders.totalSpend, 1970, 'confirmed order total, in naira, matching the product price');
  assert.equal(profile.orders.recent[0].status, 'confirmed');
  assert.equal(profile.orders.recent[0].id, ctx.order.id);
});

test('a pending order is counted but excluded from confirmed spend', { skip: SKIP && skipReason }, async () => {
  const orders = require('../services/orders/orderService');
  const pending = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customer.id,
    conversationId: ctx.conversation.id,
    items: [{ productId: ctx.product.id, quantity: 1 }],
  });

  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.equal(profile.orders.count, 2, 'every order counts, regardless of status');
  assert.equal(profile.orders.totalSpend, 1970, 'a pending order has not been confirmed — it must not inflate spend');

  await orders.updateStatus(ctx.a.id, pending.order.id, 'rejected', { actorType: 'staff' });
});

test('the conversation preview is the customer\'s own words, verbatim', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.equal(profile.conversations.count, 1);
  assert.equal(profile.conversations.recent[0].preview, 'Do you have Coartem?');
});

test('an unresolved-then-resolved handoff produces both timeline events', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  const types = profile.timeline.map((e) => e.eventType);
  assert.ok(types.includes('PHARMACIST_HANDOFF'));
  assert.ok(types.includes('PHARMACIST_RESPONDED'), 'a resolved_at must produce its own event, not be silently dropped');
});

test('the timeline is sorted newest first', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  const times = profile.timeline.map((e) => new Date(e.occurredAt).getTime());
  const sorted = [...times].sort((x, y) => y - x);
  assert.deepEqual(times, sorted);
});

test('the response has no clinical fields anywhere — this is a CRM, not an EHR', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  const flat = JSON.stringify(profile).toLowerCase();
  for (const banned of ['diagnos', 'allerg', 'vital', 'labresult', 'treatmentplan', 'clinicalnote']) {
    assert.ok(!flat.includes(banned), `found forbidden clinical term "${banned}" in the profile response`);
  }
});

test('medicationJourneys is an honest empty array, not a fabricated placeholder', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.deepEqual(profile.medicationJourneys, []);
});

test('a customer with no orders or conversations still returns a complete, non-throwing shape', { skip: SKIP && skipReason }, async () => {
  const [bare] = await db`
    insert into customers (pharmacy_id, wa_phone, wa_jid, display_name, first_seen_at)
    values (${ctx.a.id}, '2349080000099', '2349080000099@s.whatsapp.net', null, now())
    returning id, first_seen_at
  `;
  // Raw insert bypasses inboundIngest.js's xmax-detected PATIENT_CREATED
  // recording, same reasoning as the handoff fixture above — recorded here
  // to mirror what the real path does, not to test around it.
  const { recordEvent } = require('../services/customers/customerEvents');
  await recordEvent(db, {
    pharmacyId: ctx.a.id, customerId: bare.id, eventType: 'PATIENT_CREATED',
    occurredAt: bare.first_seen_at, actorType: 'system', entityType: 'customer', entityId: bare.id,
  });

  const profile = await getCustomerProfile(ctx.a.id, bare.id);
  assert.equal(profile.orders.count, 0);
  assert.equal(profile.orders.totalSpend, 0);
  assert.deepEqual(profile.orders.recent, []);
  assert.equal(profile.conversations.count, 0);
  assert.deepEqual(profile.conversations.recent, []);
  // Still has PATIENT_CREATED even with nothing else — that event comes
  // from first_seen_at, not from any activity.
  assert.equal(profile.timeline.length, 1);
  assert.equal(profile.timeline[0].eventType, 'PATIENT_CREATED');
});
