/**
 * Diagnostic tests and their results, against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a test belongs to a pharmacy, and pharmacy B must
 * never read or write one of pharmacy A's (GOLDEN-001).
 *
 * Then the three things this record exists to get right: a value entered is
 * never a signed-off result by itself; a finalised report cannot be changed
 * without keeping what it said; and a result is evidence — it never becomes a
 * diagnosis, a vital sign, or anything else on its own.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the test record NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'labtest';
const TODAY = '2026-09-23';

let db;
let tests;
let ctx = null;

const { readTestInput, readTestPatch } = require('../services/clinical/testInput');
const input = (b) => readTestInput(b, { today: TODAY });
const patch = (b) => readTestPatch(b, { today: TODAY });
const PHARMACIST = (userId) => ({ actorId: userId, actorRole: 'pharmacist' });
const STAFF = (userId) => ({ actorId: userId, actorRole: 'staff' });

const FBG = (over = {}) => ({
  testName: 'Fasting blood glucose', testCode: 'FBG', category: 'chemistry', specimen: 'blood',
  performed: '2026-09-20',
  results: [{
    analyteName: 'Fasting blood glucose', analyteCode: 'FBG', valueNumber: 108, unit: 'mg/dL',
    referenceLow: 70, referenceHigh: 99, interpretation: 'high',
  }],
  ...over,
});

let phone = 2349100000000;
async function patient(pharmacyId) {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, 'Test Tester', 'Test Tester')
    returning id
  `;
  return c.id;
}

async function events(customerId, type) {
  return db`
    select event_type, actor_type, actor_id, metadata, visibility from customer_events
    where customer_id = ${customerId} and event_type = ${type}
    order by occurred_at, id
  `;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  tests = require('../services/clinical/tests');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const staffA = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}),
    (${userB}, ${`${TAG}-b-${userB}@example.test`}),
    (${staffA}, ${`${TAG}-s-${staffA}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });
  ctx = { a, b, userA, userB, staffA };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ---------------------------------------------------

test('pharmacy B cannot read, order or edit a test on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await tests.addTest(ctx.a.id, p, input(FBG()), PHARMACIST(ctx.userA));

  const theirs = await tests.listTests(ctx.b.id, p);
  assert.deepEqual(theirs.tests, []);
  assert.equal(theirs.counts.all, 0);
  await assert.rejects(() => tests.getTest(ctx.b.id, p, mine.id), (e) => e.status === 404);
  await assert.rejects(
    () => tests.updateTest(ctx.b.id, p, mine.id, patch({ notes: 'not mine' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => tests.addTest(ctx.b.id, p, input({ testName: 'Malaria RDT' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  assert.deepEqual((await tests.testTrend(ctx.b.id, p, { code: 'FBG' })).points, []);
  assert.equal((await tests.getTest(ctx.a.id, p, mine.id)).notes, null);
});

// ---- the record -----------------------------------------------------------

test('a quantitative result keeps its value, unit, range and reading after a refresh', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await tests.addTest(ctx.a.id, p, input(FBG({
    reason: 'Thirst and fatigue', source: 'external_lab', sourceName: 'Synlab · 2026-0918-441',
    performedByName: 'Synlab, Ikeja', ordererName: 'Dr Okafor', priority: 'urgent',
  })), PHARMACIST(ctx.userA));

  const back = await tests.getTest(ctx.a.id, p, saved.id);
  assert.equal(back.testName, 'Fasting blood glucose');
  assert.equal(back.category, 'chemistry');
  assert.equal(back.specimen, 'blood');
  assert.equal(back.priority, 'urgent');
  assert.equal(back.source, 'external_lab');
  assert.match(back.sourceName, /2026-0918-441/);
  assert.equal(back.performedByName, 'Synlab, Ikeja');
  assert.equal(back.ordererName, 'Dr Okafor');
  // Entering a value never finalises it.
  assert.equal(back.status, 'preliminary');
  const r = back.results[0];
  assert.equal(r.valueNumber, 108);
  assert.equal(r.unit, 'mg/dL');
  assert.equal(r.referenceLow, 70);
  assert.equal(r.referenceHigh, 99);
  assert.equal(r.interpretation, 'high');
  assert.equal(back.abnormal, true, 'a high result is flagged for a pharmacist');
  assert.equal(back.critical, false);
  assert.equal(back.recordedBy.id, ctx.userA);
});

test('coded and text results are stored as what they are', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const rdt = await tests.addTest(ctx.a.id, p, input({
    testName: 'Malaria RDT', testCode: 'MAL_RDT', category: 'rapid_test', specimen: 'blood', performed: TODAY,
    results: [{ analyteName: 'Malaria RDT', valueCode: 'positive', valueDisplay: 'Positive', interpretation: 'positive' }],
  }), PHARMACIST(ctx.userA));
  assert.equal(rdt.results[0].valueDisplay, 'Positive');
  assert.equal(rdt.results[0].valueNumber, null);
  assert.equal(rdt.abnormal, true, 'a positive RDT is something to look at');

  const xray = await tests.addTest(ctx.a.id, p, input({
    testName: 'Chest X-ray', category: 'imaging', specimen: 'not_applicable', performed: TODAY,
    results: [{ analyteName: 'Report', valueText: 'No focal consolidation. Heart size normal.', interpretation: 'normal' }],
  }), PHARMACIST(ctx.userA));
  assert.match(xray.results[0].valueText, /No focal consolidation/);
  assert.equal(xray.abnormal, false);
});

test('one test carries a whole panel, each analyte with its own range', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const lipid = await tests.addTest(ctx.a.id, p, input({
    testName: 'Lipid profile', testCode: 'LIPID', category: 'chemistry', performed: '2026-09-18',
    results: [
      { analyteName: 'Total cholesterol', analyteCode: 'TC', valueNumber: 210, unit: 'mg/dL', referenceHigh: 200, interpretation: 'high' },
      { analyteName: 'HDL cholesterol', analyteCode: 'HDL', valueNumber: 55, unit: 'mg/dL', referenceLow: 40, interpretation: 'normal' },
      { analyteName: 'LDL cholesterol', analyteCode: 'LDL', valueNumber: 130, unit: 'mg/dL', referenceHigh: 100, interpretation: 'high' },
      { analyteName: 'Triglycerides', analyteCode: 'TRIG', valueNumber: 140, unit: 'mg/dL', referenceHigh: 150, interpretation: 'normal' },
    ],
  }), PHARMACIST(ctx.userA));
  assert.deepEqual(lipid.results.map((r) => r.analyteCode), ['TC', 'HDL', 'LDL', 'TRIG'], 'in the order entered');
  assert.equal(lipid.results[1].referenceLow, 40);
  assert.equal(lipid.abnormal, true);
});

// ---- the lifecycle --------------------------------------------------------

test('an ordered test has no result, and gains one without being finalised', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const ordered = await tests.addTest(ctx.a.id, p, input({
    testName: 'Lipid profile', category: 'chemistry', reason: 'Annual check', orderedOn: TODAY,
  }), STAFF(ctx.staffA));
  assert.equal(ordered.status, 'ordered');
  assert.deepEqual(ordered.results, []);
  assert.equal(ordered.performed.at, null);

  const withResult = await tests.updateTest(ctx.a.id, p, ordered.id, patch({
    performed: '2026-09-22',
    results: [{ analyteName: 'Total cholesterol', valueNumber: 180, unit: 'mg/dL', referenceHigh: 200, interpretation: 'normal' }],
  }), STAFF(ctx.staffA));
  assert.equal(withResult.status, 'preliminary', 'a value entered is not a signed-off result');

  const final = await tests.updateTest(ctx.a.id, p, ordered.id, patch({ status: 'final' }), PHARMACIST(ctx.userA));
  assert.equal(final.status, 'final');
  assert.equal(final.results.length, 1);
});

test('a cancelled test keeps its reason and is never deleted', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const t = await tests.addTest(ctx.a.id, p, input({ testName: 'Urinalysis', orderedOn: TODAY }), STAFF(ctx.staffA));
  const cancelled = await tests.updateTest(ctx.a.id, p, t.id, patch({
    status: 'cancelled', statusReason: 'Patient did not return with the sample.',
  }), PHARMACIST(ctx.userA));
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.statusReason, /did not return/);
  const { counts } = await tests.listTests(ctx.a.id, p);
  assert.equal(counts.all, 1);
});

// ---- corrections ----------------------------------------------------------

test('CORRECTING a final result keeps what it said, with a reason', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const t = await tests.addTest(ctx.a.id, p, input({
    testName: 'HbA1c', testCode: 'HBA1C', category: 'chemistry', performed: '2026-06-10', status: 'final',
    results: [{ analyteName: 'HbA1c', analyteCode: 'HBA1C', valueNumber: 8.1, unit: '%', referenceLow: 4, referenceHigh: 5.6, interpretation: 'high' }],
  }), PHARMACIST(ctx.userA));
  assert.equal(t.status, 'final');

  // Editing a signed-off report without saying why is refused.
  await assert.rejects(
    () => tests.updateTest(ctx.a.id, p, t.id, patch({
      results: [{ analyteName: 'HbA1c', analyteCode: 'HBA1C', valueNumber: 7.8, unit: '%', referenceLow: 4, referenceHigh: 5.6, interpretation: 'high' }],
    }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'statusReason',
  );

  const corrected = await tests.updateTest(ctx.a.id, p, t.id, patch({
    statusReason: 'Laboratory reissued the report: 7.8 %, not 8.1 %.',
    results: [{ analyteName: 'HbA1c', analyteCode: 'HBA1C', valueNumber: 7.8, unit: '%', referenceLow: 4, referenceHigh: 5.6, interpretation: 'high' }],
  }), PHARMACIST(ctx.userA));
  assert.equal(corrected.status, 'corrected');
  assert.equal(corrected.results[0].valueNumber, 7.8);
  // What it said before is kept, and readable.
  assert.equal(corrected.corrections.length, 1);
  assert.equal(corrected.corrections[0].snapshot.results[0].valueNumber, 8.1);
  assert.match(corrected.corrections[0].reason, /reissued/);
  assert.equal(corrected.corrections[0].by, (await db`select email from auth.users where id = ${ctx.userA}`)[0].email);

  const audit = await events(p, 'TEST_CORRECTED');
  assert.equal(audit.length, 1);
  assert.match(audit[0].metadata.reason, /reissued/);
  assert.equal(audit[0].visibility, 'internal');

  // A form that round-trips the status it loaded does not get to keep
  // "Completed" on a report whose values it just changed.
  const again = await tests.updateTest(ctx.a.id, p, t.id, patch({
    status: 'final', statusReason: 'Second reissue.',
    results: [{ analyteName: 'HbA1c', analyteCode: 'HBA1C', valueNumber: 7.6, unit: '%', referenceLow: 4, referenceHigh: 5.6, interpretation: 'high' }],
  }), PHARMACIST(ctx.userA));
  assert.equal(again.status, 'corrected');
  assert.equal(again.corrections.length, 2, 'each correction is kept');
});

test('a preliminary result is edited freely — no correction is invented', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const t = await tests.addTest(ctx.a.id, p, input(FBG()), STAFF(ctx.staffA));
  assert.equal(t.status, 'preliminary');
  const edited = await tests.updateTest(ctx.a.id, p, t.id, patch({
    results: [{ analyteName: 'Fasting blood glucose', analyteCode: 'FBG', valueNumber: 102, unit: 'mg/dL', referenceLow: 70, referenceHigh: 99, interpretation: 'high' }],
  }), STAFF(ctx.staffA));
  assert.equal(edited.status, 'preliminary');
  assert.equal(edited.results[0].valueNumber, 102);
  assert.equal(edited.corrections.length, 0);
});

// ---- who may do what ------------------------------------------------------

test('staff may order and record; only a pharmacist finalises, corrects or cancels', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const t = await tests.addTest(ctx.a.id, p, input(FBG()), STAFF(ctx.staffA));
  const refused = (e) => e.status === 403 && e.code === 'FORBIDDEN_ROLE';

  await assert.rejects(() => tests.updateTest(ctx.a.id, p, t.id, patch({ status: 'final' }), STAFF(ctx.staffA)), refused);
  await assert.rejects(
    () => tests.updateTest(ctx.a.id, p, t.id, patch({ status: 'cancelled', statusReason: 'x' }), STAFF(ctx.staffA)),
    refused,
  );
  await assert.rejects(
    () => tests.addTest(ctx.a.id, p, input(FBG({ status: 'final' })), STAFF(ctx.staffA)),
    refused,
  );
  const ok = await tests.updateTest(ctx.a.id, p, t.id, patch({ status: 'final' }), PHARMACIST(ctx.userA));
  assert.equal(ok.status, 'final');
  // And staff cannot correct the finalised one either.
  await assert.rejects(
    () => tests.updateTest(ctx.a.id, p, t.id, patch({ statusReason: 'x', notes: 'edit' }), STAFF(ctx.staffA)),
    refused,
  );
});

// ---- reading it -----------------------------------------------------------

test('the filters count what they say, and search finds a test by name', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await tests.addTest(ctx.a.id, p, input({ testName: 'Lipid profile', orderedOn: TODAY }), PHARMACIST(ctx.userA));
  await tests.addTest(ctx.a.id, p, input({ testName: 'Urinalysis', status: 'pending', orderedOn: TODAY }), PHARMACIST(ctx.userA));
  await tests.addTest(ctx.a.id, p, input(FBG({ status: 'final' })), PHARMACIST(ctx.userA));
  await tests.addTest(ctx.a.id, p, input({
    testName: 'HbA1c', category: 'chemistry', performed: '2026-03', historical: true, status: 'final',
    source: 'patient_reported',
    results: [{ analyteName: 'HbA1c', valueNumber: 8.4, unit: '%', interpretation: 'high' }],
  }), PHARMACIST(ctx.userA));

  const { counts } = await tests.listTests(ctx.a.id, p);
  assert.deepEqual(counts, { all: 4, ordered: 1, pending: 1, completed: 2, abnormal: 2, historical: 1 });

  const abnormal = await tests.listTests(ctx.a.id, p, { filter: 'abnormal' });
  assert.deepEqual(abnormal.tests.map((t) => t.testName).sort(), ['Fasting blood glucose', 'HbA1c']);
  const historical = await tests.listTests(ctx.a.id, p, { filter: 'historical' });
  assert.deepEqual(historical.tests.map((t) => t.testName), ['HbA1c']);
  const found = await tests.listTests(ctx.a.id, p, { q: 'urin' });
  assert.deepEqual(found.tests.map((t) => t.testName), ['Urinalysis']);
  const chem = await tests.listTests(ctx.a.id, p, { category: 'chemistry' });
  assert.equal(chem.tests.length, 2);
  // The counts describe the whole record, not the filtered view.
  assert.equal(found.counts.all, 4);
});

test('a repeated measurement reads as a trend, oldest first and in one unit', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  for (const [performed, value] of [['2025-12-10', 8.9], ['2026-03-10', 8.4], ['2026-06-10', 7.8]]) {
    await tests.addTest(ctx.a.id, p, input({
      testName: 'HbA1c', testCode: 'HBA1C', category: 'chemistry', performed, status: 'final',
      results: [{ analyteName: 'HbA1c', analyteCode: 'HBA1C', valueNumber: value, unit: '%', referenceLow: 4, referenceHigh: 5.6, interpretation: 'high' }],
    }), PHARMACIST(ctx.userA));
  }
  // A result in a different unit is not plotted on the same axis.
  await tests.addTest(ctx.a.id, p, input({
    testName: 'HbA1c', testCode: 'HBA1C', category: 'chemistry', performed: '2026-08-10', status: 'final',
    results: [{ analyteName: 'HbA1c', analyteCode: 'HBA1C', valueNumber: 62, unit: 'mmol/mol', interpretation: 'high' }],
  }), PHARMACIST(ctx.userA));
  // An ordered test with no result contributes nothing.
  await tests.addTest(ctx.a.id, p, input({ testName: 'HbA1c', testCode: 'HBA1C', orderedOn: TODAY }), PHARMACIST(ctx.userA));

  const trend = await tests.testTrend(ctx.a.id, p, { code: 'HBA1C' });
  assert.equal(trend.unit, '%');
  assert.deepEqual(trend.points.map((pt) => pt.value), [8.9, 8.4, 7.8]);
  assert.deepEqual(trend.ranges, { min: 4, max: 5.6 });
  assert.deepEqual(await tests.testTrend(ctx.a.id, p, { code: 'NOPE' }), { points: [], unit: null, analyte: null });
});

test('a test is shown beside a recorded condition and its medicines — never creating either', { skip: SKIP && skipReason }, async () => {
  const problems = require('../services/clinical/problems');
  const meds = require('../services/clinical/medications');
  const { readProblemInput } = require('../services/clinical/problemInput');
  const p = await patient(ctx.a.id);

  const [definition] = await db`select id from test_definitions where code = 'HBA1C' and pharmacy_id is null`;
  const t = await tests.addTest(ctx.a.id, p, input({
    definitionId: definition.id, testName: 'HbA1c', testCode: 'HBA1C', category: 'chemistry',
    performed: TODAY, status: 'final',
    results: [{ analyteName: 'HbA1c', valueNumber: 8.1, unit: '%', referenceHigh: 5.6, interpretation: 'high' }],
  }), PHARMACIST(ctx.userA));

  // Before anything is recorded: no relationships are invented.
  let full = await tests.getTest(ctx.a.id, p, t.id);
  assert.deepEqual(full.relatedConditions, []);
  assert.deepEqual(full.relatedMedicines, []);
  // A high HbA1c did NOT create a condition.
  assert.equal((await problems.listProblems(ctx.a.id, p)).conditions.length, 0);

  // A pharmacist records the condition themselves, and the medicine for it.
  await problems.addProblem(ctx.a.id, p, readProblemInput({
    conditionName: 'Type 2 diabetes mellitus', codeSystem: 'icd10', code: 'E11', localCode: 'DIABETES',
    category: 'chronic', verificationStatus: 'confirmed',
  }, { today: TODAY }), PHARMACIST(ctx.userA));
  await meds.addMedication(ctx.a.id, p, {
    medicineName: 'Metformin', strength: '500 mg', startedOn: '2026-09-01', status: 'active',
    source: 'prescribed', conditionCode: 'DIABETES',
  });

  full = await tests.getTest(ctx.a.id, p, t.id);
  assert.deepEqual(full.relatedConditions.map((c) => c.conditionName), ['Type 2 diabetes mellitus']);
  assert.deepEqual(full.relatedMedicines.map((m) => m.medicineName), ['Metformin']);
});

test('a consultation is linked by id, and another patient\'s is refused', { skip: SKIP && skipReason }, async () => {
  const encounters = require('../services/clinical/clinicalEncounterService');
  const p = await patient(ctx.a.id);
  const other = await patient(ctx.a.id);
  const enc = await encounters.createEncounter(ctx.a.id, p, { presentingComplaint: 'Fatigue' });
  const theirs = await encounters.createEncounter(ctx.a.id, other, { presentingComplaint: 'Not yours' });

  const t = await tests.addTest(ctx.a.id, p, input(FBG({ encounterId: enc.id })), PHARMACIST(ctx.userA));
  assert.equal(t.encounter.id, enc.id);
  assert.equal(t.encounter.complaint, 'Fatigue');
  await assert.rejects(
    () => tests.addTest(ctx.a.id, p, input(FBG({ encounterId: theirs.id })), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'encounterId',
  );
});

test('the catalogue is shipped to every pharmacy and owned by none', { skip: SKIP && skipReason }, async () => {
  const all = await tests.testCatalogue(ctx.a.id, '', { limit: 60 });
  assert.ok(all.length >= 25, 'the shipped catalogue is there');
  const hba1c = all.find((d) => d.code === 'HBA1C');
  assert.equal(hba1c.unit, '%');
  assert.equal(hba1c.resultType, 'quantitative');
  assert.equal(hba1c.conditionCode, 'DIABETES');
  const rdt = all.find((d) => d.code === 'MAL_RDT');
  assert.deepEqual(rdt.codedOptions.map((o) => o.code), ['positive', 'negative', 'invalid']);
  assert.equal(all.find((d) => d.code === 'LIPID').analytes.length, 4);
  // Pharmacy B sees the same shipped rows — they belong to the product.
  assert.equal((await tests.testCatalogue(ctx.b.id, 'hba1c')).length, 1);
  assert.deepEqual((await tests.testCatalogue(ctx.a.id, 'malar')).map((d) => d.code), ['MAL_RDT']);
});

test('the summary other screens show carries the last results and what needs looking at', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await tests.addTest(ctx.a.id, p, input(FBG({ status: 'final' })), PHARMACIST(ctx.userA));
  await tests.addTest(ctx.a.id, p, input({ testName: 'Lipid profile', orderedOn: TODAY }), PHARMACIST(ctx.userA));
  const s = await tests.testSummary(ctx.a.id, p);
  assert.equal(s.pending, 1);
  assert.equal(s.counts.abnormal, 1);
  assert.deepEqual(s.recent.map((t) => t.testName), ['Fasting blood glucose']);
  assert.deepEqual(s.recent[0].result, { value: 108, unit: 'mg/dL', interpretation: 'high' });
  assert.equal(s.recent[0].abnormal, true);

  // And the medication context carries it, beside the allergies and
  // conditions — one compact clinical context, never a second chart.
  const context = await require('../services/clinical/medications').medicationContext(ctx.a.id, p);
  assert.equal(context.tests.counts.abnormal, 1);
  assert.deepEqual(context.tests.recent.map((t) => t.testName), ['Fasting blood glucose']);
});

// ---- the database's own guarantees ----------------------------------------

test('the database refuses a result that is two things at once, or a report with no date', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const t = await tests.addTest(ctx.a.id, p, input(FBG()), PHARMACIST(ctx.userA));
  await assert.rejects(
    () => db`
      insert into patient_test_results (pharmacy_id, test_id, analyte_name, value_number, value_code)
      values (${ctx.a.id}, ${t.id}, 'Confused', 1, 'positive')
    `,
    /patient_test_results_one_value/,
  );
  await assert.rejects(
    () => db`update patient_tests set performed_at = null, performed_precision = null where id = ${t.id}`,
    /patient_tests_reported_has_date/,
  );
  await assert.rejects(
    () => db`update patient_tests set status = 'cancelled' where id = ${t.id}`,
    /patient_tests_status_reason/,
  );
});

test('every change is traceable: who, what changed, and why', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const t = await tests.addTest(ctx.a.id, p, input({ testName: 'Urinalysis', orderedOn: TODAY }), STAFF(ctx.staffA));
  await tests.updateTest(ctx.a.id, p, t.id, patch({ priority: 'urgent' }), STAFF(ctx.staffA));
  await tests.updateTest(ctx.a.id, p, t.id, patch({
    performed: TODAY, results: [{ analyteName: 'Urinalysis', valueText: 'Nitrites positive.', interpretation: 'abnormal' }],
  }), STAFF(ctx.staffA));
  await tests.updateTest(ctx.a.id, p, t.id, patch({ status: 'final' }), PHARMACIST(ctx.userA));
  // A save that changes nothing writes nothing.
  await tests.updateTest(ctx.a.id, p, t.id, patch({ priority: 'urgent' }), PHARMACIST(ctx.userA));

  const ordered = await events(p, 'TEST_ORDERED');
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].actor_type, 'staff');
  assert.equal(ordered[0].metadata.test, 'Urinalysis');
  assert.equal((await events(p, 'TEST_UPDATED')).length, 1);
  const recorded = await events(p, 'TEST_RESULT_RECORDED');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].metadata.changes.status, { from: 'ordered', to: 'preliminary' });
  const statusChanged = await events(p, 'TEST_STATUS_CHANGED');
  assert.equal(statusChanged.length, 1);
  assert.deepEqual(statusChanged[0].metadata.changes.status, { from: 'preliminary', to: 'final' });
  assert.equal(statusChanged[0].actor_id, ctx.userA);
});
