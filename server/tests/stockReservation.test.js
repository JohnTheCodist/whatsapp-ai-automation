/**
 * Stock commitment, against real Postgres.
 *
 * Two of these could not be written any other way. The concurrency test
 * fires overlapping confirms for the last pack — the failure it guards
 * against only exists between a read and a write, so a mocked database would
 * prove nothing. The double-restore test guards a number moving in the
 * direction that causes overselling, which is discovered by a customer at
 * the counter rather than in a log.
 *
 * WHAT CHANGED FROM THE ORIGINAL VERSION OF THIS FILE
 * Stock used to commit at order creation — `pending` held the pack so a
 * second customer could not be sold it while a pharmacist decided. It now
 * commits on the first transition OUT of `pending` (to `confirmed`, or
 * straight to `ready` — the dashboard offers one button that does both at
 * once). A `pending` order holds nothing at all: two customers can both have
 * a pending order for the last pack, and nothing is at stake until a human
 * acts on one of them.
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
const skipReason = 'TEST_DATABASE_URL not set — stock commitment NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'restest';

let db;
let orders;
let ctx = null;

/** Fresh product per test, so one test's commits cannot skew another's. */
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
    -- Named up front: these tests exercise stock commitment, and the name
    -- gate (0020) would otherwise refuse every order before stock is touched.
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

// ---- pending holds nothing ----

test('creating an order does NOT touch stock', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Hold A', qty: 10 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 3 }],
  });
  assert.equal(r.ok, true);
  assert.equal(await stockOf(p.id), 10, 'a request nobody has looked at must not move stock');
  assert.equal(r.order.stock_held, false);
  assert.equal(r.order.reserved_until, null, 'nothing is held, so there is no countdown to hold it on');
});

test('a pending order is neither held nor promised', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Hold B', qty: 5 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }],
  });
  assert.equal(r.order.status, 'pending', 'still awaiting a human');
  assert.equal(await stockOf(p.id), 5, 'and the pack has not moved either');
});

test('two customers can both hold a PENDING order for the last pack', { skip: SKIP && skipReason }, async () => {
  // The opposite of the old behaviour, deliberately: nothing is reserved by
  // a message alone, so there is no race to lose at this stage.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Both Pending', qty: 1 });

  const [a, b] = await Promise.all([
    orders.createOrder(ctx.pharmacyId, { customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }] }),
    orders.createOrder(ctx.pharmacyId, { customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }] }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(await stockOf(p.id), 1, 'two pending requests, still one pack on the shelf');
});

test('an untracked product commits nothing even once confirmed', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Untracked', qty: null, tracked: false });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 4 }],
  });
  assert.equal(r.ok, true);
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  assert.equal(await stockOf(p.id), null, 'nothing to decrement means nothing to restore later');
});

// ---- the race moved to confirm time ----

test('two confirms for the last pack: exactly one wins', { skip: SKIP && skipReason }, async () => {
  // The reason the conditional UPDATE exists — now inside commitStock, run
  // from updateStatus instead of createOrder. Both pending orders exist
  // simultaneously (see the test above); this is what happens when a human
  // finally acts on both of them.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Last Pack', qty: 1 });

  const [a, b] = await Promise.all([
    orders.createOrder(ctx.pharmacyId, { customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }] }),
    orders.createOrder(ctx.pharmacyId, { customerId: ctx.customerId, items: [{ productId: p.id, quantity: 1 }] }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const [confirmA, confirmB] = await Promise.all([
    orders.updateStatus(ctx.pharmacyId, a.order.id, 'ready'),
    orders.updateStatus(ctx.pharmacyId, b.order.id, 'ready'),
  ]);

  const winners = [confirmA, confirmB].filter((r) => r.ok);
  assert.equal(winners.length, 1, 'both confirms succeeded — the same pack was committed twice');
  assert.equal(await stockOf(p.id), 0, 'stock must never go negative');

  const loser = [confirmA, confirmB].find((r) => !r.ok);
  assert.equal(loser.code, 'INSUFFICIENT_STOCK');
});

test('a multi-line order never half-commits', { skip: SKIP && skipReason }, async () => {
  // If the second line cannot commit, the first line's commit must roll
  // back with it — otherwise stock vanishes against an order a pharmacist
  // never actually agreed to in full.
  //
  // Ordered within what both products have in stock right now, so the
  // creation-time pre-check (a friendly, non-atomic message — see the module
  // header) lets it through; the race this test proves is the one at CONFIRM
  // time, which is where correctness now actually lives.
  const ok = await mkProduct(ctx.pharmacyId, { name: 'Plenty', qty: 10 });
  const short = await mkProduct(ctx.pharmacyId, { name: 'Scarce', qty: 3 });

  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId,
    items: [{ productId: ok.id, quantity: 2 }, { productId: short.id, quantity: 3 }],
  });
  assert.equal(r.ok, true, 'creation does not check the race, only confirm does');

  // Someone else takes "Scarce" entirely while this order sits pending —
  // exactly the gap that no longer exists at creation time, but now must be
  // caught here instead.
  await db`update products set stock_qty = 0 where id = ${short.id}`;

  const confirm = await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  assert.equal(confirm.ok, false);
  assert.equal(confirm.code, 'INSUFFICIENT_STOCK');
  assert.equal(await stockOf(ok.id), 10, 'the first line must have been rolled back');
});

// ---- release ----

test('rejecting a pending order returns nothing, because nothing was taken', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Reject Me', qty: 10 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 4 }],
  });
  assert.equal(await stockOf(p.id), 10);

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'rejected');
  assert.equal(await stockOf(p.id), 10, 'stock never moved, so rejecting has nothing to give back');
});

test('cancelling a confirmed order returns the stock it committed', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Cancel Me', qty: 8 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 2 }],
  });
  assert.equal(await stockOf(p.id), 8, 'still untouched while pending');

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  assert.equal(await stockOf(p.id), 6, 'confirming is what commits it');

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'cancelled');
  assert.equal(await stockOf(p.id), 8);
});

test('cancelling an order marked ready straight from pending also returns the stock', { skip: SKIP && skipReason }, async () => {
  // The merged dashboard button: pending -> ready in one hop, skipping
  // `confirmed` entirely. Stock must still commit exactly once, and still
  // release cleanly on a later cancel.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Ready Direct', qty: 6 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 2 }],
  });

  const ready = await orders.updateStatus(ctx.pharmacyId, r.order.id, 'ready');
  assert.equal(ready.ok, true);
  assert.equal(ready.order.stock_held, true);
  assert.equal(await stockOf(p.id), 4, 'the single click both confirmed and readied it');

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'cancelled');
  assert.equal(await stockOf(p.id), 6);
});

test('confirmed then ready does not double-commit', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'No Double Commit', qty: 9 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 3 }],
  });

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  assert.equal(await stockOf(p.id), 6);

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'ready');
  assert.equal(await stockOf(p.id), 6, 'the second transition must not commit a second time');
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
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');
  assert.equal(await stockOf(p.id), 2);

  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'cancelled');
  assert.equal(await stockOf(p.id), 5);

  // A second release attempt, directly against the guard.
  await db.begin(async (tx) => { await orders.releaseStock(tx, ctx.pharmacyId, r.order.id); });
  assert.equal(await stockOf(p.id), 5, 'stock was inflated by a second restore');
});

// ---- the hold-expiry sweep is now a no-op for pending orders ----

test('expireStaleHolds finds nothing to expire — pending orders hold nothing to lose', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Never Expires', qty: 7 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 3 }],
  });
  assert.equal(await stockOf(p.id), 7);

  const expired = await orders.expireStaleHolds();
  assert.ok(!expired.some((o) => o.id === r.order.id), 'a pending order with nothing held must not be swept');

  const [after] = await db`select status from orders where id = ${r.order.id}`;
  assert.equal(after.status, 'pending', 'still sitting in the queue, exactly as left');
  assert.equal(await stockOf(p.id), 7);
});

test('a confirmed order is never touched by the sweep', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Safe Once Confirmed', qty: 5 });
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, items: [{ productId: p.id, quantity: 2 }],
  });
  await orders.updateStatus(ctx.pharmacyId, r.order.id, 'confirmed');

  const [row] = await db`select reserved_until from orders where id = ${r.order.id}`;
  assert.equal(row.reserved_until, null);

  await orders.expireStaleHolds();
  const [after] = await db`select status from orders where id = ${r.order.id}`;
  assert.equal(after.status, 'confirmed', 'a promise a human made must not lapse on a timer');
  assert.equal(await stockOf(p.id), 3);
});
