/**
 * Whose messages are we entitled to keep?
 *
 * Baileys is a linked device, so the socket sees every conversation on the
 * account. Without a gate here, a pharmacy running the assistant on a
 * personal number has their private chats copied into our database and shown
 * to their staff. That happened in testing.
 *
 * WHY THIS IS A GATE AND NOT A FILTER
 * Hiding personal conversations in the inbox would leave them in the
 * database, and the database is the part that matters. A message that is
 * never stored cannot leak, cannot be shown to the wrong person, cannot be
 * subpoenaed and cannot cost an LLM call. So this runs before the first
 * insert, and a refusal writes nothing at all — not even the sender.
 *
 * SEPARATE FROM THE REPLY DECISION
 * conductPolicy answers "may we send to this person". This answers "may we
 * keep what they sent". A pharmacy piloting with a two-number allowlist
 * still wants a record of the real customers it has not started answering
 * yet, so the two are not the same gate and must not be merged.
 *
 * FAILS CLOSED on a malformed sender, and OPEN on unknown configuration —
 * the opposite of conductPolicy, deliberately. Not sending is recoverable;
 * not storing is not, because there is no retry and the customer is simply
 * gone.
 *
 * Pure. No database, no clock.
 */

const { normalizeMsisdn } = require('./senderIdentity');

/**
 * @param {object} args
 * @param {string}   args.ingestMode        'all' | 'allowlist'
 * @param {string}   args.phone
 * @param {string[]} [args.allowlist]
 * @param {string[]} [args.blocked]         never stored, in either mode
 * @param {string}   [args.notifyPhone]     the pharmacy's own staff alert line
 * @param {boolean}  [args.fromMe]          the owner's own outgoing message
 * @param {string}   [args.defaultCountryCode]
 * @returns {{ingest: boolean, reason: string}}
 */
function shouldIngest({
  ingestMode = 'all',
  phone,
  allowlist = [],
  blocked = [],
  notifyPhone = null,
  fromMe = false,
  defaultCountryCode = '234',
}) {
  // The owner's own outgoing messages arrive on the socket too. They are not
  // customer enquiries and storing them would put the owner's side of every
  // private conversation in the record.
  if (fromMe) return { ingest: false, reason: 'from_owner' };

  const normalised = normalizeMsisdn(phone, defaultCountryCode);
  if (!normalised) {
    // Fails closed: a sender we cannot identify cannot be checked against
    // either list, so keeping it would bypass both.
    return { ingest: false, reason: 'unresolvable_number' };
  }

  const blockSet = new Set(
    (blocked || []).map((n) => normalizeMsisdn(n, defaultCountryCode)).filter(Boolean)
  );
  if (blockSet.has(normalised)) {
    return { ingest: false, reason: 'blocked_sender' };
  }

  if (ingestMode === 'allowlist') {
    const allowSet = new Set(
      (allowlist || []).map((n) => normalizeMsisdn(n, defaultCountryCode)).filter(Boolean)
    );
    // The staff alert line is allowlisted by the fact that it IS the alert
    // line — the pharmacy named it in settings, and the system already sends
    // it order briefings containing a customer's name, medicines and
    // complaint. Requiring it to ALSO appear in the pilot allowlist meant a
    // pharmacy testing on two numbers got the "reply 1 to confirm" alert and
    // had the reply silently discarded here, before anything could act on it.
    //
    // Checked AFTER the block list on purpose. Blocking a number is the more
    // deliberate, more specific instruction of the two, and a configuration
    // that both blocks a number and names it as the alert line is a mistake
    // that should fail towards storing less, not more.
    const staffLine = normalizeMsisdn(notifyPhone, defaultCountryCode);
    if (!allowSet.has(normalised) && !(staffLine && staffLine === normalised)) {
      return { ingest: false, reason: 'not_allowlisted' };
    }
  }

  // Unknown mode keeps the message. Losing a real customer to a typo in a
  // config value is worse than storing one we did not need — the message is
  // gone forever, and nothing will retry it.
  return { ingest: true, reason: 'ok' };
}

module.exports = { shouldIngest };
