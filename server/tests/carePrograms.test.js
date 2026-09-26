/**
 * Care programmes against real Postgres.
 *
 * THE MANDATORY CASE FIRST: a programme belongs to a pharmacy, and pharmacy B
 * must never read or write one of pharmacy A's (GOLDEN-001).
 *
 * Then what this record exists to get right:
 *   - Enrolling in a template creates the patient's OWN goals and activities,
 *     with the programme name as it was at enrolment.
 *   - A second open enrolment in the same programme is a double-click, and is
 *     refused with the existing one named.
 *   - Ending a programme keeps every goal and every activity it had. That is
 *     the difference between a care record and a to-do list.
 *   - Completing a recurring task creates EXACTLY ONE next occurrence, in the
 *     same transaction, linked to the one it followed.
 *   - A task that was done cannot be deleted into never having happened.
 *   - Nothing clinical is stored here: what an activity produced is an id,
 *     checked against its own table AND this patient before it is stored.
 *   - Only a pharmacist or owner closes a course of care.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — care programmes were NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'cprogtest';
const TODAY = '2026-09-24';

let db;
let programs;
let ctx = null;

const {
  readProgramInput, readProgramPatch, readGoalInput, readGoalPatch,
  readActivityInput, readActivityPatch,
} = require('../services/clinical/careProgramInput');

const enrol = (b = {}, opts = {}) => readProgramInput(b, { today: TODAY, ...opts });
const programPatch = (b) => readProgramPatch(b);
const goalInput = (b) => readGoalInput(b, { today: TODAY });
const goalPatch = (b) => readGoalPatch(b);
const activityInput = (b) => readActivityInput(b);
const activityPatch = (b) => readActivityPatch(b);
const PHARMACIST = (userId) => ({ actorId: userId, actorRole: 'pharmacist', today: TODAY });
const STAFF = (userId) => ({ actorId: userId, actorRole: 'staff', today: TODAY });

let phone = 2349070000000;
async function patient(pharmacyId) {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, 'Programme Tester', 'Programme Tester')
    returning id
  `;
  return c.id;
}

async function vitals(pharmacyId, customerId, systolic = 148, diastolic = 92, on = null) {
  const [v] = await db`
    insert into patient_vitals (pharmacy_id, customer_id, recorded_at, systolic, diastolic)
    values (${pharmacyId}, ${customerId},
            ${on ? new Date(`${on}T09:00:00Z`) : new Date(Date.now() - 86400000)},
            ${systolic}, ${diastolic})
    returning id
  `;
  return v.id;
}

/**
 * A finished test with one number in it — what the Tests section (0060) holds,
 * written the way it writes it, so monitoring is read through the real shape
 * rather than a fixture that agrees with itself.
 */
async function testResult(pharmacyId, customerId, code, name, value, unit, on) {
  const [t] = await db`
    insert into patient_tests (pharmacy_id, customer_id, test_code, test_name, category, status,
                              performed_at, performed_precision)
    values (${pharmacyId}, ${customerId}, ${code}, ${name}, 'chemistry', 'final',
            ${new Date(`${on}T09:00:00Z`)}, 'day')
    returning id
  `;
  await db`
    insert into patient_test_results (pharmacy_id, test_id, analyte_name, analyte_code, value_number, unit)
    values (${pharmacyId}, ${t.id}, ${name}, ${code}, ${value}, ${unit})
  `;
  return t.id;
}

async function definitionByCode(code) {
  const [d] = await db`select id from care_program_definitions where code = ${code} and pharmacy_id is null`;
  return d ? d.id : null;
}

/** The catalogue row as the service hands it to the contract. */
async function definition(pharmacyId, code) {
  const all = await programs.careProgramCatalogue(pharmacyId);
  return all.find((d) => d.code === code);
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

test('pharmacy B cannot read, enrol, edit or plan on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Diabetes care' }), PHARMACIST(ctx.userA));

  const asB = await programs.listPrograms(ctx.b.id, p, { today: TODAY });
  assert.deepEqual(asB.active, []);
  assert.deepEqual(asB.past, []);
  assert.equal(asB.counts.active, 0);

  await assert.rejects(() => programs.getProgram(ctx.b.id, p, mine.id), (e) => e.status === 404);
  await assert.rejects(
    () => programs.updateProgram(ctx.b.id, p, mine.id, programPatch({ notes: 'mine now' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => programs.enrolProgram(ctx.b.id, p, enrol({ programName: 'Hypertension' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => programs.addGoal(ctx.b.id, p, mine.id, goalInput({ title: 'X' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => programs.addActivity(ctx.b.id, p, mine.id, activityInput({ title: 'X' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  // And nothing was changed by any of that.
  assert.equal((await programs.getProgram(ctx.a.id, p, mine.id)).notes, null);
});

test('the shipped templates are readable by every tenant, and carry no pharmacy', { skip: SKIP && skipReason }, async () => {
  const forA = await programs.careProgramCatalogue(ctx.a.id);
  const forB = await programs.careProgramCatalogue(ctx.b.id);
  const codes = (list) => list.map((d) => d.code).sort();
  assert.deepEqual(codes(forA), codes(forB));
  assert.ok(forA.length >= 7, 'the seven shipped programmes are there');
  assert.ok(forA.every((d) => d.shipped));
  const diabetes = forA.find((d) => d.code === 'DIABETES_CARE');
  assert.equal(diabetes.conditionCode, 'DIABETES');
  assert.ok(diabetes.goals.length > 0 && diabetes.activities.length > 0);
  assert.ok(diabetes.monitoring.some((m) => m.source === 'test' && m.code === 'HBA1C'));
});

// ---- enrolling ------------------------------------------------------------

test('enrolling in a template creates this patient\'s own goals and tasks', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const def = await definition(ctx.a.id, 'DIABETES_CARE');
  const { plan } = await programs.planForDefinition(ctx.a.id, def.id, { today: TODAY, startDate: '2026-10-01' });

  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({
    startDate: '2026-10-01', reason: 'Newly diagnosed, started on metformin',
  }, { definition: def }), { plan, ...PHARMACIST(ctx.userA) });

  assert.equal(saved.programName, 'Diabetes care');
  assert.equal(saved.programCode, 'DIABETES_CARE');
  assert.equal(saved.conditionCode, 'DIABETES');
  assert.equal(saved.definitionId, def.id);
  assert.equal(saved.status, 'active');
  assert.equal(saved.nextReviewOn, '2026-12-30');
  assert.equal(saved.goals.length, def.goals.length);
  assert.equal(saved.activities.length, def.activities.length);
  // Dated from the START day, not from today.
  assert.equal(saved.activities[0].dueOn, '2026-10-01');
  // And they are this patient's own rows now: editable.
  const edited = await programs.updateGoal(ctx.a.id, p, saved.id, saved.goals[0].id,
    goalPatch({ targetValue: 6.5 }), PHARMACIST(ctx.userA));
  assert.equal(edited.goals[0].targetValue, 6.5);

  // Renaming the template does not rewrite what this patient was enrolled in.
  await db`update care_program_definitions set name = 'Diabetes care (2027)' where id = ${def.id}`;
  const back = await programs.getProgram(ctx.a.id, p, saved.id);
  assert.equal(back.programName, 'Diabetes care');
  assert.equal(back.definitionName, 'Diabetes care (2027)');
  await db`update care_program_definitions set name = 'Diabetes care' where id = ${def.id}`;
});

test('a second open enrolment in the same programme is refused, and names the one that exists', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const def = await definition(ctx.a.id, 'HYPERTENSION_CARE');
  const first = await programs.enrolProgram(ctx.a.id, p, enrol({}, { definition: def }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => programs.enrolProgram(ctx.a.id, p, enrol({}, { definition: def }), PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'DUPLICATE_ACTIVE_PROGRAM'
      && e.existing.id === first.id && e.existing.label === 'Hypertension management',
  );

  // Once it has ended, the patient can be enrolled again — a second course of
  // care is a real thing; two live copies of one are not.
  await programs.updateProgram(ctx.a.id, p, first.id,
    programPatch({ status: 'completed', outcome: 'achieved' }), PHARMACIST(ctx.userA));
  const second = await programs.enrolProgram(ctx.a.id, p, enrol({}, { definition: def }), PHARMACIST(ctx.userA));
  assert.notEqual(second.id, first.id);

  const list = await programs.listPrograms(ctx.a.id, p, { today: TODAY });
  assert.equal(list.active.length, 1);
  assert.equal(list.past.length, 1);
});

test('the database itself refuses two open enrolments, not only the service', { skip: SKIP && skipReason }, async () => {
  // The service checks first, which gives a good message. Two requests at the
  // same moment both pass that check, so the index is what actually holds.
  const p = await patient(ctx.a.id);
  const defId = await definitionByCode('WEIGHT_PROGRAM');
  const row = {
    pharmacy_id: ctx.a.id, customer_id: p, definition_id: defId,
    program_name: 'Weight management', status: 'active', enrolled_on: TODAY,
  };
  await db`insert into patient_care_programs ${db(row)}`;
  await assert.rejects(
    () => db`insert into patient_care_programs ${db(row)}`,
    (e) => e.code === '23505',
  );
  // A programme with no template is NOT covered, deliberately: those are named
  // by hand and a pharmacist can see them on the list.
  const free = { ...row, definition_id: null, program_name: 'Wound care' };
  await db`insert into patient_care_programs ${db(free)}`;
  await db`insert into patient_care_programs ${db(free)}`;
  const [{ count }] = await db`
    select count(*)::int as count from patient_care_programs
    where pharmacy_id = ${ctx.a.id} and customer_id = ${p} and definition_id is null
  `;
  assert.equal(count, 2);
});

test('every field on a programme survives a round trip', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({
    programName: 'Antenatal support',
    status: 'planned',
    startDate: '2026-10-05',
    nextReviewOn: '2026-11-05',
    responsibleUserId: ctx.userA,
    responsibleName: 'Pharm. Adaeze',
    reason: 'First pregnancy, wants monthly checks',
    notes: 'Prefers Saturday mornings.',
  }), PHARMACIST(ctx.userA));

  const back = await programs.getProgram(ctx.a.id, p, saved.id, { today: TODAY });
  assert.equal(back.programName, 'Antenatal support');
  assert.equal(back.status, 'planned');
  assert.equal(back.startDate, '2026-10-05');
  assert.equal(back.nextReviewOn, '2026-11-05');
  assert.equal(back.responsible.id, ctx.userA);
  assert.equal(back.responsible.name, 'Pharm. Adaeze');
  assert.equal(back.reason, 'First pregnancy, wants monthly checks');
  assert.equal(back.notes, 'Prefers Saturday mornings.');
  assert.equal(back.definitionId, null);
  assert.equal(back.endDate, null);
  assert.equal(back.outcome, null);
  assert.equal(back.recordedBy.id, ctx.userA);
});

test('ending a programme keeps every goal and every task it had', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const def = await definition(ctx.a.id, 'MED_MANAGEMENT');
  const { plan } = await programs.planForDefinition(ctx.a.id, def.id, { today: TODAY });
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({}, { definition: def }), { plan, ...PHARMACIST(ctx.userA) });
  const goalCount = saved.goals.length;
  const taskCount = saved.activities.length;
  assert.ok(goalCount > 0 && taskCount > 0);

  const done = await programs.updateProgram(ctx.a.id, p, saved.id, programPatch({
    status: 'completed',
    outcome: 'partially_achieved',
    outcomeNotes: 'Adherence improved; still misses the evening dose.',
    followUpRecommendation: 'Review again in six months.',
  }), PHARMACIST(ctx.userA));

  assert.equal(done.status, 'completed');
  assert.equal(done.endDate, TODAY);
  assert.equal(done.outcome, 'partially_achieved');
  assert.equal(done.goals.length, goalCount, 'the goals are still there');
  assert.equal(done.activities.length, taskCount, 'the plan is still there');

  // It reads as past, and its history is intact.
  const list = await programs.listPrograms(ctx.a.id, p, { today: TODAY });
  assert.equal(list.past.length, 1);
  assert.equal(list.past[0].outcomeNotes, 'Adherence improved; still misses the evening dose.');
});

test('a discontinued programme records why, and the row is never deleted', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Weight plan' }), PHARMACIST(ctx.userA));
  const stopped = await programs.updateProgram(ctx.a.id, p, saved.id, programPatch({
    status: 'discontinued',
    discontinuationReason: 'lost_to_follow_up',
    statusReason: 'Moved to Abuja; three calls unanswered.',
  }), PHARMACIST(ctx.userA));

  assert.equal(stopped.status, 'discontinued');
  assert.equal(stopped.discontinuationReason, 'lost_to_follow_up');
  assert.equal(stopped.endDate, TODAY);
  const [row] = await db`select id, status from patient_care_programs where id = ${saved.id}`;
  assert.equal(row.status, 'discontinued');
});

test('the database refuses a programme that ended with nothing said about how', { skip: SKIP && skipReason }, async () => {
  // The service says it in a sentence; this is the floor under that, so a
  // future caller that skips the contract cannot write a meaningless ending.
  const p = await patient(ctx.a.id);
  const base = {
    pharmacy_id: ctx.a.id, customer_id: p, program_name: 'Raw', enrolled_on: TODAY,
  };
  await assert.rejects(
    () => db`insert into patient_care_programs ${db({ ...base, status: 'completed', end_date: TODAY })}`,
    (e) => e.code === '23514',
  );
  await assert.rejects(
    () => db`insert into patient_care_programs ${db({ ...base, status: 'discontinued', end_date: TODAY })}`,
    (e) => e.code === '23514',
  );
  // An open programme cannot carry an end date.
  await assert.rejects(
    () => db`insert into patient_care_programs ${db({ ...base, status: 'active', end_date: TODAY })}`,
    (e) => e.code === '23514',
  );
});

test('only a pharmacist or owner may close a course of care', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  // Staff may enrol, and may plan.
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Vaccination follow-up' }), STAFF(ctx.staffA));
  await programs.addGoal(ctx.a.id, p, saved.id, goalInput({ title: 'Course completed' }), STAFF(ctx.staffA));
  const withTask = await programs.addActivity(ctx.a.id, p, saved.id,
    activityInput({ title: 'Next dose due', kind: 'vaccination', dueOn: '2026-10-22' }), STAFF(ctx.staffA));
  // And may tick a task off — doing the work is not the same as closing the file.
  const ticked = await programs.updateActivity(ctx.a.id, p, saved.id, withTask.activities[0].id,
    activityPatch({ status: 'completed' }), STAFF(ctx.staffA));
  assert.equal(ticked.activities[0].status, 'completed');

  for (const patch of [
    { status: 'completed', outcome: 'achieved' },
    { status: 'discontinued', discontinuationReason: 'patient_withdrew' },
    { status: 'cancelled', statusReason: 'Enrolled the wrong patient' },
  ]) {
    await assert.rejects(
      () => programs.updateProgram(ctx.a.id, p, saved.id, programPatch(patch), STAFF(ctx.staffA)),
      (e) => e.status === 403 && e.code === 'FORBIDDEN_ROLE',
    );
  }
  // Still open, and unchanged.
  assert.equal((await programs.getProgram(ctx.a.id, p, saved.id)).status, 'active');

  const closed = await programs.updateProgram(ctx.a.id, p, saved.id,
    programPatch({ status: 'completed', outcome: 'achieved' }), PHARMACIST(ctx.userA));
  assert.equal(closed.status, 'completed');
});

// ---- goals ---------------------------------------------------------------

test('goals are added, edited and removed, and removing one leaves the tasks that served it', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'BP control' }), PHARMACIST(ctx.userA));
  const withGoal = await programs.addGoal(ctx.a.id, p, saved.id, goalInput({
    title: 'Blood pressure below 140/90',
    measure: 'Systolic BP',
    measureSource: 'vitals',
    measureCode: 'systolic',
    unit: 'mmHg',
    baselineValue: 168,
    baselineOn: '2026-09-01',
    targetValue: 140,
    targetDate: '2026-12-01',
  }), PHARMACIST(ctx.userA));
  const goalId = withGoal.goals[0].id;
  assert.equal(withGoal.goals[0].baselineValue, 168);
  assert.equal(withGoal.goals[0].measureCode, 'systolic');

  const withTask = await programs.addActivity(ctx.a.id, p, saved.id, activityInput({
    title: 'Check blood pressure', kind: 'monitoring', goalId, dueOn: '2026-10-01',
  }), PHARMACIST(ctx.userA));
  assert.equal(withTask.activities[0].goalId, goalId);

  const achieved = await programs.updateGoal(ctx.a.id, p, saved.id, goalId,
    goalPatch({ status: 'achieved' }), PHARMACIST(ctx.userA));
  assert.equal(achieved.goals[0].status, 'achieved');
  assert.equal(achieved.goals[0].achievedOn, TODAY);

  const removed = await programs.removeGoal(ctx.a.id, p, saved.id, goalId, PHARMACIST(ctx.userA));
  assert.equal(removed.goals.length, 0);
  // The task it served is still in the plan, now belonging to no goal.
  assert.equal(removed.activities.length, 1);
  assert.equal(removed.activities[0].goalId, null);
});

test('a goal from another programme cannot be attached to this one\'s task', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const one = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Programme one' }), PHARMACIST(ctx.userA));
  const two = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Programme two' }), PHARMACIST(ctx.userA));
  const withGoal = await programs.addGoal(ctx.a.id, p, one.id, goalInput({ title: 'Goal of one' }), PHARMACIST(ctx.userA));
  const foreignGoal = withGoal.goals[0].id;

  await assert.rejects(
    () => programs.addActivity(ctx.a.id, p, two.id,
      activityInput({ title: 'Task', goalId: foreignGoal }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'goalId',
  );
});

// ---- the plan and the task list ------------------------------------------

test('completing a repeating task creates exactly one next occurrence, linked to it', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Monthly checks' }), PHARMACIST(ctx.userA));
  const withTask = await programs.addActivity(ctx.a.id, p, saved.id, activityInput({
    title: 'Check blood pressure',
    kind: 'monitoring',
    dueOn: '2026-09-01',
    recurrence: { every: 1, unit: 'month' },
    assignedToName: 'Chidi',
  }), PHARMACIST(ctx.userA));
  const first = withTask.activities[0].id;

  const after1 = await programs.updateActivity(ctx.a.id, p, saved.id, first,
    activityPatch({ status: 'completed', outcomeNote: '138/86' }), PHARMACIST(ctx.userA));

  assert.equal(after1.activities.length, 2, 'exactly one next occurrence');
  const done = after1.activities.find((a) => a.id === first);
  const next = after1.activities.find((a) => a.id !== first);
  // The completed one is KEPT, with what it found.
  assert.equal(done.status, 'completed');
  assert.ok(done.completedAt);
  assert.equal(done.completedBy.id, ctx.userA);
  assert.equal(done.outcomeNote, '138/86');
  // Anchored to the day it was DUE, so a late tick does not shift the schedule.
  assert.equal(next.dueOn, '2026-10-01');
  assert.equal(next.status, 'not_started');
  assert.equal(next.recurrenceOf, first);
  assert.equal(next.assignedToName, 'Chidi');
  assert.equal(next.outcomeNote, null);

  // And doing that one creates one more, not two.
  const after2 = await programs.updateActivity(ctx.a.id, p, saved.id, next.id,
    activityPatch({ status: 'completed' }), PHARMACIST(ctx.userA));
  assert.equal(after2.activities.length, 3);
  assert.equal(after2.activities.filter((a) => a.status === 'not_started').length, 1);
});

test('completing a one-off task creates nothing, and reopening one clears its completion', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'One-off' }), PHARMACIST(ctx.userA));
  const withTask = await programs.addActivity(ctx.a.id, p, saved.id,
    activityInput({ title: 'Counsel on diet', kind: 'counselling', dueOn: '2026-09-20' }), PHARMACIST(ctx.userA));
  const taskId = withTask.activities[0].id;

  const done = await programs.updateActivity(ctx.a.id, p, saved.id, taskId,
    activityPatch({ status: 'completed' }), PHARMACIST(ctx.userA));
  assert.equal(done.activities.length, 1);
  assert.ok(done.activities[0].completedAt);

  const reopened = await programs.updateActivity(ctx.a.id, p, saved.id, taskId,
    activityPatch({ status: 'in_progress' }), PHARMACIST(ctx.userA));
  assert.equal(reopened.activities[0].completedAt, null);
  assert.equal(reopened.activities[0].completedBy, null);
});

test('a task that was done cannot be deleted into never having happened', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'History matters' }), PHARMACIST(ctx.userA));
  const withTasks = await programs.addActivity(ctx.a.id, p, saved.id,
    activityInput({ title: 'Did this', dueOn: '2026-09-10' }), PHARMACIST(ctx.userA));
  const doneId = withTasks.activities[0].id;
  await programs.updateActivity(ctx.a.id, p, saved.id, doneId, activityPatch({ status: 'completed' }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => programs.removeActivity(ctx.a.id, p, saved.id, doneId, PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'ACTIVITY_COMPLETED',
  );

  // Cancelling keeps it, with the reason.
  const cancelled = await programs.updateActivity(ctx.a.id, p, saved.id, doneId, activityPatch({
    status: 'cancelled', statusReason: 'Recorded against the wrong visit',
  }), PHARMACIST(ctx.userA));
  assert.equal(cancelled.activities[0].status, 'cancelled');
  assert.equal(cancelled.activities[0].statusReason, 'Recorded against the wrong visit');

  // A task nobody has done yet can be taken out of the plan.
  const planned = await programs.addActivity(ctx.a.id, p, saved.id,
    activityInput({ title: 'Never mind this one' }), PHARMACIST(ctx.userA));
  const plannedId = planned.activities.find((a) => a.title === 'Never mind this one').id;
  const after = await programs.removeActivity(ctx.a.id, p, saved.id, plannedId, PHARMACIST(ctx.userA));
  assert.equal(after.activities.some((a) => a.id === plannedId), false);
});

test('what a task produced is an id, checked against its own table and this patient', { skip: SKIP && skipReason }, async () => {
  const mine = await patient(ctx.a.id);
  const other = await patient(ctx.a.id);
  const myReading = await vitals(ctx.a.id, mine);
  const theirReading = await vitals(ctx.a.id, other);
  const saved = await programs.enrolProgram(ctx.a.id, mine, enrol({ programName: 'Linking' }), PHARMACIST(ctx.userA));

  const linked = await programs.addActivity(ctx.a.id, mine, saved.id, activityInput({
    title: 'Check blood pressure', kind: 'monitoring', linkedType: 'vitals', linkedId: myReading,
  }), PHARMACIST(ctx.userA));
  assert.equal(linked.activities[0].linkedType, 'vitals');
  assert.equal(linked.activities[0].linkedId, myReading);

  // Another patient's reading, in the same pharmacy, is still not this one's.
  await assert.rejects(
    () => programs.addActivity(ctx.a.id, mine, saved.id, activityInput({
      title: 'Wrong patient', linkedType: 'vitals', linkedId: theirReading,
    }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'linkedId',
  );
  // And an id that names nothing at all.
  await assert.rejects(
    () => programs.addActivity(ctx.a.id, mine, saved.id, activityInput({
      title: 'Nothing', linkedType: 'test', linkedId: crypto.randomUUID(),
    }), PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'linkedId',
  );

  // NOTHING CLINICAL IS COPIED: the task row has no value columns at all.
  // RENAMED 2026-09-24 with 0062 — the table is patient_tasks now, and this
  // query would have passed vacuously against a name that no longer exists.
  const cols = await db`
    select column_name from information_schema.columns
    where table_name = 'patient_tasks'
  `;
  assert.ok(cols.length > 0, 'the task table was found under its real name');
  const names = cols.map((c) => c.column_name);
  for (const forbiddenCol of ['systolic', 'value', 'value_number', 'result', 'medicine_name', 'condition_name']) {
    assert.equal(names.includes(forbiddenCol), false, `patient_tasks has no ${forbiddenCol}`);
  }
});

test('progress counts what the rows say, at the boundary day', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Counting' }), PHARMACIST(ctx.userA));
  await programs.addGoal(ctx.a.id, p, saved.id, goalInput({ title: 'One' }), PHARMACIST(ctx.userA));
  const withGoals = await programs.addGoal(ctx.a.id, p, saved.id, goalInput({ title: 'Two' }), PHARMACIST(ctx.userA));
  await programs.updateGoal(ctx.a.id, p, saved.id, withGoals.goals[0].id,
    goalPatch({ status: 'achieved' }), PHARMACIST(ctx.userA));

  // Due YESTERDAY is overdue; due TODAY is not — a task is not late on the day
  // it is due.
  await programs.addActivity(ctx.a.id, p, saved.id, activityInput({ title: 'Yesterday', dueOn: '2026-09-23' }), PHARMACIST(ctx.userA));
  await programs.addActivity(ctx.a.id, p, saved.id, activityInput({ title: 'Today', dueOn: TODAY }), PHARMACIST(ctx.userA));
  const all = await programs.addActivity(ctx.a.id, p, saved.id, activityInput({ title: 'Tomorrow', dueOn: '2026-09-25' }), PHARMACIST(ctx.userA));

  assert.deepEqual(all.progress.goals, { total: 2, achieved: 1, notAchieved: 0, open: 1 });
  assert.deepEqual(all.progress.activities, { total: 3, completed: 0, open: 3, overdue: 1, dropped: 0 });
  assert.equal(all.progress.nextDue.title, 'Yesterday');

  const list = await programs.listPrograms(ctx.a.id, p, { today: TODAY });
  assert.equal(list.counts.overdueTasks, 1);
  // Nothing in this list carries a percentage or a score.
  assert.ok(!JSON.stringify(list).includes('percent'));
});

test('the list separates the open programmes from the ended ones, and counts what is due', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const open = await programs.enrolProgram(ctx.a.id, p, enrol({
    programName: 'Open one', nextReviewOn: '2026-09-20',
  }), PHARMACIST(ctx.userA));
  const paused = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Paused one' }), PHARMACIST(ctx.userA));
  await programs.updateProgram(ctx.a.id, p, paused.id,
    programPatch({ status: 'on_hold', statusReason: 'Travelling until December' }), PHARMACIST(ctx.userA));
  const ended = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Ended one' }), PHARMACIST(ctx.userA));
  await programs.updateProgram(ctx.a.id, p, ended.id,
    programPatch({ status: 'cancelled', statusReason: 'Enrolled the wrong patient' }), PHARMACIST(ctx.userA));

  const list = await programs.listPrograms(ctx.a.id, p, { today: TODAY });
  assert.deepEqual(list.active.map((x) => x.programName).sort(), ['Open one', 'Paused one']);
  assert.deepEqual(list.past.map((x) => x.programName), ['Ended one']);
  assert.equal(list.counts.active, 2);
  assert.equal(list.counts.past, 1);
  // A review date that has passed is a thing somebody has to look at.
  assert.equal(list.counts.dueForReview, 1);
  assert.equal(list.active.find((x) => x.id === open.id).nextReviewOn, '2026-09-20');
});

// ---- the audit trail ------------------------------------------------------

test('every change to a programme is on the patient\'s record, with before and after', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const def = await definition(ctx.a.id, 'CHRONIC_MONITORING');
  const { plan } = await programs.planForDefinition(ctx.a.id, def.id, { today: TODAY });
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({
    reason: 'Sickle cell disease, wants regular checks',
  }, { definition: def }), { plan, ...PHARMACIST(ctx.userA) });

  const [enrolled] = await events(p, 'CARE_PROGRAM_ENROLLED');
  assert.equal(enrolled.actor_type, 'pharmacist');
  assert.equal(enrolled.actor_id, ctx.userA);
  assert.equal(enrolled.visibility, 'internal');
  assert.equal(enrolled.entity_type, 'patient_care_program');
  assert.equal(enrolled.entity_id, saved.id);
  assert.equal(enrolled.metadata.program, 'Chronic disease monitoring');
  assert.equal(enrolled.metadata.fromTemplate, true);
  assert.equal(enrolled.metadata.goals, plan.goals.length);
  assert.equal(enrolled.metadata.activities, plan.activities.length);

  await programs.updateProgram(ctx.a.id, p, saved.id,
    programPatch({ notes: 'Comes with her mother.' }), PHARMACIST(ctx.userA));
  const [updated] = await events(p, 'CARE_PROGRAM_UPDATED');
  assert.deepEqual(updated.metadata.changes.notes, { from: null, to: 'Comes with her mother.' });

  // A goal and a task each say what changed, against the PROGRAMME — which
  // outlives them, so removing one does not orphan its history.
  const withGoal = await programs.addGoal(ctx.a.id, p, saved.id, goalInput({ title: 'Seen every three months' }), PHARMACIST(ctx.userA));
  const goalEvents = await events(p, 'CARE_PROGRAM_GOAL_CHANGED');
  assert.equal(goalEvents.at(-1).metadata.action, 'added');
  assert.equal(goalEvents.at(-1).entity_id, saved.id);
  await programs.removeGoal(ctx.a.id, p, saved.id, withGoal.goals.at(-1).id, PHARMACIST(ctx.userA));
  assert.equal((await events(p, 'CARE_PROGRAM_GOAL_CHANGED')).at(-1).metadata.action, 'removed');

  // Ending it has its own name, because "completed" and "stopped" are read
  // differently by whoever opens this record next.
  await programs.updateProgram(ctx.a.id, p, saved.id, programPatch({
    status: 'completed', outcome: 'achieved', outcomeNotes: 'Stable for a year.',
  }), PHARMACIST(ctx.userA));
  const [completed] = await events(p, 'CARE_PROGRAM_COMPLETED');
  assert.equal(completed.metadata.outcome, 'achieved');
  assert.deepEqual(completed.metadata.changes.status, { from: 'active', to: 'completed' });
  assert.equal((await events(p, 'CARE_PROGRAM_STATUS_CHANGED')).length, 0);

  await programs.updateProgram(ctx.a.id, p, saved.id, programPatch({ status: 'active' }), PHARMACIST(ctx.userA));
  const [reopened] = await events(p, 'CARE_PROGRAM_STATUS_CHANGED');
  assert.deepEqual(reopened.metadata.changes.status, { from: 'completed', to: 'active' });
});

test('completing a repeating task records the next date it created', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Audited repeats' }), PHARMACIST(ctx.userA));
  const withTask = await programs.addActivity(ctx.a.id, p, saved.id, activityInput({
    title: 'Weigh-in', kind: 'monitoring', dueOn: '2026-09-10', recurrence: { every: 2, unit: 'week' },
  }), PHARMACIST(ctx.userA));
  await programs.updateActivity(ctx.a.id, p, saved.id, withTask.activities[0].id,
    activityPatch({ status: 'completed' }), PHARMACIST(ctx.userA));

  const trail = await events(p, 'CARE_PROGRAM_ACTIVITY_CHANGED');
  const completed = trail.find((e) => e.metadata.action === 'completed');
  assert.equal(completed.metadata.activity, 'Weigh-in');
  assert.equal(completed.metadata.nextDue, '2026-09-24');
  assert.ok(completed.metadata.nextActivityId);
});

// ---- the connections: monitoring, related records, the timeline -----------

test('monitoring READS Vitals and Tests, and this record stores none of it', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await vitals(ctx.a.id, p, 162, 98, '2026-09-01');
  await vitals(ctx.a.id, p, 148, 92, '2026-09-20');
  await testResult(ctx.a.id, p, 'HBA1C', 'HbA1c', 8.1, '%', '2026-08-01');
  await testResult(ctx.a.id, p, 'HBA1C', 'HbA1c', 7.4, '%', '2026-09-15');

  const def = await definition(ctx.a.id, 'DIABETES_CARE');
  const { plan } = await programs.planForDefinition(ctx.a.id, def.id, { today: TODAY });
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({}, { definition: def }), { plan, ...PHARMACIST(ctx.userA) });

  const { metrics } = await programs.programMonitoring(ctx.a.id, p, saved.id);
  const byCode = Object.fromEntries(metrics.map((m) => [m.code, m]));

  // The values are the ones the OTHER sections hold — read, never copied.
  assert.equal(byCode.systolic.latest.value, 148);
  assert.equal(byCode.systolic.previous.value, 162);
  assert.equal(byCode.systolic.unit, 'mmHg');
  assert.equal(byCode.systolic.tab, 'vitals');
  assert.equal(byCode.HBA1C.latest.value, 7.4);
  assert.equal(byCode.HBA1C.previous.value, 8.1);
  assert.equal(byCode.HBA1C.unit, '%');
  assert.equal(byCode.HBA1C.tab, 'results');

  // A metric nobody has measured says so. NOT a zero, and not a blank that
  // reads as a normal result — the template watches weight, and nobody has
  // weighed this patient.
  assert.equal(byCode.weight.count, 0);
  assert.equal(byCode.weight.latest, null);

  // And the proof it is not stored: no table in this feature has a column that
  // could hold a clinical value.
  const cols = await db`
    select table_name, column_name from information_schema.columns
    where table_name in ('patient_care_programs', 'care_program_goals',
                         'patient_tasks', 'care_program_links')
  `;
  for (const c of cols) {
    assert.ok(
      !['systolic', 'diastolic', 'pulse', 'value', 'value_number', 'result', 'reading'].includes(c.column_name),
      `${c.table_name}.${c.column_name} would be a second copy of a clinical number`,
    );
  }

  // Changing the reading changes what the programme shows, immediately,
  // because there is only one of it.
  await vitals(ctx.a.id, p, 132, 84, '2026-09-23');
  const after = await programs.programMonitoring(ctx.a.id, p, saved.id);
  assert.equal(after.metrics.find((m) => m.code === 'systolic').latest.value, 132);
});

test('a programme typed by hand watches whatever its goals measure', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await vitals(ctx.a.id, p, 150, 95, '2026-09-10');
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Wound care' }), PHARMACIST(ctx.userA));
  // No template, so nothing is watched yet.
  assert.deepEqual((await programs.programMonitoring(ctx.a.id, p, saved.id)).metrics, []);

  await programs.addGoal(ctx.a.id, p, saved.id, goalInput({
    title: 'Blood pressure below 140/90',
    measure: 'Systolic BP', measureSource: 'vitals', measureCode: 'systolic', unit: 'mmHg',
  }), PHARMACIST(ctx.userA));

  const { metrics } = await programs.programMonitoring(ctx.a.id, p, saved.id);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].code, 'systolic');
  assert.equal(metrics[0].label, 'Systolic BP');
  assert.equal(metrics[0].latest.value, 150);
});

test('pharmacy B cannot read another pharmacy\'s monitoring, related records or timeline', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await vitals(ctx.a.id, p, 150, 95, '2026-09-10');
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Private' }), PHARMACIST(ctx.userA));

  for (const call of [
    () => programs.programMonitoring(ctx.b.id, p, saved.id),
    () => programs.programRelated(ctx.b.id, p, saved.id),
    () => programs.programTimeline(ctx.b.id, p, saved.id),
    () => programs.addLink(ctx.b.id, p, saved.id, { kind: 'vitals', refId: crypto.randomUUID(), note: null }, PHARMACIST(ctx.userB)),
  ]) {
    await assert.rejects(call, (e) => e.status === 404);
  }
});

test('related records are the ones attached by hand, plus the ones sharing the programme\'s code', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const [problem] = await db`
    insert into patient_problems (pharmacy_id, customer_id, condition_name, local_code, clinical_status, verification_status)
    values (${ctx.a.id}, ${p}, 'Hypertension', 'HYPERTENSION', 'active', 'confirmed') returning id
  `;
  // The medicine is found by its condition code, never by an id this test
  // holds, so there is nothing to keep hold of here.
  await db`
    insert into medication_journeys (pharmacy_id, customer_id, medicine_name, strength, condition_code, status, started_on)
    values (${ctx.a.id}, ${p}, 'Amlodipine', '10mg', 'HYPERTENSION', 'active', ${TODAY}) returning id
  `;
  const reading = await vitals(ctx.a.id, p, 150, 95, '2026-09-10');

  const def = await definition(ctx.a.id, 'HYPERTENSION_CARE');
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({}, { definition: def }), PHARMACIST(ctx.userA));

  const before = await programs.programRelated(ctx.a.id, p, saved.id);
  assert.deepEqual(before.conditions.map((c) => c.conditionName), ['Hypertension']);
  assert.deepEqual(before.medicines.map((m) => m.medicineName), ['Amlodipine']);
  assert.deepEqual(before.links, []);
  // Derived, never copied: the condition is not in this programme's own rows.
  const [{ count }] = await db`select count(*)::int as count from care_program_links where program_id = ${saved.id}`;
  assert.equal(count, 0);

  // Attaching a reading by hand: it appears as a link, written the way Vitals
  // writes it.
  const linked = await programs.addLink(ctx.a.id, p, saved.id,
    { kind: 'vitals', refId: reading, note: 'The reading that started this' }, PHARMACIST(ctx.userA));
  assert.equal(linked.links.length, 1);
  assert.equal(linked.links[0].kind, 'vitals');
  assert.equal(linked.links[0].note, 'The reading that started this');
  assert.match(linked.links[0].label, /Sep 2026/);
  assert.equal(linked.links[0].missing, false);

  // Attaching something the code already surfaces does not list it twice.
  const both = await programs.addLink(ctx.a.id, p, saved.id, { kind: 'condition', refId: problem.id, note: null }, PHARMACIST(ctx.userA));
  assert.equal(both.links.filter((l) => l.kind === 'condition').length, 1);
  assert.deepEqual(both.conditions, []);
  assert.deepEqual(both.medicines.map((m) => m.medicineName), ['Amlodipine']);

  // The same record twice is refused rather than duplicated.
  await assert.rejects(
    () => programs.addLink(ctx.a.id, p, saved.id, { kind: 'condition', refId: problem.id, note: null }, PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'ALREADY_LINKED',
  );

  // Detaching removes the LINK and nothing else: the condition is still on the
  // patient's record, and comes back as a derived one.
  const after = await programs.removeLink(ctx.a.id, p, saved.id,
    both.links.find((l) => l.kind === 'condition').id, PHARMACIST(ctx.userA));
  assert.equal(after.links.filter((l) => l.kind === 'condition').length, 0);
  assert.deepEqual(after.conditions.map((c) => c.conditionName), ['Hypertension']);
  const [stillThere] = await db`select id from patient_problems where id = ${problem.id}`;
  assert.ok(stillThere, 'detaching did not delete the condition');
});

test('only this patient\'s own records can be attached', { skip: SKIP && skipReason }, async () => {
  const mine = await patient(ctx.a.id);
  const other = await patient(ctx.a.id);
  const theirReading = await vitals(ctx.a.id, other, 120, 80, '2026-09-10');
  const saved = await programs.enrolProgram(ctx.a.id, mine, enrol({ programName: 'Attaching' }), PHARMACIST(ctx.userA));

  await assert.rejects(
    () => programs.addLink(ctx.a.id, mine, saved.id, { kind: 'vitals', refId: theirReading, note: null }, PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'linkedId',
  );
  await assert.rejects(
    () => programs.addLink(ctx.a.id, mine, saved.id, { kind: 'test', refId: crypto.randomUUID(), note: null }, PHARMACIST(ctx.userA)),
    (e) => e.status === 400 && e.field === 'linkedId',
  );
});

test('a record deleted from its own section leaves the link saying so', { skip: SKIP && skipReason }, async () => {
  // The alternative — dropping the row — would lose that it was ever attached,
  // which is the one thing the link was there to remember.
  const p = await patient(ctx.a.id);
  const reading = await vitals(ctx.a.id, p, 150, 95, '2026-09-10');
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Outliving' }), PHARMACIST(ctx.userA));
  await programs.addLink(ctx.a.id, p, saved.id, { kind: 'vitals', refId: reading, note: null }, PHARMACIST(ctx.userA));

  await db`delete from patient_vitals where id = ${reading}`;
  const related = await programs.programRelated(ctx.a.id, p, saved.id);
  assert.equal(related.links.length, 1);
  assert.equal(related.links[0].missing, true);
  assert.equal(related.links[0].label, 'No longer on the record');
});

test('the timeline is THIS programme\'s history, not the patient\'s', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const one = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Programme one' }), PHARMACIST(ctx.userA));
  const two = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Programme two' }), PHARMACIST(ctx.userA));
  await programs.updateProgram(ctx.a.id, p, one.id, programPatch({ notes: 'Only on one' }), PHARMACIST(ctx.userA));
  const withGoal = await programs.addGoal(ctx.a.id, p, one.id, goalInput({ title: 'A goal' }), PHARMACIST(ctx.userA));
  assert.ok(withGoal.goals.length === 1);

  const { events } = await programs.programTimeline(ctx.a.id, p, one.id);
  const types = events.map((e) => e.eventType);
  assert.deepEqual(types, ['CARE_PROGRAM_GOAL_CHANGED', 'CARE_PROGRAM_UPDATED', 'CARE_PROGRAM_ENROLLED']);
  // Newest first, and every one of them is about this programme.
  assert.equal(events[0].actor, `${TAG}-a-${ctx.userA}@example.test`);
  assert.equal(events.find((e) => e.eventType === 'CARE_PROGRAM_ENROLLED').metadata.program, 'Programme one');

  // The other programme's enrolment is NOT in it, though it is on the same
  // patient's record — that is the whole difference from the patient timeline.
  const other = await programs.programTimeline(ctx.a.id, p, two.id);
  assert.deepEqual(other.events.map((e) => e.metadata.program), ['Programme two']);
});

test('attaching and detaching are on the record, with what they pointed at', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const reading = await vitals(ctx.a.id, p, 150, 95, '2026-09-10');
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ programName: 'Audited links' }), PHARMACIST(ctx.userA));
  const linked = await programs.addLink(ctx.a.id, p, saved.id, { kind: 'vitals', refId: reading, note: null }, PHARMACIST(ctx.userA));
  await programs.removeLink(ctx.a.id, p, saved.id, linked.links[0].id, PHARMACIST(ctx.userA));

  const trail = (await programs.programTimeline(ctx.a.id, p, saved.id)).events
    .filter((e) => e.metadata.action);
  assert.deepEqual(trail.map((e) => e.metadata.action), ['unlinked', 'linked']);
  assert.equal(trail[0].metadata.kind, 'vitals');
  assert.equal(trail[0].metadata.refId, reading);
});

test('the summary other screens show agrees with the section itself', { skip: SKIP && skipReason }, async () => {
  // The patient summary card and the clinical-context brief read this. It is
  // the SAME read the Care program tab uses, trimmed — so the three cannot
  // disagree about what is open or what is late.
  const p = await patient(ctx.a.id);
  const def = await definition(ctx.a.id, 'HYPERTENSION_CARE');
  const { plan } = await programs.planForDefinition(ctx.a.id, def.id, { today: '2026-09-01' });
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({ startDate: '2026-09-01' }, { definition: def }),
    { plan, ...PHARMACIST(ctx.userA) });

  const summary = await programs.careProgramSummary(ctx.a.id, p, { today: TODAY });
  const full = await programs.listPrograms(ctx.a.id, p, { today: TODAY });

  assert.equal(summary.counts.active, 1);
  assert.equal(summary.active[0].programName, 'Hypertension management');
  assert.deepEqual(summary.active[0].progress, full.active[0].progress);
  // Tasks dated 1 September are past their day on the 24th, and both reads
  // say the same number.
  assert.ok(summary.counts.overdueTasks > 0);
  assert.equal(summary.counts.overdueTasks, full.counts.overdueTasks);

  // No percentage, no score — the shape simply has nowhere to put one.
  assert.ok(!JSON.stringify(summary).match(/percent|score/i));

  // Ended programmes are counted, never listed among the active ones.
  await programs.updateProgram(ctx.a.id, p, saved.id,
    programPatch({ status: 'completed', outcome: 'achieved' }), PHARMACIST(ctx.userA));
  const after = await programs.careProgramSummary(ctx.a.id, p, { today: TODAY });
  assert.deepEqual(after.active, []);
  assert.equal(after.counts.active, 0);
  assert.equal(after.pastCount, 1);
  assert.equal(after.counts.overdueTasks, 0, 'an ended programme has nothing outstanding');
});

test('the summary is capped, and another pharmacy\'s patient has none', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  for (const name of ['One', 'Two', 'Three', 'Four']) {
    await programs.enrolProgram(ctx.a.id, p, enrol({ programName: name }), PHARMACIST(ctx.userA));
  }
  const summary = await programs.careProgramSummary(ctx.a.id, p, { today: TODAY });
  // Four open, three shown: a context panel is a pointer, and the count is
  // the honest part.
  assert.equal(summary.counts.active, 4);
  assert.equal(summary.active.length, 3);

  const asB = await programs.careProgramSummary(ctx.b.id, p, { today: TODAY });
  assert.deepEqual(asB.active, []);
  assert.equal(asB.counts.active, 0);
});

test('an edit that changes nothing writes nothing', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await programs.enrolProgram(ctx.a.id, p, enrol({
    programName: 'Quiet', notes: 'Same note',
  }), PHARMACIST(ctx.userA));
  const before = await programs.getProgram(ctx.a.id, p, saved.id);

  const again = await programs.updateProgram(ctx.a.id, p, saved.id,
    programPatch({ notes: 'Same note' }), PHARMACIST(ctx.userA));
  assert.equal(again.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal((await events(p, 'CARE_PROGRAM_UPDATED')).length, 0);
});
