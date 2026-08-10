/**
 * New-number warm-up.
 *
 * The clock is injected, so day 6 is testable today rather than next week —
 * which matters, because a ramp is precisely the kind of logic that is
 * otherwise only exercised in production, once, on the number that counts.
 *
 * Pure. No database, no sockets.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { warmupStatus, evaluateWarmup } = require('../services/whatsapp/warmupPolicy');

const DAY = 86_400_000;
const START = new Date('2026-08-01T09:00:00Z');
const at = (days) => new Date(START.getTime() + days * DAY);

// ---- the ramp ----

test('a number that has never sent starts at the day-one ceiling', () => {
  const s = warmupStatus({ startedAt: null });
  assert.equal(s.active, true);
  assert.equal(s.day, 1);
  assert.equal(s.limit, 20);
});

test('the limit grows every day and never shrinks', () => {
  let previous = 0;
  for (let d = 0; d < 7; d++) {
    const s = warmupStatus({ startedAt: START, now: at(d) });
    assert.equal(s.active, true, `day ${d + 1} should still be warming`);
    assert.ok(s.limit > previous, `day ${d + 1} limit (${s.limit}) must exceed day ${d} (${previous})`);
    previous = s.limit;
  }
});

test('day one is genuinely restrictive', () => {
  // The whole point. If day one is not small, the ramp is decoration.
  assert.equal(warmupStatus({ startedAt: START, now: at(0) }).limit, 20);
});

test('the ramp ends and stops constraining anything', () => {
  const s = warmupStatus({ startedAt: START, now: at(7) });
  assert.equal(s.active, false);
  assert.equal(s.reason, 'warmed_up');
  assert.equal(s.limit, null, 'null means no ceiling — it must not read as a limit of zero');
});

test('a long-established number is never re-throttled', () => {
  const s = warmupStatus({ startedAt: START, now: at(400) });
  assert.equal(s.active, false);
  assert.equal(s.limit, null);
});

// ---- the gate ----

test('sends are allowed below the ceiling', () => {
  const d = evaluateWarmup({ startedAt: START, now: at(0), sentToday: 5 });
  assert.equal(d.send, true);
  assert.equal(d.limit, 20);
});

test('sends stop at the ceiling', () => {
  const d = evaluateWarmup({ startedAt: START, now: at(0), sentToday: 20 });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'warmup_limit_reached');
  assert.equal(d.day, 1);
});

test('hitting the warm-up ceiling does NOT pause the pharmacy', () => {
  // conductPolicy's daily cap trips a breaker because unexplained volume is
  // a fault. This ceiling is expected and temporary — pausing a new pharmacy
  // for behaving exactly as designed would be the bug.
  const d = evaluateWarmup({ startedAt: START, now: at(0), sentToday: 999 });
  assert.equal(d.send, false);
  assert.ok(!('pause' in d), 'warm-up must never trip the circuit breaker');
});

test('a warmed-up number is unconstrained by this gate', () => {
  const d = evaluateWarmup({ startedAt: START, now: at(30), sentToday: 5000 });
  assert.equal(d.send, true, 'conductPolicy owns the steady-state cap, not this');
});

// ---- opting out ----

test('disabled means no ramp at all', () => {
  // Correct for a number with real existing history, where sudden throttling
  // would itself be the anomaly.
  const s = warmupStatus({ startedAt: null, enabled: false });
  assert.equal(s.active, false);
  assert.equal(s.limit, null);
  assert.equal(evaluateWarmup({ startedAt: null, enabled: false, sentToday: 10_000 }).send, true);
});

// ---- fails safe, not open ----

test('an unreadable start date falls back to day one, not to unlimited', () => {
  // Not knowing how old a number is must not be read as "fully warm" — that
  // is the assumption that costs the pharmacy its number.
  const s = warmupStatus({ startedAt: 'not-a-date' });
  assert.equal(s.active, true);
  assert.equal(s.day, 1);
  assert.equal(s.reason, 'unreadable_start_date');
});

test('a clock that moved backwards does not skip the ramp', () => {
  // NTP correction or a restored backup can put `now` before `startedAt`.
  const s = warmupStatus({ startedAt: START, now: new Date(START.getTime() - 5 * DAY) });
  assert.equal(s.day, 1, 'negative elapsed time must clamp to day 1, not go unlimited');
  assert.equal(s.active, true);
});

test('custom ramp lengths are respected', () => {
  assert.equal(warmupStatus({ startedAt: START, now: at(2), warmupDays: 3 }).active, true);
  assert.equal(warmupStatus({ startedAt: START, now: at(3), warmupDays: 3 }).active, false);
});

test('every decision carries a reason', () => {
  const cases = [
    { startedAt: null },
    { startedAt: START, now: at(2) },
    { startedAt: START, now: at(99) },
    { startedAt: null, enabled: false },
    { startedAt: 'rubbish' },
  ];
  for (const c of cases) {
    assert.ok(warmupStatus(c).reason, 'a silent throttle is undebuggable');
  }
});
