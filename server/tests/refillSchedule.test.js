/**
 * When a patient's medicine runs out, and what that makes today.
 *
 * These rules decide who appears on a pharmacist's refill call list. A date
 * that is one day late means a hypertensive patient goes a day without
 * amlodipine before anyone notices; a status that is wrong the other way
 * means a pharmacist rings someone who still has a full strip. Both are
 * tested at the exact boundary, because the boundary is where they break.
 *
 * Database-free on purpose: this file must run on every machine.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REMIND_DAYS_BEFORE, LAPSE_DAYS_AFTER, MAX_DAYS_SUPPLY, STATUSES,
  lagosDate, isIsoDate, addDays, daysBetween,
  daysSupplyFor, runOutDate, remindOn, refillStatus, refillCountsFrom,
} = require('../services/refills/refillSchedule');

// ---- the Lagos calendar day ----------------------------------------------

test('late evening in Lagos is still today, even though it is tomorrow nowhere else that matters', () => {
  // 23:30 WAT on the 14th is 22:30 UTC on the 14th — same day either way.
  assert.equal(lagosDate(new Date('2026-03-14T22:30:00Z')), '2026-03-14');
});

test('just after midnight in Lagos is the new day, although UTC still says yesterday', () => {
  // 00:30 WAT on the 15th is 23:30 UTC on the 14th. A server reading the UTC
  // date here would show every patient a day behind for the first hour of
  // the Lagos morning.
  assert.equal(lagosDate(new Date('2026-03-14T23:30:00Z')), '2026-03-15');
});

test('an invalid instant is refused rather than becoming "NaN-NaN-NaN"', () => {
  assert.throws(() => lagosDate(new Date('not a date')), /not a valid instant/);
});

test('an impossible calendar date is not a date, even when it has the right shape', () => {
  // Date.UTC(2026, 1, 31) quietly becomes 3 March. Accepting it would store
  // a dispense on a day that never happened.
  assert.equal(isIsoDate('2026-02-31'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('26-03-01'), false);
  assert.equal(isIsoDate('2028-02-29'), true);
});

test('date arithmetic crosses months and leap days without drifting', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2026-03-10', '2026-03-03'), -7);
});

// ---- how long one dispense lasts -----------------------------------------

test('a stated number of days is taken as the supply', () => {
  assert.deepEqual(daysSupplyFor({ daysSupply: 30 }), { ok: true, days: 30 });
});

test('a stated number of days wins over quantity and dose', () => {
  // The pharmacist's "this is a 28-day pack" is judgement; 30 tablets at 1 a
  // day is arithmetic about how the patient takes it. Judgement wins.
  assert.deepEqual(daysSupplyFor({ daysSupply: 28, quantity: 30, unitsPerDay: 1 }), { ok: true, days: 28 });
});

test('quantity divided by daily dose gives the supply', () => {
  assert.deepEqual(daysSupplyFor({ quantity: 60, unitsPerDay: 2 }), { ok: true, days: 30 });
  assert.deepEqual(daysSupplyFor({ quantity: 28, unitsPerDay: 1 }), { ok: true, days: 28 });
});

test('a part-day of medicine is rounded DOWN, so the reminder is early rather than late', () => {
  // 45 tablets at 2 a day is 22.5 days. On day 23 the patient has half a
  // dose. 23 would schedule the reminder after they needed it.
  assert.deepEqual(daysSupplyFor({ quantity: 45, unitsPerDay: 2 }), { ok: true, days: 22 });
});

test('half a tablet a day is a real dose and is honoured', () => {
  assert.deepEqual(daysSupplyFor({ quantity: 14, unitsPerDay: 0.5 }), { ok: true, days: 28 });
});

test('less than a single day of medicine is refused rather than scheduled for today', () => {
  assert.deepEqual(daysSupplyFor({ quantity: 1, unitsPerDay: 2 }), { ok: false, reason: 'SUPPLY_LESS_THAN_ONE_DAY' });
});

test('nothing to go on is refused, never defaulted to a month', () => {
  // A silent 30-day default would put a patient on a schedule nobody chose.
  assert.equal(daysSupplyFor({}).ok, false);
  assert.equal(daysSupplyFor({ quantity: 30 }).reason, 'DAYS_SUPPLY_OR_QUANTITY_AND_DOSE_REQUIRED');
  assert.equal(daysSupplyFor({ unitsPerDay: 1 }).reason, 'DAYS_SUPPLY_OR_QUANTITY_AND_DOSE_REQUIRED');
});

test('zero, negative, fractional and non-numeric days are refused, not coerced', () => {
  for (const bad of [0, -5, 2.5, '30', NaN]) {
    assert.equal(daysSupplyFor({ daysSupply: bad }).ok, false, `daysSupply ${String(bad)} must be refused`);
  }
});

test('zero or negative quantity and dose are refused', () => {
  assert.equal(daysSupplyFor({ quantity: 0, unitsPerDay: 1 }).reason, 'QUANTITY_NOT_POSITIVE');
  assert.equal(daysSupplyFor({ quantity: 30, unitsPerDay: 0 }).reason, 'DOSE_NOT_POSITIVE');
  assert.equal(daysSupplyFor({ quantity: -30, unitsPerDay: 1 }).reason, 'QUANTITY_NOT_POSITIVE');
});

test('a supply longer than the maximum is refused as a probable units mistake', () => {
  // 500 typed into "days" when 500mg was meant would otherwise take this
  // patient off every list for sixteen months.
  assert.equal(daysSupplyFor({ daysSupply: MAX_DAYS_SUPPLY }).ok, true);
  assert.equal(daysSupplyFor({ daysSupply: MAX_DAYS_SUPPLY + 1 }).reason, 'DAYS_SUPPLY_TOO_LONG');
  assert.equal(daysSupplyFor({ quantity: 1000, unitsPerDay: 1 }).reason, 'DAYS_SUPPLY_TOO_LONG');
});

// ---- the run-out date ----------------------------------------------------

test('the run-out date is the first day with NO medicine, not the last day with some', () => {
  // Dispensed on the 1st with 30 days covers the 1st..30th. Calling the 30th
  // the run-out date would list every patient as overdue while they are
  // still taking their last tablet.
  assert.equal(runOutDate('2026-09-01', 30), '2026-10-01');
});

test('a one-day supply runs out tomorrow', () => {
  assert.equal(runOutDate('2026-09-19', 1), '2026-09-20');
});

test('the run-out date is refused a non-whole or missing number of days', () => {
  assert.throws(() => runOutDate('2026-09-01', 0));
  assert.throws(() => runOutDate('2026-09-01', 2.5));
  assert.throws(() => runOutDate('2026-09-01', undefined));
});

test('the reminder window opens REMIND_DAYS_BEFORE days before run-out', () => {
  assert.equal(REMIND_DAYS_BEFORE, 5);
  assert.equal(remindOn('2026-10-01'), '2026-09-26');
});

// ---- where a supply stands today -----------------------------------------

const RUN_OUT = '2026-10-01';

test('more than five days left is upcoming: nobody should be contacted yet', () => {
  assert.deepEqual(refillStatus({ runOutOn: RUN_OUT, today: '2026-09-25' }), { status: STATUSES.UPCOMING, daysLeft: 6 });
});

test('exactly five days left is due: the window opens on the reminder date itself', () => {
  assert.deepEqual(refillStatus({ runOutOn: RUN_OUT, today: remindOn(RUN_OUT) }), { status: STATUSES.DUE, daysLeft: 5 });
});

test('one day left is still due, not overdue: they have medicine for today', () => {
  assert.deepEqual(refillStatus({ runOutOn: RUN_OUT, today: '2026-09-30' }), { status: STATUSES.DUE, daysLeft: 1 });
});

test('the run-out day itself is overdue: that is the first day without medicine', () => {
  assert.deepEqual(refillStatus({ runOutOn: RUN_OUT, today: RUN_OUT }), { status: STATUSES.OVERDUE, daysLeft: 0 });
});

test('six days out is still overdue, the last day before a pharmacist should ring', () => {
  assert.deepEqual(refillStatus({ runOutOn: RUN_OUT, today: '2026-10-07' }), { status: STATUSES.OVERDUE, daysLeft: -6 });
});

test('seven days out is lapsed', () => {
  assert.equal(LAPSE_DAYS_AFTER, 7);
  assert.deepEqual(refillStatus({ runOutOn: RUN_OUT, today: '2026-10-08' }), { status: STATUSES.LAPSED, daysLeft: -7 });
});

test('months out is still lapsed, never quietly dropped', () => {
  // A patient who stopped coming is the one a retention product exists for.
  assert.equal(refillStatus({ runOutOn: RUN_OUT, today: '2027-03-01' }).status, STATUSES.LAPSED);
});

test('a status is refused a malformed date rather than guessing one', () => {
  assert.throws(() => refillStatus({ runOutOn: '01/10/2026', today: '2026-09-25' }), /YYYY-MM-DD/);
  assert.throws(() => refillStatus({ runOutOn: RUN_OUT, today: undefined }), /YYYY-MM-DD/);
});

// ---- the profile's numbers -----------------------------------------------

const journey = (status, currentStatus, completedRefills = 0) => ({
  status, completedRefills, currentRefill: currentStatus ? { status: currentStatus } : null,
});

test('"due" on the profile counts every supply that needs action: due, overdue and lapsed', () => {
  // This is the amber number a pharmacist acts on. Counting only the "due"
  // label would hide exactly the patients who are already out of medicine.
  assert.deepEqual(refillCountsFrom([
    journey('active', 'upcoming'),
    journey('active', 'due'),
    journey('active', 'overdue'),
    journey('active', 'lapsed'),
  ]), { due: 3, overdue: 1, lapsed: 1, completed: 0 });
});

test('a stopped journey keeps its completed refills but is never counted as due', () => {
  // Its refills happened; chasing it would ring someone about a medicine
  // the pharmacist deliberately stopped.
  assert.deepEqual(refillCountsFrom([
    journey('stopped', null, 4),
    journey('stopped', 'lapsed', 1),
    journey('active', 'upcoming', 2),
  ]), { due: 0, overdue: 0, lapsed: 0, completed: 7 });
});

test('no journeys means zeroes, not a missing object', () => {
  assert.deepEqual(refillCountsFrom([]), { due: 0, overdue: 0, lapsed: 0, completed: 0 });
});
