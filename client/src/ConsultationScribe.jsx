/**
 * The AI scribe: a pharmacist talks to the patient, and the note writes
 * itself into SOAP.
 *
 * SCRIBE_PLAN.md. The consultation is recorded, Deepgram separates the
 * voices, the pharmacist says which voice is the patient, and each section is
 * drafted from the voice that owns it:
 *
 *     the patient's voice     -> Subjective
 *     the pharmacist's voice  -> Objective, Assessment, Plan
 *
 * FOUR THINGS THIS COMPONENT WILL NOT DO, each a decision rather than an
 * omission:
 *
 *   1. It never opens the microphone before consent is on the server. The
 *      control does not exist until then — not disabled, ABSENT, because a
 *      greyed-out record button invites somebody to find the way round it.
 *   2. It never saves. Accepting calls the parent's `set`, exactly as a
 *      keystroke does, so the note has one writer and a draft nobody accepted
 *      leaves no trace.
 *   3. It never keeps the audio. The Blob goes to `fetch` and is dropped; the
 *      recorder's chunks are released on stop AND on unmount.
 *   4. It never guesses which voice is the patient. With two voices and no
 *      answer there is no draft button at all.
 *
 * TYPING IS OFFERED BESIDE VOICE, NOT BENEATH IT. A noisy shop, a patient who
 * would rather not be recorded, a pharmacist who simply prefers to type —
 * none of those is a degraded path, and an interface that treats voice as the
 * real way will push somebody into recording a patient who did not want it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONSENT_SCRIPT, CONSENT_CONFIRM, CONSENT_HEADING, NOT_ASKED, consentedNote,
  speakerLabel, SPEAKER_QUESTION, SPEAKER_HELP, transcriptNote,
  TRANSCRIPT_HEADING, acceptWarning, NOT_STORED, canDraft, draftRefusalNote,
  START_HEADING, START_VOICE, START_VOICE_NOTE, START_TYPE, START_TYPE_NOTE,
  SOAP_SECTIONS, elapsedLabel, RECORDING_NOW, RECORDING_NOTE, STOP_AND_WRITE,
  WRITING_UP, sectionRefusalNote, anyDrafted, NOTHING_DRAFTED, ACCEPT_NOTE,
  REVIEW_NOTE, DISCARD_LABEL,
  TYPING_NOTE, BACK_TO_VOICE,
  levelBars, LEVEL_BARS, levelNote, NO_SPEECH, MIN_RECORDING_SECONDS,
  TOO_SHORT, deviceNote,
} from './scribeFormat.js';

/**
 * Is a microphone reachable at all?
 *
 * `getUserMedia` is absent on an insecure origin and on an older browser, and
 * a record button that throws when pressed is worse than no record button.
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

/**
 * What to record as, in the order we would rather have it.
 *
 * `new MediaRecorder(stream)` with no type lets the browser choose, which
 * is fine on Chrome and is NOT on Safari — where the only supported
 * container is mp4, and an unsupported type throws rather than falling
 * back. Opus first because it is a fraction of the size for speech, which
 * matters on a Nigerian pharmacy’s connection.
 */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
];

function bestMimeType() {
  const MR = typeof window !== 'undefined' ? window.MediaRecorder : null;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  return PREFERRED_TYPES.find((t) => MR.isTypeSupported(t)) || '';
}

/**
 * What to ask the microphone for.
 *
 * `{ audio: true }` takes the browser’s defaults, which assume a quiet
 * room. A pharmacy counter is not one: there is a fan, a till, a queue and
 * a radio. These three are the difference between a usable recording and
 * one Deepgram returns nothing from.
 *
 * `autoGainControl` matters most of the three here — a patient leaning away
 * from the phone is the common case, and without it they simply drop out.
 */
const AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export default function ConsultationScribe({
  customerId, consultationId, note, available, existing, onAccept, whenLabel,
  onTyping,
}) {
  // 'choose' | 'typing' | 'ready' | 'recording' | 'working' | 'turns' | 'review'
  const [mode, setMode] = useState('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  // The live input level, and whether any sound has EVER arrived. The
  // second is what turns a meter into an answer: a bar that is momentarily
  // flat during a pause must not read the same as a microphone that has
  // been dead since the start.
  const [level, setLevel] = useState(0);
  const [heardSound, setHeardSound] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState('');

  const [turns, setTurns] = useState(null);
  const [speakers, setSpeakers] = useState([]);
  const [diarised, setDiarised] = useState(false);
  const [patientSpeaker, setPatientSpeaker] = useState(null);

  const [sections, setSections] = useState(null);
  const [refused, setRefused] = useState({});

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const tickRef = useRef(null);
  const meterRef = useRef(null);
  const audioCtxRef = useRef(null);

  const consentAt = note?.scribeConsentAt || null;

  /** Let go of the microphone and drop the audio. Stop AND unmount. */
  const release = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach((t) => t.stop()); } catch { /* gone */ }
    try { recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop()); } catch { /* gone */ }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (meterRef.current) { cancelAnimationFrame(meterRef.current); meterRef.current = null; }
    // The AudioContext holds the microphone open just as the stream does.
    // Leaving one running keeps the browser’s recording indicator lit after
    // the pharmacist has stopped, which is its own kind of lie.
    try { audioCtxRef.current?.close(); } catch { /* already closed */ }
    audioCtxRef.current = null;
    recorderRef.current = null;
    streamRef.current = null;
    // The chunks ARE the audio. Dropping the reference is what makes "we do
    // not keep it" true on this side of the wire.
    chunksRef.current = [];
  }, []);

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

  function reset() {
    release();
    setMode('choose');
    setTurns(null);
    setSections(null);
    setRefused({});
    setPatientSpeaker(null);
    setElapsed(0);
    setError(null);
  }

  async function confirmConsent() {
    setBusy(true);
    setError(null);
    try {
      const updated = await readReply(await fetch(`${base}/scribe/consent`, { method: 'POST' }));
      onAccept?.({ consented: updated });
      setMode('ready');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Watch the input level while recording.
   *
   * THE ANSWER TO "IS IT PICKING ME UP?", and the reason it exists: the
   * whole path was proven working end to end, and a recording with no
   * speech in it still came back empty — which the screen reported as a
   * server error AFTER the consultation was over. A meter moves in the
   * first second, so a muted or wrong-device microphone is obvious before
   * anybody has said anything worth keeping.
   *
   * Reads the SAME MediaStream the recorder has, so it cannot disagree with
   * what is being captured.
   */
  function watchLevel(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    let ctx;
    try { ctx = new Ctx(); } catch { return; }
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    // NOT connected to ctx.destination: routing the microphone to the
    // speakers would howl across a counter.
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      // Peak deviation from silence (128), normalised. Peak rather than RMS
      // because the question is "did anything arrive", and a quiet room with
      // one voice in it has a low RMS and an obvious peak.
      let peak = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const d = Math.abs(buf[i] - 128);
        if (d > peak) peak = d;
      }
      const next = Math.min(1, peak / 40);
      setLevel(next);
      // A real voice, not the noise floor of a cheap microphone.
      if (next > 0.18) setHeardSound(true);
      meterRef.current = requestAnimationFrame(tick);
    };
    meterRef.current = requestAnimationFrame(tick);
  }

  async function start() {
    setError(null);
    setLevel(0);
    setHeardSound(false);
    setDeviceLabel('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
      streamRef.current = stream;

      // Which microphone actually answered. A laptop that picked its lid
      // camera mic while a headset sits unused is the commonest cause of a
      // recording nobody can hear, and naming it is the only way the
      // pharmacist can tell.
      const track = stream.getAudioTracks?.()[0];
      if (track?.label) setDeviceLabel(track.label);

      const mimeType = bestMimeType();
      const rec = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      recorderRef.current = rec;
      // A TIMESLICE, so audio accrues every second instead of arriving as
      // one blob at the end. A consultation interrupted by a closed laptop
      // or a crashed tab then still has most of itself.
      rec.start(1000);

      watchLevel(stream);
      setElapsed(0);
      tickRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);
      setMode('recording');
    } catch {
      // Refusing the microphone is a normal answer, not a fault. Say what it
      // means for the work rather than reporting a browser error.
      setError('This browser did not give access to the microphone. You can still type the note.');
      release();
      setMode('choose');
    }
  }

  async function stop() {
    const rec = recorderRef.current;
    if (!rec) return;
    // Read before the timer is cleared, and before release() resets it.
    const seconds = elapsed;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setMode('working');
    setError(null);

    const audio = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }));
      try { rec.stop(); } catch { resolve(null); }
    });
    release();

    if (!audio || !audio.size) {
      setMode('ready');
      setError('That recording was empty. Nothing was sent.');
      return;
    }

    // A misclick, not a consultation. Refused HERE rather than paid for:
    // transcribing two seconds of nothing costs money and then tells the
    // pharmacist their recording had no speech in it, which is true and
    // useless.
    if (seconds < MIN_RECORDING_SECONDS) {
      setMode('ready');
      setError(TOO_SHORT);
      return;
    }

    try {
      const form = new FormData();
      form.append('audio', audio, 'consultation.webm');
      const heard = await readReply(await fetch(`${base}/scribe`, { method: 'POST', body: form }));
      setTurns(heard.turns || []);
      setSpeakers(heard.speakers || []);
      setDiarised(Boolean(heard.diarised));
      setPatientSpeaker(null);

      // NOTHING WAS HEARD. This is a state, not an error, and it used to be
      // neither: the draft step was called with an empty transcript, the
      // server refused it as a bad request, and the pharmacist got the raw
      // 400 — "There is no transcript to draft from" — after talking for
      // five minutes. That blames the request when the truth is about the
      // room, so it now says what to check.
      if ((heard.turns || []).length === 0) {
        setMode('ready');
        setError(NO_SPEECH);
        return;
      }

      // ONE VOICE, OR NONE WE COULD SEPARATE: there is no question to ask, so
      // the write-up runs straight away rather than stopping to ask something
      // with one answer.
      if ((heard.speakers || []).length <= 1) {
        await writeUp(heard.turns || [], null);
      } else {
        setMode('turns');
      }
    } catch (e) {
      setError(e.message);
      setMode('ready');
    }
  }

  async function writeUp(useTurns, speaker) {
    setMode('working');
    setError(null);
    try {
      const got = await readReply(await fetch(`${base}/scribe/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turns: useTurns, patientSpeaker: speaker }),
      }));
      setSections(got.sections || {});
      setRefused(got.refused || {});
      setMode('review');
    } catch (e) {
      setError(e.message);
      setMode(speakers.length > 1 ? 'turns' : 'ready');
    }
  }

  function accept() {
    onAccept?.({ sections });
    reset();
  }

  /* ---- the microphone this browser cannot open -------------------------- */
  const canRecord = micAvailable();

  /* ---- 1. how do you want to work? -------------------------------------- */
  /* ---- the pharmacist chose to type ----------------------------------- */
  //
  // THIS BRANCH USED TO BE FOLDED INTO THE CHOOSER, which is why pressing
  // "Type it" appeared to do nothing: `mode` became 'typing' and the same
  // two cards re-rendered. A control that changes state nothing can see is
  // a control that is broken.
  //
  // It collapses to one line rather than disappearing, so the choice is
  // visibly remembered and the way back to voice is still there. The
  // sections below are what the pharmacist is now looking at, and the
  // parent opens all of them.
  if (mode === 'typing') {
    return (
      <div className="ui-scribe ui-scribe-typing" data-step="typing">
        <span className="ui-cprog-quiet">{TYPING_NOTE}</span>
        {canRecord && (
          <button
            type="button"
            className="ui-psection-link"
            onClick={() => setMode(consentAt ? 'ready' : 'consent')}
          >
            {BACK_TO_VOICE}
          </button>
        )}
      </div>
    );
  }

  if (mode === 'choose') {
    return (
      <div className="ui-scribe" data-step={mode}>
        <p className="ui-scribe-ask">{START_HEADING}</p>
        <div className="ui-scribe-choices">
          {canRecord && (
            <button
              type="button"
              className="ui-scribe-choice ui-scribe-choice-primary"
              disabled={busy}
              onClick={() => setMode(consentAt ? 'ready' : 'consent')}
            >
              <span className="ui-scribe-choice-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" />
                  <path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2" />
                </svg>
              </span>
              <span className="ui-scribe-choice-text">
                <strong>{START_VOICE}</strong>
                <small>{START_VOICE_NOTE}</small>
              </span>
            </button>
          )}
          <button
            type="button"
            className="ui-scribe-choice"
            onClick={() => {
              setMode('typing');
              // Open every section. A pharmacist who has said they are
              // typing should SEE what there is to type, not a
              // seven-of-fourteen budget they have to go looking behind.
              onTyping?.();
            }}
          >
            <span className="ui-scribe-choice-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <rect x="1.4" y="3.6" width="13.2" height="8.8" rx="1.6" />
                <path d="M4.4 6.6h.01M7 6.6h.01M9.6 6.6h.01M12 6.6h.01M5 9.6h6" />
              </svg>
            </span>
            <span className="ui-scribe-choice-text">
              <strong>{START_TYPE}</strong>
              <small>{START_TYPE_NOTE}</small>
            </span>
          </button>
        </div>
        {!canRecord && (
          <p className="ui-allergy-help">This browser cannot record. You can still type the note.</p>
        )}
        {error && <p className="ui-allergy-failed">{error}</p>}
      </div>
    );
  }

  /* ---- 2. consent ------------------------------------------------------- */
  if (mode === 'consent' && !consentAt) {
    return (
      <div className="ui-scribe" data-step="consent">
        <p className="ui-scribe-ask">{CONSENT_HEADING}</p>
        <blockquote className="ui-scribe-script">{CONSENT_SCRIPT}</blockquote>
        <p className="ui-allergy-help">{NOT_ASKED}</p>
        <div className="ui-scribe-actions">
          <button type="button" className="ui-scribe-go" disabled={busy} onClick={confirmConsent}>
            {CONSENT_CONFIRM}
          </button>
          <button type="button" className="ui-psection-link" onClick={reset}>Back</button>
        </div>
        {error && <p className="ui-allergy-failed">{error}</p>}
      </div>
    );
  }

  /* ---- 3. ready, recording, working ------------------------------------- */
  if (mode === 'ready' || mode === 'recording' || mode === 'working') {
    return (
      <div className="ui-scribe" data-step={mode}>
        {mode === 'ready' && (
          <>
            <p className="ui-cprog-quiet">{consentedNote(consentAt, whenLabel)}</p>
            <div className="ui-scribe-actions">
              <button type="button" className="ui-scribe-go" onClick={start}>Start recording</button>
              <button type="button" className="ui-psection-link" onClick={reset}>Back</button>
            </div>
            <p className="ui-allergy-help">{NOT_STORED}</p>
          </>
        )}

        {mode === 'recording' && (
          <div className="ui-scribe-live">
            <span className="ui-scribe-pulse" aria-hidden="true" />
            <span className="ui-scribe-live-label">{RECORDING_NOW}</span>
            <span className="ui-scribe-clock tabular-nums">{elapsedLabel(elapsed)}</span>
            <button type="button" className="ui-scribe-go" onClick={stop}>{STOP_AND_WRITE}</button>
          </div>
        )}
        {mode === 'recording' && (
          <>
            {/* THE METER. Five bars driven by the same MediaStream the
                recorder has, so it cannot disagree with what is being
                captured. It answers the question the owner actually asked —
                is it picking up? — in the first second rather than after the
                consultation is over. */}
            <div className="ui-scribe-meter" role="status" aria-live="polite">
              <span className="ui-scribe-bars" aria-hidden="true">
                {Array.from({ length: LEVEL_BARS }, (unused, i) => (
                  <i key={i} data-on={i < levelBars(level) ? "true" : "false"} />
                ))}
              </span>
              <span className="ui-cprog-quiet">{levelNote(level, { seenSound: heardSound })}</span>
            </div>
            {deviceNote(deviceLabel) && (
              <p className="ui-allergy-help">{deviceNote(deviceLabel)}</p>
            )}
            <p className="ui-allergy-help">{RECORDING_NOTE}</p>
          </>
        )}

        {mode === 'working' && (
          <div className="ui-scribe-live" data-working="true">
            <span className="ui-scribe-spin" aria-hidden="true" />
            <span className="ui-scribe-live-label">{WRITING_UP}</span>
          </div>
        )}

        {error && <p className="ui-allergy-failed">{error}</p>}
      </div>
    );
  }

  /* ---- 4. which voice is the patient? ----------------------------------- */
  if (mode === 'turns') {
    const hint = transcriptNote({ diarised, speakers });
    return (
      <div className="ui-scribe" data-step="turns">
        <fieldset className="ui-scribe-who">
          <legend>{SPEAKER_QUESTION}</legend>
          <p className="ui-allergy-help">{SPEAKER_HELP}</p>
          {speakers.map((s) => {
            const first = (turns || []).find((t) => t.speaker === s);
            return (
              <label key={s} className="ui-scribe-voice">
                <input
                  type="radio"
                  name="patient-voice"
                  checked={patientSpeaker === s}
                  onChange={() => setPatientSpeaker(s)}
                />
                <span className="ui-scribe-voice-text">
                  <strong>{speakerLabel(s)}</strong>
                  {/* The first thing each voice said, so the choice is made
                      from the words rather than from a number. */}
                  <small>{first ? `“${first.text.slice(0, 90)}”` : ''}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
        {hint && <p className="ui-allergy-help">{hint}</p>}
        <div className="ui-scribe-actions">
          <button
            type="button"
            className="ui-scribe-go"
            disabled={!canDraft({ turns, speakers, patientSpeaker })}
            onClick={() => writeUp(turns, patientSpeaker)}
          >
            Write up the note
          </button>
          <button type="button" className="ui-psection-link" onClick={reset}>{DISCARD_LABEL}</button>
        </div>
        {error && <p className="ui-allergy-failed">{error}</p>}
      </div>
    );
  }

  /* ---- 5. review -------------------------------------------------------- */
  const got = anyDrafted(sections);
  const replaces = acceptWarning(existing);
  return (
    <div className="ui-scribe ui-scribe-review" data-step="review">
      {!got && <p className="ui-allergy-help">{NOTHING_DRAFTED}</p>}
      {got && <p className="ui-allergy-help">{REVIEW_NOTE}</p>}
      {refused.all && <p className="ui-allergy-help">{draftRefusalNote(refused.all)}</p>}

      {got && SOAP_SECTIONS.map(({ id, label, from }) => {
        const value = sections?.[id] || '';
        const why = sectionRefusalNote(refused[id]);
        // An EMPTY section says nothing at all. Most consultations never
        // mention an examination finding, and a panel explaining each absence
        // is the 188 words of prose the redesign removed.
        if (!value && !why) return null;
        return (
          <div className="ui-scribe-section" key={id}>
            <div className="ui-scribe-section-head">
              <strong>{label}</strong>
              <small>{from}</small>
            </div>
            {value && (
              <textarea
                rows={Math.min(8, Math.max(2, Math.ceil(value.length / 68)))}
                value={value}
                aria-label={label}
                onChange={(e) => setSections((p) => ({ ...p, [id]: e.target.value }))}
              />
            )}
            {why && <p className="ui-allergy-help">{why}</p>}
          </div>
        );
      })}

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

      {replaces && got && <p className="ui-allergy-help">{replaces}</p>}
      <div className="ui-scribe-actions">
        {got && (
          <button type="button" className="ui-scribe-go" onClick={accept}>{ACCEPT_NOTE}</button>
        )}
        <button type="button" className="ui-psection-link" onClick={reset}>{DISCARD_LABEL}</button>
      </div>
      {error && <p className="ui-allergy-failed">{error}</p>}
    </div>
  );
}
