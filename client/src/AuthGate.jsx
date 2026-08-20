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
import SignIn from './SignIn.jsx';
import Onboarding from './Onboarding.jsx';
import { supabase, authConfigured, signOut, setActivePharmacyId } from './auth.js';

export default function AuthGate() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  // null = not looked yet · false = signed in with no pharmacy · object = has one
  const [pharmacy, setPharmacy] = useState(null);

  useEffect(() => {
    if (!authConfigured) { setChecking(false); return undefined; }

    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) { setSession(data?.session || null); setChecking(false); }
    });

    // Covers sign-in, sign-out, token refresh and a session restored in
    // another tab — all of which should move this screen without a reload.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (cancelled) return;
      setSession(s);
      // Force a fresh membership lookup: the previous answer belonged to
      // whoever was signed in before.
      setPharmacy(null);
    });

    return () => { cancelled = true; sub?.subscription?.unsubscribe(); };
  }, []);

  // Does this user actually belong to a pharmacy yet?
  useEffect(() => {
    if (!authConfigured || !session || pharmacy) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/pharmacies/me', { signal: AbortSignal.timeout(20000) });
        if (cancelled) return;
        if (r.ok) {
          const j = await r.json();
          const p = j.pharmacy || j;
          if (p?.id) { setActivePharmacyId(p.id); setPharmacy(p); return; }
        }
        // 403/404 here is the normal "signed in, no pharmacy yet" state that
        // onboarding exists for — not an error worth showing.
        setPharmacy(false);
      } catch {
        if (!cancelled) setPharmacy(false);
      }
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
        <p className="text-sm text-slate-500">Loading…</p>
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

  if (!session) return <SignIn />;

  if (pharmacy === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ui-paper)]">
        <p className="text-sm text-slate-500">Loading your pharmacy…</p>
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

  return <App onSignOut={handleSignOut} />;
}
