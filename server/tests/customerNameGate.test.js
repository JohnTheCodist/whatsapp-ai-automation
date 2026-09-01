/**
 * The name gate: a pharmacy does not hold stock for an anonymous stranger.
 *
 * The rule lives in orderService.createOrder, NOT in the calling tool. A model
 * deciding whether a customer has given their name would mean the rule holds
 * only as often as the prompt is obeyed — and a future caller (a staff-created
 * order, an API) would silently not have the gate at all. These tests exercise
 * the service directly for exactly that reason.
 *
 * The ordering assertion matters more than it looks: being asked for your name
 * and THEN told the product is unavailable is a worse conversation than being
 * told first, so the stock and catalogue checks deliberately run before the
 * name check.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Same bootstrap as the other database tests. Without loading .env first this
// file skips every case and reports "0 fail" — which reads as passing and is
// the reason a skip here names what went unverified.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the name gate was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const { createOrder } = require('../services/orders/orderService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [user] = await db`
    insert into auth.users (id, email) values (gen_random_uuid(), ${`namegate-${Date.now()}@test.local`})
    on conflict do nothing returning id
  `;
  const userId = user?.id || (await db`select id from auth.users limit 1`)[0].id;

  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Name Gate Pharmacy', ${`name-gate-${Date.now()}`}, 'active')
    returning id
  `;
  await db`insert into pharmacy_members (pharmacy_id, user_id, role) values (${p.id}, ${userId}, 'owner')`;

  const [product] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, stock_qty, stock_tracked, status)
    values (${p.id}, 'Gate Test Tablets', ${`gate-test-${Date.now()}`}, 50000, 10, true, 'active')
    returning id
  `;

  // Two customers, identical except for whether they have given a name.
  const [anon] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${p.id}, '2349070000001', '2349070000001', '2349070000001@s.whatsapp.net', 'Anon Phone Name')
    returning id
  `;
  const [named] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name,
                           full_name, name_verified, name_source)
    values (${p.id}, '2349070000002', '2349070000002', '2349070000002@s.whatsapp.net', 'Whatever Phone Says',
            'Ada Obi', true, 'customer_provided')
    returning id
  `;

  ctx = { pharmacyId: p.id, productId: product.id, anonId: anon.id, namedId: named.id };
});

after(async () => {
  if (!SKIP && db) await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

test('a customer who has not given a name cannot create an order', { skip: SKIP && skipReason }, async () => {
  const r = await createOrder(ctx.pharmacyId, {
    customerId: ctx.anonId,
    items: [{ productId: ctx.productId, quantity: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NEEDS_CUSTOMER_NAME');
});

test('the WhatsApp display name does NOT satisfy the gate', { skip: SKIP && skipReason }, async () => {
  // The anonymous customer has display_name 'Anon Phone Name'. That is the
  // pushName from their own handset — a device name, a shop name or an emoji
  // just as often as a real one — and must never end up on a reservation.
  const [c] = await db`select display_name, full_name from customers where id = ${ctx.anonId}`;
  assert.ok(c.display_name, 'fixture should have a display name');
  assert.equal(c.full_name, null);

  const r = await createOrder(ctx.pharmacyId, {
    customerId: ctx.anonId,
    items: [{ productId: ctx.productId, quantity: 1 }],
  });
  assert.equal(r.code, 'NEEDS_CUSTOMER_NAME', 'a pushName is not a customer-provided name');
});

test('no stock is held by a refused order', { skip: SKIP && skipReason }, async () => {
  const [before_] = await db`select stock_qty from products where id = ${ctx.productId}`;
  await createOrder(ctx.pharmacyId, {
    customerId: ctx.anonId,
    items: [{ productId: ctx.productId, quantity: 1 }],
  });
  const [after_] = await db`select stock_qty from products where id = ${ctx.productId}`;
  assert.equal(after_.stock_qty, before_.stock_qty, 'a refusal must not decrement stock');
});

test('a customer who HAS given a name orders normally', { skip: SKIP && skipReason }, async () => {
  const r = await createOrder(ctx.pharmacyId, {
    customerId: ctx.namedId,
    items: [{ productId: ctx.productId, quantity: 1 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.order.reference);
});

test('an unavailable product is reported BEFORE the customer is asked their name', { skip: SKIP && skipReason }, async () => {
  // Order of checks is a conversation-design decision, not an accident:
  // "what's your name?" followed by "actually we don't have that" wastes the
  // customer's time and makes the assistant look thoughtless.
  const r = await createOrder(ctx.pharmacyId, {
    customerId: ctx.anonId,
    items: [],
  });
  assert.equal(r.code, 'NO_ITEMS', 'item validation should run before the name gate');
});
