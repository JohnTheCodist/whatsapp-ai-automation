/**
 * The reconnect guard.
 *
 * This exists because of a real failure. A pharmacy paired successfully,
 * WhatsApp sent 515 restartRequired as it always does straight after
 * pairing, the manager scheduled a reconnect — and connect() returned the
 * dead socket unchanged because the session still looked alive. The session
 * sat in `connecting` indefinitely, having genuinely linked, with no error
 * logged anywhere. Nothing in the system was in a position to notice.
 *
 * Both directions are dangerous, which is why this is its own function:
 *   too eager  -> two live sockets on one session, WhatsApp knocks both off
 *   too lazy   -> reconnects silently stop happening
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsNewSocket } = require('../services/whatsapp/sessionManager');

test('no session record at all needs a socket', () => {
  assert.equal(needsNewSocket(undefined), true);
  assert.equal(needsNewSocket(null), true);
});

test('a record with no socket yet needs one', () => {
  assert.equal(needsNewSocket({ sock: null, closed: false }), true);
});

test('a closed socket must be REPLACED, not reused', () => {
  assert.equal(
    needsNewSocket({ sock: {}, closed: true }), true,
    'this is the 515-after-pairing case — returning the dead socket here strands a linked session',
  );
});

test('a live socket is reused rather than duplicated', () => {
  assert.equal(
    needsNewSocket({ sock: {}, closed: false }), false,
    'a second socket for one session makes WhatsApp drop both with connectionReplaced',
  );
});

test('the reconnect sequence asks for a new socket at the right moment', () => {
  // Mirrors what _onConnectionUpdate does on a transient close.
  const session = { sock: { id: 'first' }, closed: false };
  assert.equal(needsNewSocket(session), false, 'while live, reuse');

  session.closed = true; // what the reconnect path now sets
  assert.equal(needsNewSocket(session), true, 'once marked closed, rebuild');
});

test('a deliberate disconnect followed by reconnect still rebuilds', () => {
  const session = { sock: {}, closed: true, intentionalClose: true };
  assert.equal(needsNewSocket(session), true);
});
