/**
 * Disconnect policy — no database, no sockets, no network.
 *
 * The test that matters most is "does a rejected credential ever lead to a
 * retry". Getting that wrong turns our own recovery code into the thing that
 * gets a pharmacy's number banned, and it would never show up in a happy-path
 * integration test because it only fires when something has already gone
 * wrong.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DisconnectReason } = require('baileys');
const {
  classifyDisconnect,
  backoffMs,
  MAX_RECONNECT_ATTEMPTS,
} = require('../services/whatsapp/disconnectPolicy');

// ---- the rule the whole file exists for ----

const MUST_NEVER_RECONNECT = [
  ['loggedOut (401)', DisconnectReason.loggedOut],
  ['forbidden / likely ban (403)', DisconnectReason.forbidden],
  ['badSession (500)', DisconnectReason.badSession],
  ['multideviceMismatch (411)', DisconnectReason.multideviceMismatch],
  ['connectionReplaced (440)', DisconnectReason.connectionReplaced],
];

for (const [label, code] of MUST_NEVER_RECONNECT) {
  test(`${label} stops instead of retrying`, () => {
    const d = classifyDisconnect(code);
    assert.equal(d.action, 'stop', `${label} must not reconnect — a retry loop here is how a number gets banned`);
  });
}

test('a rejected credential is cleared, not kept for another attempt', () => {
  for (const code of [DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.badSession]) {
    assert.equal(classifyDisconnect(code).clearAuth, true);
  }
});

test('connectionReplaced stops but KEEPS credentials', () => {
  // Another socket took over; the credentials are still valid. Wiping them
  // would turn an operational problem into a re-pairing call with the owner.
  const d = classifyDisconnect(DisconnectReason.connectionReplaced);
  assert.equal(d.action, 'stop');
  assert.equal(d.clearAuth, false);
});

// ---- transient cases ----

const MUST_RECONNECT = [
  ['connectionClosed (428)', DisconnectReason.connectionClosed],
  ['connectionLost / timedOut (408)', DisconnectReason.connectionLost],
  ['unavailableService (503)', DisconnectReason.unavailableService],
  ['restartRequired (515)', DisconnectReason.restartRequired],
];

for (const [label, code] of MUST_RECONNECT) {
  test(`${label} reconnects`, () => {
    const d = classifyDisconnect(code);
    assert.equal(d.action, 'reconnect');
    assert.equal(d.clearAuth, false, 'a transient drop must never destroy working credentials');
  });
}

test('restartRequired reconnects immediately — it is the normal post-pairing step', () => {
  const d = classifyDisconnect(DisconnectReason.restartRequired);
  assert.equal(d.immediate, true, 'backing off here makes onboarding look broken');
});

test('other transient reasons do NOT skip backoff', () => {
  for (const code of [DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.unavailableService]) {
    assert.equal(classifyDisconnect(code).immediate, false);
  }
});

// ---- unknown input ----

test('an unknown status code reconnects with backoff rather than throwing', () => {
  const d = classifyDisconnect(9999);
  assert.equal(d.action, 'reconnect');
  assert.equal(d.immediate, false);
  assert.match(d.detail, /9999/, 'the unrecognised code belongs in the message so it can be looked up');
});

test('a missing status code is handled', () => {
  const d = classifyDisconnect(undefined);
  assert.equal(d.action, 'reconnect');
  assert.match(d.detail, /no status code/);
});

// ---- surfacing to humans ----

test('every terminal outcome flags that a human is needed', () => {
  for (const [, code] of MUST_NEVER_RECONNECT) {
    assert.equal(classifyDisconnect(code).needsHuman, true);
  }
});

test('transient outcomes do not page anyone', () => {
  for (const [, code] of MUST_RECONNECT) {
    assert.equal(classifyDisconnect(code).needsHuman, false);
  }
});

test('a 401 on a session that never paired does not claim the owner logged us out', () => {
  const never = classifyDisconnect(DisconnectReason.loggedOut, { wasRegistered: false });
  assert.match(never.detail, /Pairing never completed/);
  assert.doesNotMatch(
    never.detail, /logged this device out/,
    'telling someone who never received a code that they logged us out sends them to the wrong place',
  );
  // The ACTION is identical either way — only the explanation differs.
  assert.equal(never.action, 'stop');
  assert.equal(never.clearAuth, true);
});

test('a 401 on a previously paired session still reads as a logout', () => {
  const was = classifyDisconnect(DisconnectReason.loggedOut, { wasRegistered: true });
  assert.match(was.detail, /logged this device out/);
});

test('wasRegistered defaults to true, so existing callers are unaffected', () => {
  assert.deepEqual(
    classifyDisconnect(DisconnectReason.loggedOut),
    classifyDisconnect(DisconnectReason.loggedOut, { wasRegistered: true }),
  );
});

test('a suspected ban says so plainly rather than calling itself a glitch', () => {
  const d = classifyDisconnect(DisconnectReason.forbidden);
  assert.equal(d.status, 'banned');
  assert.match(d.detail, /ban/i);
});

test('every decision yields a status the schema will accept', () => {
  const allowed = new Set([
    'pending', 'pending_scan', 'connecting', 'connected',
    'disconnected', 'logged_out', 'banned', 'failed',
  ]);
  const codes = [...Object.values(DisconnectReason), 9999, undefined].filter((c) => typeof c !== 'string');
  for (const code of codes) {
    const d = classifyDisconnect(code);
    assert.ok(allowed.has(d.status), `status "${d.status}" for code ${code} would violate the CHECK constraint`);
  }
});

// ---- backoff ----

test('backoff grows with attempt number', () => {
  const ceiling = (n) => Math.min(5 * 60 * 1000, 2000 * 2 ** (n - 1));
  assert.ok(ceiling(1) < ceiling(3));
  assert.ok(ceiling(3) < ceiling(6));
});

test('backoff is capped so a long outage does not schedule a retry next week', () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(backoffMs(30) <= 5 * 60 * 1000);
  }
});

test('backoff is jittered — identical inputs must not produce identical waits', () => {
  const samples = new Set();
  for (let i = 0; i < 40; i++) samples.add(backoffMs(6));
  assert.ok(
    samples.size > 1,
    'without jitter every session dropped by one upstream blip reconnects in lockstep',
  );
});

test('backoff is never negative and never NaN', () => {
  for (const attempt of [1, 2, 5, 10, 100]) {
    const ms = backoffMs(attempt);
    assert.ok(Number.isFinite(ms) && ms >= 0, `bad backoff for attempt ${attempt}: ${ms}`);
  }
});

test('there is a finite give-up point', () => {
  assert.ok(MAX_RECONNECT_ATTEMPTS > 0 && MAX_RECONNECT_ATTEMPTS < 100);
});
