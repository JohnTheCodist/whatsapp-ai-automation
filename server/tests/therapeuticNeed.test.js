/**
 * Natural language -> NAFDAC's controlled therapeutic subgroup vocabulary.
 *
 * WHAT THIS FILE IS DEFENDING
 * Two opposite failures, and the tests are split along that line because
 * fixing either one carelessly causes the other:
 *
 *   TOO NARROW — "blood pressure medicine" finds nothing because the
 *     catalogue row says "Amlodipine 10mg / Cardio" and no string in it
 *     resembles the request. That is the gap this map exists to close.
 *
 *   TOO WIDE — "chest pain" contains the word "pain", resolves to Analgesic,
 *     and the assistant offers painkillers for a possible cardiac event.
 *     clinicalFilter ALLOWS "chest pain" (verified directly — it blocks
 *     "i have fever" but not this), so nothing upstream would catch it.
 *
 * Pure module, so no database and no skip guard: these run everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  subgroupsFor, isRefusedNeed, isKnownSubgroup, SUBGROUPS, NEED_SUBGROUP,
} = require('../services/ai/therapeuticNeed');

// ---- the vocabulary is genuinely controlled ----

test('every mapping target is a real NAFDAC subgroup, not free text', () => {
  // The property that makes this "controlled" rather than a second pile of
  // guesses: a typo produces zero matches, never a plausible wrong shelf.
  for (const entry of NEED_SUBGROUP) {
    assert.ok(
      isKnownSubgroup(entry.subgroup),
      `"${entry.subgroup}" is not in the NAFDAC vocabulary — terms: ${entry.terms.join(', ')}`,
    );
  }
});

test('subgroupsFor only ever returns controlled values', () => {
  for (const need of ['pain', 'malaria', 'bp', 'vitamins', 'worms', 'asthma inhaler']) {
    for (const s of subgroupsFor(need)) {
      assert.ok(isKnownSubgroup(s), `${need} produced non-vocabulary value "${s}"`);
    }
  }
});

test('an unrecognised need returns nothing rather than guessing', () => {
  // [] must mean "this map has no opinion" — the caller falls back to text
  // search. It must never be read as "nothing is available".
  assert.deepEqual(subgroupsFor('xyzzy'), []);
  assert.deepEqual(subgroupsFor(''), []);
  assert.deepEqual(subgroupsFor(null), []);
});

// ---- the mappings a Nigerian pharmacy actually needs ----

test('everyday phrasing reaches the right shelf', () => {
  const cases = [
    ['blood pressure medicine', 'Hypertension'],
    ['bp', 'Hypertension'],
    ['do you have painkillers', 'Analgesic'],
    ['something for pain', 'Analgesic'],
    ['malaria drugs', 'Anti-Malarial'],
    ['antimalarial', 'Anti-Malarial'],
    ['i need vitamins', 'Vitamin / Mineral'],
    ['deworming tablets', 'Anthelmintic'],
    ['antibiotics', 'Antibiotic'],
    ['diabetes medicine', 'Diabetes'],
    ['cholesterol', 'Lipid-Lowering'],
    ['asthma inhaler', 'Asthma / COPD Agent'],
    ['ors', 'Oral Rehydration Therapy'],
    ['family planning', 'Contraceptive'],
  ];
  for (const [need, expected] of cases) {
    assert.ok(
      subgroupsFor(need).includes(expected),
      `"${need}" should reach ${expected}, got ${JSON.stringify(subgroupsFor(need))}`,
    );
  }
});

test('naming a subgroup directly works without a synonym row', () => {
  assert.ok(subgroupsFor('anthelmintic').includes('Anthelmintic'));
  assert.ok(subgroupsFor('do you stock any antiglaucoma agent').includes('Antiglaucoma Agent'));
});

test('"other" is never matched, even though it is a real NAFDAC value', () => {
  // 'Other' means "unclassified". Matching it would let an unrelated grab bag
  // answer a specific request.
  assert.deepEqual(subgroupsFor('other'), []);
  assert.ok(!subgroupsFor('something other than that').includes('Other'));
});

// ---- precision: short abbreviations must not bleed ----

test('"bp" does not also return prostate medicine', () => {
  // "bp" is a substring of the term "bph". A two-way substring test returned
  // blood-pressure AND prostate medicine from two characters; word-boundary
  // matching is what separates them.
  const r = subgroupsFor('bp');
  assert.ok(r.includes('Hypertension'));
  assert.ok(!r.includes('BPH Agent'), `"bp" must not mean prostate: ${JSON.stringify(r)}`);
});

test('"bph" still reaches the prostate shelf', () => {
  assert.ok(subgroupsFor('bph').includes('BPH Agent'));
  assert.ok(subgroupsFor('prostate').includes('BPH Agent'));
});

test('plurals match without every plural being listed', () => {
  assert.ok(subgroupsFor('painkillers').includes('Analgesic'));
  assert.ok(subgroupsFor('vitamins').includes('Vitamin / Mineral'));
  assert.ok(subgroupsFor('antibiotics').includes('Antibiotic'));
});

// ---- the safety boundary ----

test('NO symptom maps to a treatment shelf', () => {
  // The inference this system exists never to make. "fever" is deliberately
  // absent even though including it would make malaria searches hit more
  // often — deciding a fever means malaria is a diagnosis.
  for (const symptom of ['fever', 'i have fever', 'high temperature', 'feeling weak', 'dizzy', 'vomiting']) {
    const resolved = isRefusedNeed(symptom) ? [] : subgroupsFor(symptom);
    assert.deepEqual(resolved, [], `"${symptom}" must not resolve to a shelf, got ${JSON.stringify(resolved)}`);
  }
});

test('red-flag complaints are REFUSED, not mapped', () => {
  // Each of these would otherwise reach a shelf through an ordinary word:
  // "chest pain" through "pain", "coughing blood" through "cough".
  for (const need of [
    'chest pain',
    'pain in my chest',
    'chest tightness',
    'difficulty breathing',
    'shortness of breath',
    'coughing blood',
    'i think i am having a stroke',
    'she is unconscious',
    'having a seizure',
    'severe abdominal pain',
  ]) {
    assert.equal(isRefusedNeed(need), true, `"${need}" must be refused outright`);
  }
});

test('describing your own condition is refused, naming a product is not', () => {
  // The distinction is who the sentence is about: a body or a shelf.
  assert.equal(isRefusedNeed('i have a terrible headache'), true);
  assert.equal(isRefusedNeed('my child has a rash'), true);
  assert.equal(isRefusedNeed('i am feeling very weak'), true);

  assert.equal(isRefusedNeed('do you have painkillers'), false);
  assert.equal(isRefusedNeed('something for back pain'), false);
  assert.equal(isRefusedNeed('blood pressure medicine'), false);
  assert.equal(isRefusedNeed('i need vitamins'), false, 'an ordinary purchase must not be refused');
  assert.equal(isRefusedNeed('i want to buy paracetamol'), false, 'buying is not a symptom report');
});

test('the guard does not swallow ordinary retail language', () => {
  // Over-blocking recreates the rigidity this feature exists to remove, so
  // this is asserted explicitly rather than left to judgement.
  const ordinary = [
    'do you have painkillers', 'something for pain', 'malaria drugs', 'cough syrup',
    'antibiotics', 'vitamins', 'blood pressure medicine', 'deworming tablets',
    'antacid', 'ors', 'family planning', 'asthma inhaler',
  ];
  for (const need of ordinary) {
    assert.equal(isRefusedNeed(need), false, `"${need}" is a normal request and must go through`);
    assert.ok(subgroupsFor(need).length > 0, `"${need}" should resolve to a shelf`);
  }
});

test('the full vocabulary is exposed, including subgroups nothing maps to yet', () => {
  // The file should state the whole permitted set, not only the reachable
  // part — otherwise a future mapping has no list to be checked against.
  assert.equal(SUBGROUPS.length, 39);
  for (const s of ['Hemostatic Agent', 'Uterotonic', 'IV Drug', 'CNS Agent']) {
    assert.ok(SUBGROUPS.includes(s), `${s} missing from the declared vocabulary`);
  }
});
