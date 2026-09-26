/**
 * How an allergy record is written on screen.
 *
 * The failure these defend against above all others: an empty record read
 * as "no allergies". After that — a half-remembered date shown as if it were
 * exact, "Other" shown instead of what the reaction was, and a warning that
 * relies on colour alone.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLERGY_STATE, stateLabel, stripLabel, CRITICALITY_TONE, VERIFICATION_TONE,
  labelFor, partialDateLabel, partialDateInput, reactionsLine, kindLine, historyStatus,
  byLine, formProblems,
} from './allergyFormat.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('an empty or unknown state is NOT ASSESSED — the word "none" is never written', () => {
  expect(stateLabel('not_assessed')).toBe('Allergies not assessed');
  expect(stateLabel(undefined)).toBe('Allergies not assessed');
  expect(stateLabel('something_new')).toBe('Allergies not assessed');
  expect(stripLabel(null)).toBe('Allergies not assessed');
  expect(stripLabel({ state: 'not_assessed', allergies: [] })).toBe('Allergies not assessed');
  for (const s of ['not_assessed', undefined, null]) {
    expect(stateLabel(s)).not.toMatch(/\bnone\b/i);
    expect(stateLabel(s)).not.toMatch(/\bno allergies\b/i);
  }
});

test('"No known allergies" is only ever said for the state that means it', () => {
  expect(stateLabel('none_known')).toBe('No known allergies');
  expect(stripLabel({ state: 'none_known', allergies: [] })).toBe('No known allergies');
});

test('known allergies are counted, and named on the strip', () => {
  expect(stateLabel('known', 1)).toBe('1 known allergy');
  expect(stateLabel('known', 2)).toBe('2 known allergies');
  const summary = {
    state: 'known',
    allergies: ['Penicillin', 'Peanuts', 'Latex', 'Ibuprofen', 'Eggs'].map((allergenName) => ({ allergenName })),
  };
  expect(stripLabel({ ...summary, allergies: summary.allergies.slice(0, 2) })).toBe('Allergies: Penicillin, Peanuts');
  // A pointer to the tab, not the tab.
  expect(stripLabel(summary)).toBe('Allergies: Penicillin, Peanuts, Latex +2');
});

test('every state carries an icon, so colour is never the only signal', () => {
  for (const s of Object.values(ALLERGY_STATE)) {
    expect(s.icon).toBeTruthy();
    expect(s.tone).toBeTruthy();
  }
});

test('no red: a known allergy and high criticality wear the amber attention tone', () => {
  // design.md keeps red for "a person is waiting" — the owner kept it so.
  expect(CRITICALITY_TONE.high).toBe('ui-tone-3');
  const css = fs.readFileSync(path.join(here, 'index.css'), 'utf8');
  const block = css.slice(css.indexOf('── allergies'), css.indexOf('── allergies') + 12000);
  expect(block.length).toBeGreaterThan(100);
  expect(block).not.toMatch(/--ui-danger|--ui-red|red-\d00|#e5|oklch\([^)]*\s2[0-9]\)/i);
});

test('a half-remembered date is shown at the precision it was given', () => {
  expect(partialDateLabel({ date: '2021-01-01', precision: 'year' })).toBe('~2021');
  expect(partialDateLabel({ date: '2021-03-01', precision: 'month' })).toBe('Mar 2021');
  expect(partialDateLabel({ date: '2021-03-15', precision: 'day' })).toBe('15 Mar 2021');
  expect(partialDateLabel({ date: null, precision: null })).toBe(null);
  expect(partialDateLabel(null)).toBe(null);
  // And goes back to the form in the shape the server reads precision from.
  expect(partialDateInput({ date: '2021-01-01', precision: 'year' })).toBe('2021');
  expect(partialDateInput({ date: '2021-03-01', precision: 'month' })).toBe('2021-03');
  expect(partialDateInput({ date: '2021-03-15', precision: 'day' })).toBe('2021-03-15');
  expect(partialDateInput(null)).toBe('');
});

test('reactions read as a line, with "Other" replaced by what it was', () => {
  const m = [{ value: 'rash', label: 'Rash' }, { value: 'facial_swelling', label: 'Facial swelling' }];
  expect(reactionsLine([{ manifestation: 'rash' }, { manifestation: 'facial_swelling' }], m)).toBe('Rash · Facial swelling');
  expect(reactionsLine([{ manifestation: 'other', description: 'Joint pain' }], m)).toBe('Joint pain');
  expect(reactionsLine(['rash'], m)).toBe('Rash');
  expect(reactionsLine([], m)).toBe(null);
});

test('what it is reads under its name, and "unknown" is not written as a word', () => {
  const o = {
    categories: [{ value: 'medication', label: 'Medication' }],
    types: [{ value: 'allergy', label: 'Allergy' }, { value: 'intolerance', label: 'Intolerance' }],
  };
  expect(kindLine({ category: 'medication', type: 'allergy' }, o)).toBe('Medication · Allergy');
  expect(kindLine({ category: 'medication', type: 'unknown' }, o)).toBe('Medication');
  expect(kindLine({ category: 'unknown', type: 'unknown' }, o)).toBe(null);
  expect(kindLine({ category: 'medication', type: 'intolerance' }, o)).toBe('Medication · Intolerance');
});

test('in the history, whether the record is true outranks whether it is current', () => {
  expect(historyStatus({ verificationStatus: 'refuted', clinicalStatus: 'inactive' })).toBe('Refuted');
  expect(historyStatus({ verificationStatus: 'entered_in_error', clinicalStatus: 'resolved' })).toBe('Entered in error');
  expect(historyStatus({ verificationStatus: 'confirmed', clinicalStatus: 'resolved' })).toBe('Resolved');
  expect(historyStatus({ verificationStatus: 'unconfirmed', clinicalStatus: 'inactive' })).toBe('Inactive');
});

test('who recorded it is said plainly, and an unattributed record still says it was recorded', () => {
  expect(byLine({ recordedBy: { email: 'ade@example.test' } })).toBe('Recorded by ade@example.test');
  expect(byLine({
    recordedBy: { email: 'ade@example.test' }, updatedBy: { email: 'bola@example.test' },
  })).toBe('Recorded by ade@example.test, last changed by bola@example.test');
  expect(byLine({ recordedBy: null })).toBe('Recorded');
});

test('the form says what is missing before it is submitted', () => {
  expect(formProblems({ allergenName: '' })).toContain('Say what the patient reacts to.');
  expect(formProblems({ allergenName: 'X', reactions: ['other'] })).toContain('Say what the other reaction was.');
  expect(formProblems({ allergenName: 'X', verificationStatus: 'refuted' })).toContain('Say why it was refuted.');
  expect(formProblems({ allergenName: 'Penicillin', reactions: ['rash'] })).toEqual([]);
});

test('every tone and state key is one the server knows', () => {
  const server = fs.readFileSync(path.join(here, '..', '..', 'server', 'services', 'clinical', 'allergyInput.js'), 'utf8');
  for (const k of Object.keys(CRITICALITY_TONE)) expect(server).toContain(`value: '${k}'`);
  for (const k of Object.keys(VERIFICATION_TONE)) expect(server).toContain(`value: '${k}'`);
  const service = fs.readFileSync(path.join(here, '..', '..', 'server', 'services', 'clinical', 'allergies.js'), 'utf8');
  for (const k of Object.keys(ALLERGY_STATE)) expect(service).toContain(`'${k}'`);
  expect(labelFor([{ value: 'a', label: 'A' }], 'b')).toBe('b');
});
