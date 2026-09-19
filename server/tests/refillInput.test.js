/**
 * The request-body contract for the refill routes.
 *
 * Every dashboard form sends numbers as strings. If this layer did not turn
 * "30" into 30, the schedule rules would refuse every enrolment typed into
 * the UI while every service test (which passes real numbers) stayed green —
 * the two halves of a contract disagreeing with nothing to notice. The
 * field names are pinned here for the same reason: the WhatsApp-number
 * field that saved nothing for weeks (AGENTS.md, 2026-09-09) was one
 * misspelt key.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  numberOrNull, textOrNull, requireId, readJourneyStart, readDispense, readStop,
} = require('../services/refills/refillInput');
const { daysSupplyFor } = require('../services/refills/refillSchedule');

const TODAY = '2026-09-19';
const UUID = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';

test('a number typed into a form arrives as a number the schedule rules accept', () => {
  const input = readJourneyStart({ medicineName: 'Amlodipine', daysSupply: '30', dispensedOn: '2026-09-10' }, { today: TODAY });
  assert.equal(input.daysSupply, 30);
  // The end-to-end point of this module: the parsed value passes the rule.
  assert.deepEqual(daysSupplyFor(input), { ok: true, days: 30 });
});

test('quantity and dose strings, including decimals, become numbers', () => {
  const input = readJourneyStart({ medicineName: 'X', quantity: ' 45 ', unitsPerDay: '0.5' }, { today: TODAY });
  assert.equal(input.quantity, 45);
  assert.equal(input.unitsPerDay, 0.5);
});

test('an empty field means "not given", not zero', () => {
  // Zero would be refused as "must be more than 0" — the wrong message for a
  // field the pharmacist simply left blank because they used days instead.
  const input = readJourneyStart({ medicineName: 'X', daysSupply: '28', quantity: '', unitsPerDay: '  ' }, { today: TODAY });
  assert.equal(input.quantity, null);
  assert.equal(input.unitsPerDay, null);
  assert.deepEqual(daysSupplyFor(input), { ok: true, days: 28 });
});

test('garbage stays refusable instead of silently becoming "not given"', () => {
  // null here could let the service fall back to quantity × dose the
  // pharmacist never meant to use. NaN is refused by the rule for this field.
  const input = readJourneyStart({ medicineName: 'X', daysSupply: 'thirty' }, { today: TODAY });
  assert.ok(Number.isNaN(input.daysSupply));
  assert.equal(daysSupplyFor(input).ok, false);
});

test('a dispense left undated is recorded as today in Lagos', () => {
  // At the counter the answer is almost always "today"; making it required
  // would add a field to the busiest screen for no information.
  assert.equal(readJourneyStart({ medicineName: 'X', daysSupply: 30 }, { today: TODAY }).dispensedOn, TODAY);
  assert.equal(readDispense({ daysSupply: 30, dispensedOn: '' }, { today: TODAY }).dispensedOn, TODAY);
});

test('a stated dispense date is kept exactly, even a malformed one, so the service can refuse it', () => {
  assert.equal(readDispense({ dispensedOn: '2026-09-01' }, { today: TODAY }).dispensedOn, '2026-09-01');
  assert.equal(readDispense({ dispensedOn: '01/09/2026' }, { today: TODAY }).dispensedOn, '01/09/2026');
});

test('the body field names are the camelCase ones the dashboard sends', () => {
  const start = readJourneyStart({
    productId: UUID, medicineName: ' Lisinopril 10mg ', unitsPerDay: 1, dispensedOn: '2026-09-18', daysSupply: 30, quantity: 30,
  }, { today: TODAY });
  assert.deepEqual(start, {
    productId: UUID, medicineName: 'Lisinopril 10mg', unitsPerDay: 1, dispensedOn: '2026-09-18', daysSupply: 30, quantity: 30,
  });
  // snake_case is not silently accepted as a second shape.
  assert.equal(readJourneyStart({ medicine_name: 'X', days_supply: 30 }, { today: TODAY }).medicineName, null);
  assert.equal(readJourneyStart({ medicine_name: 'X', days_supply: 30 }, { today: TODAY }).daysSupply, null);
});

test('a malformed product id is "not found", never a database error', () => {
  assert.throws(() => readJourneyStart({ productId: 'not-a-uuid', daysSupply: 30 }, { today: TODAY }),
    (err) => err.status === 404 && err.code === 'PRODUCT_NOT_FOUND');
});

test('a malformed path id is the same 404 as a real id from another pharmacy', () => {
  // A different error for a badly formed id would tell a caller which of
  // their guesses were at least well-formed.
  assert.throws(() => requireId('123', 'Customer'), (err) => err.status === 404 && err.code === 'NOT_FOUND');
  assert.throws(() => requireId(undefined), (err) => err.status === 404);
  assert.equal(requireId(UUID), UUID);
});

test('a stop reason is trimmed, and a blank one is no reason at all', () => {
  assert.deepEqual(readStop({ reason: '  Changed by doctor ' }), { reason: 'Changed by doctor' });
  assert.deepEqual(readStop({ reason: '   ' }), { reason: null });
  assert.deepEqual(readStop({}), { reason: null });
});

test('the primitives: numbers pass through, blanks are null, text is trimmed', () => {
  assert.equal(numberOrNull(7), 7);
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(textOrNull('  a '), 'a');
  assert.equal(textOrNull(''), null);
});
