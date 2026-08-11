/**
 * What the customer is told when the assistant will not answer.
 *
 * THE OLD MESSAGE WAS ONE LINE FOR EVERY CASE
 * "Let me get one of our pharmacists to help you with that." Accurate,
 * and it left the customer with no idea why an assistant that had just
 * quoted three prices suddenly went quiet. Someone asking about their
 * child's medicine reads that as the system failing, not as a deliberate
 * refusal.
 *
 * URGENCY DECIDES WHETHER WE ASK
 * The obvious improvement — "would you like to speak to a pharmacist?" —
 * is right for most cases and wrong for the ones that matter most. Asking
 * a permission question of someone describing an overdose costs a round
 * trip on WhatsApp, and they may not send another message. So:
 *
 *   urgent      -> act. Escalate, say so, and tell them what to do NOW.
 *   non-urgent  -> explain why, and offer the pharmacist as a choice.
 *
 * WHY THE REASON IS NAMED
 * "I'm not able to choose medicine for a child" tells the customer the
 * boundary is deliberate and professional. It reads as a pharmacy that
 * knows its limits rather than a bot that broke, and it is the honest
 * description of what just happened.
 *
 * Pure. No database, no sending.
 */

/**
 * Categories where waiting for the customer to opt in is the wrong trade.
 * Escalate immediately and say so.
 */
const URGENT = new Set(['emergency', 'overdose', 'adverse_reaction']);

/** Nothing to explain — the customer asked for a human, or we simply failed. */
const SILENT_OR_PLAIN = new Set([
  'prompt_injection', 'unreadable', 'filter_error',
  'assistant_unavailable', 'assistant_error', 'unverified_reply', 'max_iterations',
]);

/**
 * The reason, in the customer's terms. Each states the boundary rather than
 * apologising for a malfunction, because a boundary is what it is.
 */
const REASON = {
  emergency:
    'This sounds like it may be an emergency.',
  overdose:
    'This sounds like it could be a case of too much medicine being taken.',
  adverse_reaction:
    'A reaction to medicine needs a pharmacist, not me.',
  paediatric:
    "I'm not able to choose or recommend medicine for a child — that has to come from our pharmacist.",
  pregnancy:
    "I'm not able to advise on medicine during pregnancy or breastfeeding — our pharmacist handles that.",
  dosage:
    "I'm not able to advise on how much to take or how often — only our pharmacist can.",
  drug_interaction:
    "I'm not able to advise on whether medicines can be taken together — our pharmacist can.",
  symptoms:
    "I'm not able to work out what medicine suits your symptoms — our pharmacist can help with that.",
  clinical_comparison:
    "I'm not able to say which medicine would work better for you — that's our pharmacist's judgement.",
  prescription:
    'Anything involving a prescription needs our pharmacist.',
};

/**
 * @param {string} category
 * @param {object} [opts]
 * @param {string} [opts.pharmacyPhone] shown on urgent messages if known
 * @returns {{text: string|null, urgent: boolean, asksPermission: boolean}}
 *   `text` null means send nothing — a technical failure is not the
 *   customer's problem to be told about.
 */
function escalationMessage(category, { pharmacyPhone = null } = {}) {
  if (category === 'human_requested') {
    // They asked for a person. Asking whether they want one would be absurd.
    return {
      text: "Of course — I'm passing you to one of our team now. They'll reply here.",
      urgent: false,
      asksPermission: false,
    };
  }

  if (SILENT_OR_PLAIN.has(category)) {
    return {
      text: "Let me get one of our team to pick this up with you here.",
      urgent: false,
      asksPermission: false,
    };
  }

  const reason = REASON[category];

  if (URGENT.has(category)) {
    // No question, and the safety advice comes FIRST. A pharmacist replying
    // on WhatsApp is not the right answer to an emergency, and implying it
    // is would be the most harmful thing this system could say.
    const call = pharmacyPhone ? ` You can also call us on ${pharmacyPhone}.` : '';
    return {
      text: `${reason} Please get medical help straight away — go to the nearest hospital or call your doctor. `
        + `I've alerted our pharmacist and they'll reply here too.${call}`,
      urgent: true,
      asksPermission: false,
    };
  }

  if (reason) {
    return {
      text: `${reason}\n\nWould you like me to pass you to them?`,
      urgent: false,
      asksPermission: true,
    };
  }

  // Unknown category. Escalate without asking — an unrecognised reason is
  // not grounds for assuming the question was trivial.
  return {
    text: "Let me get one of our pharmacists to help you with that.",
    urgent: false,
    asksPermission: false,
  };
}

/**
 * Did the customer accept the offer of a pharmacist?
 *
 * `null` means neither — treat it as a new question rather than an answer.
 *
 * Deliberately conservative about "no": a clinical question left hanging
 * because someone typed something the matcher did not recognise is worse
 * than an unnecessary handoff, so only clear refusals count as declining.
 */
function readEscalationAnswer(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (!t || t.length > 60) return null;

  if (/^(no|nope|no o|nah|not now|no thanks?|no thank you|it'?s ok|its ok|don'?t worry|dont worry|later|no need)\b/.test(t)) {
    return false;
  }
  if (/^(y|ye|yes|yeah|yep|yup|ok|okay|sure|please|yes please|pls|abeg|go ahead|do it|connect me|i want|alright|correct)\b/.test(t)) {
    return true;
  }
  return null;
}

module.exports = { escalationMessage, readEscalationAnswer, URGENT };
