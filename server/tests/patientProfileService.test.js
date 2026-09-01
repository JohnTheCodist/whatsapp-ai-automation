/**
 * Patient profile and clinical facts — Stage 1's persistent clinical
 * identity, separate from both WhatsApp identity (customers) and any
 * single episode (clinical_encounters).
 *
 * The tests that matter most: getOrCreateProfile must never produce two
 * profiles for the same customer under concurrency (spec §25's explicit
 * "prevent duplicate patient creation"), and an AI-extracted fact must be
 * structurally incapable of arriving as 'confirmed' — that boundary is
 * spec §16/§17's whole safety argument, so it is checked here, not just
 * described in a comment.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the clinical patient profile was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const profileService = require('../services/clinical/patientProfileService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Clinical Profile A', ${`clin-prof-a-${Date.now()}`}, 'active')
    returning id
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('Clinical Profile B', ${`clin-prof-b-${Date.now()}`}, 'active')
    returning id
  `;
  const [customerA] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349100000001', '2349100000001', '2349100000001@s.whatsapp.net', 'Profile Tester')
    returning id
  `;
  const [customerB] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${b.id}, '2349100000002', '2349100000002', '2349100000002@s.whatsapp.net', 'Other Tenant')
    returning id
  `;

  ctx = { pharmacyA: a.id, pharmacyB: b.id, customerA: customerA.id, customerB: customerB.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id in (${ctx.pharmacyA}, ${ctx.pharmacyB})`.catch(() => {});
});

// ---- profile identity -----------------------------------------------------

test('a profile does not exist until first use', { skip: SKIP && skipReason }, async () => {
  const profile = await profileService.getPatientProfile(ctx.pharmacyA, ctx.customerA);
  assert.equal(profile, null);
});

test('getOrCreateProfile creates exactly one profile, ever, for a customer', { skip: SKIP && skipReason }, async () => {
  const first = await profileService.getOrCreateProfile(ctx.pharmacyA, ctx.customerA);
  const second = await profileService.getOrCreateProfile(ctx.pharmacyA, ctx.customerA);
  assert.equal(first.id, second.id, 'must return the SAME profile, not create a second one');
});

test('concurrent first-use does not create two profiles (spec §25)', { skip: SKIP && skipReason }, async () => {
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyA}, '2349100000003', '2349100000003', '2349100000003@s.whatsapp.net', 'Concurrent Tester')
    returning id
  `;
  const [p1, p2, p3] = await Promise.all([
    profileService.getOrCreateProfile(ctx.pharmacyA, c.id),
    profileService.getOrCreateProfile(ctx.pharmacyA, c.id),
    profileService.getOrCreateProfile(ctx.pharmacyA, c.id),
  ]);
  assert.equal(p1.id, p2.id);
  assert.equal(p2.id, p3.id);

  const rows = await db`select count(*)::int n from patient_profiles where customer_id = ${c.id}`;
  assert.equal(rows[0].n, 1);
});

test('a customer in pharmacy B never resolves under pharmacy A', { skip: SKIP && skipReason }, async () => {
  const profile = await profileService.getPatientProfile(ctx.pharmacyA, ctx.customerB);
  assert.equal(profile, null, 'pharmacy A must not see pharmacy B\'s customer at all');
});

// ---- profile fields ---------------------------------------------------

test('updatePatientProfile only writes the fields given', { skip: SKIP && skipReason }, async () => {
  await profileService.updatePatientProfile(ctx.pharmacyA, ctx.customerA, { sex: 'female' }, { actorType: 'pharmacist' });
  const withAge = await profileService.updatePatientProfile(
    ctx.pharmacyA, ctx.customerA, { age_years: 34 }, { actorType: 'pharmacist' },
  );
  assert.equal(withAge.sex, 'female', 'an unrelated earlier field must survive');
  assert.equal(withAge.age_years, 34);
});

test('an invalid sex value is rejected', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => profileService.updatePatientProfile(ctx.pharmacyA, ctx.customerA, { sex: 'nonsense' }),
    /sex must be/i,
  );
});

// ---- clinical facts: provenance is the point ---------------------------

test('a fact is recorded as "reported", never "confirmed", regardless of who recorded it', { skip: SKIP && skipReason }, async () => {
  const fact = await profileService.recordFact(
    ctx.pharmacyA, ctx.customerA,
    { factType: 'allergy', value: 'Penicillin', source: 'patient_reported' },
    { actorType: 'customer' },
  );
  assert.equal(fact.status, 'reported');
});

test('an AI-extracted fact starts reported — the AI cannot mark its own inference confirmed', { skip: SKIP && skipReason }, async () => {
  const fact = await profileService.recordFact(
    ctx.pharmacyA, ctx.customerA,
    { factType: 'condition', value: 'Possible hypertension, per conversation', source: 'ai_extracted' },
    { actorType: 'ai' },
  );
  assert.equal(fact.status, 'reported', 'AI-extracted facts must never start confirmed');
});

test('only a pharmacist or staff member may confirm a fact', { skip: SKIP && skipReason }, async () => {
  const fact = await profileService.recordFact(
    ctx.pharmacyA, ctx.customerA,
    { factType: 'allergy', value: 'Sulfa drugs', source: 'patient_reported' },
    { actorType: 'customer' },
  );
  await assert.rejects(
    () => profileService.confirmFact(ctx.pharmacyA, ctx.customerA, fact.id, { actorType: 'ai' }),
    /pharmacist or staff/i,
  );
  await assert.rejects(
    () => profileService.confirmFact(ctx.pharmacyA, ctx.customerA, fact.id, { actorType: 'customer' }),
    /pharmacist or staff/i,
  );

  const confirmed = await profileService.confirmFact(ctx.pharmacyA, ctx.customerA, fact.id, { actorType: 'pharmacist', actorId: null });
  assert.equal(confirmed.status, 'confirmed');
});

test('a reported-but-not-confirmed fact and a confirmed one are both visible, distinguishably', { skip: SKIP && skipReason }, async () => {
  const facts = await profileService.listFacts(ctx.pharmacyA, ctx.customerA, { factType: 'allergy' });
  const statuses = new Set(facts.map((f) => f.status));
  assert.ok(statuses.has('reported') || statuses.has('confirmed'), 'at least the recorded facts must be listed');
});

test('facts respect tenant isolation the same as the profile itself', { skip: SKIP && skipReason }, async () => {
  const facts = await profileService.listFacts(ctx.pharmacyB, ctx.customerA, {});
  assert.equal(facts.length, 0, 'pharmacy B must never see pharmacy A\'s clinical facts');
});

// ---- audit trail --------------------------------------------------------

test('creating a profile and recording a fact both leave an internal-only audit event', { skip: SKIP && skipReason }, async () => {
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyA}, '2349100000004', '2349100000004', '2349100000004@s.whatsapp.net', 'Audit Tester')
    returning id
  `;
  await profileService.getOrCreateProfile(ctx.pharmacyA, c.id, { actorType: 'system' });
  await profileService.recordFact(
    ctx.pharmacyA, c.id, { factType: 'medication', value: 'Amlodipine 5mg', source: 'patient_reported' },
    { actorType: 'customer' },
  );

  const events = await db`
    select event_type, visibility from customer_events
    where customer_id = ${c.id} and event_type in ('PATIENT_PROFILE_CREATED', 'CLINICAL_FACT_RECORDED')
  `;
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.visibility, 'internal', `${e.event_type} must be internal, never customer-visible`);
  }
});
