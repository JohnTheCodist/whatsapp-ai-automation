/**
 * The AI scribe, in the Subjective section.
 *
 * SCRIBE_PLAN.md. A pharmacist records the consultation, the recording is
 * transcribed with the voices separated, THEY say which voice is the patient,
 * and the assistant drafts the Subjective from that voice alone.
 *
 * FOUR THINGS THIS COMPONENT WILL NOT DO, and each is a decision rather than
 * an omission:
 *
 *   1. It never opens the microphone before consent is on the server. The
 *      button does not exist until then — not disabled, absent, because a
 *      greyed-out record button invites a pharmacist to find the way round it.
 *   2. It never saves. The draft goes into the parent's Subjective field
 *      through the ordinary `set`, so the note has exactly one writer and a
 *      draft nobody accepted leaves no trace.
 *   3. It never keeps the audio. The Blob is handed to `fetch` and dropped;
 *      the MediaRecorder's chunks are released when the component unmounts.
 *   4. It never guesses which voice is the patient. With two voices and no
 *      answer there is no draft button at all.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONSENT_SCRIPT, CONSENT_CONFIRM, CONSENT_HEADING, NOT_ASKED, consentedNote,
  STEP_ACTION, draftRefusalNote, speakerLabel, SPEAKER_QUESTION, SPEAKER_HELP,
  transcriptNote, DRAFT_HEADING, DRAFT_HELP, ACCEPT_LABEL, DISCARD_LABEL,
  TRANSCRIPT_HEADING, acceptWarning, NOT_STORED, canDraft,
} from './scribeFormat.js';

/**
 * Is a microphone reachable at all?
 *
 * `getUserMedia` is absent on an insecure origin and on an older browser, and
 * a record button that throws when pressed is worse than no record button.
 * Checked once, because the answer cannot change while the screen is open.
 */
function micAvailable() {
  return Boolean(
    typeof navigator !== 'undefined'
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof window !== 'undefined'
    && typeof window.MediaRecorder === 'function',
  );
}

export default function ConsultationScribe({
  customerId, consultationId, note, available, existing, onAccept, whenLabel,
}) {
  const [consenting, setConsenting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const [turns, setTurns] = useState(null);
  const [speakers, setSpeakers] = useState([]);
  const [diarised, setDiarised] = useState(false);
  const [patientSpeaker, setPatientSpeaker] = useState(null);

  const [draft, setDraft] = useState(null);
  const [refused, setRefused] = useState(null);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  const consentAt = note?.scribeConsentAt || null;

  /** Let go of the microphone. Called on stop AND on unmount. */
  const release = useCallback(() => {
    try { recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* already gone */ }
    try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* already gone */ }
    recorderRef.current = null;
    streamRef.current = null;
    // The recorded chunks are the audio. Dropping the reference is what makes
    // "we do not keep it" true on this side of the wire.
    chunksRef.current = [];
  }, []);

  // Leaving the screen must not leave the microphone on, and must not leave a
  // recording in memory.
  useEffect(() => release, [release]);

  if (!available) return null;

  const base = `/api/customers/${customerId}/consultations/${consultationId}`;

  async function readReply(res) {
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (body === null) {
      throw new Error('The pharmacy server is not responding. Nothing has been recorded.');
    }
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    return body;
  }

  async function confirmConsent() {
    setConsenting(true);
    setError(null);
    try {
      const updated = await readReply(await fetch(`${base}/scribe/consent`, { method: 'POST' }));
      onAccept?.({ consented: updated });
    } catch (e) {
      setError(e.message);
    } finally {
      setConsenting(false);
    }
  }

  async function start() {
    setError(null);
    setDraft(null);
    setRefused(null);
    setTurns(null);
    setPatientSpeaker(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new window.MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // Refusing the microphone is a normal answer, not a fault. Say what it
      // means for the work rather than reporting a browser error.
      setError('This browser did not give access to the microphone. You can still type the note.');
      release();
    }
  }

  async function stop() {
    const rec = recorderRef.current;
    if (!rec) return;
    setRecording(false);
    setWorking(true);
    setError(null);

    const audio = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }));
      try { rec.stop(); } catch { resolve(null); }
    });
    release();

    if (!audio || !audio.size) {
      setWorking(false);
      setError('That recording was empty. Nothing was sent.');
      return;
    }

    try {
      const form = new FormData();
      form.append('audio', audio, 'consultation.webm');
      const heard = await readReply(await fetch(`${base}/scribe`, { method: 'POST', body: form }));
      setTurns(heard.turns || []);
      setSpeakers(heard.speakers || []);
      setDiarised(Boolean(heard.diarised));
      // No default. With two voices the pharmacist answers; with one or none
      // there is nothing to answer and the whole transcript is used.
      setPatientSpeaker(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }

  async function makeDraft() {
    setWorking(true);
    setError(null);
    try {
      const got = await readReply(await fetch(`${base}/scribe/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turns, patientSpeaker }),
      }));
      setDraft(got.draft || '');
      setRefused(got.refused || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }

  function accept() {
    onAccept?.({ subjective: draft });
    setDraft(null);
    setTurns(null);
    setRefused(null);
  }

  function discard() {
    setDraft(null);
    setRefused(null);
    setTurns(null);
    setPatientSpeaker(null);
  }

  /* ---- consent ---------------------------------------------------------- */
  if (!consentAt) {
    return (
      <div className="ui-scribe" data-step="consent">
        <p className="ui-cprog-quiet">{CONSENT_HEADING}</p>
        {/* The script, marked as something to say rather than something to
            read. A pharmacist should be able to glance at it and speak. */}
        <blockquote className="ui-scribe-script">{CONSENT_SCRIPT}</blockquote>
        <p className="ui-allergy-help">{NOT_ASKED}</p>
        <button type="button" className="ui-psection-link" disabled={consenting} onClick={confirmConsent}>
          {CONSENT_CONFIRM}
        </button>
        {error && <p className="ui-allergy-failed">{error}</p>}
      </div>
    );
  }

  /* ---- a microphone this browser cannot open ---------------------------- */
  if (!micAvailable()) {
    return (
      <div className="ui-scribe" data-step="unavailable">
        <p className="ui-allergy-help">
          This browser cannot record. You can still type the note.
        </p>
      </div>
    );
  }

  const step = working ? 'working' : (recording ? 'recording' : (turns ? 'turns' : 'ready'));
  const replaces = acceptWarning(existing);
  const note2 = transcriptNote({ diarised, speakers });

  return (
    <div className="ui-scribe" data-step={draft !== null ? 'drafted' : step}>
      <p className="ui-cprog-quiet">{consentedNote(consentAt, whenLabel)}</p>

      {!turns && draft === null && (
        <>
          <button
            type="button"
            className={recording ? 'ui-psection-link ui-scribe-live' : 'ui-psection-link'}
            disabled={working}
            onClick={recording ? stop : start}
          >
            {recording ? STEP_ACTION.recording : (working ? STEP_ACTION.working : STEP_ACTION.ready)}
          </button>
          <p className="ui-allergy-help">{NOT_STORED}</p>
        </>
      )}

      {/* ---- the transcript, and the one question --------------------- */}
      {turns && draft === null && (
        <div className="ui-scribe-heard">
          <p className="ui-cprog-quiet">{TRANSCRIPT_HEADING}</p>
          {note2 && <p className="ui-allergy-help">{note2}</p>}
          <ol className="ui-scribe-turns">
            {turns.map((t, i) => (
              <li key={i} data-speaker={t.speaker === null ? 'unknown' : t.speaker}>
                <span className="ui-cprog-quiet">{speakerLabel(t.speaker)}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ol>

          {speakers.length > 1 && (
            <fieldset className="ui-scribe-who">
              <legend>{SPEAKER_QUESTION}</legend>
              <p className="ui-allergy-help">{SPEAKER_HELP}</p>
              {speakers.map((s) => (
                <label key={s}>
                  <input
                    type="radio"
                    name="patient-voice"
                    checked={patientSpeaker === s}
                    onChange={() => setPatientSpeaker(s)}
                  />
                  <span>{speakerLabel(s)}</span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="ui-scribe-actions">
            <button
              type="button"
              className="ui-psection-link"
              disabled={working || !canDraft({ turns, speakers, patientSpeaker })}
              onClick={makeDraft}
            >
              {working ? 'Drafting…' : 'Draft the Subjective'}
            </button>
            <button type="button" className="ui-psection-link" onClick={discard}>
              {DISCARD_LABEL}
            </button>
          </div>
        </div>
      )}

      {/* ---- the draft, BESIDE what was said -------------------------- */}
      {draft !== null && (
        <div className="ui-scribe-draft">
          {refused && <p className="ui-allergy-help">{draftRefusalNote(refused)}</p>}

          {draft !== '' && (
            <>
              <p className="ui-cprog-quiet">{DRAFT_HEADING}</p>
              <textarea
                rows={5}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={DRAFT_HEADING}
              />
              <p className="ui-allergy-help">{DRAFT_HELP}</p>
              {replaces && <p className="ui-allergy-help">{replaces}</p>}
            </>
          )}

          <details className="ui-scribe-raw">
            <summary>{TRANSCRIPT_HEADING}</summary>
            <ol className="ui-scribe-turns">
              {(turns || []).map((t, i) => (
                <li key={i} data-speaker={t.speaker === null ? 'unknown' : t.speaker}>
                  <span className="ui-cprog-quiet">{speakerLabel(t.speaker)}</span>
                  <span>{t.text}</span>
                </li>
              ))}
            </ol>
          </details>

          <div className="ui-scribe-actions">
            {draft !== '' && (
              <button type="button" className="ui-psection-link" onClick={accept}>
                {ACCEPT_LABEL}
              </button>
            )}
            <button type="button" className="ui-psection-link" onClick={discard}>
              {DISCARD_LABEL}
            </button>
          </div>
        </div>
      )}

      {error && <p className="ui-allergy-failed">{error}</p>}
    </div>
  );
}
