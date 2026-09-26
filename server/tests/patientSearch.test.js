/**
 * Patient search and care details, against real Postgres.
 *
 * Four patients in pharmacy A, each built to fall on a different side of
 * every filter, and one patient in pharmacy B who matches ALL of them. B's
 * patient appearing in any result is a tenant leak; that is the first thing
 * these tests are for. The rest pin each filter at the boundary that
 * decides it, and the care-details writes — above all that a patient can
 * only be assigned to a pharmacist of their own pharmacy.
 *
 * `today` is a fixed Lagos date, so every day-window assertion is about the
 * rule rather than the day the suite runs.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — patient search and care details NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'patsearchtest';
const TODAY = '2026-09-19';

let db;
let search;
let care;
let journeys;
let ctx = null;

async function user(label) {
  const id = crypto.randomUUID();
  await db`insert into auth.users (id, email) values (${id}, ${`${TAG}-${label}-${id.slice(0, 8)}@example.test`})`;
  return id;
}

async function patient(pharmacyId, { name, phone, lastSeen, sex = null, dob = null, ageYears = null }) {
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name, last_seen_at)
    values (${pharmacyId}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, ${name}, ${name}, ${lastSeen})
    returning id
  `;
  if (sex || dob || ageYears !== null) {
    await db`
      insert into patient_profiles (pharmacy_id, customer_id, sex, date_of_birth, age_years)
      values (${pharmacyId}, ${c.id}, ${sex}, ${dob}, ${ageYears})
    `;
  }
  return c.id;
}

async function condition(pharmacyId, customerId, code, name) {
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${pharmacyId}, ${customerId}, ${code}, ${name}, 'CONFIRMED_BY_PURCHASE', 'STRONG')
  `;
}

async function redFlagEncounter(pharmacyId, customerId, startedAt) {
  let [pp] = await db`select id from patient_profiles where customer_id = ${customerId}`;
  if (!pp) {
    [pp] = await db`insert into patient_profiles (pharmacy_id, customer_id) values (${pharmacyId}, ${customerId}) returning id`;
  }
  await db`
    insert into clinical_encounters (pharmacy_id, patient_profile_id, red_flags_detected, started_at)
    values (${pharmacyId}, ${pp.id}, ${db.json(['convulsions'])}, ${startedAt})
  `;
}

async function followUpTag(pharmacyId, customerId) {
  const [t] = await db`
    insert into tags (pharmacy_id, name, slug, is_system) values (${pharmacyId}, 'Pharmacist follow-up', 'pharmacist_follow_up', true)
    on conflict (pharmacy_id, slug) do update set name = excluded.name
    returning id
  `;
  await db`insert into patient_tags (customer_id, tag_id, pharmacy_id) values (${customerId}, ${t.id}, ${pharmacyId})`;
}

/** Search A and return the ids found, in order, never including B's patient. */
async function ids(filters) {
  const res = await search.searchPatients(ctx.a.id, filters, { today: TODAY });
  assert.ok(!res.patients.some((p) => p.id === ctx.bPatient), 'pharmacy B\'s patient leaked into A\'s search');
  return res.patients.map((p) => p.id);
}

const sameSet = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  search = require('../services/customers/patientSearch');
  care = require('../services/customers/patientCare');
  journeys = require('../services/refills/medicationJourneys');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const pharmacies = require('../services/pharmacies');
  const ownerA = await user('ownera');
  const ownerB = await user('ownerb');
  const a = await pharmacies.createPharmacy(ownerA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(ownerB, { name: `${TAG} Beta` });

  const pharmacistX = await user('pharmx');
  const staffS = await user('staffs');
  await db`insert into pharmacy_members (pharmacy_id, user_id, role) values
    (${a.id}, ${pharmacistX}, 'pharmacist'), (${a.id}, ${staffS}, 'staff')`;

  const start = (pid, cid, name, dispensedOn) => journeys.startJourney(pid, cid, {
    medicineName: name, daysSupply: 30, dispensedOn, today: TODAY,
  });

  // P1 — 68, female, hypertensive, LAPSED on amlodipine, tagged, assigned to X.
  const p1 = await patient(a.id, { name: 'Adaeze Okafor', phone: '2348031110001', lastSeen: '2026-09-18T10:00:00+01:00', sex: 'female', dob: '1958-03-01' });
  await condition(a.id, p1, 'HYPERTENSION', 'Hypertension');
  await start(a.id, p1, 'Amlodipine 5mg', '2026-08-01');           // runs out 08-31: lapsed
  await followUpTag(a.id, p1);
  await db`update customers set assigned_pharmacist_id = ${pharmacistX} where id = ${p1}`;

  // P2 — 35 by reported age, male, diabetic, metformin DUE. Last message in
  // June, but a dispense in August: last visit is the dispense.
  const p2 = await patient(a.id, { name: 'Bola Adebayo', phone: '2348031110002', lastSeen: '2026-06-01T10:00:00+01:00', sex: 'male', ageYears: 35 });
  await condition(a.id, p2, 'DIABETES', 'Diabetes');
  await start(a.id, p2, 'Metformin 500mg', '2026-08-25');           // runs out 09-24: due

  // P3 — nothing recorded about them, a RECENT danger sign, not seen for months.
  const p3 = await patient(a.id, { name: 'Chika Eze', phone: '2348031110003', lastSeen: '2026-05-01T10:00:00+01:00' });
  await redFlagEncounter(a.id, p3, '2026-09-10T09:00:00+01:00');

  // P4 — 16, male, OVERDUE on lisinopril, an OLD danger sign (outside 90 days).
  const p4 = await patient(a.id, { name: 'Dele Musa', phone: '2348031110004', lastSeen: '2026-09-15T10:00:00+01:00', sex: 'male', dob: '2010-01-01' });
  await start(a.id, p4, 'Lisinopril 10mg', '2026-08-18');           // runs out 09-17: overdue
  await redFlagEncounter(a.id, p4, '2026-03-01T09:00:00+01:00');

  // B — matches every filter A is searched with. Must never be returned.
  const bPatient = await patient(b.id, { name: 'Adaeze Okafor', phone: '2348031110001', lastSeen: '2026-09-18T10:00:00+01:00', sex: 'female', dob: '1958-03-01' });
  await condition(b.id, bPatient, 'HYPERTENSION', 'Hypertension');
  await start(b.id, bPatient, 'Amlodipine 5mg', '2026-08-01');
  await followUpTag(b.id, bPatient);
  await redFlagEncounter(b.id, bPatient, '2026-09-10T09:00:00+01:00');

  ctx = { a, b, ownerA, ownerB, pharmacistX, staffS, p1, p2, p3, p4, bPatient };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- search by name or phone ---------------------------------------------

test('a name search finds this pharmacy\'s patient and never the same name in another pharmacy', { skip: SKIP && skipReason }, async () => {
  assert.deepEqual(await ids({ q: 'adaeze' }), [ctx.p1]);
});

test('a phone typed the local way (0803…) finds the stored international number', { skip: SKIP && skipReason }, async () => {
  assert.deepEqual(await ids({ q: '0803 111 0002' }), [ctx.p2]);
});

test('a search with % or _ in it is literal text, not a wildcard that matches everyone', { skip: SKIP && skipReason }, async () => {
  assert.deepEqual(await ids({ q: '%' }), []);
  assert.deepEqual(await ids({ q: '_' }), []);
});

// ---- each filter ---------------------------------------------------------

test('age bands use the date of birth where there is one, else the reported age', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ age: '60plus' }), [ctx.p1]);
  sameSet(await ids({ age: '18-39' }), [ctx.p2]);
  sameSet(await ids({ age: 'under18' }), [ctx.p4]);
  sameSet(await ids({ age: 'unknown' }), [ctx.p3]);
  sameSet(await ids({ age: '40-59' }), []);
});

test('gender, with "not recorded" as its own choice', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ gender: 'female' }), [ctx.p1]);
  sameSet(await ids({ gender: 'male' }), [ctx.p2, ctx.p4]);
  sameSet(await ids({ gender: 'unknown' }), [ctx.p3]);
});

test('condition matches only conditions confirmed by purchase', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ condition: 'HYPERTENSION' }), [ctx.p1]);
  sameSet(await ids({ condition: 'DIABETES' }), [ctx.p2]);
});

/**
 * The chronic switch — the one control that answers "show me the people I
 * follow". It is the union of the engine's chronic codes, so it must return
 * the hypertensive AND the diabetic, and nobody whose record carries no
 * confirmed condition at all.
 */
test('the chronic switch returns every patient with a chronic condition, and only those', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ chronic: true }), [ctx.p1, ctx.p2]);
  sameSet(await ids({ chronic: false }), [ctx.p1, ctx.p2, ctx.p3, ctx.p4]);
});

test('the chronic switch narrows WITH the other filters, never instead of them', { skip: SKIP && skipReason }, async () => {
  // Chronic + diabetes is the diabetics, not everyone chronic: an OR here
  // would hand a pharmacist the hypertensive patients they did not ask for.
  sameSet(await ids({ chronic: true, condition: 'DIABETES' }), [ctx.p2]);
  sameSet(await ids({ chronic: true, gender: 'female' }), [ctx.p1]);
  // And it cannot widen the search past the patient's own pharmacy: P3 has
  // no confirmed condition, so no combination brings them back.
  sameSet(await ids({ chronic: true, age: 'unknown' }), []);
});

test('medication matches part of the name of a medicine the patient is followed on', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ medication: 'metf' }), [ctx.p2]);
  sameSet(await ids({ medication: 'AMLO' }), [ctx.p1]);
});

test('last visit is the latest of a message, an order or a dispense', { skip: SKIP && skipReason }, async () => {
  // P2's last message was in June, but their dispense on 25 Aug is 25 days
  // ago — they are a recent visitor, not a lapsed one.
  sameSet(await ids({ lastVisit: '7d' }), [ctx.p1, ctx.p4]);
  sameSet(await ids({ lastVisit: '30d' }), [ctx.p1, ctx.p2, ctx.p4]);
  sameSet(await ids({ lastVisit: 'over90' }), [ctx.p3]);
});

test('follow-up due uses the refill call list\'s own bands', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ followUp: 'due' }), [ctx.p2]);
  sameSet(await ids({ followUp: 'overdue' }), [ctx.p4]);
  sameSet(await ids({ followUp: 'lapsed' }), [ctx.p1]);
  sameSet(await ids({ followUp: 'any' }), [ctx.p1, ctx.p2, ctx.p4]);
});

test('assigned pharmacist, and unassigned', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ pharmacist: ctx.pharmacistX }), [ctx.p1]);
  sameSet(await ids({ pharmacist: 'unassigned' }), [ctx.p2, ctx.p3, ctx.p4]);
});

test('risk flags: a danger sign counts only within 90 days', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ risk: 'red_flag' }), [ctx.p3]);
  sameSet(await ids({ risk: 'lapsed' }), [ctx.p1]);
  sameSet(await ids({ risk: 'follow_up' }), [ctx.p1]);
  sameSet(await ids({ risk: 'any' }), [ctx.p1, ctx.p3]);
});

test('filters combine with AND', { skip: SKIP && skipReason }, async () => {
  sameSet(await ids({ gender: 'female', followUp: 'lapsed', risk: 'follow_up' }), [ctx.p1]);
  sameSet(await ids({ gender: 'male', followUp: 'lapsed' }), []);
});

// ---- what comes back -------------------------------------------------------

test('a result carries every column the list shows', { skip: SKIP && skipReason }, async () => {
  const res = await search.searchPatients(ctx.a.id, { q: 'Adaeze' }, { today: TODAY });
  const [p] = res.patients;
  assert.equal(p.name, 'Adaeze Okafor');
  assert.equal(p.age, 68);
  assert.equal(p.sex, 'female');
  assert.deepEqual(p.conditions, ['Hypertension']);
  assert.deepEqual(p.medications, ['Amlodipine 5mg']);
  assert.equal(p.lastVisitOn, '2026-09-18');
  assert.equal(p.followUp.status, 'lapsed');
  assert.equal(p.assignedPharmacist.id, ctx.pharmacistX);
  assert.deepEqual(p.risks, ['lapsed', 'follow_up']);
});

test('a patient with nothing due has no follow-up, not an "upcoming" one', { skip: SKIP && skipReason }, async () => {
  const { patients } = await search.searchPatients(ctx.a.id, { q: 'Chika' }, { today: TODAY });
  assert.equal(patients[0].followUp, null);
  assert.equal(patients[0].age, null);
  assert.equal(patients[0].sex, null);
});

test('the total counts every match, even when the page is smaller', { skip: SKIP && skipReason }, async () => {
  const res = await search.searchPatients(ctx.a.id, { limit: 2 }, { today: TODAY });
  assert.equal(res.patients.length, 2);
  assert.equal(res.total, 4);
});

test('filter options list only this pharmacy\'s conditions, and only pharmacists and the owner', { skip: SKIP && skipReason }, async () => {
  const opts = await search.searchOptions(ctx.a.id);
  assert.deepEqual(opts.condition.map((c) => c.value).sort(), ['DIABETES', 'HYPERTENSION']);
  assert.equal(opts.pharmacist[0].value, 'unassigned');
  const people = opts.pharmacist.slice(1).map((p) => p.value);
  assert.ok(people.includes(ctx.pharmacistX));
  assert.ok(people.includes(ctx.ownerA));
  assert.ok(!people.includes(ctx.staffS), 'staff are not offered as a patient\'s pharmacist');
  assert.ok(!people.includes(ctx.ownerB), 'another pharmacy\'s owner is not offered');
  assert.deepEqual(opts.medication.map((m) => m.value), ['Amlodipine 5mg', 'Lisinopril 10mg', 'Metformin 500mg']);
});

// ---- care details ----------------------------------------------------------

test('a patient can be assigned to one of their own pharmacy\'s pharmacists', { skip: SKIP && skipReason }, async () => {
  const result = await care.updateCare(ctx.a.id, ctx.p2, { assignedPharmacistId: ctx.pharmacistX });
  assert.equal(result.assignedPharmacist.id, ctx.pharmacistX);
  sameSet(await ids({ pharmacist: ctx.pharmacistX }), [ctx.p1, ctx.p2]);
  await care.updateCare(ctx.a.id, ctx.p2, { assignedPharmacistId: null });
  assert.equal((await care.getCare(ctx.a.id, ctx.p2)).assignedPharmacist, null);
});

test('staff, and anyone from another pharmacy, cannot be assigned', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(() => care.updateCare(ctx.a.id, ctx.p2, { assignedPharmacistId: ctx.staffS }),
    (err) => err.status === 400 && err.code === 'NOT_A_PHARMACIST');
  await assert.rejects(() => care.updateCare(ctx.a.id, ctx.p2, { assignedPharmacistId: ctx.ownerB }),
    (err) => err.status === 400 && err.code === 'NOT_A_MEMBER');
});

test('the database itself refuses an assignee from another pharmacy', { skip: SKIP && skipReason }, async () => {
  // The service check above is the friendly error; this is the guarantee.
  // A write that bypasses the service still cannot cross tenants.
  await assert.rejects(
    () => db`update customers set assigned_pharmacist_id = ${ctx.ownerB} where id = ${ctx.p3}`,
    (err) => err.code === '23503',
  );
});

test('a pharmacist leaving the pharmacy unassigns their patients rather than blocking the removal', { skip: SKIP && skipReason }, async () => {
  const leaver = await user('leaver');
  await db`insert into pharmacy_members (pharmacy_id, user_id, role) values (${ctx.a.id}, ${leaver}, 'pharmacist')`;
  await care.updateCare(ctx.a.id, ctx.p4, { assignedPharmacistId: leaver });
  await db`delete from pharmacy_members where pharmacy_id = ${ctx.a.id} and user_id = ${leaver}`;
  const [row] = await db`select pharmacy_id, assigned_pharmacist_id from customers where id = ${ctx.p4}`;
  assert.equal(row.assigned_pharmacist_id, null);
  assert.equal(row.pharmacy_id, ctx.a.id, 'only the assignee is cleared, never the patient\'s pharmacy');
});

test('staff can record age and gender, and the search sees them at once', { skip: SKIP && skipReason }, async () => {
  const result = await care.updateCare(ctx.a.id, ctx.p3, { ageYears: 45, sex: 'female' });
  assert.equal(result.ageYears, 45);
  assert.equal(result.sex, 'female');
  sameSet(await ids({ age: '40-59' }), [ctx.p3]);
  assert.ok((await ids({ gender: 'female' })).includes(ctx.p3));

  await care.updateCare(ctx.a.id, ctx.p3, { ageYears: null, sex: null });
  sameSet(await ids({ age: 'unknown' }), [ctx.p3]);
});

test('a date of birth outranks a reported age, and says so', { skip: SKIP && skipReason }, async () => {
  const result = await care.getCare(ctx.a.id, ctx.p1, { today: new Date('2026-09-19T12:00:00Z') });
  assert.equal(result.ageYears, 68);
  assert.equal(result.ageFromDateOfBirth, true);
  assert.equal((await care.getCare(ctx.a.id, ctx.p2)).ageFromDateOfBirth, false);
});

test('another pharmacy can neither read nor change a patient\'s care details', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(() => care.getCare(ctx.b.id, ctx.p1), (err) => err.status === 404);
  await assert.rejects(() => care.updateCare(ctx.b.id, ctx.p1, { sex: 'male' }), (err) => err.status === 404);
  assert.equal((await care.getCare(ctx.a.id, ctx.p1)).sex, 'female');
});
