/**
 * The contract for a diagnostic test and its results.
 *
 * What these defend against, in order of cost: a value typed into a box
 * becoming a FINAL result nobody signed off; a number with no unit or no
 * range read as normal; one row claiming to be both "8.1" and "Positive";
 * and a corrected report with no reason, which is an overwrite wearing a
 * different word.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES, INTERPRETATIONS, readTestInput, readTestPatch, mergeForCheck,
  needsClinicalRole, hasClinicalRole, suggestInterpretation, isAbnormal, isCritical, testOptions,
} = require('../services/clinical/testInput');

const TODAY = '2026-09-23';
const read = (body) => readTestInput(body, { today: TODAY });
const RDT = { testName: 'Malaria RDT', category: 'rapid_test', specimen: 'blood' };

function rejects(fn, field) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_TEST');
    assert.equal(err.field, field);
    return true;
  });
}

test('a test starts ORDERED, with only a name required', () => {
  const t = read({ testName: 'Lipid profile' });
  assert.equal(t.status, 'ordered');
  assert.equal(t.priority, 'routine');
  assert.equal(t.source, 'rxmax_clinic');
  assert.equal(t.category, 'laboratory');
  assert.equal(t.historical, false);
  assert.deepEqual(t.results, []);
  rejects(() => read({}), 'testName');
});

test('ENTERING A VALUE NEVER MAKES A RESULT FINAL — it becomes preliminary', () => {
  // The failure this prevents: a number typed at a counter reading as a
  // signed-off laboratory result.
  const t = read({
    ...RDT, performed: '2026-09-22',
    results: [{ analyteName: 'Malaria RDT', valueCode: 'negative', valueDisplay: 'Negative', interpretation: 'negative' }],
  });
  assert.equal(t.status, 'preliminary');
  // A pharmacist saying "final" is what makes it final.
  assert.equal(read({ ...RDT, performed: '2026-09-22', status: 'final', results: t.results }).status, 'final');
});

test('a reported test says when it was performed, and an ordered one need not', () => {
  rejects(() => read({ ...RDT, status: 'final', results: [{ analyteName: 'x', valueText: 'y' }] }), 'performed');
  assert.equal(read({ ...RDT }).performedAt, null);
  // At the precision known — a result from last year is often just a month.
  const old = read({ ...RDT, performed: '2026-06', results: [{ analyteName: 'HbA1c', valueNumber: 7.8, unit: '%' }] });
  assert.equal(old.performedAt, '2026-06-01');
  assert.equal(old.performedPrecision, 'month');
  rejects(() => read({ ...RDT, performed: '2027-01' }), 'performed');
});

test('a quantitative result keeps its unit and the range it was read against', () => {
  const t = read({
    testName: 'Fasting blood glucose', category: 'chemistry', performed: '2026-09-20',
    results: [{
      analyteName: 'Fasting blood glucose', analyteCode: 'FBG', valueNumber: '108',
      unit: 'mg/dL', referenceLow: 70, referenceHigh: 99, interpretation: 'high',
    }],
  });
  const r = t.results[0];
  assert.equal(r.valueNumber, 108);
  assert.equal(r.unit, 'mg/dL');
  assert.equal(r.referenceLow, 70);
  assert.equal(r.referenceHigh, 99);
  assert.equal(r.interpretation, 'high');
  // A range upside down, or attached to words, is refused.
  rejects(() => read({ ...RDT, performed: TODAY, results: [{ analyteName: 'x', valueNumber: 5, referenceLow: 9, referenceHigh: 1 }] }), 'referenceLow');
  rejects(() => read({ ...RDT, performed: TODAY, results: [{ analyteName: 'x', valueText: 'Normal study', referenceLow: 1 }] }), 'referenceLow');
});

test('a result is a number, a code, or words — never two at once', () => {
  const coded = read({ ...RDT, performed: TODAY, results: [{ analyteName: 'Malaria RDT', valueCode: 'positive' }] });
  assert.equal(coded.results[0].valueDisplay, 'positive', 'a code shows as itself when no display was sent');
  const words = read({
    testName: 'Urinalysis', performed: TODAY,
    results: [{ analyteName: 'Urinalysis', valueText: 'No significant abnormality detected.' }],
  });
  assert.match(words.results[0].valueText, /No significant/);
  rejects(() => read({ ...RDT, performed: TODAY, results: [{ analyteName: 'x', valueNumber: 1, valueCode: 'positive' }] }), 'results');
  rejects(() => read({ ...RDT, performed: TODAY, results: [{ analyteName: 'x' }] }), 'results');
  rejects(() => read({ ...RDT, performed: TODAY, results: [{ valueNumber: 1 }] }), 'results');
  rejects(() => read({ ...RDT, results: 'negative' }), 'results');
});

test('one test carries several analytes, in the order they were entered', () => {
  const t = read({
    testName: 'Lipid profile', performed: '2026-09-18',
    results: [
      { analyteName: 'Total cholesterol', analyteCode: 'TC', valueNumber: 210, unit: 'mg/dL', referenceHigh: 200, interpretation: 'high' },
      { analyteName: 'HDL cholesterol', analyteCode: 'HDL', valueNumber: 55, unit: 'mg/dL', referenceLow: 40, interpretation: 'normal' },
      { analyteName: 'LDL cholesterol', analyteCode: 'LDL', valueNumber: 130, unit: 'mg/dL', referenceHigh: 100, interpretation: 'high' },
    ],
  });
  assert.deepEqual(t.results.map((r) => r.analyteCode), ['TC', 'HDL', 'LDL']);
  assert.equal(t.status, 'preliminary');
});

test('the interpretation offered is arithmetic, and never says "critical"', () => {
  // The form pre-fills this; a pharmacist may change it. Comparing a number
  // to the range typed beside it is not a diagnosis.
  assert.equal(suggestInterpretation(108, 70, 99), 'high');
  assert.equal(suggestInterpretation(65, 70, 99), 'low');
  assert.equal(suggestInterpretation(90, 70, 99), 'normal');
  assert.equal(suggestInterpretation(210, null, 200), 'high');
  assert.equal(suggestInterpretation(55, 40, null), 'normal');
  // Nothing to compare against: no suggestion at all.
  assert.equal(suggestInterpretation(108, null, null), null);
  assert.equal(suggestInterpretation(null, 70, 99), null);
  assert.equal(suggestInterpretation('abc', 70, 99), null);
  // "Critical" is a judgement a person makes about a patient, not a
  // threshold this product invents (brief §23).
  for (const v of [1, 1000, -50]) {
    assert.notEqual(suggestInterpretation(v, 70, 99), 'critical_high');
    assert.notEqual(suggestInterpretation(v, 70, 99), 'critical_low');
  }
  // But a person may record one, and it reads as abnormal AND critical.
  assert.equal(isCritical('critical_high'), true);
  assert.equal(isAbnormal('critical_high'), true);
  assert.equal(isAbnormal('high'), true);
  assert.equal(isAbnormal('positive'), true);
  assert.equal(isAbnormal('normal'), false);
  assert.equal(isCritical('high'), false);
});

test('cancelling, amending or correcting a report always says why', () => {
  rejects(() => read({ ...RDT, status: 'cancelled' }), 'statusReason');
  assert.equal(read({ ...RDT, status: 'cancelled', statusReason: 'Patient did not return.' }).status, 'cancelled');
  rejects(() => read({
    ...RDT, status: 'corrected', performed: TODAY, results: [{ analyteName: 'x', valueText: 'y' }],
  }), 'statusReason');
});

test('specimen, priority, source and who did it are all recorded', () => {
  const t = read({
    ...RDT, specimen: 'urine', priority: 'urgent', source: 'external_lab',
    sourceName: 'Synlab · report 2026-0918-441', performedByName: 'Synlab, Ikeja',
    ordererName: 'Dr Okafor', reason: 'Fatigue and thirst', historical: true,
  });
  assert.equal(t.specimen, 'urine');
  assert.equal(t.priority, 'urgent');
  assert.equal(t.source, 'external_lab');
  assert.match(t.sourceName, /2026-0918-441/);
  assert.equal(t.historical, true);
  assert.equal(t.reason, 'Fatigue and thirst');
  rejects(() => read({ ...RDT, specimen: 'hair' }), 'specimen');
  rejects(() => read({ ...RDT, source: 'facebook' }), 'source');
  rejects(() => read({ ...RDT, priority: 'stat' }), 'priority');
  // "Historical" is said, never guessed from a date.
  assert.equal(read({ ...RDT, performed: '2019' }).historical, false);
});

test('an edit is judged against the results already stored', () => {
  const before = { status: 'preliminary', results: [{ analyteName: 'HbA1c', valueNumber: 8.1 }], performedAt: '2026-06-01', statusReason: null, reportSummary: null };
  // Finalising a stored result needs no new results in the patch.
  assert.equal(mergeForCheck(before, { status: 'final' }).status, 'final');
  // Correcting it needs a reason.
  rejects(() => mergeForCheck(before, { status: 'corrected' }), 'statusReason');
  // A test with no date cannot be reported.
  rejects(() => mergeForCheck({ ...before, performedAt: null }, { status: 'final' }), 'performed');
  // Reopening a cancelled test drops the reason that no longer applies.
  const cancelled = { status: 'cancelled', statusReason: 'Patient left', results: [], performedAt: null, reportSummary: null };
  assert.equal(mergeForCheck(cancelled, { status: 'ordered' }).statusReason, null);
  rejects(() => readTestPatch({}, { today: TODAY }), 'body');
});

test('only a pharmacist or owner may finalise, amend, correct or cancel', () => {
  // Anyone may order a test or write down what a result said.
  assert.equal(needsClinicalRole({ status: 'ordered' }), false);
  assert.equal(needsClinicalRole({ status: 'preliminary' }), false);
  for (const s of ['final', 'amended', 'corrected', 'cancelled']) {
    assert.equal(needsClinicalRole({ status: s }), true, s);
  }
  // Re-saving the same status is not a new claim.
  assert.equal(needsClinicalRole({ status: 'final' }, { status: 'final' }), false);
  assert.equal(hasClinicalRole('pharmacist'), true);
  assert.equal(hasClinicalRole('staff'), false);
});

test('the lifecycle and the vocabulary are the brief\'s', () => {
  assert.deepEqual(STATUSES.map((s) => s.value),
    ['ordered', 'pending', 'preliminary', 'final', 'amended', 'corrected', 'cancelled']);
  // "Completed" is what a pharmacist reads for a final report.
  assert.equal(STATUSES.find((s) => s.value === 'final').label, 'Completed');
  assert.equal(INTERPRETATIONS.length, 10);
  const o = testOptions();
  for (const { value } of o.categories) assert.doesNotThrow(() => read({ testName: 'X', category: value }));
  for (const { value } of o.specimens) assert.doesNotThrow(() => read({ testName: 'X', specimen: value }));
  for (const { value } of o.sources) assert.doesNotThrow(() => read({ testName: 'X', source: value }));
  for (const list of Object.values(o)) {
    for (const item of list) assert.deepEqual(Object.keys(item).sort(), ['label', 'value']);
  }
});

test('a test links to the consultation it belongs to, by id', () => {
  const enc = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';
  assert.equal(read({ ...RDT, encounterId: enc }).encounterId, enc);
  rejects(() => read({ ...RDT, encounterId: 'consultation-1' }), 'encounterId');
});

test('a reported test with no values still needs the lab\'s words', () => {
  // An imaging report is words, not numbers — but "final" with neither is a
  // report that says nothing.
  rejects(() => read({ testName: 'Chest X-ray', category: 'imaging', status: 'final', performed: TODAY }), 'results');
  const report = read({
    testName: 'Chest X-ray', category: 'imaging', status: 'final', performed: TODAY,
    reportSummary: 'No focal consolidation. Heart size normal.',
  });
  assert.equal(report.status, 'final');
});
