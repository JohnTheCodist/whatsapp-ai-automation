/**
 * customerActivity — dormancy is CLASSIFIED at read time, never WRITTEN to
 * customers.status. See migration 0015 for why the two must stay separate:
 * a status a cron silently sets is indistinguishable from one a staff member
 * deliberately chose, and the next feature to read status needs to be able
 * to trust it means something a person decided.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyActivity } = require('../services/customers/customerActivity');

const NOW = new Date('2026-08-13T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

test('seen today is active', () => {
  const r = classifyActivity(NOW, NOW);
  assert.equal(r.tier, 'active');
  assert.equal(r.daysSinceContact, 0);
});

test('29 days is still active, 31 is quiet — the boundary is exact', () => {
  assert.equal(classifyActivity(daysAgo(29), NOW).tier, 'active');
  assert.equal(classifyActivity(daysAgo(30), NOW).tier, 'active');
  assert.equal(classifyActivity(daysAgo(31), NOW).tier, 'quiet');
});

test('90 days is quiet, 91 is dormant', () => {
  assert.equal(classifyActivity(daysAgo(90), NOW).tier, 'quiet');
  assert.equal(classifyActivity(daysAgo(91), NOW).tier, 'dormant');
});

test('a year of silence is dormant, not a crash', () => {
  const r = classifyActivity(daysAgo(400), NOW);
  assert.equal(r.tier, 'dormant');
  assert.equal(r.daysSinceContact, 400);
});

test('no last_seen_at at all is "unknown", not "dormant" — those are different claims', () => {
  assert.deepEqual(classifyActivity(null, NOW), { tier: 'unknown', daysSinceContact: null });
  assert.deepEqual(classifyActivity(undefined, NOW), { tier: 'unknown', daysSinceContact: null });
});

test('an unparsable timestamp is "unknown", not a thrown error', () => {
  const r = classifyActivity('not-a-date', NOW);
  assert.equal(r.tier, 'unknown');
});

test('a string ISO timestamp works the same as a Date instance', () => {
  const asString = classifyActivity(daysAgo(45).toISOString(), NOW);
  const asDate = classifyActivity(daysAgo(45), NOW);
  assert.deepEqual(asString, asDate);
});

test('a future timestamp (bad clock, bad input) does not go negative', () => {
  const future = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
  const r = classifyActivity(future, NOW);
  assert.equal(r.daysSinceContact, 0);
  assert.equal(r.tier, 'active');
});

test('defaults to real time when now is omitted', () => {
  const r = classifyActivity(new Date());
  assert.equal(r.tier, 'active');
  assert.equal(r.daysSinceContact, 0);
});
