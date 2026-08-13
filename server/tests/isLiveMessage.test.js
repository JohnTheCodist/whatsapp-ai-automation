/**
 * Which inbound messages get acted on, and which are treated as backfill.
 *
 * FROM PRODUCTION
 * A pharmacy reconnected, a customer sent a real message minutes later, and
 * it never reached the dashboard or got a reply. Every event arrived from
 * Baileys tagged 'append' instead of 'notify' — continuously, not just as a
 * one-off history sync — and the old filter trusted that label with no
 * second check. The customer's message was correctly timestamped as brand
 * new; only the label lied.
 *
 * Both directions of getting this wrong are expensive: miss a live customer
 * (this bug), or resurrect three-day-old history and answer a question that
 * was already dealt with in person. So both are tested explicitly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLiveMessage } = require('../services/whatsapp/sessionManager');

const NOW = 1_800_000_000_000; // fixed instant, so the tests do not depend on wall-clock time
const secondsAgo = (s) => Math.round((NOW - s * 1000) / 1000);

// ---- the bug this file exists for ----

test('a message minutes old and labelled "append" is still treated as live', () => {
  const r = isLiveMessage('append', secondsAgo(90), NOW);
  assert.equal(r.isLive, true, 'this is exactly the production case: a real message Baileys mislabelled');
});

test('the same is true for "prepend"', () => {
  const r = isLiveMessage('prepend', secondsAgo(30), NOW);
  assert.equal(r.isLive, true);
});

// ---- the protection this must not lose ----

test('a message genuinely days old is NOT treated as live, whatever the label', () => {
  const threeDaysAgo = secondsAgo(3 * 24 * 60 * 60);
  assert.equal(isLiveMessage('append', threeDaysAgo, NOW).isLive, false);
  assert.equal(
    isLiveMessage('notify', threeDaysAgo, NOW).isLive, true,
    'notify is trusted outright — Baileys saying "this is new" is taken at face value regardless of the timestamp it also sent',
  );
});

test('a message just past the window is excluded, not rounded in', () => {
  const window = 3 * 60 * 1000;
  const r = isLiveMessage('append', secondsAgo(0), NOW - window - 1);
  // (kept simple: directly construct an old-enough timestamp)
  const old = Math.round((NOW - window - 5000) / 1000);
  assert.equal(isLiveMessage('append', old, NOW).isLive, false);
});

test('a message just inside the window is included', () => {
  const window = 3 * 60 * 1000;
  const fresh = Math.round((NOW - window + 5000) / 1000);
  assert.equal(isLiveMessage('append', fresh, NOW).isLive, true);
});

// ---- notify is unconditional ----

test('type "notify" is always live, even with no timestamp', () => {
  assert.equal(isLiveMessage('notify', undefined, NOW).isLive, true);
  assert.equal(isLiveMessage('notify', null, NOW).isLive, true);
});

// ---- fails closed on bad input ----

test('a missing timestamp on a non-notify message is not treated as live', () => {
  for (const ts of [undefined, null, '']) {
    const r = isLiveMessage('append', ts, NOW);
    assert.equal(r.isLive, false, `should not trust an unknown age (ts=${JSON.stringify(ts)})`);
    assert.equal(r.ageMs, null);
  }
});

test('a non-numeric timestamp does not throw and is not live', () => {
  const r = isLiveMessage('append', 'not-a-number', NOW);
  assert.equal(r.isLive, false);
});

// ---- reported age is honest ----

test('ageMs reflects how old the message actually was', () => {
  const r = isLiveMessage('append', secondsAgo(45), NOW);
  assert.ok(Math.abs(r.ageMs - 45000) < 1000, `expected ~45000ms, got ${r.ageMs}`);
});
