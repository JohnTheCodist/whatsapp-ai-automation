/**
 * The pharmacist's consultation note against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a consultation belongs to a pharmacy AND to a
 * patient (GOLDEN-001). A clinical note is somebody's account of a medical
 * interaction; naming its id must not be enough to read it.
 *
 * Then what this module exists to get right:
 *   - It is the ASSESSMENT beside the episode, not a second episode. The
 *     encounter (0029) is written by the WhatsApp engine; this is written by a
 *     person, and may exist with no encounter at all (a counter consultation).
 *   - It creates NO clinical record as a side effect — no Condition, no
 *     Allergy, no Vitals reading (§36).
 *   - What must be filled to finalise is decided by the TYPE (§23).
 *   - Only a pharmacist or the owner may finalise (§33).
 *   - A finalised note is not silently edited, and not deleted (§32, §39).
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the consultation note was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'consulttest';

let db;
let consultations;
let ctx = null;

const {
  readConsultationInput, readConsultationPatch, readErrorInput, readAmendmentInput,
} = require('../services/clinical/consultationInput');

const PHARMACIST = (userId) => ({ actorId: userId, actorRole: 'pharmacist' });
const STAFF = (userId) => ({ actorId: userId, actorRole: 'staff' });

let phone = 2349050000000;
async function patient(pharmacyId, name = 'Consultation Tester') {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, ${name}, ${name})
    returning id
  `;
  return c.id;
}

/** An episode, written the way the WhatsApp engine writes one. */
async function encounter(pharmacyId, customerId, over = {}) {
  const [profile] = await db`
    insert into patient_profiles (pharmacy_id, customer_id)
    values (${pharmacyId}, ${customerId})
    on conflict (pharmacy_id, customer_id) do update set updated_at = now()
    returning id
  `;
  const [e] = await db`
    insert into clinical_encounters (
      pharmacy_id, patient_profile_id, presenting_complaint, reported_symptoms,
      symptom_duration, severity, red_flags_detected, status
    ) values (
      ${pharmacyId}, ${profile.id},
      ${over.complaint || 'Headache and dizziness'},
      ${over.symptoms || 'Dizzy on standing'},
      ${over.duration || '3 days'}, ${over.severity || 'moderate'},
      ${db.json(over.redFlags || [])}, ${over.status || 'completed'}
    )
    returning id
  `;
  return e.id;
}

const start = (b) => readConsultationInput(b, [
  { slug: 'minor_ailment' }, { slug: 'bp_review' }, { slug: 'medication_review' },
]);

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  consultations = require('../services/clinical/consultations');

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

test('pharmacy B cannot read, edit or finalise a consultation of ours', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment', reasonCode: 'cough' }), PHARMACIST(ctx.userA));

  const asB = await consultations.listConsultations(ctx.b.id, p, {});
  assert.deepEqual(asB.consultations, []);
  assert.equal(asB.counts.all, 0);

  assert.equal(await consultations.getConsultation(ctx.b.id, p, mine.id), null);
  await assert.rejects(
    () => consultations.updateConsultation(ctx.b.id, p, mine.id, readConsultationPatch({ notes: 'mine now' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => consultations.completeConsultation(ctx.b.id, p, mine.id, PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
});

test('another patient in the SAME pharmacy is refused too', { skip: SKIP && skipReason }, async () => {
  // A clinical note is somebody's account of a medical interaction. An id
  // pasted into the wrong patient's URL must not open it.
  const p1 = await patient(ctx.a.id, 'Patient One');
  const p2 = await patient(ctx.a.id, 'Patient Two');
  const mine = await consultations.startConsultation(ctx.a.id, p1,
    start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));

  assert.equal(await consultations.getConsultation(ctx.a.id, p2, mine.id), null);
  const asP2 = await consultations.listConsultations(ctx.a.id, p2, {});
  assert.deepEqual(asP2.consultations, []);
});

// ---- the encounter is optional (plan §11.1) -------------------------------

test('a counter consultation needs no episode, and says so rather than faking one', { skip: SKIP && skipReason }, async () => {
  // Most community-pharmacy consultations happen across a counter with no
  // WhatsApp thread. A triage panel claiming "no red flags" on one of those
  // would be a safety claim nobody made.
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment', reasonCode: 'cough' }), PHARMACIST(ctx.userA));

  assert.equal(c.encounterId, null);
  assert.equal(c.triage, null, 'no episode means no triage summary, not an empty one');
});

test('a consultation from an episode READS the triage rather than re-asking it', { skip: SKIP && skipReason }, async () => {
  // §6: Consultation receives the triage information. Nothing is re-entered
  // and nothing is summarised by a model.
  const p = await patient(ctx.a.id);
  const e = await encounter(ctx.a.id, p, {
    complaint: 'Headache and dizziness', duration: '3 days', severity: 'moderate',
    redFlags: ['sudden_onset'],
  });

  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment', encounterId: e }), PHARMACIST(ctx.userA));

  assert.equal(c.encounterId, e);
  assert.equal(c.triage.chiefConcern, 'Headache and dizziness');
  assert.equal(c.triage.duration, '3 days');
  assert.equal(c.triage.severity, 'moderate');
  assert.deepEqual(c.triage.redFlags, ['sudden_onset']);

  // And the consultation did NOT copy any of it into its own columns — the
  // triage lives in the encounter, and is read from there on every load.
  const [row] = await db`select * from pharmacist_consultations where id = ${c.id}`;
  assert.equal(row.reason_code, null);
  assert.equal(row.subjective, null);
});

test('another patient\'s episode cannot be attached to this note', { skip: SKIP && skipReason }, async () => {
  const p1 = await patient(ctx.a.id);
  const p2 = await patient(ctx.a.id);
  const theirs = await encounter(ctx.a.id, p2);

  await assert.rejects(
    () => consultations.startConsultation(ctx.a.id, p1,
      start({ consultationType: 'minor_ailment', encounterId: theirs }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 400); assert.equal(e.code, 'INVALID_REFERENCE'); return true; },
  );
});

// ---- the note's life ------------------------------------------------------

test('a draft is saved as it is written, and becomes in progress', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), STAFF(ctx.staffA));
  assert.equal(c.status, 'draft', 'anyone may open one and write a draft');

  const saved = await consultations.updateConsultation(ctx.a.id, p, c.id,
    readConsultationPatch({ reasonCode: 'cough', subjective: 'Dry cough, four days' }), STAFF(ctx.staffA));
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.reasonCode, 'cough');
  assert.equal(saved.subjective, 'Dry cough, four days');

  // A field not mentioned in the patch is untouched — this is a workspace
  // saved as it fills, not a form that replaces itself.
  const again = await consultations.updateConsultation(ctx.a.id, p, c.id,
    readConsultationPatch({ objective: 'Temp 36.8' }), STAFF(ctx.staffA));
  assert.equal(again.subjective, 'Dry cough, four days');
  assert.equal(again.objective, 'Temp 36.8');
});

test('what must be filled to finalise is decided by the TYPE, at the database', { skip: SKIP && skipReason }, async () => {
  // §23's conditional requirements, proven end to end rather than only in the
  // contract: the same note finalises as a minor ailment and does not as a
  // blood-pressure review.
  const p = await patient(ctx.a.id);
  const bp = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'bp_review' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, p, bp.id, readConsultationPatch({
    reasonCode: 'bp_review', assessmentText: 'BP monitoring required', planText: 'Repeat in 2 weeks',
  }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => consultations.completeConsultation(ctx.a.id, p, bp.id, PHARMACIST(ctx.userA)),
    (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.code, 'INCOMPLETE');
      assert.ok(e.outstanding.some((o) => /measured or observed/i.test(o)));
      return true;
    },
  );

  // It is still a draft — a refused finalisation changes nothing.
  const still = await consultations.getConsultation(ctx.a.id, p, bp.id);
  assert.notEqual(still.status, 'completed');
  assert.equal(still.completedAt, null);

  await consultations.updateConsultation(ctx.a.id, p, bp.id,
    readConsultationPatch({ objective: 'BP 138/86 mmHg' }), PHARMACIST(ctx.userA));
  const done = await consultations.completeConsultation(ctx.a.id, p, bp.id, PHARMACIST(ctx.userA));
  assert.equal(done.status, 'completed');
  assert.ok(done.completedAt);
  assert.equal(done.finalisedBy, ctx.userA);
});

test('a staff member may write the note but not finalise it', { skip: SKIP && skipReason }, async () => {
  // Doing the work is not closing the file — the rule every clinical module
  // here uses (§33).
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), STAFF(ctx.staffA));
  await consultations.updateConsultation(ctx.a.id, p, c.id, readConsultationPatch({
    reasonCode: 'cough', assessmentText: 'Uncomplicated acute cough', planText: 'Hydration',
  }), STAFF(ctx.staffA));

  await assert.rejects(
    () => consultations.completeConsultation(ctx.a.id, p, c.id, STAFF(ctx.staffA)),
    (e) => { assert.equal(e.status, 403); assert.equal(e.code, 'ROLE_REQUIRED'); return true; },
  );

  // The pharmacist can, and the note records who finished it.
  const done = await consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA));
  assert.equal(done.finalisedBy, ctx.userA);
  assert.equal(done.createdBy, ctx.staffA, 'and who wrote it');
});

test('a finalised note cannot be silently edited, and is never deleted', { skip: SKIP && skipReason }, async () => {
  // §32 asks for a correction mechanism rather than overwriting; §39 says a
  // finished note is not deleted. Amendment is phase 3, so until then
  // "finished" means finished.
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, p, c.id, readConsultationPatch({
    reasonCode: 'cough', assessmentText: 'Uncomplicated acute cough', planText: 'Hydration',
  }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA));

  await assert.rejects(
    () => consultations.updateConsultation(ctx.a.id, p, c.id,
      readConsultationPatch({ assessmentText: 'Something else entirely' }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 409); assert.equal(e.code, 'FINALISED'); return true; },
  );

  // Finalising twice is refused rather than re-stamping the time.
  await assert.rejects(
    () => consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA)),
    (e) => e.code === 'ALREADY_FINALISED',
  );

  const [row] = await db`select assessment_text from pharmacist_consultations where id = ${c.id}`;
  assert.equal(row.assessment_text, 'Uncomplicated acute cough', 'the note is as it was finalised');
});

test('a note marked entered in error is RETIRED, with its reason, and still there', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment', reasonCode: 'cough' }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => consultations.markEnteredInError(ctx.a.id, p, c.id, readErrorInput({ reason: 'Wrong patient' }), STAFF(ctx.staffA)),
    (e) => e.code === 'ROLE_REQUIRED',
  );

  const retired = await consultations.markEnteredInError(ctx.a.id, p, c.id,
    readErrorInput({ reason: 'Recorded against the wrong patient' }), PHARMACIST(ctx.userA));
  assert.equal(retired.status, 'entered_in_error');
  assert.equal(retired.errorReason, 'Recorded against the wrong patient');

  // The row is still there — a finished clinical record is not removed
  // because somebody would rather it had not happened.
  const [row] = await db`select id, reason_code from pharmacist_consultations where id = ${c.id}`;
  assert.ok(row);
  assert.equal(row.reason_code, 'cough');

  // And it cannot then be finalised.
  await assert.rejects(
    () => consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA)),
    (e) => e.code === 'IN_ERROR',
  );
});

// ---- the boundary this module must not cross (§36) ------------------------

test('documenting a consultation creates NO clinical record of its own', { skip: SKIP && skipReason }, async () => {
  // §36: no Condition from assessment text, no Allergy from an adverse-effect
  // note, no Vitals reading, no medication change. The note is a narrative
  // about records that live elsewhere.
  const p = await patient(ctx.a.id);
  const before = await db`
    select (select count(*)::int from patient_problems where customer_id = ${p}) as problems,
           (select count(*)::int from patient_allergies where customer_id = ${p}) as allergies,
           (select count(*)::int from patient_vitals where customer_id = ${p}) as vitals,
           (select count(*)::int from medication_journeys where customer_id = ${p}) as meds,
           (select count(*)::int from patient_tasks where customer_id = ${p}) as tasks
  `;

  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, p, c.id, readConsultationPatch({
    reasonCode: 'medication_side_effect',
    subjective: 'Rash after amoxicillin. Reports penicillin allergy.',
    assessmentText: 'Possible hypertension. Possible penicillin allergy. BP 150/95.',
    planText: 'Refer',
  }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA));

  const after = await db`
    select (select count(*)::int from patient_problems where customer_id = ${p}) as problems,
           (select count(*)::int from patient_allergies where customer_id = ${p}) as allergies,
           (select count(*)::int from patient_vitals where customer_id = ${p}) as vitals,
           (select count(*)::int from medication_journeys where customer_id = ${p}) as meds,
           (select count(*)::int from patient_tasks where customer_id = ${p}) as tasks
  `;
  assert.deepEqual(after[0], before[0],
    'a consultation created a clinical record as a side effect of being written');
});

test('the note table has nowhere to store a measurement', { skip: SKIP && skipReason }, async () => {
  // The structural half of §38: a blood pressure belongs in Vitals, a result
  // in Tests. The note holds narrative and pointers, so there is nowhere to
  // put a number that another screen would then disagree with.
  const cols = (await db`
    select column_name from information_schema.columns
    where table_name = 'pharmacist_consultations'
  `).map((c) => c.column_name);
  assert.ok(cols.length > 0, 'the table was not found — this would pass on nothing');

  for (const measurement of [
    'systolic', 'diastolic', 'pulse', 'temperature', 'weight', 'height', 'bmi',
    'glucose', 'spo2', 'respiratory_rate', 'result_value', 'diagnosis_code',
  ]) {
    assert.ok(!cols.includes(measurement),
      `pharmacist_consultations grew a ${measurement} column — that belongs in Vitals or Tests`);
  }
});

// ---- history and the summary ---------------------------------------------

test('the history is this patient\'s, newest first, and filterable by type', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const older = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await db`update pharmacist_consultations set started_at = '2026-09-01' where id = ${older.id}`;
  const newer = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'medication_review' }), PHARMACIST(ctx.userA));

  const all = await consultations.listConsultations(ctx.a.id, p, {});
  assert.deepEqual(all.consultations.map((c) => c.id), [newer.id, older.id]);
  assert.equal(all.counts.all, 2);
  assert.equal(all.counts.open, 2);
  assert.equal(all.counts.completed, 0);

  const filtered = await consultations.listConsultations(ctx.a.id, p, { type: 'medication_review' });
  assert.deepEqual(filtered.consultations.map((c) => c.id), [newer.id]);
  // The counts still describe the patient, not the filtered list.
  assert.equal(filtered.counts.all, 2);

  // The type's label travels with the row, so a history does not render slugs.
  assert.equal(newer.typeLabel, 'Medication review');
});

test('the summary other screens show agrees with the section itself', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment', reasonCode: 'cough' }), PHARMACIST(ctx.userA));

  const summary = await consultations.consultationsSummary(ctx.a.id, p);
  const section = await consultations.listConsultations(ctx.a.id, p, {});
  assert.deepEqual(summary.counts, section.counts);
  assert.equal(summary.recent[0].reasonCode, 'cough');
  assert.equal(String(summary.lastConsultationAt), String(section.lastConsultationAt));

  // A patient never consulted has no last consultation — not today's date.
  const fresh = await patient(ctx.a.id);
  const empty = await consultations.consultationsSummary(ctx.a.id, fresh);
  assert.equal(empty.lastConsultationAt, null);
  assert.deepEqual(empty.recent, []);
  assert.equal(empty.counts.all, 0);
});

test('the note carries its own generated summary, built only from what was entered', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, p, c.id, readConsultationPatch({
    reasonCode: 'cough', reasonText: 'Cough for 4 days',
    assessmentText: 'Uncomplicated acute cough', planText: 'Hydration and monitoring',
  }), PHARMACIST(ctx.userA));

  const read = await consultations.getConsultation(ctx.a.id, p, c.id);
  assert.deepEqual(read.summary.map((s) => s.id), ['reason', 'assessment', 'plan']);
  // Nothing about the objective, because nothing was entered there.
  assert.ok(!read.summary.some((s) => s.id === 'objective'));
  // The summary is not a column.
  // postgres.js returns a Result (an Array subclass), which is not
  // deep-equal to a plain []. Map it first, and the assertion then says
  // what it means rather than failing on a type nobody was testing.
  const summaryCols = (await db`
    select column_name from information_schema.columns
    where table_name = 'pharmacist_consultations' and column_name like '%summary%'
  `).map((c) => c.column_name);
  assert.deepEqual(summaryCols, [], 'the summary was stored, and will go stale on the next edit');
});

test('starting, finalising and retiring are on the patient\'s history', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, p,
    start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, p, c.id, readConsultationPatch({
    reasonCode: 'cough', assessmentText: 'Uncomplicated', planText: 'Hydration',
  }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA));
  await consultations.markEnteredInError(ctx.a.id, p, c.id,
    readErrorInput({ reason: 'Wrong patient' }), PHARMACIST(ctx.userA));

  const events = await db`
    select event_type, metadata, visibility, entity_type
    from customer_events
    where customer_id = ${p} and event_type like 'CONSULTATION%'
    order by occurred_at, id
  `;
  assert.deepEqual(events.map((e) => e.event_type),
    ['CONSULTATION_STARTED', 'CONSULTATION_COMPLETED', 'CONSULTATION_ENTERED_IN_ERROR']);
  // The entity type is the NOTE's, not the encounter's — clinicalRefs uses
  // the word "consultation" for clinical_encounters, and one name meaning two
  // tables is how a pointer finds the wrong row.
  for (const e of events) {
    assert.equal(e.entity_type, 'pharmacist_consultation');
    assert.equal(e.visibility, 'internal');
  }
  assert.equal(events[2].metadata.reason, 'Wrong patient');
});

// ---- phase 2: problems, interventions, referral (0069) --------------------

const { readProblemInput, readInterventionInput, readReferralInput, readPrescriptionInput } =
  require('../services/clinical/consultationInput');

/** A reading of this patient's, for a problem to point at. */
async function reading(pharmacyId, customerId, systolic = 148) {
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic, diastolic)
    values (${pharmacyId}, ${customerId}, now(), ${systolic}, 92) returning id`;
  return v.id;
}

async function draft(pharmacyId, customerId, type = 'minor_ailment') {
  return consultations.startConsultation(pharmacyId, customerId,
    start({ consultationType: type }), PHARMACIST(ctx.userA));
}

test('a problem points at a record and is DESCRIBED from the section that owns it', { skip: SKIP && skipReason }, async () => {
  // §3: reference those records rather than duplicating them. The proof is
  // that the link row holds no clinical value at all — the label comes from
  // Vitals, on every read.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  const v = await reading(ctx.a.id, p);

  const withProblem = await consultations.addProblem(ctx.a.id, p, c.id, readProblemInput({
    label: 'Uncontrolled blood pressure', certainty: 'provisional', status: 'monitoring',
    refKind: 'vitals', refId: v,
  }), PHARMACIST(ctx.userA));

  assert.equal(withProblem.problems.length, 1);
  const problem = withProblem.problems[0];
  assert.equal(problem.label, 'Uncontrolled blood pressure');
  assert.equal(problem.certainty, 'provisional');
  assert.equal(problem.refKind, 'vitals');
  assert.ok(problem.record, 'the reading is described, not copied');

  // Writing a problem moved the note from draft to in progress.
  assert.equal(withProblem.status, 'in_progress');
});

test('the problem table has nowhere to store what the record says', { skip: SKIP && skipReason }, async () => {
  // The structural half of §3 and §38, stated as a column list rather than by
  // hunting for a number in a row — a uuid contains digit runs by chance, and
  // that version of this assertion both fails spuriously and proves nothing
  // (the lesson from Messages phase 2).
  for (const [table, expected] of [
    ['consultation_problems', [
      'certainty', 'consultation_id', 'created_at', 'customer_id', 'id', 'label',
      'note', 'pharmacy_id', 'position', 'ref_id', 'ref_kind', 'status',
    ]],
    ['consultation_interventions', [
      'consultation_id', 'created_at', 'customer_id', 'id', 'kind', 'note',
      'pharmacy_id', 'position', 'problem_id',
    ]],
  ]) {
    const cols = (await db`
      select column_name from information_schema.columns where table_name = ${table}
    `).map((c) => c.column_name).sort();
    assert.ok(cols.length > 0, `${table} was not found — this would pass on nothing`);
    assert.deepEqual(cols, expected, `${table} grew a column that could hold a clinical value`);
  }
});

test('only THIS patient\'s records can be pointed at', { skip: SKIP && skipReason }, async () => {
  // Attaching another patient's reading would put one person's blood pressure
  // on another person's consultation.
  const p1 = await patient(ctx.a.id);
  const p2 = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p1);
  const theirs = await reading(ctx.a.id, p2, 120);

  await assert.rejects(
    () => consultations.addProblem(ctx.a.id, p1, c.id, readProblemInput({
      label: 'Theirs', refKind: 'vitals', refId: theirs,
    }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 400); assert.equal(e.code, 'INVALID_REFERENCE'); return true; },
  );

  const after = await consultations.getConsultation(ctx.a.id, p1, c.id);
  assert.deepEqual(after.problems, []);
});

test('pharmacy B cannot add a problem or an intervention to our consultation', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);

  await assert.rejects(
    () => consultations.addProblem(ctx.b.id, p, c.id, readProblemInput({ label: 'Theirs' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => consultations.addIntervention(ctx.b.id, p, c.id, readInterventionInput({ kind: 'patient_counselling' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => consultations.setReferral(ctx.b.id, p, c.id, readReferralInput({ destination: 'none' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
});

test('problems keep the number the pharmacist gave them', { skip: SKIP && skipReason }, async () => {
  // 0057's lesson: rows written in one transaction share now(), so ordering by
  // created_at leaves a random uuid as the tiebreak and the list reads back
  // differently on different loads. §12 NUMBERS these.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  for (const label of ['Poor adherence', 'Elevated BP', 'Dizziness']) {
    await consultations.addProblem(ctx.a.id, p, c.id, readProblemInput({ label }), PHARMACIST(ctx.userA));
  }

  for (let i = 0; i < 3; i += 1) {
    const read = await consultations.getConsultation(ctx.a.id, p, c.id);
    assert.deepEqual(read.problems.map((x) => x.label),
      ['Poor adherence', 'Elevated BP', 'Dizziness'], 'the order must not change between loads');
    assert.deepEqual(read.problems.map((x) => x.position), [1, 2, 3]);
  }
});

test('an intervention can be about a problem, and only about one of THIS note\'s', { skip: SKIP && skipReason }, async () => {
  // The question arrays on one row could not answer.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  const other = await draft(ctx.a.id, p, 'medication_review');

  const withProblem = await consultations.addProblem(ctx.a.id, p, c.id,
    readProblemInput({ label: 'Poor adherence to metformin' }), PHARMACIST(ctx.userA));
  const problemId = withProblem.problems[0].id;

  const done = await consultations.addIntervention(ctx.a.id, p, c.id, readInterventionInput({
    kind: 'adherence_counselling', problemId, note: 'Discussed taking it with the evening meal.',
  }), PHARMACIST(ctx.userA));
  assert.equal(done.interventions[0].problemId, problemId);

  // A problem belonging to a DIFFERENT consultation is refused.
  await assert.rejects(
    () => consultations.addIntervention(ctx.a.id, p, other.id, readInterventionInput({
      kind: 'adherence_counselling', problemId,
    }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 400); assert.equal(e.field, 'problemId'); return true; },
  );

  // And an intervention about nothing in particular is allowed.
  const general = await consultations.addIntervention(ctx.a.id, p, c.id,
    readInterventionInput({ kind: 'self_care_advice' }), PHARMACIST(ctx.userA));
  assert.equal(general.interventions[1].problemId, null);
});

test('a problem removed from a draft goes; one on a finalised note cannot', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  const added = await consultations.addProblem(ctx.a.id, p, c.id,
    readProblemInput({ label: 'Mistyped' }), PHARMACIST(ctx.userA));
  const problemId = added.problems[0].id;

  const gone = await consultations.removeProblem(ctx.a.id, p, c.id, problemId, PHARMACIST(ctx.userA));
  assert.deepEqual(gone.problems, []);

  // Rebuild and finalise, then nothing may be added or removed.
  await consultations.addProblem(ctx.a.id, p, c.id,
    readProblemInput({ label: 'Uncomplicated acute cough' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, p, c.id,
    readConsultationPatch({ reasonCode: 'cough', planText: 'Hydration' }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA));

  for (const attempt of [
    () => consultations.addProblem(ctx.a.id, p, c.id, readProblemInput({ label: 'After the fact' }), PHARMACIST(ctx.userA)),
    () => consultations.addIntervention(ctx.a.id, p, c.id, readInterventionInput({ kind: 'referral' }), PHARMACIST(ctx.userA)),
    () => consultations.setReferral(ctx.a.id, p, c.id, readReferralInput({ destination: 'none' }), PHARMACIST(ctx.userA)),
  ]) {
    await assert.rejects(attempt, (e) => { assert.equal(e.code, 'FINALISED'); return true; });
  }
});

// Found by driving the endpoints on 2026-09-28: deleting a problem left the
// intervention behind with a null pointer, which is 0069's `on delete set
// null` doing what it should — and nothing was asserting it.
test('removing a problem keeps the intervention that was about it', { skip: SKIP && skipReason }, async () => {
  // An intervention is a professional act that HAPPENED. A pharmacist who
  // rang the prescriber about a problem, then tidied that problem off the
  // list, must not thereby erase the record of the call — which is what a
  // cascading delete would do, silently, in a note nobody re-reads until it
  // matters. The intervention stays and stops naming a problem.
  const pt = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, pt);
  const added = await consultations.addProblem(ctx.a.id, pt, c.id,
    readProblemInput({ label: 'Poorly controlled blood pressure' }), PHARMACIST(ctx.userA));
  const problemId = added.problems[0].id;

  const withAction = await consultations.addIntervention(ctx.a.id, pt, c.id,
    readInterventionInput({ kind: 'prescriber_contacted', problemId, note: 'Dose review agreed' }),
    PHARMACIST(ctx.userA));
  assert.equal(withAction.interventions[0].problemId, problemId);

  const gone = await consultations.removeProblem(ctx.a.id, pt, c.id, problemId, PHARMACIST(ctx.userA));
  assert.deepEqual(gone.problems, []);
  assert.equal(gone.interventions.length, 1, 'the call was made; it is still on the note');
  assert.equal(gone.interventions[0].kind, 'prescriber_contacted');
  assert.equal(gone.interventions[0].note, 'Dose review agreed');
  // It no longer claims to be about a problem the note does not hold.
  assert.equal(gone.interventions[0].problemId, null);

  // And it still reads as an intervention in the summary.
  const summary = gone.summary.find((x) => x.id === 'interventions');
  assert.ok(summary, 'the intervention is still summarised');
  assert.match(summary.lines.join(' '), /Prescriber contacted/);
});
test('a structured problem list IS an assessment, and finalises without free text', { skip: SKIP && skipReason }, async () => {
  // Phase 1 wrote `sectionFilled` to accept either. This proves it end to end.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  await consultations.updateConsultation(ctx.a.id, p, c.id,
    readConsultationPatch({ reasonCode: 'cough', planText: 'Hydration' }), PHARMACIST(ctx.userA));

  const before = await consultations.getConsultation(ctx.a.id, p, c.id);
  assert.ok(before.outstanding.some((o) => /assessment/i.test(o)), 'no assessment yet');

  await consultations.addProblem(ctx.a.id, p, c.id,
    readProblemInput({ label: 'Uncomplicated acute cough' }), PHARMACIST(ctx.userA));

  const after = await consultations.getConsultation(ctx.a.id, p, c.id);
  assert.deepEqual(after.outstanding, [], 'the problem list satisfies the assessment');
  const done = await consultations.completeConsultation(ctx.a.id, p, c.id, PHARMACIST(ctx.userA));
  assert.equal(done.status, 'completed');
});

// THE ONE THAT MATTERS MOST IN THIS BLOCK.
test('a referral never considered is not recorded as "not required"', { skip: SKIP && skipReason }, async () => {
  // §17. "Referral: not required" on a note where nobody considered it is a
  // clinical decision the software invented.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);

  const untouched = await consultations.getConsultation(ctx.a.id, p, c.id);
  assert.equal(untouched.referralDestination, null);
  assert.ok(!untouched.summary.some((s) => s.id === 'referral'));

  const decided = await consultations.setReferral(ctx.a.id, p, c.id,
    readReferralInput({ destination: 'none' }), PHARMACIST(ctx.userA));
  assert.equal(decided.referralDestination, 'none');
  assert.deepEqual(decided.summary.find((s) => s.id === 'referral').lines, ['No referral required']);

  const referred = await consultations.setReferral(ctx.a.id, p, c.id, readReferralInput({
    destination: 'physician', reason: 'Persistent elevated BP despite treatment', urgency: 'routine',
  }), PHARMACIST(ctx.userA));
  assert.equal(referred.referralUrgency, 'routine');
  assert.match(referred.summary.find((s) => s.id === 'referral').lines.join(' '), /Persistent elevated BP/);
});

test('the database itself refuses a referral that names somewhere and no reason', { skip: SKIP && skipReason }, async () => {
  // The CHECK, not only the contract. A pharmacist reading "Refer to hospital"
  // with no reason cannot act on it, and neither can the hospital.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  await assert.rejects(
    () => db`update pharmacist_consultations set referral_destination = 'hospital' where id = ${c.id}`,
    (e) => e.code === '23514',
  );
});

test('a consultation may point at a care programme without enrolling anybody', { skip: SKIP && skipReason }, async () => {
  // §21: the programme keeps its own plan. Nothing here duplicates it.
  const programs = require('../services/clinical/carePrograms');
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p, 'medication_review');

  const [prog] = await db`
    insert into patient_care_programs (pharmacy_id, customer_id, program_name, status, start_date)
    values (${ctx.a.id}, ${p}, 'Hypertension management', 'active', current_date)
    returning id`;

  const goalsBefore = (await db`select count(*)::int as n from care_program_goals where program_id = ${prog.id}`)[0].n;

  const linked = await consultations.setCareProgram(ctx.a.id, p, c.id, prog.id, PHARMACIST(ctx.userA));
  assert.equal(linked.careProgramId, prog.id);

  // The programme is untouched — no goals, no activities, no status change.
  const goalsAfter = (await db`select count(*)::int as n from care_program_goals where program_id = ${prog.id}`)[0].n;
  assert.equal(goalsAfter, goalsBefore);
  const [still] = await db`select status from patient_care_programs where id = ${prog.id}`;
  assert.equal(still.status, 'active');

  // Another patient's programme is refused.
  const other = await patient(ctx.a.id);
  const [theirs] = await db`
    insert into patient_care_programs (pharmacy_id, customer_id, program_name, status, start_date)
    values (${ctx.a.id}, ${other}, 'Diabetes care', 'active', current_date) returning id`;
  await assert.rejects(
    () => consultations.setCareProgram(ctx.a.id, p, c.id, theirs.id, PHARMACIST(ctx.userA)),
    (e) => e.code === 'INVALID_REFERENCE',
  );
  assert.ok(programs, 'the care programme module is the one that owns programmes');
});

test('§16 records the clarification, and implies no prescription was changed', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p, 'medication_review');
  const saved = await consultations.setPrescriptionReview(ctx.a.id, p, c.id, readPrescriptionInput({
    issues: ['dose', 'interaction'], prescriberContacted: true, prescriberOutcome: 'Dose confirmed at 5 mg',
  }), PHARMACIST(ctx.userA));

  assert.deepEqual(saved.prescriptionIssues, ['dose', 'interaction']);
  assert.ok(saved.prescriberContactedAt);
  assert.equal(saved.prescriberOutcome, 'Dose confirmed at 5 mg');

  // Nothing about the patient's medicines changed — RxMax has no prescribing
  // workflow, and recording a clarification must not imply one.
  const meds = (await db`select count(*)::int as n from medication_journeys where customer_id = ${p}`)[0].n;
  assert.equal(meds, 0);
});

test('phase 2 still creates no clinical record as a side effect', { skip: SKIP && skipReason }, async () => {
  // §36, re-proven now that there are four more ways to write to a note.
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  const v = await reading(ctx.a.id, p, 150);

  const before = await db`
    select (select count(*)::int from patient_problems where customer_id = ${p}) as conditions,
           (select count(*)::int from patient_allergies where customer_id = ${p}) as allergies,
           (select count(*)::int from patient_vitals where customer_id = ${p}) as vitals,
           (select count(*)::int from patient_tasks where customer_id = ${p}) as tasks,
           (select count(*)::int from medication_journeys where customer_id = ${p}) as meds`;

  await consultations.addProblem(ctx.a.id, p, c.id, readProblemInput({
    label: 'Possible hypertension', certainty: 'possible', refKind: 'vitals', refId: v,
  }), PHARMACIST(ctx.userA));
  await consultations.addIntervention(ctx.a.id, p, c.id,
    readInterventionInput({ kind: 'referral', note: 'Sent to physician' }), PHARMACIST(ctx.userA));
  await consultations.setReferral(ctx.a.id, p, c.id,
    readReferralInput({ destination: 'physician', reason: 'Persistent elevated BP' }), PHARMACIST(ctx.userA));

  const after = await db`
    select (select count(*)::int from patient_problems where customer_id = ${p}) as conditions,
           (select count(*)::int from patient_allergies where customer_id = ${p}) as allergies,
           (select count(*)::int from patient_vitals where customer_id = ${p}) as vitals,
           (select count(*)::int from patient_tasks where customer_id = ${p}) as tasks,
           (select count(*)::int from medication_journeys where customer_id = ${p}) as meds`;

  assert.deepEqual(after[0], before[0],
    'documenting a consultation created a clinical record somewhere else');
});

test('the problem, the intervention and the referral are on the audit trail', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const c = await draft(ctx.a.id, p);
  await consultations.addProblem(ctx.a.id, p, c.id,
    readProblemInput({ label: 'SECRETLABEL', certainty: 'suspected' }), PHARMACIST(ctx.userA));
  await consultations.addIntervention(ctx.a.id, p, c.id,
    readInterventionInput({ kind: 'adherence_counselling' }), PHARMACIST(ctx.userA));
  await consultations.setReferral(ctx.a.id, p, c.id,
    readReferralInput({ destination: 'physician', reason: 'x' }), PHARMACIST(ctx.userA));

  const events = await db`
    select event_type, metadata, visibility, entity_type from customer_events
    where customer_id = ${p} and event_type like 'CONSULTATION_%'
    order by occurred_at, id`;
  const types = events.map((e) => e.event_type);
  assert.ok(types.includes('CONSULTATION_PROBLEM_ADDED'));
  assert.ok(types.includes('CONSULTATION_INTERVENTION_RECORDED'));
  assert.ok(types.includes('CONSULTATION_REFERRAL_RECORDED'));
  for (const e of events) {
    assert.equal(e.entity_type, 'pharmacist_consultation');
    assert.equal(e.visibility, 'internal');
  }
  // The audit carries the pharmacist's judgement, not the record's contents —
  // and not the label either, which belongs in the note.
  const problemEvent = events.find((e) => e.event_type === 'CONSULTATION_PROBLEM_ADDED');
  assert.equal(problemEvent.metadata.certainty, 'suspected');
  assert.ok(!JSON.stringify(problemEvent.metadata).includes('SECRETLABEL'));
});

/* ==========================================================================
 * Phase 3 — amendment, entered-in-error, and the audit view (§32, §39)
 * ======================================================================== */

/** A minor ailment, filled in and finalised. */
async function finalised(pharmacyId, userId) {
  const pt = await patient(pharmacyId);
  const c = await consultations.startConsultation(pharmacyId, pt, start({ consultationType: 'minor_ailment' }), PHARMACIST(userId));
  await consultations.updateConsultation(pharmacyId, pt, c.id, readConsultationPatch({
    reasonCode: 'cough', assessmentText: 'Uncomplicated acute cough', planText: 'Hydration and rest',
  }), PHARMACIST(userId));
  const done = await consultations.completeConsultation(pharmacyId, pt, c.id, PHARMACIST(userId));
  return { pt, id: c.id, done };
}

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('an amendment keeps what the note SAID, even after the note says something else', { skip: SKIP && skipReason }, async () => {
  // This is the whole of §32. A correction that overwrites is not a
  // correction — it is a rewrite with no record that anything was rewritten,
  // and the next pharmacist reads the new text as what was always there.
  const { pt, id, done } = await finalised(ctx.a.id, ctx.userA);
  assert.equal(done.status, 'completed');
  assert.equal(done.assessmentText, 'Uncomplicated acute cough');
  assert.ok(done.completedAt, 'finalising records when');
  // A note nobody has corrected says so, without the screen having to fetch
  // its history to find out.
  assert.equal(done.amendmentCount, 0);

  const reopened = await consultations.amendConsultation(ctx.a.id, pt, id,
    readAmendmentInput({ reason: 'Assessment was wrong — it is allergic rhinitis' }), PHARMACIST(ctx.userA));

  // The note is in progress, NOT a fifth status. 0067's own CHECK requires
  // both of these to be cleared, and it is right to: a reopened note has no
  // signature, and naming who signed the replaced version would attribute a
  // record they have not seen.
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.finalisedBy, null);

  // Now change it, and re-finalise.
  await consultations.updateConsultation(ctx.a.id, pt, id, readConsultationPatch({
    assessmentText: 'Allergic rhinitis',
  }), PHARMACIST(ctx.userA));
  const resigned = await consultations.completeConsultation(ctx.a.id, pt, id, PHARMACIST(ctx.userA));
  assert.equal(resigned.assessmentText, 'Allergic rhinitis');
  assert.equal(resigned.status, 'completed');
  // Derived by COUNTING the snapshots on every read, never stored — so it
  // cannot disagree with the rows it counts, and a re-signed note still
  // carries that it was corrected.
  assert.equal(resigned.amendmentCount, 1);
  assert.equal(reopened.amendmentCount, 1, 'the count is right the moment it is reopened');

  // AND THE OLD TEXT IS STILL THERE.
  const { amendments } = await consultations.consultationHistory(ctx.a.id, pt, id);
  assert.equal(amendments.length, 1);
  assert.equal(amendments[0].snapshot.assessmentText, 'Uncomplicated acute cough');
  assert.equal(amendments[0].snapshot.status, 'completed');
  assert.ok(amendments[0].snapshot.completedAt, 'the snapshot keeps the signature it had');
  assert.match(amendments[0].reason, /allergic rhinitis/i);
  assert.ok(amendments[0].at);
});

test('the snapshot holds the whole note, not a diff', { skip: SKIP && skipReason }, async () => {
  // 0070 argues this: a diff is only readable beside the thing it applies to,
  // and after two amendments nobody can reconstruct the middle version
  // without replaying them in the right order. A full copy cannot be got
  // wrong. This is the ONE place in the feature that copies clinical values
  // rather than pointing at them, because here going stale is the point.
  const pt = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, pt, start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, pt, c.id, readConsultationPatch({
    reasonCode: 'cough', assessmentText: 'Acute cough', planText: 'Hydration',
    subjective: 'Four days, dry', objective: 'Chest clear',
  }), PHARMACIST(ctx.userA));
  await consultations.addProblem(ctx.a.id, pt, c.id,
    readProblemInput({ label: 'acute cough', certainty: 'possible', status: 'active' }), PHARMACIST(ctx.userA));
  await consultations.addIntervention(ctx.a.id, pt, c.id,
    readInterventionInput({ kind: 'self_care_advice', note: 'Steam inhalation' }), PHARMACIST(ctx.userA));
  await consultations.setReferral(ctx.a.id, pt, c.id,
    readReferralInput({ destination: 'none', reason: 'Self-limiting' }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, pt, c.id, PHARMACIST(ctx.userA));

  await consultations.amendConsultation(ctx.a.id, pt, c.id,
    readAmendmentInput({ reason: 'Wrong patient details' }), PHARMACIST(ctx.userA));

  const { amendments } = await consultations.consultationHistory(ctx.a.id, pt, c.id);
  const snap = amendments[0].snapshot;
  assert.equal(snap.subjective, 'Four days, dry');
  assert.equal(snap.objective, 'Chest clear');
  assert.equal(snap.referralDestination, 'none');
  assert.equal(snap.problems.length, 1, 'the problem list is in the snapshot');
  assert.equal(snap.problems[0].label, 'acute cough');
  assert.equal(snap.interventions.length, 1, 'what was done is in the snapshot');
  assert.equal(snap.interventions[0].kind, 'self_care_advice');
  // The summary as it READ, so the history can show the note the way a
  // pharmacist would have seen it rather than making a reader rebuild it.
  assert.ok(snap.summary.some((x) => x.id === 'assessment'));
});

test('a second amendment is its own entry, and the first is not overwritten', { skip: SKIP && skipReason }, async () => {
  // recordEvent's DEFAULT idempotency key is eventType:entityType:entityId,
  // which would silently discard the second amendment of one note — exactly
  // the bug that lost a patient's second conversation relabel in Messages
  // phase 1, where the history showed one change where two had happened.
  const { pt, id } = await finalised(ctx.a.id, ctx.userA);

  await consultations.amendConsultation(ctx.a.id, pt, id,
    readAmendmentInput({ reason: 'First correction' }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, pt, id, PHARMACIST(ctx.userA));
  await consultations.amendConsultation(ctx.a.id, pt, id,
    readAmendmentInput({ reason: 'Second correction' }), PHARMACIST(ctx.userA));

  const { amendments, events } = await consultations.consultationHistory(ctx.a.id, pt, id);
  assert.equal(amendments.length, 2);
  assert.deepEqual(amendments.map((a) => a.reason), ['Second correction', 'First correction']);

  const amended = events.filter((e) => e.eventType === 'CONSULTATION_AMENDED');
  assert.equal(amended.length, 2, 'both amendments are on the audit trail');
  assert.deepEqual(amended.map((e) => e.metadata.amendmentNumber).sort(), [1, 2]);
  // The event carries the reason and NEVER the snapshot: the note would then
  // be in two places that can disagree.
  for (const e of amended) {
    assert.ok(e.metadata.reason);
    assert.ok(!('snapshot' in e.metadata), 'the event log is not a second copy of the note');
  }
});

test('an amended note must still pass its type\'s gate to be re-finalised', { skip: SKIP && skipReason }, async () => {
  // An amendment must not be a way around §23. A blood-pressure review that
  // needs an objective when first signed still needs one after being
  // reopened, and the SAME function decides.
  const pt = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, pt, start({ consultationType: 'bp_review' }), PHARMACIST(ctx.userA));
  await consultations.updateConsultation(ctx.a.id, pt, c.id, readConsultationPatch({
    reasonCode: 'bp_review', objective: 'BP 138/86, sitting', assessmentText: 'Controlled', planText: 'Continue',
  }), PHARMACIST(ctx.userA));
  await consultations.completeConsultation(ctx.a.id, pt, c.id, PHARMACIST(ctx.userA));

  await consultations.amendConsultation(ctx.a.id, pt, c.id,
    readAmendmentInput({ reason: 'The reading was recorded against the wrong arm' }), PHARMACIST(ctx.userA));
  // Empty the section the type requires.
  await consultations.updateConsultation(ctx.a.id, pt, c.id,
    readConsultationPatch({ objective: '' }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => consultations.completeConsultation(ctx.a.id, pt, c.id, PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.code, 'INCOMPLETE'); assert.ok(e.outstanding.length > 0); return true; },
  );
});

test('an OPEN note is edited, never "amended"', { skip: SKIP && skipReason }, async () => {
  // Calling ordinary typing an amendment would fill the history with entries
  // for text that was never signed, and bury the corrections that matter.
  const pt = await patient(ctx.a.id);
  const c = await consultations.startConsultation(ctx.a.id, pt, start({ consultationType: 'minor_ailment' }), PHARMACIST(ctx.userA));
  await assert.rejects(
    () => consultations.amendConsultation(ctx.a.id, pt, c.id, readAmendmentInput({ reason: 'Fixing a typo' }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 409); assert.equal(e.code, 'NOT_FINALISED'); return true; },
  );
  const { amendments } = await consultations.consultationHistory(ctx.a.id, pt, c.id);
  assert.deepEqual(amendments, [], 'a refused amendment leaves no snapshot behind');
});

test('a note entered in error cannot be amended back into the record', { skip: SKIP && skipReason }, async () => {
  // §39. Retiring a note is the one act that says "this should never have
  // existed". Letting it then be edited and re-signed would launder it.
  const { pt, id } = await finalised(ctx.a.id, ctx.userA);
  await consultations.markEnteredInError(ctx.a.id, pt, id,
    readErrorInput({ reason: 'Recorded against the wrong patient' }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => consultations.amendConsultation(ctx.a.id, pt, id, readAmendmentInput({ reason: 'Undo' }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 409); assert.equal(e.code, 'IN_ERROR'); return true; },
  );
  // And it is still there, still readable, still saying why (§39).
  const still = await consultations.getConsultation(ctx.a.id, pt, id);
  assert.equal(still.status, 'entered_in_error');
  assert.match(still.errorReason, /wrong patient/i);
});

test('re-marking a retired note is refused, and the original reason survives', { skip: SKIP && skipReason }, async () => {
  // Found while writing phase 3: markEnteredInError worked from ANY status,
  // so a second call overwrote `error_reason` — losing the only explanation
  // the record has — and put a second ENTERED_IN_ERROR on the audit trail
  // for something that happened once.
  const { pt, id } = await finalised(ctx.a.id, ctx.userA);
  await consultations.markEnteredInError(ctx.a.id, pt, id,
    readErrorInput({ reason: 'Recorded against the wrong patient' }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => consultations.markEnteredInError(ctx.a.id, pt, id,
      readErrorInput({ reason: 'Actually it was a duplicate' }), PHARMACIST(ctx.userA)),
    (e) => { assert.equal(e.status, 409); assert.equal(e.code, 'ALREADY_IN_ERROR'); return true; },
  );

  const still = await consultations.getConsultation(ctx.a.id, pt, id);
  assert.match(still.errorReason, /wrong patient/i, 'the first reason is what the record keeps');
  const { events } = await consultations.consultationHistory(ctx.a.id, pt, id);
  assert.equal(events.filter((e) => e.eventType === 'CONSULTATION_ENTERED_IN_ERROR').length, 1);
});

test('only a pharmacist or the owner may amend, enforced at the service', { skip: SKIP && skipReason }, async () => {
  const { pt, id } = await finalised(ctx.a.id, ctx.userA);
  await assert.rejects(
    () => consultations.amendConsultation(ctx.a.id, pt, id, readAmendmentInput({ reason: 'Let me fix this' }), STAFF(ctx.staffA)),
    (e) => { assert.equal(e.status, 403); assert.equal(e.code, 'ROLE_REQUIRED'); return true; },
  );
  // Refused BEFORE anything was written: the note is untouched and finalised.
  const still = await consultations.getConsultation(ctx.a.id, pt, id);
  assert.equal(still.status, 'completed');
  assert.ok(still.completedAt);
  const { amendments } = await consultations.consultationHistory(ctx.a.id, pt, id);
  assert.deepEqual(amendments, []);
});

test('the history is THIS note\'s, and another pharmacy cannot read it', { skip: SKIP && skipReason }, async () => {
  // GOLDEN-001 on a new read path. A consultation id is not a capability.
  const first = await finalised(ctx.a.id, ctx.userA);
  const second = await finalised(ctx.a.id, ctx.userA);
  await consultations.amendConsultation(ctx.a.id, first.pt, first.id,
    readAmendmentInput({ reason: 'Only the first note was corrected' }), PHARMACIST(ctx.userA));

  const mine = await consultations.consultationHistory(ctx.a.id, first.pt, first.id);
  assert.equal(mine.amendments.length, 1);
  const other = await consultations.consultationHistory(ctx.a.id, second.pt, second.id);
  assert.deepEqual(other.amendments, [], 'the other note has its own history');
  assert.ok(other.events.every((e) => e.eventType !== 'CONSULTATION_AMENDED'));

  // Pharmacy B, naming pharmacy A's note and A's patient.
  await assert.rejects(
    () => consultations.consultationHistory(ctx.b.id, first.pt, first.id),
    (e) => { assert.equal(e.status, 404); assert.equal(e.code, 'NOT_FOUND'); return true; },
  );
  // And another patient in the SAME pharmacy is refused too.
  await assert.rejects(
    () => consultations.consultationHistory(ctx.a.id, second.pt, first.id),
    (e) => { assert.equal(e.status, 404); return true; },
  );
  await assert.rejects(
    () => consultations.amendConsultation(ctx.b.id, first.pt, first.id, readAmendmentInput({ reason: 'Not mine' }), PHARMACIST(ctx.userB)),
    (e) => { assert.equal(e.status, 404); return true; },
  );
});

test('the audit view carries every act on the note, in order, with who did it', { skip: SKIP && skipReason }, async () => {
  // §32. Not a changelog: the history answers when the note was started, each
  // time it was signed, what was added to it and every correction since.
  const { pt, id } = await finalised(ctx.a.id, ctx.userA);
  await consultations.amendConsultation(ctx.a.id, pt, id,
    readAmendmentInput({ reason: 'Plan was incomplete' }), PHARMACIST(ctx.userA));

  const { events } = await consultations.consultationHistory(ctx.a.id, pt, id);
  const types = events.map((e) => e.eventType);
  for (const want of ['CONSULTATION_STARTED', 'CONSULTATION_COMPLETED', 'CONSULTATION_AMENDED']) {
    assert.ok(types.includes(want), `${want} missing from the history`);
  }
  // Newest first, and every entry names a person.
  const times = events.map((e) => new Date(e.occurredAt).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => y - x));
  for (const e of events) {
    assert.ok(e.actorType, 'every act has an actor type');
    assert.ok(e.actor, 'every act names who did it');
  }
});

test('amending creates no clinical record anywhere, and deletes nothing', { skip: SKIP && skipReason }, async () => {
  // §36 again, on the one path that WRITES a copy of clinical text. The
  // snapshot goes into its own table and nowhere else: no Condition from the
  // assessment being corrected, no Vitals row, no task.
  const { pt, id } = await finalised(ctx.a.id, ctx.userA);
  await consultations.amendConsultation(ctx.a.id, pt, id,
    readAmendmentInput({ reason: 'Assessment reworded' }), PHARMACIST(ctx.userA));

  for (const table of ['patient_problems', 'patient_allergies', 'patient_vitals', 'patient_tasks', 'medication_journeys']) {
    const [{ count }] = await db.unsafe(
      `select count(*)::int as count from ${table} where pharmacy_id = $1 and customer_id = $2`,
      [ctx.a.id, pt],
    );
    assert.equal(count, 0, `amending created a row in ${table}`);
  }
  // And the note itself is still one row — amending is not a copy-on-write.
  const [{ count }] = await db`
    select count(*)::int as count from pharmacist_consultations
    where pharmacy_id = ${ctx.a.id} and customer_id = ${pt}
  `;
  assert.equal(count, 1);
});
