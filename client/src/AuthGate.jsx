/**
 * Decides which of three things a visitor sees: sign-in, onboarding, or the app.
 *
 * A WRAPPER, NOT AN EDIT TO App
 * App is the working dashboard. Threading session state through it would mean
 * touching a large file that currently works, for a concern it does not have.
 * This sits in front instead: App renders only once there is a session and a
 * pharmacy, so nothing inside it has to know auth exists.
 *
 * WHY MISSING CONFIG FALLS THROUGH TO THE APP
 * Without VITE_SUPABASE_* there is no way to sign anyone in — and the server
 * in that situation is almost always running DEV_AUTH_BYPASS, which serves
 * every request as a fixed pharmacy. Showing a sign-in screen that cannot
 * succeed would break local development to enforce a rule the server is not
 * applying anyway.
 *
 * So the keys are the switch: absent, this is a dev machine and the app opens
 * with a visible banner saying so; present, authentication is real. That makes
 * "is auth on?" answerable by looking at one thing, rather than inferring it
 * from a combination of client and server settings that can disagree.
 */

import { useCallback, useEffect, useState } from 'react';
import App from './App.jsx';
import Loading from './Loading.jsx';
import SignIn from './SignIn.jsx';
import ResetPassword from './ResetPassword.jsx';
import Onboarding from './Onboarding.jsx';
import { supabase, authConfigured, signOut, setActivePharmacyId } from './auth.js';

export default function AuthGate() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  // Arrived through a password reset link and has not chosen a new one yet.
  // Outranks every other screen below — see the render order.
  //
  // Seeded SYNCHRONOUSLY from the URL rather than waiting for the
  // PASSWORD_RECOVERY event. Both happen, but getSession() can resolve first,
  // and then the dashboard renders for a moment before the event arrives and
  // replaces it. A password screen that appears after a flash of somebody
  // else's data looks like a glitch at the exact moment a person is being
  // careful. Supabase puts `type=recovery` in the hash, so the answer is
  // already on the page before React's first render.
  const [recovering, setRecovering] = useState(
    () => typeof window !== 'undefined' && /[#&]type=recovery\b/.test(window.location.hash)
  );
  // null = not looked yet · false = signed in with no pharmacy · object = has one
  const [pharmacy, setPharmacy] = useState(null);

  useEffect(() => {
    if (!authConfigured) { setChecking(false); return undefined; }

    let cancelled = false;
    let lastUserId;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      lastUserId = data?.session?.user?.id || null;
      setSession(data?.session || null);
      setChecking(false);
    });

    // Covers sign-in, sign-out, token refresh and a session restored in
    // another tab — all of which should move this screen without a reload.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (cancelled) return;

      // Following a reset link signs the person IN, which is why this needs
      // catching before anything else: without it the app cannot tell a
      // password recovery from an ordinary sign-in, and sends someone who
      // clicked "forgot password" straight through to the dashboard — or, as
      // reported, to onboarding — with their password still unchanged and
      // nothing saying so.
      if (event === 'PASSWORD_RECOVERY') {
        setSession(s);
        setRecovering(true);
        return;
      }

      setSession(s);
      // Supabase fires this on a plain token refresh too — notably every
      // time the tab regains focus, even though who is signed in has not
      // changed. Resetting pharmacy (and so re-fetching it) on every one of
      // those was what could bounce an already-onboarded owner back to
      // onboarding on nothing more than a transient failure of that
      // refetch. Only re-look-up when the signed-in user actually changed.
      const userId = s?.user?.id || null;
      if (userId !== lastUserId) {
        lastUserId = userId;
        setPharmacy(null);
      }
    });

    return () => { cancelled = true; sub?.subscription?.unsubscribe(); };
  }, []);

  // Does this user actually belong to a pharmacy yet?
  useEffect(() => {
    // pharmacy !== null, NOT a truthy check: `false` is a valid, resolved
    // answer ("signed in, no pharmacy yet") and must stop this effect from
    // re-firing just as much as an actual pharmacy object does. A truthy
    // check let `false` slip through, and since onAuthStateChange resets
    // pharmacy to null on every auth event it sees, the two together made
    // this hammer /api/pharmacies/me in a tight loop instead of ever
    // settling into onboarding.
    if (!authConfigured || !session || pharmacy !== null) return undefined;
    let cancelled = false;
    (async () => {
      // Up to 3 tries: only a 403 (NO_MEMBERSHIP) or 404 is requireAuth/this
      // route's way of actually saying "no pharmacy yet". Anything else — a
      // 401 from a token race, a 500, a dropped connection, a timeout — is a
      // failed request, not an answer, and must not be read as one. Treating
      // it as one is what previously sent an already-onboarded owner back to
      // onboarding whenever this fetch merely failed once.
      let unauthorizedEveryTime = true;

      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const r = await fetch('/api/pharmacies/me', { signal: AbortSignal.timeout(20000) });
          if (cancelled) return;
          if (r.ok) {
            const j = await r.json();
            const p = j.pharmacy || j;
            if (p?.id) { setActivePharmacyId(p.id); setPharmacy(p); return; }
          }
          if (r.status === 403 || r.status === 404) { setPharmacy(false); return; }
          if (r.status !== 401) unauthorizedEveryTime = false;
        } catch {
          // network error / timeout — fall through to retry below. NOT a 401,
          // so it must not be mistaken for a dead session.
          unauthorizedEveryTime = false;
        }
        if (attempt < 2) await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
      if (cancelled) return;

      // Three 401s in a row is not the token race this loop was built for.
      //
      // A single 401 genuinely can be a race — the token expired between
      // being read and being used — which is why one is retried rather than
      // acted on. But a session that is still rejected after three attempts
      // and two waits is simply dead: expired past refresh, revoked, or
      // invalidated by a password change.
      //
      // Falling through to the comment below left that person on the loading
      // spinner permanently, with no sign-out button on screen because the
      // app had not rendered yet. The only escape was clearing site data from
      // developer tools, which is not an instruction anybody should need.
      // Signing out costs a sign-in; the spinner cost the whole session.
      if (unauthorizedEveryTime) {
        await signOut();
        setSession(null);
        setPharmacy(null);
        return;
      }

      // Exhausted retries without a confirmed answer either way. Stay on the
      // loading screen rather than guessing — a stuck spinner is
      // recoverable, a wrong onboarding redirect looks like data loss.
    })();
    return () => { cancelled = true; };
  }, [session, pharmacy]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    setSession(null);
    setPharmacy(null);
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ui-paper)]">
        <p className="text-sm text-slate-500"><Loading /></p>
      </div>
    );
  }

  // Dev machine: no keys, server almost certainly bypassing auth.
  if (!authConfigured) {
    return (
      <>
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          <strong>No authentication.</strong> VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY are unset, so anyone reaching this page is served
          as the default pharmacy. Local development only.
        </div>
        <App />
      </>
    );
  }

  // BEFORE the pharmacy lookup and everything after it. A recovery session is
  // a real session, so every check below would happily let this person into
  // the app — which is exactly the bug: they asked to change their password
  // and were shown a dashboard instead, password unchanged.
  if (recovering) {
    return (
      <ResetPassword
        email={session?.user?.email || ''}
        onDone={() => {
          // The hash still says type=recovery, and it is what seeds the state
          // above — leaving it would put a reloaded page straight back on this
          // screen with a link that has already been spent.
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          setRecovering(false);
          setSession(null);
          setPharmacy(null);
        }}
      />
    );
  }

  if (!session) return <SignIn />;

  if (pharmacy === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ui-paper)]">
        <p className="text-sm text-slate-500"><Loading label="Loading your pharmacy" /></p>
      </div>
    );
  }

  if (pharmacy === false) {
    return (
      <Onboarding
        email={session.user?.email || ''}
        onCreated={(p) => setPharmacy(p)}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <App
      onSignOut={handleSignOut}
      pharmacy={pharmacy}
      email={session.user?.email || ''}
    />
  );
}
