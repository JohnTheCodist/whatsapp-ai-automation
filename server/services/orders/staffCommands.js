/**
 * Acting on an order from the pharmacy's own WhatsApp, without a dashboard.
 *
 * WHY THIS EXISTS
 * Staff already receive every new order on their personal WhatsApp
 * (staffAlert.js). Until now the alert ended "Confirm in the dashboard" —
 * so the notification arrived where they actually are, and the action lived
 * somewhere they have to stop, find a laptop, and log into. In a shop with
 * one counter and no back office, that gap is why orders sit unconfirmed
 * while the customer waits.
 *
 * THE RULE THAT MAKES THIS SAFE: A COMMAND MUST RESOLVE TO EXACTLY ONE ORDER.
 * A bare "ok" or "1" does not name an order, so this module reports it as
 * `needs_reference` and lets the caller decide. The caller's rule is narrow
 * and is the whole safety argument: it acts only when the pharmacy has
 * EXACTLY ONE order waiting, and otherwise lists them and asks which.
 *
 * There is deliberately no "the most recent order" fallback. The last order
 * the SYSTEM saw and the last one the PHARMACIST read are different things
 * the moment two arrive close together, and the cost of guessing wrong is
 * confirming stock for the wrong customer or rejecting an order that was
 * fine. One waiting order is unambiguous; two is a question.
 *
 * WHAT THIS MODULE DOES NOT DO
 * It does not authorise anybody. Deciding that a sender is staff is the
 * caller's job (it compares against the pharmacy's configured notify_phone),
 * because authorisation depends on the pharmacy row and this file is pure —
 * text in, intent out, no database and no clock.
 */

/**
 * The words a busy person actually types, mapped to the status they mean.
 *
 * `ok` and `yes` are included because that is the natural reply to an alert
 * asking for confirmation, and refusing them would make the feature feel
 * broken. They still require a reference like every other verb.
 *
 * 'ready' maps to the same status the dashboard's single button produces —
 * see orderService.ALLOWED_TRANSITIONS, where pending -> ready is legal
 * precisely so confirming and marking ready are one action.
 */
const VERBS = [
  // Numbers first, and they are the headline shortcut: the alert prints
  // "Reply 1 to confirm, 2 to reject", so a pharmacist mid-shift types one
  // character.
  //
  // The pattern accepts ONLY a bare digit, or a digit followed by a
  // reference and nothing else. It deliberately does not accept a digit
  // followed by prose: "2 packs are gone" is a sentence about stock, and
  // reading it as "reject the waiting order" would be a destructive action
  // taken on a message that was not a command at all. A quantity at the
  // start of a sentence is far too common to treat as an instruction.
  { re: /^1(\s+[0-9A-Z]{3}-[0-9A-Z]{3})?$/i, action: 'ready' },
  { re: /^2(\s+[0-9A-Z]{3}-[0-9A-Z]{3})?$/i, action: 'rejected' },
  { re: /^3(\s+[0-9A-Z]{3}-[0-9A-Z]{3})?$/i, action: 'completed' },

  { re: /^(ok|okay|yes|y|confirm|confirmed|accept|approve)\b/i, action: 'ready' },
  { re: /^(ready|done|prepared)\b/i, action: 'ready' },
  { re: /^(reject|decline|refuse|no|n)\b/i, action: 'rejected' },
  { re: /^(cancel|cancelled)\b/i, action: 'cancelled' },
  { re: /^(collected|picked|pickup|complete|completed)\b/i, action: 'completed' },
];

/**
 * References are three characters, a hyphen, then three, from an alphabet
 * with the ambiguous glyphs removed (see orderService.generateReference).
 * Matched case-insensitively and anywhere in the message, because people
 * write "ok ABC-DEF", "ABC-DEF ok", and "confirm order ABC-DEF" equally.
 *
 * The hyphen is required. Without it this would match ordinary words and
 * turn "confirm the paracetamol" into an action on a fabricated reference.
 */
const REFERENCE = /\b([0-9A-Z]{3}-[0-9A-Z]{3})\b/i;

/** Asking what is waiting, rather than acting on one thing. */
const LIST = /^(list|orders|pending|what'?s pending|status)\b/i;

/** A request for the commands, which staff will need exactly once. */
const HELP = /^(help|commands|\?)\s*$/i;

/**
 * @param {string} text
 * @returns {null | {kind:'help'}
 *                 | {kind:'list'}
 *                 | {kind:'act', action:string, reference:string}
 *                 | {kind:'needs_reference', action:string}}
 *   null means "this is not a staff command" — the caller should treat the
 *   message as ordinary conversation rather than guessing.
 */
function parseStaffCommand(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  if (HELP.test(t)) return { kind: 'help' };
  if (LIST.test(t)) return { kind: 'list' };

  const verb = VERBS.find((v) => v.re.test(t));
  if (!verb) return null;

  const ref = t.match(REFERENCE);
  if (!ref) {
    // The verb was recognised but no order was named. Reported as its own
    // outcome rather than as "not a command", so the caller can answer
    // "which order?" instead of silently ignoring someone who is trying to
    // confirm something.
    return { kind: 'needs_reference', action: verb.action };
  }

  return { kind: 'act', action: verb.action, reference: ref[1].toUpperCase() };
}

/** What staff are told when they ask, and after a failed parse. */
function helpText() {
  return [
    'When one order is waiting, just reply:',
    '',
    '  1   confirm and mark ready',
    '  2   reject — cannot supply it',
    '  3   collected',
    '',
    'If more than one is waiting, name it:',
    '',
    '  1 ABC-DEF        or   OK ABC-DEF',
    '  2 ABC-DEF        or   REJECT ABC-DEF',
    '',
    'Send LIST to see what is waiting.',
    'The customer is messaged automatically either way.',
  ].join('\n');
}

module.exports = { parseStaffCommand, helpText, VERBS, REFERENCE };
