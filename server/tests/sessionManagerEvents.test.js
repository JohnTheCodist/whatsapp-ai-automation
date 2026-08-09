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
