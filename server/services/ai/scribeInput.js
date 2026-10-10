/**
 * The request contract for the AI scribe's drafting step.
 *
 * SCRIBE_PLAN.md. PURE — no network, no key, no database — like
 * `consultationInput`, `followupInput` and `messageInput`, and for the reason
 * this repository keeps relearning: a form sends strings, and a service tested
 * only against well-shaped objects passes every test while every real
 * submission fails. `refillInput`'s 11 tests exist because of exactly that.
 *
 * WHY THE CLIENT SENDS THE TURNS BACK, which looks wrong and is deliberate.
 *
 * The obvious design is to keep the transcript on the server between the two
 * requests, hand the browser an id, and draft from the stored copy. That is a
 * stored transcript of a patient consultation — the precise thing 0071 says
 * this feature does not keep. A row with a short lifetime is still a row, and
 * the one that fails to be deleted is the one that matters.
 *
 * So the transcript lives in the browser tab for as long as the pharmacist is
 * looking at it, and comes back here to be drafted from. The trade is honest
 * and worth stating: an authenticated member of staff can post text that never
 * came from a recording and have the model structure it. That costs this
 * pharmacy a few tokens and produces a draft only they can see, in a box they
 * could have typed into anyway. It is a smaller price than a table of
 * recordings of real patients.
 */

/**
 * What the screen says when the gate refuses.
 *
 * Each reason gets its own sentence, because the three have three different
 * answers and "cannot record" tells a pharmacist which of them to do: none.
 */
const SCRIBE_REFUSALS = Object.freeze({
  no_consent: 'Ask the patient first, then confirm they agreed to be recorded.',
  finalised: 'This consultation is finalised, so there is nothing left to transcribe.',
  not_found: 'Consultation not found.',
});

/**
 * Caps. A consultation is minutes of two people talking.
 *
 * These are not security boundaries — the request is already authenticated and
 * tenant-scoped. They stop one mistyped loop in a browser turning into a
 * 40,000-token model call against the pharmacy's own account.
 */
const MAX_TURNS = 2000;
const MAX_TRANSCRIPT_CHARS = 60000;

function bad(message, field, code = 'INVALID_INPUT') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  // Every form here reads `body.field` to highlight the box that is wrong.
  // Omitting it is the bug `errorHandler.test.js` was written for.
  err.field = field;
  return err;
}

/**
 * Read one turn.
 *
 * A speaker that is not an integer stays NULL rather than becoming 0. Speaker
 * 0 is a real person in Deepgram's answer, and coercing "I do not know who
 * said this" into "the first voice" is how half a conversation gets attributed
 * at random — which is the failure `readDeepgram` already refuses to make, so
 * it must not be reintroduced on the way back in.
 */
function readTurn(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('That is not a transcript.', 'turns');
  }
  const text = String(raw.text == null ? '' : raw.text).trim();
  const speaker = Number.isInteger(raw.speaker) ? raw.speaker : null;
  if (speaker !== null && (speaker < 0 || speaker > 50)) {
    throw bad(`Turn ${index + 1} names a voice that cannot exist.`, 'turns');
  }
  return { speaker, text };
}

/**
 * The drafting request: a transcript, and which voice in it is the patient.
 *
 * Returns the same shape `readDeepgram` produces, so `draftNote()` cannot tell
 * whether it was handed a provider's answer or a round trip through a browser
 * — one code path, tested once.
 */
function readScribeDraftInput(body = {}) {
  const b = body && typeof body === 'object' ? body : {};

  if (!Array.isArray(b.turns)) throw bad('There is no transcript to draft from.', 'turns');
  if (b.turns.length === 0) throw bad('There is no transcript to draft from.', 'turns');
  if (b.turns.length > MAX_TURNS) throw bad('That transcript is too long.', 'turns');

  const turns = b.turns
    .map(readTurn)
    .filter((t) => t.text.length > 0);

  // Turns that are all blank is NOT "the recording caught nothing".
  //
  // Found by the test for this function. Without this, an array of empty
  // turns passed the length check above, filtered down to nothing, and
  // reached `readTranscript`, which refused it as `too_short` — so the screen
  // told the pharmacist the recording had caught nothing.
  //
  // That sentence is a statement about the PATIENT'S CONSULTATION, and here
  // it would be false: the listen step only offers a draft once it has turns
  // with words in them, so an empty one is a broken request. Same rule as the
  // absent-speaker refusal below — say the request is wrong rather than
  // inventing a quiet consultation.
  if (turns.length === 0) throw bad('There is no transcript to draft from.', 'turns');

  const text = turns.map((t) => t.text).join(' ').trim();
  if (text.length > MAX_TRANSCRIPT_CHARS) throw bad('That transcript is too long.', 'turns');

  const speakers = [...new Set(turns.map((t) => t.speaker).filter((n) => n !== null))]
    .sort((a, b2) => a - b2);

  // `patientSpeaker` may legitimately be absent: an undiarised recording has
  // no voice to name, and the draft is then made from the whole transcript —
  // which is honest, because there is only one voice in it to be wrong about.
  let patientSpeaker = null;
  if (b.patientSpeaker !== null && b.patientSpeaker !== undefined && b.patientSpeaker !== '') {
    // A <select> sends "1". Rejecting that would be a contract that every
    // real form fails while every test passes.
    const n = typeof b.patientSpeaker === 'string' && /^\d+$/.test(b.patientSpeaker.trim())
      ? Number(b.patientSpeaker.trim())
      : b.patientSpeaker;
    if (!Number.isInteger(n)) throw bad('Say which voice is the patient.', 'patientSpeaker');

    // Naming a voice the transcript does not contain yields NO patient text,
    // so the model would be handed an empty string and the pharmacist would
    // be told the recording caught nothing. That is a confusing lie about the
    // recording; the truth is that the request is wrong.
    if (!speakers.includes(n)) {
      throw bad('That voice is not in this recording.', 'patientSpeaker');
    }
    patientSpeaker = n;
  } else if (speakers.length > 1) {
    // Two or more voices and nobody named: refuse rather than draft from
    // both. Drafting the whole conversation as the Subjective would record
    // the pharmacist's own questions and advice as the patient's report,
    // which is the single failure this provider was chosen to prevent.
    throw bad('Say which voice is the patient.', 'patientSpeaker');
  }

  // WHO THE OTHER VOICE IS, derived rather than asked for.
  //
  // With exactly two voices and one of them named as the patient, the other
  // is the pharmacist — so the screen asks ONE question instead of two. With
  // three or more voices (a relative in the shop, a colleague passing) it
  // stays null: guessing which of two unnamed voices is the pharmacist would
  // put a stranger’s words into a clinical assessment.
  let pharmacistSpeaker = null;
  if (Number.isInteger(patientSpeaker) && speakers.length === 2) {
    pharmacistSpeaker = speakers.find((n) => n !== patientSpeaker);
    if (!Number.isInteger(pharmacistSpeaker)) pharmacistSpeaker = null;
  }

  return {
    pharmacistSpeaker,
    parsed: {
      turns,
      speakers,
      diarised: speakers.length > 1,
      text,
    },
    patientSpeaker,
  };
}

module.exports = {
  SCRIBE_REFUSALS,
  MAX_TURNS,
  MAX_TRANSCRIPT_CHARS,
  readScribeDraftInput,
};
