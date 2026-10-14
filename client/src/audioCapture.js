/**
 * What to ask a browser for when recording speech.
 *
 * MOVED HERE UNCHANGED from ConsultationScribe.jsx when dictation became a
 * second caller. Both the consultation scribe and the dictation microphone
 * record a person talking in a pharmacy, over the same connections, into the
 * same provider — so the codec order and the microphone constraints below
 * are one decision, not two. Each carries a measured reason, and a second
 * copy is a second thing to get wrong.
 *
 * Nothing in this module records anything or asks for permission. It only
 * says what to ask for.
 */

/**
 * In order of preference.
 *
 * Safari does not support webm at all — its container is mp4, and an
 * unsupported type throws rather than falling back. Opus first because it is
 * a fraction of the size for speech, which matters on a Nigerian pharmacy's
 * connection.
 */
export const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
];

/** The best type this browser will actually record, or '' to let it choose. */
export function bestMimeType() {
  const MR = typeof window !== 'undefined' ? window.MediaRecorder : null;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return PREFERRED_TYPES.find((t) => MR.isTypeSupported(t)) || '';
}

/**
 * What to ask the microphone for.
 *
 * `{ audio: true }` takes the browser's defaults, which assume a quiet room.
 * A pharmacy counter is not one: there is a fan, a till, a queue and a
 * radio. These three are the difference between a usable recording and one
 * the provider returns nothing from.
 *
 * `autoGainControl` matters most of the three — somebody leaning away from
 * the phone is the common case, and without it they simply drop out.
 */
export const AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

/** Whether this browser can record at all. */
export function canRecordAudio() {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder === 'function'
    && Boolean(navigator?.mediaDevices?.getUserMedia);
}
