/**
 * What the AI scribe says on screen.
 *
 * SCRIBE_PLAN.md. The wording IS the safety layer on this side of the wire. A
 * scribe produces fluent clinical prose, and fluency reads as authority — so
 * every test here defends against a pharmacist in a hurry mistaking a machine
 * draft for the record, or a refusal for a finding about the patient.
 *
 * The server-side half (`scribeContract.test.js`, `scribeInput.test.js`) asks
 * whether a draft is safe to produce. This asks whether what the screen says
 * about it is true.
 */

import { test, expect } from 'vitest';
import {
  CONSENT_SCRIPT, CONSENT_CONFIRM, NOT_ASKED, consentedNote,
  DRAFT_REFUSALS, DRAFT_REFUSAL_FALLBACK, draftRefusalNote,
  speakerLabel, SPEAKER_QUESTION, NOT_SEPARATED, ONE_VOICE, transcriptNote,
  DRAFT_HEADING, ACCEPT_LABEL, WILL_REPLACE, acceptWarning,
  NOT_STORED, canDraft, SCRIBE_STEPS,
} from './scribeFormat.js';

// THE MOST IMPORTANT TEST IN THIS FILE.
test('the consent script is something a pharmacist can SAY, and every clause is true', () => {
  // Not a legal notice and not a tickbox label. If the sentence is hard to say
  // out loud it will not be said, and the consent becomes a click — which is
  // a worse record than none, because it claims a conversation happened.
  expect(CONSENT_SCRIPT).toMatch(/^I would like to record/);
  // First person, addressed to the patient. "The pharmacy may record this
  // consultation" is a notice; this is speech.
  expect(CONSENT_SCRIPT).toMatch(/\byou\b/);

  // Each promise is true of the implementation, which is why it is sayable:
  // nothing in the schema can hold a recording, and the transcript lives in
  // the browser tab only.
  expect(CONSENT_SCRIPT).toMatch(/not kept/i);
  expect(CONSENT_SCRIPT).toMatch(/notes I write/i);
  // And the patient is told they can refuse. A consent script that omits the
  // refusal is not asking.
  expect(CONSENT_SCRIPT).toMatch(/say no/i);

  // No legal or technical vocabulary — the words a patient at a counter in
  // Lagos cannot act on.
  for (const jargon of [
    /GDPR/i, /NDPA/i, /data subject/i, /lawful basis/i, /process(?:ing)? your data/i,
    /third part(?:y|ies)/i, /AI model/i, /transcription service/i,
  ]) {
    expect(CONSENT_SCRIPT, `the script uses jargon: ${jargon}`).not.toMatch(jargon);
  }

  // The confirmation says what the pharmacist DID, not that a box is ticked.
  // "I agree to the terms" would be the pharmacist consenting, which is the
  // wrong person entirely.
  expect(CONSENT_CONFIRM).toMatch(/told the patient/i);
  expect(CONSENT_CONFIRM).toMatch(/they agreed/i);
});

test('before anybody is asked, the screen says what has to happen in the room', () => {
  // "Consent required" describes a form. A pharmacist needs to know that the
  // next step is a conversation, and that nothing is recording meanwhile.
  expect(NOT_ASKED).toMatch(/ask the patient/i);
  expect(NOT_ASKED).toMatch(/nothing is recorded/i);
  expect(NOT_ASKED).not.toMatch(/required|invalid|error|permission denied/i);
});

test('a consent already given is shown, so it cannot look forgotten', () => {
  const when = () => '10 Oct, 09:14';
  expect(consentedNote('2026-10-10T09:14:00Z', when)).toBe('Patient agreed to be recorded · 10 Oct, 09:14');

  // Without a formatter it still states the fact rather than printing a raw
  // timestamp at a pharmacist.
  expect(consentedNote('2026-10-10T09:14:00Z', null)).toBe('Patient agreed to be recorded');

  // Never asked is NOTHING, not "no consent" — the panel shows the script
  // instead, and two sentences about the same absence would contradict.
  expect(consentedNote(null, when)).toBe(null);
  expect(consentedNote(undefined, when)).toBe(null);
});

// THE SECOND MOST IMPORTANT TEST.
test('a refusal is about the RECORDING, never a finding about the patient', () => {
  // The whole design problem in one assertion. "The recording caught too
  // little" is about a microphone. Phrased as "no symptoms were reported" the
  // same state becomes a clinical finding this software invented — and it
  // would sit in front of a pharmacist as though somebody had asked.
  for (const [code, sentence] of Object.entries(DRAFT_REFUSALS)) {
    expect(sentence.length, `${code} says nothing`).toBeGreaterThan(20);

    // Not a claim about the person or their health.
    for (const clinical of [
      /no symptoms?/i, /no complaints?/i, /nothing reported/i, /patient reports/i,
      /denies/i, /unremarkable/i, /no abnormal/i, /the patient (?:is|was|has)/i,
      /asymptomatic/i, /normal/i,
    ]) {
      expect(sentence, `${code} makes a clinical claim: ${clinical}`).not.toMatch(clinical);
    }
  }

  // Each one tells the pharmacist the transcript is still there, because that
  // is the thing that lets them carry on — and losing the expensive half over
  // the cheap half is the failure `scribe()` already guards against.
  // EXTENDED 2026-10-10 with truncated, which the live provider produced on
  // every realistic transcript before maxTokens was raised. It is listed
  // separately from too_short on purpose: one is about the recording and the
  // other is about the assistant, and telling a pharmacist their recording
  // was empty when it was not is a false claim about their consultation.
  for (const code of ['too_short', 'meta', 'invented_negative', 'longer_than_transcript', 'model_unavailable', 'truncated']) {
    expect(DRAFT_REFUSALS[code], `${code} does not mention the transcript`).toMatch(/transcript/i);
  }

  // The two SAFETY refusals say the draft was thrown away, plainly. A
  // pharmacist who knows the assistant discards its own unsafe output is a
  // pharmacist who trusts the rest of it for the right reason.
  expect(DRAFT_REFUSALS.invented_negative).toMatch(/did not say/i);
  expect(DRAFT_REFUSALS.invented_negative).toMatch(/discarded/i);
  expect(DRAFT_REFUSALS.longer_than_transcript).toMatch(/discarded/i);

  // An unknown code still produces a usable sentence rather than nothing or
  // the raw code. A refusal the screen cannot name must not render as blank,
  // which would look like a draft of nothing.
  expect(draftRefusalNote('something_new_from_the_server')).toBe(DRAFT_REFUSAL_FALLBACK);
  expect(DRAFT_REFUSAL_FALLBACK).toMatch(/transcript/i);
  // And no refusal at all is no sentence.
  expect(draftRefusalNote(null)).toBe(null);
  expect(draftRefusalNote(undefined)).toBe(null);
});

test('a voice is numbered the way a person counts, and never given an identity', () => {
  // Deepgram counts from 0 and a pharmacist does not. "Voice 0" is a label
  // nobody outside this codebase reads.
  expect(speakerLabel(0)).toBe('Voice 1');
  expect(speakerLabel(1)).toBe('Voice 2');

  // Never a letter or a role. "Speaker A" suggests an identity, and
  // "Pharmacist"/"Patient" would be the software answering the one question it
  // must not answer.
  for (const n of [0, 1, 2, 5]) {
    expect(speakerLabel(n)).not.toMatch(/patient|pharmacist|doctor|staff|[A-Z]$/);
  }

  // An unknown speaker SAYS unknown. Falling back to "Voice 1" would
  // attribute words nobody attributed.
  expect(speakerLabel(null)).toBe('Unknown voice');
  expect(speakerLabel(undefined)).toBe('Unknown voice');
  expect(speakerLabel('1')).toBe('Unknown voice');
});

test('the question is asked, and has no default', () => {
  expect(SPEAKER_QUESTION).toMatch(/\?$/);
  expect(SPEAKER_QUESTION).toMatch(/which voice is the patient/i);
});

test('"we could not tell who spoke" and "one person spoke" stay different sentences', () => {
  // Two different facts, and only the second is a reason to skip the
  // question. Collapsing them would tell a pharmacist a two-voice recording
  // had one voice in it.
  expect(transcriptNote({ diarised: false, speakers: [0] })).toBe(ONE_VOICE);
  expect(transcriptNote({ diarised: false, speakers: [] })).toBe(NOT_SEPARATED);
  expect(ONE_VOICE).not.toBe(NOT_SEPARATED);

  // The unseparated case tells them to CHECK before accepting, because the
  // whole transcript is being used and it may contain their own words.
  expect(NOT_SEPARATED).toMatch(/check/i);
  expect(NOT_SEPARATED).toMatch(/whole transcript/i);

  // Separated: no note at all. The turns speak for themselves and a sentence
  // explaining that they are separated is the 188 words of prose the
  // consultation redesign removed.
  expect(transcriptNote({ diarised: true, speakers: [0, 1] })).toBe(null);
  expect(transcriptNote()).toBe(NOT_SEPARATED);
});

test('the draft is always labelled a draft, and the accept says what it will do', () => {
  // A pharmacist scanning the screen has to tell machine output from the note
  // without reading carefully.
  expect(DRAFT_HEADING).toMatch(/suggested/i);
  expect(DRAFT_HEADING).toMatch(/recording/i);
  // Never presented as the finished article.
  expect(DRAFT_HEADING).not.toMatch(/^subjective$|^note$|^summary$/i);

  // "OK" or "Apply" would not say where it lands. This names the section.
  expect(ACCEPT_LABEL).toMatch(/subjective/i);
  expect(ACCEPT_LABEL).not.toMatch(/^(ok|apply|confirm|done|save)$/i);
});

test('a pharmacist who has already typed is told that accepting replaces it', () => {
  // Accepting REPLACES and there is no undo. Discovering that afterwards
  // costs a clinical note somebody wrote by hand.
  expect(acceptWarning('Reports a cough since Monday')).toBe(WILL_REPLACE);
  expect(WILL_REPLACE).toMatch(/replace/i);

  // An empty box has nothing to lose, so no warning — a caution shown every
  // time is a caution nobody reads.
  expect(acceptWarning('')).toBe(null);
  expect(acceptWarning('   ')).toBe(null);
  expect(acceptWarning(null)).toBe(null);
  expect(acceptWarning(undefined)).toBe(null);
});

test('the screen states that nothing is kept, because the patient was told so', () => {
  expect(NOT_STORED).toMatch(/not saved/i);
  expect(NOT_STORED).toMatch(/this screen only/i);
});

// THE RULE THE PROVIDER CHOICE RESTS ON, mirrored on the client.
test('with two voices and nobody named, the screen offers no draft at all', () => {
  // The server refuses this (`readScribeDraftInput`). The screen must not
  // offer a button that the server would refuse — and more importantly, a
  // draft from both voices records the pharmacist's own advice as the
  // patient's report.
  const turns = [
    { speaker: 0, text: 'What can I help you with?' },
    { speaker: 1, text: 'I have had a cough for four days.' },
  ];
  expect(canDraft({ turns, speakers: [0, 1], patientSpeaker: null })).toBe(false);
  expect(canDraft({ turns, speakers: [0, 1], patientSpeaker: 1 })).toBe(true);
  expect(canDraft({ turns, speakers: [0, 1], patientSpeaker: 0 })).toBe(true);

  // One voice needs no answer — a question with one option is not a question.
  expect(canDraft({ turns: [turns[1]], speakers: [1], patientSpeaker: null })).toBe(true);
  // Nor does an unseparated recording.
  expect(canDraft({ turns: [{ speaker: null, text: 'cough for four days' }], speakers: [] })).toBe(true);

  // Nothing heard, nothing to draft.
  expect(canDraft({ turns: [], speakers: [] })).toBe(false);
  expect(canDraft()).toBe(false);
});

test('the steps keep the question BETWEEN hearing and drafting', () => {
  // `turns` is its own step and not folded into `drafted`. That gap is where
  // a person answers the one question a model must not answer, and a flow
  // that goes straight from audio to draft has no room for it.
  expect(SCRIBE_STEPS.indexOf('turns')).toBeGreaterThan(SCRIBE_STEPS.indexOf('working'));
  expect(SCRIBE_STEPS.indexOf('drafted')).toBeGreaterThan(SCRIBE_STEPS.indexOf('turns'));
  // And consent comes before anything else.
  expect(SCRIBE_STEPS[0]).toBe('consent');
});
