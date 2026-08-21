/**
 * The trade code: how a customer becomes a wholesale account without anyone
 * tagging them.
 *
 * THE PROBLEM THIS SOLVES
 * A pharmacy sells at two prices, and the system has to know which applies —
 * without staff tagging customers by hand (it never happens), without letting
 * customers declare themselves (everyone would claim trade), and without
 * inferring from purchase size (a family collecting three months of a chronic
 * medicine looks exactly like a small bulk order, and guessing wrong there
 * removes a real patient from the clinical register).
 *
 * A wa.me link can carry a prefilled message, so the pharmacy prints two QR
 * codes pointing at the SAME number:
 *
 *   retail     wa.me/<number>
 *   wholesale  wa.me/<number>?text=<trade code>
 *
 * The retail code goes on the counter; the trade code goes on invoices and
 * delivery notes, handed only to buyers the pharmacy already deals with.
 * Scanning it sends one message whose text is the code, and that first
 * message is what marks the account.
 *
 * WHY THE CODE LOOKS THE WAY IT DOES
 * Short enough to sit under a QR square and be read aloud over a phone, and
 * random enough not to be guessed by someone who has only seen the retail
 * code. It is NOT a secret in the security sense — anyone who is shown an
 * invoice can read it — and it does not need to be. The worst case is a
 * retail customer getting trade pricing on a bulk order, which the pharmacy
 * still confirms by hand before anything is dispensed.
 *
 * Ambiguous characters are excluded for the same reason order references
 * exclude them: these get read down a phone line in a noisy shop.
 */

const crypto = require('node:crypto');

/**
 * No 0/O, 1/I/L, 5/S, 8/B — they are misread aloud and in handwriting.
 *
 * The literal previously contained a full-width ９ (U+FF19), which a
 * defensive `.replace(/[^0-9A-Z]/g, '')` silently stripped — so the alphabet
 * was quietly one character shorter than it reads. The filter is kept because
 * it is cheap insurance against exactly that happening again on a copy-paste,
 * but the source characters are now all ASCII.
 */
const ALPHABET = '234679ACDEFGHJKMNPQRTUVWXYZ'.replace(/[^0-9A-Z]/g, '');

const CODE_BODY_LENGTH = 4;

/**
 * `WS-` prefixed so a pharmacist seeing it in a message list knows instantly
 * what it is, and so a stray four-character message cannot be mistaken for
 * one.
 */
function generateTradeCode() {
  const bytes = crypto.randomBytes(CODE_BODY_LENGTH);
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) {
    body += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `WS-${body}`;
}

/**
 * Is this message the trade code, and nothing else?
 *
 * DELIBERATELY STRICT. The QR sends exactly the code, so an exact match after
 * trimming is all that is ever needed for the real path. Accepting it inside
 * a longer sentence would mean a customer who was told the code over the
 * phone — or who saw it on someone else's invoice — could type "hi is WS-4821
 * still valid" and upgrade themselves.
 *
 * Case-insensitive because phone keyboards capitalise the first word, and the
 * customer did not type this on purpose in the first place.
 */
function isTradeCode(text, code) {
  if (!code || typeof text !== 'string') return false;
  return text.trim().toUpperCase() === String(code).trim().toUpperCase();
}

/**
 * The two links a pharmacy prints.
 *
 * The number is used exactly as stored — bare digits, no plus, no spaces —
 * because this string goes into a URL that gets printed. A space or a leading
 * "+" produces a link that fails silently after the flyers exist.
 */
function buildLinks(publicNumber, tradeCode) {
  const digits = String(publicNumber || '').replace(/\D/g, '');
  if (!digits) return { retail: null, wholesale: null };

  const retail = `https://wa.me/${digits}`;
  return {
    retail,
    wholesale: tradeCode ? `${retail}?text=${encodeURIComponent(tradeCode)}` : null,
  };
}

module.exports = { generateTradeCode, isTradeCode, buildLinks, CODE_BODY_LENGTH };
