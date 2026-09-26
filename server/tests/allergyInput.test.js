/**
 * The contract for an allergy record.
 *
 * What these defend against, in order of cost: a record that says it is
 * wrong yet still shows as a current allergy; a reaction severity and a
 * future-exposure risk collapsed into one field; every adverse reaction
 * silently filed as an allergy; and a half-known date refused, so the
 * allergy goes unrecorded rather than recorded as "~2021".
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MANIFESTATIONS, COMMON_ALLERGENS,
  readAllergyInput, readAllergyPatch, mergeForCheck, needsClinicalRole, hasClinicalRole,
  allergyOptions, partialDate,
} = require('../services/clinical/allergyInput');

const TODAY = '2026-09-22';
const read = (body) => readAllergyInput(body, { today: TODAY });

function rejects(fn, field) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_ALLERGY');
    assert.equal(err.field, field);
    return true;
  });
}

test('an allergy needs only an allergen — and the defaults are the honest ones', () => {
  const a = read({ allergenName: 'Penicillin' });
  assert.equal(a.allergenName, 'Penicillin');
  // Not every reaction is an allergy, and nobody has checked yet.
  assert.equal(a.type, 'unknown');
  assert.equal(a.verificationStatus, 'unconfirmed');
  assert.equal(a.category, 'unknown');
  assert.equal(a.clinicalStatus, 'active');
  // Nothing about the danger is assumed.
  assert.equal(a.severity, null);
  assert.equal(a.criticality, null);
  assert.deepEqual(a.reactions, []);
  rejects(() => read({}), 'allergenName');
  rejects(() => read({ allergenName: '   ' }), 'allergenName');
});

test('the allergen may be free text, or a code picked from a list', () => {
  assert.equal(read({ allergenName: 'The blue cough syrup' }).allergenCode, null);
  assert.equal(read({ allergenName: 'Amoxicillin', allergenCode: 'nafdac:amoxicillin' }).allergenCode, 'nafdac:amoxicillin');
  assert.equal(read({ allergenName: 'Peanuts', allergenCode: 'common:peanut' }).allergenCode, 'common:peanut');
  rejects(() => read({ allergenName: 'X', allergenCode: 'snomed:123' }), 'allergenCode');
});

test('allergy, intolerance and unknown are three answers', () => {
  // Nausea from metformin is an intolerance. Filed as an allergy, it teaches
  // the next pharmacist to avoid a drug the patient can take.
  assert.equal(read({ allergenName: 'Metformin', type: 'intolerance' }).type, 'intolerance');
  assert.equal(read({ allergenName: 'Penicillin', type: 'allergy' }).type, 'allergy');
  rejects(() => read({ allergenName: 'X', type: 'sensitivity' }), 'type');
  for (const c of ['medication', 'food', 'environmental', 'biologic', 'other', 'unknown']) {
    assert.equal(read({ allergenName: 'X', category: c }).category, c);
  }
  rejects(() => read({ allergenName: 'X', category: 'drug' }), 'category');
});

test('one allergy carries several reactions, in the order they were entered', () => {
  const a = read({
    allergenName: 'Amoxicillin',
    reactions: ['rash', { manifestation: 'facial_swelling' }, 'itching'],
  });
  assert.deepEqual(a.reactions.map((r) => r.manifestation), ['rash', 'facial_swelling', 'itching']);
  // The same reaction twice is a double-click.
  rejects(() => read({ allergenName: 'X', reactions: ['rash', 'rash'] }), 'reactions');
  rejects(() => read({ allergenName: 'X', reactions: ['sneezing'] }), 'reactions');
  rejects(() => read({ allergenName: 'X', reactions: 'rash' }), 'reactions');
});

test('"Other" reaction must say what it was — and may appear more than once', () => {
  rejects(() => read({ allergenName: 'X', reactions: ['other'] }), 'otherReaction');
  const a = read({
    allergenName: 'X',
    reactions: [
      { manifestation: 'other', description: 'Joint pain' },
      { manifestation: 'other', description: 'Blurred vision' },
    ],
  });
  assert.equal(a.reactions.length, 2);
  assert.equal(a.reactions[1].description, 'Blurred vision');
});

test('severity and criticality are separate fields, with separate vocabularies', () => {
  // A mild rash to penicillin can still be high criticality: severity is the
  // last reaction, criticality is the next exposure.
  const a = read({ allergenName: 'Penicillin', severity: 'mild', criticality: 'high' });
  assert.equal(a.severity, 'mild');
  assert.equal(a.criticality, 'high');
  rejects(() => read({ allergenName: 'X', severity: 'high' }), 'severity');
  rejects(() => read({ allergenName: 'X', criticality: 'severe' }), 'criticality');
  assert.equal(read({ allergenName: 'X', criticality: 'unable_to_assess' }).criticality, 'unable_to_assess');
});

test('a record that is refuted or in error is never a current allergy, and always says why', () => {
  rejects(() => read({ allergenName: 'Penicillin', verificationStatus: 'refuted' }), 'statusReason');
  rejects(() => read({ allergenName: 'Penicillin', verificationStatus: 'entered_in_error' }), 'statusReason');

  const refuted = read({
    allergenName: 'Penicillin', verificationStatus: 'refuted',
    statusReason: 'Tolerated a full amoxicillin course in 2025.',
  });
  // Even if the form sent active, an untrue record is not current.
  assert.notEqual(refuted.clinicalStatus, 'active');
  const forced = read({
    allergenName: 'Penicillin', verificationStatus: 'refuted', clinicalStatus: 'active', statusReason: 'x',
  });
  assert.equal(forced.clinicalStatus, 'inactive');
});

test('a patient\'s half-remembered date is recorded at the precision they gave', () => {
  assert.deepEqual(partialDate('onset', '2021', TODAY), { date: '2021-01-01', precision: 'year' });
  assert.deepEqual(partialDate('onset', '2021-03', TODAY), { date: '2021-03-01', precision: 'month' });
  assert.deepEqual(partialDate('onset', '2021-03-15', TODAY), { date: '2021-03-15', precision: 'day' });
  // Unknown is a real answer.
  assert.deepEqual(partialDate('onset', '', TODAY), { date: null, precision: null });
  assert.deepEqual(partialDate('onset', null, TODAY), { date: null, precision: null });

  rejects(() => partialDate('onset', 'about 5 years ago', TODAY), 'onset');
  rejects(() => partialDate('onset', '2021-02-30', TODAY), 'onset');
  rejects(() => partialDate('onset', '2027', TODAY), 'onset');
  // This year is fine even though Jan 1 of it has passed — compared at the
  // precision given, "2026" is not in the future.
  assert.equal(partialDate('onset', '2026', TODAY).precision, 'year');
  assert.equal(partialDate('onset', '2026-09', TODAY).precision, 'month');
  rejects(() => partialDate('onset', '2026-10', TODAY), 'onset');
});

test('the last reaction cannot come before the first', () => {
  rejects(() => read({ allergenName: 'X', onset: '2023', lastOccurrence: '2021' }), 'lastOccurrence');
  const a = read({ allergenName: 'X', onset: '2021', lastOccurrence: '2023-06' });
  assert.equal(a.onsetPrecision, 'year');
  assert.equal(a.lastOccurrencePrecision, 'month');
});

test('where it came from is recorded, and defaults to the patient', () => {
  assert.equal(read({ allergenName: 'X' }).source, 'patient');
  for (const s of ['patient', 'guardian', 'previous_record', 'prescriber', 'pharmacist', 'other']) {
    assert.equal(read({ allergenName: 'X', source: s }).source, s);
  }
  rejects(() => read({ allergenName: 'X', source: 'google' }), 'source');
});

test('an edit changes only what it names; reactions, when sent, are replaced', () => {
  const patch = readAllergyPatch({ severity: 'severe', reactions: ['wheezing'] }, { today: TODAY });
  assert.deepEqual(Object.keys(patch).sort(), ['reactions', 'severity']);
  assert.deepEqual(patch.reactions.map((r) => r.manifestation), ['wheezing']);
  // Clearing a date is an edit, not nothing.
  assert.deepEqual(readAllergyPatch({ onset: '' }, { today: TODAY }), { onsetDate: null, onsetPrecision: null });
  rejects(() => readAllergyPatch({}, { today: TODAY }), 'body');
  rejects(() => readAllergyPatch({ allergenName: '' }, { today: TODAY }), 'allergenName');
});

test('an edit is judged against the stored record, not just what it sends', () => {
  const before = {
    verificationStatus: 'confirmed', clinicalStatus: 'active', statusReason: null,
    onsetDate: '2021-01-01', lastOccurrenceDate: null,
  };
  // Refuting without a reason is refused even though the patch is "valid".
  rejects(() => mergeForCheck(before, { verificationStatus: 'refuted' }), 'statusReason');
  const ok = mergeForCheck(before, { verificationStatus: 'refuted', statusReason: 'Challenge test negative' });
  assert.equal(ok.clinicalStatus, 'inactive');

  // Moving the last occurrence before the stored onset is caught too.
  rejects(() => mergeForCheck(before, { lastOccurrenceDate: '2019-01-01' }), 'lastOccurrence');

  // Correcting a refuted record back to confirmed drops the stale reason.
  const wasRefuted = { ...before, verificationStatus: 'refuted', clinicalStatus: 'inactive', statusReason: 'x' };
  const back = mergeForCheck(wasRefuted, { verificationStatus: 'confirmed' });
  assert.equal(back.statusReason, null);
});

test('only a pharmacist or owner may say a record is true or untrue', () => {
  // Writing down what the patient said is open to anyone.
  assert.equal(needsClinicalRole({ verificationStatus: 'unconfirmed' }), false);
  assert.equal(needsClinicalRole({ severity: 'mild' }), false);
  for (const v of ['confirmed', 'refuted', 'entered_in_error']) {
    assert.equal(needsClinicalRole({ verificationStatus: v }), true, v);
  }
  // Re-saving the same verification is not a new claim.
  assert.equal(needsClinicalRole({ verificationStatus: 'confirmed' }, { verificationStatus: 'confirmed' }), false);
  assert.equal(hasClinicalRole('pharmacist'), true);
  assert.equal(hasClinicalRole('owner'), true);
  assert.equal(hasClinicalRole('staff'), false);
  assert.equal(hasClinicalRole(undefined), false);
});

test('the options a form offers are exactly what the contract accepts', () => {
  const o = allergyOptions();
  assert.equal(o.manifestations.length, 15);
  assert.deepEqual(MANIFESTATIONS.map((m) => m.value).slice(0, 3), ['rash', 'hives', 'itching']);
  for (const { value } of o.categories) assert.doesNotThrow(() => read({ allergenName: 'X', category: value }));
  for (const { value } of o.severities) assert.doesNotThrow(() => read({ allergenName: 'X', severity: value }));
  for (const { value } of o.criticalities) assert.doesNotThrow(() => read({ allergenName: 'X', criticality: value }));
  for (const { value } of o.sources) assert.doesNotThrow(() => read({ allergenName: 'X', source: value }));
  for (const { value } of o.exposureRoutes) assert.doesNotThrow(() => read({ allergenName: 'X', exposureRoute: value }));
  // Nothing in the vocabulary ranks: labels only.
  for (const list of Object.values(o)) {
    for (const item of list) assert.deepEqual(Object.keys(item).sort(), ['label', 'value']);
  }
});

test('the common-allergen list holds drug CLASSES but no individual medicine', () => {
  // Individual medicines come from the NAFDAC register; this list must not
  // become a second, hand-kept drug list. A class (penicillins, sulfa) is
  // the one medication allergen the register cannot offer.
  for (const a of COMMON_ALLERGENS) {
    if (a.category === 'medication') assert.equal(a.drugClass, true, `${a.key} is a medicine, not a class`);
    else assert.ok(['food', 'environmental'].includes(a.category), a.key);
    assert.doesNotThrow(() => read({ allergenName: a.label, allergenCode: `common:${a.key}`, category: a.category }));
  }
});
