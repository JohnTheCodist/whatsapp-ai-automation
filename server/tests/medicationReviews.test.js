/**
 * The medication review, against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a review belongs to a pharmacy, and pharmacy B
 * must never read or write one of pharmacy A's — across all three tables
 * (GOLDEN-001).
 *
 * The rest of this file holds the three decisions the review rests on: one
 * open draft per patient, findings replaced wholesale rather than merged, and
 * a signed review that refuses to be rewritten. Each of those, if it broke,
 * would produce a review that READS as a record of what a pharmacist decided
 * while not being one — which is the only failure on this screen that matters.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the medication review NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'mrevtest';
const TODAY = '2026-09-21';

let db;
let reviews;
let meds;
let ctx = null;

/** The review body as the route hands it over, already read by the contract. */
const { readReviewInput } = require('../services/clinical/medicationReviewInput');
const body = (b) => readReviewInput(b, { today: TODAY });
const signed = (b) => readReviewInput(b, { today: TODAY, signing: true });

async function patient(pharmacyId, phone) {
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, 'Review Tester', 'Review Tester')
    returning id
  `;
  return c.id;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  reviews = require('../services/clinical/medicationReviews');
  meds = require('../services/clinical/medications');

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
    p1: await patient(a.id, '2349070000001'),
    p2: await patient(a.id, '2349070000002'),
    p3: await patient(a.id, '2349070000003'),
    p4: await patient(a.id, '2349070000004'),
    bPatient: await patient(b.id, '2349070000005'),
  };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ---------------------------------------------------

test('pharmacy B cannot read, start, save or sign a review on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const med = await meds.addMedication(ctx.a.id, ctx.p1, {
    medicineName: 'Amlodipine', startedOn: '2026-09-01', status: 'active', source: 'prescribed',
  });
  const mine = await reviews.startReview(ctx.a.id, ctx.p1, { actorId: ctx.userA, today: TODAY });
  await reviews.saveReview(ctx.a.id, ctx.p1, mine.id, body({
    problems: [{ problem: 'non_adherence', journeyId: med.id, ref: 0 }],
    actions: [{ action: 'adherence_counselling', problemRef: 0 }],
  }));

  // Read: the same empty answer as a patient with no reviews, so a caller
  // cannot tell "not yours" from "nothing here".
  assert.deepEqual((await reviews.listReviews(ctx.b.id, ctx.p1)).reviews, []);
  await assert.rejects(
    () => reviews.getReview(ctx.b.id, ctx.p1, mine.id),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => reviews.startReview(ctx.b.id, ctx.p1, { today: TODAY }),
    (err) => err.status === 404 && err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => reviews.saveReview(ctx.b.id, ctx.p1, mine.id, body({ notes: 'Not mine' })),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => reviews.saveReview(ctx.b.id, ctx.p1, mine.id, signed({ outcome: 'resolved' }), { sign: true }),
    (err) => err.status === 404,
  );
  // B cannot see A's medicines through the reviewable list either.
  assert.deepEqual(await reviews.reviewableMedications(ctx.b.id, ctx.p1), []);

  // And A's review is untouched — the findings too, not just the header.
  const still = await reviews.getReview(ctx.a.id, ctx.p1, mine.id);
  assert.equal(still.notes, null);
  assert.equal(still.status, 'draft');
  assert.equal(still.problems.length, 1);
  assert.equal(still.actions.length, 1);
});

// ---- one draft ------------------------------------------------------------

test('starting a review twice returns the draft already being written', { skip: SKIP && skipReason }, async () => {
  // Two drafts would be two half-records of the same sitting, and neither
  // would be the review.
  const first = await reviews.startReview(ctx.a.id, ctx.p2, { actorId: ctx.userA, today: TODAY });
  await reviews.saveReview(ctx.a.id, ctx.p2, first.id, body({ notes: 'Half written' }));

  const second = await reviews.startReview(ctx.a.id, ctx.p2, { actorId: ctx.userA, today: TODAY });
  assert.equal(second.id, first.id);
  assert.equal(second.notes, 'Half written');
  assert.equal((await reviews.listReviews(ctx.a.id, ctx.p2)).reviews.length, 1);

  // Once it is signed, the next start is a NEW review.
  await reviews.saveReview(ctx.a.id, ctx.p2, first.id, signed({ outcome: 'resolved' }), {
    actorId: ctx.userA, sign: true,
  });
  const third = await reviews.startReview(ctx.a.id, ctx.p2, { actorId: ctx.userA, today: TODAY });
  assert.notEqual(third.id, first.id);
  assert.equal(third.status, 'draft');
  assert.equal((await reviews.listReviews(ctx.a.id, ctx.p2)).reviews.length, 2);
});

test('a new review starts empty and unattributed rather than assuming anything', { skip: SKIP && skipReason }, async () => {
  const r = await reviews.startReview(ctx.a.id, ctx.p3, { today: TODAY });
  assert.equal(r.status, 'draft');
  assert.equal(r.reviewedOn, TODAY);
  assert.equal(r.adherence, 'unknown');
  assert.equal(r.outcome, null);
  assert.equal(r.followUpOn, null);
  assert.equal(r.signedAt, null);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.actions, []);
  // DEV_AUTH_BYPASS has no real user, and an unattributed review is still a
  // review that happened.
  assert.equal(r.reviewer, null);
});

// ---- the findings ---------------------------------------------------------

test('an intervention is stored against the problem it answers', { skip: SKIP && skipReason }, async () => {
  // The question this exists to answer: WHICH interaction did you ring the
  // prescriber about.
  const amlo = await meds.addMedication(ctx.a.id, ctx.p4, {
    medicineName: 'Amlodipine', startedOn: '2026-09-01', status: 'active', source: 'prescribed',
  });
  const met = await meds.addMedication(ctx.a.id, ctx.p4, {
    medicineName: 'Metformin', startedOn: '2026-09-01', status: 'active', source: 'prescribed',
  });

  const draft = await reviews.startReview(ctx.a.id, ctx.p4, { actorId: ctx.userA, today: TODAY });
  const saved = await reviews.saveReview(ctx.a.id, ctx.p4, draft.id, body({
    adherence: 'partial',
    problems: [
      { problem: 'potential_interaction', journeyId: amlo.id, ref: 0, notes: 'With the herbal mix' },
      { problem: 'incorrect_dose', journeyId: met.id, ref: 1 },
    ],
    actions: [
      { action: 'prescriber_contacted', problemRef: 1, notes: 'Rang Dr John' },
      { action: 'counselling_provided' },
    ],
  }));

  assert.equal(saved.adherence, 'partial');
  assert.equal(saved.problems.length, 2);
  // The medicine's name travels with the problem, so a review reads without
  // joining back to the medication list.
  assert.equal(saved.problems[0].medicineName, 'Amlodipine');
  assert.equal(saved.problems[1].medicineName, 'Metformin');

  const rang = saved.actions.find((a) => a.action === 'prescriber_contacted');
  const doseProblem = saved.problems.find((p) => p.problem === 'incorrect_dose');
  assert.equal(rang.problemId, doseProblem.id, 'the intervention points at the dose problem, not the interaction');
  // A general intervention belongs to no single problem, and that is not a
  // missing link.
  assert.equal(saved.actions.find((a) => a.action === 'counselling_provided').problemId, null);
});

test('saving replaces the findings — a removed problem does not linger', { skip: SKIP && skipReason }, async () => {
  // Merging would leave a finding the pharmacist had deliberately removed
  // still in the record, which reads as something nobody stands behind.
  const draft = await reviews.startReview(ctx.a.id, ctx.p4, { actorId: ctx.userA, today: TODAY });
  await reviews.saveReview(ctx.a.id, ctx.p4, draft.id, body({
    problems: [
      { problem: 'adverse_effect', ref: 0 },
      { problem: 'access_cost', ref: 1 },
    ],
    actions: [{ action: 'referral_made', problemRef: 0 }],
  }));

  const after2 = await reviews.saveReview(ctx.a.id, ctx.p4, draft.id, body({
    problems: [{ problem: 'access_cost', ref: 0 }],
    actions: [{ action: 'counselling_provided', problemRef: 0 }],
  }));
  assert.deepEqual(after2.problems.map((p) => p.problem), ['access_cost']);
  assert.deepEqual(after2.actions.map((a) => a.action), ['counselling_provided']);
  assert.equal(after2.actions[0].problemId, after2.problems[0].id);

  // Nothing orphaned behind it — the old rows are gone, not detached.
  const [{ count }] = await db`
    select count(*)::int as count from medication_review_problems
    where review_id = ${draft.id} and pharmacy_id = ${ctx.a.id}
  `;
  assert.equal(count, 1);
  const [{ count: actionCount }] = await db`
    select count(*)::int as count from medication_review_actions
    where review_id = ${draft.id} and pharmacy_id = ${ctx.a.id}
  `;
  assert.equal(actionCount, 1);

  // Clearing everything is a legitimate save, not a no-op.
  const emptied = await reviews.saveReview(ctx.a.id, ctx.p4, draft.id, body({}));
  assert.deepEqual(emptied.problems, []);
  assert.deepEqual(emptied.actions, []);
});

// ---- signing --------------------------------------------------------------

test('a signed review refuses to be edited — a correction is a new review', { skip: SKIP && skipReason }, async () => {
  const draft = await reviews.startReview(ctx.a.id, ctx.p3, { actorId: ctx.userA, today: TODAY });
  const done = await reviews.saveReview(ctx.a.id, ctx.p3, draft.id, signed({
    outcome: 'monitoring',
    problems: [{ problem: 'non_adherence', ref: 0 }],
    actions: [{ action: 'adherence_counselling', problemRef: 0 }],
    followUpOn: '2026-10-21',
    followUpReason: 'Check the blood pressure',
  }), { actorId: ctx.userA, sign: true });

  assert.equal(done.status, 'signed');
  assert.ok(done.signedAt, 'signing stamps when');
  assert.equal(done.reviewer.id, ctx.userA, 'and who');
  assert.equal(done.followUpOn, '2026-10-21');

  await assert.rejects(
    () => reviews.saveReview(ctx.a.id, ctx.p3, draft.id, body({ notes: 'Actually...' })),
    (err) => err.status === 409 && err.code === 'ALREADY_SIGNED',
  );
  // Signing it again is the same refusal, not a second signature.
  await assert.rejects(
    () => reviews.saveReview(ctx.a.id, ctx.p3, draft.id, signed({ outcome: 'resolved' }), { sign: true }),
    (err) => err.status === 409,
  );

  const still = await reviews.getReview(ctx.a.id, ctx.p3, draft.id);
  assert.equal(still.notes, null);
  assert.equal(still.outcome, 'monitoring');
  assert.equal(still.problems.length, 1);
});

// ---- what a review is about -----------------------------------------------

test('the reviewable list is what the patient is on now, not everything they ever took', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349070000006');
  const live = await meds.addMedication(ctx.a.id, p, {
    medicineName: 'Lisinopril', strength: '10 mg', startedOn: '2026-09-01',
    status: 'active', source: 'prescribed',
  });
  const past = await meds.addMedication(ctx.a.id, p, {
    medicineName: 'Amoxicillin', startedOn: '2026-08-01', status: 'active', source: 'prescribed',
  });
  await meds.updateMedication(ctx.a.id, p, past.id, { status: 'completed', endedOn: '2026-08-08' });

  const list = await reviews.reviewableMedications(ctx.a.id, p);
  assert.deepEqual(list.map((m) => m.medicineName), ['Lisinopril']);
  assert.equal(list[0].id, live.id);
  assert.equal(list[0].strength, '10 mg');
});

test('a review survives the medicine it was about being taken off the record', { skip: SKIP && skipReason }, async () => {
  // ON DELETE SET NULL: a medicine removed does not erase the problem that
  // was found with it. The finding happened.
  const p = await patient(ctx.a.id, '2349070000007');
  const med = await meds.addMedication(ctx.a.id, p, {
    medicineName: 'Ibuprofen', startedOn: '2026-09-01', status: 'active', source: 'pharmacist_added',
  });
  const draft = await reviews.startReview(ctx.a.id, p, { actorId: ctx.userA, today: TODAY });
  await reviews.saveReview(ctx.a.id, p, draft.id, body({
    problems: [{ problem: 'adverse_effect', journeyId: med.id, ref: 0, notes: 'Stomach pain' }],
    actions: [{ action: 'medication_stopped', problemRef: 0 }],
  }));

  await db`delete from medication_journeys where id = ${med.id} and pharmacy_id = ${ctx.a.id}`;

  const after2 = await reviews.getReview(ctx.a.id, p, draft.id);
  assert.equal(after2.problems.length, 1);
  assert.equal(after2.problems[0].problem, 'adverse_effect');
  assert.equal(after2.problems[0].notes, 'Stomach pain');
  assert.equal(after2.problems[0].journeyId, null);
  assert.equal(after2.problems[0].medicineName, null, 'the name is gone with the row, the finding is not');
  assert.equal(after2.actions.length, 1);
});

test('the history reads newest first, with each review carrying its own findings', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id, '2349070000008');
  const older = await reviews.startReview(ctx.a.id, p, { actorId: ctx.userA, today: TODAY });
  await reviews.saveReview(ctx.a.id, p, older.id, signed({
    reviewedOn: '2026-08-01', outcome: 'resolved',
    problems: [{ problem: 'patient_misunderstanding', ref: 0 }],
    actions: [{ action: 'counselling_provided', problemRef: 0 }],
  }), { actorId: ctx.userA, sign: true });

  const newer = await reviews.startReview(ctx.a.id, p, { actorId: ctx.userA, today: TODAY });
  await reviews.saveReview(ctx.a.id, p, newer.id, body({
    reviewedOn: '2026-09-15',
    problems: [{ problem: 'drug_not_effective', ref: 0 }],
  }));

  const { reviews: list } = await reviews.listReviews(ctx.a.id, p);
  assert.deepEqual(list.map((r) => r.reviewedOn), ['2026-09-15', '2026-08-01']);
  // The findings are not smeared across the history — each belongs to its own.
  assert.deepEqual(list[0].problems.map((x) => x.problem), ['drug_not_effective']);
  assert.deepEqual(list[0].actions, []);
  assert.deepEqual(list[1].problems.map((x) => x.problem), ['patient_misunderstanding']);
  assert.deepEqual(list[1].actions.map((x) => x.action), ['counselling_provided']);
  assert.equal(list[1].status, 'signed');
});

test('the findings read back in the order the pharmacist wrote them', { skip: SKIP && skipReason }, async () => {
  // They are all written in ONE transaction, so they all share one
  // created_at — without a position the order is the uuid tiebreak, which is
  // random, and two people reading the same review read a different account
  // of the same consultation (0057).
  const p = await patient(ctx.a.id, '2349070000009');
  const draft = await reviews.startReview(ctx.a.id, p, { actorId: ctx.userA, today: TODAY });
  const order = ['non_adherence', 'incorrect_dose', 'access_cost', 'adverse_effect', 'drug_not_effective'];

  const saved = await reviews.saveReview(ctx.a.id, p, draft.id, body({
    problems: order.map((problem, i) => ({ problem, ref: i })),
    actions: [
      { action: 'adherence_counselling', problemRef: 0 },
      { action: 'dose_clarification', problemRef: 1 },
      { action: 'referral_made', problemRef: 2 },
    ],
  }));
  assert.deepEqual(saved.problems.map((x) => x.problem), order);
  assert.deepEqual(saved.actions.map((x) => x.action),
    ['adherence_counselling', 'dose_clarification', 'referral_made']);

  // And again on a fresh read, not just on the one the save returned.
  const reread = await reviews.getReview(ctx.a.id, p, draft.id);
  assert.deepEqual(reread.problems.map((x) => x.problem), order);
  assert.deepEqual(reread.actions.map((x) => x.action),
    ['adherence_counselling', 'dose_clarification', 'referral_made']);

  // Reordering is a save like any other.
  const flipped = [...order].reverse();
  const again = await reviews.saveReview(ctx.a.id, p, draft.id, body({
    problems: flipped.map((problem, i) => ({ problem, ref: i })),
  }));
  assert.deepEqual(again.problems.map((x) => x.problem), flipped);
});
