/**
 * The generic event architecture — validation, tenancy, and the extension
 * path a future feature module actually depends on.
 *
 * The existing customerEvents.test.js covers idempotency, pagination and
 * ordering against the stream. This file covers the guarantees that make the
 * stream safe to expose to every future domain: that an event cannot be
 * filed against the wrong tenant, cannot reference another pharmacy's data,
 * cannot invent a vocabulary, and CAN accept an event type whose feature
 * does not exist yet.
 *
 * The last one is the whole point of the segment: if Segment 2 cannot record
 * MEDICATION_STARTED without a migration, this layer failed at the only job
 * it was built for.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — event architecture NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'evtarch';

let db;
let recordEvent;
let PATIENT_EVENTS;
let ctx = null;

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  ({ recordEvent } = require('../services/customers/customerEvents'));
  ({ PATIENT_EVENTS } = require('../services/customers/patientEventTypes'));

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  // One customer in each tenant, so cross-tenant attempts are realistic
  // rather than using an id that simply does not exist.
  const [custA] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349080000001', '2349080000001', '2349080000001@s.whatsapp.net', 'Alpha Customer')
    returning id`;
  const [custB] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${b.id}, '2349080000002', '2349080000002', '2349080000002@s.whatsapp.net', 'Beta Customer')
    returning id`;

  // A product in B, used to prove an entity from another tenant is refused.
  const [prodB] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, status)
    values (${b.id}, 'Beta Product', 'beta-product', 50000, 'active')
    returning id`;

  ctx = { userA, userB, a, b, custA, custB, prodB };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

const base = () => ({
  pharmacyId: ctx.a.id,
  customerId: ctx.custA.id,
  actorType: 'system',
  entityType: 'customer',
  entityId: ctx.custA.id,
});

// ---- the reason this segment exists ------------------------------------

test('accepts an event type whose feature does not exist yet', { skip: SKIP && skipReason }, async () => {
  // Segment 2 must be able to do exactly this without a migration. If this
  // test needs a schema change to pass, the architecture did not deliver.
  const id = await recordEvent(db, {
    ...base(),
    eventType: PATIENT_EVENTS.MEDICATION_STARTED,
    actorType: 'pharmacist',
    idempotencyKey: `medstart:${crypto.randomUUID()}`,
  });
  assert.ok(id, 'a reserved future event type must be recordable today');
});

test('a reserved entity type with no table yet is accepted, not verified into failure', { skip: SKIP && skipReason }, async () => {
  // medication_journey has no table. The entity check must skip rather than
  // throw, or Segment 2 could never reference its own records.
  const id = await recordEvent(db, {
    ...base(),
    eventType: PATIENT_EVENTS.MEDICATION_REMINDER_SENT,
    entityType: 'medication_journey',
    entityId: crypto.randomUUID(),
    idempotencyKey: `reminder:${crypto.randomUUID()}`,
  });
  assert.ok(id);
});

// ---- vocabulary --------------------------------------------------------

test('an unregistered event type is refused', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recordEvent(db, { ...base(), eventType: 'TOTALLY_MADE_UP' }),
    /Unknown event type/,
    'a typo must not silently become a new event type',
  );
});

test('an unregistered actor type is refused', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recordEvent(db, { ...base(), eventType: PATIENT_EVENTS.PATIENT_CREATED, actorType: 'wizard' }),
    /Unknown actor type/,
  );
});

test('an unregistered entity type is refused', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recordEvent(db, { ...base(), eventType: PATIENT_EVENTS.PATIENT_CREATED, entityType: 'spaceship' }),
    /Unknown entity type/,
  );
});

// ---- tenancy: the security requirement ---------------------------------

test('refuses to file an event against another pharmacy\'s customer', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recordEvent(db, {
      ...base(),
      pharmacyId: ctx.a.id,
      customerId: ctx.custB.id, // belongs to B
      entityId: ctx.custB.id,
      eventType: PATIENT_EVENTS.PATIENT_CREATED,
    }),
    /does not belong to pharmacy/,
    'one tenant\'s history must never be writable onto another\'s timeline',
  );
});

test('refuses an entity belonging to another pharmacy', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recordEvent(db, {
      ...base(),
      eventType: PATIENT_EVENTS.PRODUCT_VIEWED,
      entityType: 'product',
      entityId: ctx.prodB.id, // a real product, wrong tenant
      idempotencyKey: `view:${crypto.randomUUID()}`,
    }),
    /was not found in pharmacy/,
    'an event must not be able to link to another tenant\'s record',
  );
});

test('refuses an entity that does not exist at all', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recordEvent(db, {
      ...base(),
      eventType: PATIENT_EVENTS.ORDER_CONFIRMED,
      entityType: 'order',
      entityId: crypto.randomUUID(),
      idempotencyKey: `ord:${crypto.randomUUID()}`,
    }),
    /was not found in pharmacy/,
  );
});

// ---- idempotency, explicit key -----------------------------------------

test('the same idempotency key twice yields exactly one event', { skip: SKIP && skipReason }, async () => {
  const key = `explicit:${crypto.randomUUID()}`;
  const args = { ...base(), eventType: PATIENT_EVENTS.PATIENT_CREATED, idempotencyKey: key };

  const first = await recordEvent(db, args);
  const second = await recordEvent(db, args);

  assert.ok(first, 'first call records');
  assert.equal(second, null, 'a replay is a no-op, not an error');

  const [{ n }] = await db`
    select count(*)::int n from customer_events
    where pharmacy_id = ${ctx.a.id} and idempotency_key = ${key}`;
  assert.equal(n, 1);
});

test('DIFFERENT keys on the same entity both record — the bug 0018 fixes', { skip: SKIP && skipReason }, async () => {
  // Under 0017's composite key this was impossible: the second view of the
  // same product was silently discarded. Repeatable events (product views,
  // monthly refills, each reminder) are exactly what the reserved event
  // types describe, so this is the behaviour Segment 2 and 3 depend on.
  const [prodA] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, status)
    values (${ctx.a.id}, 'Alpha Product', ${'alpha-' + crypto.randomUUID()}, 12300, 'active')
    returning id`;

  const one = await recordEvent(db, {
    ...base(),
    eventType: PATIENT_EVENTS.PRODUCT_VIEWED,
    entityType: 'product', entityId: prodA.id,
    idempotencyKey: `view:${prodA.id}:1`,
  });
  const two = await recordEvent(db, {
    ...base(),
    eventType: PATIENT_EVENTS.PRODUCT_VIEWED,
    entityType: 'product', entityId: prodA.id,
    idempotencyKey: `view:${prodA.id}:2`,
  });

  assert.ok(one && two, 'both views must be recorded');
  assert.notEqual(one, two);
});

test('the same key is scoped per pharmacy, so tenants cannot collide', { skip: SKIP && skipReason }, async () => {
  const key = 'shared-key-value';
  const inA = await recordEvent(db, { ...base(), eventType: PATIENT_EVENTS.PATIENT_CREATED, idempotencyKey: key });
  const inB = await recordEvent(db, {
    pharmacyId: ctx.b.id, customerId: ctx.custB.id,
    actorType: 'system', entityType: 'customer', entityId: ctx.custB.id,
    eventType: PATIENT_EVENTS.PATIENT_CREATED, idempotencyKey: key,
  });
  assert.ok(inA && inB, 'an identical key in two tenants is two distinct events');
});

// ---- transactional integrity -------------------------------------------

test('a rolled-back transaction records no event', { skip: SKIP && skipReason }, async () => {
  const key = `rollback:${crypto.randomUUID()}`;
  await assert.rejects(() => db.begin(async (tx) => {
    await recordEvent(tx, { ...base(), eventType: PATIENT_EVENTS.ORDER_CONFIRMED, entityType: 'customer', entityId: ctx.custA.id, idempotencyKey: key });
    throw new Error('business action failed after the event was recorded');
  }));

  const [{ n }] = await db`
    select count(*)::int n from customer_events
    where pharmacy_id = ${ctx.a.id} and idempotency_key = ${key}`;
  assert.equal(n, 0, 'an event must never survive the transaction whose fact it describes');
});

// ---- occurred_at vs created_at -----------------------------------------

test('occurred_at is stored as given, independent of when the row was written', { skip: SKIP && skipReason }, async () => {
  const when = new Date('2026-01-15T09:30:00Z');
  const key = `backdated:${crypto.randomUUID()}`;
  await recordEvent(db, {
    ...base(), eventType: PATIENT_EVENTS.PATIENT_CREATED,
    occurredAt: when, idempotencyKey: key,
  });

  const [row] = await db`
    select occurred_at, created_at from customer_events
    where pharmacy_id = ${ctx.a.id} and idempotency_key = ${key}`;

  assert.equal(new Date(row.occurred_at).toISOString(), when.toISOString());
  assert.ok(
    new Date(row.created_at).getTime() > when.getTime(),
    'created_at is when we recorded it and must not be overwritten by occurred_at',
  );
});
