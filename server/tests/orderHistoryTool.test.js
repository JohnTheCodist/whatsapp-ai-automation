/**
 * get_order_history — the tool that exists so the AI never has to remember.
 *
 * Segment 1 §1 is explicit: the LLM's conversation context is temporary
 * working context, not the source of truth for customer history. "What did
 * I buy last time" answered from a few turns of context, or worse from the
 * model's own invention, is exactly the failure mode this tool closes off.
 * These tests exercise runTool directly against a real database, the same
 * way customerNameGate.test.js exercises orderService directly — a rule
 * this load-bearing has to be proven against the thing it actually queries,
 * not a mock of it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — order history retrieval was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const { runTool } = require('../services/ai/catalogueTools');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('History Test A', ${`hist-a-${Date.now()}`}, 'active')
    returning id
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('History Test B', ${`hist-b-${Date.now()}`}, 'active')
    returning id
  `;
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name, name_verified, name_source)
    values (${a.id}, '2349070000001', '2349070000001', '2349070000001@s.whatsapp.net', 'Order History Tester',
            'Order History Tester', true, 'customer_provided')
    returning id
  `;
  // A second customer on pharmacy A with NO orders, to prove an empty
  // history is reported as an explicit fact, not confused with an error.
  const [emptyCustomer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349070000002', '2349070000002', '2349070000002@s.whatsapp.net', 'No Orders Yet')
    returning id
  `;

  // Explicit, clearly-separated created_at values. Both rows inserted in one
  // statement would otherwise share (or nearly share) now(), making "newest
  // first" a coin flip rather than a real assertion — real orders are never
  // placed in the same millisecond, but a test fixture can accidentally do
  // exactly that.
  const [older, newer] = await db`
    insert into orders (pharmacy_id, customer_id, reference, status, total_kobo, created_at)
    values
      (${a.id}, ${customer.id}, 'HIST-OLD-1', 'completed', 197000, now() - interval '2 days'),
      (${a.id}, ${customer.id}, 'HIST-NEW-1', 'confirmed', 280000, now())
    returning id, reference
  `;

  await db`
    insert into order_items (order_id, pharmacy_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo)
    values
      (${older.id}, ${a.id}, 'Coartem 20/120mg', 197000, 1, 197000),
      (${newer.id}, ${a.id}, 'Condoms (Gold Circle) 3pk', 28000, 1, 28000)
  `;

  ctx = { pharmacyId: a.id, otherPharmacyId: b.id, customerId: customer.id, emptyCustomerId: emptyCustomer.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id in (${ctx.pharmacyId}, ${ctx.otherPharmacyId})`.catch(() => {});
});

test('returns real past orders with what was actually bought', { skip: SKIP && skipReason }, async () => {
  const result = await runTool({ pharmacyId: ctx.pharmacyId, customerId: ctx.customerId }, 'get_order_history', {});
  assert.equal(result.orders.length, 2);
  // Newest first — "what did I buy last time" means the most recent one.
  assert.equal(result.orders[0].reference, 'HIST-NEW-1');
  assert.equal(result.orders[0].items[0].name, 'Condoms (Gold Circle) 3pk');
  assert.equal(result.orders[1].reference, 'HIST-OLD-1');
  assert.equal(result.orders[1].items[0].name, 'Coartem 20/120mg');
});

test('a customer with no orders gets an explicit empty fact, not a silent list', { skip: SKIP && skipReason }, async () => {
  const result = await runTool({ pharmacyId: ctx.pharmacyId, customerId: ctx.emptyCustomerId }, 'get_order_history', {});
  assert.equal(result.orders.length, 0);
  assert.match(result.note, /no previous orders/i);
});

test('an unidentified customer (no customerId yet) is a distinct case from "no orders"', { skip: SKIP && skipReason }, async () => {
  const result = await runTool({ pharmacyId: ctx.pharmacyId, customerId: null }, 'get_order_history', {});
  assert.equal(result.orders.length, 0);
  assert.match(result.note, /not yet identified/i);
});

test('pharmacy B cannot retrieve pharmacy A\'s customer history', { skip: SKIP && skipReason }, async () => {
  // The real tenant-isolation check: same customerId, wrong pharmacyId. If
  // the query trusted customerId alone this would leak orders across tenants.
  const result = await runTool({ pharmacyId: ctx.otherPharmacyId, customerId: ctx.customerId }, 'get_order_history', {});
  assert.equal(result.orders.length, 0);
});

test('limit is honoured and capped at 10', { skip: SKIP && skipReason }, async () => {
  const capped = await runTool({ pharmacyId: ctx.pharmacyId, customerId: ctx.customerId }, 'get_order_history', { limit: 999 });
  assert.ok(capped.orders.length <= 10);

  const one = await runTool({ pharmacyId: ctx.pharmacyId, customerId: ctx.customerId }, 'get_order_history', { limit: 1 });
  assert.equal(one.orders.length, 1);
});

test('a name_snapshot survives a later product rename — history is frozen, not live', { skip: SKIP && skipReason }, async () => {
  // Simulates a catalogue product being renamed after the order was placed.
  // The tool must report what the customer actually received, not
  // whatever the product is called today.
  const [p] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, status)
    values (${ctx.pharmacyId}, 'Panadol Extra', ${`hist-test-panadol-${Date.now()}`}, 50000, 'active')
    returning id
  `;
  const [order] = await db`
    insert into orders (pharmacy_id, customer_id, reference, status, total_kobo)
    values (${ctx.pharmacyId}, ${ctx.customerId}, 'HIST-RENAME-1', 'completed', 50000)
    returning id
  `;
  await db`
    insert into order_items (order_id, pharmacy_id, product_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo)
    values (${order.id}, ${ctx.pharmacyId}, ${p.id}, 'Panadol Extra', 50000, 1, 50000)
  `;
  await db`update products set name = 'Panadol Extra (Reformulated)' where id = ${p.id}`;

  const result = await runTool({ pharmacyId: ctx.pharmacyId, customerId: ctx.customerId }, 'get_order_history', { limit: 1 });
  assert.equal(result.orders[0].items[0].name, 'Panadol Extra',
    'must report the name at time of order, not the catalogue\'s current name');
});
