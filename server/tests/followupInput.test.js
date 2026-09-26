/**
 * The follow-up contract: what the queue will and will not hold.
 *
 * PURE — no database, no network, no model. These run everywhere, always.
 *
 * What they are defending:
 *   - A follow-up may have NO due date. "Review the HbA1c when the result
 *     comes back" is a real thing a pharmacist needs to remember, and refusing
 *     it would make them invent a date they do not have.
 *   - Due and Overdue are never stored, so nothing here accepts them as a
 *     status: a status somebody must remember to update will be wrong.
 *   - Completing says HOW IT WENT. A completed follow-up with no outcome is
 *     the row that makes the record worthless to whoever reads it next.
 *   - Cancelling says why, and only a pharmacist may do it.
 *   - The task vocabulary is SHARED with the care plan rather than copied,
 *     which is the whole point of 0062 putting both in one table.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FOLLOWUP_TYPES, FOLLOWUP_STATUSES, PRIORITIES, SOURCE_TYPES, OUTCOMES,
  CANCEL_REASONS, FOLLOWUP_FILTERS,
  readFollowupInput, readFollowupPatch, mergeForCheck,
  readCompletion, readReschedule, readCancellation,
  needsClinicalRole, hasClinicalRole, followupOptions,
} = require('../services/clinical/followupInput');
const { ACTIVITY_KINDS, ACTIVITY_STATUSES } = require('../services/clinical/careProgramInput');

const TODAY = '2026-09-24';
const make = (b = {}) => readFollowupInput(b);

// ---- creating one ---------------------------------------------------------

test('a follow-up says what needs to happen, and nothing else is required', () => {
  assert.throws(() => make({}), (e) => e.status === 400 && e.field === 'title');

  const f = make({ title: 'Repeat blood pressure' });
  assert.equal(f.title, 'Repeat blood pressure');
  assert.equal(f.status, 'not_started');
  assert.equal(f.priority, 'routine');
  assert.equal(f.kind, 'follow_up');
  // THE ONE THAT MATTERS: no due date is allowed. "Review the result when it
  // arrives" is a real follow-up nobody can date yet, and forcing a date would
  // put a made-up one in front of a pharmacist three weeks later.
  assert.equal(f.dueOn, null);
  assert.equal(f.outcome, null);
  assert.equal(f.sourceType, null);
});

test('every field a pharmacist fills in survives the contract', () => {
  const f = make({
    title: 'Repeat blood pressure',
    description: 'Sitting, after five minutes',
    kind: 'monitoring',
    priority: 'urgent',
    reason: 'BP was elevated during the consultation.',
    dueOn: '2026-10-08',
    dueTime: '10:30',
    assignedToName: 'Pharm. John',
    recurrence: { every: 2, unit: 'week' },
    sourceType: 'consultation',
    sourceId: '11111111-1111-4111-8111-111111111111',
    notes: 'Patient advised to return.',
  });
  assert.equal(f.kind, 'monitoring');
  assert.equal(f.priority, 'urgent');
  assert.equal(f.reason, 'BP was elevated during the consultation.');
  assert.equal(f.dueOn, '2026-10-08');
  assert.equal(f.dueTime, '10:30');
  assert.equal(f.assignedToName, 'Pharm. John');
  assert.deepEqual(f.recurrence, { every: 2, unit: 'week' });
  assert.equal(f.sourceType, 'consultation');
});

test('a date that is not a date, and a time with no day, are both refused', () => {
  assert.throws(() => make({ title: 'X', dueOn: 'next tuesday' }), (e) => e.field === 'dueOn');
  assert.throws(() => make({ title: 'X', dueOn: '2026-02-31' }), (e) => e.field === 'dueOn');
  assert.throws(() => make({ title: 'X', dueTime: '25:00', dueOn: TODAY }), (e) => e.field === 'dueTime');
  // A time with no day is not a due date.
  assert.throws(() => make({ title: 'X', dueTime: '10:30' }), (e) => e.field === 'dueOn');
  // A database round trip gives back '10:30:00'; it means the same thing.
  assert.equal(make({ title: 'X', dueOn: TODAY, dueTime: '10:30:00' }).dueTime, '10:30');
});

test('a repeating follow-up needs a first due date, or it never comes round', () => {
  assert.throws(
    () => make({ title: 'Check BP', recurrence: { every: 1, unit: 'month' } }),
    (e) => e.field === 'dueOn',
  );
  assert.throws(() => make({ title: 'X', dueOn: TODAY, recurrence: { every: 0, unit: 'day' } }),
    (e) => e.field === 'recurrence');
});

test('what raised it and what it produced are two different facts', () => {
  // An id with no kind points at nothing anybody can resolve.
  assert.throws(() => make({ title: 'X', sourceId: '11111111-1111-4111-8111-111111111111' }),
    (e) => e.field === 'sourceType');
  // A kind with no id is fine: "raised at a consultation" is true even when
  // nobody said which one.
  assert.equal(make({ title: 'X', sourceType: 'consultation' }).sourceType, 'consultation');
  assert.equal(make({ title: 'X', sourceType: 'manual' }).sourceId, null);

  // The link is the RESULT, and half of one is refused in both directions.
  assert.throws(() => make({ title: 'X', linkedType: 'vitals' }), (e) => e.field === 'linkedId');
  assert.throws(() => make({ title: 'X', linkedId: '11111111-1111-4111-8111-111111111111' }),
    (e) => e.field === 'linkedType');

  // Both at once: raised by the consultation, produced the reading.
  const both = make({
    title: 'Repeat BP',
    sourceType: 'consultation',
    sourceId: '11111111-1111-4111-8111-111111111111',
    linkedType: 'vitals',
    linkedId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(both.sourceType, 'consultation');
  assert.equal(both.linkedType, 'vitals');
  assert.notEqual(both.sourceId, both.linkedId);
});

test('an outcome belongs to a follow-up that was done, or deliberately not done', () => {
  assert.throws(() => make({ title: 'X', outcome: 'improved' }), (e) => e.field === 'outcome');
  assert.equal(make({ title: 'X', status: 'completed', outcome: 'improved' }).outcome, 'improved');
  assert.equal(make({ title: 'X', status: 'skipped', statusReason: 'Patient moved away', outcome: 'did_not_attend' }).outcome, 'did_not_attend');
});

test('skipping or cancelling says why, and a live follow-up carries no stale reason', () => {
  assert.throws(() => make({ title: 'X', status: 'skipped' }), (e) => e.field === 'statusReason');
  assert.throws(() => make({ title: 'X', status: 'cancelled' }), (e) => e.field === 'statusReason');
  assert.equal(make({ title: 'X', statusReason: 'stale' }).statusReason, null);
});

test('an empty patch is refused rather than written as a no-op', () => {
  assert.throws(() => readFollowupPatch({}), (e) => e.field === 'body');
  const patch = readFollowupPatch({ dueOn: '2026-10-01' });
  assert.deepEqual(patch, { dueOn: '2026-10-01' });
  // The merge runs the same rules as a create: a repeat still needs a date.
  assert.throws(
    () => mergeForCheck({ title: 'X', status: 'not_started', dueOn: null, recurrence: null },
      readFollowupPatch({ recurrence: { every: 1, unit: 'month' } })),
    (e) => e.field === 'dueOn',
  );
});

// ---- completing, moving, cancelling --------------------------------------

test('completing says how it went, and never lands in the future', () => {
  assert.throws(() => readCompletion({}, { today: TODAY }), (e) => e.field === 'outcome');

  const done = readCompletion({ outcome: 'improved', outcomeNote: 'BP 132/84' }, { today: TODAY });
  assert.equal(done.status, 'completed');
  assert.equal(done.outcome, 'improved');
  assert.equal(done.completedOn, TODAY);

  assert.throws(() => readCompletion({ outcome: 'completed', completedOn: '2026-12-01' }, { today: TODAY }),
    (e) => e.field === 'completedOn');

  // A patient who did not attend is still a follow-up somebody DID: they
  // tried, and wrote down what happened. It completes, with that outcome.
  const missed = readCompletion({ outcome: 'did_not_attend' }, { today: TODAY });
  assert.equal(missed.status, 'completed');
  assert.equal(missed.outcome, 'did_not_attend');

  // The result is a LINK to the record it produced, never a value.
  const withResult = readCompletion({
    outcome: 'stable', linkedType: 'vitals', linkedId: '22222222-2222-4222-8222-222222222222',
  }, { today: TODAY });
  assert.equal(withResult.linkedType, 'vitals');
  assert.ok(!('value' in withResult) && !('systolic' in withResult));
});

test('a completion records a reading OR points at one, never both', () => {
  // Both would be two answers to "what did this produce". The reading itself
  // is checked by the VITALS contract at the route — this only refuses the
  // ambiguity.
  assert.throws(
    () => readCompletion({
      outcome: 'stable',
      linkedType: 'vitals',
      linkedId: '22222222-2222-4222-8222-222222222222',
      reading: { systolic: 120, diastolic: 80 },
    }, { today: TODAY }),
    (e) => e.status === 400 && e.field === 'reading',
  );
  // Either on its own is fine, and neither is a value on the follow-up.
  assert.equal(readCompletion({ outcome: 'stable', reading: { systolic: 120 } }, { today: TODAY }).reading, null);
  assert.equal(readCompletion({
    outcome: 'stable', linkedType: 'vitals', linkedId: '22222222-2222-4222-8222-222222222222',
  }, { today: TODAY }).linkedType, 'vitals');
});

test('the measurements a completion may record are the Vitals screen\'s own', () => {
  // ONE definition of a measurement. If Vitals adds a sign, the completion
  // panel offers it; this list never grows on its own.
  const { VITALS } = require('../services/clinical/vitalRanges');
  const fields = followupOptions().vitalsFields;
  assert.deepEqual(fields.map((f) => f.key), VITALS.map((v) => v.key));
  assert.deepEqual(fields.map((f) => f.label), VITALS.map((v) => v.label));
  assert.deepEqual(fields.map((f) => f.unit), VITALS.map((v) => v.unit));
  // A unit travels with every one of them: a number with no unit is not a
  // reading anybody can act on.
  for (const f of fields) assert.ok(f.unit, `${f.key} has a unit`);
});

test('moving one needs a new date, and not one in the past', () => {
  assert.throws(() => readReschedule({}, { today: TODAY }), (e) => e.field === 'dueOn');
  assert.throws(() => readReschedule({ dueOn: '2026-09-01' }, { today: TODAY }), (e) => e.field === 'dueOn');
  const moved = readReschedule({ dueOn: '2026-10-08', reason: 'Patient travelling' }, { today: TODAY });
  assert.equal(moved.dueOn, '2026-10-08');
  assert.equal(moved.reason, 'Patient travelling');
});

test('cancelling takes a reason from the list, and writes it where a person will read it', () => {
  assert.throws(() => readCancellation({}), (e) => e.field === 'reason');
  assert.throws(() => readCancellation({ reason: 'because' }), (e) => e.field === 'reason');

  const plain = readCancellation({ reason: 'duplicate' });
  assert.equal(plain.reason, 'duplicate');
  assert.equal(plain.statusReason, 'Duplicate');

  const noted = readCancellation({ reason: 'transferred_care', note: 'Moved to Abuja' });
  assert.equal(noted.statusReason, 'Transferred care — Moved to Abuja');
  // The CODE travels separately, so "how many were cancelled as duplicates"
  // stays answerable from the audit trail.
  assert.equal(noted.reason, 'transferred_care');
});

test('only a pharmacist or owner may cancel planned care', () => {
  assert.equal(needsClinicalRole('cancelled'), true);
  for (const status of ['not_started', 'in_progress', 'completed', 'skipped']) {
    assert.equal(needsClinicalRole(status), false, `${status} is work, not a decision to stop`);
  }
  assert.equal(hasClinicalRole('pharmacist'), true);
  assert.equal(hasClinicalRole('owner'), true);
  assert.equal(hasClinicalRole('staff'), false);
});

// ---- the vocabulary ------------------------------------------------------

test('the task vocabulary is SHARED with the care plan, not copied', () => {
  // 0062 made a follow-up and a care-programme activity the same row. Two
  // copies of "what completed means" is the duplication the brief forbids —
  // these are the same frozen lists, not lookalikes.
  assert.equal(FOLLOWUP_TYPES, ACTIVITY_KINDS);
  assert.equal(FOLLOWUP_STATUSES, ACTIVITY_STATUSES);
});

test('the vocabulary the form offers is the one the database holds', () => {
  const o = followupOptions();
  assert.deepEqual(o.statuses.map((s) => s.value),
    ['not_started', 'in_progress', 'completed', 'skipped', 'cancelled']);
  // Due and Overdue are NOT statuses: both are derived from the due date.
  assert.ok(!o.statuses.some((s) => ['due', 'overdue'].includes(s.value)));
  assert.deepEqual(o.priorities.map((s) => s.value), ['routine', 'urgent']);
  assert.deepEqual(o.outcomes.map((s) => s.value), OUTCOMES.map((x) => x.value));
  assert.deepEqual(o.cancelReasons.map((s) => s.value), CANCEL_REASONS.map((x) => x.value));
  assert.deepEqual(o.filters.map((f) => f.value), ['', 'today', 'overdue', 'upcoming', 'completed', 'cancelled']);
  assert.deepEqual(o.sourceTypes.map((s) => s.value), SOURCE_TYPES.map((x) => x.value));

  // The brief's eleven types are all reachable, under one label each.
  assert.equal(o.types.length, 16);
  for (const wanted of ['clinical_review', 'medication_review', 'monitoring', 'test',
    'condition_monitoring', 'adherence', 'lifestyle', 'care_program_review',
    'appointment', 'referral', 'other']) {
    assert.ok(o.types.some((t) => t.value === wanted), `${wanted} is offered`);
  }
  const labels = o.types.map((t) => t.label);
  assert.equal(new Set(labels).size, labels.length, 'no two kinds share a label');

  for (const list of [o.types, o.statuses, o.priorities, o.outcomes, o.cancelReasons, o.sourceTypes]) {
    for (const item of list) {
      assert.ok(item.label && !item.label.includes('_'), `${item.value} has a readable label`);
    }
  }
  assert.deepEqual(PRIORITIES.map((p) => p.value), ['routine', 'urgent']);
  assert.deepEqual(FOLLOWUP_FILTERS.map((f) => f.count),
    ['all', 'today', 'overdue', 'upcoming', 'completed', 'cancelled']);
});
