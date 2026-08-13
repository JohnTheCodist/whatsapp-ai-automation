/**
 * Stock reservation, against real Postgres.
 *
 * Two of these could not be written any other way. The concurrency test
 * fires overlapping orders for the last pack — the failure it guards against
 * only exists between a read and a write, so a mocked database would prove
 * nothing. The double-restore test guards a number moving in the direction
 * that causes overselling, which is discovered by a customer at the counter
 * rather than in a log.
 *
 * Skips loudly without TEST_DATABASE_URL.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — reservation NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'restest';

let db;
let orders;
let ctx = null;

/** Fresh product per test, so one test's holds cannot skew another's. */
async function mkProduct(pharmacyId, { name, qty, tracked = true, price = 100000 }) {
  const [row] = await db`
    insert into products ${db({
      pharmacy_id: pharmacyId,
      name,
      natural_key: `${TAG}-${name}-${crypto.randomUUID()}`.toLowerCase(),
      price_kobo: price,
      stock_qty: qty,
      stock_tracked: tracked,
      status: 'active',
    }, 'pharmacy_id', 'name', 'natural_key', 'price_kobo', 'stock_qty', 'stock_tracked', 'status')}
    returning id, name, stock_qty
  `;
  return row;
}

const stockOf = async (id) => (await db`select stock_qty from products where id = ${id}`)[0].stock_qty;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  orders = require('../services/orders/orderService');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userId = crypto.randomUUID();
  await db`insert into auth.users (id, email) values (${userId}, ${`${TAG}-${userId}@example.test`})`;
  const pharmacies = require('../services/pharmacies');
  const p = await pharmacies.createPharmacy(userId, { name: `${TAG} Alpha` });

  const [customer] = await db`
    -- Named up front: these tests exercise stock holds, and the name gate
    -- (0020) would otherwise refuse every order before stock is touched.
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name,
                           full_name, name_verified, name_source)
    values (${p.id}, '2349011111111', '2349011111111', '2349011111111@s.whatsapp.net', 'Res Tester',
            'Res Tester', true, 'customer_provided')
    returning id
  `;
  ctx = { userId, pharmacyId: p.id, customerId: customer.id };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`;
  await db`delete from auth.users where id = ${ctx.userId}`;
  await db.end({ timeout: 5 });
});

// ---- the hold ----

test('creating an order decrements stock immediately', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Hold A', qty: 10 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 3 }],
  });
  assert.equal(r.ok, true);
  assert.equal(await stockOf(p.id), 7, 'the hold must be real, not notional');
  assert.equal(r.order.stock_held, true);
  assert.ok(r.order.reserved_until, 'a hold without a deadline is stock lost forever');
});

test('a pending order is held but NOT promised', { skip: SKIP && skipReason }, async () => {
  // The whole two-stage design: stock moves, the customer is told nothing.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Hold B', qty: 5 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }],
  });
  assert.equal(r.order.status, 'pending', 'still awaiting a human');
  assert.equal(await stockOf(p.id), 4, 'but the pack is already off the shelf');
});

test('an untracked product holds nothing', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Untracked', qty: null, tracked: false });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 4 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.order.stock_held, false, 'nothing to decrement means nothing to restore later');
  assert.equal(await stockOf(p.id), null);
});

// ---- the race ----

test('two orders for the last pack: exactly one wins', { skip: SKIP && skipReason }, async () => {
  // The reason the conditional UPDATE exists. Both callers read stock_qty=1
  // and both believe they can have it; only the one whose UPDATE lands first
  // actually does.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Last Pack', qty: 1 });

  const [a, b] = await Promise.all([
    orders.createOrder(ctx.pharmacyId, { customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }] }),
    orders.createOrder(ctx.pharmacyId, { customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }] }),
  ]);

  const winners = [a, b].filter((r) => r.ok);
  assert.equal(winners.length, 1, 'both orders succeeded — the same pack was sold twice');
  assert.equal(await stockOf(p.id), 0, 'stock must never go negative');

  const loser = [a, b].find((r) => !r.ok);
  assert.equal(loser.code, 'INSUFFICIENT_STOCK');
});

test('a multi-line order never half-reserves', { skip: SKIP && skipReason }, async () => {
  // If the second line cannot be held, the first line's hold must roll back
  // with it — otherwise stock vanishes against an order that never existed.
  const ok = await mkProduct(ctx.pharmacyId, { name: 'Plenty', qty: 10 });
  const short = await mkProduct(ctx.pharmacyId, { name: 'Scarce', qty: 1 });

  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId,
    items: [{ productId: ok.id, quantity: 2 }, { productId: short.id, quantity: 5 }],
  });

  assert.equal(r.ok, false);
  assert.equal(await stockOf(ok.id), 10, 'the first line must have been rolled back');
  assert.equal(await stockOf(short.id), 1);
});

// ---- release ----

test('rejecting an order returns the stock', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Reject Me', qty: 10 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 4 }],
  });
  assert.equal(await stockOf(p.id), 6);

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'rejected');
  assert.equal(await stockOf(p.id), 10, 'a pack the pharmacy will not supply belongs back on the shelf');
});

test('cancelling a confirmed order returns the stock', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Cancel Me', qty: 8 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 2 }],
  });
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  assert.equal(await stockOf(p.id), 6, 'confirming must not double-decrement');

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'cancelled');
  assert.equal(await stockOf(p.id), 8);
});

test('COMPLETING an order does NOT return stock', { skip: SKIP && skipReason }, async () => {
  // That stock genuinely left with the customer. Restoring it here would
  // invent inventory that does not exist.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Collected', qty: 6 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 2 }],
  });
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'completed');
  assert.equal(await stockOf(p.id), 4);
});

test('stock is never restored twice', { skip: SKIP && skipReason }, async () => {
  // The failure this prevents inflates stock, which is the direction that
  // causes overselling — discovered by a customer, not by a log.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Double Restore', qty: 5 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 3 }],
  });
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'rejected');
  assert.equal(await stockOf(p.id), 5);

  // A second release attempt, directly against the guard.
  await db.begin(async (tx) => { await orders.releaseStock(tx, ctx.pharmacyId, r.order.id); });
  assert.equal(await stockOf(p.id), 5, 'stock was inflated by a second restore');
});

// ---- expiry ----

test('an expired hold returns its stock and cancels the order', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Expire Me', qty: 7 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 3 }],
  });
  assert.equal(await stockOf(p.id), 4);

  // Backdate the deadline rather than waiting two hours.
  await db`update orders set reserved_until = now() - interval '1 minute' where id = ${r.order.id}`;

  const expired = await orders.expireStaleHolds();
  assert.ok(expired.some((o) => o.id === r.order.id), 'the due order should have been swept');
  assert.equal(await stockOf(p.id), 7, 'held stock nobody confirmed must come back');

  const [after] = await db`select status from orders where id = ${r.order.id}`;
  assert.equal(after.status, 'cancelled');
});

test('a confirmed order is never expired out from under the customer', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Safe Once Confirmed', qty: 5 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 2 }],
  });
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');

  const [row] = await db`select reserved_until from orders where id = ${r.order.id}`;
  assert.equal(row.reserved_until, null, 'confirming must clear the countdown');

  await orders.expireStaleHolds();
  const [after] = await db`select status from orders where id = ${r.order.id}`;
  assert.equal(after.status, 'confirmed', 'a promise a human made must not lapse on a timer');
  assert.equal(await stockOf(p.id), 3);
});
