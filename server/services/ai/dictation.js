/**
 * Dictation — a pharmacist speaking their OWN words into a search box.
 *
 * WHAT THIS IS NOT. It is not the scribe. The scribe is ambient: it hears a
 * pharmacist and a patient, needs consent recorded against a consultation
 * (0071), and produces clinical prose. This produces a search query.
 *
 * SEPARATE FROM scribe.js ON PURPOSE, duplicated fetch and all. The scribe
 * hard-codes `diarize=true` because its whole correctness rests on knowing
 * which voice was the patient. Parameterising that to serve this feature
 * would turn a safety guarantee into an argument, and arguments get passed
 * wrongly. Thirty-five lines of duplication is the cheaper risk.
 *
 * THREE THINGS MAKE THIS UNUSABLE AS A WAY TO RECORD A PATIENT, and none of
 * them is a policy anybody has to remember:
 *
 * 1. A HARD DURATION CAP, checked against the provider's own measurement of
 *    the audio rather than its byte count. A consultation cannot be captured
 *    through a thirty-second door. Bytes alone would not do it — a low
 *    bitrate turns ten minutes into a small file — so the text is DISCARDED
 *    when the measured audio is too long, after transcription, unread.
 * 2. NO DIARIZATION IS REQUESTED. The provider is never asked to separate
 *    speakers, so nothing here can produce "what the patient said" as
 *    distinct from anything else. There is no shape for it to come back in.
 * 3. NOTHING IS STORED. No audio, no transcript, no row, no event. The text
 *    goes back to the box the pharmacist is typing in, where they can see it
 *    and change it before it does anything.
 *
 * The result reaches a SEARCH FIELD. It is not a clinical record, it is not
 * attributed to anybody, and it writes nothing.
 */

const { env } = require('../../config/env');
const { LlmUnavailable } = require('./llmClient');
const { isTranscriptionConfigured, transcriptionUrl } = require('./scribe');

/**
 * The cap, in seconds of audio.
 *
 * Thirty is generous for "show me Ngozi Okafor's refills" and far short of
 * anything resembling a consultation. It is the number that makes the
 * promise structural: this endpoint cannot capture one, whatever anybody
 * points the microphone at.
 */
const MAX_DICTATION_SECONDS = 30;

/**
 * A cheap pre-flight guard so an obviously oversized body is refused before
 * it is sent anywhere. NOT the real limit — see MAX_DICTATION_SECONDS, which
 * is what actually holds. 2MB is roughly a minute of ordinary browser opus,
 * so this rejects the absurd and lets the duration check do the real work.
 */
const MAX_DICTATION_BYTES = 2 * 1024 * 1024;

/** How long the provider says the audio actually was, or null. */
function measuredSeconds(body) {
  const d = body?.metadata?.duration;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null;
}

/**
 * One person's speech, as text.
 *
 * @returns {Promise<{text: string, seconds: number|null}>}
 */
async function dictate(buffer, { mimetype = 'audio/webm' } = {}) {
  if (!isTranscriptionConfigured()) {
    throw new LlmUnavailable('No transcription key is configured (TRANSCRIPTION_API_KEY).');
  }
  if (!buffer || !buffer.length) {
    const err = new Error('No audio was received.');
    err.status = 400; err.code = 'NO_AUDIO';
    throw err;
  }
  if (buffer.length > MAX_DICTATION_BYTES) {
    const err = new Error('That is longer than dictation accepts. Type it instead.');
    err.status = 413; err.code = 'DICTATION_TOO_LARGE';
    throw err;
  }

  const url = new URL(transcriptionUrl());
  url.searchParams.set('model', env.transcription.model);
  // NO diarize, NO utterances. One speaker is the premise of this feature,
  // and not asking means there is no shape in which "the other voice" could
  // come back. See the header.
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  // Named rather than guessed, for the same reason the scribe names it: a
  // Nigerian English accent should not be transcribed into another language.
  url.searchParams.set('language', 'en');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.transcription.timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // `Token`, not `Bearer` — Bearer is a 401 that looks like a bad key.
        Authorization: `Token ${env.transcription.apiKey}`,
        'Content-Type': mimetype,
      },
      body: buffer,
      signal: controller.signal,
    });
  } catch (e) {
    throw new LlmUnavailable(`Dictation did not complete: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The provider's own message is not passed through: it can quote the
    // audio back, and that would put spoken words into a log.
    throw new LlmUnavailable(`Dictation failed (${res.status}).`);
  }

  const body = await res.json().catch(() => null);
  if (!body) throw new LlmUnavailable('Dictation returned something unreadable.');

  /* THE CAP, CHECKED AGAINST THE AUDIO AND NOT THE FILE.

     The text exists at this point and is deliberately dropped on the floor
     rather than returned. A recording longer than the cap is not a dictated
     query whatever it contains, and the one thing this endpoint must never
     become is a way to transcribe a consultation.

     An unmeasurable duration is refused too — GOLDEN-002c's rule, that "we
     could not tell" is never "it is safe". */
  const seconds = measuredSeconds(body);
  if (seconds === null || seconds > MAX_DICTATION_SECONDS) {
    const err = new Error(
      seconds === null
        ? 'That recording could not be measured, so it was not used.'
        : `Dictation is for short phrases — that was ${Math.round(seconds)} seconds.`,
    );
    err.status = 413; err.code = 'DICTATION_TOO_LONG';
    err.expose = true;
    throw err;
  }

  const text = String(
    body?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '',
  ).trim();

  return { text, seconds };
}

module.exports = { dictate, MAX_DICTATION_SECONDS, MAX_DICTATION_BYTES };
