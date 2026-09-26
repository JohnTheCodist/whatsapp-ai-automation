/**
 * The care-programme contract: what the record will and will not hold.
 *
 * PURE — no database, no network, no model. These run everywhere, always.
 *
 * What they are defending:
 *   - A programme that ended says HOW it ended. A completed programme with no
 *     outcome, or a discontinued one with no reason, is the row that makes a
 *     care record worthless six months later when somebody asks what happened.
 *   - Only a pharmacist closes a course of care. Anyone may enrol, plan and
 *     tick off a task.
 *   - Enrolling in a template takes the template's word for what it is, never
 *     the client's.
 *   - A goal that says it reads a number says where from, and the place is one
 *     that exists — a goal pointed at "systolicc" would show nothing, forever,
 *     silently.
 *   - A repeat produces EXACTLY ONE next occurrence, on the same day of the
 *     month, anchored to the day it was DUE rather than the day it was done.
 *   - Progress is counts. There is no percentage, because a percentage over
 *     tasks printed beside a patient's name reads as a claim about the patient.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  readProgramInput, readProgramPatch, mergeProgramForCheck,
  readGoalInput, mergeGoalForCheck, readActivityInput, readActivityPatch,
  readRecurrence, readLinkInput, monitoringSpec, nextDue, addMonths, nextOccurrence,
  progressFrom, planFromDefinition, careProgramOptions,
  needsClinicalRole, hasClinicalRole,
} = require('../services/clinical/careProgramInput');

const TODAY = '2026-09-24';
const enrol = (b = {}, opts = {}) => readProgramInput(b, { today: TODAY, ...opts });
const goal = (b = {}) => readGoalInput(b, { today: TODAY });

// ---- the programme --------------------------------------------------------

test('enrolling needs a name, and defaults to active from today', () => {
  assert.throws(() => enrol({}), (e) => e.status === 400 && e.field === 'programName');

  const p = enrol({ programName: 'Diabetes care' });
  assert.equal(p.status, 'active');
  assert.equal(p.enrolledOn, TODAY);
  assert.equal(p.startDate, TODAY);
  assert.equal(p.endDate, null);
  assert.equal(p.outcome, null);
});

test('a template is trusted about what it is; the client is not', () => {
  // The definition has been read from the database by the service. A caller
  // claiming a different code, name or condition does not get to store one.
  const definition = {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'DIABETES_CARE',
    name: 'Diabetes care',
    conditionCode: 'DIABETES',
    defaultReviewDays: 90,
  };
  const p = enrol({
    programCode: 'FREE_MONEY',
    conditionCode: 'HYPERTENSION',
    definitionId: '99999999-9999-4999-8999-999999999999',
  }, { definition });

  assert.equal(p.programName, 'Diabetes care');
  assert.equal(p.programCode, 'DIABETES_CARE');
  assert.equal(p.conditionCode, 'DIABETES');
  assert.equal(p.definitionId, definition.id);
  // The review date comes from the template, counted from the start day.
  assert.equal(p.nextReviewOn, '2026-12-23');
});

test('a programme that ended says how it ended', () => {
  assert.throws(
    () => enrol({ programName: 'Diabetes care', status: 'completed' }),
    (e) => e.field === 'outcome',
  );
  assert.throws(
    () => enrol({ programName: 'Diabetes care', status: 'completed', outcome: 'achieved' }),
    (e) => e.field === 'endDate',
  );
  assert.throws(
    () => enrol({ programName: 'X', status: 'discontinued', endDate: TODAY }),
    (e) => e.field === 'discontinuationReason',
  );
  assert.throws(
    () => enrol({ programName: 'X', status: 'cancelled', endDate: TODAY }),
    (e) => e.field === 'statusReason',
  );
  // Paused is a state somebody has to be able to explain, too.
  assert.throws(
    () => enrol({ programName: 'X', status: 'on_hold' }),
    (e) => e.field === 'statusReason',
  );

  const done = enrol({
    programName: 'Weight management', status: 'completed', outcome: 'partially_achieved', endDate: TODAY,
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.endDate, TODAY);
});

test('pressing Complete ends the programme today, and reopening it clears the ending', () => {
  const before = {
    programName: 'Diabetes care', status: 'active', startDate: '2026-06-01', endDate: null,
    outcome: null, discontinuationReason: null, statusReason: null,
  };
  // No end date supplied: the pharmacist pressing the button has said when.
  const closed = mergeProgramForCheck(before, readProgramPatch({ status: 'completed', outcome: 'achieved' }), { today: TODAY });
  assert.equal(closed.endDate, TODAY);

  // Reopening drops the outcome and the discontinuation reason, which no
  // longer describe anything. The audit trail keeps what they said.
  const ended = { ...before, status: 'discontinued', endDate: TODAY, discontinuationReason: 'patient_withdrew' };
  const reopened = mergeProgramForCheck(ended, readProgramPatch({ status: 'active' }), { today: TODAY });
  assert.equal(reopened.endDate, null);
  assert.equal(reopened.discontinuationReason, null);
});

test('a programme cannot have ended before it started', () => {
  assert.throws(() => enrol({
    programName: 'X', status: 'completed', outcome: 'achieved',
    startDate: '2026-09-01', endDate: '2026-08-01',
  }), (e) => e.field === 'endDate');
});

test('only a pharmacist or owner may close a course of care', () => {
  // The three that end a programme.
  for (const status of ['completed', 'discontinued', 'cancelled']) {
    assert.equal(needsClinicalRole({ status }), true, `${status} needs a pharmacist`);
  }
  // Everything else — enrolling, pausing, planning — does not.
  for (const status of ['planned', 'active', 'on_hold']) {
    assert.equal(needsClinicalRole({ status }), false, `${status} does not`);
  }
  // Already there: an edit that leaves the status alone is not a closing act.
  assert.equal(needsClinicalRole({ status: 'completed' }, { status: 'completed' }), false);

  assert.equal(hasClinicalRole('pharmacist'), true);
  assert.equal(hasClinicalRole('owner'), true);
  assert.equal(hasClinicalRole('staff'), false);
  assert.equal(hasClinicalRole(null), false);
});

test('an empty patch is refused rather than written as a no-op', () => {
  assert.throws(() => readProgramPatch({}), (e) => e.field === 'body');
  assert.throws(() => readActivityPatch({}), (e) => e.field === 'body');
});

// ---- goals ---------------------------------------------------------------

test('a goal that reads a number says where from, and the place has to exist', () => {
  const g = goal({
    title: 'Blood pressure below 140/90',
    measure: 'Systolic BP',
    measureSource: 'vitals',
    measureCode: 'systolic',
    unit: 'mmHg',
    targetValue: 140,
  });
  assert.equal(g.measureSource, 'vitals');
  assert.equal(g.measureCode, 'systolic');

  // A typo in the metric would show nothing forever, without ever erroring.
  assert.throws(() => goal({ title: 'X', measureSource: 'vitals', measureCode: 'systolicc' }),
    (e) => e.field === 'measureCode');
  // Half a measure reads from nowhere.
  assert.throws(() => goal({ title: 'X', measureSource: 'vitals' }), (e) => e.field === 'measureCode');
  assert.throws(() => goal({ title: 'X', measureCode: 'systolic' }), (e) => e.field === 'measureCode');

  // BMI is derived in the vitals read, so a goal may name it.
  assert.equal(goal({ title: 'BMI below 25', measureSource: 'vitals', measureCode: 'bmi' }).measureCode, 'bmi');
});

test('a goal may be judged rather than measured, and still be a goal', () => {
  const g = goal({ title: 'Takes medicines as prescribed', targetText: 'No missed doses reported at review' });
  assert.equal(g.measureSource, null);
  assert.equal(g.targetValue, null);
  assert.equal(g.targetText, 'No missed doses reported at review');
});

test('a settled goal says when it settled, and an unsettled one carries no date', () => {
  assert.equal(goal({ title: 'X', status: 'achieved' }).achievedOn, TODAY);
  assert.equal(goal({ title: 'X', status: 'not_achieved', achievedOn: '2026-09-01' }).achievedOn, '2026-09-01');
  // Moving a goal back to in progress drops a date that would now be a lie.
  assert.equal(goal({ title: 'X', status: 'in_progress', achievedOn: '2026-09-01' }).achievedOn, null);

  const settled = mergeGoalForCheck({ status: 'planned', achievedOn: null }, { status: 'achieved' }, { today: TODAY });
  assert.equal(settled.achievedOn, TODAY);
});

// ---- activities — the care plan and the task list ------------------------

test('a task needs a title, and skipping or cancelling one says why', () => {
  assert.throws(() => readActivityInput({}), (e) => e.field === 'title');
  assert.throws(() => readActivityInput({ title: 'Check BP', status: 'skipped' }), (e) => e.field === 'statusReason');
  assert.throws(() => readActivityInput({ title: 'Check BP', status: 'cancelled' }), (e) => e.field === 'statusReason');

  const skipped = readActivityInput({ title: 'Check BP', status: 'skipped', statusReason: 'Patient did not attend' });
  assert.equal(skipped.statusReason, 'Patient did not attend');
  // A task back in play carries no leftover reason.
  assert.equal(readActivityInput({ title: 'Check BP', statusReason: 'stale' }).statusReason, null);
});

test('a repeating task needs a first due date, or it never comes round', () => {
  assert.throws(
    () => readActivityInput({ title: 'Check BP', recurrence: { every: 1, unit: 'month' } }),
    (e) => e.field === 'dueOn',
  );
  const a = readActivityInput({ title: 'Check BP', dueOn: '2026-10-01', recurrence: { every: 1, unit: 'month' } });
  assert.deepEqual(a.recurrence, { every: 1, unit: 'month' });
});

test('a repeat is a whole number of days, weeks or months', () => {
  assert.equal(readRecurrence(null), null);
  assert.deepEqual(readRecurrence({ every: 2, unit: 'week' }), { every: 2, unit: 'week' });
  assert.throws(() => readRecurrence({ every: 1, unit: 'fortnight' }), (e) => e.field === 'recurrence');
  assert.throws(() => readRecurrence({ every: 0, unit: 'day' }), (e) => e.field === 'recurrence');
  assert.throws(() => readRecurrence({ every: 1.5, unit: 'month' }), (e) => e.field === 'recurrence');
  assert.throws(() => readRecurrence({ every: 99, unit: 'month' }), (e) => e.field === 'recurrence');
  assert.throws(() => readRecurrence({ unit: 'month' }), (e) => e.field === 'recurrence');
  assert.throws(() => readRecurrence({ every: 1 }), (e) => e.field === 'recurrence');
});

test('half a link points at nothing, which looks like a record that exists', () => {
  assert.throws(() => readActivityInput({ title: 'X', linkedType: 'test' }), (e) => e.field === 'linkedId');
  assert.throws(
    () => readActivityInput({ title: 'X', linkedId: '11111111-1111-4111-8111-111111111111' }),
    (e) => e.field === 'linkedType',
  );
  const a = readActivityInput({ title: 'X', linkedType: 'test', linkedId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(a.linkedType, 'test');
});

test('a monthly repeat keeps its day of the month, and clamps where the month is short', () => {
  assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
  // 31 January plus a month is the end of February, not the 3rd of March.
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(nextDue('2026-10-01', { every: 3, unit: 'month' }), '2027-01-01');
  assert.equal(nextDue('2026-10-01', { every: 2, unit: 'week' }), '2026-10-15');
  assert.equal(nextDue('2026-10-01', { every: 10, unit: 'day' }), '2026-10-11');
  assert.equal(nextDue(null, { every: 1, unit: 'day' }), null);
  assert.equal(nextDue('2026-10-01', null), null);
});

test('the next occurrence is anchored to the day it was DUE, not the day it was done', () => {
  // A monthly BP check due on the 1st, ticked off on the 10th, is next due on
  // the 1st — otherwise a task done late pushes the whole schedule later, and
  // a year of small delays becomes a missed quarter.
  const next = nextOccurrence({
    id: 'a1', title: 'Check blood pressure', kind: 'monitoring', dueOn: '2026-09-01',
    recurrence: { every: 1, unit: 'month' }, assignedToName: 'Chidi', position: 2,
  }, { today: '2026-09-10' });
  assert.equal(next.dueOn, '2026-10-01');
  assert.equal(next.status, 'not_started');
  assert.equal(next.recurrenceOf, 'a1');
  assert.equal(next.title, 'Check blood pressure');
  assert.equal(next.assignedToName, 'Chidi');
  assert.deepEqual(next.recurrence, { every: 1, unit: 'month' });
  // The new one carries nothing from the old one's completion.
  assert.equal(next.linkedId, null);
  assert.equal(next.outcomeNote, null);

  // Done months late: it rolls forward to a date in the future rather than
  // arriving already overdue.
  const late = nextOccurrence({
    id: 'a2', title: 'Check BP', kind: 'monitoring', dueOn: '2026-01-15',
    recurrence: { every: 1, unit: 'month' },
  }, { today: '2026-09-24' });
  assert.equal(late.dueOn, '2026-10-15');

  // No repeat, or no due date: nothing follows.
  assert.equal(nextOccurrence({ id: 'a3', title: 'X', dueOn: '2026-09-01' }, { today: TODAY }), null);
  assert.equal(nextOccurrence({ id: 'a4', title: 'X', recurrence: { every: 1, unit: 'day' } }, { today: TODAY }), null);
});

// ---- progress ------------------------------------------------------------

test('progress is counts, and there is no percentage anywhere in it', () => {
  const goals = [
    { status: 'achieved' }, { status: 'in_progress' }, { status: 'planned' },
    { status: 'not_achieved' }, { status: 'cancelled' },
  ];
  const activities = [
    { id: 't1', title: 'Done', status: 'completed', dueOn: '2026-09-01' },
    { id: 't2', title: 'Overdue', status: 'not_started', dueOn: '2026-09-20' },
    { id: 't3', title: 'Later', status: 'not_started', dueOn: '2026-10-01' },
    { id: 't4', title: 'Started', status: 'in_progress', dueOn: null },
    // Skipped and cancelled are not outstanding work, and not work done.
    { id: 't5', title: 'Skipped', status: 'skipped', dueOn: '2026-09-02' },
    { id: 't6', title: 'Cancelled', status: 'cancelled', dueOn: '2026-09-03' },
  ];
  const p = progressFrom(goals, activities, { today: TODAY });

  assert.deepEqual(p.goals, { total: 5, achieved: 1, notAchieved: 1, open: 2 });
  assert.deepEqual(p.activities, { total: 4, completed: 1, open: 3, overdue: 1, dropped: 2 });
  // The next thing to do is the earliest dated one still open.
  assert.deepEqual(p.nextDue, { id: 't2', title: 'Overdue', dueOn: '2026-09-20' });

  const json = JSON.stringify(p);
  assert.ok(!json.includes('percent'), 'no percentage is reported');
  assert.ok(!json.includes('score'), 'no score is reported');

  // Nothing planned: zeros, and no next thing.
  assert.deepEqual(progressFrom([], [], { today: TODAY }).nextDue, null);
});

// ---- expanding a template ------------------------------------------------

test('a template becomes this patient\'s own rows, dated from the day it starts', () => {
  const definition = {
    goals: [{
      title: 'HbA1c below 7%', measure: 'HbA1c', source: 'test', code: 'HBA1C', unit: '%',
      targetValue: 7, targetDays: 90,
    }],
    activities: [
      { kind: 'monitoring', title: 'Check blood pressure', offsetDays: 0, recurrence: { every: 1, unit: 'month' } },
      { kind: 'review', title: 'Programme review', offsetDays: 90 },
    ],
  };
  const { goals, activities } = planFromDefinition(definition, { today: TODAY, startDate: '2026-10-01' });

  assert.equal(goals.length, 1);
  assert.equal(goals[0].measureSource, 'test');
  assert.equal(goals[0].measureCode, 'HBA1C');
  assert.equal(goals[0].targetDate, '2026-12-30');
  assert.equal(goals[0].status, 'planned');
  assert.equal(goals[0].position, 0);

  assert.equal(activities.length, 2);
  assert.equal(activities[0].dueOn, '2026-10-01');
  assert.deepEqual(activities[0].recurrence, { every: 1, unit: 'month' });
  assert.equal(activities[1].dueOn, '2026-12-30');
  assert.equal(activities[1].status, 'not_started');
  assert.equal(activities[1].position, 1);
});

test('a template row the record cannot hold fails at enrolment, not quietly', () => {
  // Every expanded row goes through the same contract a typed one does, so a
  // template that names a metric this product does not record is refused here
  // rather than stored as a goal that can never show a value.
  assert.throws(
    () => planFromDefinition({ goals: [{ title: 'X', source: 'vitals', code: 'bloodsugar' }], activities: [] }, { today: TODAY }),
    (e) => e.status === 400 && e.field === 'measureCode',
  );
  assert.throws(
    () => planFromDefinition({ goals: [], activities: [{ title: '' }] }, { today: TODAY }),
    (e) => e.field === 'title',
  );
  // A repeating template activity with no offset would have no first date.
  assert.throws(
    () => planFromDefinition({
      goals: [], activities: [{ title: 'Check BP', recurrence: { every: 1, unit: 'month' } }],
    }, { today: TODAY }),
    (e) => e.field === 'dueOn',
  );
});

// ---- the connections ------------------------------------------------------

test('attaching a record says what kind it is and which one, and nothing about it', () => {
  const link = readLinkInput({
    kind: 'condition',
    refId: '11111111-1111-4111-8111-111111111111',
    note: 'The programme is for this',
  });
  assert.deepEqual(link, {
    kind: 'condition',
    refId: '11111111-1111-4111-8111-111111111111',
    note: 'The programme is for this',
  });
  // Nothing the record SAYS is carried here — a label sent by the client would
  // be a copy of a clinical record, going stale from the moment it was stored.
  assert.equal(Object.keys(link).length, 3);

  assert.throws(() => readLinkInput({ refId: '11111111-1111-4111-8111-111111111111' }), (e) => e.field === 'kind');
  assert.throws(() => readLinkInput({ kind: 'condition' }), (e) => e.field === 'refId');
  assert.throws(() => readLinkInput({ kind: 'invoice', refId: '11111111-1111-4111-8111-111111111111' }),
    (e) => e.field === 'kind');
  assert.throws(() => readLinkInput({ kind: 'condition', refId: 'not-an-id' }), (e) => e.field === 'refId');
});

test('what a programme watches is its template plus any goal that measures something', () => {
  const definition = [
    { source: 'vitals', code: 'systolic', label: 'Systolic BP' },
    { source: 'test', code: 'HBA1C', label: 'HbA1c' },
  ];
  const goals = [
    // Already watched by the template: not listed twice.
    { measureSource: 'vitals', measureCode: 'systolic', measure: 'Systolic BP', unit: 'mmHg' },
    // New, and the reason this needs no column of its own: a goal that reads a
    // number IS a thing being monitored.
    { measureSource: 'vitals', measureCode: 'weight', measure: 'Weight', unit: 'kg' },
    // Reads nothing: not a metric.
    { title: 'Takes medicines as prescribed' },
  ];
  const spec = monitoringSpec(definition, goals);
  assert.deepEqual(spec.map((m) => `${m.source}:${m.code}`), ['vitals:systolic', 'test:HBA1C', 'vitals:weight']);
  assert.equal(spec[0].label, 'Systolic BP');
  assert.equal(spec[2].unit, 'kg');

  // A programme typed by hand has no template at all, and still gets a panel
  // as soon as somebody writes a goal that measures something.
  assert.deepEqual(monitoringSpec(null, goals).map((m) => m.code), ['systolic', 'weight']);
  assert.deepEqual(monitoringSpec([], []), []);
});

test('a metric this product cannot read is left out rather than shown empty forever', () => {
  // A row that can never show a value reads as a measurement nobody has taken,
  // which is a different claim from "this is not watched".
  const spec = monitoringSpec([
    { source: 'vitals', code: 'systolicc', label: 'Typo' },
    { source: 'test', code: 'lower case', label: 'Not a code' },
    { source: 'inventory', code: 'STOCK', label: 'Not a clinical source' },
    { source: 'vitals', label: 'No code at all' },
    { source: 'vitals', code: 'bmi', label: 'BMI' },
  ], []);
  assert.deepEqual(spec.map((m) => m.code), ['bmi']);
  // Junk in the list does not throw: a bad template row must not stop a
  // programme opening.
  assert.deepEqual(monitoringSpec(['nonsense', null, 42], []), []);
});

test('the vocabulary the form offers is the one the database holds', () => {
  const o = careProgramOptions();
  assert.deepEqual(o.statuses.map((s) => s.value),
    ['planned', 'active', 'on_hold', 'completed', 'discontinued', 'cancelled']);
  assert.deepEqual(o.outcomes.map((s) => s.value),
    ['achieved', 'partially_achieved', 'not_achieved', 'transferred', 'other']);
  assert.deepEqual(o.goalStatuses.map((s) => s.value),
    ['planned', 'in_progress', 'achieved', 'not_achieved', 'cancelled']);
  assert.deepEqual(o.activityStatuses.map((s) => s.value),
    ['not_started', 'in_progress', 'completed', 'skipped', 'cancelled']);
  assert.deepEqual(o.recurrenceUnits.map((s) => s.value), ['day', 'week', 'month']);
  assert.deepEqual(o.linkKinds.map((s) => s.value),
    ['condition', 'medication', 'test', 'vitals', 'encounter']);
  // Every label is a word a pharmacist would say, not a column name.
  for (const list of Object.values(o)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'object') continue;
      assert.ok(item.label && !item.label.includes('_'), `${item.value} has a readable label`);
    }
  }
});
