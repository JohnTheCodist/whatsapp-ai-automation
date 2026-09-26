/**
 * The patient search's filter bar: its order, and the request it builds.
 * The server validates every value (server/tests/patientFilters.test.js);
 * these pin the half of the contract the dashboard owns.
 */

import { test, expect } from 'vitest';
import {
  FILTERS, CHRONIC, EMPTY_FILTERS, activeFilterCount, buildSearchQuery, isNarrowed, optionLabel, resultSummary,
} from './patientSearchQuery.js';

test('the eight filters, in the order the owner named them', () => {
  expect(FILTERS.map((f) => f.label)).toEqual([
    'Age', 'Condition', 'Gender', 'Medication', 'Last visit', 'Follow-up due', 'Assigned pharmacist', 'Risk flag',
  ]);
});

test('the filter keys are exactly the query parameters the server reads', () => {
  expect(FILTERS.map((f) => f.key)).toEqual([
    'age', 'condition', 'gender', 'medication', 'lastVisit', 'followUp', 'pharmacist', 'risk',
  ]);
});

test('an empty search asks for everything', () => {
  expect(buildSearchQuery('', EMPTY_FILTERS)).toBe('');
  expect(buildSearchQuery('   ', EMPTY_FILTERS)).toBe('');
  expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
});

test('only the filters that are set go into the request', () => {
  const query = buildSearchQuery(' Bello ', { ...EMPTY_FILTERS, age: '60plus', risk: 'lapsed' });
  expect(query).toBe('q=Bello&age=60plus&risk=lapsed');
  expect(activeFilterCount({ ...EMPTY_FILTERS, age: '60plus', risk: 'lapsed' })).toBe(2);
});

test('values are encoded, so a medicine name with spaces survives the trip', () => {
  expect(buildSearchQuery('', { ...EMPTY_FILTERS, medication: 'Amlodipine 5mg' })).toBe('medication=Amlodipine+5mg');
});

test('an active pill shows the label the server gave that value', () => {
  const options = { age: [{ value: '60plus', label: '60 and over' }] };
  expect(optionLabel(options, 'age', '60plus')).toBe('60 and over');
  expect(optionLabel(options, 'age', 'nope')).toBe('');
  expect(optionLabel(null, 'age', '60plus')).toBe('');
});

test('the result count says when the page is only part of the answer', () => {
  expect(resultSummary({ total: 4, shown: 4, filtered: true })).toBe('4 patients');
  expect(resultSummary({ total: 1, shown: 1, filtered: false })).toBe('1 patient');
  expect(resultSummary({ total: 240, shown: 100, filtered: false })).toBe('Showing 100 of 240 patients');
  expect(resultSummary({ total: 0, shown: 0, filtered: true })).toBe('No patients match');
  expect(resultSummary({ total: 0, shown: 0, filtered: false })).toBe('No patients yet');
});

test('last visit reads in days for recent visits and as a date for old ones', async () => {
  const { visitLabel } = await import('./patientSearchQuery.js');
  expect(visitLabel('2026-09-19', '2026-09-19')).toBe('Today');
  expect(visitLabel('2026-09-18', '2026-09-19')).toBe('Yesterday');
  expect(visitLabel('2026-08-25', '2026-09-19')).toBe('25 days ago');
  expect(visitLabel('2026-05-01', '2026-09-19')).toBe('1 May 2026');
  expect(visitLabel(null, '2026-09-19')).toBe('Never');
});

/**
 * The chronic switch. It is a filter on the wire but not one of the eight on
 * the screen, and these pin both halves of that: it reaches the server, and
 * it stays out of the count, the grid and the chips — all three of which
 * exist to show what is hidden, which a visible switch is not.
 */
test('the chronic switch is not one of the eight filters', () => {
  expect(FILTERS.map((f) => f.key)).not.toContain(CHRONIC.key);
  expect(EMPTY_FILTERS[CHRONIC.key]).toBe(false);
  expect(activeFilterCount({ ...EMPTY_FILTERS, [CHRONIC.key]: true })).toBe(0);
});

test('the switch travels as chronic=on, and absent when it is off', () => {
  expect(buildSearchQuery('', { ...EMPTY_FILTERS, chronic: true })).toBe('chronic=on');
  expect(buildSearchQuery('', { ...EMPTY_FILTERS, chronic: false })).toBe('');
  // On top of the other filters, never instead of them.
  expect(buildSearchQuery('', { ...EMPTY_FILTERS, chronic: true, gender: 'female' }))
    .toBe('gender=female&chronic=on');
});

test('the empty-state wording knows the switch narrows the list too', () => {
  expect(isNarrowed('', EMPTY_FILTERS)).toBe(false);
  expect(isNarrowed('', { ...EMPTY_FILTERS, chronic: true })).toBe(true);
  expect(isNarrowed(' bello ', EMPTY_FILTERS)).toBe(true);
  expect(isNarrowed('', { ...EMPTY_FILTERS, risk: 'any' })).toBe(true);
});
