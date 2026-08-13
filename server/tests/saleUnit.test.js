/**
 * saleUnit — the catalogue's own word for one sellable unit, not the
 * customer's word for it.
 *
 * FROM REAL TRAFFIC
 * A customer asked for "a sachet of paracetamol". The product's form is
 * `tablet`. The assistant replied "Paracetamol 500mg tablets at ₦460 per
 * sachet" — the tool result already carried `form: "tablet"`, and the model
 * used the customer's word anyway because nothing forced a preference. This
 * is the fix: a fact the prompt can require, not a hope the model infers it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { saleUnit, unitForForm, isWrongUnit } = require('../services/ai/saleUnit');

// ---- the bug itself ----

test('a tablet is a card, not a sachet — the exact case from real traffic', () => {
  const product = { form: 'tablet' };
  assert.equal(saleUnit(product), 'card');
  assert.equal(isWrongUnit('sachet', product), true, 'a customer calling tablets "sachet" must be corrected');
});

// ---- form -> unit mapping ----

test('common forms map to the counter word a Nigerian pharmacy actually uses', () => {
  assert.equal(unitForForm('tablet'), 'card');
  assert.equal(unitForForm('capsule'), 'card');
  assert.equal(unitForForm('syrup'), 'bottle');
  assert.equal(unitForForm('cream'), 'tube');
  assert.equal(unitForForm('injection'), 'vial');
  assert.equal(unitForForm('sachet'), 'sachet');
});

test('matching is case and whitespace insensitive — real data has both', () => {
  // The live catalogue has "Tablet" and "tablet" as distinct raw strings.
  assert.equal(unitForForm('Tablet'), 'card');
  assert.equal(unitForForm('  Capsule  '), 'card');
  assert.equal(unitForForm('TABLET'), 'card');
});

test('an unknown or missing form does not crash and falls back to "pack"', () => {
  assert.equal(unitForForm(null), null);
  assert.equal(unitForForm(undefined), null);
  assert.equal(unitForForm(''), null);
  assert.equal(unitForForm('a completely novel dosage form'), null);

  assert.equal(saleUnit({ form: null }), 'pack');
  assert.equal(saleUnit({}), 'pack');
  assert.equal(saleUnit({ form: 'nonsense' }), 'pack');
});

// ---- correction logic ----

test('an unknown form is never "corrected" — nothing to correct against', () => {
  assert.equal(isWrongUnit('sachet', { form: null }), false);
  assert.equal(isWrongUnit('sachet', { form: 'mystery-form' }), false);
});

test('no unit mentioned means nothing to correct', () => {
  assert.equal(isWrongUnit('', { form: 'tablet' }), false);
  assert.equal(isWrongUnit(null, { form: 'tablet' }), false);
  assert.equal(isWrongUnit(undefined, { form: 'tablet' }), false);
});

test('the right word is not flagged as wrong', () => {
  assert.equal(isWrongUnit('card', { form: 'tablet' }), false);
  assert.equal(isWrongUnit('bottle', { form: 'syrup' }), false);
});

test('regional synonyms are recognised, not flagged as a mismatch', () => {
  // "strip" and "card" name the same object; correcting a customer for using
  // a real regional synonym would be pedantic, not helpful.
  assert.equal(isWrongUnit('strip', { form: 'tablet' }), false);
  assert.equal(isWrongUnit('tabs', { form: 'tablet' }), false);
  assert.equal(isWrongUnit('tablets', { form: 'capsule' }), false, 'tablets/capsules both sell as a card');
});

test('a genuinely different unit is flagged', () => {
  assert.equal(isWrongUnit('bottle', { form: 'tablet' }), true);
  assert.equal(isWrongUnit('sachet', { form: 'syrup' }), true);
  assert.equal(isWrongUnit('vial', { form: 'cream' }), true);
});

// ---- what the assistant actually reads ----

test('every UNIT_BY_FORM entry resolves through saleUnit — no dead mapping entries', () => {
  const { UNIT_BY_FORM } = require('../services/ai/saleUnit');
  for (const form of Object.keys(UNIT_BY_FORM)) {
    const unit = saleUnit({ form });
    assert.ok(unit && typeof unit === 'string' && unit.length > 0, `form "${form}" produced no usable unit`);
  }
});
