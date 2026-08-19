/**
 * Changing an order the pharmacy has not acted on yet.
 *
 * THE BOUNDARY THESE TESTS EXIST TO DEFEND
 * While an order is `pending`, editing it is free: no stock has moved
 * (commitStock runs on the first exit from pending), no pharmacist has agreed
 * to supply anything, and the customer has been told only that their request
 * was sent. So "actually make that 2" is just a conversation continuing.
 *
 * Once a human clicks confirm or ready, all three of those become false at
 * once — stock is off the shelf, the pharmacy is committed, and the customer
 * has been told it is reserved or ready. An edit then means a pharmacist
 * picking against a list that changed after they read it. The refusal is the
 * feature; the test below that asserts it is the most important one here.
 *
 * Real Postgres, because the guard is a `for update` row lock and a status
 * check inside one transaction — a mock would prove neither.
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
const skipReason = 'TEST_DATABASE_URL not set — order amendment NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'amendtest';

let db;
let orders;
let ctx = null;

async function mkProduct(pharmacyId, { name, price = 100000, qty = 50 }) {
  const [row] = await db`
    insert into products ${db({
      pharmacy_id: pharmacyId,
      name,
      natural_key: `${TAG}-${name}-${crypto.randomUUID()}`.toLowerCase(),
      price_kobo: price,
      stock_qty: qty,
      stock_tracked: true,
      status: 'active',
    }, 'pharmacy_id', 'name', 'natural_key', 'price_kobo', 'stock_qty', 'stock_tracked', 'status')}
    returning id, name
  `;
  return row;
}

/**
 * A fresh pending order in its OWN conversation.
 *
 * The separate conversation is load-bearing, not tidiness. createOrder folds
 * a new item into any order already pending in the same conversation (the
 * "anything else?" cart behaviour), so reusing one conversation across these
 * tests would silently merge every fixture into the first test's order —
 * which is exactly what happened when this file first ran, and it read as
 * five implementation bugs rather than one fixture mistake. One shopping trip
 * per conversation is also what the merge behaviour actually models.
 */
async function mkOrder(items) {
  // Closed first: a partial unique index (idx_conversations_one_open) allows
  // only one OPEN conversation per customer, which is the schema enforcing
  // the same "one live thread per person" rule the app relies on.
  //
  // workflow_state moves WITH status — conversations_workflow_matches_status
  // permits only open/ai_handling/waiting_* while open, and resolved/archived
  // once closed. Setting status alone violates the check.
  await db`
    update conversations set status = 'closed', workflow_state = 'resolved', closed_at = now()
    where customer_id = ${ctx.customerId} and status = 'open'
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, status, mode, last_message_at)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'open', 'bot', now())
    returning id
  `;
  const r = await orders.createOrder(ctx.pharmacyId, {
    customerId: ctx.customerId, conversationId: conv.id, items,
  });
  assert.equal(r.ok, true, `fixture order failed: ${r.error || ''}`);
  return r.order;
}

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
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name,
                           full_name, name_verified, name_source)
    values (${p.id}, '2349055555555', '2349055555555', '2349055555555@s.whatsapp.net', 'Amend Tester',
            'Amend Tester', true, 'customer_provided')
    returning id
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, status, mode, last_message_at)
    values (${p.id}, ${customer.id}, 'open', 'bot', now())
    returning id
  `;
  ctx = { userId, pharmacyId: p.id, customerId: customer.id, conversationId: conv.id };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`;
  await db`delete from auth.users where id = ${ctx.userId}`;
  await db.end({ timeout: 5 });
});

// ---- the ordinary cases ----

test('a quantity can be changed while the order is still pending', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend A', price: 50000 });
  const order = await mkOrder([{ productId: p.id, quantity: 2 }]);
  assert.equal(order.total_kobo, 100000);

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.order.total_kobo, 250000, 'the total must follow the new quantity');
  assert.equal(r.order.items.length, 1, 'changing a quantity must not add a line');
  assert.equal(r.order.items[0].quantity, 5);
});

test('quantity is the NEW total, not a difference', { skip: SKIP && skipReason }, async () => {
  // The tool's own description promises this. If it were treated as a delta,
  // "make that 2" on a line of 2 would silently become 4.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Absolute', price: 10000 });
  const order = await mkOrder([{ productId: p.id, quantity: 2 }]);

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 2 });
  assert.equal(r.order.items[0].quantity, 2, 'setting the same quantity must be a no-op, not a doubling');
});

test('quantity 0 removes the line but keeps the rest of the order', { skip: SKIP && skipReason }, async () => {
  const keep = await mkProduct(ctx.pharmacyId, { name: 'Amend Keep', price: 30000 });
  const drop = await mkProduct(ctx.pharmacyId, { name: 'Amend Drop', price: 70000 });
  const order = await mkOrder([{ productId: keep.id, quantity: 1 }, { productId: drop.id, quantity: 1 }]);

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: drop.id, quantity: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  assert.equal(r.order.items.length, 1);
  assert.equal(r.order.items[0].name_snapshot, 'Amend Keep');
  assert.equal(r.order.total_kobo, 30000, 'the removed line must leave the total');
  assert.equal(r.order.status, 'pending', 'an order with items left is still an order');
});

test('removing the LAST item cancels the order rather than leaving an empty one', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Last', price: 20000 });
  const order = await mkOrder([{ productId: p.id, quantity: 1 }]);

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);
  assert.equal(r.order.status, 'cancelled', 'an order with nothing on it is a change of mind, not a smaller order');
  assert.equal(r.order.total_kobo, 0);
});

test('the price comes from the line, not from a re-read of the catalogue', { skip: SKIP && skipReason }, async () => {
  // A customer was quoted a figure when the item was added. If the shelf
  // price changes before the pharmacy confirms, amending the QUANTITY must
  // not silently reprice what they already agreed to.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Reprice', price: 40000 });
  const order = await mkOrder([{ productId: p.id, quantity: 1 }]);

  await db`update products set price_kobo = 99999 where id = ${p.id}`;

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 2 });
  assert.equal(r.order.total_kobo, 80000, 'the quoted unit price must survive a catalogue change');
});

// ---- the boundary that matters most ----

test('a CONFIRMED order refuses to be amended', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Confirmed', price: 25000 });
  const order = await mkOrder([{ productId: p.id, quantity: 2 }]);
  await orders.updateStatus(ctx.pharmacyId, order.id, 'confirmed');

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 1 });
  assert.equal(r.ok, false, 'stock is committed and a person is picking this — it must not change under them');
  assert.equal(r.code, 'ALREADY_ACTIONED');
  assert.match(r.error, /confirmed/i, 'the customer needs to hear WHY, not a generic failure');

  const [after] = await db`select quantity from order_items where order_id = ${order.id}`;
  assert.equal(after.quantity, 2, 'the order must be untouched after a refusal');
});

test('an order marked READY straight from pending also refuses', { skip: SKIP && skipReason }, async () => {
  // The dashboard's merged one-click button goes pending -> ready, skipping
  // `confirmed` entirely. That path must be just as closed.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Ready', price: 15000 });
  const order = await mkOrder([{ productId: p.id, quantity: 1 }]);
  await orders.updateStatus(ctx.pharmacyId, order.id, 'ready');

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ALREADY_ACTIONED');
});

test('a cancelled order says there is nothing to change', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Cancelled', price: 15000 });
  const order = await mkOrder([{ productId: p.id, quantity: 1 }]);
  await orders.updateStatus(ctx.pharmacyId, order.id, 'cancelled');

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to change/i);
});

// ---- refusals that are not about status ----

test('a product not on the order is refused, not silently added', { skip: SKIP && skipReason }, async () => {
  const onOrder = await mkProduct(ctx.pharmacyId, { name: 'Amend On', price: 10000 });
  const notOnOrder = await mkProduct(ctx.pharmacyId, { name: 'Amend Off', price: 10000 });
  const order = await mkOrder([{ productId: onOrder.id, quantity: 1 }]);

  const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: notOnOrder.id, quantity: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_ON_ORDER', 'this tool changes lines; create_order adds them');
});

test('a negative or fractional quantity is refused rather than coerced', { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend BadQty', price: 10000 });
  const order = await mkOrder([{ productId: p.id, quantity: 1 }]);

  for (const bad of [-1, 1.5, 'two']) {
    const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.equal(r.code, 'BAD_QUANTITY');
  }

  const [untouched] = await db`select quantity from order_items where order_id = ${order.id}`;
  assert.equal(untouched.quantity, 1, 'a refused amendment must not have changed anything');
});

test('a MISSING quantity is refused, never treated as "remove"', { skip: SKIP && skipReason }, async () => {
  // Number(null) and Number(undefined-as-'') both coerce to 0, and 0 means
  // delete the line. So a model that omitted the field would silently remove
  // an item nobody asked to remove — the quietest possible way to lose a
  // customer's order. Removal must be an explicit 0.
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Missing', price: 10000 });
  const order = await mkOrder([{ productId: p.id, quantity: 3 }]);

  for (const missing of [null, undefined, '']) {
    const r = await orders.amendPendingOrder(ctx.pharmacyId, order.id, { productId: p.id, quantity: missing });
    assert.equal(r.ok, false, `${JSON.stringify(missing)} must not delete the line`);
    assert.equal(r.code, 'BAD_QUANTITY');
  }

  const [still] = await db`select quantity from order_items where order_id = ${order.id}`;
  assert.equal(still.quantity, 3, 'the line must survive every missing-quantity call');
});

test("another pharmacy cannot amend this one's order", { skip: SKIP && skipReason }, async () => {
  const p = await mkProduct(ctx.pharmacyId, { name: 'Amend Tenant', price: 10000 });
  const order = await mkOrder([{ productId: p.id, quantity: 1 }]);

  const otherPharmacyId = crypto.randomUUID();
  const r = await orders.amendPendingOrder(otherPharmacyId, order.id, { productId: p.id, quantity: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND', 'a foreign order must not even resolve');
});
