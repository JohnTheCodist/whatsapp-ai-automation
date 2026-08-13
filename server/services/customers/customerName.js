/**
 * Names: cleaning them, splitting them, and — the important one — proving the
 * customer actually said the name being stored.
 *
 * THE PROBLEM THIS SOLVES
 * Extracting "John Adeyemi" from "my name is john adeyemi pls" is natural
 * language work, which the model is good at and a regex is bad at. But a
 * model asked for a name will always produce one, and the plausible wrong
 * answers here are dangerous in a specific way: it can reach for the WhatsApp
 * display name ("John's iPhone"), invent a surname to make "John" look
 * complete, or carry a name over from an earlier unrelated sentence. Any of
 * those ends up printed on a package.
 *
 * So the division is: the model may EXTRACT, the application VERIFIES.
 * isGroundedIn() checks every word of the proposed name appears in what the
 * customer actually typed. A name the customer did not type cannot be saved,
 * regardless of what the model returns — the same shape as replyValidator,
 * applied to identity instead of prices.
 *
 * Pure. No database, no model, no I/O.
 */

/** Strip punctuation and collapse whitespace, preserving letters and marks. */
function normaliseWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Words that are part of the sentence, not part of the name.
 *
 * Deliberately short. This is not trying to parse English — it exists so that
 * "my name is John" does not become the four-word name "my name is John" when
 * the model passes the sentence through unchanged.
 */
const LEAD_IN = /^(?:(?:my|the)\s+(?:full\s+)?name\s+(?:is|na)\s+|i\s+am\s+|i'?m\s+|it'?s\s+|this\s+is\s+|call\s+me\s+|na\s+)/i;

/** Trailing politeness that real customers append: "John Adeyemi pls", "…thanks". */
const TRAILING_NOISE = /[\s,.]+(?:please|pls|abeg|thanks?|thank\s+you|sir|ma|ma'?am)\s*$/i;

/**
 * Clean a name the customer gave, without inventing anything.
 *
 * @param {string} raw
 * @returns {string|null} the cleaned name, or null if nothing usable remains
 */
function cleanName(raw) {
  let s = normaliseWhitespace(raw);
  if (!s) return null;

  s = s.replace(LEAD_IN, '');
  s = s.replace(TRAILING_NOISE, '');
  // Quotes and trailing punctuation, but NOT internal hyphens or apostrophes:
  // Ada-Obi and O'Brien are names, not noise.
  s = s.replace(/^["'“”]+|["'“”.,!?]+$/g, '');
  s = normaliseWhitespace(s);

  if (!s) return null;
  // A name has to contain at least one letter. Digits-only or symbols-only is
  // someone answering a different question.
  if (!/\p{L}/u.test(s)) return null;
  if (s.length > 120) return null;

  return s;
}

/**
 * Does every word of `name` appear in what the customer actually wrote?
 *
 * This is the guard that makes it impossible for a name to be invented,
 * imported from the WhatsApp display name, or carried over from an earlier
 * message. Word-level rather than substring: a substring check would accept
 * "Ada" from the word "Canada", and accept a surname the customer never said
 * as long as its letters happened to occur somewhere.
 *
 * @param {string} name          the proposed name
 * @param {string} customerText  the customer's own message
 * @returns {boolean}
 */
function isGroundedIn(name, customerText) {
  const cleaned = cleanName(name);
  if (!cleaned) return false;

  const said = new Set(
    String(customerText || '')
      .toLowerCase()
      // Split on anything that is not a letter, mark, hyphen or apostrophe,
      // so "john-paul" and "o'brien" survive as single tokens.
      .split(/[^\p{L}\p{M}'-]+/u)
      .filter(Boolean)
  );
  if (said.size === 0) return false;

  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => said.has(w));
}

/**
 * Split a cleaned full name into first and last.
 *
 * One word gives a first name and a NULL last name — never an empty string,
 * and never a guess. Three or more words keep everything after the first as
 * the last name rather than trying to identify a middle name, because
 * "Ngozi Chukwuemeka Okonkwo" has no reliable rule and getting it wrong is
 * worse than not splitting it.
 *
 * @param {string} fullName
 * @returns {{firstName: string|null, lastName: string|null, fullName: string|null}}
 */
function splitName(fullName) {
  const cleaned = cleanName(fullName);
  if (!cleaned) return { firstName: null, lastName: null, fullName: null };

  const parts = cleaned.split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
    fullName: cleaned,
  };
}

/**
 * Is this message plausibly the customer answering "what is your name?"
 *
 * Used only to decide whether it is worth ASKING the model to extract a name
 * — never to extract one. A false positive here costs an extra model call; a
 * false negative just means the assistant asks again.
 */
function looksLikeNameReply(text) {
  const s = normaliseWhitespace(text);
  if (!s || s.length > 80) return false;
  if (LEAD_IN.test(s)) return true;
  // Bare "John Adeyemi" — one to four words, all letters.
  const words = s.replace(TRAILING_NOISE, '').split(/\s+/);
  return words.length <= 4 && words.every((w) => /^[\p{L}\p{M}'-]+$/u.test(w));
}

module.exports = { cleanName, isGroundedIn, splitName, looksLikeNameReply };
