/**
 * How a medication is written on screen.
 *
 * These strings are read as instructions about what a person is putting in
 * their body. The failures they defend against: a line padded with dashes
 * for every unknown, so blanks read as answers; "Ongoing" lost, so a chronic
 * medicine looks like it has no duration recorded; and a history shown as
 * one undifferentiated list, which answers "what changed and when" only for
 * someone who already knows the dates.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MED_TABS, HISTORY_FILTERS, MED_STATUS, MED_SOURCE,
  productLine, dosingLine, durationLabel, prescriberLabel, courseLabel,
  groupByMonth, medicationsSummary, frequencyLabel, routeLabel,
} from './medicationFormat.js';

const med = (over = {}) => ({
  id: '1', medicineName: 'Amlodipine', status: 'active', startedOn: '2026-09-15', source: 'prescribed', ...over,
});

test('the dosing line carries only what was recorded, never a dash for the rest', () => {
  // A pharmacist writing up what a patient says they take often knows the
  // name and one other thing. "1 tablet · — · — · —" reads as though the
  // blanks were answers.
  expect(dosingLine(med({ dose: '1 tablet', route: 'oral', frequency: 'twice_daily', durationDays: 30 })))
    .toBe('1 tablet · Oral · Twice daily · 30 days');
  expect(dosingLine(med({ dose: '1 tablet' }))).toBe('1 tablet · Ongoing');
  expect(dosingLine(med({ status: 'completed' }))).toBe(null);
});

test('no duration on a current medicine means ongoing, not missing', () => {
  expect(durationLabel(med())).toBe('Ongoing');
  expect(durationLabel(med({ durationDays: 1 }))).toBe('1 day');
  expect(durationLabel(med({ durationDays: 30 }))).toBe('30 days');
  // On a finished course "Ongoing" would be a contradiction, so it says
  // nothing rather than something wrong.
  expect(durationLabel(med({ status: 'completed' }))).toBe(null);
});

test('what the medicine IS sits under what it is called', () => {
  expect(productLine(med({ strength: '10 mg', form: 'tablet' }))).toBe('10 mg tablet');
  expect(productLine(med({ strength: '10 mg' }))).toBe('10 mg');
  expect(productLine(med())).toBe(null);
});

test('a course says "since" while it is running and a range once it has ended', () => {
  expect(courseLabel(med())).toMatch(/^since 15 Sept? 2026$/);
  expect(courseLabel(med({ status: 'stopped', endedOn: '2026-10-01' }))).toMatch(/^15 Sept? 2026 – 01 Oct 2026$/);
});

test('an outside prescriber shows their name, one of ours their email', () => {
  expect(prescriberLabel(med({ prescriber: { id: null, name: 'Dr John', email: null } }))).toBe('Dr John');
  expect(prescriberLabel(med({ prescriber: { id: 'x', name: null, email: 'ade@rx.test' } }))).toBe('ade@rx.test');
  expect(prescriberLabel(med())).toBe(null);
});

test('a prescription says nothing about its source; anything else says what it is', () => {
  // The distinction a community pharmacist needs is "this did NOT come from
  // a prescription". Labelling the common case too would be noise on every
  // row, which is how the uncommon case stops being noticed.
  expect(MED_SOURCE.prescribed).toBe(null);
  expect(MED_SOURCE.patient_reported).toBe('Patient reported');
  expect(MED_SOURCE.historical).toBe('Historical');
});

test('only "active" wears the brand green; everything else is history', () => {
  expect(MED_STATUS.active.tone).toBe('ui-med-active');
  for (const status of ['completed', 'stopped', 'cancelled']) {
    expect(MED_STATUS[status].tone, status).not.toBe('ui-med-active');
  }
  // A draft is not something the patient is taking.
  expect(MED_STATUS.draft.tone).toBe('ui-med-draft');
});

test('history is grouped by month, newest first', () => {
  const groups = groupByMonth([
    med({ id: 'a', startedOn: '2026-06-02' }),
    med({ id: 'b', startedOn: '2026-09-15' }),
    med({ id: 'c', startedOn: '2026-08-20' }),
    med({ id: 'd', startedOn: '2026-09-01' }),
  ]);
  expect(groups.map((g) => g.label)).toEqual([expect.stringMatching(/^Sept? 2026$/), 'Aug 2026', 'Jun 2026']);
  expect(groups[0].medications.map((m) => m.id)).toEqual(['b', 'd']);
});

test('a medicine with no start date cannot land in a month it does not have', () => {
  expect(groupByMonth([med({ startedOn: null })])).toEqual([]);
});

test('the empty states say what is empty, not just that something is', () => {
  expect(medicationsSummary({ current: 0, history: 0 }, 'current')).toBe('No current medication');
  expect(medicationsSummary({ current: 0, history: 0 }, 'history')).toBe('Nothing in the history');
  expect(medicationsSummary({ current: 1, history: 3 }, 'current')).toBe('1 medicine');
  expect(medicationsSummary({ current: 2, history: 3 }, 'history')).toBe('3 medicines');
});

test('the three sections, and the history filters the brief asked for', () => {
  expect(MED_TABS.map((t) => t.id)).toEqual(['current', 'history', 'review']);
  expect(HISTORY_FILTERS.map((f) => f.label))
    .toEqual(['All', 'Active', 'Completed', 'Stopped', 'Cancelled', 'Draft']);
});

test('every value the dashboard can write is one the server accepts', () => {
  // The labels are the dashboard's; the vocabulary is the server's. If a key
  // drifts, a frequency renders blank for ever and nothing fails.
  const server = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'services', 'clinical', 'medicationInput.js'),
    'utf8',
  );
  for (const key of ['once_daily', 'twice_daily', 'every_8_hours', 'as_needed']) {
    expect(frequencyLabel(key), key).toBeTruthy();
    expect(server).toContain(`value: '${key}'`);
  }
  for (const key of ['oral', 'topical', 'im', 'iv', 'inhaled']) {
    expect(routeLabel(key), key).toBeTruthy();
    expect(server).toContain(`value: '${key}'`);
  }
  for (const status of Object.keys(MED_STATUS)) {
    expect(server, `the server knows the status "${status}"`).toContain(`value: '${status}'`);
  }
  for (const source of Object.keys(MED_SOURCE)) {
    expect(server, `the server knows the source "${source}"`).toContain(`value: '${source}'`);
  }
});
