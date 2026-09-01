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

/**
 * The one-line answer to "what am I looking at and why is it mine?"
 *
 * WHY THIS EXISTS
 * The headline alone is a label, and for the technical categories it is a
 * label written from the SYSTEM's point of view. A pharmacist opening a queue
 * and reading "Assistant could not settle on an answer" learns nothing they
 * can act on: not whether it is medical, not what the patient wanted, not
 * what they should do about it. Reported from the real queue as "confusing as
 * hell", which is fair.
 *
 * WHY IT IS A LOOKUP AND NOT A MODEL
 * The obvious build is to send the thread to the LLM for a summary, and it is
 * the wrong one HERE for the reason at the top of this file: a pharmacist
 * acts clinically on what they read, and a paraphrase that turns "three
 * months" into "three years" reads perfectly and causes harm. Every other
 * claim in this product is verified against a tool result before anyone sees
 * it; the briefing for the person making the medical decision cannot be the
 * one place that rule is dropped.
 *
 * The failure being fixed was never a missing summary anyway — it was an
 * empty window (routes/conversations.js) leaving the pharmacist with no
 * patient words at all. A model asked to summarise nothing would have written
 * something confident and wrong, which is strictly worse than a blank.
 *
 * So: a fixed sentence per category, plus the patient's own words underneath.
 * Deterministic, auditable, and it says the thing the category actually means.
 */
const SITUATION = {
  emergency:
    'The patient may be describing an emergency. Read their words first and respond immediately.',
  overdose:
    'The patient may have taken too much of a medicine. This needs you before anything else in the queue.',
  adverse_reaction:
    'The patient is describing a reaction to a medicine they have taken.',
  paediatric:
    'The patient is asking about medicine for a child. The assistant is not permitted to answer this.',
  pregnancy:
    'The patient is asking about medicine during pregnancy or breastfeeding. The assistant is not permitted to answer this.',
  dosage:
    'The patient is asking how much or how often to take something. The assistant is not permitted to answer this.',
  drug_interaction:
    'The patient is asking whether medicines can be taken together. The assistant is not permitted to answer this.',
  symptoms:
    'The patient described symptoms and wants a recommendation. Choosing a medicine for symptoms is your call, not the assistant’s.',
  clinical_comparison:
    'The patient is asking which of two medicines is better for them. That is a clinical judgement, so it came to you.',
  prescription:
    'The patient is asking about a prescription.',
  human_requested:
    'The patient asked to speak to a person. Nothing has gone wrong — they simply want you.',

  // The technical ones. Saying plainly that these are NOT medical is the
  // whole point: a pharmacist should not spend triage attention wondering
  // whether someone is unwell when the assistant merely fell over.
  max_iterations:
    'NOT a medical question. The assistant got stuck trying to complete what the patient asked and gave up. Read their messages below and answer them directly.',
  unverified_reply:
    'NOT a medical question. The assistant drafted a reply it could not verify against the catalogue, so it stopped rather than risk quoting a wrong price.',
  assistant_unavailable:
    'NOT a medical question. The assistant could not be reached, so this fell to you. The patient may not know anything went wrong.',
  assistant_error:
    'NOT a medical question. The assistant failed mid-turn. The patient is waiting on an answer it never sent.',
  filter_error:
    'The safety check itself failed, so this was escalated rather than answered. Treat the patient’s words below as unscreened.',
  unreadable:
    'The message could not be read — it may be an image, a voice note, or a prescription photo. Open the conversation to see it.',
  prompt_injection:
    'The message looked like an attempt to manipulate the assistant, so it was not answered. Usually harmless curiosity; judge it yourself.',
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

  // THE EXCHANGE, BOTH DIRECTIONS.
  //
  // `said` and `since` are inbound only, and on a technical escalation that
  // hides the half that explains everything. The real queue showed a patient
  // asking to change an order to 135 cards and the assistant replying "Sorry,
  // I got a bit tangled there" twice — and the pharmacist saw only the
  // patient's three attempts, which read as someone repeating themselves for
  // no reason. Seeing the assistant's replies is what turns four confusing
  // fragments into an obvious story.
  //
  // ANCHORED ON THE HANDOFF, for the same reason the route's query is.
  // A plain slice(-6) of everything shows the six NEWEST messages, so on a
  // case that has waited two days the pharmacist gets recent chatter and none
  // of the exchange that caused the escalation — the failure this whole
  // change exists to fix, reintroduced one layer up.
  const withBody = messages.filter((m) => m.body);
  const shape = (m) => ({
    from: m.direction === 'inbound' ? 'patient' : 'assistant',
    body: String(m.body).slice(0, 300),
    at: m.created_at,
  });
  const exchange = [
    // Weighted towards BEFORE: that is the part that explains why this is in
    // the queue, and it is the part that goes missing.
    ...withBody.filter((m) => new Date(m.created_at).getTime() <= cutoff).slice(-5).map(shape),
    ...withBody.filter((m) => new Date(m.created_at).getTime() > cutoff).slice(-3).map(shape),
  ];

  // The last thing the assistant actually said to them. On a technical
  // escalation this is usually an apology the patient is still holding, and a
  // pharmacist who opens with "how can I help" without knowing that reads as
  // a second system that has not been listening either.
  const lastAssistant = [...messages].reverse().find((m) => m.direction === 'outbound' && m.body);

  const minutes = minutesSince(requestedAt);

  return {
    headline: HEADLINE[category] || 'Needs a person',
    // One sentence: what this is, and what the pharmacist is being asked to
    // do about it. Deterministic — see the note above SITUATION.
    situation: SITUATION[category]
      || 'The assistant stepped back and asked for a person. Read the patient’s words below.',
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
    // The back-and-forth, so the patient's messages have the assistant's
    // replies around them instead of standing alone.
    exchange,
    lastAssistantReply: lastAssistant ? String(lastAssistant.body).slice(0, 300) : null,
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

module.exports = { buildBriefing, HEADLINE, SITUATION, URGENT, TECHNICAL };
