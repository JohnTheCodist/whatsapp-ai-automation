/**
 * Deciding whether a customer is a trade account, from the QR code they
 * arrived through.
 *
 * THE PROBLEM THIS SOLVES
 * A pharmacy sells at two prices and nobody has time to tag customers. Three
 * other designs were considered and rejected:
 *
 *   manual tagging   — does not happen in a busy pharmacy
 *   self-declaration — everyone claims the trade price
 *   volume inference — a family collecting three months of a chronic medicine
 *                      looks exactly like a small bulk order, and guessing
 *                      wrong here is guessing wrong about money
 *
 * The QR code decides instead, because it is the one signal the PHARMACY
 * already controls: they choose who gets handed the trade code. It goes on
 * invoices and delivery notes for buyers they already deal with; the retail
 * code goes on the counter.
 *
 * Both codes point at the same number, so this costs no second SIM, no second
 * pairing, and no second socket.
 *
 * WHAT MAKES THE CODE SAFE ENOUGH
 * It is not a password and does not protect anything dangerous — the worst a
 * leak does is give someone trade prices. But it should not be *guessable* by
 * someone poking at wa.me links, so it is generated with crypto randomness
 * rather than derived from the pharmacy name.
 *
 * The check is deliberately narrow: the code must be the ONLY meaningful
 * thing in the first message. A customer who happens to quote the code inside
 * a sentence is not arriving through the link — and a retail customer who
 * learns the code from an invoice can still use it, which is a decision for
 * the pharmacy about who they hand paperwork to, not something this file can
 * police.
 */

const crypto = require('node:crypto');

/**
 * Prefix so the token is recognisable in a message log as a trade arrival
 * rather than a customer typing something odd.
 */
const PREFIX = 'TRADE-';

/**
 * Ambiguous characters removed for the same reason order references drop
 * them: this string gets printed on paperwork and occasionally read aloud
 * over a phone line in a noisy shop.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Generate a pharmacy's trade code. */
function generateWholesaleCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${PREFIX}${out}`;
}

/**
 * Is this inbound message someone arriving through a trade link?
 *
 * Matches only when the code is effectively the whole message, which is what
 * a wa.me prefilled text produces. Punctuation and surrounding whitespace are
 * tolerated because WhatsApp clients occasionally append or trim.
 *
 * Case-insensitive: the prefill is fixed, but a customer who retypes it by
 * hand from an invoice should not fail on capitals.
 *
 * @returns {string|null} the normalised code, or null
 */
function extractWholesaleCode(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 64) return null;

  const m = trimmed.match(new RegExp(`^[\\s"'.,!-]*(${PREFIX}[A-Z0-9]{8})[\\s"'.,!]*$`, 'i'));
  return m ? m[1].toUpperCase() : null;
}

/**
 * The wa.me links a pharmacy prints.
 *
 * The retail link carries no prefill at all — a customer opening it types
 * their own first message, which is the normal experience. Only the trade
 * link is prefilled, and only with the code.
 */
function buildLinks(phoneDigits, wholesaleCode) {
  const number = String(phoneDigits || '').replace(/\D/g, '');
  if (!number) return { retail: null, wholesale: null };
  return {
    retail: `https://wa.me/${number}`,
    wholesale: wholesaleCode
      ? `https://wa.me/${number}?text=${encodeURIComponent(wholesaleCode)}`
      : null,
  };
}

/**
 * Does this message carry THIS pharmacy's trade code?
 *
 * Compared against the pharmacy's own stored code rather than just matching
 * the shape, so one pharmacy's code cannot promote a customer at another —
 * the codes are unique across the table, and a shape-only check would let a
 * leaked code work everywhere it was pasted.
 *
 * timingSafeEqual is used out of habit rather than necessity: this is not a
 * secret worth attacking, but the comparison is free and the alternative is
 * explaining later why one credential-shaped check in the codebase leaks
 * length through early exit.
 */
function isTradeCode(text, expectedCode) {
  const found = extractWholesaleCode(text);
  if (!found || !expectedCode) return false;

  const a = Buffer.from(found, 'utf8');
  const b = Buffer.from(String(expectedCode).toUpperCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  generateWholesaleCode, extractWholesaleCode, isTradeCode, buildLinks, PREFIX,
};
