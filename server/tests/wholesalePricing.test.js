/**
 * The wholesale price tier, against real Postgres.
 *
 * WHAT THIS PROTECTS
 * 0040 gave customers a customer_type and the QR code that sets it, and then
 * priced everyone from the single price_kobo column anyway — a trade account
 * was identified correctly and charged retail. 0043 added the second column;
 * these tests are the reason it cannot quietly stop being used.
 *
 * The rule under test above all others: A CUSTOMER IS PRICED BY THEIR OWN
 * ACCOUNT TYPE, AND ONLY EVER SEES ONE PRICE. Not the tier a caller passed
 * in, not a fallback to whichever figure exists. An order that commits at a
 * different tier than the assistant quoted is an argument at the counter.
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
const skipReason = 'TEST_DATABASE_URL not set — wholesale pricing NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'wholesaletest';

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

  const user = crypto.randomUUID();
  await db`insert into auth.users (id, email) values (${user}, ${`${TAG}-${user}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const ph = await pharmacies.createPharmacy(user, { name: `${TAG} Alpha` });

  const mkProduct = async (fields) => {
    const [row] = await db`
      insert into products ${db({
        pharmacy_id: ph.id,
        name: fields.name,
        natural_key: `${TAG}-${fields.name}`.toLowerCase(),
        price_kobo: fields.price_kobo,
        wholesale_price_kobo: fields.wholesale_price_kobo ?? null,
        stock_qty: 500,
        stock_tracked: true,
        status: 'active',
      }, 'pharmacy_id', 'name', 'natural_key', 'price_kobo', 'wholesale_price_kobo',
         'stock_qty', 'stock_tracked', 'status')}
      returning id, name, price_kobo, wholesale_price_kobo
    `;
    return row;
  };

  const mkCustomer = async (type, phone) => {
    const [row] = await db`
      insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name,
                             full_name, name_verified, name_source, customer_type)
      values (${ph.id}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, 'Test',
              'Test Buyer', true, 'customer_provided', ${type})
      returning id, customer_type
    `;
    return row;
  };

  ctx = {
    user,
    ph,
    // Both tiers priced. The gap is deliberately large so a wrong tier is
    // unmistakable in an assertion rather than an off-by-rounding.
    bothTiers: await mkProduct({ name: 'Amoxicillin 500mg', price_kobo: 200000, wholesale_price_kobo: 120000 }),
    // Retail only — the case the "no fallback" rule is about.
    retailOnly: await mkProduct({ name: 'Counter Only Syrup', price_kobo: 150000 }),
    retailCustomer: await mkCustomer('retail', '2349013993601'),
    wholesaleCustomer: await mkCustomer('wholesale', '2349013993602'),
  };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id = ${ctx.ph.id}`;
  await db`delete from auth.users where id = ${ctx.user}`;
  await db.end({ timeout: 5 });
});

// ---- the tier rule ----

test('a retail customer is charged the retail price', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.ph.id, {
    customerId: ctx.retailCustomer.id,
    items: [{ productId: ctx.bothTiers.id, quantity: 2 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.items[0].unit_price_kobo, 200000, 'retail column, not wholesale');
  assert.equal(r.order.total_kobo, 400000);
});

test('a wholesale customer is charged the wholesale price', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.ph.id, {
    customerId: ctx.wholesaleCustomer.id,
    items: [{ productId: ctx.bothTiers.id, quantity: 2 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.items[0].unit_price_kobo, 120000, 'wholesale column, not retail');
  assert.equal(r.order.total_kobo, 240000);
});

test('the tier comes from the customer record, not from the caller', { skip: SKIP && skipReason }, async () => {
  // A caller trying to dictate the tier. These keys are not in the signature
  // and must have no effect whatsoever — the same rule the price itself has.
  const r = await orders.createOrder(ctx.ph.id, {
    customerId: ctx.retailCustomer.id,
    customerType: 'wholesale',
    tier: 'wholesale',
    wholesale: true,
    items: [{ productId: ctx.bothTiers.id, quantity: 1 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.items[0].unit_price_kobo, 200000, 'a retail customer stays retail');
});

// ---- no silent fallback ----

test('a wholesale customer CANNOT order a product with no wholesale price', { skip: SKIP && skipReason }, async () => {
  const r = await orders.createOrder(ctx.ph.id, {
    customerId: ctx.wholesaleCustomer.id,
    items: [{ productId: ctx.retailOnly.id, quantity: 1 }],
  });
  assert.equal(r.ok, false, 'must not fall back to the retail price');
  assert.equal(r.code, 'NO_PRICE');
  assert.match(r.error, /no wholesale price/i, 'the message must name the missing WHOLESALE price, not read as generally unpriced');
});

test('the same product still sells normally to a retail customer', { skip: SKIP && skipReason }, async () => {
  // The other half of the rule above: "not on the trade list" must not mean
  // "withdrawn". A retail-only product is exactly what most of the catalogue
  // is, and it has to keep selling at the counter.
  const r = await orders.createOrder(ctx.ph.id, {
    customerId: ctx.retailCustomer.id,
    items: [{ productId: ctx.retailOnly.id, quantity: 1 }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.order.items[0].unit_price_kobo, 150000);
});
