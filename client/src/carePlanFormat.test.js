/**
 * The words the care-programme screens put on a page about a person.
 *
 * Not cosmetic strings. "No goals set" and "none" are different claims, and
 * only the first is true in a product that has never asked. "67% complete"
 * beside a patient's name is a third claim, about the patient, that nothing in
 * this system is entitled to make.
 */

import { test, expect } from 'vitest';
import {
  PROGRAM_TONE, TASK_TONE, PROGRAM_SECTIONS, EMPTY_TEXT,
  isOpen, rangeLabel, progressParts, progressLine, nextUpLine, dueLabel, isOverdue,
  taskList, recurrenceLabel, targetLabel, currentLabel, outcomeLine, responsibleLine,
  programProblems, endingProblems, taskProblems, goalProblems,
  monitoringValue, monitoringChange, readingCount, timelineSentence, stampLabel, countsLine,
} from './carePlanFormat.js';

const TODAY = '2026-09-24';

const program = (over = {}) => ({
  id: 'p1',
  programName: 'Diabetes care',
  status: 'active',
  enrolledOn: '2026-06-10',
  startDate: '2026-06-10',
  nextReviewOn: '2026-12-01',
  endDate: null,
  outcome: null,
  responsible: null,
  goals: [],
  activities: [],
  progress: {
    goals: { total: 0, achieved: 0, notAchieved: 0, open: 0 },
    activities: { total: 0, completed: 0, open: 0, overdue: 0, dropped: 0 },
    nextDue: null,
  },
  ...over,
});

test('progress is counts, and no screen can print a percentage from it', () => {
  const p = program({
    progress: {
      goals: { total: 3, achieved: 1, notAchieved: 0, open: 2 },
      activities: { total: 12, completed: 8, open: 4, overdue: 2, dropped: 1 },
      nextDue: { id: 't1', title: 'Check blood pressure', dueOn: '2026-09-20' },
    },
  });
  expect(progressLine(p)).toBe('Goals 1/3 · Tasks 8/12 · 2 overdue');
  expect(progressLine(p)).not.toMatch(/%/);
  // The overdue count is the only part that carries a tone, and it is amber —
  // red is reserved for a person waiting (design.md).
  const parts = progressParts(p);
  expect(parts.find((x) => x.id === 'overdue').tone).toBe('ui-tone-3');
  expect(parts.filter((x) => x.tone).length).toBe(1);

  // Nothing planned: nothing counted, rather than "0%".
  expect(progressLine(program())).toBe(null);
});

test('an empty section says what it is, and never "none"', () => {
  for (const text of Object.values(EMPTY_TEXT)) {
    expect(text).not.toMatch(/^none$/i);
    expect(text.toLowerCase()).not.toBe('none');
  }
  expect(EMPTY_TEXT.goals).toBe('No goals set');
  expect(EMPTY_TEXT.tasks).toBe('Nothing outstanding');
});

test('a due date is written the way somebody would say it', () => {
  expect(dueLabel(TODAY, TODAY)).toBe('due today');
  expect(dueLabel('2026-09-25', TODAY)).toBe('due tomorrow');
  expect(dueLabel('2026-09-23', TODAY)).toBe('1 day overdue');
  expect(dueLabel('2026-09-17', TODAY)).toBe('7 days overdue');
  expect(dueLabel('2026-09-29', TODAY)).toBe('due in 5 days');
  // Far away: the date itself, which is easier to act on than "in 37 days".
  expect(dueLabel('2026-11-01', TODAY)).toBe('due 1 Nov 2026');
  expect(dueLabel(null, TODAY)).toBe(null);
});

test('a task is not overdue on the day it is due, and a finished one never is', () => {
  expect(isOverdue({ status: 'not_started', dueOn: TODAY }, TODAY)).toBe(false);
  expect(isOverdue({ status: 'not_started', dueOn: '2026-09-23' }, TODAY)).toBe(true);
  expect(isOverdue({ status: 'in_progress', dueOn: '2026-09-23' }, TODAY)).toBe(true);
  // Done, skipped or cancelled: not outstanding, so not late.
  expect(isOverdue({ status: 'completed', dueOn: '2026-01-01' }, TODAY)).toBe(false);
  expect(isOverdue({ status: 'skipped', dueOn: '2026-01-01' }, TODAY)).toBe(false);
  // A task with no date cannot be late.
  expect(isOverdue({ status: 'not_started', dueOn: null }, TODAY)).toBe(false);
});

test('the task list is what is still to do, overdue first, and holds no history', () => {
  const p = program({
    activities: [
      { id: 'a1', title: 'Later', status: 'not_started', dueOn: '2026-10-01', position: 0 },
      { id: 'a2', title: 'Done', status: 'completed', dueOn: '2026-09-01', position: 1 },
      { id: 'a3', title: 'Overdue', status: 'not_started', dueOn: '2026-09-20', position: 2 },
      { id: 'a4', title: 'Undated', status: 'in_progress', dueOn: null, position: 3 },
      { id: 'a5', title: 'Skipped', status: 'skipped', dueOn: '2026-09-02', position: 4 },
      { id: 'a6', title: 'Today', status: 'not_started', dueOn: TODAY, position: 5 },
    ],
  });
  expect(taskList(p, TODAY).map((a) => a.title)).toEqual(['Overdue', 'Today', 'Later', 'Undated']);
});

test('a repeat is described in words a pharmacist would use, or not at all', () => {
  expect(recurrenceLabel({ recurrence: { every: 1, unit: 'month' } })).toBe('every month');
  expect(recurrenceLabel({ recurrence: { every: 2, unit: 'week' } })).toBe('every 2 weeks');
  expect(recurrenceLabel({ recurrence: { every: 10, unit: 'day' } })).toBe('every 10 days');
  expect(recurrenceLabel({ recurrence: null })).toBe(null);
  expect(recurrenceLabel({})).toBe(null);
});

test('a goal with no target says so, rather than showing an empty column', () => {
  expect(targetLabel({ targetValue: 140, unit: 'mmHg' })).toBe('140 mmHg');
  expect(targetLabel({ targetValue: 7, unit: '%' })).toBe('7 %');
  expect(targetLabel({ targetText: 'No missed doses reported' })).toBe('No missed doses reported');
  expect(targetLabel({})).toBe('No target set');
});

test('a goal never says it is unmet because nobody measured', () => {
  const goal = { title: 'BP below 140', measureSource: 'vitals', measureCode: 'systolic', unit: 'mmHg' };
  // THE ONE THAT MATTERS: no reading is "not measured yet", never a zero and
  // never a claim about the goal.
  expect(currentLabel(goal, null)).toBe('Not measured yet');
  expect(currentLabel(goal, { value: null })).toBe('Not measured yet');
  expect(currentLabel(goal, { value: 0 })).toBe('0 mmHg');
  expect(currentLabel(goal, { value: 138, unit: 'mmHg', at: '2026-09-20' })).toBe('138 mmHg · 20 Sep 2026');
  // A goal that reads nothing has no current value to show at all.
  expect(currentLabel({ title: 'Takes medicines' }, null)).toBe(null);
});

test('how long a programme ran, and how it ended', () => {
  expect(rangeLabel(program())).toBe('Started 10 Jun 2026');
  expect(rangeLabel(program({ startDate: null }))).toBe('Started 10 Jun 2026');
  expect(rangeLabel(program({ status: 'completed', endDate: '2026-09-20' })))
    .toBe('10 Jun 2026 – 20 Sep 2026');

  const options = {
    outcomes: [{ value: 'partially_achieved', label: 'Partly achieved' }],
    discontinuationReasons: [{ value: 'lost_to_follow_up', label: 'Lost to follow-up' }],
  };
  expect(outcomeLine(program({ status: 'completed', outcome: 'partially_achieved' }), options))
    .toBe('Outcome: partly achieved');
  expect(outcomeLine(program({ status: 'discontinued', discontinuationReason: 'lost_to_follow_up' }), options))
    .toBe('Stopped: lost to follow-up');
  expect(outcomeLine(program({ status: 'cancelled' }), options)).toBe('Cancelled');
  expect(outcomeLine(program(), options)).toBe(null);
});

test('what the programme is waiting on, and "nothing due" says nothing about the patient', () => {
  const withTask = program({
    progress: {
      goals: { total: 0, achieved: 0, notAchieved: 0, open: 0 },
      activities: { total: 1, completed: 0, open: 1, overdue: 1, dropped: 0 },
      nextDue: { id: 't1', title: 'Check blood pressure', dueOn: '2026-09-20' },
    },
  });
  expect(nextUpLine(withTask, TODAY)).toBe('Check blood pressure — 4 days overdue');
  // No tasks: the review is the next thing.
  expect(nextUpLine(program({ nextReviewOn: '2026-09-25' }), TODAY)).toBe('Review — due tomorrow');
  // Neither: a fact about the plan, not about the person.
  expect(nextUpLine(program({ nextReviewOn: null }), TODAY)).toBe('Nothing due');

  expect(responsibleLine(program())).toBe('No pharmacist assigned');
  expect(responsibleLine(program({ responsible: { name: 'Pharm. Adaeze' } }))).toBe('Pharmacist: Pharm. Adaeze');
});

test('an open programme is the one being followed, and every status has a tone', () => {
  expect(isOpen(program({ status: 'planned' }))).toBe(true);
  expect(isOpen(program({ status: 'active' }))).toBe(true);
  expect(isOpen(program({ status: 'on_hold' }))).toBe(true);
  expect(isOpen(program({ status: 'completed' }))).toBe(false);
  expect(isOpen(program({ status: 'discontinued' }))).toBe(false);
  expect(isOpen(program({ status: 'cancelled' }))).toBe(false);

  for (const status of ['planned', 'active', 'on_hold', 'completed', 'discontinued', 'cancelled']) {
    expect(PROGRAM_TONE[status], `${status} has a tone`).toBeTruthy();
  }
  for (const status of ['not_started', 'in_progress', 'completed', 'skipped', 'cancelled']) {
    expect(TASK_TONE[status], `${status} has a tone`).toBeTruthy();
  }
  // No care-programme state is red: red means a person is waiting (design.md).
  const tones = [...Object.values(PROGRAM_TONE), ...Object.values(TASK_TONE)];
  expect(tones.some((t) => t.includes('critical') || t.includes('danger'))).toBe(false);
});

test('the six sections of a programme, in the order they are worked through', () => {
  // AMENDED 2026-09-24 with the product: phase 2 added Monitoring and Timeline.
  // Neither holds anything — Monitoring reads Vitals and Tests, Timeline reads
  // the events the programme has already written — so the rule this pins is
  // unchanged: the sections of a programme, and their order.
  expect(PROGRAM_SECTIONS.map((s) => s.id)).toEqual(['overview', 'goals', 'plan', 'tasks', 'monitoring', 'timeline']);
  expect(PROGRAM_SECTIONS.map((s) => s.label)).toEqual(['Overview', 'Goals', 'Care plan', 'Tasks', 'Monitoring', 'Timeline']);
});

// ---- monitoring ----------------------------------------------------------

test('a monitored value that nobody has measured says so, and never shows a zero', () => {
  const metric = { source: 'vitals', code: 'systolic', unit: 'mmHg', count: 0, latest: null, previous: null };
  expect(monitoringValue(metric)).toBe('Not measured');
  expect(monitoringValue(metric)).not.toMatch(/\b0\b/);
  expect(readingCount(metric)).toBe('no readings yet');

  const measured = {
    unit: 'mmHg', count: 2,
    latest: { at: '2026-09-20T09:00:00Z', value: 148 },
    previous: { at: '2026-09-01T09:00:00Z', value: 140 },
  };
  expect(monitoringValue(measured)).toBe('148 mmHg');
  expect(readingCount(measured)).toBe('2 readings');
  expect(readingCount({ count: 1 })).toBe('1 reading');

  // A real reading of zero is a reading, and is shown.
  expect(monitoringValue({ unit: 'mmHg', latest: { value: 0 } })).toBe('0 mmHg');
});

test('a change between readings is arithmetic, and never a verdict', () => {
  const up = {
    unit: 'mmHg',
    latest: { at: '2026-09-20T09:00:00Z', value: 148 },
    previous: { at: '2026-09-01T09:00:00Z', value: 140 },
  };
  expect(monitoringChange(up)).toBe('up 8 mmHg since 1 Sep 2026');

  const down = {
    unit: '%',
    latest: { at: '2026-09-15T09:00:00Z', value: 7.4 },
    previous: { at: '2026-08-01T09:00:00Z', value: 8.1 },
  };
  expect(monitoringChange(down)).toBe('down 0.7 % since 1 Aug 2026');
  // THE ONE THAT MATTERS: no word here judges the change. Whether a fall in
  // HbA1c is good depends on the person, the medicine and the target, and this
  // screen decides none of that.
  for (const text of [monitoringChange(up), monitoringChange(down)]) {
    expect(text).not.toMatch(/better|worse|improv|control|normal|high|low/i);
  }

  expect(monitoringChange({ latest: { value: 5 }, previous: { value: 5 }, unit: 'kg' })).toBe('unchanged');
  // One reading, or none: nothing to compare with, and nothing claimed.
  expect(monitoringChange({ latest: { value: 5 }, previous: null })).toBe(null);
  expect(monitoringChange(null)).toBe(null);
});

// ---- the timeline --------------------------------------------------------

const OPTIONS = {
  statuses: [{ value: 'active', label: 'Active' }, { value: 'on_hold', label: 'On hold' }],
  outcomes: [{ value: 'partially_achieved', label: 'Partly achieved' }],
  discontinuationReasons: [{ value: 'patient_withdrew', label: 'Patient withdrew' }],
  linkKinds: [{ value: 'vitals', label: 'Vitals reading' }],
};

test('each event on the timeline is a sentence built only from what was recorded', () => {
  const say = (eventType, metadata) => timelineSentence({ eventType, metadata }, OPTIONS);

  expect(say('CARE_PROGRAM_ENROLLED', { fromTemplate: true, goals: 2, activities: 5 }))
    .toEqual({ text: 'Enrolled', detail: 'from a template · 2 goals · 5 tasks' });
  expect(say('CARE_PROGRAM_ENROLLED', {})).toEqual({ text: 'Enrolled', detail: null });

  expect(say('CARE_PROGRAM_COMPLETED', { outcome: 'partially_achieved' }))
    .toEqual({ text: 'Completed', detail: 'Partly achieved' });
  expect(say('CARE_PROGRAM_DISCONTINUED', { changes: { discontinuationReason: { to: 'patient_withdrew' } } }).detail)
    .toBe('Patient withdrew');
  expect(say('CARE_PROGRAM_STATUS_CHANGED', { changes: { status: { from: 'active', to: 'on_hold' } }, reason: 'Travelling' }))
    .toEqual({ text: 'Active → On hold', detail: 'Travelling' });

  expect(say('CARE_PROGRAM_UPDATED', { action: 'linked', kind: 'vitals' }).text)
    .toBe('Attached a vitals reading');
  expect(say('CARE_PROGRAM_UPDATED', { action: 'unlinked', kind: 'vitals' }).text)
    .toBe('Detached a vitals reading');
  // An ordinary edit names the boxes that changed, in words, not column names.
  expect(say('CARE_PROGRAM_UPDATED', { changes: { nextReviewOn: {}, responsibleName: {} } }))
    .toEqual({ text: 'Edited', detail: 'review date, pharmacist' });

  expect(say('CARE_PROGRAM_GOAL_CHANGED', { action: 'removed', goal: 'BP below 140/90' }))
    .toEqual({ text: 'Removed a goal', detail: 'BP below 140/90' });
  expect(say('CARE_PROGRAM_ACTIVITY_CHANGED', { action: 'completed', activity: 'Check BP', nextDue: '2026-10-01' }))
    .toEqual({ text: 'Completed a task', detail: 'Check BP · next due 1 Oct 2026' });

  // An event this screen does not know is shown plainly rather than described
  // wrongly — a confident sentence about the wrong thing is the worse failure.
  expect(say('SOMETHING_NEW', { anything: true })).toEqual({ text: 'Recorded', detail: null });
});

test('a timeline stamp carries the time of day, which a due date does not', () => {
  expect(stampLabel('2026-09-22T14:05:00Z')).toMatch(/^22 Sep 2026, \d{2}:\d{2}$/);
  expect(stampLabel(null)).toBe(null);
  expect(stampLabel('not a date')).toBe(null);
});

test('the counts line other screens print is the same one, and carries no percentage', () => {
  // The summary card and the clinical-context brief both print this, so it
  // lives in one place: three screens cannot end up saying a programme's
  // progress three different ways.
  const p = program({
    progress: {
      goals: { total: 3, achieved: 1, notAchieved: 0, open: 2 },
      activities: { total: 12, completed: 8, open: 4, overdue: 2, dropped: 0 },
      nextDue: null,
    },
  });
  expect(countsLine(p)).toBe('Goals 1/3 · Tasks 8/12');
  // The overdue count is deliberately NOT in it: on another screen it is the
  // flag, toned on its own, rather than buried in a sentence.
  expect(countsLine(p)).not.toMatch(/overdue|%/);
  expect(countsLine(program())).toBe('Goals 0/0 · Tasks 0/0');
  expect(countsLine({})).toBe(null);
});

test('"not enrolled" and "no care programmes" say nothing about the patient', () => {
  expect(EMPTY_TEXT.notEnrolled).toBe('Not enrolled in any');
  expect(EMPTY_TEXT.noPrograms).toBe('No care programmes');
  // Neither is a clinical claim: enrolment is a fact this system holds
  // completely, unlike "no allergies", which it can only know if asked.
  for (const text of [EMPTY_TEXT.notEnrolled, EMPTY_TEXT.noPrograms]) {
    expect(text).not.toMatch(/healthy|well|fine|no problems/i);
  }
});

test('the connections say what is missing, and never "none"', () => {
  for (const key of ['monitoring', 'related', 'timeline']) {
    expect(EMPTY_TEXT[key].toLowerCase()).not.toBe('none');
    expect(EMPTY_TEXT[key]).not.toMatch(/^no records found$/i);
  }
  expect(EMPTY_TEXT.monitoring).toBe('Nothing is being monitored');
  expect(EMPTY_TEXT.related).toBe('No records attached yet');
});

test('the forms say what is missing before the server has to', () => {
  expect(programProblems({})).toEqual(['Say which programme this is.']);
  expect(programProblems({ programName: 'Diabetes care' })).toEqual([]);
  expect(programProblems({ programName: 'X', status: 'on_hold' }))
    .toEqual(['Say why the programme is on hold.']);

  expect(endingProblems({ status: 'completed' })).toEqual(['Say how the programme ended.']);
  expect(endingProblems({ status: 'completed', outcome: 'achieved' })).toEqual([]);
  expect(endingProblems({ status: 'discontinued' })).toEqual(['Say why the programme was stopped.']);
  expect(endingProblems({ status: 'cancelled' })).toEqual(['Say why the programme was cancelled.']);

  expect(taskProblems({})).toEqual(['Say what needs to be done.']);
  expect(taskProblems({ title: 'Check BP', repeats: true }))
    .toEqual(['A repeating task needs a first due date.']);
  expect(taskProblems({ title: 'Check BP', status: 'skipped' }))
    .toEqual(['Say why this was skipped.']);

  expect(goalProblems({})).toEqual(['Say what the goal is.']);
  expect(goalProblems({ title: 'X', measureSource: 'vitals' }))
    .toEqual(['Say which measurement the goal reads.']);
  expect(goalProblems({ title: 'X', measureCode: 'systolic' }))
    .toEqual(['Say where the measurement is read from.']);
});
