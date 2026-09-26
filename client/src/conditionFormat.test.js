/**
 * How a condition is written on screen.
 *
 * The failure these defend against above all: an uncertain condition that
 * reads as a diagnosis. After that — a refuted record surfacing under
 * "Active", a half-remembered onset shown as exact, and a hint that blocks
 * instead of informing.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUS_GROUP, CONDITION_FILTERS, matchesFilter, VERIFICATION_TONE, isCertain, displayName,
  partialDateLabel, partialDateInput, onsetLabel, historyStatus, encounterLabel, timeline,
  byLine, HINT_TEXT, formProblems,
} from './conditionFormat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const c = (over = {}) => ({
  id: 'c1', conditionName: 'Asthma', clinicalStatus: 'active', verificationStatus: 'confirmed', onset: { date: null, precision: null, note: null }, ...over,
});

test('an uncertain condition never reads like a confirmed one', () => {
  expect(displayName(c())).toBe('Asthma');
  expect(displayName(c({ verificationStatus: 'provisional' }))).toBe('Possible asthma');
  expect(displayName(c({ verificationStatus: 'differential' }))).toBe('? Asthma');
  // An acronym keeps its capitals.
  expect(displayName(c({ conditionName: 'COPD', verificationStatus: 'provisional' }))).toBe('Possible COPD');
  // And the chip is outlined, not filled, for every uncertain state.
  expect(VERIFICATION_TONE.confirmed).not.toBe(VERIFICATION_TONE.provisional);
  for (const v of ['provisional', 'unconfirmed', 'differential']) {
    expect(VERIFICATION_TONE[v]).toBe('ui-med-draft');
    expect(isCertain(c({ verificationStatus: v }))).toBe(false);
  }
  expect(isCertain(c())).toBe(true);
});

test('the six statuses group into the three the screen talks about', () => {
  expect(['active', 'recurrence', 'relapse'].map((s) => STATUS_GROUP[s])).toEqual(['active', 'active', 'active']);
  expect(STATUS_GROUP.inactive).toBe('inactive');
  expect([STATUS_GROUP.remission, STATUS_GROUP.resolved]).toEqual(['resolved', 'resolved']);
});

test('the filters are the brief\'s, and a refuted record answers only to "Refuted"', () => {
  expect(CONDITION_FILTERS.map((f) => f.label)).toEqual(['All', 'Active', 'Inactive', 'Resolved', 'Refuted']);
  const refuted = c({ verificationStatus: 'refuted', clinicalStatus: 'inactive' });
  expect(matchesFilter(refuted, 'refuted')).toBe(true);
  expect(matchesFilter(refuted, 'inactive')).toBe(false);
  expect(matchesFilter(c({ verificationStatus: 'entered_in_error', clinicalStatus: 'inactive' }), 'refuted')).toBe(true);
  expect(matchesFilter(c({ clinicalStatus: 'remission' }), 'resolved')).toBe(true);
  expect(matchesFilter(c({ clinicalStatus: 'relapse' }), 'active')).toBe(true);
  expect(matchesFilter(refuted, '')).toBe(true);
});

test('onset is shown at the precision given, or as the note when no date says it', () => {
  expect(partialDateLabel({ date: '2022-01-01', precision: 'year' })).toBe('~2022');
  expect(partialDateLabel({ date: '2026-08-01', precision: 'month' })).toBe('Aug 2026');
  expect(partialDateLabel({ date: '2026-08-15', precision: 'day' })).toBe('15 Aug 2026');
  expect(onsetLabel(c({ onset: { date: null, precision: null, note: 'Since childhood' } }))).toBe('Since childhood');
  expect(onsetLabel(c())).toBe(null);
  expect(partialDateInput({ date: '2026-08-01', precision: 'month' })).toBe('2026-08');
  expect(partialDateInput(null)).toBe('');
});

test('in the history, whether a record is true outranks its status', () => {
  const statuses = [{ value: 'resolved', label: 'Resolved' }, { value: 'remission', label: 'In remission' }];
  expect(historyStatus(c({ verificationStatus: 'refuted', clinicalStatus: 'inactive' }), statuses)).toBe('Refuted');
  expect(historyStatus(c({ verificationStatus: 'entered_in_error' }), statuses)).toBe('Entered in error');
  expect(historyStatus(c({ clinicalStatus: 'remission' }), statuses)).toBe('In remission');
});

test('a condition documented at a consultation says so, with the date', () => {
  expect(encounterLabel(c({ encounter: { id: 'e1', startedAt: '2026-09-22T09:00:00Z' } }))).toBe('Consultation — 22 Sep 2026');
  expect(encounterLabel(c({ encounter: { id: 'e1', startedAt: null } }))).toBe('Consultation');
  expect(encounterLabel(c())).toBe(null);
});

test('the timeline groups by when it began, newest first, unknown last', () => {
  const groups = timeline([
    c({ id: 'a', onset: { date: '2022-01-01', precision: 'year' } }),
    c({ id: 'b', onset: { date: '2026-08-01', precision: 'month' } }),
    c({ id: 'd', onset: { date: '2026-09-15', precision: 'day' } }),
    c({ id: 'e', onset: { date: null, precision: null } }),
  ]);
  expect(groups.map((g) => g.label)).toEqual(['Sep 2026', 'Aug 2026', '2022', 'Onset unknown']);
});

test('the hints inform — neither says the entry is refused', () => {
  for (const text of Object.values(HINT_TEXT)) expect(text).not.toMatch(/cannot|not allowed|refused|blocked/i);
  expect(HINT_TEXT.allergy).toMatch(/Allergies tab/);
});

test('the form says what is missing before it is submitted', () => {
  expect(formProblems({ conditionName: '' })).toContain('Say what the condition is.');
  expect(formProblems({ conditionName: 'X', verificationStatus: 'refuted' })).toContain('Say why it was refuted.');
  expect(formProblems({ conditionName: 'X', clinicalStatus: 'active', abatement: '2026-08' }).length).toBe(1);
  expect(formProblems({ conditionName: 'Hypertension', clinicalStatus: 'active' })).toEqual([]);
  expect(byLine({ recordedBy: null })).toBe('Recorded');
});

test('every status and verification the screen knows is one the server accepts', () => {
  const server = fs.readFileSync(path.join(here, '..', '..', 'server', 'services', 'clinical', 'problemInput.js'), 'utf8');
  for (const k of Object.keys(STATUS_GROUP)) expect(server).toContain(`value: '${k}'`);
  for (const k of Object.keys(VERIFICATION_TONE)) expect(server).toContain(`value: '${k}'`);
});
