/**
 * Final polish on an outbound message, applied at the moment of sending.
 *
 * WHY THIS IS A FUNCTION AND NOT A PROMPT INSTRUCTION
 * The same reasoning as replyValidator: a prompt asking the model to bold
 * prices is a request it will honour most of the time, and "most of the
 * time" produces a channel where some messages are formatted and some are
 * not, which reads worse than none being formatted at all. Consistency here
 * is only achievable deterministically.
 *
 * RUNS AFTER VALIDATION, NEVER BEFORE.
 * replyValidator reads the model's raw draft. This adds asterisks around
 * money, and a validator seeing `*₦430*` instead of `₦430` is a validator
 * one regex change away from silently passing an invented price. Format last,
 * check first — the order is load-bearing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not rewrite words, reorder sentences, or shorten anything. Every
 * transformation here is presentational and reversible; if it ever changed
 * what a message SAYS, it would be editing a pharmacy's words after they had
 * been checked, which is exactly the thing this system is careful not to do.
 *
 * Pure. No model, no network, no database.
 */

/**
 * WhatsApp's own markup — a single asterisk pair, not markdown's double.
 * `**bold**` renders literally as asterisks on a phone, which is the most
 * common way this goes wrong.
 */
const BOLD = (s) => `*${s}*`;

/**
 * ₦1,300 · ₦430.50 · ₦900 — the shapes replyValidator already recognises.
 *
 * Thousands separators are matched as `,` followed by EXACTLY three digits,
 * not as a loose `[\d,]*`. The loose version swallowed the comma that ends a
 * clause — "₦3,940, reference GRW-YT4" bolded as `*₦3,940,*`, dragging the
 * sentence's punctuation inside the emphasis. Caught by the figures-unchanged
 * test, which is precisely what that test is for.
 */
const MONEY = /(₦\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;

/**
 * An order reference: three characters, a hyphen, three characters, from the
 * unambiguous alphabet generateReference uses. Bounded by word edges so it
 * cannot catch a hyphenated word or a date.
 */
const REFERENCE = /\b([2-9A-Z]{3}-[2-9A-Z]{3})\b/g;

/** Already-emphasised text, so a second pass cannot produce `**₦430**`. */
function alreadyBold(text, index) {
  return text[index - 1] === '*' || text[index - 1] === '_';
}

/**
 * Bold every price and order reference.
 *
 * These two are singled out because they are what a customer actually looks
 * for: what it costs, and the code they will read out at the counter. Bolding
 * more than that is how a message ends up with no emphasis at all — if
 * everything is bold, nothing is.
 */
function emphasiseFacts(text) {
  let out = text.replace(MONEY, (m, val, offset, full) => (
    alreadyBold(full, offset) ? m : BOLD(val.replace(/₦\s+/, '₦'))
  ));
  out = out.replace(REFERENCE, (m, ref, offset, full) => (
    alreadyBold(full, offset) ? m : BOLD(ref)
  ));
  return out;
}

/**
 * Normalise list markers to one shape.
 *
 * Models drift between "-", "*", "•" and "· " across turns, sometimes inside
 * a single reply. On a phone the difference is very visible and reads as
 * three different senders. "•" wins because it is the one that does NOT
 * collide with WhatsApp's own markup: a line starting "* Panadol" renders as
 * a stray asterisk, and "- " reads as a dash mid-sentence.
 */
function normaliseBullets(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*·]\s+/, '• '))
    .join('\n');
}

/**
 * Collapse runaway whitespace.
 *
 * A blank line between blocks is deliberate and useful; three are an
 * accident, and on a narrow screen they push the actual question off the
 * visible area. Trailing spaces are invisible in the source and produce a
 * ragged right edge in the bubble.
 */
function tidyWhitespace(text) {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Put each bullet on its own line.
 *
 * Real traffic produced options run together on one line when the model was
 * terse, which turns a scannable list back into a paragraph. Only splits
 * where a bullet marker genuinely follows sentence-ending punctuation, so a
 * "•" used mid-sentence is left alone.
 *
 * The colon is in that set because it is how a list is introduced — "here
 * are my picks: • Panadol — ₦1,300." left the FIRST product welded to the
 * lead-in sentence while every later one broke correctly, so a three-item
 * list came out as a paragraph followed by two bullets. It is still
 * punctuation-anchored rather than splitting on every "•", which is what
 * keeps a separator usage ("Open 9am • 5pm daily") intact.
 */
function breakBullets(text) {
  return text.replace(/([.!?:])\s+•\s*/g, '$1\n• ');
}

/**
 * @param {string} text  the validated reply, exactly as approved
 * @returns {string} the same message, formatted for a phone screen
 */
function formatForWhatsApp(text) {
  if (typeof text !== 'string' || !text.trim()) return text;

  let out = text;
  out = breakBullets(out);
  out = normaliseBullets(out);
  out = emphasiseFacts(out);
  out = tidyWhitespace(out);
  return out;
}

module.exports = {
  formatForWhatsApp,
  // exported for tests — each rule is worth pinning on its own, because a
  // regression in one is invisible inside the combined output
  emphasiseFacts,
  normaliseBullets,
  tidyWhitespace,
  breakBullets,
};
