/**
 * The three voices a pharmacy can choose, and the exact sentence each one
 * puts into the system prompt.
 *
 * WHY THE PROMPT LINE IS FIXED HERE RATHER THAN STORED
 * The pharmacy picks a KEY; this file owns the wording. If the wording lived
 * in the database an owner could type anything into it, and that text would
 * be handed to the model as an instruction — a prompt-injection surface
 * opened by a settings screen. Everything else in this codebase treats
 * owner- and customer-supplied text as facts rather than directives, and a
 * tone setting is not the place to make an exception.
 *
 * WHAT NONE OF THESE MAY DO
 * Tone is manner, not permission. No value here makes the assistant more
 * willing to give clinical advice, quote an unverified price, or soften a
 * refusal — those are decided by the clinical filter and the reply validator,
 * which run regardless of tone. A "confident expert" option was deliberately
 * NOT offered: it is the one word most likely to read, to a model, as
 * licence to answer the questions this system exists to route to a
 * pharmacist.
 *
 * The three were chosen against how Nigerian community pharmacies actually
 * speak to customers on WhatsApp, not against a generic brand-voice chart.
 */

const TONES = Object.freeze({
  warm: {
    key: 'warm',
    label: 'Warm and familiar',
    // What the owner sees. Written as the customer's experience, because
    // that is what they are choosing between.
    blurb: 'Greets people properly, uses “ma” and “sir”, sounds like the counter staff.',
    sample: 'Good morning ma! Yes we have it — Amlodipine 10mg is ₦1,480 a card. How many do you need?',
    line: 'TONE: Warm and familiar, like a trusted neighbourhood pharmacy. Greet people properly, '
      + 'use "ma" and "sir" naturally where a Nigerian counter attendant would, and keep sentences short '
      + 'and friendly. Never let warmth turn into over-familiarity or filler.',
  },

  professional: {
    key: 'professional',
    label: 'Professional and brisk',
    blurb: 'Straight to the answer. Minimal small talk. Suits a busy counter.',
    sample: 'Yes, in stock. Amlodipine 10mg — ₦1,480 per card. How many would you like?',
    line: 'TONE: Professional and brisk. Lead with the answer, keep pleasantries to a minimum, and do not '
      + 'pad replies with small talk. Stay polite and never clipped to the point of sounding rude.',
  },

  reassuring: {
    key: 'reassuring',
    label: 'Calm and reassuring',
    blurb: 'Unhurried and patient — for customers who are worried or unwell.',
    sample: 'Yes, we have that one. Amlodipine 10mg is ₦1,480 a card — take your time, just tell me how many you need.',
    line: 'TONE: Calm and reassuring. Assume the person may be unwell or anxious. Keep a steady, unhurried '
      + 'register, acknowledge what they have said before answering, and never rush them. Reassurance is '
      + 'about MANNER only — it never means offering comfort about a medical question you must not answer.',
  },
});

const DEFAULT_TONE = 'warm';

/** Every value the settings UI may offer, in the order it should present them. */
const TONE_OPTIONS = Object.freeze(
  Object.values(TONES).map(({ key, label, blurb, sample }) => ({ key, label, blurb, sample })),
);

/**
 * The prompt line for a stored key.
 *
 * Falls back rather than throwing: an unrecognised value (a hand-edited row,
 * a key removed in a later version) must not take the assistant offline for
 * that pharmacy. A wrong-but-safe voice beats no reply.
 */
function toneLine(key) {
  return (TONES[key] || TONES[DEFAULT_TONE]).line;
}

function isValidTone(key) {
  return Object.prototype.hasOwnProperty.call(TONES, key);
}

module.exports = { TONES, TONE_OPTIONS, DEFAULT_TONE, toneLine, isValidTone };
