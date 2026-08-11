/**
 * Everyday words -> catalogue category words.
 *
 * FROM A REAL GAP
 * browse_category matched "malaria" and returned nothing for "pain", because
 * the catalogue shelf is labelled "Analgesic". The feature worked only where
 * the clinical name happened to be the common one, and an empty result reads
 * to a customer as an empty shop.
 *
 * The tests that matter most are the ones asserting what is NOT mapped. This
 * table is a dictionary; the moment it starts mapping a symptom to a
 * treatment it has become a diagnosis, which is the one thing this system is
 * built never to do.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { categoriesFor } = require('../services/ai/needVocabulary');

test('everyday words reach the clinical shelf name', () => {
  assert.ok(categoriesFor('pain').includes('analgesic'));
  assert.ok(categoriesFor('painkiller').includes('analgesic'));
  assert.ok(categoriesFor('headache').includes('analgesic'));
  assert.ok(categoriesFor('infection').includes('antibiotic'));
  assert.ok(categoriesFor('cough').includes('cold & flu'));
  assert.ok(categoriesFor('vitamins').includes('supplement'));
});

test('the original word is always kept', () => {
  // A customer who says "antimalarial" must match a catalogue that also says
  // antimalarial, with or without the map.
  assert.ok(categoriesFor('antimalarial').includes('antimalarial'));
  assert.ok(categoriesFor('somethingunmapped').includes('somethingunmapped'));
});

test('a phrase containing the term still matches', () => {
  assert.ok(categoriesFor('something for pain').includes('analgesic'));
  assert.ok(categoriesFor('do you have anything for cough').includes('cold & flu'));
});

test('case and spacing do not matter', () => {
  assert.ok(categoriesFor('  PAIN  ').includes('analgesic'));
  assert.ok(categoriesFor('Blood Pressure').includes('antihypertensive'));
});

// ---- the boundary this file exists to hold ----

test('SYMPTOMS ARE NOT MAPPED TO TREATMENTS', () => {
  // "fever" would make malaria searches match more often and is exactly the
  // inference that must never be automated: deciding a fever means malaria
  // is a diagnosis. A customer saying this gets a pharmacist, not a shelf.
  const fever = categoriesFor('fever');
  assert.deepEqual(fever, ['fever'], 'fever must map to nothing but itself');

  for (const symptom of ['tired', 'weak', 'dizzy', 'vomiting', 'chest pain']) {
    const got = categoriesFor(symptom);
    assert.ok(
      !got.includes('antimalarial') && !got.includes('antibiotic'),
      `"${symptom}" must not resolve to a treatment class — that is a diagnosis`,
    );
  }
});

test('empty input yields nothing rather than everything', () => {
  assert.deepEqual(categoriesFor(''), []);
  assert.deepEqual(categoriesFor(null), []);
  assert.deepEqual(categoriesFor(undefined), []);
});

test('no duplicate terms are returned', () => {
  const terms = categoriesFor('analgesic');
  assert.equal(new Set(terms).size, terms.length);
});
