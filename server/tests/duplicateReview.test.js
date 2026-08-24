/**
 * Which near-identical product names are worth asking a pharmacist about.
 *
 * WHERE THIS SITS, AND WHY IT IS ALLOWED TO BE EAGER
 * productBuilder already collapses a typo when NAFDAC can confirm it: one
 * spelling resolves to a registered generic, the other is a short edit away,
 * and nothing else is close enough to be ambiguous. That path MERGES rows, so
 * it is deliberately conservative.
 *
 * This module handles what NAFDAC cannot settle — names the registry has
 * never heard of, which it often has not, because it does not list every drug
 * on the Nigerian market. It merges nothing. It only asks a person to look.
 * That difference is why the rule here can be looser than the one that
 * decides identity: the worst outcome is a pharmacist glancing at two names
 * and deciding they are genuinely different.
 *
 * The rule still has to be tight enough to be worth reading. A panel that
 * lists every vaguely similar pair is a panel nobody opens.
 *
 * Pure: no database, no clock, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeTypo } = require('../services/catalogue/duplicateReview');

// The inputs are already normalised text by the time looksLikeTypo sees them
// — lowercase, punctuation stripped — so these read the way the function is
// actually called from findUnverifiedDuplicates.

// ---- the case this exists for ----

test('a one-letter transposition is flagged', () => {
  assert.equal(looksLikeTypo('cirpofloxacin', 'ciprofloxacin'), true);
});

test('a single dropped letter is flagged', () => {
  assert.equal(looksLikeTypo('amoxicilin', 'amoxicillin'), true);
});

test('two edits in a long name are still flagged', () => {
  assert.equal(looksLikeTypo('paracetamoll', 'paracetemol'), true);
});

// ---- what it refuses, so the panel stays worth reading ----

test('identical names are not a pair — they are one product', () => {
  assert.equal(looksLikeTypo('ciprofloxacin', 'ciprofloxacin'), false);
});

test('genuinely different products are not flagged', () => {
  assert.equal(looksLikeTypo('metformin', 'amlodipine'), false);
  assert.equal(looksLikeTypo('vitamin c', 'zinc tablets'), false);
});

test('short names are never compared — two edits reaches everything', () => {
  // "zinc" and "zafi" are one or two edits apart and completely unrelated.
  // Below six characters the distance stops carrying information.
  assert.equal(looksLikeTypo('zinc', 'zafi'), false);
  assert.equal(looksLikeTypo('cofta', 'cifta'), false);
});

test('a big length difference is refused before the distance is even measured', () => {
  assert.equal(looksLikeTypo('paracetamol', 'paracetamol extra strength'), false);
});

test('three edits is too many, even in a long name', () => {
  assert.equal(looksLikeTypo('chloroquine', 'chlorpromazi'), false);
});

/**
 * The look-alike-sound-alike question, stated explicitly because it is the
 * reason the merging path next door is so careful.
 *
 * Prednisone and Prednisolone ARE two different medicines two edits apart, so
 * this rule does flag them. That is correct HERE and would be a serious bug
 * in productBuilder: this panel shows a pharmacist two names and asks, it
 * never rewrites a natural_key.
 *
 * And in practice the pair cannot reach a reader at all: findUnverifiedDuplicates
 * drops any pair NAFDAC can name on BOTH sides, and both of these are
 * registered. That filter asks the registry live and is deliberately NOT a
 * stored data flag — the flag that looked like it meant "the reference data
 * does not know this product" actually meant something much weaker, and
 * filtering on it let exactly this kind of pair through.
 */
test('a real look-alike pair is only ever surfaced for review, never merged', () => {
  assert.equal(looksLikeTypo('prednisone', 'prednisolone'), true);
});
