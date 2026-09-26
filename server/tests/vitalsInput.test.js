/**
 * The request body for a vitals reading.
 *
 * A form sends strings, and an untouched box sends "". The failure this
 * defends against is that empty box becoming a stored ZERO — a pulse of 0
 * on a living patient's chart, which the table would then colour red and
 * the chart would plot at the floor.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readVitalsInput } = require('../services/clinical/vitalsInput');

function rejects(body, field) {
  assert.throws(() => readVitalsInput(body), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_READING');
    assert.equal(err.field, field);
    return true;
  });
}

test('a form\'s strings become numbers, and its empty boxes become absent', () => {
  const r = readVitalsInput({
    systolic: '120', diastolic: '80', pulse: '88', spo2: '', respiratoryRate: '18',
    temperature: '36.8', weight: '60', height: '150', muac: '',
  });
  assert.equal(r.systolic, 120);
  assert.equal(r.pulse, 88);
  assert.equal(r.temperature, 36.8);
  assert.equal(r.weight, 60);
  // THE TEST THAT MATTERS: an untouched box is null, never 0.
  assert.equal(r.spo2, null);
  assert.equal(r.muac, null);
});

test('an empty form is refused, so a mis-click cannot become a dated blank', () => {
  rejects({}, 'reading');
  rejects({ systolic: '', pulse: '', notes: 'nothing taken' }, 'reading');
});

test('a blood pressure needs both of its numbers', () => {
  // Half a blood pressure is not a reading, and it would draw a line with
  // one end on the chart.
  rejects({ systolic: '120' }, 'diastolic');
  rejects({ diastolic: '80' }, 'systolic');
  // And the diastolic is the lower of the two, always.
  rejects({ systolic: '80', diastolic: '120' }, 'diastolic');
  rejects({ systolic: '120', diastolic: '120' }, 'diastolic');
});

test('an alarming reading stores; an impossible one is refused and names its field', () => {
  // 190/110 is a hypertensive crisis and must reach the record.
  assert.equal(readVitalsInput({ systolic: '190', diastolic: '110' }).systolic, 190);
  assert.equal(readVitalsInput({ pulse: '190' }).pulse, 190);
  assert.equal(readVitalsInput({ temperature: '41.5' }).temperature, 41.5);
  // These are typing mistakes, not patients.
  rejects({ systolic: '12', diastolic: '8' }, 'systolic');
  rejects({ pulse: '900' }, 'pulse');
  rejects({ temperature: '368' }, 'temperature');
  rejects({ pulse: 'fast' }, 'pulse');
});

test('numbers are rounded to what the column holds, so what comes back is what was sent', () => {
  assert.equal(readVitalsInput({ pulse: '88.6' }).pulse, 89);
  assert.equal(readVitalsInput({ temperature: '36.849' }).temperature, 36.8);
  assert.equal(readVitalsInput({ weight: '60.44' }).weight, 60.4);
});

test('a reading cannot have been taken in the future', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(readVitalsInput({ pulse: '80', recordedAt: past }).recordedAt, past);
  rejects({ pulse: '80', recordedAt: new Date(Date.now() + 86_400_000).toISOString() }, 'recordedAt');
  rejects({ pulse: '80', recordedAt: 'tuesday' }, 'recordedAt');
  // Absent means "now", decided by the database rather than the browser's
  // clock, which may be set to anything.
  assert.equal(readVitalsInput({ pulse: '80' }).recordedAt, null);
});

test('notes are trimmed, optional, and bounded', () => {
  assert.equal(readVitalsInput({ pulse: '80', notes: '  feels unwell  ' }).notes, 'feels unwell');
  assert.equal(readVitalsInput({ pulse: '80', notes: '   ' }).notes, null);
  rejects({ pulse: '80', notes: 'x'.repeat(1001) }, 'notes');
});
