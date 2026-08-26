/**
 * Setting a new password after following a reset link.
 *
 * WHY THIS HAD TO EXIST
 * resetPasswordForEmail sends a link back to the app, and Supabase turns that
 * link into a real signed-in session. Without a screen for it, the app simply
 * treated that as an ordinary sign-in: the person who clicked "forgot
 * password" was never asked for a new one, and landed wherever a signed-in
 * user lands — onboarding, in the case that reported this. Their password was
 * unchanged, so the next sign-in failed exactly as before, with nothing
 * anywhere explaining why.
 *
 * WHY IT IS A SEPARATE SCREEN AND NOT A FIELD IN SETTINGS
 * The person arriving here does not know their password. Every other place
 * that changes one can ask for the old one first; this cannot, because not
 * knowing it is the reason they are here. That makes it a different flow with
 * a different threat model — it is the emailed link that authenticates, and it
 * is spent the moment it is used.
 */

import { useState } from 'react';
import { supabase, signOut } from './auth.js';
import { Shell } from './SignIn.jsx';
import './auth.css';

const MIN_LENGTH = 8;

export default function ResetPassword({ email, onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);

    // Checked here as well as by Supabase so the answer is immediate and in
    // our own words, rather than a round trip returning a provider's phrasing.
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Those two passwords are not the same.');
      return;
    }

    setBusy(true);
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      setDone(true);
    } catch (err) {
      setError(
        /same.*password|should be different/i.test(err.message || '')
          ? 'That is the password you already had. Choose a different one.'
          : (err.message || 'Could not set the new password.')
      );
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell>
        <h1 className="auth-h">Password changed.</h1>
        <p className="auth-sub">
          Sign in with your new password. Do it on any other devices you use as well —
          they are still signed in with the old session.
        </p>
        <button
          type="button"
          className="auth-btn"
          onClick={async () => {
            // Signed out deliberately rather than dropped into the app. The
            // session that got them here came from an emailed link, and
            // finishing on the sign-in screen proves the new password works
            // NOW — rather than the next time they open the app and find it
            // does not.
            await signOut();
            onDone?.();
          }}
        >
          Go to sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="auth-h">Choose a new password.</h1>
      <p className="auth-sub">
        {email ? <>For <strong>{email}</strong>. </> : null}
        This link works once, so finish it now.
      </p>

      <form onSubmit={submit}>
        <label className="auth-label">
          <span>New password</span>
          <input
            className="auth-input"
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>

        <label className="auth-label">
          <span>Type it again</span>
          <input
            className="auth-input"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p className="auth-note auth-note-err">{error}</p>}

        <button className="auth-btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </Shell>
  );
}
