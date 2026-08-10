/**
 * Auto-generate a welcome note for the settings screen.
 *
 * WHAT THIS IS FOR
 * The one line of free text that appears between the greeting and the menu
 * (menu.js's `welcomeNote`) — e.g. "We deliver across Ikeja" or "Open every
 * day including public holidays". A short, low-stakes line most owners will
 * struggle to word from a blank box, which is exactly the kind of task worth
 * a "write this for me" button.
 *
 * WHY THIS IS NOT THE customer-facing assistant
 * catalogueTools/replyValidator exist because a customer message must never
 * become a false claim about price, stock or an action taken. Nothing here
 * talks to a customer. The output is a DRAFT an owner reads, edits, and
 * explicitly saves — so the heavy verification machinery built for live
 * replies would be solving a problem this endpoint does not have. What it
 * still needs, because the input is free text an owner typed: the result
 * must not silently exceed the column's own limit, and must not smuggle
 * instructions THROUGH the note back into a future customer conversation.
 */

const { chat, isConfigured, LlmUnavailable } = require('./llmClient');

const MAX_WELCOME_NOTE = 300;

function buildPrompt({ pharmacyName, botName, city, delivers, extraInfo }) {
  const facts = [
    `Pharmacy name: ${pharmacyName}`,
    botName ? `Assistant name: ${botName}` : null,
    city ? `Location: ${city}` : null,
    delivers === true ? 'Offers delivery' : delivers === false ? 'Pickup only, no delivery' : null,
    extraInfo ? `Other details the owner gave: ${extraInfo}` : null,
  ].filter(Boolean).join('\n');

  return [
    {
      role: 'system',
      content:
        'Write ONE short, warm sentence a Nigerian pharmacy can show customers right after "Hi, I\'m {bot} from {pharmacy}." '
        + 'It should say something true and useful from the facts given — like what the pharmacy is known for, its area, or that it delivers. '
        + 'Do not invent facts that were not given. Do not use emoji. Do not mention AI, WhatsApp, or that this was generated. '
        + 'Output ONLY the sentence — no quotation marks, no preamble, no explanation.',
    },
    { role: 'user', content: facts || `Pharmacy name: ${pharmacyName}` },
  ];
}

/**
 * @param {object} facts  whatever the owner has already told us — never
 *   invented, only what is passed in
 * @returns {Promise<string>}
 * @throws {LlmUnavailable} if there is no model to ask — the caller decides
 *   whether that is a 503 or a fallback, this module does not guess
 */
async function generateWelcomeNote(facts) {
  if (!isConfigured()) {
    throw new LlmUnavailable('No LLM is configured, so a note cannot be drafted automatically.');
  }
  if (!facts?.pharmacyName) {
    throw new Error('pharmacyName is required to draft a welcome note.');
  }

  const { content } = await chat({
    messages: buildPrompt(facts),
    maxTokens: 120,
    // Slightly warmer than the customer-facing assistant's 0.2 — this is
    // one line of marketing copy an owner will read and can reject, not a
    // factual claim to a customer.
    temperature: 0.6,
  });

  // A model has no knowledge of this column's limit and no reason to respect
  // it. Enforced here rather than trusted, same as any other input this size.
  let note = content.trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (note.length > MAX_WELCOME_NOTE) note = note.slice(0, MAX_WELCOME_NOTE - 1).trimEnd() + '…';

  return note;
}

module.exports = { generateWelcomeNote, MAX_WELCOME_NOTE };
