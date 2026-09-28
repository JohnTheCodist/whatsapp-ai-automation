/**
 * The record pickers.
 *
 * Two screens point at records they do not own. This file exists to stop the
 * failure that shape produces: a screen OFFERING a kind of record it cannot
 * list, so a pharmacist picks "Medication", waits, and is told this patient
 * has none — while the Medications section beside it shows four.
 */

import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import { RECORD_PICKERS, PICKER_KINDS, readRecords } from './recordPicker.js';

// The vocabularies are the SERVER's, read from the real module rather than a
// fixture — a copy here would agree with itself while the wire disagreed.
const require = createRequire(import.meta.url);
const { PROBLEM_REF_KINDS } = require('../../server/services/clinical/consultationInput.js');
const { LINK_KINDS } = require('../../server/services/clinical/careProgramInput.js');

// THE MOST IMPORTANT TEST IN THIS FILE.
test('every kind a screen may offer can actually be listed', () => {
  // A consultation problem may point at any of these (§12). If one has no
  // picker, the screen draws the button and the list comes back empty.
  for (const kind of PROBLEM_REF_KINDS.map((k) => k.id)) {
    expect(PICKER_KINDS, `no picker for ${kind}`).toContain(kind);
    expect(typeof RECORD_PICKERS[kind].url).toBe('function');
    expect(typeof RECORD_PICKERS[kind].rows).toBe('function');
  }
  // And the care programme's link kinds, which is where this map came from.
  for (const kind of LINK_KINDS.map((k) => k.value ?? k.id)) {
    expect(PICKER_KINDS, `no picker for ${kind}`).toContain(kind);
  }
});

test('each picker reads the section that owns the records, not a copy', () => {
  // The URL names the owning section's own endpoint. A picker reading some
  // aggregate would be a second source of truth for what a patient has.
  expect(RECORD_PICKERS.condition.url('c1')).toBe('/api/customers/c1/problems');
  expect(RECORD_PICKERS.medication.url('c1')).toMatch(/^\/api\/customers\/c1\/medications/);
  expect(RECORD_PICKERS.test.url('c1')).toBe('/api/customers/c1/tests');
  expect(RECORD_PICKERS.vitals.url('c1')).toMatch(/^\/api\/customers\/c1\/vitals/);
  // Every one is scoped to the patient in the path. None takes a pharmacy id
  // from the client — GOLDEN-001's rule reaches the picker too.
  for (const kind of PICKER_KINDS) {
    const url = RECORD_PICKERS[kind].url('c1');
    expect(url).toContain('/customers/c1/');
    expect(url).not.toMatch(/pharmacy/i);
  }
});

test('a payload with nothing in it lists nothing, and never throws', () => {
  // The endpoints answer with different key names, and one of them changing
  // must show as an empty picker rather than a blank screen.
  for (const kind of PICKER_KINDS) {
    expect(RECORD_PICKERS[kind].rows({}, () => null)).toEqual([]);
  }
});

test('a reading is listed by its day and its numbers', () => {
  const rows = RECORD_PICKERS.vitals.rows(
    { readings: [{ id: 'v1', recordedAt: '2026-09-27T09:00:00Z', systolic: 148, diastolic: 92, pulse: 78 }] },
    () => '27 Sept 2026',
  );
  expect(rows[0].label).toBe('27 Sept 2026');
  expect(rows[0].detail).toBe('148/92 mmHg · 78 bpm');

  // A reading with no blood pressure is not labelled "undefined/undefined".
  const partial = RECORD_PICKERS.vitals.rows(
    { readings: [{ id: 'v2', recordedAt: 'x', pulse: 61 }] }, () => null,
  );
  expect(partial[0].label).toBe('Reading');
  expect(partial[0].detail).toBe('61 bpm');
});

test('a read that fails lists nothing rather than breaking the screen', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  try {
    expect(await readRecords('condition', 'c1')).toEqual([]);
    // An unknown kind is not a crash either.
    expect(await readRecords('nonsense', 'c1')).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});
