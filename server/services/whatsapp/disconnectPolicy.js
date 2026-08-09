/**
 * What to do when a Baileys socket closes.
 *
 * This is a pure function on purpose, for the same reason `selectTenant` is:
 * it encodes the decision most likely to be got wrong, and the wrong answer
 * is expensive in a way tests can't otherwise reach.
 *
 * THE FAILURE THIS PREVENTS
 * Treating every close as "reconnect" is the default mistake, and it is the
 * single worst thing this system can do. A socket that closed because
 * WhatsApp rejected the credentials will reject them again, immediately,
 * forever. That reconnect loop is itself an abuse signal — so the code
 * written to recover from a disconnection becomes the thing that converts a
 * recoverable session into a banned number.
 *
 * So: closes are classified, and some of them mean STOP.
 *
 * Exhaustively testable without a socket, a network, or a database.
 */

const { DisconnectReason } = require('baileys');

/**
 * @typedef {object} DisconnectDecision
 * @property {'reconnect'|'stop'} action     what the session manager should do
 * @property {boolean} clearAuth             wipe stored credentials — they are dead
 * @property {string}  status                value for whatsapp_accounts.status
 * @property {string}  detail                human-readable, lands in status_detail
 * @property {boolean} immediate             skip backoff (only legitimate after pairing)
 * @property {boolean} needsHuman            no automated path back; tell someone
 */

/**
 * @param {number|undefined} statusCode  from lastDisconnect.error.output.statusCode
 * @param {{wasRegistered?: boolean}} [context]
 *   `wasRegistered` distinguishes a session that had completed pairing from
 *   one that never did. Both produce a 401, but they are different problems
 *   and telling a pharmacy the wrong one sends them looking in the wrong
 *   place — "you logged us out" is nonsense to someone who never got a code.
 * @returns {DisconnectDecision}
 */
function classifyDisconnect(statusCode, { wasRegistered = true } = {}) {
  switch (statusCode) {
    // --- terminal: the credentials are gone or refused -------------------

    case DisconnectReason.loggedOut: // 401
      return {
        action: 'stop',
        clearAuth: true,
        status: 'logged_out',
        detail: wasRegistered
          ? 'The pharmacy logged this device out from their phone. Re-pairing is required.'
          : 'Pairing never completed — WhatsApp rejected the session before it was linked. '
            + 'The code may have expired or been entered on a different number. Request a new code.',
        immediate: false,
        needsHuman: true,
      };

    case DisconnectReason.forbidden: // 403
      return {
        action: 'stop',
        clearAuth: true,
        status: 'banned',
        // Deliberately not softened. A 403 here most often means the number
        // has been actioned by WhatsApp, and presenting that as a glitch
        // wastes the hours when telling the pharmacy still matters.
        detail: 'WhatsApp refused this account (403). Most likely a ban. Do not retry automatically.',
        immediate: false,
        needsHuman: true,
      };

    case DisconnectReason.badSession: // 500
      return {
        action: 'stop',
        clearAuth: true,
        status: 'logged_out',
        detail: 'Stored session is corrupt and cannot be used. Credentials cleared; re-pairing is required.',
        immediate: false,
        needsHuman: true,
      };

    case DisconnectReason.multideviceMismatch: // 411
      return {
        action: 'stop',
        clearAuth: true,
        status: 'logged_out',
        detail: 'Multi-device mismatch. Re-pairing is required.',
        immediate: false,
        needsHuman: true,
      };

    // --- terminal-ish: retrying would actively make it worse -------------

    case DisconnectReason.connectionReplaced: // 440
      return {
        action: 'stop',
        clearAuth: false,
        status: 'disconnected',
        // Two sockets racing to own one session knock each other off
        // indefinitely. Whoever took over is probably a second instance of
        // this app, so the fix is operational, not a retry.
        detail: 'Another session replaced this connection. Not reconnecting — that would fight it. Check for a second running instance.',
        immediate: false,
        needsHuman: true,
      };

    // --- transient: reconnect -------------------------------------------

    case DisconnectReason.restartRequired: // 515
      return {
        action: 'reconnect',
        clearAuth: false,
        status: 'connecting',
        // Normal and expected immediately after pairing. Backing off here
        // just makes onboarding feel broken for no reason.
        detail: 'Restart required after pairing — reconnecting immediately.',
        immediate: true,
        needsHuman: false,
      };

    case DisconnectReason.connectionClosed: // 428
    case DisconnectReason.connectionLost:   // 408 (=== timedOut)
      return {
        action: 'reconnect',
        clearAuth: false,
        status: 'disconnected',
        detail: 'Connection dropped. Reconnecting with backoff.',
        immediate: false,
        needsHuman: false,
      };

    case DisconnectReason.unavailableService: // 503
      return {
        action: 'reconnect',
        clearAuth: false,
        status: 'disconnected',
        detail: 'WhatsApp reported the service unavailable. Reconnecting with backoff.',
        immediate: false,
        needsHuman: false,
      };

    // --- unknown ---------------------------------------------------------

    default:
      // Reconnect, but with backoff and a capped attempt count so an
      // unrecognised permanent error degrades into a stopped session rather
      // than an infinite loop. Erring toward retry is right here: the known
      // dangerous codes are all enumerated above, so anything reaching this
      // branch is more likely a transient network fault than a rejection.
      return {
        action: 'reconnect',
        clearAuth: false,
        status: 'disconnected',
        detail: `Unrecognised disconnect (${statusCode === undefined ? 'no status code' : statusCode}). Reconnecting with backoff.`,
        immediate: false,
        needsHuman: false,
      };
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration: without it every session dropped by the same
 * upstream blip reconnects in lockstep, which is both a self-inflicted
 * thundering herd and an unusual traffic pattern from one IP.
 *
 * @param {number} attempt  1-based
 * @returns {number} milliseconds
 */
function backoffMs(attempt, { baseMs = 2000, capMs = 5 * 60 * 1000 } = {}) {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}

/** Give up automated recovery after this many consecutive failures. */
const MAX_RECONNECT_ATTEMPTS = 10;

module.exports = { classifyDisconnect, backoffMs, MAX_RECONNECT_ATTEMPTS };
