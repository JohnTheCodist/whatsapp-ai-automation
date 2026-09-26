/**
 * What a vital sign means: the reference ranges, BMI, and when a number is
 * shown as unusual.
 *
 * THE FAILURE THIS DEFENDS AGAINST is a red number that should not be red,
 * or a black one that should not be black. Both teach staff to stop reading
 * the colour, and the second one does it silently. The child rule below is
 * the sharpest case: a toddler's pulse of 120 is ordinary, and an adult
 * table applied to them would flag every healthy child in the register.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VITALS, vital, bmi, bmiClass, abnormalFlags, flagLabel,
} = require('../services/clinical/vitalRanges');

test('every vital carries its own unit, and nothing infers one from a number', () => {
  for (const v of VITALS) {
    assert.ok(v.unit, `${v.key} has a unit`);
    assert.ok(v.label, `${v.key} has a label`);
    assert.ok(Array.isArray(v.range) && v.range.length === 2, `${v.key} has plausibility bounds`);
    assert.ok(v.range[0] < v.range[1], `${v.key} bounds are the right way round`);
  }
  assert.equal(vital('nope'), null);
});

test('the reference range sits inside the plausibility bounds, never outside', () => {
  // A reading can be alarming and still storable. If a reference bound ever
  // fell outside what the column accepts, a real observation would be
  // refused by the database for being abnormal — which is backwards.
  for (const v of VITALS.filter((x) => x.min !== undefined)) {
    assert.ok(v.range[0] <= v.min, `${v.key}: plausible low ${v.range[0]} <= normal low ${v.min}`);
    assert.ok(v.range[1] >= v.max, `${v.key}: plausible high ${v.range[1]} >= normal high ${v.max}`);
  }
});

test('BMI is weight over height in metres squared, to one decimal', () => {
  // The example on the reference screen: 60kg at 150cm is 26.7.
  assert.equal(bmi(60, 150), 26.7);
  assert.equal(bmi(70, 175), 22.9);
});

test('BMI is null when either measurement is missing, never zero', () => {
  // Zero is a number a chart will plot and a classification will call
  // "underweight". Absent has to stay absent.
  assert.equal(bmi(null, 150), null);
  assert.equal(bmi(60, null), null);
  assert.equal(bmi(60, 0), null);
  assert.equal(bmi('', ''), null);
});

test('a reading outside the usual adult range is flagged, low or high', () => {
  const flags = abnormalFlags({
    systolic: 130, diastolic: 90, pulse: 120, spo2: 91, respiratoryRate: 18, temperature: 38.4,
  }, 55);
  assert.equal(flags.pulse, 'high');
  assert.equal(flags.spo2, 'low');
  assert.equal(flags.temperature, 'high');
  // Inside the range is not flagged at all — there is no "normal" mark.
  assert.equal(flags.systolic, undefined);
  assert.equal(flags.respiratoryRate, undefined);
  // 90 is the top of the diastolic range, and the top of a range is inside it.
  assert.equal(flags.diastolic, undefined);
});

test('NOTHING is flagged for a child, or for a patient whose age is unknown', () => {
  // The bounds here are adult bounds. A four-year-old's pulse of 120 is
  // ordinary; flagging it red is how staff learn to ignore red.
  const child = { pulse: 120, respiratoryRate: 26, temperature: 37.0 };
  assert.deepEqual(abnormalFlags(child, 4), {});
  assert.deepEqual(abnormalFlags(child, 17), {});
  assert.deepEqual(abnormalFlags(child, null), {});
  // The same numbers on an adult are flagged.
  assert.equal(abnormalFlags(child, 40).pulse, 'high');
});

test('a missing reading is never flagged, because absent is not abnormal', () => {
  assert.deepEqual(abnormalFlags({ pulse: null, spo2: undefined, temperature: '' }, 40), {});
});

test('BMI is only classified for adults, and never for a child', () => {
  assert.equal(bmiClass(26.7, 40), 'overweight');
  assert.equal(bmiClass(17, 40), 'underweight');
  assert.equal(bmiClass(22, 40), 'healthy');
  assert.equal(bmiClass(33, 40), 'obese');
  // A child's BMI is read against a growth chart for their age and sex, not
  // this table.
  assert.equal(bmiClass(26.7, 9), null);
  assert.equal(bmiClass(26.7, null), null);
  assert.equal(bmiClass(null, 40), null);
});

test('a flag explains itself in words, with the range it fell outside', () => {
  const said = flagLabel('spo2', 'low');
  assert.match(said, /Below/);
  assert.match(said, /94/);
  assert.match(said, /%/);
  assert.equal(flagLabel('spo2', null), null);
});
