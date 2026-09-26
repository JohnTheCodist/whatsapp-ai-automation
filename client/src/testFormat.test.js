/**
 * How a diagnostic test is written on screen.
 *
 * The failure these defend against: a pharmacist having to open a record to
 * find out what the result was. After that — a panel's worst value hidden
 * behind three normal ones, a reference range shown as if it were the
 * result, a trend drawn from two points, and "critical" looking like
 * "high".
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_FILTERS, STATUS_TONE, INTERPRETATION_TONE, interpretationArrow, isCritical, labelFor,
  performedLabel, performedInput, dayLabel, resultValue, rowResult, rowInterpretation,
  referenceLabel, sourceLabel, encounterLabel, pendingLine, byLine, canTrend, trendSeries,
  MIN_TREND_POINTS, formProblems,
} from './testFormat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const glucose = (over = {}) => ({
  id: 't1', testName: 'Fasting blood glucose', status: 'final', category: 'chemistry',
  performed: { at: '2026-09-20T00:00:00.000Z', precision: 'day' },
  source: 'external_lab', sourceName: 'Synlab · 2026-0918-441',
  results: [{
    analyteName: 'Fasting blood glucose', valueNumber: 108, unit: 'mg/dL',
    referenceLow: 70, referenceHigh: 99, interpretation: 'high',
  }],
  ...over,
});

test('the result is written for the row — no click to find out what it was', () => {
  expect(rowResult(glucose())).toBe('108 mg/dL');
  expect(rowInterpretation(glucose())).toBe('high');
  expect(resultValue({ valueCode: 'negative', valueDisplay: 'Negative' })).toBe('Negative');
  expect(resultValue({ valueText: 'No significant abnormality detected.' })).toMatch(/^No significant/);
  // A number with no unit is still a result.
  expect(resultValue({ valueNumber: 5.6 })).toBe('5.6');
  expect(rowResult({ results: [] })).toBe(null);
});

test('a panel says how many values it holds, and how many need looking at', () => {
  const lipid = glucose({
    testName: 'Lipid profile',
    results: [
      { analyteName: 'TC', valueNumber: 210, unit: 'mg/dL', interpretation: 'high' },
      { analyteName: 'HDL', valueNumber: 55, unit: 'mg/dL', interpretation: 'normal' },
      { analyteName: 'LDL', valueNumber: 130, unit: 'mg/dL', interpretation: 'high' },
      { analyteName: 'TRIG', valueNumber: 140, unit: 'mg/dL', interpretation: 'normal' },
    ],
  });
  expect(rowResult(lipid)).toBe('4 values, 2 abnormal');
  // The worst reading is the one the row shows — never the first normal one.
  expect(rowInterpretation(lipid)).toBe('high');
  const critical = glucose({
    results: [
      { analyteName: 'K', valueNumber: 6.9, interpretation: 'critical_high' },
      { analyteName: 'Na', valueNumber: 138, interpretation: 'normal' },
    ],
  });
  expect(rowInterpretation(critical)).toBe('critical_high');
  const allNormal = glucose({
    results: [
      { analyteName: 'A', valueNumber: 1, interpretation: 'normal' },
      { analyteName: 'B', valueNumber: 2, interpretation: 'normal' },
    ],
  });
  expect(rowInterpretation(allNormal)).toBe('normal');
});

test('critical is louder than abnormal, and neither relies on colour alone', () => {
  expect(INTERPRETATION_TONE.critical_high).toBe('ui-test-critical');
  expect(INTERPRETATION_TONE.high).toBe('ui-tone-3');
  expect(INTERPRETATION_TONE.normal).toBe('ui-tone-quiet');
  expect(isCritical('critical_low')).toBe(true);
  expect(isCritical('low')).toBe(false);
  // An arrow AND the word — the word comes from the server's own list.
  expect(interpretationArrow('high')).toBe('▲');
  expect(interpretationArrow('critical_low')).toBe('▼');
  expect(interpretationArrow('normal')).toBe(null);
  expect(labelFor([{ value: 'critical_high', label: 'Critically high' }], 'critical_high')).toBe('Critically high');
});

test('the date is shown at the precision it was recorded', () => {
  expect(performedLabel(glucose())).toBe('20 Sep 2026');
  expect(performedLabel(glucose({ performed: { at: '2026-06-01T00:00:00.000Z', precision: 'month' } }))).toBe('Jun 2026');
  expect(performedLabel(glucose({ performed: { at: '2019-01-01T00:00:00.000Z', precision: 'year' } }))).toBe('~2019');
  expect(performedLabel(glucose({ performed: { at: null, precision: null } }))).toBe(null);
  expect(performedInput(glucose())).toBe('2026-09-20');
  expect(performedInput(glucose({ performed: { at: '2026-06-01T00:00:00.000Z', precision: 'month' } }))).toBe('2026-06');
  expect(performedInput({ performed: { at: null } })).toBe('');
  expect(dayLabel('2026-09-22T09:00:00Z')).toBe('22 Sep 2026');
});

test('the reference range reads as a range, and the lab\'s own words win', () => {
  expect(referenceLabel(glucose().results[0])).toBe('70–99 mg/dL');
  expect(referenceLabel({ referenceLow: null, referenceHigh: 200, unit: 'mg/dL' })).toBe('≤ 200 mg/dL');
  expect(referenceLabel({ referenceLow: 40, referenceHigh: null, unit: 'mg/dL' })).toBe('≥ 40 mg/dL');
  expect(referenceLabel({ referenceLow: null, referenceHigh: null })).toBe(null);
  expect(referenceLabel({ referenceLow: 1, referenceHigh: 2, referenceText: 'Non-reactive' })).toBe('Non-reactive');
});

test('an ordered test says a result is pending, and never shows a blank as a result', () => {
  expect(pendingLine(glucose({ status: 'ordered', results: [] }))).toBe('Test ordered — result pending');
  expect(pendingLine(glucose({ status: 'pending', results: [] }))).toMatch(/result pending/);
  expect(pendingLine(glucose({ status: 'cancelled', results: [] }))).toBe('Cancelled');
  expect(pendingLine(glucose())).toBe(null);
});

test('where it came from travels with the result', () => {
  const sources = [{ value: 'external_lab', label: 'External laboratory' }];
  expect(sourceLabel(glucose(), sources)).toBe('External laboratory · Synlab · 2026-0918-441');
  expect(sourceLabel({ source: 'external_lab' }, sources)).toBe('External laboratory');
  expect(encounterLabel(glucose({ encounter: { id: 'e1', startedAt: '2026-09-20T09:00:00Z' } }))).toBe('Consultation — 20 Sep 2026');
  expect(encounterLabel(glucose())).toBe(null);
  expect(byLine({ recordedBy: null })).toBe('Recorded');
});

test('a trend needs three points — two dots and a line is not a trend', () => {
  expect(MIN_TREND_POINTS).toBe(3);
  const points = (n) => Array.from({ length: n }, (_, i) => ({ at: `2026-0${i + 1}-10T00:00:00Z`, value: 8 - i }));
  expect(canTrend({ points: points(2) })).toBe(false);
  expect(canTrend({ points: points(3) })).toBe(true);
  expect(canTrend(null)).toBe(false);
  expect(trendSeries({ points: points(2) })).toBe(null);

  const chart = trendSeries({ analyte: 'HbA1c', unit: '%', points: points(3), ranges: { min: 4, max: 5.6 } });
  // Exactly the shape the app's existing chart takes.
  expect(chart.series[0].label).toBe('HbA1c');
  expect(chart.series[0].points).toHaveLength(3);
  expect(chart.unit).toBe('%');
  expect(chart.ranges).toEqual({ min: 4, max: 5.6 });
  expect(trendSeries({ points: points(3), ranges: { min: null, max: null } }).ranges).toBe(null);
});

test('the filters are the brief\'s, each naming the count it shows', () => {
  expect(TEST_FILTERS.map((f) => f.label)).toEqual(['All', 'Ordered', 'Pending', 'Completed', 'Abnormal', 'Historical']);
  for (const f of TEST_FILTERS) expect(typeof f.count).toBe('string');
  // Completed is what a final report is called on screen.
  expect(STATUS_TONE.final).toBe('ui-med-active');
  expect(STATUS_TONE.ordered).toBe('ui-med-draft');
});

test('the form says what is missing before it is submitted', () => {
  expect(formProblems({ testName: '' })).toContain('Say which test this is.');
  expect(formProblems({ testName: 'X', status: 'final', results: [] }))
    .toEqual(expect.arrayContaining(['Say when the test was performed.']));
  expect(formProblems({ testName: 'X', status: 'final', performed: '2026-09-20', results: [] }))
    .toContain('Record a result, or the report\'s own words.');
  expect(formProblems({ testName: 'X', status: 'cancelled' })).toContain('Say why it was cancelled.');
  expect(formProblems({
    testName: 'X', status: 'preliminary', performed: '2026-09-20',
    results: [{ analyteName: 'Glucose', valueNumber: '' }],
  })).toContain('Glucose has no result.');
  expect(formProblems({
    testName: 'Malaria RDT', status: 'preliminary', performed: '2026-09-22',
    results: [{ analyteName: 'Malaria RDT', valueCode: 'negative' }],
  })).toEqual([]);
  expect(formProblems({ testName: 'Lipid profile', status: 'ordered', results: [] })).toEqual([]);
});

test('every status and interpretation the screen knows is one the server accepts', () => {
  const server = fs.readFileSync(path.join(here, '..', '..', 'server', 'services', 'clinical', 'testInput.js'), 'utf8');
  for (const k of Object.keys(STATUS_TONE)) expect(server, k).toContain(`value: '${k}'`);
  for (const k of Object.keys(INTERPRETATION_TONE)) expect(server, k).toContain(`value: '${k}'`);
  for (const f of TEST_FILTERS.filter((x) => x.value)) {
    expect(fs.readFileSync(path.join(here, '..', '..', 'server', 'services', 'clinical', 'tests.js'), 'utf8'))
      .toContain(`filter === '${f.value}'`);
  }
});
