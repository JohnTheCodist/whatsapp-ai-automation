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
require('./helpers/testDb').useTestDatabase(TEST_URL);

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
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name,
                           full_name, name_verified, name_source)
    values (${a.id}, '2349080000001', '2349080000001', '2349080000001@s.whatsapp.net', 'Profile Tester',
            'Profile Tester', true, 'customer_provided')
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

  // KEYS, NOT VALUES — and that distinction is the point of this test.
  //
  // This used to scan JSON.stringify(profile), which conflated the schema
  // with the words people type into it. It passed only because the profile
  // exposed inbound message text and nothing else; once activeConversation
  // began previewing the last message in EITHER direction, a real assistant
  // reply containing "diagnostic" failed it. Nothing was wrong with the
  // response — a pharmacy conversation may legitimately contain clinical
  // words, and a test that forbids the CUSTOMER from saying "allergy" is
  // testing the wrong thing.
  //
  // What must never appear is a clinical FIELD: a diagnosis, an allergy
  // list, vitals. That is a claim about shape, so it is checked against the
  // shape.
  const keys = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      keys.push(k.toLowerCase());
      walk(v);
    }
  }(profile));

  // AMENDED 2026-09-21, with the owner's decision on the record
  // (MEDICATIONS_PLAN.md §6.2). This list used to include "allerg" and
  // "vital", on the grounds that a CRM keeps no clinical record at all. That
  // is no longer what this product is: it keeps vitals (0054) and a
  // medication record with dose, route, indication and prescriber (0055).
  //
  // The rule that survives is the one that matters, and it is narrower and
  // sharper: the software RECORDS WHAT A PHARMACIST OBSERVED OR WAS TOLD,
  // and never forms a clinical judgement of its own. So a diagnosis, a
  // severity, a triage category, a treatment plan and an interaction verdict
  // are still forbidden by name — and a test that quietly dropped to nothing
  // would have been worse than no test.
  for (const banned of ['diagnos', 'severity', 'triage', 'treatmentplan', 'recommendation', 'interactionrisk']) {
    const hit = keys.find((k) => k.includes(banned));
    assert.ok(!hit, `profile exposes "${hit}" — this product records observations, it does not form clinical judgements`);
  }
});

test('medicationJourneys is an honest empty array, not a fabricated placeholder', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.deepEqual(profile.medicationJourneys, []);
});

test('a customer with no orders or conversations still returns a complete, non-throwing shape', { skip: SKIP && skipReason }, async () => {
  const [bare] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, first_seen_at)
    values (${ctx.a.id}, '2349080000099', '2349080000099', '2349080000099@s.whatsapp.net', null, now())
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

/**
 * Conditions and consultation counts on the profile (2026-09-20).
 *
 * Both were added for the patient summary, which shows a line per section of
 * the record and links through. The tests that matter are the tenant ones:
 * a condition or a consultation belonging to another pharmacy's patient must
 * never appear here, and both read through a join that could lose the scope
 * in a refactor without any visible symptom.
 */
test('conditions come back with their status, so "confirmed by purchase" is never shown as a diagnosis', { skip: SKIP && skipReason }, async () => {
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.a.id}, ${ctx.customer.id}, 'HYPERTENSION', 'Hypertension', 'CONFIRMED_BY_PURCHASE', 'STRONG')
    on conflict do nothing
  `;
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  const found = profile.conditions.find((c) => c.code === 'HYPERTENSION');
  assert.ok(found, 'the condition is on the profile');
  assert.equal(found.name, 'Hypertension');
  // The status travels with it. A screen that only had the name could not
  // tell a pharmacist this came from a till, not a doctor.
  assert.equal(found.status, 'CONFIRMED_BY_PURCHASE');
  assert.equal(found.evidence, 'STRONG');
});

test('another pharmacy\'s condition on the same customer id is not returned', { skip: SKIP && skipReason }, async () => {
  // Pharmacy B writes a condition against A's customer id. Nothing stops a
  // row existing; the query must refuse to read it.
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.b.id}, ${ctx.customer.id}, 'ASTHMA', 'Asthma', 'CONFIRMED_BY_PURCHASE', 'STRONG')
    on conflict do nothing
  `;
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.ok(!profile.conditions.some((c) => c.code === 'ASTHMA'), 'pharmacy B\'s condition leaked into A\'s profile');
});

test('consultation counts are counts only — the encounters themselves are not on the profile', { skip: SKIP && skipReason }, async () => {
  const [pp] = await db`
    insert into patient_profiles (pharmacy_id, customer_id) values (${ctx.a.id}, ${ctx.customer.id})
    returning id
  `;
  await db`
    insert into clinical_encounters (pharmacy_id, patient_profile_id, red_flags_detected, started_at)
    values (${ctx.a.id}, ${pp.id}, ${db.json(['chest pain'])}, now() - interval '2 days')
  `;
  await db`
    insert into clinical_encounters (pharmacy_id, patient_profile_id, red_flags_detected, started_at)
    values (${ctx.a.id}, ${pp.id}, ${db.json([])}, now() - interval '9 days')
  `;
  const profile = await getCustomerProfile(ctx.a.id, ctx.customer.id);
  assert.equal(profile.clinical.encounters, 2);
  assert.equal(profile.clinical.redFlagEncounters, 1);
  assert.ok(profile.clinical.lastEncounterAt, 'the most recent consultation is dated');
  // Counts, not content: what was said in a consultation is a section of the
  // record behind its own request, never a field on the summary payload.
  assert.deepEqual(Object.keys(profile.clinical).sort(), ['encounters', 'lastEncounterAt', 'redFlagEncounters']);
});

test('a patient with no conditions and no consultations gets honest zeroes', { skip: SKIP && skipReason }, async () => {
  const [bare] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, first_seen_at)
    values (${ctx.a.id}, '2349080000077', '2349080000077', '2349080000077@s.whatsapp.net', 'No History', now())
    returning id
  `;
  const profile = await getCustomerProfile(ctx.a.id, bare.id);
  assert.deepEqual(profile.conditions, []);
  assert.equal(profile.clinical.encounters, 0);
  assert.equal(profile.clinical.redFlagEncounters, 0);
  assert.equal(profile.clinical.lastEncounterAt, null);
});
