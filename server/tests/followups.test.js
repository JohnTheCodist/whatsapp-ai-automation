/**
 * Follow-ups against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a follow-up belongs to a pharmacy, and pharmacy B
 * must never read or write one of pharmacy A's (GOLDEN-001).
 *
 * Then what this queue exists to get right:
 *   - ONE table, ONE queue: a care-programme activity is a follow-up too, and
 *     appears here — while a standalone follow-up never leaks into a
 *     programme's plan or its progress counts (0062).
 *   - Due and overdue are derived from the date at the boundary day, never
 *     from a status somebody has to remember to update.
 *   - Completing records HOW IT WENT and points at what it produced; the
 *     reading itself stays in Vitals.
 *   - Rescheduling keeps the date it moved from; cancelling keeps the row.
 *   - Only a pharmacist or owner may cancel.
 *   - What raised it is checked against its own table AND this patient.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — follow-ups were NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'followuptest';
const TODAY = '2026-09-24';
const YESTERDAY = '2026-09-23';
const TOMORROW = '2026-09-25';

let db;
let followups;
let programs;
let ctx = null;

const {
  readFollowupInput, readFollowupPatch, readCompletion, readReschedule, readCancellation,
  FOLLOWUP_TYPES,
} = require('../services/clinical/followupInput');

const input = (b) => readFollowupInput(b);
const patch = (b) => readFollowupPatch(b);
const PHARMACIST = (userId) => ({ actorId: userId, actorRole: 'pharmacist', today: TODAY });
const STAFF = (userId) => ({ actorId: userId, actorRole: 'staff', today: TODAY });

let phone = 2349080000000;
async function patient(pharmacyId) {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, 'Follow-up Tester', 'Follow-up Tester')
    returning id
  `;
  return c.id;
}

async function vitals(pharmacyId, customerId) {
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic, diastolic)
    values (${pharmacyId}, ${customerId}, ${new Date(`${TODAY}T09:00:00Z`)}, 148, 92)
    returning id
  `;
  return v.id;
}

/** A consultation, through the tables the Clinical module actually uses. */
async function consultation(pharmacyId, customerId) {
  const [profile] = await db`
    insert into patient_profiles (pharmacy_id, customer_id)
    values (${pharmacyId}, ${customerId})
    on conflict (pharmacy_id, customer_id) do update set updated_at = now()
    returning id
  `;
  const [e] = await db`
    insert into clinical_encounters (pharmacy_id, patient_profile_id, presenting_complaint, started_at)
    values (${pharmacyId}, ${profile.id}, 'Headache and high BP', ${new Date(`${YESTERDAY}T09:00:00Z`)})
    returning id
  `;
  return e.id;
}

async function events(customerId, type) {
  return db`
    select event_type, actor_type, actor_id, metadata, visibility, entity_type, entity_id
    from customer_events
    where customer_id = ${customerId} and event_type = ${type}
    order by occurred_at, id
  `;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  followups = require('../services/clinical/followups');
  programs = require('../services/clinical/carePrograms');

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

test('pharmacy B cannot read, create, edit, complete or cancel on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Repeat blood pressure', dueOn: TOMORROW }), PHARMACIST(ctx.userA));

  const asB = await followups.listFollowups(ctx.b.id, p, { today: TODAY });
  assert.deepEqual(asB.followups, []);
  assert.equal(asB.counts.all, 0);

  await assert.rejects(() => followups.getFollowup(ctx.b.id, p, mine.id), (e) => e.status === 404);
  await assert.rejects(
    () => followups.updateFollowup(ctx.b.id, p, mine.id, patch({ title: 'Mine now' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => followups.completeFollowup(ctx.b.id, p, mine.id, readCompletion({ outcome: 'completed' }, { today: TODAY }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => followups.cancelFollowup(ctx.b.id, p, mine.id, readCancellation({ reason: 'duplicate' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => followups.createFollowup(ctx.b.id, p, input({ title: 'Theirs' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  // And nothing was changed by any of that.
  assert.equal((await followups.getFollowup(ctx.a.id, p, mine.id)).title, 'Repeat blood pressure');
});

// ---- the record -----------------------------------------------------------

test('every field comes back as entered, with what raised it resolved', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const enc = await consultation(ctx.a.id, p);

  const saved = await followups.createFollowup(ctx.a.id, p, input({
    title: 'Repeat blood pressure',
    description: 'Sitting, after five minutes',
    kind: 'monitoring',
    priority: 'urgent',
    reason: 'BP was elevated during the consultation.',
    dueOn: '2026-10-08',
    dueTime: '10:30',
    assignedToName: 'Pharm. John',
    sourceType: 'consultation',
    sourceId: enc,
    notes: 'Patient advised to return.',
  }), PHARMACIST(ctx.userA));

  const back = await followups.getFollowup(ctx.a.id, p, saved.id, { today: TODAY });
  assert.equal(back.title, 'Repeat blood pressure');
  assert.equal(back.kind, 'monitoring');
  assert.equal(back.priority, 'urgent');
  assert.equal(back.reason, 'BP was elevated during the consultation.');
  assert.equal(back.dueOn, '2026-10-08');
  assert.equal(back.dueTime, '10:30');
  assert.equal(back.assignedToName, 'Pharm. John');
  assert.equal(back.status, 'not_started');
  assert.equal(back.bucket, 'upcoming');
  assert.equal(back.rescheduledCount, 0);
  // It has no programme, and it knows whose it is anyway (0062's customer_id).
  assert.equal(back.programId, null);
  assert.equal(back.customerId, p);
  // What raised it, written the way the Clinical module writes it.
  assert.equal(back.sourceType, 'consultation');
  assert.equal(back.source.id, enc);
  assert.match(back.source.label, /Sep 2026/);
  assert.equal(back.linked, null);
});

test('the database accepts every kind the form offers', { skip: SKIP && skipReason }, async () => {
  // The CHECK in 0062 and the list in careProgramInput are one vocabulary in
  // two places; this is what stops them drifting.
  const p = await patient(ctx.a.id);
  for (const type of FOLLOWUP_TYPES) {
    const saved = await followups.createFollowup(ctx.a.id, p,
      input({ title: `A ${type.label}`, kind: type.value }), PHARMACIST(ctx.userA));
    assert.equal(saved.kind, type.value);
  }
});

test('a follow-up can only point at this patient\'s own records', { skip: SKIP && skipReason }, async () => {
  const mine = await patient(ctx.a.id);
  const other = await patient(ctx.a.id);
  const theirReading = await vitals(ctx.a.id, other);
  const myReading = await vitals(ctx.a.id, mine);

  await assert.rejects(
    () => followups.createFollowup(ctx.a.id, mine,
      input({ title: 'Wrong patient', sourceType: 'vitals', sourceId: theirReading }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'sourceId',
  );
  await assert.rejects(
    () => followups.createFollowup(ctx.a.id, mine,
      input({ title: 'Nothing', linkedType: 'test', linkedId: crypto.randomUUID() }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'linkedId',
  );

  const ok = await followups.createFollowup(ctx.a.id, mine,
    input({ title: 'Repeat BP', sourceType: 'vitals', sourceId: myReading }), PHARMACIST(ctx.userA));
  assert.equal(ok.source.id, myReading);
});

// ---- the queue ------------------------------------------------------------

test('the queue buckets at the boundary day, and counts what is waiting', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mk = (title, extra) => followups.createFollowup(ctx.a.id, p, input({ title, ...extra }), PHARMACIST(ctx.userA));

  await mk('Yesterday', { dueOn: YESTERDAY });
  await mk('Today', { dueOn: TODAY });
  await mk('Tomorrow', { dueOn: TOMORROW });
  // No date: "review the result when it arrives" is upcoming, never overdue —
  // it cannot be late against a date nobody has.
  await mk('When the result arrives', {});
  await mk('Urgent one', { dueOn: TOMORROW, priority: 'urgent' });

  const { followups: queue, counts } = await followups.listFollowups(ctx.a.id, p, { today: TODAY });
  const bucket = Object.fromEntries(queue.map((f) => [f.title, f.bucket]));
  assert.equal(bucket.Yesterday, 'overdue');
  // A task is NOT late on the day it is due.
  assert.equal(bucket.Today, 'today');
  assert.equal(bucket.Tomorrow, 'upcoming');
  assert.equal(bucket['When the result arrives'], 'upcoming');

  assert.equal(counts.all, 5);
  assert.equal(counts.overdue, 1);
  assert.equal(counts.today, 1);
  assert.equal(counts.upcoming, 3);
  assert.equal(counts.urgent, 1);

  // Overdue first, then today, then by date — the order a pharmacist works in.
  assert.deepEqual(queue.slice(0, 3).map((f) => f.title), ['Yesterday', 'Today', 'Tomorrow']);

  const onlyOverdue = await followups.listFollowups(ctx.a.id, p, { today: TODAY, filter: 'overdue' });
  assert.deepEqual(onlyOverdue.followups.map((f) => f.title), ['Yesterday']);
  // The counts do not change with the filter: they describe the patient, not
  // the current view.
  assert.equal(onlyOverdue.counts.all, 5);
});

test('a care-programme activity is in the patient\'s queue, and a follow-up is not in the programme', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const { readProgramInput, readActivityInput } = require('../services/clinical/careProgramInput');
  const program = await programs.enrolProgram(ctx.a.id, p,
    readProgramInput({ programName: 'Hypertension management' }, { today: TODAY }),
    { actorId: ctx.userA, actorRole: 'pharmacist' });
  await programs.addActivity(ctx.a.id, p, program.id,
    readActivityInput({ title: 'Check blood pressure', kind: 'monitoring', dueOn: YESTERDAY }),
    { actorId: ctx.userA, actorRole: 'pharmacist' });

  await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Standalone follow-up', dueOn: TODAY }), PHARMACIST(ctx.userA));

  // ONE QUEUE: the programme's task is here, and says which programme.
  const { followups: queue, counts } = await followups.listFollowups(ctx.a.id, p, { today: TODAY });
  const fromProgram = queue.find((f) => f.title === 'Check blood pressure');
  assert.ok(fromProgram, 'the programme activity is in the patient queue');
  assert.equal(fromProgram.programName, 'Hypertension management');
  assert.equal(fromProgram.bucket, 'overdue');
  assert.equal(counts.all, 2);

  // AND THE PROGRAMME IS UNCHANGED: the standalone follow-up never leaks into
  // its plan or its counts.
  const back = await programs.getProgram(ctx.a.id, p, program.id, { today: TODAY });
  assert.deepEqual(back.activities.map((a) => a.title), ['Check blood pressure']);
  assert.equal(back.progress.activities.total, 1);
  assert.equal(back.progress.activities.overdue, 1);
});

// ---- doing the work -------------------------------------------------------

test('completing records how it went and what it produced, and the reading stays in Vitals', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const reading = await vitals(ctx.a.id, p);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Repeat blood pressure', dueOn: YESTERDAY }), PHARMACIST(ctx.userA));

  const done = await followups.completeFollowup(ctx.a.id, p, saved.id, readCompletion({
    outcome: 'improved',
    outcomeNote: 'BP improved from the previous reading.',
    linkedType: 'vitals',
    linkedId: reading,
  }, { today: TODAY }), PHARMACIST(ctx.userA));

  assert.equal(done.status, 'completed');
  assert.equal(done.outcome, 'improved');
  assert.equal(done.bucket, 'completed');
  assert.ok(done.completedAt);
  assert.equal(done.completedBy.id, ctx.userA);
  // The RESULT is a pointer. The numbers are in patient_vitals, once.
  assert.equal(done.linkedType, 'vitals');
  assert.equal(done.linked.id, reading);
  assert.match(done.linked.detail, /148\/92/);
  const cols = await db`
    select column_name from information_schema.columns where table_name = 'patient_tasks'
  `;
  const names = cols.map((c) => c.column_name);
  assert.ok(names.length > 0, 'the task table was found under its real name');
  for (const forbidden of ['systolic', 'diastolic', 'value', 'value_number', 'result']) {
    assert.equal(names.includes(forbidden), false, `patient_tasks has no ${forbidden}`);
  }

  // Twice is refused rather than quietly overwriting the first outcome.
  await assert.rejects(
    () => followups.completeFollowup(ctx.a.id, p, saved.id,
      readCompletion({ outcome: 'stable' }, { today: TODAY }), PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'ALREADY_COMPLETED',
  );
});

test('completing a repeating follow-up creates exactly one next occurrence', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p, input({
    title: 'Check blood pressure',
    kind: 'monitoring',
    priority: 'urgent',
    reason: 'Hypertension monitoring',
    dueOn: '2026-09-01',
    recurrence: { every: 1, unit: 'month' },
    assignedToName: 'Pharm. John',
  }), PHARMACIST(ctx.userA));

  await followups.completeFollowup(ctx.a.id, p, saved.id,
    readCompletion({ outcome: 'stable' }, { today: TODAY }), PHARMACIST(ctx.userA));

  const { followups: queue } = await followups.listFollowups(ctx.a.id, p, { today: TODAY });
  assert.equal(queue.length, 2, 'exactly one next occurrence');
  const next = queue.find((f) => f.id !== saved.id);
  // Anchored to the day it was DUE, not the day it was done.
  assert.equal(next.dueOn, '2026-10-01');
  assert.equal(next.status, 'not_started');
  assert.equal(next.recurrenceOf, saved.id);
  // The standing job's details carry across; the last outcome does not.
  assert.equal(next.priority, 'urgent');
  assert.equal(next.reason, 'Hypertension monitoring');
  assert.equal(next.assignedToName, 'Pharm. John');
  assert.equal(next.outcome, null);
});

test('rescheduling keeps the date it moved from, and counts the moves', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Medication review', dueOn: TOMORROW }), PHARMACIST(ctx.userA));

  const moved = await followups.rescheduleFollowup(ctx.a.id, p, saved.id,
    readReschedule({ dueOn: '2026-10-08', reason: 'Patient travelling' }, { today: TODAY }), PHARMACIST(ctx.userA));
  assert.equal(moved.dueOn, '2026-10-08');
  assert.equal(moved.rescheduledCount, 1);

  const [event] = await events(p, 'FOLLOWUP_RESCHEDULED');
  assert.equal(event.metadata.from, TOMORROW);
  assert.equal(event.metadata.to, '2026-10-08');
  assert.equal(event.metadata.reason, 'Patient travelling');

  // The same date is not a move.
  await assert.rejects(
    () => followups.rescheduleFollowup(ctx.a.id, p, saved.id,
      readReschedule({ dueOn: '2026-10-08' }, { today: TODAY }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.code === 'SAME_DATE',
  );

  // A finished one is reopened before it can be moved, rather than silently
  // becoming live again.
  await followups.completeFollowup(ctx.a.id, p, saved.id,
    readCompletion({ outcome: 'completed' }, { today: TODAY }), PHARMACIST(ctx.userA));
  await assert.rejects(
    () => followups.rescheduleFollowup(ctx.a.id, p, saved.id,
      readReschedule({ dueOn: '2026-11-01' }, { today: TODAY }), PHARMACIST(ctx.userA)),
    (e) => e.status === 409,
  );
});

test('cancelling keeps the row and needs a pharmacist', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Lifestyle counselling', dueOn: TOMORROW }), STAFF(ctx.staffA));

  // Staff may create it and do the work; stopping planned care is a decision.
  await assert.rejects(
    () => followups.cancelFollowup(ctx.a.id, p, saved.id,
      readCancellation({ reason: 'duplicate' }), STAFF(ctx.staffA)),
    (e) => e.status === 403 && e.code === 'FORBIDDEN_ROLE',
  );

  const cancelled = await followups.cancelFollowup(ctx.a.id, p, saved.id,
    readCancellation({ reason: 'transferred_care', note: 'Moved to Abuja' }), PHARMACIST(ctx.userA));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.bucket, 'cancelled');
  assert.equal(cancelled.statusReason, 'Transferred care — Moved to Abuja');
  assert.ok(cancelled.cancelledAt);

  // The row is KEPT — deleting it would lose that it was ever needed.
  const [row] = await db`select id, status from patient_tasks where id = ${saved.id}`;
  assert.equal(row.status, 'cancelled');
  const [event] = await events(p, 'FOLLOWUP_CANCELLED');
  assert.equal(event.metadata.reason, 'transferred_care');

  // Reopening puts it back in the queue and clears what no longer applies.
  const reopened = await followups.reopenFollowup(ctx.a.id, p, saved.id, PHARMACIST(ctx.userA));
  assert.equal(reopened.status, 'not_started');
  assert.equal(reopened.statusReason, null);
  assert.equal(reopened.cancelledAt, null);
  const [back] = await events(p, 'FOLLOWUP_REOPENED');
  assert.equal(back.metadata.from, 'cancelled');
});

test('a completed follow-up cannot be cancelled into never having happened', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Done already', dueOn: YESTERDAY }), PHARMACIST(ctx.userA));
  await followups.completeFollowup(ctx.a.id, p, saved.id,
    readCompletion({ outcome: 'completed' }, { today: TODAY }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => followups.cancelFollowup(ctx.a.id, p, saved.id,
      readCancellation({ reason: 'duplicate' }), PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'ALREADY_COMPLETED',
  );
});

test('editing one changes only what was sent, and an empty edit writes nothing', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Review HbA1c result', reason: 'Diabetes care' }), PHARMACIST(ctx.userA));

  const edited = await followups.updateFollowup(ctx.a.id, p, saved.id,
    patch({ priority: 'urgent', assignedToName: 'Pharm. Adaeze' }), PHARMACIST(ctx.userA));
  assert.equal(edited.priority, 'urgent');
  assert.equal(edited.assignedToName, 'Pharm. Adaeze');
  assert.equal(edited.reason, 'Diabetes care', 'what was not sent was not touched');

  const again = await followups.updateFollowup(ctx.a.id, p, saved.id,
    patch({ priority: 'urgent' }), PHARMACIST(ctx.userA));
  assert.equal(again.updatedAt.getTime(), edited.updatedAt.getTime());
  assert.equal((await events(p, 'FOLLOWUP_UPDATED')).length, 1);
});

// ---- the audit trail ------------------------------------------------------

test('every act on a follow-up is on the patient\'s record, pointing at the task', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const enc = await consultation(ctx.a.id, p);
  const saved = await followups.createFollowup(ctx.a.id, p, input({
    title: 'Repeat blood pressure',
    reason: 'BP was elevated',
    dueOn: TOMORROW,
    sourceType: 'consultation',
    sourceId: enc,
  }), PHARMACIST(ctx.userA));

  const [created] = await events(p, 'FOLLOWUP_CREATED');
  assert.equal(created.actor_type, 'pharmacist');
  assert.equal(created.actor_id, ctx.userA);
  assert.equal(created.visibility, 'internal');
  assert.equal(created.entity_type, 'patient_task');
  assert.equal(created.entity_id, saved.id);
  assert.equal(created.metadata.title, 'Repeat blood pressure');
  assert.equal(created.metadata.source, 'consultation');
  assert.equal(created.metadata.sourceId, enc);

  await followups.updateFollowup(ctx.a.id, p, saved.id, patch({ title: 'Repeat BP' }), PHARMACIST(ctx.userA));
  const [updated] = await events(p, 'FOLLOWUP_UPDATED');
  assert.deepEqual(updated.metadata.changes.title, { from: 'Repeat blood pressure', to: 'Repeat BP' });

  await followups.completeFollowup(ctx.a.id, p, saved.id,
    readCompletion({ outcome: 'stable', outcomeNote: '132/84' }, { today: TODAY }), PHARMACIST(ctx.userA));
  const [done] = await events(p, 'FOLLOWUP_COMPLETED');
  assert.equal(done.metadata.outcome, 'stable');
  assert.equal(done.metadata.note, '132/84');
  assert.equal(done.metadata.completedOn, TODAY);
});

// ---- phase 2: recording a reading, and this follow-up's history -----------

test('completing may RECORD the reading, and it lands in Vitals, not here', { skip: SKIP && skipReason }, async () => {
  const { readVitalsInput } = require('../services/clinical/vitalsInput');
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Repeat blood pressure', kind: 'monitoring', dueOn: YESTERDAY }), PHARMACIST(ctx.userA));

  const fields = readCompletion({ outcome: 'improved', outcomeNote: 'Better than last time' }, { today: TODAY });
  // The same contract the Vitals screen uses — one definition of a plausible
  // reading, not a second one inside Follow-up.
  fields.reading = readVitalsInput({ systolic: '132', diastolic: '84', pulse: '72' });

  const done = await followups.completeFollowup(ctx.a.id, p, saved.id, fields, PHARMACIST(ctx.userA));
  assert.equal(done.status, 'completed');
  assert.equal(done.outcome, 'improved');
  // It points at the new reading.
  assert.equal(done.linkedType, 'vitals');
  assert.ok(done.linkedId);
  assert.ok(done.linked.detail.includes('132/84'), 'the link reads as the reading it points at');

  // AND THE READING IS IN VITALS, where readings live — the numbers are in
  // patient_vitals and nowhere else.
  const [reading] = await db`
    select systolic, diastolic, pulse, customer_id from patient_vitals where id = ${done.linkedId}
  `;
  assert.equal(reading.systolic, 132);
  assert.equal(reading.diastolic, 84);
  assert.equal(reading.pulse, 72);
  assert.equal(reading.customer_id, p);

  // The Vitals section sees it like any other reading.
  const { vitalsSeries } = require('../services/clinical/vitals');
  const series = await vitalsSeries(ctx.a.id, p, { limit: 10 });
  assert.ok(series.some((r) => r.systolic === 132), 'the reading is in the Vitals series');

  // The audit says it was RECORDED here rather than pointed at.
  const [event] = await events(p, 'FOLLOWUP_COMPLETED');
  assert.equal(event.metadata.readingRecorded, true);
  assert.equal(event.metadata.result.kind, 'vitals');
});

test('a reading is refused by the Vitals contract, and nothing is completed', { skip: SKIP && skipReason }, async () => {
  const { readVitalsInput } = require('../services/clinical/vitalsInput');
  const p = await patient(ctx.a.id);
  const saved = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Repeat blood pressure', dueOn: TODAY }), PHARMACIST(ctx.userA));

  // A systolic of 19 is a typo, and the Vitals contract is what says so.
  assert.throws(() => readVitalsInput({ systolic: '19' }), (e) => e.status === 400 && e.field === 'systolic');
  // An empty reading is a mis-click, not a reading of nothing.
  assert.throws(() => readVitalsInput({}), (e) => e.status === 400);

  // The follow-up is untouched by either refusal.
  assert.equal((await followups.getFollowup(ctx.a.id, p, saved.id)).status, 'not_started');
});

test('the timeline is THIS follow-up\'s history, not the patient\'s', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const one = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Repeat blood pressure', dueOn: TOMORROW }), PHARMACIST(ctx.userA));
  const two = await followups.createFollowup(ctx.a.id, p,
    input({ title: 'Review HbA1c result' }), PHARMACIST(ctx.userA));

  await followups.rescheduleFollowup(ctx.a.id, p, one.id,
    readReschedule({ dueOn: '2026-10-08', reason: 'Patient travelling' }, { today: TODAY }), PHARMACIST(ctx.userA));
  await followups.completeFollowup(ctx.a.id, p, one.id,
    readCompletion({ outcome: 'stable' }, { today: TODAY }), PHARMACIST(ctx.userA));

  const { events: trail } = await followups.followupTimeline(ctx.a.id, p, one.id);
  assert.deepEqual(trail.map((e) => e.eventType),
    ['FOLLOWUP_COMPLETED', 'FOLLOWUP_RESCHEDULED', 'FOLLOWUP_CREATED']);
  // Newest first, with who did it and what changed.
  assert.equal(trail[0].actor, `${TAG}-a-${ctx.userA}@example.test`);
  assert.equal(trail[1].metadata.from, TOMORROW);
  assert.equal(trail[1].metadata.to, '2026-10-08');

  // The OTHER follow-up's history is not in it, though it is the same patient
  // — that is the whole difference from the patient's timeline.
  const other = await followups.followupTimeline(ctx.a.id, p, two.id);
  assert.deepEqual(other.events.map((e) => e.metadata.title), ['Review HbA1c result']);

  // And another pharmacy cannot read either of them.
  await assert.rejects(() => followups.followupTimeline(ctx.b.id, p, one.id), (e) => e.status === 404);
});

// ---- phase 3: what other screens show ------------------------------------

test('the summary other screens show agrees with the queue, and counts only what is waiting', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mk = (title, extra) => followups.createFollowup(ctx.a.id, p, input({ title, ...extra }), PHARMACIST(ctx.userA));
  await mk('Late one', { dueOn: YESTERDAY });
  await mk('Today one', { dueOn: TODAY });
  await mk('Later one', { dueOn: TOMORROW });
  const done = await mk('Already done', { dueOn: YESTERDAY });
  await followups.completeFollowup(ctx.a.id, p, done.id,
    readCompletion({ outcome: 'completed' }, { today: TODAY }), PHARMACIST(ctx.userA));

  const summary = await followups.followupSummary(ctx.a.id, p, { today: TODAY });
  const queue = await followups.listFollowups(ctx.a.id, p, { today: TODAY });

  // The SAME counts the section shows — one read, trimmed.
  assert.deepEqual(summary.counts, queue.counts);
  assert.equal(summary.counts.overdue, 1);
  assert.equal(summary.counts.completed, 1);

  // What is still waiting, overdue first.
  assert.deepEqual(summary.next.map((f) => f.title), ['Late one', 'Today one', 'Later one']);

  // The finished one is NOT in it, because a completed follow-up is history,
  // not work. Asked with a limit that could HOLD it: an earlier version of
  // this assertion used the default cap of 3, where the completed row fell
  // off the end anyway — so it passed against a filter that let history
  // through. The cap must not be the thing that excludes it.
  const wide = await followups.followupSummary(ctx.a.id, p, { today: TODAY, limit: 20 });
  assert.equal(wide.next.length, 3);
  assert.ok(!wide.next.some((f) => f.title === 'Already done'));

  // No percentage, no score: the shape has nowhere to put one.
  assert.ok(!JSON.stringify(summary).match(/percent|score/i));

  // Capped: a context panel is a pointer, and the count is the honest part.
  await mk('One more', { dueOn: TOMORROW });
  const capped = await followups.followupSummary(ctx.a.id, p, { today: TODAY, limit: 3 });
  assert.equal(capped.next.length, 3);
  assert.equal(capped.counts.upcoming, 2);

  // Another pharmacy's patient has none.
  const asB = await followups.followupSummary(ctx.b.id, p, { today: TODAY });
  assert.deepEqual(asB.next, []);
  assert.equal(asB.counts.all, 0);
});

// ---- what 0062 carried across ---------------------------------------------

test('every task still belongs to the patient its programme belongs to', { skip: SKIP && skipReason }, async () => {
  // 0062 backfilled customer_id from the programme. A row where the two
  // disagree would put one patient's task in another patient's queue.
  const wrong = await db`
    select count(*)::int as count
    from patient_tasks t
    join patient_care_programs p on p.id = t.program_id
    where t.customer_id <> p.customer_id or t.pharmacy_id <> p.pharmacy_id
  `;
  assert.equal(wrong[0].count, 0);

  const orphan = await db`select count(*)::int as count from patient_tasks where customer_id is null`;
  assert.equal(orphan[0].count, 0);
});
