/**
 * When a failure is worth a pharmacist, and when it is just a bad turn.
 *
 * WHAT WAS WRONG
 * Every category that stopped the assistant raised a handoff. Nine of them
 * are clinical and should. The rest are the assistant's OWN failures — a
 * reply that failed validation, a tool loop that ran too long, a message it
 * could not read — and those were paging a pharmacist too.
 *
 * From a real conversation: a customer typed their name, the assistant
 * escalated with "Let me get one of our team to pick this up with you here",
 * the customer asked "Why ?", was never answered, and the assistant carried
 * on two minutes later asking for the name again. Nothing clinical happened.
 * A pharmacist was summoned because a model had a bad turn.
 *
 * That is expensive in the way that matters: staff stop trusting the alerts.
 * A handoff queue full of "the AI got confused" is one nobody reads, and the
 * emergency sitting in it goes unread with the rest.
 *
 * THE RULE
 * Clinical always escalates, immediately, every time. That boundary does not
 * move and nothing here weakens it.
 *
 * Everything else gets to recover: the assistant says something honest, the
 * customer tries again, and life goes on. Only if the same conversation keeps
 * failing does a person get involved — because at that point it genuinely is
 * stuck, which is a different fact from one bad turn.
 *
 * PURE. Counters are passed in.
 */

/**
 * Clinical. Non-negotiable, and deliberately listed rather than derived —
 * a category added to the filter later must be classified deliberately, and
 * defaulting to "recover" for something unrecognised would be exactly the
 * wrong direction. See classify(): unknown categories escalate.
 */
const CLINICAL = new Set([
  'emergency',
  'overdose',
  'adverse_reaction',
  'paediatric',
  'pregnancy',
  'dosage',
  'drug_interaction',
  'symptoms',
  'prescription',
  'clinical_comparison',
]);

/**
 * The customer asked for a person. Not a failure at all — honouring it is the
 * feature, and it must never be "recovered" into the assistant refusing to
 * fetch anyone.
 */
const CUSTOMER_ASKED = new Set(['human_requested']);

/**
 * The assistant's own failures. Recoverable — none of these say anything
 * about the customer's health, only about a turn that went wrong.
 */
const RECOVERABLE = new Set([
  'unverified_reply',    // the draft failed validation
  'max_iterations',      // the tool loop ran too long
  'unreadable',          // could not read what arrived
  'prompt_injection',    // someone tried to steer the assistant
  'filter_error',        // the safety filter itself errored
  'assistant_error',
  'assistant_unavailable',
]);

/**
 * How many times one conversation may fail to produce a reply before a person
 * is brought in.
 *
 * Two, not one: a single bad turn is noise and the next message usually goes
 * through. Not five either — a customer who has been told "say that again"
 * three times has been failed, and quietly retrying at them is worse than
 * admitting it.
 */
const MAX_RECOVERIES = 2;

/**
 * prompt_injection never escalates, at any count.
 *
 * Escalating on it hands anyone who can message the pharmacy a button that
 * summons staff — send the same crafted text repeatedly and the handoff queue
 * fills up on demand. The correct response is to decline and continue, which
 * costs the attacker everything and the pharmacy nothing.
 */
const NEVER_ESCALATES = new Set(['prompt_injection']);

/**
 * @param {object} args
 * @param {string} args.category            what the filter or the loop reported
 * @param {number} [args.recoveriesSoFar]   consecutive failed turns in this conversation
 * @returns {{action: 'escalate'|'recover', reason: string}}
 */
function classify({ category, recoveriesSoFar = 0 }) {
  if (CLINICAL.has(category)) {
    return { action: 'escalate', reason: 'clinical' };
  }
  if (CUSTOMER_ASKED.has(category)) {
    return { action: 'escalate', reason: 'customer_asked_for_a_person' };
  }

  if (RECOVERABLE.has(category)) {
    if (NEVER_ESCALATES.has(category)) {
      return { action: 'recover', reason: 'declined_without_escalating' };
    }
    if (recoveriesSoFar >= MAX_RECOVERIES) {
      // Genuinely stuck now, which is a different fact from one bad turn.
      return { action: 'escalate', reason: 'repeatedly_stuck' };
    }
    return { action: 'recover', reason: 'assistant_failure' };
  }

  // Unrecognised. Escalating is the safe direction for something nobody has
  // classified: a new clinical category treated as recoverable would mean an
  // assistant quietly handling exactly what it must not.
  return { action: 'escalate', reason: 'unclassified_category' };
}

/**
 * What to say when recovering, in the customer's terms.
 *
 * Never "an error occurred". A customer does not care which component failed
 * and cannot act on it; what they need is to know it was not them and what to
 * do next. Each of these ends with something the customer can actually do.
 */
function recoveryMessage(category) {
  switch (category) {
    case 'unreadable':
      return 'Sorry — I could not read that one. Could you type it as a message?';
    case 'prompt_injection':
      // Declines without accusing. Someone testing the assistant gets a flat
      // boundary; a customer who phrased something oddly is not called a
      // hacker for it.
      return 'I can only help with this pharmacy — medicines, prices, stock and orders. What can I get for you?';
    case 'max_iterations':
      return 'Sorry, I got a bit tangled there. Could you say that again, in a few words?';
    default:
      return 'Sorry — I did not get that quite right. Could you say it once more?';
  }
}

module.exports = {
  classify, recoveryMessage,
  CLINICAL, RECOVERABLE, CUSTOMER_ASKED, MAX_RECOVERIES,
};
