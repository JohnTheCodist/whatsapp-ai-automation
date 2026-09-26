/**
 * The words the Follow-up queue puts on a screen about a person.
 *
 * Not cosmetic strings. A follow-up with no date must not be written as though
 * it had one; a task past its day must say so in words as well as colour; and
 * nothing on this screen may read as a claim about the patient rather than
 * about the work.
 */

import { test, expect } from 'vitest';
import {
  BUCKETS, STATUS_TONE, BUCKET_TONE, EMPTY_TEXT,
  dueLabel, isOverdue, contextLine, sourceLine, resultLine, outcomeLine,
  movedLine, grouped, headline, formProblems, completionProblems, cancelProblems,
  lagosToday, dayLabel, stampLabel, timelineSentence, hasAnyReading,
  summaryParts, outstandingCount, emptyText,
} from './followupFormat.js';

const TODAY = '2026-09-24';

const OPTIONS = {
  types: [{ value: 'monitoring', label: 'Monitoring' }, { value: 'medication_review', label: 'Medication review' }],
  sourceTypes: [{ value: 'consultation', label: 'Consultation' }, { value: 'manual', label: 'Raised by hand' }],
  outcomes: [{ value: 'improved', label: 'Improved' }, { value: 'did_not_attend', label: 'Patient did not attend' }],
  linkKinds: [{ value: 'vitals', label: 'Vitals reading' }],
};

const followup = (over = {}) => ({
  id: 'f1',
  title: 'Repeat blood pressure',
  kind: 'monitoring',
  status: 'not_started',
  priority: 'routine',
  reason: 'Hypertension monitoring',
  dueOn: '2026-09-20',
  dueTime: null,
  assignedToName: 'Pharm. John',
  sourceType: 'consultation',
  source: { id: 'e1', label: 'Headache', at: '2026-09-06T09:00:00Z' },
  linkedType: null,
  linked: null,
  outcome: null,
  outcomeNote: null,
  rescheduledCount: 0,
  programName: null,
  bucket: 'overdue',
  ...over,
});

test('a due date is written the way somebody would say it — and no date says so', () => {
  expect(dueLabel(followup({ dueOn: TODAY }), TODAY)).toBe('Due today');
  expect(dueLabel(followup({ dueOn: '2026-09-25' }), TODAY)).toBe('Due tomorrow');
  expect(dueLabel(followup({ dueOn: '2026-09-23' }), TODAY)).toBe('1 day overdue');
  expect(dueLabel(followup({ dueOn: '2026-09-20' }), TODAY)).toBe('4 days overdue');
  expect(dueLabel(followup({ dueOn: '2026-09-29' }), TODAY)).toBe('Due in 5 days');
  expect(dueLabel(followup({ dueOn: '2026-11-01' }), TODAY)).toBe('Due 1 Nov 2026');
  // A time is shown where one was set, and never invented where it was not.
  expect(dueLabel(followup({ dueOn: TODAY, dueTime: '10:30' }), TODAY)).toBe('Due today at 10:30');

  // THE ONE THAT MATTERS: "review the result when it arrives" has no date, and
  // the screen says that rather than showing a date nobody chose.
  expect(dueLabel(followup({ dueOn: null }), TODAY)).toBe('No date yet');
  expect(dueLabel(followup({ dueOn: null }), TODAY)).not.toMatch(/overdue|today|tomorrow/i);
});

test('a finished follow-up is never described as late', () => {
  // Found on screen 2026-09-25: a COMPLETED follow-up whose due date had
  // passed read "1 day overdue", which says there is work outstanding when
  // there is none. It was due, and that day has gone.
  for (const status of ['completed', 'skipped', 'cancelled']) {
    const f = followup({ status, dueOn: '2026-09-20' });
    expect(dueLabel(f, TODAY)).toBe('Was due 20 Sep 2026');
    expect(dueLabel(f, TODAY)).not.toMatch(/overdue|due today|due tomorrow/i);
  }
  expect(dueLabel(followup({ status: 'completed', dueOn: null }), TODAY)).toBe('No date was set');
  // Still to do: unchanged.
  expect(dueLabel(followup({ status: 'not_started', dueOn: '2026-09-20' }), TODAY)).toBe('4 days overdue');
});

test('a follow-up is not overdue on the day it is due, and a finished one never is', () => {
  expect(isOverdue(followup({ dueOn: TODAY }), TODAY)).toBe(false);
  expect(isOverdue(followup({ dueOn: '2026-09-23' }), TODAY)).toBe(true);
  expect(isOverdue(followup({ dueOn: '2026-09-23', status: 'in_progress' }), TODAY)).toBe(true);
  expect(isOverdue(followup({ dueOn: '2026-01-01', status: 'completed' }), TODAY)).toBe(false);
  expect(isOverdue(followup({ dueOn: '2026-01-01', status: 'cancelled' }), TODAY)).toBe(false);
  // No date, no lateness.
  expect(isOverdue(followup({ dueOn: null }), TODAY)).toBe(false);
});

test('the row says what it is for, who has it, and where it came from', () => {
  expect(contextLine(followup(), OPTIONS))
    .toBe('Monitoring · Hypertension monitoring · Pharm. John · from Consultation — 6 Sep 2026');

  // Raised by hand: nothing pretends there was a source.
  expect(sourceLine(followup({ sourceType: 'manual', source: null }), OPTIONS)).toBe(null);
  expect(sourceLine(followup({ sourceType: null, source: null }), OPTIONS)).toBe(null);
  // Inside a care programme, the programme is how a pharmacist found it.
  expect(sourceLine(followup({ programName: 'Hypertension management' }), OPTIONS))
    .toBe('from Hypertension management');
});

test('what it produced is a pointer, and a deleted record says so rather than vanishing', () => {
  expect(resultLine(followup(), OPTIONS)).toBe(null);
  expect(resultLine(followup({
    linkedType: 'vitals', linked: { id: 'v1', label: '24 Sep 2026', detail: '132/84 mmHg' },
  }), OPTIONS)).toBe('Vitals reading · 24 Sep 2026 · 132/84 mmHg');
  // The record was deleted from Vitals: the link stays and says what happened.
  expect(resultLine(followup({ linkedType: 'vitals', linked: null }), OPTIONS))
    .toBe('Vitals reading — no longer on the record');
});

test('how it went is the pharmacist\'s words, and nothing is added to them', () => {
  expect(outcomeLine(followup(), OPTIONS)).toBe(null);
  expect(outcomeLine(followup({ outcome: 'improved' }), OPTIONS)).toBe('Improved');
  expect(outcomeLine(followup({ outcome: 'improved', outcomeNote: 'BP 132/84' }), OPTIONS))
    .toBe('Improved — BP 132/84');
  // "Did not attend" is an outcome a person recorded, not a judgement drawn
  // from an absence of data.
  expect(outcomeLine(followup({ outcome: 'did_not_attend' }), OPTIONS)).toBe('Patient did not attend');
});

test('a follow-up that keeps being put off says so', () => {
  expect(movedLine(followup())).toBe(null);
  expect(movedLine(followup({ rescheduledCount: 1 }))).toBe('Rescheduled once');
  expect(movedLine(followup({ rescheduledCount: 3 }))).toBe('Rescheduled 3 times');
});

test('the queue is grouped the way it is worked, and history is kept out of the way', () => {
  const list = [
    followup({ id: 'a', title: 'Late', bucket: 'overdue' }),
    followup({ id: 'b', title: 'Now', bucket: 'today' }),
    followup({ id: 'c', title: 'Soon', bucket: 'upcoming' }),
    followup({ id: 'd', title: 'Done', bucket: 'completed', status: 'completed' }),
    followup({ id: 'e', title: 'Stopped', bucket: 'cancelled', status: 'cancelled' }),
  ];
  const groups = grouped(list);
  expect(groups.map((g) => g.id)).toEqual(['overdue', 'today', 'upcoming', 'completed', 'cancelled']);
  expect(groups.map((g) => g.label)).toEqual(['Overdue', 'Due today', 'Upcoming', 'Completed', 'Cancelled']);
  // An empty group is not drawn at all.
  expect(grouped([followup({ bucket: 'today' })]).map((g) => g.id)).toEqual(['today']);
  expect(grouped([])).toEqual([]);
});

test('the headline counts the work and names the next thing, with no score', () => {
  const h = headline({ all: 6, overdue: 2, today: 1, upcoming: 3, completed: 4, cancelled: 0 },
    followup({ title: 'Repeat blood pressure', dueOn: '2026-09-20' }), TODAY);
  expect(h.line).toBe('2 overdue · 1 due today · 3 upcoming');
  expect(h.parts.find((p) => p.id === 'overdue').tone).toBe('ui-tone-3');
  expect(h.next).toEqual({ title: 'Repeat blood pressure', due: '4 days overdue' });
  expect(JSON.stringify(h)).not.toMatch(/%|percent|score/i);

  // Nothing outstanding is a fact about the queue; it says nothing about the
  // patient's health.
  const quiet = headline({ all: 2, overdue: 0, today: 0, upcoming: 0, completed: 2, cancelled: 0 }, null, TODAY);
  expect(quiet.line).toBe('Nothing outstanding');
  expect(quiet.next).toBe(null);
});

test('an empty queue says what it is, and never that the patient needs nothing', () => {
  expect(EMPTY_TEXT.none).toBe('No follow-ups');
  expect(EMPTY_TEXT.noneHelp).toBe('This patient currently has no follow-up actions.');
  expect(EMPTY_TEXT.noUpcoming).toBe('No upcoming follow-ups');
  for (const text of Object.values(EMPTY_TEXT)) {
    expect(text).not.toMatch(/nothing (is )?(needed|required)|patient is (well|fine|stable)/i);
  }
});

test('no follow-up state is red, and every one of them has a tone', () => {
  for (const status of ['not_started', 'in_progress', 'completed', 'skipped', 'cancelled']) {
    expect(STATUS_TONE[status], `${status} has a tone`).toBeTruthy();
  }
  for (const b of BUCKETS) {
    expect(BUCKET_TONE[b.id], `${b.id} has a tone`).toBeTruthy();
  }
  // Overdue is amber (ui-tone-3). Red means a person is waiting (design.md).
  expect(BUCKET_TONE.overdue).toBe('ui-tone-3');
  const tones = [...Object.values(STATUS_TONE), ...Object.values(BUCKET_TONE)];
  expect(tones.some((t) => t.includes('critical') || t.includes('danger'))).toBe(false);
});

test('the forms say what is missing before the server has to', () => {
  expect(formProblems({})).toEqual(['Say what needs to happen.']);
  expect(formProblems({ title: 'Repeat BP' })).toEqual([]);
  expect(formProblems({ title: 'Repeat BP', repeats: true }))
    .toEqual(['A repeating follow-up needs a first due date.']);
  expect(formProblems({ title: 'Repeat BP', dueTime: '10:30' }))
    .toEqual(['Say which day, as well as the time.']);

  expect(completionProblems({})).toEqual(['Say how the follow-up turned out.']);
  expect(completionProblems({ outcome: 'improved' })).toEqual([]);
  expect(completionProblems({ outcome: 'improved', linkedType: 'vitals' }))
    .toEqual(['Choose the record it produced, or clear the kind.']);

  expect(cancelProblems({})).toEqual(['Say why this follow-up is being cancelled.']);
  expect(cancelProblems({ reason: 'duplicate' })).toEqual([]);
});

// ---- this follow-up's history --------------------------------------------

const TL_OPTIONS = {
  types: [{ value: 'monitoring', label: 'Monitoring' }],
  sourceTypes: [{ value: 'consultation', label: 'Consultation' }],
  outcomes: [{ value: 'improved', label: 'Improved' }],
  cancelReasons: [{ value: 'duplicate', label: 'Duplicate' }],
  linkKinds: [{ value: 'vitals', label: 'Vitals reading' }],
};

test('each event on the history is a sentence built only from what was recorded', () => {
  const say = (eventType, metadata) => timelineSentence({ eventType, metadata }, TL_OPTIONS);

  expect(say('FOLLOWUP_CREATED', { kind: 'monitoring', priority: 'urgent', dueOn: '2026-10-08', source: 'consultation' }))
    .toEqual({ text: 'Created', detail: 'Monitoring · urgent · due 8 Oct 2026 · from consultation' });
  // A follow-up with no date says so here too, rather than showing nothing.
  expect(say('FOLLOWUP_CREATED', { kind: 'monitoring', source: 'manual' }).detail)
    .toBe('Monitoring · no date yet');

  expect(say('FOLLOWUP_RESCHEDULED', { from: '2026-09-25', to: '2026-10-08', reason: 'Patient travelling', times: 1 }))
    .toEqual({ text: 'Moved from 25 Sep 2026 to 8 Oct 2026', detail: 'Patient travelling' });
  expect(say('FOLLOWUP_RESCHEDULED', { from: null, to: '2026-10-08', times: 3 }).text)
    .toBe('Moved from no date to 8 Oct 2026');
  expect(say('FOLLOWUP_RESCHEDULED', { from: '2026-09-25', to: '2026-10-08', times: 3 }).detail)
    .toBe('moved 3 times');

  // A reading RECORDED at completion says so — it is a different act from
  // pointing at one that already existed.
  expect(say('FOLLOWUP_COMPLETED', { outcome: 'improved', note: 'BP 132/84', readingRecorded: true, result: { kind: 'vitals' } }))
    .toEqual({ text: 'Completed — Improved', detail: 'BP 132/84 · reading recorded in Vitals' });
  expect(say('FOLLOWUP_COMPLETED', { outcome: 'improved', result: { kind: 'vitals' } }).detail)
    .toBe('linked to a vitals reading');

  expect(say('FOLLOWUP_CANCELLED', { reason: 'duplicate', note: 'Already raised' }))
    .toEqual({ text: 'Cancelled — Duplicate', detail: 'Already raised' });
  expect(say('FOLLOWUP_REOPENED', { from: 'cancelled' }).text).toBe('Reopened');
  expect(say('FOLLOWUP_UPDATED', { changes: { dueOn: {}, assignedToName: {} } }))
    .toEqual({ text: 'Edited', detail: 'due date, who has it' });

  // An event this screen does not know is shown plainly rather than described
  // wrongly — a confident sentence about the wrong thing is the worse failure.
  expect(say('SOMETHING_NEW', { anything: true })).toEqual({ text: 'Recorded', detail: null });
});

test('a history stamp carries the time of day, which a due date does not', () => {
  expect(stampLabel('2026-09-22T14:05:00Z')).toMatch(/^22 Sep 2026, \d{2}:\d{2}$/);
  expect(stampLabel(null)).toBe(null);
  expect(stampLabel('not a date')).toBe(null);
});

test('a reading with nothing in it is a mis-click, not a reading of nothing', () => {
  expect(hasAnyReading({})).toBe(false);
  expect(hasAnyReading({ systolic: '', diastolic: '  ' })).toBe(false);
  expect(hasAnyReading(null)).toBe(false);
  expect(hasAnyReading({ systolic: '132' })).toBe(true);
  // A recorded zero is a value somebody typed, and the Vitals contract is
  // what decides whether it is plausible.
  expect(hasAnyReading({ pulse: 0 })).toBe(true);

  // The panel refuses the two ambiguities before the server has to.
  expect(completionProblems({ outcome: 'stable', recordReading: true, reading: {} }))
    .toEqual(['Enter at least one measurement, or turn off recording a reading.']);
  expect(completionProblems({
    outcome: 'stable', recordReading: true, reading: { systolic: '132' },
    linkedType: 'vitals', linkedId: 'v1',
  })).toEqual(['Record a reading, or point at one — not both.']);
  expect(completionProblems({ outcome: 'stable', recordReading: true, reading: { systolic: '132' } }))
    .toEqual([]);
});

// ---- what other screens show (§26) ---------------------------------------

test('the counts other screens print are one function, and count only what is waiting', () => {
  // The summary card and the clinical-context brief both print this, so it
  // lives in one place — three screens should not find three ways to say the
  // same thing.
  const counts = { all: 9, overdue: 2, today: 1, upcoming: 3, completed: 3, cancelled: 0 };
  expect(summaryParts(counts).map((p) => p.text)).toEqual(['2 overdue', '1 due today', '3 upcoming']);
  // The overdue part is the only one toned, and it is amber — red means a
  // person is waiting (design.md).
  expect(summaryParts(counts).find((p) => p.id === 'overdue').tone).toBe('ui-tone-3');
  expect(summaryParts(counts).filter((p) => p.tone).length).toBe(1);

  // OUTSTANDING is what is still to do — never the total, which includes
  // everything already finished.
  expect(outstandingCount(counts)).toBe(6);
  expect(outstandingCount({ all: 4, overdue: 0, today: 0, upcoming: 0, completed: 4 })).toBe(0);
  expect(outstandingCount(null)).toBe(0);
  expect(summaryParts(null)).toEqual([]);
});

test('"nothing outstanding" and "no follow-ups" are different facts, and neither is about the patient', () => {
  expect(EMPTY_TEXT.noneOutstanding).toBe('Nothing outstanding');
  expect(EMPTY_TEXT.noFollowups).toBe('No follow-ups');
  for (const text of [EMPTY_TEXT.noneOutstanding, EMPTY_TEXT.noFollowups]) {
    expect(text).not.toMatch(/healthy|well|fine|stable|no problems|nothing needed/i);
  }
});

// Found by opening the screen on 2026-09-25: the medication context brief
// told a pharmacist "Nothing outstanding" about a patient who had never had
// a single follow-up, while the summary card for the same patient said "No
// follow-ups". Two screens, two answers, one of them false. The choice is
// now one function and both ask it.
test('which empty sentence is true is decided ONCE, for every screen that says one', () => {
  const none = { all: 0, overdue: 0, today: 0, upcoming: 0, completed: 0, cancelled: 0 };
  const allDone = { all: 4, overdue: 0, today: 0, upcoming: 0, completed: 3, cancelled: 1 };
  const working = { all: 4, overdue: 1, today: 0, upcoming: 1, completed: 2, cancelled: 0 };

  // Never raised: saying "nothing outstanding" here claims work was done.
  expect(emptyText(none)).toBe(EMPTY_TEXT.noFollowups);
  // Raised and dealt with: saying "no follow-ups" here loses that it happened.
  expect(emptyText(allDone)).toBe(EMPTY_TEXT.noneOutstanding);
  // There is work to show, so no empty sentence at all.
  expect(emptyText(working)).toBe(null);
  // Not read. The caller says "Not recorded" its own way, because only the
  // caller knows whether it asked — this function must not guess for it.
  expect(emptyText(null)).toBe(null);

  // Cancelled still counts as having been raised: a follow-up that was
  // called off is history, not an empty record.
  expect(emptyText({ all: 1, overdue: 0, today: 0, upcoming: 0, cancelled: 1 }))
    .toBe(EMPTY_TEXT.noneOutstanding);
});

test('the Lagos day is the day the pharmacy is having', () => {
  // 23:30 UTC is already tomorrow in Lagos (UTC+1), and a task due "tomorrow"
  // must not read as overdue because the browser is on another clock.
  expect(lagosToday(new Date('2026-09-24T23:30:00Z'))).toBe('2026-09-25');
  expect(lagosToday(new Date('2026-09-24T09:00:00Z'))).toBe('2026-09-24');
  expect(dayLabel('2026-09-24T09:00:00Z')).toBe('24 Sep 2026');
  expect(dayLabel(null)).toBe(null);
});
