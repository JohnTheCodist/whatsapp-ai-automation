/**
 * The manager must never take the process down.
 *
 * A statement timeout on a status write was caught, reported via
 * emit('error', ...), and killed the server — because 'error' is a reserved
 * EventEmitter name and Node throws ERR_UNHANDLED_ERROR when nothing is
 * listening. One transient database hiccup ended every pharmacy's session in
 * the process, and the code that did it was the error handler.
 *
 * These tests do not need a socket, a network, or a database.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../services/whatsapp/sessionManager');

test('emitting the reserved "error" event does not throw', () => {
  const mgr = new SessionManager();
  assert.doesNotThrow(
    () => mgr.emit('error', new Error('boom')),
    'an unlistened "error" emit throws ERR_UNHANDLED_ERROR and kills the process',
  );
});

test('a default "error" listener is installed at construction', () => {
  const mgr = new SessionManager();
  assert.ok(
    mgr.listenerCount('error') >= 1,
    'without this, any future emit("error") is a latent process-killer',
  );
});

test('failures are reported on "session-error", which is safe to leave unhandled', () => {
  const mgr = new SessionManager();
  assert.doesNotThrow(() => mgr.emit('session-error', {
    accountId: 'x', phase: 'test', error: new Error('db down'),
  }));
});

test('"session-error" carries enough context to locate the failure', () => {
  const mgr = new SessionManager();
  const seen = [];
  mgr.on('session-error', (p) => seen.push(p));

  mgr.emit('session-error', { accountId: 'acct-1', phase: 'setStatus', error: new Error('timeout') });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].accountId, 'acct-1');
  assert.equal(seen[0].phase, 'setStatus', 'phase is what distinguishes a save failure from a connect failure');
  assert.match(seen[0].error.message, /timeout/);
});

test('a fresh manager reports no live sessions and no live count', () => {
  const mgr = new SessionManager();
  assert.equal(mgr.liveCount, 0);
  assert.deepEqual(mgr.getStatus('anything'), { live: false });
});

test('sendText on an unknown session rejects instead of throwing synchronously', async () => {
  const mgr = new SessionManager();
  await assert.rejects(
    () => mgr.sendText('missing', '234@s.whatsapp.net', 'hi'),
    /No live session/,
  );
});

test('sendText refuses an empty message', async () => {
  const mgr = new SessionManager();
  // Seeded directly so the emptiness check is what fails, not the lookup.
  mgr.sessions.set('a', { accountId: 'a', sock: {}, closed: false });
  await assert.rejects(() => mgr.sendText('a', 'x@s.whatsapp.net', '   '), /empty message/);
});

// ---------------------------------------------------------------------------
// restore retries
// ---------------------------------------------------------------------------
//
// A statement timeout on start()'s (trivial, indexed) account query used to
// leave WhatsApp offline indefinitely: the failure was caught, nothing
// retried, and the stored status row still read 'connected' — so the
// dashboard showed a healthy connection over a socket that did not exist.
// Nothing about that failure was permanent; a restart fixed it instantly.
//
// The stub `db` is PASSED IN rather than monkey-patched. getSql is
// destructured at module load, so patching the module afterwards has no
// effect — an earlier version of this test therefore ran against the real
// database, opened a real socket, and killed the live session.

const timeoutError = () => {
  const e = new Error('canceling statement due to statement timeout');
  e.code = '57014';
  return e;
};

test('start() retries a failing account query instead of giving up', async () => {
  let calls = 0;
  const db = () => {
    calls += 1;
    return calls < 3 ? Promise.reject(timeoutError()) : Promise.resolve([]);
  };

  const mgr = new SessionManager();
  const attempts = [];
  mgr.on('session-error', (e) => { if (e.phase === 'restore-query') attempts.push(e.attempt); });

  const restored = await mgr.start({ staggerMs: 0, retries: 5, db });

  assert.equal(calls, 3, 'should have retried until the query succeeded');
  assert.equal(restored, 0, 'no accounts came back, so none were restored');
  assert.deepEqual(attempts, [1, 2], 'every failed attempt is reported, not just the last');
});

test('start() rethrows once retries are exhausted, rather than reporting zero sessions', async () => {
  const db = () => Promise.reject(timeoutError());
  const mgr = new SessionManager();
  mgr.on('session-error', () => {});

  // Returning 0 would read as "there were no sessions to restore", which is a
  // different and far less alarming fact than "restore failed".
  await assert.rejects(
    () => mgr.start({ staggerMs: 0, retries: 2, db }),
    /statement timeout/,
  );
});

test('a stopping manager abandons retries immediately', async () => {
  let calls = 0;
  const db = () => { calls += 1; return Promise.reject(timeoutError()); };
  const mgr = new SessionManager();
  mgr.on('session-error', () => {});
  mgr.stopping = true;

  const result = await mgr.start({ staggerMs: 0, retries: 5, db });
  assert.equal(result, 0);
  assert.equal(calls, 0, 'shutdown must not be delayed by backoff sleeps');
});
