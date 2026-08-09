/**
 * May we send a reply to this person?
 *
 * The connected number auto-replies to whoever messages it. During testing
 * that must be a very short list, and the failure mode of getting this wrong
 * is a pharmacy's real customers receiving output from a half-built
 * assistant.
 *
 * Three deliberate choices:
 *
 *   1. FAIL CLOSED. Anything unrecognised — an unknown mode, a missing list,
 *      an unparseable number — declines to send. An allowlist that errs
 *      toward sending is not an allowlist.
 *
 *   2. NUMBERS ARE NORMALISED ON BOTH SIDES. 09013993683 and 2349013993683
 *      are the same person. Comparing raw strings makes the list silently
 *      not match, which looks identical to "the assistant is broken".
 *
 *   3. EVERY DECISION CARRIES A REASON. "Did not reply" with no explanation
 *      is the hardest possible thing to debug, and the reason is what the
 *      dashboard shows staff.
 *
 * Pure. No sockets, no database.
 */

const { normalizeMsisdn } = require('./senderIdentity');

/**
 * @param {object} args
 * @param {string} args.replyMode          'off' | 'allowlist' | 'all'
 * @param {string} args.phone              sender, any format
 * @param {string[]} [args.allowlist]      permitted numbers, any format
 * @param {string} [args.defaultCountryCode]
 * @returns {{send: boolean, reason: string}}
 */
function shouldReply({ replyMode, phone, allowlist = [], defaultCountryCode = '234' }) {
  const normalised = normalizeMsisdn(phone, defaultCountryCode);

  if (!normalised) {
    return { send: false, reason: 'unresolvable_number' };
  }

  switch (replyMode) {
    case 'off':
      return { send: false, reason: 'reply_mode_off' };

    case 'all':
      return { send: true, reason: 'reply_mode_all' };

    case 'allowlist': {
      if (!Array.isArray(allowlist) || allowlist.length === 0) {
        // An empty allowlist means nobody, not everybody. This is the branch
        // where a "sensible default" would be actively dangerous.
        return { send: false, reason: 'allowlist_empty' };
      }
      const permitted = new Set(
        allowlist.map((n) => normalizeMsisdn(n, defaultCountryCode)).filter(Boolean)
      );
      return permitted.has(normalised)
        ? { send: true, reason: 'allowlisted' }
        : { send: false, reason: 'not_allowlisted' };
    }

    default:
      // Unknown mode. Refuse rather than guess — a typo in configuration
      // must not open the gate.
      return { send: false, reason: `unknown_reply_mode:${replyMode}` };
  }
}

module.exports = { shouldReply };
