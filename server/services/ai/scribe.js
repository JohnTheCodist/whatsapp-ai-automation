/**
 * The AI scribe: a recording in, a draft Subjective section out.
 *
 * SCRIBE_PLAN.md. Two steps, deliberately separate:
 *
 *   transcribe(audio)    Whisper. Audio in memory, words out, audio dropped.
 *   draftSubjective(t)   the chat model, structuring ONLY what was said.
 *
 * NOTHING HERE WRITES TO THE RECORD. This module returns a transcript and a
 * draft; the pharmacist's accept is what calls the ordinary
 * `PATCH /consultations/:id`, through the same contract their typing uses.
 * There is no path from this file to the database, which is why no test has
 * to prove one is not taken.
 *
 * EVERY DECISION ABOUT WHAT IS SAFE LIVES IN `scribeContract.js`, which is
 * pure. This file is the plumbing: a key, a network call, a timeout. Keeping
 * them apart is what lets the safety rules be tested without either.
 */

const { env } = require('../../config/env');
const { chat, LlmUnavailable } = require('./llmClient');
const {
  SYSTEM_PROMPT, readTranscript, readDraft, withinTranscript,
  readDeepgram, patientText,
} = require('./scribeContract');

/**
 * Is transcription configured at all?
 *
 * ITS OWN KEY, not the chat provider's. This was wrong in the first version:
 * it derived the audio endpoint from `LLM_API_URL`, and this deployment's
 * chat model is DeepSeek — which has no audio endpoint. That would have POSTed
 * a patient's recording to a path that does not exist on a provider that never
 * offered the service.
 *
 * Unconfigured is a supported state, not an error: the scribe does not appear
 * and the Subjective box is typed, exactly as before this feature existed.
 */
function isTranscriptionConfigured() {
  return Boolean(env.transcription.apiKey && env.transcription.apiUrl);
}

const transcriptionUrl = () => env.transcription.apiUrl || null;

/**
 * Deepgram accepts far more than this; the cap is ours.
 *
 * A consultation is minutes, not hours. A 25 MB body arriving at this route
 * is a bug or a misuse, and failing at the door beats paying to transcribe
 * it and then discovering that.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Audio in, SPEAKER-SEPARATED turns out. THE AUDIO IS NEVER WRITTEN DOWN.
 *
 * It arrives in memory (`multer.memoryStorage()`, the pattern the catalogue
 * upload already uses), goes straight to the provider, and the buffer is the
 * caller’s to drop. Nothing in this product’s schema can hold a recording,
 * which is how "we do not keep it" stays true without anybody maintaining it.
 *
 * DEEPGRAM, NOT WHISPER, AND THE REASON IS DIARIZATION. The scribe is
 * ambient: it hears a pharmacist and a patient. Subjective is specifically
 * what the PATIENT said. Whisper returns one undivided run of text, so a
 * model writing the Subjective from it has to GUESS which half of the
 * conversation to write down — and that guess lands in a clinical record as
 * "the patient reported". Deepgram returns utterances tagged by speaker, so
 * the guess is replaced by a fact.
 *
 * It still does not know WHICH speaker is the patient — it knows there are
 * two. That is one question for the pharmacist, answered in one tap, and it
 * is a far better question than asking a model to infer it.
 */
async function transcribe(buffer, { mimetype = 'audio/webm' } = {}) {
  if (!isTranscriptionConfigured()) {
    throw new LlmUnavailable('No transcription key is configured (TRANSCRIPTION_API_KEY).');
  }
  if (!buffer || !buffer.length) {
    const err = new Error('No audio was received.');
    err.status = 400; err.code = 'NO_AUDIO';
    throw err;
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    const err = new Error('That recording is too long to transcribe.');
    err.status = 413; err.code = 'AUDIO_TOO_LARGE';
    throw err;
  }

  const url = new URL(transcriptionUrl());
  url.searchParams.set('model', env.transcription.model);
  // The whole reason this provider was chosen.
  url.searchParams.set('diarize', 'true');
  url.searchParams.set('utterances', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  // Naming the language stops a model guessing one from an accent and
  // transcribing a Nigerian English consultation into something else.
  url.searchParams.set('language', 'en');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.transcription.timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // Deepgram uses `Token`, NOT `Bearer`. Sending Bearer here is a 401
        // that looks like a bad key.
        Authorization: `Token ${env.transcription.apiKey}`,
        'Content-Type': mimetype,
      },
      body: buffer,
      signal: controller.signal,
    });
  } catch (e) {
    throw new LlmUnavailable(`Transcription did not complete: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The provider’s own message is NOT passed through: it can quote the
    // audio back, and that would put a patient’s words into a log.
    throw new LlmUnavailable(`Transcription failed (${res.status}).`);
  }

  const body = await res.json().catch(() => null);
  if (!body) throw new LlmUnavailable('Transcription returned something unreadable.');
  return readDeepgram(body);
}
/**
 * The patient’s words in, a draft Subjective section out — or nothing.
 *
 * Takes the PARSED transcript and which speaker the pharmacist identified as
 * the patient. Only that speaker’s turns reach the model: Subjective is what
 * the patient reported, and the provider was chosen so this could be a
 * filter rather than a guess.
 *
 * Returning nothing is a SUCCESS, not a failure: a recording that caught
 * little should produce little, and the screen says so rather than showing a
 * paragraph about a consultation nobody heard.
 *
 * The model is checked, not trusted. `readDraft` refuses an answer about the
 * request and refuses a negative finding nobody established;
 * `withinTranscript` refuses a draft longer than what was said.
 */
async function draftSubjective(parsed, patientSpeaker = null) {
  // Accept a bare string too, so the function is usable on an undiarised
  // transcript and in tests without building a provider payload.
  const source = typeof parsed === 'string'
    ? parsed
    : (Number.isInteger(patientSpeaker)
      ? patientText(parsed, patientSpeaker)
      : (parsed?.text || ''));

  const transcript = readTranscript(source);
  if (!transcript.usable) {
    return { draft: '', transcript: transcript.text, refused: transcript.reason };
  }

  const reply = await chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcript.text },
    ],
    // Low, because this is extraction. Creativity here is the bug.
    temperature: 0,
    // RAISED FROM 400, measured against the live model on a realistic
    // consultation. This deployment's chat model spends tokens REASONING
    // before it answers, and those count against the budget while never
    // appearing in `content` — so 400 produced `finishReason: 'length'` with
    // an EMPTY string, every time, on a 689-character patient transcript.
    //
    // A Subjective section is a paragraph. The headroom is for the thinking,
    // not for the answer, which is why it is this much larger than the output
    // it needs to hold.
    maxTokens: 1200,
  });

  const content = reply?.choices?.[0]?.message?.content ?? reply?.content ?? '';

  // CUT OFF IS NOT THE SAME AS NOTHING TO SAY, and conflating them is how a
  // pharmacist gets told a lie about their own consultation.
  //
  // An empty answer is a legitimate result — a recording that caught little
  // should produce little. But an answer that hit the token ceiling was
  // INTERRUPTED, and reporting it as "the recording caught too little" is a
  // statement about the patient that the software invented. Worse, a
  // truncated non-empty answer is half a clinical sentence.
  //
  // Found by driving the real provider. With `maxTokens: 400` this fired on
  // every realistic transcript and the screen said the recording was empty.
  if (reply?.finishReason === 'length') {
    return { draft: '', transcript: transcript.text, refused: 'truncated' };
  }
  // The PATIENT’S OWN WORDS are passed in, which is what lets the absence
  // rule distinguish a quotation from a fabrication. Without them it refuses
  // every negative, which is correct but useless — a patient answering "any
  // fever?" with "no" is the normal case, not an edge one.
  const checked = readDraft(content, { source: transcript.text });
  if (!checked.ok) {
    return { draft: '', transcript: transcript.text, refused: checked.refused };
  }
  if (!withinTranscript(checked.draft, transcript.text)) {
    // Longer than what was said: material has been added, and the only place
    // it can have come from is the model.
    return { draft: '', transcript: transcript.text, refused: 'longer_than_transcript' };
  }

  return { draft: checked.draft, transcript: transcript.text, refused: null };
}

/**
 * Transcribe a recording and return the turns, WITHOUT drafting anything.
 *
 * This is the first half of the flow and it stops here deliberately. The
 * screen shows the speaker-separated turns and asks the one question a model
 * must not answer: WHICH VOICE IS THE PATIENT. Only then is there anything
 * worth drafting from.
 *
 * A recording Deepgram could not separate comes back `diarised: false` with
 * one unlabelled turn, and the screen says so rather than guessing.
 */
async function listen(buffer, meta) {
  return transcribe(buffer, meta);
}

/**
 * The whole job, once the patient’s voice is known.
 *
 * The transcript comes back EVEN WHEN THE DRAFT DOES NOT. A pharmacist with
 * the raw words still has most of what they wanted: they can read, edit and
 * keep. Losing the transcript because the structuring step failed would
 * throw away the expensive part over the cheap one.
 */
async function scribe(parsed, patientSpeaker = null) {
  try {
    return await draftSubjective(parsed, patientSpeaker);
  } catch (e) {
    if (e instanceof LlmUnavailable) {
      const text = typeof parsed === 'string' ? parsed : (parsed?.text || '');
      return { draft: '', transcript: text, refused: 'model_unavailable' };
    }
    throw e;
  }
}
module.exports = {
  transcribe, listen, draftSubjective, scribe,
  isTranscriptionConfigured, transcriptionUrl, MAX_AUDIO_BYTES,
};
