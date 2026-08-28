/**
 * Orders, against real Postgres.
 *
 * The rule under test above all others: THE CALLER DOES NOT SET PRICES.
 * createOrder takes product ids and quantities and reads every figure from
 * the catalogue itself. The model has already been observed asserting things
 * that were not true; if it could also assert a price, a hallucinated number
 * would become a real total and an argument at the counter.
 *
 * Skips loudly without TEST_DATABASE_URL, like the other integration suites.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — orders NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'ordertest';

let db;
let orders;
let ctx = null;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  orders = require('../services/orders/orderService');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  const mkProduct = async (pharmacyId, fields) => {
    const [row] = await db`
      insert into products ${db({
        pharmacy_id: pharmacyId,
        name: fields.name,
        natural_key: `${TAG}-${fields.name}`.toLowerCase(),
        price_kobo: fields.price_kobo,
        stock_qty: fields.stock_qty ?? null,
        stock_tracked: fields.stock_tracked ?? false,
        status: fields.status || 'active',
      }, 'pharmacy_id', 'name', 'natural_key', 'price_kobo', 'stock_qty', 'stock_tracked', 'status')}
      returning id, name, price_kobo
    `;
    return row;
  };

  const [customer] = await db`
    -- full_name is required before an order can be created (0020). These
    -- tests are about pricing and stock, so the fixture arrives already
    -- named; the name gate itself is covered in customerNameGate.test.js.
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name,
                           full_name, name_verified, name_source)
    values (${a.id}, '2349013993683', '2349013993683', '2349013993683@s.whatsapp.net', 'Test Customer',
            'Test Customer', true, 'customer_provided')
    returning id
  `;

  ctx = {
    userA, userB, a, b, customerId: customer.id,
    // Deliberately generous: since 0010, every createOrder in this file
    // actually decrements stock. A tight number here would make later tests
    // fail for running out rather than for the thing they assert.
    priced:    await mkProduct(a.id, { name: 'Amoxicillin 500mg', price_kobo: 156000, stock_tracked: true, stock_qty: 500 }),
    unpriced:  await mkProduct(a.id, { name: 'Mystery Syrup',     price_kobo: null }),
    lowStock:  await mkProduct(a.id, { name: 'Coartem',           price_kobo: 197000, stock_tracked: true, stock_qty: 2 }),
    hidden:    await mkProduct(a.id, { name: 'Withdrawn Tabs',    price_kobo: 100000, status: 'hidden' }),
    otherTenant: await mkProduct(b.id, { name: 'Beta Only',       price_kobo: 500000 }),
  };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- the price rule ----

test('the price comes from the catalogue, not from the caller', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    // A caller trying to dictate money. These keys are not in the signature
    // and must have no effect whatsoever.
    items: [{ productId: ctx.priced.id, quantity: 2, price_kobo: 1, unit_price_kobo: 1, price: 0.01 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.items[0].unit_price_kobo, 156000, 'the catalogue price must win');
  assert.equal(r.order.total_kobo, 312000, '2 x ₦1,560, computed server-side');
});

test('the total is computed, never accepted', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.priced.id, quantity: 3 }],
    total_kobo: 1, totalKobo: 1,
  });
  assert.equal(r.order.total_kobo, 468000);
});

// ---- refusals the customer can be told about ----

test('an unpriced product cannot be ordered', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.unpriced.id, quantity: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_PRICE');
  assert.match(r.error, /no price/i, 'unknown is not free — the reason must say so');
});

test('ordering more than the stock on hand is refused, with the number', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.lowStock.id, quantity: 5 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INSUFFICIENT_STOCK');
  assert.match(r.error, /only 2/, 'the customer should hear how many there are');
});

test('a non-active product is refused', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.hidden.id, quantity: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PRODUCT_UNAVAILABLE');
});

test("another pharmacy's product simply does not resolve", { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.otherTenant.id, quantity: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_PRODUCT', 'a leaked id from another tenant must not be orderable');
});

test('bad quantities are refused rather than coerced', { skip: SKIP && skipReason }, async () => {
  for (const quantity of [0, -1, 1.5, 'two', null, NaN]) {
    const r = await orders.createOrder(ctx.a.id, {
      customerId: ctx.customerId,
      items: [{ productId: ctx.priced.id, quantity }],
    });
    assert.equal(r.ok, false, `quantity ${JSON.stringify(quantity)} should be refused`);
  }
});

test('a wholesale-sized quantity is refused against the shelf, with the number', { skip: SKIP && skipReason }, async () => {
  // Was asserted as QUANTITY_TOO_LARGE, against a fixed ceiling of 100.
  // There is no policy ceiling any more — the limit IS the stock — so a
  // request for 5000 is a stock answer, not a rule answer, and it must carry
  // the number the pharmacy CAN do. A refusal without that number is what had
  // a customer guessing 205, then 135, then 100.
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.priced.id, quantity: 5000 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INSUFFICIENT_STOCK');
  assert.ok(Number.isInteger(r.maxQuantity), 'the caller cannot offer a number it was not given');
  assert.match(r.error, new RegExp(String(r.maxQuantity)), 'the number must be in the sentence the customer reads');
});

test('an empty order is refused', { skip: SKIP && skipReason }, async () => {
  assert.equal((await orders.createOrder(ctx.a.id, { customerId: ctx.customerId, items: [] })).ok, false);
});

// ---- shape ----

test('the same product twice is collapsed, not duplicated', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId,
    items: [{ productId: ctx.priced.id, quantity: 2 }, { productId: ctx.priced.id, quantity: 1 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.order.items.length, 1, 'one line, not two');
  assert.equal(r.order.items[0].quantity, 3);
  assert.equal(r.order.total_kobo, 468000);
});

test('an order starts PENDING — it is a request, not an agreement', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId, items: [{ productId: ctx.priced.id, quantity: 1 }],
  });
  assert.equal(r.order.status, 'pending');
});

test('the reference avoids characters people misread aloud', { skip: SKIP && skipReason }, async () => {
  for (let i = 0; i < 200; i++) {
    // Counter staff read these back over a phone line in a noisy shop.
    assert.ok(!/[01OIL58BS]/.test(orders.generateReference()), 'ambiguous character in reference');
  }
});

// ---- staff transitions ----

test('a pending order can be confirmed, and history is written', { skip: SKIP && skipReason }, async () => {
  const created = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId, items: [{ productId: ctx.priced.id, quantity: 1 }],
  });
  const r = await orders.updateStatus(ctx.a.id, created.order.id, 'confirmed', { note: 'ok' });
  assert.equal(r.ok, true);
  assert.equal(r.order.status, 'confirmed');

  const history = await db`select from_status, to_status from order_status_history
                           where order_id = ${created.order.id} order by changed_at`;
  assert.equal(history.length, 2, 'creation and confirmation are both recorded');
  assert.deepEqual(history[1], { from_status: 'pending', to_status: 'confirmed' });
});

test('a completed order cannot be walked backwards', { skip: SKIP && skipReason }, async () => {
  const created = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId, items: [{ productId: ctx.priced.id, quantity: 1 }],
  });
  await orders.updateStatus(ctx.a.id, created.order.id, 'confirmed');
  await orders.updateStatus(ctx.a.id, created.order.id, 'completed');

  const r = await orders.updateStatus(ctx.a.id, created.order.id, 'pending');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_TRANSITION', 'a mis-click must not rewrite what the customer was told');
});

test("one pharmacy cannot change another's order", { skip: SKIP && skipReason }, async () => {
  const created = await orders.createOrder(ctx.a.id, {
    customerId: ctx.customerId, items: [{ productId: ctx.priced.id, quantity: 1 }],
  });
  const r = await orders.updateStatus(ctx.b.id, created.order.id, 'confirmed');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('the tenant guard fires on a missing pharmacy id', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => orders.createOrder(undefined, { customerId: ctx.customerId, items: [{ productId: ctx.priced.id, quantity: 1 }] }),
    /Tenant guard/,
  );
});
