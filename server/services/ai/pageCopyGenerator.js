/**
 * Auto-draft the heading, introduction, or "about this service" paragraph
 * for one generated website page — the same idea as welcomeNoteGenerator.js,
 * for the "Write with AI" button on PageText.jsx.
 *
 * WHY THIS EXISTS RATHER THAN A GENERIC TEMPLATE. pages.js already writes a
 * heading and an intro for every page, and it is honest and safe, but it is
 * the same formula for every pharmacy on the platform — "X — Pharmacy in Y",
 * "What we can help with at our pharmacy in Y." An owner who wants their OWN
 * words was asked to write ad copy from a blank box, which is exactly the
 * task worth a "write this for me" button. So this is deliberately NOT
 * instructed to produce a safer version of the same template — it is told
 * what the generated version already sounds like and asked not to repeat it.
 *
 * NOT THE CUSTOMER-FACING ASSISTANT, for the same reason
 * welcomeNoteGenerator.js is not: nothing here talks to a customer in real
 * time, so the verification machinery built for live replies is not what
 * this needs. What it still needs, because a model has no knowledge of this
 * product's own rules: it must not invent a fact the pharmacy did not give
 * it, and — because this text can land on a SERVICE page — it must not
 * cross into medical advice, dosing or a promised outcome. Both are
 * instructed explicitly rather than assumed, and the result is still only a
 * DRAFT: the caller shows it to the owner and saves nothing on its own.
 */

const { chat, isConfigured, LlmUnavailable } = require('./llmClient');

/** Validated server-side by validatePageCopy too — kept here as the model's own ceiling. */
const FIELD_LIMITS = Object.freeze({ heading: 120, intro: 400, about: 600 });
/** Aimed well under the hard cap: nothing this short reads better for being longer. */
const FIELD_TARGETS = Object.freeze({ heading: 70, intro: 220, about: 380 });

function pageDescription(kind, label) {
  switch (kind) {
    case 'about': return 'the About page, which introduces the pharmacy to someone who has never visited';
    case 'services': return 'the Services page, an index listing everything the pharmacy offers';
    case 'service': return `the page for one specific service: "${label}"`;
    case 'location': return 'the Location page, which helps a customer find and travel to the pharmacy';
    case 'contact': return 'the Contact page, which tells a customer how to reach the pharmacy';
    case 'healthIndex': return 'the Health Information page, an index of health guides the pharmacy publishes';
    default: return 'a page on the pharmacy\'s website';
  }
}

function fieldInstruction(field, kind) {
  if (field === 'heading') {
    return `Write ONLY the HEADING at the top of this page — a TITLE, not a sentence and not a `
      + `paragraph. Strict limits: 4 to 9 words, ${FIELD_TARGETS.heading} characters or fewer, ONE `
      + 'title only. Do not follow it with any further sentence, clause, or explanation — the moment '
      + 'the title is written, stop. It must read like something a skilled copywriter chose, not a '
      + 'mechanical "[Topic] — Pharmacy in [City]" template, which is what the page shows today and is '
      + 'exactly what this should improve on. Example of the right SHAPE (do not reuse the wording): '
      + '"Your Health, Close to Home". It may name the pharmacy or its area only if that reads '
      + 'naturally as part of a short title, never as a keyword stapled onto the end.';
  }
  if (field === 'about' && kind === 'service') {
    return `Write a short paragraph, ${FIELD_TARGETS.about} characters or fewer (2 to 4 sentences), `
      + 'describing this ONE SERVICE for a customer deciding whether to come in for it — practically, '
      + 'what happens and who it is for. Do not give medical advice, a dosage, a diagnosis, or promise a '
      + 'specific health outcome. Describe the service itself, not what it treats or cures.';
  }
  return `Write the INTRODUCTION directly under the heading — the first sentence or two a visitor reads `
    + `on this page, ${FIELD_TARGETS.intro} characters or fewer. Warm, specific and useful; it may `
    + 'mention the pharmacy\'s area once if that reads naturally, but must never read like a list of '
    + 'keywords.';
}

function buildPrompt({ pharmacyName, area, description, services, kind, label, field }) {
  const facts = [
    `Pharmacy name: ${pharmacyName}`,
    area ? `Area: ${area}` : null,
    description ? `How the pharmacy describes itself: ${description}` : null,
    services?.length ? `Services offered: ${services.join(', ')}` : null,
    `This text is for: ${pageDescription(kind, label)}`,
  ].filter(Boolean).join('\n');

  return [
    {
      role: 'system',
      content:
        'You are an experienced copywriter and local-SEO specialist writing website copy for an '
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
        + 'where natural, not as an ad addressing "you". Output ONLY the requested text: no quotation '
        + 'marks, no field name, no markdown, no explanation, and nothing after the requested text ends.'
        + '\n\n'
        + fieldInstruction(field, kind),
    },
    { role: 'user', content: facts },
  ];
}

/**
 * @param {object} facts pharmacy/page facts — never invented, only passed through
 * @param {'heading'|'intro'|'about'} facts.field
 * @returns {Promise<string>}
 * @throws {LlmUnavailable} if there is no model to ask
 */
async function generatePageCopy(facts) {
  if (!isConfigured()) {
    throw new LlmUnavailable('No LLM is configured, so this cannot be drafted automatically.');
  }
  if (!facts?.pharmacyName) {
    throw new Error('pharmacyName is required to draft page copy.');
  }
  const field = FIELD_LIMITS[facts.field] ? facts.field : 'intro';

  const { content } = await chat({
    messages: buildPrompt({ ...facts, field }),
    // NOT a guess at output length — the configured model reasons before it
    // answers (see llmClient.js's chat() returning a separate
    // reasoning_content), and that reasoning is billed against maxTokens
    // like any other completion token. Measured directly against this exact
    // prompt: a 42-CHARACTER heading used 1419 reasoning tokens before
    // writing a single word of the answer, while a much longer "about this
    // service" paragraph used 780 — reasoning cost does not track output
    // length at all. At the welcome-note generator's 120, or this file's own
    // original 260, the model was cut off mid-thought on `finishReason:
    // "length"` and returned an EMPTY content string every time — no error,
    // no partial draft, just silently nothing, which is worse than failing
    // loudly. 2800 leaves real margin over the worst case observed.
    maxTokens: 2800,
    // Warmer than the customer-facing assistant's 0.2 — this is a draft of
    // marketing copy an owner will read and can reject, not a factual claim
    // sent to a customer.
    temperature: 0.65,
  });

  let text = content.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ');
  // Even with a generous ceiling, a reasoning model can in principle still
  // exhaust it before writing an answer. Surfaced as a real error rather than
  // handed back as a silently empty draft — an empty box that LOOKS like a
  // successful "Write with AI" is worse than one that plainly says it failed.
  if (!text) {
    throw new LlmUnavailable('The AI did not return any text this time. Try again, or write it yourself.');
  }
  const cap = FIELD_LIMITS[field];
  if (text.length > cap) text = `${text.slice(0, cap - 1).trimEnd()}…`;
  return text;
}

module.exports = { generatePageCopy, FIELD_LIMITS, FIELD_TARGETS };
