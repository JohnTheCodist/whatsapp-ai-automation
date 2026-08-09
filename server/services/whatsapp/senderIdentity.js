/**
 * Who sent this message, and where do we reply?
 *
 * WhatsApp is migrating to LIDs — opaque identifiers that are NOT phone
 * numbers. Real traffic arrives looking like this:
 *
 *   remoteJid:      198350347493478@lid          <- addressable, meaningless
 *   remoteJidAlt:   2349013993683@s.whatsapp.net <- the actual number
 *   addressingMode: lid
 *
 * Those two facts have different jobs and must not be conflated:
 *
 *   - The LID is what we REPLY to. It is how WhatsApp addressed us and is
 *     the identifier guaranteed to route.
 *   - The phone number is what a HUMAN recognises. A pharmacist looking at
 *     "198350347493478" cannot tell which customer that is, cannot match it
 *     to a walk-in, and cannot phone them.
 *
 * Storing only the LID makes the dashboard useless to staff. Replying to
 * only the phone number risks not routing. So we keep both.
 *
 * Pure. No sockets, no database.
 */

/** Digits after the '@', or null. */
function userPart(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const at = jid.lastIndexOf('@');
  if (at <= 0) return null;
  const user = jid.slice(0, at).split(':')[0]; // strip any device suffix
  return /^[0-9]+$/.test(user) ? user : null;
}

function domainPart(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const at = jid.lastIndexOf('@');
  return at === -1 ? null : jid.slice(at + 1);
}

/**
 * @param {object} key  msg.key from Baileys
 * @param {string} [pushName]
 * @returns {{replyJid: string|null, phone: string|null, lid: string|null, displayName: string|null}}
 */
function resolveSender(key, pushName) {
  const remoteJid = key?.remoteJid || null;
  const altJid = key?.remoteJidAlt || null;

  const remoteDomain = domainPart(remoteJid);
  const altDomain = domainPart(altJid);

  let phone = null;
  let lid = null;

  if (remoteDomain === 'lid') {
    lid = userPart(remoteJid);
    // The alt is where the real number lives when addressing is by LID.
    if (altDomain === 's.whatsapp.net') phone = userPart(altJid);
  } else if (remoteDomain === 's.whatsapp.net') {
    phone = userPart(remoteJid);
    // Some payloads carry the LID in the alt instead — the mirror case.
    if (altDomain === 'lid') lid = userPart(altJid);
  }

  return {
    // Always reply to the JID that addressed us. Substituting the phone
    // number would be guessing at routing WhatsApp already told us.
    replyJid: remoteJid,
    phone,
    lid,
    displayName: pushName ? String(pushName).slice(0, 100) : null,
  };
}

/**
 * Normalise a human-typed number to international digits.
 *
 * Nigerian numbers are written locally as 09013993683 and internationally as
 * 2349013993683. An allowlist that treats those as different values fails in
 * exactly the way an allowlist must not: silently, by not matching.
 *
 * @param {string} input
 * @param {string} [defaultCountryCode] applied when a local trunk '0' is stripped
 * @returns {string|null} digits only, or null if unusable
 */
function normalizeMsisdn(input, defaultCountryCode = '234') {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/[^0-9]/g, '');
  if (!digits) return null;

  // Local trunk prefix: 0803... -> <cc>803...
  if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.replace(/^0+/, '');
  }

  // Too short to be a real subscriber number even with a country code.
  if (digits.length < 10) return null;
  return digits;
}

module.exports = { resolveSender, normalizeMsisdn, userPart, domainPart };
