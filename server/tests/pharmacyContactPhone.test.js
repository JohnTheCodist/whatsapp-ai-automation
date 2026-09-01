/**
 * The customer-facing contact number: saved with real normalisation, and
 * surfaced to the assistant only through contact_pharmacy — never invented,
 * never leaked across tenants, and audited exactly when it is actually
 * handed to a customer.
 *
 * DB-backed, the same discipline as customerNameGate.test.js and
 * orderHistoryTool.test.js: this rule only matters if it holds against the
 * real table and the real tool runner, not a mock of either.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the customer contact number was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const { updateProfile, getProfile } = require('../services/pharmacies');
const { runTool } = require('../services/ai/catalogueTools');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Contact Test A', ${`contact-a-${Date.now()}`}, 'active')
    returning id
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('Contact Test B', ${`contact-b-${Date.now()}`}, 'active')
    returning id
  `;
  // Pre-seeded here for A and B — the ordinary case, matching what
  // createPharmacy() does. Deliberately NOT done for a third pharmacy
  // below: that gap is real (found live, not hypothetical — see the test
  // named for it) and updateProfile has to work without it.
  await db`insert into pharmacy_profile (pharmacy_id) values (${a.id}), (${b.id})`;

  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349090000001', '2349090000001', '2349090000001@s.whatsapp.net', 'Contact Tester')
    returning id
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${a.id}, ${customer.id}, 'bot', now())
    returning id
  `;

  ctx = { pharmacyA: a.id, pharmacyB: b.id, customerId: customer.id, conversationId: conv.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id in (${ctx.pharmacyA}, ${ctx.pharmacyB})`.catch(() => {});
});

// ---- normalisation on save -----------------------------------------------

test('a local-format and international-format number save to the SAME value', { skip: SKIP && skipReason }, async () => {
  const local = await updateProfile(ctx.pharmacyA, { phone: '08012345678' });
  const localStored = local.phone;

  const intl = await updateProfile(ctx.pharmacyA, { phone: '+2348012345678' });
  assert.equal(intl.phone, localStored, '0801... and +234801... must collapse to one stored value');
});

test('a pharmacy with NO profile row yet still saves — found live, not hypothetical', { skip: SKIP && skipReason }, async () => {
  // A real dev pharmacy in this system had no pharmacy_profile row at all —
  // predating whenever createPharmacy() started inserting one — and its
  // very first save of this feature 404'd with "Profile not found" even
  // though the pharmacy plainly existed. "Every pharmacy has a profile row"
  // was an app-level convention, not something the schema enforced, so it
  // had already drifted at least once. updateProfile upserts specifically
  // so this cannot happen again regardless of how a pharmacy's row came to
  // be missing.
  const [c] = await db`
    insert into pharmacies (name, slug, status)
    values ('No Profile Row Yet', ${`no-profile-${Date.now()}`}, 'active')
    returning id
  `;
  const noExistingRow = await db`select 1 from pharmacy_profile where pharmacy_id = ${c.id}`;
  assert.equal(noExistingRow.length, 0, 'test setup: this pharmacy must genuinely have no profile row');

  const saved = await updateProfile(c.id, { phone: '08099998888' });
  assert.ok(saved, 'the save must succeed rather than returning null for a pharmacy that exists');
  assert.equal(saved.phone, '2348099998888');

  const reread = await getProfile(c.id);
  assert.equal(reread.phone, '2348099998888', 'must also read back correctly, not just on the write response');

  await db`delete from pharmacies where id = ${c.id}`;
});

test('garbage input is rejected, not silently stored', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => updateProfile(ctx.pharmacyA, { phone: 'not a number' }),
    /valid.*phone/i,
  );
});

test('an explicit null clears a previously-saved number', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyA, { phone: '08012345678' });
  const cleared = await updateProfile(ctx.pharmacyA, { phone: null });
  assert.equal(cleared.phone, null);
});

// ---- contact_pharmacy: grounding, tenancy, audit -------------------------

test('a configured number is returned to the assistant, formatted for a customer to read', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyA, { phone: '08087654321' });

  const result = await runTool(
    { pharmacyId: ctx.pharmacyA, conversationId: ctx.conversationId, customerId: ctx.customerId },
    'contact_pharmacy', { reason: 'automation_limit' },
  );
  assert.equal(result.available, true);
  assert.match(result.phone, /^\+234/, 'must read as an obvious phone number, not raw digits');
});

test('no configured number: unavailable, and nothing is invented', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyB, { phone: null });

  const result = await runTool(
    { pharmacyId: ctx.pharmacyB, conversationId: null, customerId: null },
    'contact_pharmacy', { reason: 'automation_limit' },
  );
  assert.equal(result.available, false);
  assert.ok(!('phone' in result), 'must not include a phone key at all when none is configured');
});

test('pharmacy B can never retrieve pharmacy A\'s number', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyA, { phone: '08011112222' });
  await updateProfile(ctx.pharmacyB, { phone: null });

  const result = await runTool(
    { pharmacyId: ctx.pharmacyB, conversationId: null, customerId: null },
    'contact_pharmacy', { reason: 'automation_limit' },
  );
  assert.equal(result.available, false, 'pharmacy B has no number of its own — A\'s must never leak in');
});

test('providing the number records PHARMACY_CONTACT_PROVIDED with the reason given', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyA, { phone: '08033334444' });

  await runTool(
    { pharmacyId: ctx.pharmacyA, conversationId: ctx.conversationId, customerId: ctx.customerId },
    'contact_pharmacy', { reason: 'customer_requested_direct_contact' },
  );

  // id desc, not created_at desc — this customer already has an earlier
  // PHARMACY_CONTACT_PROVIDED row from test 4, and two events inserted
  // within the same clock tick make created_at ordering ambiguous. id is
  // monotonic regardless of timestamp resolution.
  const [event] = await db`
    select event_type, metadata from customer_events
    where customer_id = ${ctx.customerId} and event_type = 'PHARMACY_CONTACT_PROVIDED'
    order by id desc limit 1
  `;
  assert.ok(event, 'the event must be recorded');
  assert.equal(event.metadata.reason, 'customer_requested_direct_contact');
});

test('a routine lookup with no number configured records NO event — nothing was provided', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyB, { phone: null });
  const [customerB] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyB}, '2349090000002', '2349090000002', '2349090000002@s.whatsapp.net', 'B Customer')
    returning id
  `;

  await runTool(
    { pharmacyId: ctx.pharmacyB, conversationId: null, customerId: customerB.id },
    'contact_pharmacy', { reason: 'automation_limit' },
  );

  const events = await db`
    select id from customer_events
    where customer_id = ${customerB.id} and event_type = 'PHARMACY_CONTACT_PROVIDED'
  `;
  assert.equal(events.length, 0);
});

test('getProfile round-trips a saved number back out for the dashboard', { skip: SKIP && skipReason }, async () => {
  await updateProfile(ctx.pharmacyA, { phone: '08055556666' });
  const profile = await getProfile(ctx.pharmacyA);
  assert.ok(profile.phone, 'the dashboard must be able to read back what was saved');
});
