/**
 * Speak instead of typing — the pharmacist's own words, into the box beside
 * this button.
 *
 * NOT THE SCRIBE, and the distance is deliberate. The scribe records a
 * consultation: two voices, a patient, consent recorded against a note
 * (0071), and clinical prose out. This fills a search field with what one
 * person said, and that person is the one who pressed the button.
 *
 * WHY THERE IS NO CONSENT STEP HERE. Consent exists because somebody else is
 * being recorded. There is no second party: you press, you speak, your words
 * appear in a box you can see and edit before anything happens.
 *
 * WHAT STOPS IT BECOMING THE OTHER THING is not a rule anybody follows. The
 * server caps dictation at MAX seconds, measured against the provider's own
 * reading of the audio rather than the file size, and never asks for speaker
 * separation — so a consultation cannot come back through it in a form that
 * distinguishes a patient from anyone. This component stops the recording
 * itself at the same cap, so nobody discovers that limit by losing a
 * sentence to it.
 *
 * STATES, all four visible rather than inferred: idle, recording (with the
 * seconds counting down), sending, and whatever went wrong. A microphone
 * that silently does nothing is the thing people press twice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { bestMimeType, AUDIO_CONSTRAINTS, canRecordAudio } from './audioCapture.js';
import { DICTATE_START, DICTATE_STOP, DICTATE_SENDING, dictationError } from './dictation.js';

export default function DictateButton({ onText, disabled = false }) {
  const [mode, setMode] = useState('idle');
  const [left, setLeft] = useState(null);
  const [error, setError] = useState(null);
  const [cap, setCap] = useState(null);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const tickRef = useRef(null);
  const stoppedRef = useRef(false);

  /** Let go of the microphone. The browser keeps the tab's recording
   *  indicator lit until every track is stopped, and a pharmacy laptop
   *  showing a live microphone all afternoon is its own problem. */
  const release = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try { recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* gone */ }
    try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* gone */ }
    recorderRef.current = null;
    streamRef.current = null;
  }, []);

  // Released on unmount too: navigating away mid-recording must not leave the
  // microphone open.
  useEffect(() => release, [release]);

  /* Whether the control should exist at all. A microphone that cannot work is
     worse than none — somebody speaks a whole sentence before finding out. */
  useEffect(() => {
    let dead = false;
    fetch('/api/dictate/capabilities')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!dead) setCap(j || { available: false }); })
      .catch(() => { if (!dead) setCap({ available: false }); });
    return () => { dead = true; };
  }, []);

  const send = useCallback(async (blob) => {
    setMode('sending');
    try {
      const form = new FormData();
      form.append('audio', blob, 'dictation.webm');
      const res = await fetch('/api/dictate', { method: 'POST', body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error(body?.error || ''), { body });

      const text = String(body?.text || '').trim();
      if (!text) {
        // Caught nothing is not an error. Say what happened and leave the box
        // alone rather than clearing what was already typed.
        setError(dictationError({ code: 'NOTHING_HEARD' }));
        setMode('idle');
        return;
      }
      onText?.(text);
      setMode('idle');
    } catch (e) {
      setError(dictationError(e?.body || { message: e?.message }));
      setMode('idle');
    }
  }, [onText]);

  const stop = useCallback(() => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try { recorderRef.current?.stop(); } catch { release(); setMode('idle'); }
  }, [release]);

  const start = useCallback(async () => {
    setError(null);
    const seconds = cap?.maxSeconds || 30;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
      streamRef.current = stream;
      const mimeType = bestMimeType();
      const rec = mimeType
        ? new window.MediaRecorder(stream, { mimeType })
        : new window.MediaRecorder(stream);

      chunksRef.current = [];
      stoppedRef.current = false;
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        release();
        setLeft(null);
        if (blob.size) send(blob); else setMode('idle');
      };
      recorderRef.current = rec;
      rec.start();
      setMode('recording');
      setLeft(seconds);

      /* THE CLIENT STOPS AT THE SERVER'S CAP. Without this the server refuses
         at the limit and whoever was speaking loses the sentence — the limit
         is a safety property, and discovering it by losing work makes people
         work around it. */
      tickRef.current = setInterval(() => {
        setLeft((n) => {
          if (n === null) return null;
          if (n <= 1) { stop(); return 0; }
          return n - 1;
        });
      }, 1000);
    } catch {
      // Refusing the microphone is a normal answer, not a fault.
      setError(dictationError({ code: 'NO_MICROPHONE' }));
      release();
      setMode('idle');
    }
  }, [cap, release, send, stop]);

  // The server says transcription is off, or this browser cannot record.
  if (cap && !cap.available) return null;
  if (!canRecordAudio()) return null;

  const busy = mode === 'sending';

  return (
    <>
      <button
        type="button"
        onClick={mode === 'recording' ? stop : start}
        disabled={disabled || busy}
        aria-pressed={mode === 'recording'}
        className={`ui-home-tool${mode === 'recording' ? ' is-recording' : ''}`}
      >
        <span aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" />
            <path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2" />
          </svg>
        </span>
        {busy ? DICTATE_SENDING : mode === 'recording' ? `${DICTATE_STOP} ${left ?? ''}s` : DICTATE_START}
      </button>
      {error && <span className="ui-home-toolnote">{error}</span>}
    </>
  );
}
