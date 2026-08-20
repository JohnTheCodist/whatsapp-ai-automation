/**
 * Sign in / create an account.
 *
 * EMAIL AND PASSWORD, NOT A MAGIC LINK
 * A magic link is one less secret to manage, and it is the wrong default
 * here: it makes every sign-in depend on email arriving promptly on a phone
 * at a counter, over a connection that is not always good. A pharmacist
 * locked out mid-shift because a link is slow is a worse failure than a
 * password they already know how to use. Reset-by-email stays available for
 * the case it is actually suited to.
 *
 * ONE SCREEN, TWO MODES
 * Sign-in and sign-up differ by a single line of copy, and splitting them
 * across routes mostly produces people on the wrong one. The toggle keeps
 * whatever has already been typed.
 *
 * STYLED AS THE MARKETING SITE, NOT THE DASHBOARD — see auth.css. Someone
 * arriving from home.html has just read a page in cream and emerald; landing
 * on flat dashboard chrome reads as being handed to a different company
 * halfway through signing up.
 */

import { useState } from 'react';
import { supabase, authConfigured } from './auth.js';
import './auth.css';

export default function SignIn() {
  const [mode, setMode] = useState('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const signUp = mode === 'up';

  if (!authConfigured) {
    return (
      <Shell>
        <h1 className="auth-h">
          <Line delay={1}>Almost</Line>
          <Line delay={2}>configured.</Line>
        </h1>
        <p className="auth-sub auth-settle auth-d1">
          Sign-in needs two values this build was not given:
        </p>
        <ul className="auth-settle auth-d2 auth-mono" style={{ margin: '0.75rem 0 0', paddingLeft: '1.1rem' }}>
          <li>VITE_SUPABASE_URL</li>
          <li>VITE_SUPABASE_ANON_KEY</li>
        </ul>
        <p className="auth-settle auth-d3" style={{ marginTop: '0.9rem', fontSize: '0.8125rem', color: 'var(--ink-faint)' }}>
          Both are in Supabase under Settings → API. Use the <strong>anon / publishable</strong> key —
          never the service-role key, which bypasses every access rule and must stay on the server.
        </p>
      </Shell>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (signUp) {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        // Supabase returns a user with no session when email confirmation is
        // switched on. Only then is "check your email" true — saying it
        // otherwise sends someone to look for a mail that was never sent.
        if (!data.session) {
          setNotice('Account created. Check your email to confirm it, then sign in.');
          setMode('in');
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      // No navigation here — AuthGate is subscribed to the auth state and
      // swaps the screen itself. Redirecting as well would race it.
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hands off to Google and comes back to this origin.
   *
   * No success path to write: the browser leaves the page entirely, and on
   * return AuthGate's onAuthStateChange sees the restored session and swaps
   * the screen. `busy` is left ON deliberately — the redirect can take a
   * beat on a slow connection, and re-enabling the button would invite a
   * second click that starts a competing OAuth flow.
   */
  const withGoogle = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (err) throw err;
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!email.trim()) { setError('Enter your email first, then choose reset.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      if (err) throw err;
      // Deliberately not "we sent you a link". Confirming which addresses
      // have accounts turns this box into a way to enumerate customers.
      setNotice('If that email has an account, a reset link is on its way.');
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="auth-h">
        {signUp ? (
          <>
            <Line delay={1}>Create your</Line>
            <Line delay={2}><span className="auth-accent">account.</span></Line>
          </>
        ) : (
          <>
            <Line delay={1}>Welcome</Line>
            <Line delay={2}><span className="auth-accent">back.</span></Line>
          </>
        )}
      </h1>

      <p className="auth-sub auth-settle auth-d1">
        {signUp
          ? 'You’ll name your pharmacy on the next screen.'
          : 'The counter your customers actually message.'}
      </p>

      <form onSubmit={submit} className="auth-form auth-settle auth-d2">
        <label className="auth-label">
          <span>Email</span>
          <input
            className="auth-input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="auth-label">
          <span>Password</span>
          <input
            className="auth-input"
            type="password"
            required
            minLength={8}
            autoComplete={signUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {signUp && <span className="auth-hint">At least 8 characters.</span>}
        </label>

        {error && <p className="auth-note auth-note-err">{error}</p>}
        {notice && <p className="auth-note auth-note-ok">{notice}</p>}

        <button type="submit" className="auth-btn" disabled={busy}>
          {busy ? 'Working…' : signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <div className="auth-settle auth-d3">
        <div className="auth-or"><span>or</span></div>

        {/* Same button for both modes, and the label says so. Google returns
            the same account whether it was first seen at sign-up or sign-in,
            so offering "Sign up with Google" and "Sign in with Google" as if
            they were different routes invents a distinction the provider
            does not have — and sends people looking for the other one. */}
        <button
          type="button"
          className="auth-btn-google"
          disabled={busy}
          onClick={withGoogle}
        >
          <GoogleMark />
          Continue with Google
        </button>
      </div>

      <div className="auth-foot auth-settle auth-d3">
        <button
          type="button"
          className="auth-link"
          onClick={() => { setMode(signUp ? 'in' : 'up'); setError(null); setNotice(null); }}
        >
          {signUp ? 'I already have an account' : 'Create an account instead'}
        </button>
        {!signUp && (
          <button type="button" className="auth-link" onClick={reset}>Forgot password</button>
        )}
      </div>
    </Shell>
  );
}

/** One authored line of the heading, in its own reveal mask. */
function Line({ children }) {
  return <span className="ln"><i>{children}</i></span>;
}

/**
 * Google's mark, inline rather than fetched.
 *
 * Their brand terms require the four-colour G unmodified, and a remote image
 * would put a third-party request — and a blank square when it is slow — on
 * the one screen that has to work before anything else does.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * Supabase's own wording leaks implementation ("Invalid login credentials")
 * and is occasionally alarming for what is usually a typo. Only the cases
 * someone can act on are rewritten; anything else passes through rather than
 * being flattened into a generic message that helps nobody.
 */
function friendly(err) {
  const m = String(err?.message || err || '');
  if (/invalid login credentials/i.test(m)) return 'That email and password do not match an account.';
  if (/already registered|already been registered/i.test(m)) return 'That email already has an account — sign in instead.';
  if (/password should be at least/i.test(m)) return 'Password needs to be at least 8 characters.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first — check your inbox for the link.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a moment and try again.';
  if (/fetch|network|failed to fetch/i.test(m)) return 'Could not reach the server. Check your connection and try again.';
  return m || 'Something went wrong. Try again.';
}

function Shell({ children }) {
  return (
    <div className="auth">
      <span className="auth-bloom auth-bloom-a" aria-hidden="true" />
      <span className="auth-bloom auth-bloom-b" aria-hidden="true" />
      <span className="auth-bloom auth-bloom-c" aria-hidden="true" />

      <div>
        <div className="auth-card">
          <a className="auth-mark" href="/home.html">
            <span aria-hidden="true">R</span>RxNaija
          </a>
          {children}
        </div>
        {/* A way back to the site. Someone who clicked "Sign in" to look
            around should not have the browser's back button as their only
            exit. */}
        <p className="auth-back">
          <a href="/home.html">← Back to rxnaija.com</a>
        </p>
      </div>
    </div>
  );
}
