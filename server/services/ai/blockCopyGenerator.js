/**
 * Auto-draft the text for one editable field on one homepage section (block).
 *
 * SAME IDEA AS pageCopyGenerator.js, ONE LEVEL LOWER. That file drafts the
 * heading/intro/about text for a whole PAGE, derived from pages.js. This one
 * drafts a single PROP on a single BLOCK in the pharmacy's own site_data —
 * the hero's heading, the WhatsApp band's description, a button's label —
 * the free editorial text that templates.js seeds explicitly and that, until
 * now, only the drag-and-drop advanced editor could change.
 *
 * NOT A SECOND CONTRACT. The block registry (blocks/registry.js) is still the
 * only place that knows what fields a block has and how long each may be —
 * this file is handed a field NAME, its MAX LENGTH and the block's own LABEL
 * and DESCRIPTION (all read from that registry by the route, never guessed
 * here), and writes to the shape the registry already enforces. Nothing here
 * invents a new prop or a new block.
 *
 * VOICE VARIES BY WHAT THE FIELD ACTUALLY IS, not by which block it lives on
 * — a heading reads the same whether it belongs to the hero or to Services,
 * and a button's own label is always short, tappable text rather than a
 * sentence. Classifying by field NAME (heading/subheading/description/label-
 * shaped/message/note) instead of by block type is what lets a block added
 * next year work here with no new branch — see fieldKind().
 *
 * THE ONE FIELD THAT IS NOT MARKETING COPY: `message` is the text pre-filled
 * into a customer's own WhatsApp message when they tap a button — it has to
 * read as something a CUSTOMER would type to the pharmacy, first person, not
 * as copy written to the customer. Getting this backwards would put ad copy
 * in someone's own WhatsApp app, sent in their own name.
 *
 * SAME ANTI-FABRICATION REASONING, AND THE SAME "NOT THE CUSTOMER-FACING
 * ASSISTANT" REASONING AS pageCopyGenerator.js — see that file's header for
 * why this needs neither the reply-validator nor a fact it was not given.
 */

const { chat, isConfigured, LlmUnavailable } = require('./llmClient');

/** What voice and shape a field needs, independent of which block it lives on. */
function fieldKind(field) {
  if (field === 'heading') return 'heading';
  if (field === 'subheading') return 'subheading';
  if (field === 'description') return 'description';
  if (field === 'message') return 'message';
  if (field === 'note') return 'note';
  // label, buttonLabel, primaryCtaLabel, secondaryCtaLabel, directionsLabel —
  // every one of them is a button's own short text.
  return 'label';
}

function fieldInstruction(kind, max, blockLabel, blockDescription) {
  const about = `This is for the "${blockLabel}" section of the pharmacy's homepage (${blockDescription}).`;
  switch (kind) {
    case 'heading':
      return `${about} Write ONLY the section's HEADING — a short title, not a sentence and not a `
        + `paragraph. 3 to 8 words, ${max} characters or fewer. Do not follow it with any further `
        + 'clause or explanation — the moment the title is written, stop. It must read like something a '
        + 'skilled copywriter chose for this exact section, not a generic label.';
    case 'subheading':
      return `${about} Write the supporting line that sits directly under the heading — one sentence, `
        + `${max} characters or fewer, warm and specific rather than a slogan.`;
    case 'description':
      return `${about} Write one short paragraph (1 to 3 sentences), ${max} characters or fewer, that `
        + 'does the job this section exists to do.';
    case 'message':
      return 'This is the message PRE-FILLED into a CUSTOMER\'s own WhatsApp when they tap this button — '
        + 'write it in the CUSTOMER\'S voice, first person, as if they are the one sending it to the '
        + `pharmacy (for example: "Hello, I would like to ask about a medicine."), ${max} characters or `
        + 'fewer. This is not marketing copy and must never address the customer.';
    case 'note':
      return `${about} Write one short supporting note, ${max} characters or fewer.`;
    default: // label
      return `${about} Write ONLY the button's own text — 2 to 6 words, no ending punctuation, ${max} `
        + 'characters or fewer. It must read as something to tap, not a sentence.';
  }
}

function buildPrompt({ pharmacyName, area, description, services, blockLabel, blockDescription, field, max }) {
  const kind = fieldKind(field);
  const facts = [
    `Pharmacy name: ${pharmacyName}`,
    area ? `Area: ${area}` : null,
    description ? `How the pharmacy describes itself: ${description}` : null,
    services?.length ? `Services offered: ${services.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  return [
    {
      role: 'system',
      content:
        'You are an experienced copywriter and local-SEO specialist writing homepage copy for an '
        + 'independent Nigerian community pharmacy. Write in plain, warm, human English — never generic '
        + 'marketing filler, never a stock template.\n\n'
        + 'THE SINGLE MOST IMPORTANT RULE: use ONLY the facts listed below. Do not add a single detail '
        + 'that is not in that list — no hours, no "no appointment needed", no "walk-ins welcome", no '
        + 'delivery, no award, no certification, no statistic, no year founded, no staff count, no '
        + 'specific promise. If a detail would make the copy better but is not in the facts, LEAVE IT '
        + 'OUT rather than guess a plausible-sounding one — a guess about a real healthcare business is '
        + 'a false claim, not a stylistic choice. It is entirely fine, and expected, for the result to be '
        + 'short and simple when few facts are given.\n\n'
        + 'Never mention that this text was written by AI. Write as the pharmacy, in first person plural '
        + 'where natural, not as an ad addressing "you" — except where the field instruction below says '
        + 'otherwise. Output ONLY the requested text: no quotation marks, no field name, no markdown, no '
        + 'explanation, and nothing after the requested text ends.'
        + '\n\n'
        + fieldInstruction(kind, max, blockLabel, blockDescription),
    },
    { role: 'user', content: facts || `Pharmacy name: ${pharmacyName}` },
  ];
}

/**
 * @param {object} facts pharmacy/block facts — never invented, only passed through
 * @param {string} facts.field the block's own prop name (heading, subheading, ...)
 * @param {number} facts.max the field's own character limit, from the block registry
 * @param {string} facts.blockLabel the block's editor label (e.g. "Hero")
 * @param {string} facts.blockDescription the block's own registry description
 * @returns {Promise<string>}
 * @throws {LlmUnavailable} if there is no model to ask
 */
async function generateBlockCopy(facts) {
  if (!isConfigured()) {
    throw new LlmUnavailable('No LLM is configured, so this cannot be drafted automatically.');
  }
  if (!facts?.pharmacyName) {
    throw new Error('pharmacyName is required to draft homepage copy.');
  }
  const max = Number.isInteger(facts.max) && facts.max > 0 ? facts.max : 200;

  const { content } = await chat({
    messages: buildPrompt({ ...facts, max }),
    // Same reasoning-token budget fix as pageCopyGenerator.js and
    // welcomeNoteGenerator.js — a small ceiling here silently returns an
    // empty string on this exact model. See pageCopyGenerator.js for the
    // direct measurement.
    maxTokens: 2800,
    // Warmer than the customer-facing assistant's 0.2 — this is a draft of
    // marketing copy an owner will read and can reject, not a factual claim
    // sent to a customer.
    temperature: 0.65,
  });

  let text = content.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ');
  // Even with a generous ceiling, a reasoning model can in principle still
  // exhaust it before writing an answer. Surfaced as a real error rather than
  // handed back as a silently empty draft.
  if (!text) {
    throw new LlmUnavailable('The AI did not return any text this time. Try again, or write it yourself.');
  }
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

module.exports = { generateBlockCopy, fieldKind };
