/**
 * Conditions — the problem list — against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a condition belongs to a pharmacy, and pharmacy B
 * must never read or write one of pharmacy A's (GOLDEN-001).
 *
 * Then what the list exists to get right: a recorded condition is never
 * confused with the purchase engine's inference; a duplicate current
 * condition is not created by accident; nothing is deleted — resolved and
 * refuted records stay, with their reasons; and a consultation or a vitals
 * reading is LINKED, never copied, and only if it is this patient's own.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the problem list NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'probtest';
const TODAY = '2026-09-22';

let db;
let problems;
let ctx = null;

const { readProblemInput, readProblemPatch } = require('../services/clinical/problemInput');
const input = (b) => readProblemInput(b, { today: TODAY });
const patch = (b) => readProblemPatch(b, { today: TODAY });
const PHARMACIST = (userId) => ({ actorId: userId, actorRole: 'pharmacist' });
const STAFF = (userId) => ({ actorId: userId, actorRole: 'staff' });
const HTN = { conditionName: 'Hypertension', codeSystem: 'icd10', code: 'I10', localCode: 'HYPERTENSION', category: 'chronic' };

let phone = 2349090000000;
async function patient(pharmacyId) {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, 'Condition Tester', 'Condition Tester')
    returning id
  `;
  return c.id;
}

async function vitals(pharmacyId, customerId, sys = 148, dia = 92) {
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic, diastolic)
    values (${pharmacyId}, ${customerId}, now() - interval '1 day', ${sys}, ${dia})
    returning id
  `;
  return v.id;
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
  problems = require('../services/clinical/problems');

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

test('pharmacy B cannot read, record or edit a condition on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await problems.addProblem(ctx.a.id, p, input(HTN), PHARMACIST(ctx.userA));

  assert.deepEqual(await problems.listProblems(ctx.b.id, p), { conditions: [], history: [], suggestions: [] });
  await assert.rejects(() => problems.getProblem(ctx.b.id, p, mine.id), (e) => e.status === 404);
  await assert.rejects(
    () => problems.updateProblem(ctx.b.id, p, mine.id, patch({ severity: 'mild' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => problems.addProblem(ctx.b.id, p, input({ conditionName: 'Asthma' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  assert.deepEqual(await problems.encounterChoices(ctx.b.id, p), []);
  assert.equal((await problems.getProblem(ctx.a.id, p, mine.id)).severity, null);
});

// ---- the record -----------------------------------------------------------

test('every field comes back as entered — after a refresh, with the consultation and reading linked', { skip: SKIP && skipReason }, async () => {
  const encounters = require('../services/clinical/clinicalEncounterService');
  const p = await patient(ctx.a.id);
  const enc = await encounters.createEncounter(ctx.a.id, p, { presentingComplaint: 'BP check' });
  const v = await vitals(ctx.a.id, p);

  const saved = await problems.addProblem(ctx.a.id, p, input({
    ...HTN,
    clinicalStatus: 'active',
    verificationStatus: 'confirmed',
    severity: 'moderate',
    bodySite: 'Not applicable',
    onset: '2022',
    onsetNote: 'Found at a work health check',
    source: 'previous_record',
    assertedByName: 'Dr Okafor, LUTH',
    encounterId: enc.id,
    evidenceVitalsIds: [v],
    notes: 'Diagnosed at a hospital in 2022. Currently taking amlodipine.',
  }), PHARMACIST(ctx.userA));

  const back = await problems.getProblem(ctx.a.id, p, saved.id);
  assert.equal(back.conditionName, 'Hypertension');
  assert.equal(back.code, 'I10');
  assert.equal(back.codeSystem, 'icd10');
  assert.equal(back.localCode, 'HYPERTENSION');
  assert.equal(back.category, 'chronic');
  assert.equal(back.clinicalStatus, 'active');
  assert.equal(back.verificationStatus, 'confirmed');
  assert.equal(back.severity, 'moderate');
  assert.equal(back.bodySite, 'Not applicable');
  assert.deepEqual(back.onset, { date: '2022-01-01', precision: 'year', note: 'Found at a work health check' });
  assert.equal(back.source, 'previous_record');
  assert.equal(back.assertedByName, 'Dr Okafor, LUTH');
  assert.match(back.notes, /amlodipine/);
  assert.equal(back.recordedBy.id, ctx.userA);
  // Linked, not copied: the consultation and the reading are their own rows.
  assert.equal(back.encounter.id, enc.id);
  assert.equal(back.encounter.complaint, 'BP check');
  assert.equal(back.evidence.length, 1);
  assert.equal(back.evidence[0].vitalsId, v);
  assert.equal(back.evidence[0].systolic, 148);
});

test('the medicines for a condition are shown beside it, never merged into it', { skip: SKIP && skipReason }, async () => {
  const meds = require('../services/clinical/medications');
  const p = await patient(ctx.a.id);
  await meds.addMedication(ctx.a.id, p, {
    medicineName: 'Amlodipine', strength: '5 mg', startedOn: '2026-09-01', status: 'active',
    source: 'prescribed', conditionCode: 'HYPERTENSION',
  });
  const c = await problems.addProblem(ctx.a.id, p, input(HTN), PHARMACIST(ctx.userA));
  const back = await problems.getProblem(ctx.a.id, p, c.id);
  assert.deepEqual(back.relatedMedicines.map((m) => m.medicineName), ['Amlodipine']);
});

test('an edit changes what it names, leaves the rest, and replaces the readings', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const v1 = await vitals(ctx.a.id, p, 150, 95);
  const v2 = await vitals(ctx.a.id, p, 142, 90);
  const c = await problems.addProblem(ctx.a.id, p, input({ ...HTN, notes: 'Keep', evidenceVitalsIds: [v1] }), PHARMACIST(ctx.userA));

  const edited = await problems.updateProblem(ctx.a.id, p, c.id, patch({
    severity: 'severe', bodySite: 'n/a', evidenceVitalsIds: [v2],
  }), PHARMACIST(ctx.userA));
  assert.equal(edited.severity, 'severe');
  assert.equal(edited.notes, 'Keep');
  assert.deepEqual(edited.evidence.map((e) => e.vitalsId), [v2]);
});

test('a consultation or reading from ANOTHER patient cannot be linked', { skip: SKIP && skipReason }, async () => {
  const encounters = require('../services/clinical/clinicalEncounterService');
  const p = await patient(ctx.a.id);
  const other = await patient(ctx.a.id);
  const theirEnc = await encounters.createEncounter(ctx.a.id, other, { presentingComplaint: 'Not yours' });
  const theirVitals = await vitals(ctx.a.id, other);

  await assert.rejects(
    () => problems.addProblem(ctx.a.id, p, input({ ...HTN, encounterId: theirEnc.id }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'encounterId',
  );
  await assert.rejects(
    () => problems.addProblem(ctx.a.id, p, input({ ...HTN, evidenceVitalsIds: [theirVitals] }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'evidenceVitalsIds',
  );
  assert.equal((await problems.listProblems(ctx.a.id, p)).conditions.length, 0, 'nothing half-written');
});

// ---- duplicates -----------------------------------------------------------

test('a second current Hypertension is refused, pointing at the one that exists', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const first = await problems.addProblem(ctx.a.id, p, input(HTN), PHARMACIST(ctx.userA));

  // Same code.
  await assert.rejects(
    () => problems.addProblem(ctx.a.id, p, input(HTN), PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'DUPLICATE_ACTIVE' && e.existing.id === first.id,
  );
  // Same name typed freely, no code.
  await assert.rejects(
    () => problems.addProblem(ctx.a.id, p, input({ conditionName: '  hypertension ' }), PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.existing.id === first.id,
  );

  // "Continue anyway" is allowed, and the audit says it was deliberate.
  const second = await problems.addProblem(ctx.a.id, p, input({ ...HTN, allowDuplicate: true }), PHARMACIST(ctx.userA));
  assert.notEqual(second.id, first.id);
  const recorded = await events(p, 'CONDITION_RECORDED');
  assert.equal(recorded.at(-1).metadata.duplicateOf, first.id);
});

test('history and consultation diagnoses are never blocked as duplicates', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Malaria', category: 'acute' }), PHARMACIST(ctx.userA));
  // A past episode, recorded already resolved.
  await problems.addProblem(ctx.a.id, p, input({
    conditionName: 'Malaria', category: 'acute', clinicalStatus: 'resolved', abatement: '2026-08-15',
  }), PHARMACIST(ctx.userA));
  // A diagnosis made at one consultation.
  await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Malaria', category: 'encounter_diagnosis' }), PHARMACIST(ctx.userA));
  const r = await problems.listProblems(ctx.a.id, p);
  assert.equal(r.conditions.length + r.history.length, 3);
});

test('once the first is resolved, the same condition can be current again', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const first = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Malaria', category: 'acute' }), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, p, first.id, patch({ clinicalStatus: 'resolved', abatement: '2026-08-15' }), PHARMACIST(ctx.userA));
  const again = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Malaria', category: 'acute' }), PHARMACIST(ctx.userA));
  const r = await problems.listProblems(ctx.a.id, p);
  assert.deepEqual(r.conditions.map((c) => c.id), [again.id]);
  assert.deepEqual(r.history.map((c) => c.id), [first.id], 'the old episode is kept');
});

// ---- nothing is deleted ---------------------------------------------------

test('resolved and in-remission conditions stay in the history with their dates', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mal = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Malaria', category: 'acute', onset: '2026-08' }), PHARMACIST(ctx.userA));
  const res = await problems.updateProblem(ctx.a.id, p, mal.id, patch({ clinicalStatus: 'resolved', abatement: '2026-08-15' }), PHARMACIST(ctx.userA));
  assert.deepEqual(res.abatement, { date: '2026-08-15', precision: 'day' });

  const ast = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Asthma' }), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, p, ast.id, patch({ clinicalStatus: 'remission', abatement: '2024' }), PHARMACIST(ctx.userA));

  const r = await problems.listProblems(ctx.a.id, p);
  assert.equal(r.conditions.length, 0);
  assert.deepEqual(r.history.map((c) => c.clinicalStatus).sort(), ['remission', 'resolved']);

  // Active again: the stale resolution date goes, the record stays.
  const back = await problems.updateProblem(ctx.a.id, p, mal.id, patch({ clinicalStatus: 'recurrence' }), PHARMACIST(ctx.userA));
  assert.equal(back.clinicalStatus, 'recurrence');
  assert.equal(back.abatement.date, null);
  // The database refuses a current condition with a resolution date.
  await assert.rejects(
    () => db`update patient_problems set abatement_date = '2026-09-01', abatement_precision = 'day' where id = ${mal.id}`,
    /patient_problems_abatement_not_current/,
  );
});

test('a refuted or erroneous condition is kept, says why, and is never current', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Asthma', verificationStatus: 'provisional' }), STAFF(ctx.staffA));
  const refuted = await problems.updateProblem(ctx.a.id, p, c.id, patch({
    verificationStatus: 'refuted', statusReason: 'Spirometry normal; the wheeze was a chest infection.',
  }), PHARMACIST(ctx.userA));
  assert.equal(refuted.verificationStatus, 'refuted');
  assert.equal(refuted.clinicalStatus, 'inactive');

  const e = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Epilepsy' }), STAFF(ctx.staffA));
  await problems.updateProblem(ctx.a.id, p, e.id, patch({
    verificationStatus: 'entered_in_error', statusReason: 'Wrong patient.',
  }), PHARMACIST(ctx.userA));

  const r = await problems.listProblems(ctx.a.id, p);
  assert.equal(r.conditions.length, 0);
  assert.equal(r.history.length, 2);
  assert.ok(r.history.every((h) => h.statusReason));

  await assert.rejects(
    () => db`update patient_problems set clinical_status = 'active' where id = ${c.id}`,
    /patient_problems_untrue_not_current/,
  );
  await assert.rejects(
    () => db`update patient_problems set status_reason = null where id = ${c.id}`,
    /patient_problems_untrue_has_reason/,
  );
});

test('uncertain conditions follow confirmed ones in the current list', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Asthma', verificationStatus: 'provisional' }), PHARMACIST(ctx.userA));
  await problems.addProblem(ctx.a.id, p, input({ ...HTN, verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  const r = await problems.listProblems(ctx.a.id, p);
  assert.deepEqual(r.conditions.map((c) => [c.conditionName, c.verificationStatus]),
    [['Hypertension', 'confirmed'], ['Asthma', 'provisional']]);
});

// ---- who may do what ------------------------------------------------------

test('staff may record what they were told; only a pharmacist may confirm, differentiate or refute', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Migraine', verificationStatus: 'provisional' }), STAFF(ctx.staffA));
  await problems.updateProblem(ctx.a.id, p, c.id, patch({ notes: 'Worse with bright light' }), STAFF(ctx.staffA));

  const refused = (e) => e.status === 403 && e.code === 'FORBIDDEN_ROLE';
  for (const v of ['confirmed', 'differential']) {
    await assert.rejects(
      () => problems.addProblem(ctx.a.id, p, input({ conditionName: `X ${v}`, verificationStatus: v }), STAFF(ctx.staffA)),
      refused, v,
    );
  }
  await assert.rejects(
    () => problems.updateProblem(ctx.a.id, p, c.id, patch({ verificationStatus: 'refuted', statusReason: 'x' }), STAFF(ctx.staffA)),
    refused,
  );
  const ok = await problems.updateProblem(ctx.a.id, p, c.id, patch({ verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  assert.equal(ok.verificationStatus, 'confirmed');
});

// ---- the audit trail ------------------------------------------------------

test('every change is traceable: who, what changed from what, and why', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Gout', severity: 'mild' }), STAFF(ctx.staffA));
  await problems.updateProblem(ctx.a.id, p, c.id, patch({ severity: 'moderate' }), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, p, c.id, patch({ clinicalStatus: 'resolved', abatement: '2026-09', statusReason: 'No flare for a year' }), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, p, c.id, patch({ severity: 'moderate' }), PHARMACIST(ctx.userA)); // no change

  const recorded = await events(p, 'CONDITION_RECORDED');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor_type, 'staff');
  assert.equal(recorded[0].visibility, 'internal');
  const updated = await events(p, 'CONDITION_UPDATED');
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].metadata.changes.severity, { from: 'mild', to: 'moderate' });
  const status = await events(p, 'CONDITION_STATUS_CHANGED');
  assert.equal(status.length, 1);
  assert.deepEqual(status[0].metadata.changes.clinicalStatus, { from: 'active', to: 'resolved' });
  assert.equal(status[0].metadata.reason, 'No flare for a year');
});

// ---- the purchase inference, kept apart -----------------------------------

test('a purchase inference is a suggestion, labelled, until a pharmacist records it', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength, supporting_transaction_count)
    values (${ctx.a.id}, ${p}, 'HYPERTENSION', 'Hypertension', 'CONFIRMED_BY_PURCHASE', 'STRONG', 4)
  `;
  let r = await problems.listProblems(ctx.a.id, p);
  // NOT a condition — a suggestion, with its basis stated.
  assert.equal(r.conditions.length, 0);
  assert.equal(r.suggestions.length, 1);
  assert.match(r.suggestions[0].basis, /not a diagnosis/i);
  assert.equal(r.suggestions[0].purchases, 4);
  assert.deepEqual(r.suggestions[0].prefill, {
    conditionName: 'Hypertension', codeSystem: 'icd10', code: 'I10', localCode: 'HYPERTENSION', category: 'chronic',
  });

  // A house code that covers several diagnoses pre-fills none of them:
  // purchases cannot tell type 1 diabetes from type 2.
  const q = await patient(ctx.a.id);
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.a.id}, ${q}, 'DIABETES', 'Diabetes', 'CONFIRMED_BY_PURCHASE', 'STRONG')
  `;
  const [diabetes] = (await problems.listProblems(ctx.a.id, q)).suggestions;
  assert.deepEqual(diabetes.prefill, { conditionName: 'Diabetes', localCode: 'DIABETES', category: 'chronic' });

  // Recorded by hand: now a condition, and no longer suggested.
  await problems.addProblem(ctx.a.id, p, input(r.suggestions[0].prefill), PHARMACIST(ctx.userA));
  r = await problems.listProblems(ctx.a.id, p);
  assert.equal(r.conditions.length, 1);
  assert.equal(r.conditions[0].verificationStatus, 'unconfirmed', 'recording it did not confirm it');
  assert.equal(r.suggestions.length, 0);
});

test('the summary other screens show carries the record and the inference, apart', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.a.id}, ${p}, 'DIABETES', 'Diabetes', 'CONFIRMED_BY_PURCHASE', 'STRONG')
  `;
  await problems.addProblem(ctx.a.id, p, input({ ...HTN, verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  const s = await problems.problemSummary(ctx.a.id, p);
  assert.deepEqual(s.conditions.map((c) => c.conditionName), ['Hypertension']);
  assert.deepEqual(s.purchaseSuggested.map((x) => x.localCode), ['DIABETES']);
});

// ---- the rest of the product ----------------------------------------------

test('triage receives current conditions with their certainty — never the purchase inference', { skip: SKIP && skipReason }, async () => {
  const encounters = require('../services/clinical/clinicalEncounterService');
  const facts = require('../services/clinical/clinicalFactService');
  const p = await patient(ctx.a.id);
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.a.id}, ${p}, 'DIABETES', 'Diabetes', 'CONFIRMED_BY_PURCHASE', 'STRONG')
  `;
  await problems.addProblem(ctx.a.id, p, input({ ...HTN, verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Asthma', verificationStatus: 'provisional' }), PHARMACIST(ctx.userA));
  const gone = await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Epilepsy' }), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, p, gone.id, patch({ verificationStatus: 'refuted', statusReason: 'x' }), PHARMACIST(ctx.userA));

  const enc = await encounters.createEncounter(ctx.a.id, p, { presentingComplaint: 'Condition seed test' });
  await facts.seedFromProfile(ctx.a.id, enc.id, { customerId: p });
  const rows = await db`select concept, value from encounter_facts where encounter_id = ${enc.id} and concept = 'profile_conditions'`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 'Asthma (provisional); Hypertension (confirmed)');
  assert.doesNotMatch(rows[0].value, /Diabetes|Epilepsy/);
});

test('0059 carries an old condition fact across once, and leaves the old row', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const [profile] = await db`insert into patient_profiles (pharmacy_id, customer_id) values (${ctx.a.id}, ${p}) returning id`;
  await db`
    insert into patient_clinical_facts (pharmacy_id, patient_profile_id, fact_type, value, status, source)
    values (${ctx.a.id}, ${profile.id}, 'condition', 'Sickle cell disease', 'confirmed', 'pharmacist_recorded')
  `;
  const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '0059_patient_problems.sql'), 'utf8');
  const start = migration.indexOf('insert into patient_problems');
  const carry = migration.slice(start, migration.indexOf(';', start));
  await db.unsafe(carry);
  await db.unsafe(carry);

  const r = await problems.listProblems(ctx.a.id, p);
  assert.deepEqual(r.conditions.map((c) => [c.conditionName, c.verificationStatus, c.source]),
    [['Sickle cell disease', 'confirmed', 'pharmacist']]);
  const [{ n }] = await db`select count(*)::int as n from patient_clinical_facts where patient_profile_id = ${profile.id}`;
  assert.equal(n, 1);
});

test('the consultation picker lists this patient\'s consultations, and creates nothing', { skip: SKIP && skipReason }, async () => {
  const encounters = require('../services/clinical/clinicalEncounterService');
  const p = await patient(ctx.a.id);
  // A patient with no profile yet: reading must not create one.
  assert.deepEqual(await problems.encounterChoices(ctx.a.id, p), []);
  const [{ n }] = await db`select count(*)::int as n from patient_profiles where customer_id = ${p}`;
  assert.equal(n, 0);
  const enc = await encounters.createEncounter(ctx.a.id, p, { presentingComplaint: 'Headache' });
  const list = await problems.encounterChoices(ctx.a.id, p);
  assert.deepEqual(list.map((e) => [e.id, e.complaint]), [[enc.id, 'Headache']]);
});

test('the Patients list counts a recorded condition — under the chronic switch, the filter and the column', { skip: SKIP && skipReason }, async () => {
  // Owner's decision, 2026-09-22: recording Hypertension must put the patient
  // under "Show only chronic patients" without waiting for purchases. A
  // refuted or resolved record must not.
  const search = require('../services/customers/patientSearch');
  const recorded = await patient(ctx.a.id);
  const refuted = await patient(ctx.a.id);
  const resolved = await patient(ctx.a.id);
  await problems.addProblem(ctx.a.id, recorded, input({ ...HTN, verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  const r1 = await problems.addProblem(ctx.a.id, refuted, input(HTN), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, refuted, r1.id, patch({ verificationStatus: 'refuted', statusReason: 'x' }), PHARMACIST(ctx.userA));
  const r2 = await problems.addProblem(ctx.a.id, resolved, input(HTN), PHARMACIST(ctx.userA));
  await problems.updateProblem(ctx.a.id, resolved, r2.id, patch({ clinicalStatus: 'resolved' }), PHARMACIST(ctx.userA));

  const idsFor = async (filters) => (await search.searchPatients(ctx.a.id, { ...filters, pageSize: 100 }, { today: TODAY }))
    .patients.map((x) => x.id);
  for (const filters of [{ chronic: true }, { condition: 'HYPERTENSION' }]) {
    const ids = await idsFor(filters);
    assert.ok(ids.includes(recorded), `recorded patient missing under ${JSON.stringify(filters)}`);
    assert.ok(!ids.includes(refuted), 'a refuted record counts for nothing');
    assert.ok(!ids.includes(resolved), 'a resolved condition is not current');
  }

  const row = (await search.searchPatients(ctx.a.id, { q: '', pageSize: 100 }, { today: TODAY }))
    .patients.find((x) => x.id === recorded);
  assert.deepEqual(row.conditions, ['Hypertension']);

  const options = await search.searchOptions(ctx.a.id);
  assert.ok(options.condition.some((c) => c.value === 'HYPERTENSION'), 'the Condition filter offers a recorded code');
});

test('the medication review context carries recorded conditions, and the inference apart', { skip: SKIP && skipReason }, async () => {
  const meds = require('../services/clinical/medications');
  const p = await patient(ctx.a.id);
  await db`
    insert into patient_condition (pharmacy_id, customer_id, condition_code, condition_name, status, evidence_strength)
    values (${ctx.a.id}, ${p}, 'DYSLIPIDEMIA', 'Dyslipidaemia', 'CONFIRMED_BY_PURCHASE', 'STRONG')
  `;
  await problems.addProblem(ctx.a.id, p, input({ ...HTN, verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  await problems.addProblem(ctx.a.id, p, input({ conditionName: 'Asthma', verificationStatus: 'provisional' }), PHARMACIST(ctx.userA));

  const context = await meds.medicationContext(ctx.a.id, p);
  assert.deepEqual(context.problems.conditions.map((c) => [c.conditionName, c.verificationStatus]),
    [['Hypertension', 'confirmed'], ['Asthma', 'provisional']]);
  assert.deepEqual(context.problems.purchaseSuggested.map((s) => s.localCode), ['DYSLIPIDEMIA']);
  // The raw inference is still there for the readers that used it, unmixed.
  assert.deepEqual(context.conditions.map((c) => c.code), ['DYSLIPIDEMIA']);
});
