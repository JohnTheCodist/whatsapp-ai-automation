/**
 * How the dashboard shows a vitals reading.
 *
 * Three things are worth a test here, and they are all about NOT LYING WITH
 * A CHART: a visit where nobody took a temperature must not be plotted as
 * zero; the axis must not be forced to include a zero that means nothing;
 * and the dashboard must not invent its own opinion about which numbers are
 * abnormal — that belongs to the server, once.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VITALS_COLUMNS, BIOMETRICS_COLUMNS, CHART_SIGNS, SERIES_COLOURS,
  cellValue, cellFlag, readingStamp, shortDate, itemsLabel, chartSeries, chartBounds, axisTicks, referenceBand,
} from './vitalsFormat.js';

const at = (iso, over = {}) => ({ recordedAt: iso, abnormal: {}, ...over });

test('a blood pressure is one cell written as two numbers', () => {
  const bp = VITALS_COLUMNS[0];
  expect(cellValue(at('2026-01-01', { systolic: 120, diastolic: 80 }), bp)).toBe('120 / 80');
  // Half a blood pressure is not a blood pressure.
  expect(cellValue(at('2026-01-01', { systolic: 120, diastolic: null }), bp)).toBe(null);
});

test('a missing reading is a dash, never a zero', () => {
  const pulse = VITALS_COLUMNS.find((c) => c.key === 'pulse');
  expect(cellValue(at('2026-01-01', { pulse: null }), pulse)).toBe(null);
  expect(cellValue(at('2026-01-01', { pulse: 0 }), pulse)).toBe(0);
});

test('the dashboard colours what the SERVER flagged, and decides nothing itself', () => {
  const pulse = VITALS_COLUMNS.find((c) => c.key === 'pulse');
  // A pulse of 130 with no flag from the server — a child, say — stays black.
  expect(cellFlag(at('2026-01-01', { pulse: 130, abnormal: {} }), pulse)).toBe(null);
  expect(cellFlag(at('2026-01-01', { pulse: 130, abnormal: { pulse: 'high' } }), pulse)).toBe('high');
  // Either half of a blood pressure flags the cell.
  const bp = VITALS_COLUMNS[0];
  expect(cellFlag(at('x', { abnormal: { diastolic: 'high' } }), bp)).toBe('high');
});

test('a visit that did not record a sign is absent from its line, not plotted at zero', () => {
  const readings = [
    { recordedAt: '2026-01-01T08:00:00Z', temperature: 36.8 },
    { recordedAt: '2026-01-02T08:00:00Z', temperature: null },   // nobody took it
    { recordedAt: '2026-01-03T08:00:00Z', temperature: 37.2 },
  ];
  const [line] = chartSeries(readings, CHART_SIGNS.find((s) => s.key === 'temperature'));
  expect(line.points.map((p) => p.value)).toEqual([36.8, 37.2]);
  // A zero here would draw the line down to the floor and back, which reads
  // as a collapse rather than as a gap.
  expect(line.points.some((p) => p.value === 0)).toBe(false);
});

test('blood pressure is two lines on one axis, and every other sign is one', () => {
  const readings = [{ recordedAt: '2026-01-01T08:00:00Z', systolic: 120, diastolic: 80, pulse: 70 }];
  expect(chartSeries(readings, CHART_SIGNS.find((s) => s.key === 'bp')).map((s) => s.label))
    .toEqual(['Systolic', 'Diastolic']);
  expect(chartSeries(readings, CHART_SIGNS.find((s) => s.key === 'pulse'))).toHaveLength(1);
  // Two series, two validated hues — and never more than the list holds.
  expect(SERIES_COLOURS.length).toBeGreaterThanOrEqual(2);
});

test('the axis follows the data and is never forced to include zero', () => {
  // A temperature axis from 0 is a flat line at the top of the frame.
  const bounds = chartBounds([{ points: [{ value: 36.5 }, { value: 37.4 }] }]);
  expect(bounds.min).toBeGreaterThan(30);
  expect(bounds.max).toBeLessThan(40);
  expect(bounds.min).toBeLessThan(36.5);
  expect(bounds.max).toBeGreaterThan(37.4);
});

test('one reading still draws, instead of dividing by a zero range', () => {
  const bounds = chartBounds([{ points: [{ value: 98 }] }]);
  expect(bounds.max).toBeGreaterThan(bounds.min);
  expect(chartBounds([])).toBe(null);
});

test('axis ticks are round numbers inside the bounds', () => {
  const ticks = axisTicks({ min: 36.2, max: 37.9 });
  expect(ticks.length).toBeGreaterThan(1);
  for (const t of ticks) {
    expect(t).toBeGreaterThanOrEqual(36.2);
    expect(t).toBeLessThanOrEqual(37.9);
  }
});

test('a reading is stamped with its date AND its time', () => {
  // Three readings on one morning is the normal case on the reference
  // screen; a date alone would make them look like duplicates.
  const stamp = readingStamp('2021-12-03T05:28:00Z');
  expect(stamp).toMatch(/03 - Dec - 2021/);
  expect(stamp).toMatch(/\d{2}:\d{2}/);
  expect(readingStamp(null)).toBe('—');
  expect(shortDate('2021-12-03T05:28:00Z')).toBe('03 - Dec - 2021');
});

test('the item count says how many of how many', () => {
  expect(itemsLabel(3, 12)).toBe('3 / 12 items');
  expect(itemsLabel(1, 1)).toBe('1 / 1 item');
});

test('every column the dashboard shows is a reading the server knows about', () => {
  // The labels are the dashboard's, the ranges are the server's — but the
  // KEYS have to be the same, or a column silently shows nothing forever.
  const server = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'services', 'clinical', 'vitalRanges.js'),
    'utf8',
  );
  const keys = [
    ...VITALS_COLUMNS.flatMap((c) => c.pair || [c.key]),
    ...BIOMETRICS_COLUMNS.map((c) => c.key),
    ...CHART_SIGNS.flatMap((s) => s.series),
  ].filter((k) => k !== 'bmi');           // bmi is derived, not a column
  for (const key of new Set(keys)) {
    expect(server, `the server records "${key}"`).toContain(`key: '${key}'`);
  }
});

test('the usual-range band comes from the server, and is absent for a child', () => {
  // The dashboard holds no clinical range of its own: one copy here and one
  // on the server is two answers to "is this normal", and a pharmacist would
  // believe whichever they happened to look at.
  const ranges = { systolic: { min: 90, max: 140 }, spo2: { min: 94, max: 100 } };
  const bp = CHART_SIGNS.find((s) => s.key === 'bp');
  expect(referenceBand(ranges, bp)).toMatchObject({ min: 90, max: 140 });
  // A child or an unknown age gets no ranges at all from the server, so
  // nothing is shaded — the same rule as the red in the table.
  expect(referenceBand(null, bp)).toBe(null);
  // A sign the server sends no bounds for (weight, say) is not invented.
  expect(referenceBand(ranges, { key: 'weight', series: ['weight'] })).toBe(null);
});
