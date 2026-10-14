/**
 * What the dictation microphone says, and what it says when it fails.
 *
 * PURE — no React, no fetch. Here rather than inline in the component for
 * the reason every other `*Format.js` in this repo exists: the wording is
 * the part worth testing, and a sentence shown to somebody at a counter
 * should not be reachable only by rendering a component with a microphone.
 *
 * THE RULE THESE FOLLOW. Every message says what happened AND what the
 * person can do now. "Dictation failed" is a fact about the software;
 * "Nothing came through — type it instead" is a fact they can act on. The
 * scribe learned this the expensive way: an unreachable provider came back
 * as a masked 500 that told a pharmacist nothing, least of all that the note
 * had to be typed.
 */

/** The idle label. Says what it does, not what it is. */
export const DICTATE_START = 'Speak';

/** While recording. Pressing again stops; the seconds are appended by the
 *  component because they count down live. */
export const DICTATE_STOP = 'Stop';

/** While the audio is with the provider. */
export const DICTATE_SENDING = 'Reading…';

/**
 * Why it did not work, in words that name the next move.
 *
 * Takes the server's error body (which carries `code` and `error`) or a
 * local `{ code }`. An unrecognised failure gets the general sentence rather
 * than the provider's own text: that text can quote the audio back, which
 * would put somebody's spoken words on a screen they did not expect.
 */
export function dictationError(body) {
  const code = body?.code || null;

  switch (code) {
    case 'NO_MICROPHONE':
      // Refusing the microphone is a normal answer, not a fault, and the
      // sentence should not read like an accusation.
      return 'No microphone was available. You can still type.';
    case 'NOTHING_HEARD':
      return 'Nothing came through. Try again, or type it.';
    case 'DICTATION_TOO_LONG':
    case 'DICTATION_TOO_LARGE':
      // The cap is a safety property, so the sentence says what dictation is
      // FOR rather than apologising for a limit.
      return 'Dictation is for short phrases. Type longer notes instead.';
    case 'BAD_AUDIO':
      return 'That recording could not be read. Try again, or type it.';
    case 'LLM_UNAVAILABLE':
    case 'SCRIBE_UNAVAILABLE':
      return 'Dictation is unavailable right now. Type it instead.';
    default:
      return 'Dictation did not work. Type it instead.';
  }
}

/**
 * What a dictated phrase should do to a box somebody may have typed in.
 *
 * APPEND, NEVER REPLACE. Somebody who typed "ngozi" and then spoke "refills
 * due" meant both. Replacing silently deletes what they typed, and a search
 * box is exactly where that is least expected.
 */
export function mergeDictation(existing, spoken) {
  const had = String(existing || '').trim();
  const said = String(spoken || '').trim();
  if (!said) return had;
  if (!had) return said;
  return `${had} ${said}`;
}
