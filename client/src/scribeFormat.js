/**
 * What the AI scribe SAYS on screen.
 *
 * SCRIBE_PLAN.md. Pure, like `consultationFormat`, `messageFormat` and
 * `followupFormat` — and here the wording is most of the feature's honesty, so
 * it is the part worth pinning with tests.
 *
 * THE RULE THIS MODULE EXISTS TO HOLD. A scribe produces a fluent clinical
 * paragraph, and fluency reads as authority. Every sentence here is written so
 * that a pharmacist in a hurry cannot mistake a MACHINE DRAFT for the record,
 * or a refusal for a finding about the patient.
 */

/**
 * The consent script, written to be READ ALOUD.
 *
 * Not a legal notice and not a tickbox label. A pharmacist at a counter needs
 * words they can actually say to the person in front of them, and a patient
 * needs to hear what happens in terms they can act on. If the sentence is hard
 * to say out loud it will not be said, and the consent becomes a click.
 *
 * Every clause is TRUE of the implementation, which is why it is short:
 *   - the recording is not kept      (nothing in the schema can hold it)
 *   - the transcript is not kept     (it lives in this tab and nowhere else)
 *   - what survives is the note      (accepted through the ordinary PATCH)
 *   - they can say no                (and the consultation continues as normal)
 */
const CONSENT_SCRIPT = 'I would like to record this conversation so I can listen '
  + 'to you instead of typing. The recording is not kept — I only keep the notes '
  + 'I write from it, and you can say no.';

const CONSENT_CONFIRM = 'I have told the patient and they agreed';
const CONSENT_HEADING = 'Before recording';

/**
 * What the pharmacist is told while nothing has been asked yet.
 *
 * It names the patient's decision, not the software's state. "Consent
 * required" describes a form; this describes what has to happen in the room.
 */
const NOT_ASKED = 'Ask the patient first. Nothing is recorded until you confirm they agreed.';

/** Said once consent is on the record, so it is clear it was not forgotten. */
function consentedNote(at, whenLabel) {
  if (!at) return null;
  const when = typeof whenLabel === 'function' ? whenLabel(at) : null;
  return when ? `Patient agreed to be recorded · ${when}` : 'Patient agreed to be recorded';
}

/**
 * The steps, in order, as the screen moves through them.
 *
 * `turns` is its own step and not folded into `drafted` — the pharmacist
 * answers "which voice is the patient" in between, and that question is the
 * one thing a model must not answer for them.
 */
const SCRIBE_STEPS = Object.freeze(['consent', 'ready', 'recording', 'working', 'turns', 'drafted']);

const STEP_ACTION = Object.freeze({
  ready: 'Start recording',
  recording: 'Stop and transcribe',
  working: 'Transcribing…',
});

/**
 * Why a draft did not come back, in a sentence that says what to do next.
 *
 * NONE OF THESE IS A STATEMENT ABOUT THE PATIENT. That is the whole design
 * problem: "the recording caught too little" is about the microphone, and if
 * it were phrased as "no symptoms were reported" it would be a clinical
 * finding this software invented. Each one names the RECORDING or the DRAFT,
 * never the person.
 *
 * `invented_negative` and `longer_than_transcript` both mean the draft was
 * thrown away for being unsafe, and they say so plainly rather than hiding it
 * as a generic failure — a pharmacist who knows the assistant discards its own
 * output is a pharmacist who trusts the rest of it for the right reason.
 */
const DRAFT_REFUSALS = Object.freeze({
  too_short: 'The recording caught too little to draft from. The transcript is below — type what matters.',
  meta: 'The assistant answered about the recording instead of writing the note, so the draft was discarded. The transcript is below.',
  invented_negative: 'The draft stated something the patient did not say, so it was discarded. The transcript is below — write it yourself.',
  longer_than_transcript: 'The draft was longer than the conversation, which means it added something. It was discarded. The transcript is below.',
  // Added 2026-10-10 after the live provider hit its token ceiling and
  // returned nothing. Deliberately NOT folded into too_short: one is about
  // the recording and the other is about the assistant, and telling a
  // pharmacist the recording was empty when it was not is a false statement
  // about their patient's consultation.
  truncated: 'The assistant ran out of room before it finished, so the part-written draft was discarded. The transcript is below.',
  model_unavailable: 'The assistant is not available right now. The transcript is below and nothing has been lost.',
});

const DRAFT_REFUSAL_FALLBACK = 'No draft was produced. The transcript is below — type what matters.';

function draftRefusalNote(refused) {
  if (!refused) return null;
  return DRAFT_REFUSALS[refused] || DRAFT_REFUSAL_FALLBACK;
}

/**
 * A voice, named for a human.
 *
 * ONE-BASED on screen, zero-based on the wire. Deepgram counts from 0 and a
 * pharmacist does not; "Voice 0" is a label nobody outside this codebase
 * reads, and the mapping belongs in one place rather than in every caller.
 *
 * Never "Speaker A" either — a letter suggests an identity, and all we know is
 * that two different people spoke.
 */
function speakerLabel(speaker) {
  if (!Number.isInteger(speaker)) return 'Unknown voice';
  return `Voice ${speaker + 1}`;
}

/**
 * The question, and why it is phrased as a question rather than a setting.
 *
 * It is the one judgement the pharmacist must make before anything is drafted,
 * and the screen should look like it is asking rather than like it has a
 * default. There is no default: a wrong guess here writes the pharmacist's own
 * advice into the record as the patient's report.
 */
const SPEAKER_QUESTION = 'Which voice is the patient?';
const SPEAKER_HELP = 'The note records what the PATIENT said, so this has to be right.';

/**
 * What the transcript panel says when there is nothing to separate.
 *
 * An undiarised recording is reported honestly rather than labelled as one
 * voice: "we could not tell who was speaking" and "one person spoke" are
 * different facts, and only the second is a reason to skip the question.
 */
const NOT_SEPARATED = 'This recording was not separated into voices, so the whole '
  + 'transcript is used. Check it reads as the patient before you accept.';
const ONE_VOICE = 'One voice in this recording.';

function transcriptNote({ diarised = false, speakers = [] } = {}) {
  if (diarised) return null;
  return speakers.length === 1 ? ONE_VOICE : NOT_SEPARATED;
}

/**
 * The draft's own label, which must never read as the record.
 *
 * This wording is doing real work. The box holds machine output sitting beside
 * a clinical note, and a pharmacist scanning the screen has to be able to tell
 * them apart without reading carefully. So the draft is always called a draft,
 * always says where it came from, and the accept control says what it will do
 * rather than "OK".
 */
const DRAFT_HEADING = 'Suggested from the recording';
const DRAFT_HELP = 'Nothing is saved until you accept it, and you can edit it first.';
const ACCEPT_LABEL = 'Use this as the Subjective';
const DISCARD_LABEL = 'Discard';
const TRANSCRIPT_HEADING = 'What was said';

/**
 * Said where the Subjective box already has something in it.
 *
 * Accepting REPLACES, and a pharmacist who has already typed three lines must
 * be told that before pressing it — not discover it afterwards with no undo.
 */
const WILL_REPLACE = 'This will replace what is already in the Subjective box.';

function acceptWarning(existing) {
  return String(existing || '').trim().length > 0 ? WILL_REPLACE : null;
}

/** Nothing is stored, said once on screen because the patient was told it. */
const NOT_STORED = 'The recording is not saved. The transcript stays on this screen only.';

/**
 * May the draft step run?
 *
 * Mirrors `readScribeDraftInput` on the server deliberately: the screen must
 * not offer a button that the server will refuse. Two voices and nobody named
 * is NOT draftable, which is the rule the whole provider choice rests on.
 */
function canDraft({ turns = [], speakers = [], patientSpeaker = null } = {}) {
  if (!turns.length) return false;
  if (speakers.length > 1) return Number.isInteger(patientSpeaker);
  return true;
}

export {
  CONSENT_SCRIPT,
  CONSENT_CONFIRM,
  CONSENT_HEADING,
  NOT_ASKED,
  consentedNote,
  SCRIBE_STEPS,
  STEP_ACTION,
  DRAFT_REFUSALS,
  DRAFT_REFUSAL_FALLBACK,
  draftRefusalNote,
  speakerLabel,
  SPEAKER_QUESTION,
  SPEAKER_HELP,
  NOT_SEPARATED,
  ONE_VOICE,
  transcriptNote,
  DRAFT_HEADING,
  DRAFT_HELP,
  ACCEPT_LABEL,
  DISCARD_LABEL,
  TRANSCRIPT_HEADING,
  WILL_REPLACE,
  acceptWarning,
  NOT_STORED,
  canDraft,
};

/* ==========================================================================
 * The SOAP write-up (owner's decision, 2026-10-10)
 * ======================================================================== */

/**
 * How a pharmacist chooses to work, offered as a real choice rather than a
 * setting buried somewhere.
 *
 * TYPING IS A FIRST-CLASS OPTION, listed beside voice and not beneath it. A
 * noisy shop, a patient who would rather not be recorded, a pharmacist who
 * simply prefers to type — none of those is a degraded path, and an interface
 * that treats voice as the real way and typing as the fallback will push
 * somebody into recording a patient who did not want to be.
 */
const START_HEADING = 'How do you want to write this up?';
const START_VOICE = 'With voice';
const START_VOICE_NOTE = 'Talk to the patient. The note writes itself.';
const START_TYPE = 'Type it';
const START_TYPE_NOTE = 'Fill the sections in yourself.';

/** The four boxes, in the order a clinician reads them. */
const SOAP_SECTIONS = Object.freeze([
  { id: 'subjective', label: 'Subjective', from: 'What the patient told you' },
  { id: 'objective', label: 'Objective', from: 'What you observed or measured' },
  { id: 'assessment', label: 'Assessment', from: 'Your impression' },
  { id: 'plan', label: 'Plan', from: 'What you decided' },
]);

/** The recording clock, as a pharmacist reads a stopwatch. */
function elapsedLabel(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const RECORDING_NOW = 'Recording';
const RECORDING_NOTE = 'Talk normally. Stop when you are done and the note will be written up.';
const STOP_AND_WRITE = 'Stop and write up';
const WRITING_UP = 'Writing up the note…';

/**
 * Why a section came back empty, said per section.
 *
 * AN EMPTY SECTION IS USUALLY CORRECT, not a failure — most consultations
 * never mention an examination finding, and a note that invented one would be
 * the whole problem. So a section that is simply empty says nothing at all,
 * and only a section that was REFUSED explains itself.
 */
const SECTION_REFUSALS = Object.freeze({
  wrong_speaker: 'Nothing was drafted here because that voice did not say anything.',
  invented_negative: 'A line was dropped because it stated something nobody said.',
  hardened_certainty: 'A line was dropped because it turned your "maybe" into a diagnosis.',
  longer_than_transcript: 'A line was dropped for being longer than what was said.',
  meta: 'The assistant answered about the recording instead of writing the note.',
});

function sectionRefusalNote(code) {
  if (!code) return null;
  return SECTION_REFUSALS[code] || 'A line was dropped because it could not be checked against what was said.';
}

/** Did anything at all come back? */
function anyDrafted(sections) {
  return SOAP_SECTIONS.some((s) => String(sections?.[s.id] || '').trim().length > 0);
}

const NOTHING_DRAFTED = 'Nothing could be written up from that recording. The transcript is below — type what matters.';
const ACCEPT_NOTE = 'Put this in the note';
const REVIEW_NOTE = 'Read it before you accept it. Nothing is saved until you do.';

export {
  START_HEADING, START_VOICE, START_VOICE_NOTE, START_TYPE, START_TYPE_NOTE,
  SOAP_SECTIONS, elapsedLabel,
  RECORDING_NOW, RECORDING_NOTE, STOP_AND_WRITE, WRITING_UP,
  SECTION_REFUSALS, sectionRefusalNote, anyDrafted,
  NOTHING_DRAFTED, ACCEPT_NOTE, REVIEW_NOTE,
};

/* ==========================================================================
 * Hearing the room (2026-10-10)
 *
 * The owner: "the recording still not picking". Diagnosed by driving the
 * whole path with a synthetic stream — MediaRecorder, the upload, multer and
 * Deepgram all worked, and a recording with no speech in it came back with
 * zero turns, which the screen then reported as the server's raw 400:
 * "There is no transcript to draft from."
 *
 * That is the wrong answer twice over. It blames the request when the truth
 * is about the ROOM, and it arrives after somebody has already talked for
 * five minutes. Both halves are fixed here: a level meter so a dead
 * microphone is obvious in the first second, and a sentence that says what
 * to check.
 * ======================================================================== */

/**
 * The live input level, as something a person can read at a glance.
 *
 * Bars rather than a number: a pharmacist glancing down mid-sentence needs
 * "it is moving" in one look, and 0.42 is not that.
 */
const LEVEL_BARS = 5;

function levelBars(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(LEVEL_BARS, Math.round(n * LEVEL_BARS)));
}

/** Said under the meter while nothing is reaching the microphone. */
const LEVEL_SILENT = 'No sound reaching the microphone yet.';
const LEVEL_OK = 'Picking you up.';

function levelNote(level, { seenSound = false } = {}) {
  if (seenSound) return LEVEL_OK;
  return levelBars(level) > 0 ? LEVEL_OK : LEVEL_SILENT;
}

/**
 * The recording caught no speech.
 *
 * NOT an error, and not a claim about the patient. The microphone may have
 * been muted, picking up the wrong device, or too far away — all of which the
 * pharmacist can check and none of which the software can tell apart. So it
 * says what to look at rather than what went wrong.
 */
const NO_SPEECH = 'No speech was picked up in that recording. Check the microphone is the right one and is not muted, then try again.';

/** Under about this long, a recording is a misclick rather than a consultation. */
const MIN_RECORDING_SECONDS = 2;
const TOO_SHORT = 'That recording was too short to write anything up. Hold the button through the consultation and stop when you are done.';

/** Which microphone is actually in use, so a wrong default is visible. */
function deviceNote(label) {
  const name = String(label || '').trim();
  return name ? `Using ${name}` : null;
}

export {
  LEVEL_BARS, levelBars, LEVEL_SILENT, LEVEL_OK, levelNote,
  NO_SPEECH, MIN_RECORDING_SECONDS, TOO_SHORT, deviceNote,
};

/* ==========================================================================
 * Choosing to type (2026-10-11)
 *
 * The owner: "when user click type option, nothing happens". It did not —
 * `mode` became 'typing' and the SAME chooser re-rendered, because the branch
 * handled 'choose' and 'typing' together. A control that changes state
 * nothing can see is a control that is broken.
 *
 * Choosing to type now does two things: the panel gets out of the way, and
 * every section opens. A pharmacist who has said they are typing should see
 * what there is to type, not a seven-of-fourteen budget they have to go
 * looking behind.
 * ======================================================================== */

/** Said where the chooser was, so the choice is visibly remembered. */
const TYPING_NOTE = 'Typing this one.';

/** The way back. The choice is never one-way. */
const BACK_TO_VOICE = 'Use voice instead';

export { TYPING_NOTE, BACK_TO_VOICE };
