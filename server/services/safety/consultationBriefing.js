/**
 * What a pharmacist needs to know before opening a conversation.
 *
 * WHY THIS IS ASSEMBLED, NOT SUMMARISED BY A MODEL
 * The obvious build is "send the thread to the LLM and ask for a summary".
 * A pharmacist acts clinically on what they read here, and a paraphrase that
 * turns three months old into three years old is a summary that reads
 * perfectly and causes harm. Every other claim in this product is verified
 * against a tool result before it reaches anyone; a briefing for the person
 * making the medical decision cannot be the one place that rule is dropped.
 *
 * So this is built from data that is already true:
 *   - the escalation category, decided deterministically by the filter
 *   - the customer's OWN WORDS, quoted, never rephrased
 *   - products already discussed, from conversation context
 *   - how long they have been waiting
 *
 * In practice that is also more useful. Most of these threads are under ten
 * messages, where the customer's actual sentences ARE the summary and a
 * paraphrase only adds distance from what they said.
 *
 * Pure. Takes rows, returns a briefing.
 */

/** The escalation category, in words a pharmacist would use. */
const HEADLINE = {
  emergency: 'Possible emergency',
  overdose: 'Possible overdose',
  adverse_reaction: 'Reaction to medicine',
  paediatric: 'Medicine for a child',
  pregnancy: 'Pregnancy or breastfeeding',
  dosage: 'How much / how often to take',
  drug_interaction: 'Taking medicines together',
  symptoms: 'Symptoms — wants a recommendation',
  clinical_comparison: 'Which medicine is better',
  prescription: 'Prescription question',
  human_requested: 'Asked to speak to a person',
  prompt_injection: 'Unusual message — flagged automatically',
  unreadable: 'Could not read the message',
  assistant_unavailable: 'Assistant was unavailable',
  assistant_error: 'Assistant failed',
  filter_error: 'Safety check failed',
  unverified_reply: 'Assistant draft could not be verified',
  max_iterations: 'Assistant could not settle on an answer',
};

/** Categories a pharmacist should look at before anything else. */
const URGENT = new Set(['emergency', 'overdose', 'adverse_reaction']);

/**
 * Categories that are OUR failure, not a clinical question. Worth separating:
 * a pharmacist skimming a queue should not spend attention on these thinking
 * someone needs medical help.
 */
const TECHNICAL = new Set([
  'assistant_unavailable', 'assistant_error', 'filter_error',
  'unverified_reply', 'max_iterations', 'unreadable', 'prompt_injection',
]);

function minutesSince(when) {
  if (!when) return null;
  return Math.max(0, Math.round((Date.now() - new Date(when).getTime()) / 60000));
}

/** "just now", "12m", "3h 20m" — a pharmacist reads elapsed time, not a clock. */
function waitingFor(minutes) {
  if (minutes === null) return null;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * @param {object} args
 * @param {string} args.category
 * @param {Date}   args.requestedAt
 * @param {object[]} args.messages   oldest first: {direction, body, created_at}
 * @param {object} [args.context]    conversations.context
 * @returns {object} briefing
 */
function buildBriefing({ category, requestedAt, messages = [], context = {} }) {
  const inbound = messages.filter((m) => m.direction === 'inbound' && m.body);

  // Split on the moment of escalation.
  //
  // Taking the last inbound message overall looked right and was wrong: a
  // customer who keeps typing after being handed over replaces their own
  // reason for being here. A real queue showed "Hello" as the trigger for a
  // conversation escalated for "I'm having severe headache" — the pharmacist
  // would have opened it with no idea why it was there.
  const cutoff = requestedAt ? new Date(requestedAt).getTime() : Infinity;
  const before = inbound.filter((m) => new Date(m.created_at).getTime() <= cutoff);
  const after = inbound.filter((m) => new Date(m.created_at).getTime() > cutoff);

  // The customer's own words, most recent last. Capped at four: enough for
  // the shape of the question, short enough that a pharmacist reads all of it
  // rather than skimming — which is the entire point.
  const said = before.slice(-4).map((m) => String(m.body).slice(0, 300));

  // What actually tripped the filter: the last thing they said before we
  // stepped back.
  const trigger = before.length ? String(before[before.length - 1].body).slice(0, 300) : null;

  // Anything said SINCE. The assistant is muted, so these have had no reply
  // at all, and they are often the most current thing the customer wants —
  // in testing, someone escalated for a headache then asked about vitamin C
  // and got silence. A pharmacist opening this needs to see both.
  const since = after.slice(-4).map((m) => String(m.body).slice(0, 300));

  const minutes = minutesSince(requestedAt);

  return {
    headline: HEADLINE[category] || 'Needs a person',
    category: category || null,
    urgent: URGENT.has(category),
    technical: TECHNICAL.has(category),
    waiting: waitingFor(minutes),
    waitingMinutes: minutes,
    // Verbatim. Never a paraphrase — see the note at the top of this file.
    trigger,
    said,
    // Unanswered by anyone. The assistant is muted and no human has replied
    // yet, so every one of these is a message sitting in silence.
    since,
    unansweredSince: since.length,
    messageCount: messages.length,
    // Context the pharmacist would otherwise have to scroll for.
    discussed: context?.last_product_name || null,
    pendingSuggestion: context?.pending_suggestion?.product_name || null,
    // True when the customer was offered a pharmacist and has not answered.
    // Distinguishes "wants you" from "we asked and they went quiet", which
    // are different amounts of urgency for the same open row.
    awaitingCustomerAnswer: Boolean(context?.pending_escalation),
  };
}

module.exports = { buildBriefing, HEADLINE, URGENT, TECHNICAL };
