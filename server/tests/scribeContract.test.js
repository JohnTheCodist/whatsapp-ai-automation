/**
 * What the AI scribe may put in front of a pharmacist.
 *
 * SCRIBE_PLAN.md. Every test here defends against the same failure, which is
 * the only one that matters: a FLUENT, CLINICAL-SOUNDING paragraph containing
 * something nobody said, saved into a patient's record and read months later
 * by somebody who was not in the room.
 *
 * None of this needs a key, a network or a recording — which is the point.
 * The rules that make a feature safe should be verifiable without the
 * feature's infrastructure, the same split `communicationPolicy` uses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCRIBABLE, NEVER_SCRIBABLE, SYSTEM_PROMPT, MIN_TRANSCRIPT_CHARS,
  readTranscript, readDraft, withinTranscript, mayScribe,
  readDeepgram, patientTurns, patientText,
  unsupportedNegative, BLANKET_CLAIM,
} = require('../services/ai/scribeContract');

// THE MOST IMPORTANT TEST IN THIS FILE.
test('the scribe may draft what the patient SAID, and nothing a pharmacist decides', () => {
  // Subjective is reportage. Everything else on that screen is a judgement or
  // a measurement, and a model drafting one of those is a model making a
  // clinical decision — the line §38 draws.
  assert.deepEqual(SCRIBABLE, ['subjective']);

  for (const section of NEVER_SCRIBABLE) {
    assert.equal(mayScribe(section), false, `the scribe was offered for ${section}`);
  }
  // The ones that would be worst, named explicitly so this cannot be widened
  // without somebody deleting the line that says why.
  for (const section of ['assessment', 'objective', 'plan', 'referral', 'problems']) {
    assert.ok(NEVER_SCRIBABLE.includes(section), `${section} is not on the forbidden list`);
    assert.equal(mayScribe(section), false);
  }
  assert.equal(mayScribe('allergies'), false);
  assert.equal(mayScribe(null), false);
  assert.equal(mayScribe('subjective'), true);
});

test('the instruction says that saying LESS is correct', () => {
  // A model told only "write the history" writes a complete-looking one. The
  // prompt has to make thinness the right answer, or fluency fills the gap.
  assert.match(SYSTEM_PROMPT, /ONLY information stated in the text you are given/);
  assert.match(SYSTEM_PROMPT, /If the text is thin, your answer is thin/);
  assert.match(SYSTEM_PROMPT, /return an empty string/i);

  // AMENDED 2026-10-05 with the provider. The first version pinned "NO SPEAKER
  // LABELS" and "LEAVE IT OUT", because Whisper returns one undivided run of
  // text and the model had to be told it could not tell who spoke.
  //
  // Deepgram separates the speakers and the PHARMACIST identifies which voice
  // is the patient, so the model is now given only the patient's turns. The
  // rule this test defends did not weaken — it moved UPSTREAM, from an
  // instruction the model might ignore to a filter it cannot see past. What
  // the prompt must now say is the opposite: that everything here is the
  // patient's, so questions and advice are not written down as reports.
  assert.match(SYSTEM_PROMPT, /Everything you are given was said BY THE PATIENT/);
  // The prompt wraps between "do" and "not", so the whitespace class goes
  // there — not before "record", which is where the first version put it.
  assert.match(SYSTEM_PROMPT, /do\s+not record advice or explanations as though the patient said them/);

  // And the absence rule, which survives any provider: a patient who did not
  // mention fever has not denied it.
  assert.match(SYSTEM_PROMPT, /Do not state an absence the patient did not state/);

  // And it is told not to stray into the sections it may not write.
  assert.match(SYSTEM_PROMPT, /Do not write an assessment, a\s*\n?\s*diagnosis, a plan/);
});

test('a recording that caught nothing never becomes a paragraph', () => {
  // The failure: a silent room, a pocketed phone, a patient who said one
  // word — and a tidy history about a consultation that did not happen.
  for (const nothing of [null, undefined, '', '   ', '\n\n', 'mm', 'okay']) {
    const r = readTranscript(nothing);
    assert.equal(r.usable, false, `"${nothing}" was treated as a usable transcript`);
    assert.equal(r.reason, 'too_short');
  }
  // It fails CLOSED before the model is called at all: no request, no cost,
  // and above all no opportunity to invent.
  assert.ok(MIN_TRANSCRIPT_CHARS > 0);

  const real = readTranscript('  I have been having a dry cough for about four days now.  ');
  assert.equal(real.usable, true);
  assert.equal(real.text, 'I have been having a dry cough for about four days now.');
});

test('a model that answers about the REQUEST is refused, not shown', () => {
  // "I'm sorry, the transcript does not contain enough information" is not a
  // clinical note. Dropped into the Subjective box it is a sentence about the
  // software sitting in a patient's record.
  for (const meta of [
    "I'm sorry, but the transcript does not contain enough information.",
    'As an AI language model, I cannot determine what the patient said.',
    'Unfortunately the audio was unclear.',
    'The transcript is too short to summarise.',
    'There is not enough information to write a subjective section.',
  ]) {
    const r = readDraft(meta);
    assert.equal(r.ok, false, `a meta answer reached the box: ${meta}`);
    assert.equal(r.draft, '');
    assert.equal(r.refused, 'meta');
  }
});

// THE SECOND MOST IMPORTANT TEST.
test('the scribe may not assert an absence nobody established', () => {
  // The allergy card's lesson (0058), in the most dangerous possible place. A
  // model writing "denies chest pain" or "no other symptoms" is recording an
  // answer to a question NOBODY ASKED — and the next pharmacist reads it as
  // one that was.
  for (const invented of [
    'Patient reports a cough. No other symptoms.',
    'Four days of cough. Denies fever.',
    'Cough for four days, otherwise well.',
    'Reports dizziness. No known allergies.',
    'Cough. Nil chest pain.',
    'Headache for two days. Systems otherwise unremarkable.',
    'Reports a cough with no abnormality elsewhere.',
  ]) {
    const r = readDraft(invented);
    assert.equal(r.ok, false, `an invented negative reached the box: ${invented}`);
    assert.equal(r.refused, 'invented_negative');
  }

  // What the patient actually said, including a genuine report, is fine.
  const good = readDraft('Reports a dry cough for four days, worse at night. Has tried honey and warm water.');
  assert.equal(good.ok, true);
  assert.match(good.draft, /dry cough for four days/);
});

test('a draft longer than the conversation has had material added to it', () => {
  // A summary of a conversation is shorter than the conversation. One that is
  // LONGER has gained content, and the only place it can have come from is
  // the model.
  const transcript = 'Cough. Four days. Dry.';
  assert.equal(withinTranscript('Reports a dry cough for four days.', transcript), false);
  assert.equal(withinTranscript('Dry cough, 4 days.', transcript), true);
  // An empty draft is always fine — that is the honest answer to a thin
  // recording, not a failure.
  assert.equal(withinTranscript('', transcript), true);
  assert.equal(withinTranscript(null, transcript), true);
});

test('a draft is unwrapped, not trusted', () => {
  // Models return prose in code fences and quotes. Those are formatting, not
  // content, and they must not end up in a clinical record.
  assert.equal(readDraft('```\nReports a cough for four days.\n```').draft,
    'Reports a cough for four days.');
  assert.equal(readDraft('"Reports a cough for four days."').draft,
    'Reports a cough for four days.');
  assert.equal(readDraft('```text\nReports a cough.\n```').draft, 'Reports a cough.');

  // An empty answer is ACCEPTED, not refused: it is the correct response to a
  // recording with nothing in it, and the screen says so.
  const empty = readDraft('');
  assert.equal(empty.ok, true);
  assert.equal(empty.draft, '');
  assert.equal(empty.refused, null);
});

/* ==========================================================================
 * Speaker separation — the reason the provider is Deepgram
 * ======================================================================== */

/** A Deepgram reply with two voices, shaped as the API really returns it. */
const TWO_VOICES = {
  results: {
    channels: [{ alternatives: [{ transcript: 'one undivided run of text' }] }],
    utterances: [
      { speaker: 0, transcript: 'Good morning, what can I help you with?' },
      { speaker: 1, transcript: 'I have had a dry cough for four days.' },
      { speaker: 0, transcript: 'You should drink plenty of water and rest.' },
      { speaker: 1, transcript: 'It is worse at night.' },
    ],
  },
};

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('the pharmacist’s own words never become the patient’s report', () => {
  // This is why the provider is Deepgram and not Whisper. Subjective is what
  // the PATIENT said. Given one undivided transcript, a model writing it has
  // to GUESS which half of a conversation to record — and the guess lands in
  // a clinical record as "the patient reported".
  const parsed = readDeepgram(TWO_VOICES);
  assert.equal(parsed.diarised, true);
  assert.deepEqual(parsed.speakers, [0, 1]);

  // Speaker 1 is the patient: only their words.
  const asPatient = patientText(parsed, 1);
  assert.match(asPatient, /dry cough for four days/);
  assert.match(asPatient, /worse at night/);
  // And NOT the pharmacist's question, nor the pharmacist's advice — advice
  // recorded as a patient report is a fabricated history.
  assert.doesNotMatch(asPatient, /what can I help/i);
  assert.doesNotMatch(asPatient, /drink plenty of water/i);

  // The filter is symmetrical: naming the other voice gives the other half.
  assert.match(patientText(parsed, 0), /drink plenty of water/i);
  assert.doesNotMatch(patientText(parsed, 0), /dry cough/i);
});

test('with nobody identified as the patient, NOTHING is drafted', () => {
  // The one question a model must not answer is which voice is the patient.
  // Until a person answers it there is no patient text at all — so there is
  // nothing to draft from, and the model is never called.
  const parsed = readDeepgram(TWO_VOICES);
  for (const nobody of [null, undefined, '1', NaN, -1.5, {}]) {
    assert.equal(patientText(parsed, nobody), '',
      `a non-speaker (${JSON.stringify(nobody)}) produced patient text`);
    assert.deepEqual(patientTurns(parsed, nobody), []);
  }

  // And empty patient text is refused before the model is reached.
  assert.equal(readTranscript(patientText(parsed, null)).usable, false);
});

test('a recording Deepgram could not separate says so, rather than guessing', () => {
  // An older model, a changed plan, or a mono recording: no utterances come
  // back. Inventing speakers here would attribute half a conversation at
  // random, which is worse than admitting we do not know.
  const flat = readDeepgram({
    results: { channels: [{ alternatives: [{ transcript: 'cough for four days' }] }] },
  });
  assert.equal(flat.diarised, false);
  assert.deepEqual(flat.speakers, []);
  assert.equal(flat.turns.length, 1);
  assert.equal(flat.turns[0].speaker, null, 'an unknown speaker must stay null');
  assert.equal(flat.text, 'cough for four days');

  // An unknown speaker is never treated as the patient.
  assert.equal(patientText(flat, 0), '');
  assert.equal(patientText(flat, null), '');
});

test('a reply with nothing in it produces no turns and no speakers', () => {
  for (const empty of [null, undefined, {}, { results: {} },
    { results: { channels: [] } },
    { results: { channels: [{ alternatives: [{ transcript: '' }] }], utterances: [] } }]) {
    const parsed = readDeepgram(empty);
    assert.deepEqual(parsed.turns, [], `turns from ${JSON.stringify(empty)}`);
    assert.deepEqual(parsed.speakers, []);
    assert.equal(parsed.diarised, false);
    assert.equal(parsed.text, '');
  }
});

test('one voice is not separated, because there is nothing to separate', () => {
  // A pharmacist dictating alone. Labelling that as separated would offer a
  // "which voice is the patient" question with one answer and no meaning.
  const solo = readDeepgram({
    results: {
      channels: [{ alternatives: [{ transcript: 'x' }] }],
      utterances: [
        { speaker: 0, transcript: 'The patient reports a cough.' },
        { speaker: 0, transcript: 'It started four days ago.' },
      ],
    },
  });
  assert.equal(solo.diarised, false);
  assert.deepEqual(solo.speakers, [0]);
  assert.equal(solo.turns.length, 2);
});

/* ==========================================================================
 * Quoted or fabricated — the question the absence rule actually asks
 *
 * AMENDED 2026-10-10. The rule above ("may not assert an absence nobody
 * established") is unchanged and still the point. What changed is HOW it is
 * decided, because the old version was measured against the real model on a
 * realistic consultation and refused a faithful draft:
 *
 *   patient said   "No fever."  "No I do not smoke at all."
 *   model wrote    "No fever. Did not smoke."
 *   old rule       REFUSED
 *
 * A pharmacist asks "any fever?" and the patient answers, so that is the
 * NORMAL case. The old rule would have refused nearly every honest draft
 * while looking perfectly safe against every test in this file.
 * ======================================================================== */

// THE TEST THAT MADE THIS CHANGE NECESSARY.
test('a negative the patient actually SAID is a quotation, not a fabrication', () => {
  // Measured against the live model, not imagined. This draft came back from
  // DeepSeek on this patient text, and the old rule threw it away.
  const said = 'I have had a dry cough for five days. No fever. '
    + 'No I do not smoke at all.';
  const r = readDraft('Dry cough for five days. No fever. Did not smoke.', { source: said });
  assert.equal(r.ok, true, `a quoted negative was refused: ${r.sentence}`);
  assert.match(r.draft, /No fever/);
});

// AND THE HALF THAT MUST NOT HAVE LOOSENED.
test('a negative the patient never said is still refused, and now for the right reason', () => {
  // The worst sentence this feature could produce is a fabricated "no known
  // allergies". It is refused because the WORDS ARE NOT THERE rather than
  // because the phrase matched a list — which is strictly stronger: it also
  // catches a phrasing nobody thought to add.
  const said = 'I have had a dry cough for five days. It is worse at night.';

  for (const invented of [
    'Dry cough for five days. No known allergies.',
    'Dry cough for five days. Denies chest pain.',
    'Dry cough for five days. No history of asthma.',
    // Phrasings no list contained, caught because the subject is absent.
    'Dry cough. The patient has never had tuberculosis.',
    'Dry cough. Not diabetic.',
  ]) {
    const r = readDraft(invented, { source: said });
    assert.equal(r.ok, false, `an invented negative was accepted: ${invented}`);
    assert.equal(r.refused, 'invented_negative');
    assert.ok(r.sentence, `the refusal does not say WHICH sentence: ${invented}`);
  }
});

test('mentioning something is not denying it', () => {
  // The subtlest failure, and the reason both halves are required. A patient
  // who said "my chest feels tight" has named the chest WITHOUT denying
  // anything about it — so "no chest pain" is still a claim nobody made.
  const said = 'My chest feels tight sometimes when I cough. I have no fever.';

  const wrong = readDraft('Cough with chest tightness. No chest pain.', { source: said });
  assert.equal(wrong.ok, false, 'a denial was read out of a mere mention');

  // While the one they did deny passes.
  const right = readDraft('Cough with chest tightness. No fever.', { source: said });
  assert.equal(right.ok, true, `a stated denial was refused: ${right.sentence}`);
});

test('a claim about everything NOT discussed can never be supported', () => {
  // "No other symptoms" asserts the absence of things nobody named, and
  // "unremarkable" asserts a review of systems that did not happen. No patient
  // sentence could license either, so they are refused even when the
  // transcript is full of denials.
  const denials = 'No fever, no pain, no vomiting, no cough, nothing else at all.';

  for (const blanket of [
    'Reports dizziness. No other symptoms.',
    'Reports dizziness. Systems otherwise unremarkable.',
    'Reports dizziness, otherwise well.',
    'Reports dizziness. No acute distress.',
    'Reports dizziness. Within normal limits.',
    'Reports dizziness with no abnormality elsewhere.',
  ]) {
    const r = readDraft(blanket, { source: denials });
    assert.equal(r.ok, false, `a blanket claim was accepted: ${blanket}`);
    assert.ok(BLANKET_CLAIM.test(blanket), `not recognised as blanket: ${blanket}`);
  }
});

test('with no patient words at all, every negative is refused', () => {
  // The conservative direction, and the reason this change did not weaken
  // anything: a caller that cannot say what the patient said gets the old
  // behaviour. "We could not tell" is never "it is fine" (GOLDEN-002c).
  for (const negative of [
    'Cough for four days. No fever.',
    'Cough. Denies chest pain.',
    'Cough. Did not smoke.',
  ]) {
    assert.equal(readDraft(negative).ok, false, `accepted with no source: ${negative}`);
    assert.equal(readDraft(negative, { source: null }).ok, false);
    assert.equal(readDraft(negative, { source: '' }).ok, false);
  }

  // And a source with no negation in it cannot support one either.
  assert.equal(
    readDraft('Cough. No fever.', { source: 'I have a cough and a fever.' }).ok,
    false,
    'a negative was supported by a source that denied nothing',
  );
});

test('a draft with no claim of absence is not examined for one', () => {
  // The common case must not be touched by any of this. A purely positive
  // report passes whatever the source says.
  const r = readDraft(
    'Dry cough for five days, worse at night. Has tried honey and lime.',
    { source: 'cough five days worse at night honey and lime' },
  );
  assert.equal(r.ok, true);
  assert.equal(unsupportedNegative(r.draft, 'anything'), null);
});

test('a bare negative with nothing to be about is refused', () => {
  // FOUND BY MUTATION, not by writing the test first: making a subjectless
  // negative "supported" left every test green.
  //
  // This is the allergy card's "None" (0058) in the worst possible place. A
  // Subjective box reading "None." or "Not reported." is a claim that
  // something was asked and answered, and it cannot be checked against the
  // patient's words because it does not say what it is about. Unverifiable
  // is refused — the same direction as every other branch here.
  const said = 'No fever, no pain, nothing at all, I feel fine otherwise.';

  for (const bare of [
    'None.',
    'Not reported.',
    'Nil.',
    'Cough for four days. None.',
    'Cough for four days. Not reported.',
  ]) {
    const r = readDraft(bare, { source: said });
    assert.equal(r.ok, false, `a subjectless negative was accepted: ${bare}`);
    assert.equal(r.refused, 'invented_negative');
  }
});

/* ==========================================================================
 * Cut off is not the same as nothing to say
 * ======================================================================== */

test('an answer cut off by the token limit is refused, not reported as silence', () => {
  // THE MOST INSTRUCTIVE BUG IN THIS FEATURE SO FAR, because every test in
  // this file passed while it was happening. Found by driving the live
  // provider, not by reasoning.
  //
  // This deployment's chat model spends tokens REASONING before it answers.
  // They count against the budget and never appear in `content`, so with
  // maxTokens at 400 a realistic 689-character patient transcript came back
  // as `finishReason: 'length'` with an EMPTY string — every single time.
  //
  // An empty answer is otherwise legitimate: a recording that caught little
  // should produce little. So the screen said "the recording caught too
  // little to draft from", which is a statement about the PATIENT'S
  // CONSULTATION, and it was false. The recording was fine. The assistant was
  // interrupted mid-sentence.
  //
  // Pinned structurally, the way GOLDEN-007 pins its sender list: the branch
  // cannot be exercised without a provider, and the thing worth protecting is
  // that it exists at all and is not folded into the empty case.
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', 'services', 'ai', 'scribe.js'), 'utf8',
  );

  // The branch exists, keys off the provider's own finish reason, and has its
  // OWN refusal code rather than reusing the one about the recording.
  assert.match(src, /finishReason === 'length'/,
    'nothing distinguishes a truncated answer from an empty one');
  assert.match(src, /refused: 'truncated'/,
    'a truncated answer does not have its own refusal');

  // And it is checked BEFORE readDraft, because a half-written clinical
  // sentence must not be examined and accepted as a short one.
  assert.ok(
    src.indexOf("finishReason === 'length'") < src.indexOf('readDraft(content'),
    'the truncation check runs after the draft has already been accepted',
  );

  // The budget has headroom for the thinking, not just for the answer. 400
  // was the measured failure; anything near it will fail the same way.
  const budget = Number((src.match(/maxTokens:\s*(\d+)/) || [])[1]);
  assert.ok(budget >= 1000, `maxTokens is ${budget}, which measured as too small at 400`);
});
