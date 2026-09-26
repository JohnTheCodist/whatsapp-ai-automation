/**
 * The care-details request body: what the profile form sends, and what the
 * service receives. Dashboard forms send "45" and ""; the service wants 45
 * and null. A key that is absent must stay absent, or saving just the
 * gender would also wipe the age.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCareInput } = require('../services/customers/careInput');

const UUID = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';

function rejects(body, field) {
  assert.throws(() => readCareInput(body), (err) => err.status === 400 && err.field === field);
}

test('only the keys sent are returned, so saving one field never clears another', () => {
  assert.deepEqual(readCareInput({ sex: 'female' }), { sex: 'female' });
  assert.deepEqual(readCareInput({}), {});
});

test('an age typed into a form arrives as a whole number', () => {
  assert.deepEqual(readCareInput({ ageYears: '45' }), { ageYears: 45 });
  assert.deepEqual(readCareInput({ ageYears: 0 }), { ageYears: 0 });
});

test('blanking a field clears it, rather than being ignored', () => {
  assert.deepEqual(readCareInput({ ageYears: '', sex: '', assignedPharmacistId: '' }), {
    ageYears: null, sex: null, assignedPharmacistId: null,
  });
});

test('impossible ages are refused, not clamped', () => {
  for (const bad of ['-1', '131', '45.5', 'forty', NaN]) rejects({ ageYears: bad }, 'ageYears');
});

test('gender is female or male or blank; "unknown" is a blank, not a choice staff make', () => {
  assert.deepEqual(readCareInput({ sex: 'Female' }), { sex: 'female' });
  rejects({ sex: 'unknown' }, 'sex');
  rejects({ sex: 'f' }, 'sex');
});

test('an assignee is a user id or nothing', () => {
  assert.deepEqual(readCareInput({ assignedPharmacistId: UUID }), { assignedPharmacistId: UUID });
  assert.deepEqual(readCareInput({ assignedPharmacistId: null }), { assignedPharmacistId: null });
  rejects({ assignedPharmacistId: 'Ade' }, 'assignedPharmacistId');
});
