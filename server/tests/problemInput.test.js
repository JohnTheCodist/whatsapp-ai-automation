/**
 * The contract for a condition record (the problem list).
 *
 * What these defend against, in order of cost: an uncertain condition that
 * reads as a confirmed diagnosis; a refuted one still showing as current; a
 * resolved condition losing its history, or a current one carrying a
 * resolution date; and a patient's "since childhood" refused because it is
 * not a date.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CATALOGUE, readProblemInput, readProblemPatch, mergeForCheck, needsClinicalRole,
  hasClinicalRole, conditionHints, searchCatalogue, problemOptions,
} = require('../services/clinical/problemInput');

const TODAY = '2026-09-22';
const read = (body) => readProblemInput(body, { today: TODAY });

function rejects(fn, field) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_CONDITION');
    assert.equal(err.field, field);
    return true;
  });
}

test('a condition needs only a name — and it starts active and UNCONFIRMED', () => {
  const c = read({ conditionName: 'Asthma' });
  assert.equal(c.conditionName, 'Asthma');
  assert.equal(c.clinicalStatus, 'active');
  // Writing down what a patient said is not a confirmed diagnosis.
  assert.equal(c.verificationStatus, 'unconfirmed');
  assert.equal(c.category, 'problem_list');
  assert.equal(c.severity, null, 'severity is never forced');
  assert.equal(c.bodySite, null);
  assert.equal(c.codeSystem, null);
  rejects(() => read({}), 'conditionName');
  rejects(() => read({ conditionName: '  ' }), 'conditionName');
});

test('a coded condition keeps its code, and free text needs none', () => {
  const coded = read({ conditionName: 'Hypertension', codeSystem: 'icd10', code: 'I10', localCode: 'HYPERTENSION' });
  assert.equal(coded.code, 'I10');
  assert.equal(coded.codeSystem, 'icd10');
  assert.equal(coded.localCode, 'HYPERTENSION');
  const free = read({ conditionName: 'Chronic sinus trouble' });
  assert.equal(free.code, null);
  // A code without its system (or the reverse) means nothing.
  rejects(() => read({ conditionName: 'X', code: 'I10' }), 'code');
  rejects(() => read({ conditionName: 'X', codeSystem: 'icd9', code: '401' }), 'codeSystem');
  rejects(() => read({ conditionName: 'X', localCode: 'hypertension' }), 'localCode');
});

test('category, severity, body site and source take their vocabularies', () => {
  const c = read({
    conditionName: 'Osteoarthritis', category: 'chronic', severity: 'moderate',
    bodySite: 'Left knee', source: 'previous_record', assertedByName: 'Dr Okafor, LUTH',
  });
  assert.equal(c.category, 'chronic');
  assert.equal(c.severity, 'moderate');
  assert.equal(c.bodySite, 'Left knee');
  assert.equal(c.source, 'previous_record');
  assert.equal(c.assertedByName, 'Dr Okafor, LUTH');
  rejects(() => read({ conditionName: 'X', category: 'diagnosis' }), 'category');
  rejects(() => read({ conditionName: 'X', severity: 'critical' }), 'severity');
  rejects(() => read({ conditionName: 'X', source: 'google' }), 'source');
  for (const s of ['patient', 'previous_record', 'prescriber', 'pharmacist', 'laboratory', 'other']) {
    assert.equal(read({ conditionName: 'X', source: s }).source, s);
  }
});

test('all six clinical statuses and six verification statuses are accepted', () => {
  for (const s of ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved']) {
    assert.equal(read({ conditionName: 'X', clinicalStatus: s }).clinicalStatus, s);
  }
  for (const v of ['confirmed', 'provisional', 'unconfirmed', 'differential']) {
    assert.equal(read({ conditionName: 'X', verificationStatus: v }).verificationStatus, v);
  }
  rejects(() => read({ conditionName: 'X', clinicalStatus: 'cured' }), 'clinicalStatus');
  rejects(() => read({ conditionName: 'X', verificationStatus: 'likely' }), 'verificationStatus');
});

test('a refuted or erroneous record is never current, and always says why', () => {
  rejects(() => read({ conditionName: 'Asthma', verificationStatus: 'refuted' }), 'statusReason');
  rejects(() => read({ conditionName: 'Asthma', verificationStatus: 'entered_in_error' }), 'statusReason');
  const r = read({
    conditionName: 'Asthma', verificationStatus: 'refuted', clinicalStatus: 'active',
    statusReason: 'Spirometry normal; wheeze was a one-off chest infection.',
  });
  assert.equal(r.clinicalStatus, 'inactive');
});

test('onset at the precision the patient knows it, with a note for what no date says', () => {
  const c = read({ conditionName: 'Asthma', onset: '2019', onsetNote: 'Since childhood' });
  assert.equal(c.onsetDate, '2019-01-01');
  assert.equal(c.onsetPrecision, 'year');
  assert.equal(c.onsetNote, 'Since childhood');
  // Unknown is fine — and a note alone is fine.
  const noteOnly = read({ conditionName: 'Asthma', onsetNote: 'Since childhood' });
  assert.equal(noteOnly.onsetDate, null);
  rejects(() => read({ conditionName: 'X', onset: 'around 2022' }), 'onset');
  rejects(() => read({ conditionName: 'X', onset: '2027' }), 'onset');
});

test('a resolution date belongs only to a resolved, in-remission or inactive condition', () => {
  const resolved = read({ conditionName: 'Malaria', clinicalStatus: 'resolved', onset: '2026-08', abatement: '2026-08-15' });
  assert.equal(resolved.abatementDate, '2026-08-15');
  assert.equal(resolved.abatementPrecision, 'day');
  assert.equal(read({ conditionName: 'X', clinicalStatus: 'remission', abatement: '2025' }).abatementPrecision, 'year');
  // A current condition has not resolved.
  rejects(() => read({ conditionName: 'X', clinicalStatus: 'active', abatement: '2026-08' }), 'abatement');
  // And nothing resolves before it began.
  rejects(() => read({ conditionName: 'X', clinicalStatus: 'resolved', onset: '2026-08', abatement: '2026-07' }), 'abatement');
});

test('a consultation and supporting readings are referenced by id, never copied', () => {
  const enc = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';
  const v1 = '7a2d3c2f-9e5b-4d4f-8c6b-3a6e9f2b1d55';
  const c = read({ conditionName: 'Hypertension', encounterId: enc, evidenceVitalsIds: [v1, v1] });
  assert.equal(c.encounterId, enc);
  assert.deepEqual(c.evidenceVitalsIds, [v1], 'the same reading twice is one link');
  rejects(() => read({ conditionName: 'X', encounterId: 'consultation-1' }), 'encounterId');
  rejects(() => read({ conditionName: 'X', evidenceVitalsIds: 'abc' }), 'evidenceVitalsIds');
  rejects(() => read({ conditionName: 'X', evidenceVitalsIds: ['nope'] }), 'evidenceVitalsIds');
});

test('notes sit beside the structured fields, never instead of them', () => {
  const c = read({
    conditionName: 'Hypertension', verificationStatus: 'provisional',
    notes: 'Diagnosed at a hospital in 2022. Currently taking amlodipine.',
  });
  assert.equal(c.verificationStatus, 'provisional');
  assert.match(c.notes, /amlodipine/);
});

test('"Continue anyway" must be said explicitly', () => {
  assert.equal(read({ conditionName: 'X' }).allowDuplicate, false);
  assert.equal(read({ conditionName: 'X', allowDuplicate: 'yes' }).allowDuplicate, false);
  assert.equal(read({ conditionName: 'X', allowDuplicate: true }).allowDuplicate, true);
});

test('an edit changes only what it names, judged against the stored record', () => {
  const patch = readProblemPatch({ severity: 'severe' }, { today: TODAY });
  assert.deepEqual(patch, { severity: 'severe' });
  rejects(() => readProblemPatch({}, { today: TODAY }), 'body');

  const before = {
    clinicalStatus: 'resolved', verificationStatus: 'confirmed', statusReason: null,
    onsetDate: '2026-08-01', abatementDate: '2026-08-15', abatementPrecision: 'day',
  };
  // Making a resolved condition active again drops the stale resolution date.
  const again = mergeForCheck(before, { clinicalStatus: 'recurrence' });
  assert.equal(again.abatementDate, null);
  assert.equal(again.abatementPrecision, null);
  // Refuting without a reason is refused even though the patch is valid alone.
  rejects(() => mergeForCheck({ ...before, clinicalStatus: 'active', abatementDate: null }, { verificationStatus: 'refuted' }), 'statusReason');
  // Correcting a refuted record back to confirmed drops the stale reason.
  const wasRefuted = { ...before, verificationStatus: 'refuted', clinicalStatus: 'inactive', statusReason: 'x' };
  assert.equal(mergeForCheck(wasRefuted, { verificationStatus: 'confirmed' }).statusReason, null);
});

test('only a pharmacist or owner may confirm, list a differential, or say a record is untrue', () => {
  for (const v of ['unconfirmed', 'provisional']) assert.equal(needsClinicalRole({ verificationStatus: v }), false, v);
  for (const v of ['confirmed', 'differential', 'refuted', 'entered_in_error']) {
    assert.equal(needsClinicalRole({ verificationStatus: v }), true, v);
  }
  assert.equal(needsClinicalRole({ verificationStatus: 'confirmed' }, { verificationStatus: 'confirmed' }), false);
  assert.equal(hasClinicalRole('pharmacist'), true);
  assert.equal(hasClinicalRole('owner'), true);
  assert.equal(hasClinicalRole('staff'), false);
});

test('a symptom or an allergy typed as a condition gets a hint — never a refusal', () => {
  assert.deepEqual(conditionHints('Headache'), ['symptom']);
  assert.deepEqual(conditionHints('persistent cough'), ['symptom']);
  assert.deepEqual(conditionHints('Penicillin allergy'), ['allergy']);
  assert.deepEqual(conditionHints('Allergic to sulfa'), ['allergy']);
  assert.deepEqual(conditionHints('Hypertension'), []);
  // A real condition from the list is never flagged, even with a symptom word.
  assert.deepEqual(conditionHints('Allergic rhinitis').includes('symptom'), false);
  // And the hint changes nothing: the input still reads.
  assert.equal(read({ conditionName: 'Headache' }).conditionName, 'Headache');
});

test('the catalogue searches as typed, and every code in it is shaped like ICD-10', () => {
  assert.equal(searchCatalogue('hypert')[0].name, 'Hypertension');
  // Starts-with first, alphabetically; then a match at a word start.
  assert.deepEqual(searchCatalogue('hyper').map((c) => c.name),
    ['Hyperlipidaemia', 'Hypertension', 'Hyperthyroidism', 'Benign prostatic hyperplasia']);
  assert.equal(searchCatalogue('diab')[0].localCode, 'DIABETES');
  assert.ok(searchCatalogue('arthr').some((c) => c.name === 'Osteoarthritis'));
  assert.deepEqual(searchCatalogue('h'), []);
  for (const c of CATALOGUE) {
    assert.match(c.code, /^[A-Z]\d{2}(\.\d{1,2})?$/, `${c.name} ${c.code}`);
    // No symptom is offered as a condition.
    assert.deepEqual(conditionHints(c.name).includes('symptom'), false, c.name);
  }
  // The house codes are the ones the purchase engine and medications use.
  const locals = new Set(CATALOGUE.map((c) => c.local).filter(Boolean));
  assert.deepEqual([...locals].sort(), ['ASTHMA_OR_COPD', 'DIABETES', 'DYSLIPIDEMIA', 'HYPERTENSION']);
});

test('the options a form offers are exactly what the contract accepts', () => {
  const o = problemOptions();
  for (const { value } of o.categories) assert.doesNotThrow(() => read({ conditionName: 'X', category: value }));
  for (const { value } of o.clinicalStatuses) assert.doesNotThrow(() => read({ conditionName: 'X', clinicalStatus: value }));
  for (const { value } of o.severities) assert.doesNotThrow(() => read({ conditionName: 'X', severity: value }));
  for (const list of Object.values(o)) {
    for (const item of list) assert.deepEqual(Object.keys(item).sort(), ['label', 'value']);
  }
});
