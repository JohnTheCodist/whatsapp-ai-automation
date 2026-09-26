/**
 * The patient medication record, against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a medication belongs to a pharmacy, and pharmacy
 * B must never read or write one of pharmacy A's — even with A's real
 * customer id in hand (GOLDEN-001).
 *
 * THE OTHER HALF OF THIS FILE IS THE REFILL ENGINE. 0055 widened
 * medication_journeys.status from active|stopped to five values, and six
 * things read that column meaning "active". These tests hold the line: a
 * completed course leaves the refill call list, its refill history survives,
 * and a draft never reaches the list at all.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the medication record NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'medstest';
const TODAY = '2026-09-21';

let db;
let meds;
let journeys;
let search;
let ctx = null;

const base = (over = {}) => ({
  medicineName: 'Amlodipine', startedOn: '2026-09-15', status: 'active', source: 'prescribed', ...over,
});

async function patient(pharmacyId, phone) {
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, 'Meds Tester', 'Meds Tester')
    returning id
  `;
  return c.id;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  meds = require('../services/clinical/medications');
  journeys = require('../services/refills/medicationJourneys');
  search = require('../services/customers/patientSearch');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  ctx = {
    a, b, userA, userB,
    p1: await patient(a.id, '2349060000001'),
    p2: await patient(a.id, '2349060000002'),
    bPatient: await patient(b.id, '2349060000003'),
  };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ---------------------------------------------------

test('pharmacy B cannot read, edit or add a medication on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const mine = await meds.addMedication(ctx.a.id, ctx.p1, base({ medicineName: 'Lisinopril' }));

  // Read: the same empty answer as a patient with no medicines, so a caller
  // cannot tell "not yours" from "nothing here".
  const theirs = await meds.listMedications(ctx.b.id, ctx.p1);
  assert.deepEqual(theirs.medications, []);

  await assert.rejects(
    () => meds.getMedication(ctx.b.id, ctx.p1, mine.id),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => meds.updateMedication(ctx.b.id, ctx.p1, mine.id, { dose: '2 tablets' }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => meds.addMedication(ctx.b.id, ctx.p1, base()),
    (err) => err.status === 404 && err.code === 'NOT_FOUND',
  );

  // And A still has exactly what it had.
  const still = await meds.listMedications(ctx.a.id, ctx.p1);
  assert.equal(still.medications.filter((m) => m.medicineName === 'Lisinopril').length, 1);
});

// ---- the record -----------------------------------------------------------

test('every clinical field a pharmacist entered comes back as it was entered', { skip: SKIP && skipReason }, async () => {
  const saved = await meds.addMedication(ctx.a.id, ctx.p2, base({
    medicineName: 'Metformin',
    genericName: 'Metformin hydrochloride',
    brandName: 'Glucophage',
    strength: '500 mg',
    form: 'tablet',
    dose: '1 tablet',
    route: 'oral',
    frequency: 'twice_daily',
    dosesPerDay: 2,
    timing: 'With meals',
    durationDays: 30,
    indication: 'Type 2 diabetes',
    conditionCode: 'DIABETES',
    prescriberName: 'Dr John',
    instructions: 'Take after food.',
    notes: 'Patient asked about nausea.',
    source: 'prescribed',
  }), { actorId: ctx.userA });

  assert.equal(saved.strength, '500 mg');
  assert.equal(saved.form, 'tablet');
  assert.equal(saved.route, 'oral');
  assert.equal(saved.frequency, 'twice_daily');
  assert.equal(saved.durationDays, 30);
  assert.equal(saved.indication, 'Type 2 diabetes');
  assert.equal(saved.prescriber.name, 'Dr John');
  assert.equal(saved.instructions, 'Take after food.');
  assert.equal(saved.source, 'prescribed');
  // The frequency drove the refill engine's column rather than being typed
  // a second time.
  assert.equal(saved.unitsPerDay, 2);

  const read = await meds.getMedication(ctx.a.id, ctx.p2, saved.id);
  assert.deepEqual(read, saved);
});

test('THE PAYLOAD CARRIES NO INVENTORY FIELD — a medicine taken is not a pack on a shelf', { skip: SKIP && skipReason }, async () => {
  const saved = await meds.addMedication(ctx.a.id, ctx.p2, base({ medicineName: 'Paracetamol' }));
  const keys = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) { keys.push(k.toLowerCase()); walk(v); }
  }(saved));
  for (const banned of ['price', 'cost', 'stock', 'quantityonhand', 'batch', 'expiry', 'supplier', 'reorder', 'warehouse']) {
    assert.ok(!keys.some((k) => k.includes(banned)), `medication payload exposes "${banned}" — that is Stock, not a clinical record`);
  }
});

test('a patient cannot be put on the same medicine twice while it is active', { skip: SKIP && skipReason }, async () => {
  await meds.addMedication(ctx.a.id, ctx.p2, base({ medicineName: 'Losartan' }));
  await assert.rejects(
    () => meds.addMedication(ctx.a.id, ctx.p2, base({ medicineName: ' losartan ' })),
    (err) => err.status === 409 && err.code === 'ALREADY_ON_THIS',
  );
});

test('an edit changes what it names and leaves the rest of the record alone', { skip: SKIP && skipReason }, async () => {
  const saved = await meds.addMedication(ctx.a.id, ctx.p2, base({
    medicineName: 'Atenolol', dose: '1 tablet', notes: 'Original note', indication: 'Hypertension',
  }));
  const edited = await meds.updateMedication(ctx.a.id, ctx.p2, saved.id, { dose: '2 tablets' }, { actorId: ctx.userA });
  assert.equal(edited.dose, '2 tablets');
  assert.equal(edited.notes, 'Original note');
  assert.equal(edited.indication, 'Hypertension');
  assert.ok(edited.updatedAt >= saved.updatedAt);
});

// ---- the status widening, and the refill engine ---------------------------

test('completing a course takes it off the refill call list and keeps its history', { skip: SKIP && skipReason }, async () => {
  // Enrolled through the refill engine, so there is a real open supply.
  const p = await patient(ctx.a.id, '2349060000010');
  const journey = await journeys.startJourney(ctx.a.id, p, {
    medicineName: 'Amlodipine 5mg', daysSupply: 30, dispensedOn: '2026-09-01', today: TODAY,
  });
  const before = await journeys.listRefillQueue(ctx.a.id, { today: '2026-10-05' });
  assert.ok(before.items.some((i) => i.customer.id === p), 'the patient is on the call list while active');

  await meds.updateMedication(ctx.a.id, p, journey.id, { status: 'completed' });

  const after = await journeys.listRefillQueue(ctx.a.id, { today: '2026-10-05' });
  assert.ok(!after.items.some((i) => i.customer.id === p), 'a completed course must leave the call list');

  // The supply is closed, not deleted: the history of what was dispensed is
  // a fact about the patient and survives the course ending.
  const supplies = await db`select status from refills where journey_id = ${journey.id}`;
  assert.equal(supplies.length, 1);
  assert.equal(supplies[0].status, 'cancelled');
});

test('a draft is not something the patient is taking, and never reaches the call list', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349060000011');
  const draft = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Ramipril', status: 'draft' }));
  assert.equal(draft.status, 'draft');
  assert.equal(draft.endedAt, null);

  // The Medication filter and the medications column both mean "active".
  const found = await search.searchPatients(ctx.a.id, { medication: 'Ramipril' }, { today: TODAY });
  assert.equal(found.patients.length, 0, 'a draft must not appear as a medicine the patient is on');
});

test('an ended medicine records when it ended, and a running one cannot', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349060000012');
  const m = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Ibuprofen' }));
  assert.equal(m.endedAt, null);

  const stopped = await meds.updateMedication(ctx.a.id, p, m.id, { status: 'stopped', stopReason: 'Stomach upset' });
  assert.ok(stopped.endedAt, 'a stopped medicine records when it stopped');
  assert.equal(stopped.stopReason, 'Stomach upset');

  // Restarting clears both — the record is running again, and the old reason
  // would read as though it were still stopped.
  const restarted = await meds.updateMedication(ctx.a.id, p, m.id, { status: 'active' });
  assert.equal(restarted.endedAt, null);
  assert.equal(restarted.stopReason, null);
});

test('a patient can be put back on a medicine they finished — that is a repeat prescription', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349060000013');
  const first = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Amoxicillin' }));
  await meds.updateMedication(ctx.a.id, p, first.id, { status: 'completed' });
  // The one-active index is partial, so a finished course does not block it.
  const second = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Amoxicillin' }));
  assert.notEqual(second.id, first.id);

  const all = await meds.listMedications(ctx.a.id, p);
  assert.equal(all.counts.current, 1);
  assert.equal(all.counts.history, 1);
});

// ---- reading it back ------------------------------------------------------

test('current medicines come first, then history newest-first', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349060000014');
  const old = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Old one', startedOn: '2026-06-01' }));
  await meds.updateMedication(ctx.a.id, p, old.id, { status: 'stopped', stopReason: 'Rash' });
  await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Newer', startedOn: '2026-08-01' }));
  await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Newest', startedOn: '2026-09-10' }));

  const list = await meds.listMedications(ctx.a.id, p);
  assert.deepEqual(list.medications.map((m) => m.medicineName), ['Newest', 'Newer', 'Old one']);
  assert.equal(list.counts.current, 2);
  assert.equal(list.counts.history, 1);

  const current = await meds.listMedications(ctx.a.id, p, { status: 'current' });
  assert.deepEqual(current.medications.map((m) => m.medicineName), ['Newest', 'Newer']);
  const history = await meds.listMedications(ctx.a.id, p, { status: 'history' });
  assert.deepEqual(history.medications.map((m) => m.medicineName), ['Old one']);
});

test('an in-house prescriber comes back with their email, an outside one with their name', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349060000015');
  const inHouse = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Salbutamol', prescriberId: ctx.userA }));
  assert.equal(inHouse.prescriber.id, ctx.userA);
  assert.match(inHouse.prescriber.email, /@example\.test$/);

  const outside = await meds.addMedication(ctx.a.id, p, base({ medicineName: 'Prednisolone', prescriberName: 'Dr Ade, LUTH' }));
  assert.equal(outside.prescriber.name, 'Dr Ade, LUTH');
  assert.equal(outside.prescriber.id, null);
});

// ---- context --------------------------------------------------------------

test('the context panel carries the allergy record — and an empty one is NOT ASSESSED, never "none"', { skip: SKIP && skipReason }, async () => {
  // REWRITTEN 2026-09-22 with the allergy record (0058). The rule this test
  // held — never tell a pharmacist "no allergies" from a system that was not
  // asked — is the same rule, now stricter: an unassessed patient reads as
  // not_assessed, a recorded allergy is named with its reactions, and a
  // refuted one is not shown as current.
  const allergies = require('../services/clinical/allergies');
  const { readAllergyInput, readAllergyPatch } = require('../services/clinical/allergyInput');
  const pharmacist = { actorId: null, actorRole: 'pharmacist' };

  const empty = await meds.medicationContext(ctx.a.id, ctx.p1);
  assert.equal(empty.allergies.state, 'not_assessed');
  assert.deepEqual(empty.allergies.allergies, []);

  const pen = await allergies.addAllergy(ctx.a.id, ctx.p1, readAllergyInput({
    allergenName: 'Penicillin', criticality: 'high', reactions: ['rash', 'facial_swelling'],
  }, { today: TODAY }), pharmacist);
  const lat = await allergies.addAllergy(ctx.a.id, ctx.p1, readAllergyInput({ allergenName: 'Latex' }, { today: TODAY }), pharmacist);
  await allergies.updateAllergy(ctx.a.id, ctx.p1, lat.id, readAllergyPatch({
    verificationStatus: 'refuted', statusReason: 'Wore latex gloves without reaction.',
  }, { today: TODAY }), pharmacist);

  const known = await meds.medicationContext(ctx.a.id, ctx.p1);
  assert.equal(known.allergies.state, 'known');
  assert.deepEqual(known.allergies.allergies.map((a) => a.allergenName), ['Penicillin']);
  assert.deepEqual(known.allergies.allergies[0].reactions, ['rash', 'facial_swelling']);
  assert.deepEqual(known.allergies.allergies[0].reactionLabels, ['Rash', 'Facial swelling']);
  assert.equal(known.allergies.allergies[0].criticality, 'high');

  // Tidy: this file's later tests share the patient.
  await allergies.updateAllergy(ctx.a.id, ctx.p1, pen.id, readAllergyPatch({
    verificationStatus: 'entered_in_error', statusReason: 'Test fixture.',
  }, { today: TODAY }), pharmacist);
});

test('the context panel carries the care programmes, and shows nothing when there are none', { skip: SKIP && skipReason }, async () => {
  // A pharmacist writing up a medicine should be able to see that this patient
  // is being followed for something, and that a task is late, without leaving
  // the screen. Shown, never acted on: nothing here starts or changes a
  // programme (0061, phase 3).
  const programs = require('../services/clinical/carePrograms');
  const { readProgramInput } = require('../services/clinical/careProgramInput');

  const before = await meds.medicationContext(ctx.a.id, ctx.p2);
  assert.deepEqual(before.carePrograms.active, [], 'a patient in no programme has an empty list');
  assert.equal(before.carePrograms.counts.active, 0);

  await programs.enrolProgram(
    ctx.a.id, ctx.p2,
    readProgramInput({ programName: 'Weight management' }, { today: '2026-09-24' }),
    { actorId: ctx.userA, actorRole: 'pharmacist' },
  );
  const after = await meds.medicationContext(ctx.a.id, ctx.p2);
  assert.equal(after.carePrograms.counts.active, 1);
  assert.equal(after.carePrograms.active[0].programName, 'Weight management');
  assert.ok(after.carePrograms.active[0].progress, 'the counts travel with it');
});

test('the context panel carries what needs to happen next, and nothing when there is nothing', { skip: SKIP && skipReason }, async () => {
  // A pharmacist writing up a medicine should be able to see that a repeat
  // blood pressure is three weeks late without leaving the screen (0062,
  // follow-ups phase 3). Shown, never acted on: nothing on this screen
  // creates, completes or reschedules a follow-up.
  const followups = require('../services/clinical/followups');
  const { readFollowupInput } = require('../services/clinical/followupInput');

  const before = await meds.medicationContext(ctx.a.id, ctx.p1);
  assert.deepEqual(before.followups.next, [], 'a patient with nothing outstanding gets an empty list, not a missing key');
  assert.equal(before.followups.counts.overdue, 0);

  await followups.createFollowup(
    ctx.a.id, ctx.p1,
    readFollowupInput({ title: 'Repeat blood pressure', dueOn: '2020-01-01' }),
    { actorId: ctx.userA, actorRole: 'pharmacist' },
  );
  const after = await meds.medicationContext(ctx.a.id, ctx.p1);
  // A date that far past is overdue on whatever day this test runs, so the
  // assertion cannot rot the way a hand-written "yesterday" would.
  assert.equal(after.followups.counts.overdue, 1);
  assert.equal(after.followups.next[0].title, 'Repeat blood pressure');
});

test('the context panel is this pharmacy\'s facts only', { skip: SKIP && skipReason }, async () => {
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.a.id}, ${ctx.p1}, 'HYPERTENSION', 'Hypertension', 'CONFIRMED_BY_PURCHASE', 'STRONG')
    on conflict do nothing
  `;
  // Pharmacy B writes a condition against A's customer id. It must not appear.
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.b.id}, ${ctx.p1}, 'ASTHMA', 'Asthma', 'CONFIRMED_BY_PURCHASE', 'STRONG')
    on conflict do nothing
  `;
  const context = await meds.medicationContext(ctx.a.id, ctx.p1);
  assert.ok(context.conditions.some((c) => c.code === 'HYPERTENSION'));
  assert.ok(!context.conditions.some((c) => c.code === 'ASTHMA'), 'pharmacy B\'s condition leaked into A\'s context');
});
