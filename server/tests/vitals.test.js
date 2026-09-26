/**
 * Vitals and biometrics, against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a reading belongs to a pharmacy, and pharmacy B
 * must never see one of pharmacy A's — even asking with A's real customer
 * id. Every read here is scoped by pharmacy_id in its own WHERE clause
 * rather than checked after the fact (GOLDEN-001), and these tests plant a
 * reading under B on A's patient to prove it.
 *
 * The rest pin what the schema promises: BMI derived rather than stored, the
 * adult reference ranges never applied to a child, newest-first order, and
 * a row of nothing refused by the database itself.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — vitals NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'vitalstest';

let db;
let vitals;
let ctx = null;

async function patient(pharmacyId, phone, { ageYears = null } = {}) {
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, 'Vitals Tester', 'Vitals Tester')
    returning id
  `;
  if (ageYears !== null) {
    await db`insert into patient_profiles (pharmacy_id, customer_id, age_years) values (${pharmacyId}, ${c.id}, ${ageYears})`;
  }
  return c.id;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  vitals = require('../services/clinical/vitals');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  const adult = await patient(a.id, '2349070000001', { ageYears: 55 });
  const child = await patient(a.id, '2349070000002', { ageYears: 4 });
  const unknown = await patient(a.id, '2349070000003');

  ctx = {
    a, b, userA, adult, child, unknown,
  };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ---------------------------------------------------

test('pharmacy B never sees pharmacy A\'s reading, even asking with A\'s patient id', { skip: SKIP && skipReason }, async () => {
  await vitals.recordVitals(ctx.a.id, ctx.adult, { pulse: 72 }, { actorId: ctx.userA });
  // B writes its own reading against the same customer id. Nothing stops the
  // row existing; the read must refuse to return it to A, and A's to B.
  await db`
    insert into patient_vitals (pharmacy_id, customer_id, pulse) values (${ctx.b.id}, ${ctx.adult}, 199)
  `;

  const mine = await vitals.listVitals(ctx.a.id, ctx.adult);
  assert.ok(mine.readings.every((r) => r.pulse !== 199), 'pharmacy B\'s reading leaked into A');

  // And B asking for A's patient gets the same empty answer as a patient
  // with nothing recorded — no way to tell "not yours" from "nothing here".
  const theirs = await vitals.listVitals(ctx.b.id, ctx.unknown);
  assert.deepEqual(theirs.readings, []);
  assert.equal(theirs.total, 0);
});

test('recording against another pharmacy\'s patient is refused, not silently filed', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => vitals.recordVitals(ctx.b.id, ctx.adult, { pulse: 80 }),
    (err) => err.status === 404 && err.code === 'NOT_FOUND',
  );
});

// ---- what the schema promises ---------------------------------------------

test('BMI is derived on every read, and is not a column', { skip: SKIP && skipReason }, async () => {
  const saved = await vitals.recordVitals(ctx.a.id, ctx.adult, { weight: 60, height: 150 });
  assert.equal(saved.bmi, 26.7);
  const columns = await db`
    select column_name from information_schema.columns where table_name = 'patient_vitals'
  `;
  const names = columns.map((c) => c.column_name);
  assert.ok(!names.includes('bmi'), 'bmi must not be stored — it is wrong the moment a measurement is corrected');
  assert.ok(!names.some((n) => n.includes('abnormal') || n.includes('severity')),
    'no stored interpretation: whether a number is unusual is decided at read time');
});

test('the adult ranges flag an adult and never a child', { skip: SKIP && skipReason }, async () => {
  const reading = { pulse: 120, spo2: 91 };
  await vitals.recordVitals(ctx.a.id, ctx.adult, reading);
  await vitals.recordVitals(ctx.a.id, ctx.child, reading);

  const grown = await vitals.listVitals(ctx.a.id, ctx.adult);
  assert.equal(grown.ageYears, 55);
  assert.equal(grown.readings[0].abnormal.pulse, 'high');
  assert.equal(grown.readings[0].abnormal.spo2, 'low');

  // Same numbers, four years old: ordinary, and marked as nothing.
  const small = await vitals.listVitals(ctx.a.id, ctx.child);
  assert.equal(small.ageYears, 4);
  assert.deepEqual(small.readings[0].abnormal, {});
});

test('an unknown age flags nothing, rather than assuming an adult', { skip: SKIP && skipReason }, async () => {
  await vitals.recordVitals(ctx.a.id, ctx.unknown, { pulse: 150 });
  const page = await vitals.listVitals(ctx.a.id, ctx.unknown);
  assert.equal(page.ageYears, null);
  assert.deepEqual(page.readings[0].abnormal, {});
});

test('readings come back newest first, and the page count is the whole count', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349070000004', { ageYears: 30 });
  const day = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();
  for (const n of [1, 2, 3]) {
    await vitals.recordVitals(ctx.a.id, p, { pulse: 60 + n, recordedAt: day(n) });
  }
  const page = await vitals.listVitals(ctx.a.id, p, { limit: 2 });
  assert.equal(page.readings.length, 2);
  assert.equal(page.total, 3, 'the total is every reading, not the page');
  assert.deepEqual(page.readings.map((r) => r.pulse), [63, 62]);

  const second = await vitals.listVitals(ctx.a.id, p, { limit: 2, offset: 2 });
  assert.deepEqual(second.readings.map((r) => r.pulse), [61]);

  // The chart reads the same data the other way round.
  const series = await vitals.vitalsSeries(ctx.a.id, p);
  assert.deepEqual(series.map((r) => r.pulse), [61, 62, 63]);
});

test('a reading of nothing at all is refused by the database', { skip: SKIP && skipReason }, async () => {
  // The service layer refuses it too (vitalsInput.test.js), but the table is
  // the last word: a dated blank would appear on the chart as a day with no
  // numbers, and no read path should have to filter for that.
  await assert.rejects(
    () => db`insert into patient_vitals (pharmacy_id, customer_id) values (${ctx.a.id}, ${ctx.adult})`,
    (err) => /patient_vitals_not_empty/.test(err.message),
  );
});

test('an alarming reading stores, because a schema that refuses one loses it', { skip: SKIP && skipReason }, async () => {
  const saved = await vitals.recordVitals(ctx.a.id, ctx.adult, { systolic: 210, diastolic: 130, spo2: 82 });
  assert.equal(saved.systolic, 210);
  assert.equal(saved.spo2, 82);
});

test('a decimal comes back as a number, not as the string postgres stores', { skip: SKIP && skipReason }, async () => {
  const saved = await vitals.recordVitals(ctx.a.id, ctx.adult, { temperature: 36.8, weight: 72.5 });
  assert.strictEqual(saved.temperature, 36.8);
  assert.strictEqual(saved.weight, 72.5);
});

test('who recorded it is kept, and survives that member leaving the pharmacy', { skip: SKIP && skipReason }, async () => {
  const saved = await vitals.recordVitals(ctx.a.id, ctx.adult, { pulse: 70 }, { actorId: ctx.userA });
  assert.equal(saved.recordedBy, ctx.userA);
  // No foreign key to pharmacy_members: the reading is still a fact about
  // the patient after the person who took it is gone.
  await db`delete from pharmacy_members where pharmacy_id = ${ctx.a.id} and user_id = ${ctx.userA}`;
  const [still] = await db`select recorded_by from patient_vitals where id = ${saved.id}`;
  assert.equal(still.recorded_by, ctx.userA);
  await db`insert into pharmacy_members (pharmacy_id, user_id, role) values (${ctx.a.id}, ${ctx.userA}, 'owner')`;
});

test('the reference band travels with an adult\'s readings, and never a child\'s', { skip: SKIP && skipReason }, async () => {
  // The chart shades these bounds as "the usual range". They come from the
  // server so the band and the red in the table can never disagree — and
  // they are absent for a child, so no band is drawn against one.
  const grown = await vitals.listVitals(ctx.a.id, ctx.adult);
  assert.ok(grown.ranges, 'an adult gets the bounds');
  assert.deepEqual(grown.ranges.spo2, { min: 94, max: 100 });
  assert.ok(!('weight' in grown.ranges), 'a weight has no usual range');

  const small = await vitals.listVitals(ctx.a.id, ctx.child);
  assert.equal(small.ranges, null);
  const nobody = await vitals.listVitals(ctx.a.id, ctx.unknown);
  assert.equal(nobody.ranges, null);
});
