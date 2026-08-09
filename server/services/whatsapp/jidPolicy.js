/**
 * Which conversations the assistant is allowed to participate in.
 *
 * WHY THIS IS AN ALLOWLIST, NOT AN EXCLUSION LIST
 * The obvious implementation is "reply unless it's a group". That fails
 * open: WhatsApp adds addressable JID types over time (newsletters and LIDs
 * both arrived after the original API), and anything unrecognised would
 * default to "this is a customer, reply to it".
 *
 * The cost of that failure is not a bug report. An assistant answering
 * inside a group chat broadcasts one customer's medicine enquiry to everyone
 * in it — a privacy incident involving health information, caused by a
 * default. So unknown types are ignored, and adding support for a new one is
 * a deliberate act.
 *
 * Baileys v7 has no `isJidUser` export (it did in earlier versions), so this
 * is written against the JID domains directly with the library's own
 * predicates as a second layer.
 *
 * Pure. No sockets, no database.
 */

const {
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidNewsletter,
  isJidBot,
  isJidMetaAI,
} = require('baileys');

/**
 * The only two domains that represent a one-to-one human conversation.
 *
 * `@s.whatsapp.net` is the classic phone-number JID. `@lid` is the newer
 * privacy-preserving identifier WhatsApp is migrating toward — a real
 * customer, addressed differently. Omitting it would mean silently ignoring
 * a growing share of genuine messages.
 */
const DIRECT_USER_DOMAINS = new Set(['s.whatsapp.net', 'lid']);

/**
 * @param {string} jid
 * @returns {boolean} true only for a direct chat with one human
 */
function isDirectUserChat(jid) {
  if (!jid || typeof jid !== 'string') return false;

  const at = jid.lastIndexOf('@');
  if (at === -1) return false;

  const domain = jid.slice(at + 1);
  const user = jid.slice(0, at);
  if (!DIRECT_USER_DOMAINS.has(domain)) return false;
  // 'status@broadcast' has a valid-looking shape; an empty or non-numeric
  // user part is not a person.
  if (!user || !/^[0-9]+(:[0-9]+)?$/.test(user)) return false;

  // Defence in depth: if the library disagrees, believe the library.
  if (safe(isJidGroup, jid)) return false;
  if (safe(isJidBroadcast, jid)) return false;
  if (safe(isJidStatusBroadcast, jid)) return false;
  if (safe(isJidNewsletter, jid)) return false;
  if (safe(isJidBot, jid)) return false;
  if (safe(isJidMetaAI, jid)) return false;

  return true;
}

/**
 * Predicates come and go across Baileys versions. A missing one should not
 * throw and take a live socket's message handler down with it — it should
 * just not contribute an opinion.
 */
function safe(fn, jid) {
  try {
    return typeof fn === 'function' ? Boolean(fn(jid)) : false;
  } catch {
    return false;
  }
}

module.exports = { isDirectUserChat, DIRECT_USER_DOMAINS };
