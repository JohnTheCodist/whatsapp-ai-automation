/**
 * The tenant guard.
 *
 * assertPharmacyId is the last thing standing between a bug and a query
 * that runs without a tenant filter. Its whole job is to be impossible to
 * pass accidentally, so these tests are mostly about what it REFUSES.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPharmacyId } = require('../services/db');

const VALID = '11111111-1111-4111-8111-111111111111';

test('accepts a well-formed uuid', () => {
  assert.doesNotThrow(() => assertPharmacyId(VALID));
});

test('accepts an uppercase uuid — case is not identity for uuid', () => {
  assert.doesNotThrow(() => assertPharmacyId(VALID.toUpperCase()));
});

test('rejects the empty-ish values that actually cause leaks', () => {
  // Every one of these is what a forgotten argument or a missing session
  // looks like at the call site.
  for (const value of [undefined, null, '', 0, false, NaN]) {
    assert.throws(
      () => assertPharmacyId(value),
      /Tenant guard/,
      `expected throw for ${JSON.stringify(value)}`
    );
  }
});

test('rejects strings that are not uuids', () => {
  for (const value of ['default', 'all', '*', '1', 'undefined', 'null', VALID.slice(0, 30)]) {
    assert.throws(() => assertPharmacyId(value), /Tenant guard/, `expected throw for ${value}`);
  }
});

test('rejects a uuid with anything appended — no injection through the guard', () => {
  for (const value of [`${VALID} or 1=1`, `${VALID}'--`, `${VALID}\n`, `${VALID} ${VALID}`]) {
    assert.throws(() => assertPharmacyId(value), /Tenant guard/, `expected throw for ${value}`);
  }
});

test('rejects non-string types that could stringify into something plausible', () => {
  for (const value of [{ toString: () => VALID }, [VALID], Symbol('x'), 12345]) {
    assert.throws(() => assertPharmacyId(value), /Tenant guard/);
  }
});

test('the error names the offending value so the bug is findable', () => {
  try {
    assertPharmacyId(undefined);
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /invalid pharmacyId/);
    assert.match(err.message, /undefined/);
  }
});
