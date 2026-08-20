/**
 * Three steps between "signed in" and "has a working assistant":
 * the pharmacy's name, the assistant's name, and how it speaks.
 *
 * WHY THREE AND NOT ONE FORM
 * The same three fields stacked on one screen read as paperwork; asked one at
 * a time they read as being set up. The cost of the split is real though —
 * every extra step is somewhere to abandon — so only two of these can even be
 * got wrong, and the third has a default already selected. Nobody is ever
 * blocked by an empty required field they did not expect.
 *
 * WHY ONLY STEP ONE WRITES ANYTHING
 * The pharmacy is created at step one because every tenant-scoped route needs
 * it to exist. Steps two and three PATCH the same row afterwards, so an
 * abandoned flow leaves a usable pharmacy with a default assistant rather
 * than a half-written one — and the dashboard is reachable either way.
 *
 * WHY THE ANIMATION NEEDS A `key`
 * Each step is keyed, which forces React to remount rather than reuse the
 * DOM. That remount is what replays the heading and settle animations
 * already defined in auth.css. Without it the next step appears fully formed
 * with no transition, which is exactly the "it just jumped" feeling this
 * flow is trying not to have.
 */

import { useState } from 'react';
import { setActivePharmacyId } from './auth.js';
import './auth.css';

/**
 * Mirrors server/services/ai/assistantTone.js.
 *
 * Duplicated deliberately rather than fetched: this screen runs before the
 * pharmacy exists, so there is no tenant to scope a settings request to, and
 * a network round trip here would put a spinner in the middle of the flow.
 * The server validates the key it receives against its own list regardless,
 * so a drift between the two files fails as a clean 400 rather than as a
 * silently wrong tone.
 */
const TONES = [
  {
    key: 'warm',
    label: 'Warm and familiar',
    blurb: 'Greets people properly, uses “ma” and “sir”, sounds like your counter staff.',
    sample: 'Good morning ma! Yes we have it — Amlodipine 10mg is ₦1,480 a card. How many do you need?',
  },
  {
    key: 'professional',
    label: 'Professional and brisk',
    blurb: 'Straight to the answer, minimal small talk. Suits a busy counter.',
    sample: 'Yes, in stock. Amlodipine 10mg — ₦1,480 per card. How many would you like?',
  },
  {
    key: 'reassuring',
    label: 'Calm and reassuring',
    blurb: 'Unhurried and patient — for customers who are worried or unwell.',
    sample: 'Yes, we have that one. Amlodipine 10mg is ₦1,480 a card — take your time, just tell me how many you need.',
  },
];

export default function Onboarding({ email, onCreated, onSignOut }) {
  const [step, setStep] = useState(0);
  const [back, setBack] = useState(false);

  const [name, setName] = useState('');
  const [botName, setBotName] = useState('');
  const [tone, setTone] = useState('warm');

  const [pharmacy, setPharmacy] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const go = (next) => { setBack(next < step); setError(null); setStep(next); };

  // Step 1 — create the pharmacy. The only irreversible write in the flow.
  const createPharmacy = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/pharmacies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not create the pharmacy.');

      const p = j.pharmacy || j;
      // Pin the tenant immediately: the PATCH on the next step is scoped by
      // x-pharmacy-id, and without this it would rely on the server's default
      // pick — which is wrong the moment someone owns two pharmacies.
      if (p?.id) setActivePharmacyId(p.id);
      setPharmacy(p);
      go(1);
    } catch (err) {
      setError(friendly(err, 'Nothing was created — try again.'));
    } finally {
      setBusy(false);
    }
  };

  // Steps 2 and 3 — refine what already exists.
  const saveAssistant = async (fields, next) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/pharmacies/me/assistant', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not save that.');
      if (next === 'done') onCreated(j.pharmacy || pharmacy);
      else go(next);
    } catch (err) {
      setError(friendly(err, 'Your pharmacy is saved — this step is not.'));
    } finally {
      setBusy(false);
    }
  };

  const stepClass = back ? 'auth-step-back' : 'auth-step';

  return (
    <div className="auth">
      <span className="auth-bloom auth-bloom-a" aria-hidden="true" />
      <span className="auth-bloom auth-bloom-b" aria-hidden="true" />
      <span className="auth-bloom auth-bloom-c" aria-hidden="true" />

      <div>
        <div className="auth-card">
          <span className="auth-mark"><span aria-hidden="true">R</span>RxNaija</span>

          <div className="auth-steps" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={3}
            aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((i) => (
              <i key={i} className={i === step ? 'on' : i < step ? 'done' : ''} />
            ))}
          </div>

          {/* key forces the remount that replays the reveal — see the header. */}
          <div key={step} className={stepClass}>

            {step === 0 && (
              <>
                <h1 className="auth-h">
                  <Line>Name your</Line>
                  <Line><span className="auth-accent">pharmacy.</span></Line>
                </h1>
                <p className="auth-sub auth-settle auth-d1">
                  This is what customers see when the assistant introduces itself.
                </p>

                <form onSubmit={createPharmacy} className="auth-form auth-settle auth-d2">
                  <label className="auth-label">
                    <span>Pharmacy name</span>
                    <input
                      className="auth-input" required autoFocus maxLength={80}
                      value={name} onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Sterling Pharmacy"
                    />
                  </label>
                  {error && <p className="auth-note auth-note-err">{error}</p>}
                  <button type="submit" className="auth-btn" disabled={busy || !name.trim()}>
                    {busy ? 'Creating…' : 'Continue'}
                  </button>
                </form>
              </>
            )}

            {step === 1 && (
              <>
                <h1 className="auth-h">
                  <Line>Name your</Line>
                  <Line><span className="auth-accent">assistant.</span></Line>
                </h1>
                <p className="auth-sub auth-settle auth-d1">
                  What it calls itself when a customer asks who they are speaking to.
                </p>

                <form
                  onSubmit={(e) => { e.preventDefault(); saveAssistant({ botName: botName.trim() }, 2); }}
                  className="auth-form auth-settle auth-d2"
                >
                  <label className="auth-label">
                    <span>Assistant name</span>
                    <input
                      className="auth-input" autoFocus maxLength={40}
                      value={botName} onChange={(e) => setBotName(e.target.value)}
                      placeholder={`e.g. Ada, or just ${name.trim() || 'the pharmacy name'}`}
                    />
                    <span className="auth-hint">
                      Leave it blank and it answers as {name.trim() || 'your pharmacy'}.
                    </span>
                  </label>
                  {error && <p className="auth-note auth-note-err">{error}</p>}
                  <div className="auth-row">
                    <button type="button" className="auth-btn-ghost" onClick={() => go(0)} disabled={busy}>
                      Back
                    </button>
                    <button type="submit" className="auth-btn" disabled={busy}>
                      {busy ? 'Saving…' : 'Continue'}
                    </button>
                  </div>
                </form>
              </>
            )}

            {step === 2 && (
              <>
                <h1 className="auth-h">
                  <Line>How should it</Line>
                  <Line><span className="auth-accent">sound?</span></Line>
                </h1>
                <p className="auth-sub auth-settle auth-d1">
                  This changes how it speaks — never what it is willing to answer.
                  Clinical questions always go to your pharmacist.
                </p>

                <div className="tone-list auth-settle auth-d2">
                  {TONES.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className="tone"
                      aria-pressed={tone === t.key}
                      onClick={() => setTone(t.key)}
                    >
                      <span className="tone-name">{t.label}</span>
                      <span className="tone-blurb">{t.blurb}</span>
                      <span className="tone-sample">{t.sample}</span>
                    </button>
                  ))}
                </div>

                {error && <p className="auth-note auth-note-err" style={{ marginTop: '0.9rem' }}>{error}</p>}

                <div className="auth-row auth-settle auth-d3">
                  <button type="button" className="auth-btn-ghost" onClick={() => go(1)} disabled={busy}>
                    Back
                  </button>
                  <button
                    type="button"
                    className="auth-btn"
                    disabled={busy}
                    onClick={() => saveAssistant({ assistantTone: tone }, 'done')}
                  >
                    {busy ? 'Finishing…' : 'Finish setup'}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="auth-foot auth-settle auth-d3">
            <span style={{ color: 'var(--ink-faint)' }}>Signed in as {email}</span>
            <button type="button" className="auth-link" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({ children }) {
  return <span className="ln"><i>{children}</i></span>;
}

/**
 * A timeout here is ambiguous in a way an error message has to resolve: the
 * request may well have succeeded server-side. `tail` says what is known to
 * be safe, so nobody re-runs a step that already took effect.
 */
function friendly(err, tail) {
  if (err?.name === 'TimeoutError') return `The server did not respond. ${tail}`;
  return err?.message || 'Something went wrong. Try again.';
}
