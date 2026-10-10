/**
 * The request contract for the scribe's drafting step.
 *
 * SCRIBE_PLAN.md. Needs no key, no network and no recording — the point of
 * keeping this layer pure. What it defends is narrower and sharper than
 * `scribeContract.test.js`: that file asks whether a DRAFT is safe to show,
 * this one asks whether we have been told enough to draft at all.
 *
 * The bug class it exists for is the one `refillInput` was written after: a
 * service tested only against well-shaped objects passes every test while
 * every real form submission fails, because a browser sends strings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readScribeDraftInput, SCRIBE_REFUSALS, MAX_TURNS, MAX_TRANSCRIPT_CHARS,
} = require('../services/ai/scribeInput');
const { readDeepgram } = require('../services/ai/scribeContract');

/** Two voices, as the screen sends them back after a recording. */
const TWO_VOICES = [
  { speaker: 0, text: 'Good morning, what can I help you with?' },
  { speaker: 1, text: 'I have had a dry cough for four days.' },
  { speaker: 0, text: 'You should drink plenty of water and rest.' },
  { speaker: 1, text: 'It is worse at night.' },
];

// THE MOST IMPORTANT TEST IN THIS FILE.
test('two voices and nobody named is REFUSED, never drafted from both', () => {
  // Drafting the whole conversation as the Subjective would record the
  // pharmacist's own questions and advice as something the patient reported.
  // That is the single failure Deepgram was chosen to prevent, and it would
  // be reintroduced here — on the way back IN — if this layer shrugged and
  // used the full transcript.
  assert.throws(
    () => readScribeDraftInput({ turns: TWO_VOICES }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /which voice is the patient/i);
      // The form has to be able to highlight the control that is wrong.
      assert.equal(err.field, 'patientSpeaker');
      return true;
    },
  );

  // Named, and only that voice survives.
  const named = readScribeDraftInput({ turns: TWO_VOICES, patientSpeaker: 1 });
  assert.equal(named.patientSpeaker, 1);
  assert.deepEqual(named.parsed.speakers, [0, 1]);
  assert.equal(named.parsed.diarised, true);
});

test('a voice that is not in the recording is refused, not silently emptied', () => {
  // Naming an absent speaker yields no patient text, so the model would be
  // handed an empty string and the pharmacist told the recording caught
  // nothing. That is a confusing lie about the recording — the truth is that
  // the request is wrong, and the screen should say so.
  assert.throws(
    () => readScribeDraftInput({ turns: TWO_VOICES, patientSpeaker: 7 }),
    (err) => {
      assert.match(err.message, /not in this recording/i);
      assert.equal(err.field, 'patientSpeaker');
      return true;
    },
  );
});

test('a select sends "1" and that is a valid answer', () => {
  // The refillInput lesson, in the one place a number reaches this feature
  // from a control rather than from code. A contract that only accepts a
  // JavaScript integer is a contract every real submission fails while every
  // test passes.
  const r = readScribeDraftInput({ turns: TWO_VOICES, patientSpeaker: '1' });
  assert.equal(r.patientSpeaker, 1);

  // And "0" is the first voice, not an absent answer. A falsy check here
  // would make speaker 0 unnameable.
  const zero = readScribeDraftInput({ turns: TWO_VOICES, patientSpeaker: '0' });
  assert.equal(zero.patientSpeaker, 0);

  for (const nonsense of ['one', '1.5', '-1', 'null', {}, [], true]) {
    assert.throws(
      () => readScribeDraftInput({ turns: TWO_VOICES, patientSpeaker: nonsense }),
      /which voice is the patient|not in this recording/i,
      `${JSON.stringify(nonsense)} was accepted as a speaker`,
    );
  }
});

test('an unknown speaker stays unknown and never becomes the first voice', () => {
  // `readDeepgram` refuses to guess who spoke when the provider did not say.
  // Coercing that null to 0 on the way back in would attribute half a
  // conversation at random — the same failure, reintroduced at the other end
  // of the round trip.
  const r = readScribeDraftInput({
    turns: [{ speaker: null, text: 'cough for four days, worse at night' }],
  });
  assert.equal(r.parsed.turns[0].speaker, null);
  assert.deepEqual(r.parsed.speakers, []);
  assert.equal(r.parsed.diarised, false);
  // Nobody to name, so nobody is named — and the draft is made from the whole
  // transcript, which is honest when there is only one voice in it.
  assert.equal(r.patientSpeaker, null);
});

test('a recording with one voice needs no answer about whose it is', () => {
  // A pharmacist dictating alone, or a patient who talked while the
  // pharmacist listened. Demanding a speaker here would be a question with
  // one answer.
  const r = readScribeDraftInput({
    turns: [
      { speaker: 0, text: 'I have been having headaches since Monday.' },
      { speaker: 0, text: 'They are worse in the afternoon.' },
    ],
  });
  assert.equal(r.patientSpeaker, null);
  assert.deepEqual(r.parsed.speakers, [0]);
  assert.equal(r.parsed.diarised, false);
  assert.match(r.parsed.text, /headaches since Monday/);
});

test('nothing to draft from is refused before a model is reached', () => {
  for (const nothing of [
    {}, { turns: null }, { turns: [] }, { turns: 'cough' },
    { turns: [{ speaker: 0, text: '   ' }, { speaker: 1, text: '' }] },
  ]) {
    assert.throws(
      () => readScribeDraftInput(nothing),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.field, 'turns');
        return true;
      },
      `${JSON.stringify(nothing)} was accepted as a transcript`,
    );
  }
  // Called with nothing at all, rather than throwing something unreadable.
  assert.throws(() => readScribeDraftInput(), /no transcript/i);
  assert.throws(() => readScribeDraftInput(null), /no transcript/i);
});

test('the parsed shape is the one the provider produces, so there is ONE code path', () => {
  // `draftNote()` must not be able to tell whether it was handed Deepgram's
  // answer or a round trip through a browser. Two shapes would mean two paths
  // through the drafting code and one of them tested.
  const fromProvider = readDeepgram({
    results: {
      channels: [{ alternatives: [{ transcript: 'x' }] }],
      utterances: TWO_VOICES.map((t) => ({ speaker: t.speaker, transcript: t.text })),
    },
  });
  const fromBrowser = readScribeDraftInput({ turns: TWO_VOICES, patientSpeaker: 1 }).parsed;

  assert.deepEqual(Object.keys(fromBrowser).sort(), Object.keys(fromProvider).sort());
  assert.deepEqual(fromBrowser.turns, fromProvider.turns);
  assert.deepEqual(fromBrowser.speakers, fromProvider.speakers);
  assert.equal(fromBrowser.diarised, fromProvider.diarised);
  assert.equal(fromBrowser.text, fromProvider.text);
});

test('a transcript longer than a consultation is refused', () => {
  // Not a security boundary — the request is authenticated and tenant-scoped.
  // It stops one mistyped loop in a browser becoming a 40,000-token model
  // call billed to the pharmacy.
  assert.ok(MAX_TURNS > 0 && MAX_TRANSCRIPT_CHARS > 0);

  const tooMany = Array.from({ length: MAX_TURNS + 1 }, () => ({ speaker: 0, text: 'cough' }));
  assert.throws(() => readScribeDraftInput({ turns: tooMany }), /too long/i);

  const tooLong = [{ speaker: 0, text: 'a'.repeat(MAX_TRANSCRIPT_CHARS + 1) }];
  assert.throws(() => readScribeDraftInput({ turns: tooLong }), /too long/i);
});

test('each refusal says what to DO, not that something went wrong', () => {
  // "Cannot record" tells a pharmacist standing at a counter nothing. The
  // three reasons have three different answers and the sentences have to
  // carry them: ask the patient, open a new consultation, or nothing.
  assert.match(SCRIBE_REFUSALS.no_consent, /ask the patient/i);
  assert.match(SCRIBE_REFUSALS.finalised, /finalised/i);
  assert.match(SCRIBE_REFUSALS.not_found, /not found/i);

  // Three reasons, three sentences, no two the same — a shared message would
  // be the generic error with extra steps.
  const said = Object.values(SCRIBE_REFUSALS);
  assert.equal(new Set(said).size, said.length);
  // And none of them blames the person or mentions the software.
  for (const sentence of said) {
    assert.doesNotMatch(sentence, /error|failed|invalid|unauthorised|forbidden/i);
  }
});
