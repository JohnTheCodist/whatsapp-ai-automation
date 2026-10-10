/**
 * What the AI scribe may produce, and what it may never produce.
 *
 * SCRIBE_PLAN.md. The scribe listens to a consultation and drafts the
 * Subjective section so a pharmacist talks to the patient instead of typing
 * about them.
 *
 * PURE, and separate from the model call on purpose. Everything that decides
 * what is SAFE lives here, where it can be tested without a network, a key or
 * a recording — the same split `communicationPolicy` uses, and for the same
 * reason: the rules that keep a feature safe should not need the feature's
 * infrastructure to verify.
 *
 * THE ONE RISK THIS FILE EXISTS FOR. A language model asked to "write the
 * history" writes a PLAUSIBLE history — fluent, clinical, and containing
 * details nobody said. In a WhatsApp reply that is embarrassing. In a clinical
 * record it is a symptom the patient never reported, read months later by
 * somebody who was not in the room and has no way to know.
 */

/**
 * The ONLY section a scribe may ever draft.
 *
 * Subjective is what the patient reported — pure reportage, and the bulk of
 * the typing. Every other section is a judgement or a measurement:
 *
 *   assessment      the pharmacist's own impression (§13)
 *   objective       what was observed or measured
 *   plan            a decision
 *   problems        a decision, with a certainty attached
 *   interventions   a record of what a person did
 *   referral        a decision that sends somebody somewhere
 *
 * A model drafting any of those is a model making a clinical decision, which
 * is the line §38 draws.
 */
const SCRIBABLE = Object.freeze(['subjective']);

/** Sections a scribe must never be offered for, named so a test can say why. */
const NEVER_SCRIBABLE = Object.freeze([
  'assessment', 'objective', 'plan', 'problems', 'interventions',
  'referral', 'prescription', 'care-program', 'summary',
]);

/**
 * The instruction. Extractive, and explicit that saying less is correct.
 *
 * It is given ONLY the patient's turns. Deepgram separates the speakers and
 * the pharmacist says which voice is the patient, so the question a model must
 * not answer — "who said this?" — is answered by a person, in one tap, before
 * the model sees anything.
 *
 * Three failures it is written against:
 *
 *   1. A fluent paragraph containing a symptom nobody mentioned.
 *   2. Recording the pharmacist's own advice as something the patient said.
 *   3. Inventing a history for a recording that caught nothing.
 */
const SYSTEM_PROMPT = [
  'You are a scribe for a Nigerian community pharmacist. You are given the',
  "PATIENT'S OWN WORDS from a consultation and you write the SUBJECTIVE",
  'section of the note: what the patient reported about their symptoms and',
  'history.',
  '',
  'RULES, in order of importance:',
  '',
  '1. Use ONLY information stated in the text you are given. Never add a',
  '   symptom, a duration, a medicine, a measurement or a detail that was not',
  '   said. If the text is thin, your answer is thin. That is correct.',
  '',
  "2. Everything you are given was said BY THE PATIENT. The pharmacist's own",
  '   words have already been removed. So do not write down questions, and do',
  '   not record advice or explanations as though the patient said them.',
  '',
  '3. If nothing usable was said, return an empty string. Do not write "the',
  '   patient reports no complaints" or any other sentence about a patient you',
  '   did not hear.',
  '',
  '4. Record only what the patient REPORTED. Do not write an assessment, a',
  '   diagnosis, a plan, a recommendation, an observation or a measurement,',
  "   even if one was discussed. Those are the pharmacist's to record.",
  '',
  '5. Do not state an absence the patient did not state. If they did not',
  '   mention fever, do not write that they deny fever.',
  '',
  '6. Plain clinical English, in the past tense, no preamble and no heading.',
  '   Do not address the reader. Do not apologise. Return the section text and',
  '   nothing else.',
].join('\n');

/** A transcript too thin to draft from. Below this, do not call the model. */
const MIN_TRANSCRIPT_CHARS = 20;

/**
 * Phrases that mean the model answered about the REQUEST instead of the
 * patient. They are not clinical content and must never reach the box.
 */
const META_ANSWER = /^(i'm sorry|i am sorry|sorry,|as an ai|i cannot|i can't|unfortunately|it (?:seems|appears) (?:that )?(?:the )?transcript|the transcript (?:is|does not|doesn't)|there is (?:no|not enough)|no (?:usable )?information)/i;

/**
 * Claims of absence, and the one thing that distinguishes a FABRICATED one
 * from a REPORTED one.
 *
 * AMENDED 2026-10-10, after driving the real model on a realistic Nigerian
 * pharmacy consultation. The rule was right and its CALIBRATION was wrong,
 * and the measurement is worth recording because the first version looked
 * fine against every test:
 *
 *   patient said   "No fever."  "No I do not smoke at all."
 *   model wrote    "No fever. Did not smoke."
 *   old rule       REFUSED — as an invented negative
 *
 * That is a faithful quotation being thrown away. And it is not an edge
 * case: a pharmacist asks "any fever?" and the patient answers, so the old
 * rule would have refused nearly every honest draft while looking safe. A
 * safety check that fires on the normal case is a feature nobody uses.
 *
 * WHY IT IS NOW SAFE TO BE PRECISE. The old regex was written when the model
 * saw the WHOLE conversation and could invent an absence from nothing. It
 * now sees only the PATIENT’S OWN WORDS — Deepgram separates the voices and
 * the pharmacist names the patient’s. So a negative that also appears in
 * those words is QUOTED, not invented, and the question stops being "does
 * this sentence look like a negative finding" and becomes the answerable
 * one: "did the patient say it?"
 *
 * This is STRICTER than the old rule where it matters. "No known allergies"
 * from a patient who never mentioned allergies is still refused — and now it
 * is refused because the words are not there, rather than because the
 * phrase matched a list.
 */

/**
 * Claims that NO transcript can support, so they are refused outright.
 *
 * Each one is a statement about everything that was NOT discussed:
 * "no other symptoms" asserts the absence of things nobody named, and
 * "unremarkable" asserts a review of systems that did not happen. There is
 * no patient sentence that could license them, so there is nothing to check
 * them against.
 */
const BLANKET_CLAIM = new RegExp([
  // claims about everything not mentioned
  "\\bno (?:other|further|additional) ",
  "(?:complaints?|symptoms?|concerns?|issues?|problems?|findings?)",
  // a review of systems nobody performed
  "|\\bunremarkable\\b|\\botherwise well\\b|\\botherwise healthy\\b",
  "|\\bno acute\\b|\\bwithin normal limits\\b|\\bNAD\\b",
  "|\\bsystems? (?:are |is )?(?:otherwise )?normal\\b",
  "|\\bno abnormalit\\w*",
].join(''), 'i');

/**
 * A negation, in the forms a patient and a model both use.
 *
 * `nil` and `denies` are here as NEGATIONS rather than as forbidden words.
 * A patient does not say "denies fever", but writing it when they said "no
 * fever" is a faithful report in clinical idiom, and refusing the idiom
 * while accepting the plain form would be a rule about vocabulary rather
 * than about truth.
 */
const NEGATION = /\b(?:no|not|none|never|nil|without|denies|denied|negative|hasn|haven|didn|doesn|don|isn|aren|cannot)\b|n['\u2019]t\b/i;

/** Words that carry no clinical subject, so matching one proves nothing. */
const STOP = new Set([
  'the', 'and', 'but', 'for', 'with', 'that', 'this', 'there', 'they', 'them',
  'has', 'have', 'had', 'was', 'were', 'been', 'being', 'are', 'any', 'also',
  'patient', 'reports', 'report', 'reported', 'states', 'stated', 'says',
  'said', 'denies', 'denied', 'other', 'otherwise', 'further', 'known',
  'significant', 'previous', 'current', 'currently', 'since', 'about',
  'during', 'when', 'while', 'from', 'does', 'did', 'not', 'nil', 'none',
  'never', 'without', 'normal', 'abnormality', 'abnormalities', 'his', 'her',
  'their', 'she', 'does', 'left', 'right', 'side', 'time', 'times', 'day',
  'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
]);

/** Crudely singularise, so "symptoms" and "symptom" match. */
const stem = (w) => w.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '');

/** The clinical subjects a sentence is talking about. */
function subjects(sentence) {
  return [...new Set(
    String(sentence || '').toLowerCase().match(/[a-z][a-z'\u2019-]{2,}/g) || [],
  )]
    .filter((w) => !STOP.has(w))
    .map(stem)
    .filter((w) => w.length >= 3);
}

/**
 * Did the patient's own words license this negative sentence?
 *
 * Both halves are required, and the second is the one doing the work: the
 * source must itself be negating, AND must be talking about the same thing.
 * A patient who said "my chest is tight" has mentioned the chest without
 * denying anything about it, so "no chest pain" is still refused.
 */
function negativeSupported(sentence, source) {
  const text = String(source || '');
  if (!text) return false;

  const claimed = subjects(sentence);
  // A negative sentence with no clinical subject at all cannot be checked,
  // so it is not supported. That is the conservative direction.
  if (claimed.length === 0) return false;

  // PER SENTENCE, and this is the whole correctness of the check.
  //
  // The first version asked only whether the source negated ANYTHING and
  // mentioned the subject ANYWHERE. Its own test caught it: given "My chest
  // feels tight... I have no fever", the unrelated "no fever" licensed a
  // drafted "No chest pain" — because the chest was mentioned and something
  // was denied. Those are two different sentences and two different facts.
  //
  // So the denial and the subject have to arrive together: the patient must
  // have said "no X" about this X, not "no Y" while mentioning X.
  return sentences(text).some((said) => {
    if (!NEGATION.test(said)) return false;
    const denied = new Set(subjects(said));
    return claimed.some((w) => denied.has(w));
  });
}

/** Sentences, split so each claim is judged on its own. */
function sentences(text) {
  return String(text || '')
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Find a claim of absence this draft is not entitled to make.
 *
 * Returns the offending sentence, or null. With NO source it refuses every
 * negative, which keeps the old behaviour for any caller that cannot say
 * what the patient said — "we could not tell" is never "it is fine".
 */
function unsupportedNegative(draft, source = null) {
  for (const sentence of sentences(draft)) {
    if (BLANKET_CLAIM.test(sentence)) return sentence;
    if (!NEGATION.test(sentence)) continue;
    if (!negativeSupported(sentence, source)) return sentence;
  }
  return null;
}

/**
 * Decide whether a transcript is worth sending to the model at all.
 *
 * Fails CLOSED and costs nothing: a recording that caught nothing should not
 * become an API call, and above all should not become a paragraph.
 */
function readTranscript(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) {
    return { usable: false, text, reason: 'too_short' };
  }
  return { usable: true, text, reason: null };
}

/**
 * Accept or refuse what the model produced.
 *
 * The model is not trusted to have followed its instructions — it is checked.
 * A refusal here is not a failure of the feature: it means the pharmacist
 * types, which is what they would have done anyway.
 */
function readDraft(raw, { source = null } = {}) {
  const text = String(raw == null ? '' : raw).trim()
    // Models like to wrap prose in quotes or a code fence.
    .replace(/^```[a-z]*\s*/i, '').replace(/```$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (!text) return { ok: true, draft: '', refused: null };

  // It answered about the request rather than about the patient.
  if (META_ANSWER.test(text)) return { ok: false, draft: '', refused: 'meta' };

  // It asserted an absence the patient did not.
  const invented = unsupportedNegative(text, source);
  if (invented) return { ok: false, draft: '', refused: 'invented_negative', sentence: invented };

  return { ok: true, draft: text, refused: null };
}

/**
 * The draft must not be longer than what was said.
 *
 * A summary of a conversation is shorter than the conversation. A "summary"
 * that is LONGER has had material added to it, and the only place that
 * material can have come from is the model.
 */
function withinTranscript(draft, transcript) {
  const d = String(draft || '').trim().length;
  const t = String(transcript || '').trim().length;
  if (d === 0) return true;
  return d <= t;
}

/** Which section this draft may be offered for. Never anything else. */
function mayScribe(section) {
  return SCRIBABLE.includes(section);
}

/* ==========================================================================
 * Deepgram's answer, read into turns
 * ======================================================================== */

/**
 * Turn Deepgram's response into speaker-tagged turns.
 *
 * PURE, and here rather than in `scribe.js`, because the shape of a provider's
 * reply is exactly the kind of thing that is wrong in a way no unit test
 * catches if it only ever runs against the network.
 *
 * `utterances` is what we asked for and what we use. If it is missing — an
 * older model, a changed plan, a mono recording Deepgram declined to diarise —
 * we fall back to the plain transcript as a SINGLE UNKNOWN SPEAKER rather than
 * pretending to know who spoke. An unlabelled turn is honest; a wrongly
 * labelled one is a false report.
 */
function readDeepgram(body) {
  const alt = body?.results?.channels?.[0]?.alternatives?.[0] || null;
  const plain = String(alt?.transcript || '').trim();

  const utterances = Array.isArray(body?.results?.utterances)
    ? body.results.utterances : [];

  if (utterances.length === 0) {
    // No diarization came back. Say so rather than inventing speakers.
    return {
      turns: plain ? [{ speaker: null, text: plain }] : [],
      speakers: [],
      diarised: false,
      text: plain,
    };
  }

  const turns = utterances
    .map((u) => ({
      speaker: Number.isInteger(u?.speaker) ? u.speaker : null,
      text: String(u?.transcript || '').trim(),
    }))
    .filter((t) => t.text.length > 0);

  const speakers = [...new Set(turns.map((t) => t.speaker).filter((n) => n !== null))]
    .sort((a, b) => a - b);

  return {
    turns,
    speakers,
    // Two or more voices is what "diarised" is for. One speaker is a
    // monologue, and labelling it adds nothing.
    diarised: speakers.length > 1,
    text: turns.map((t) => t.text).join(' ').trim(),
  };
}

/**
 * Only what the patient said, once the pharmacist has told us who that is.
 *
 * THE WHOLE POINT OF CHOOSING A DIARIZING PROVIDER. Subjective is what the
 * PATIENT reported. With turns and an answer to "which voice is the patient",
 * that becomes a filter instead of a guess.
 *
 * An unknown speaker is NOT included. If we cannot tell whose words those
 * were, writing them down as the patient's is the false report this whole
 * design exists to avoid.
 */
function patientTurns(parsed, patientSpeaker) {
  const turns = parsed?.turns || [];
  if (!Number.isInteger(patientSpeaker)) return [];
  return turns.filter((t) => t.speaker === patientSpeaker);
}

/** Those turns as the text the model is given. */
function patientText(parsed, patientSpeaker) {
  return patientTurns(parsed, patientSpeaker).map((t) => t.text).join(' ').trim();
}

module.exports = {
  SCRIBABLE,
  NEVER_SCRIBABLE,
  SYSTEM_PROMPT,
  MIN_TRANSCRIPT_CHARS,
  readTranscript,
  readDraft,
  unsupportedNegative,
  BLANKET_CLAIM,
  withinTranscript,
  mayScribe,
  readDeepgram,
  patientTurns,
  patientText,
};
