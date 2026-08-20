/**
 * Session, and the one place a token is attached to a request.
 *
 * WHY THE FETCH WRAPPER IS GLOBAL RATHER THAN PER-CALL
 * Every screen in this app calls bare `fetch('/api/...')` — dozens of call
 * sites across a dozen files. Threading a token through all of them would be
 * a large diff over working code, and the failure mode of missing ONE is a
 * screen that 401s in production for reasons nobody can see from the code.
 *
 * Patching `window.fetch` once covers every existing call and every future
 * one by construction. It is scoped narrowly: same-origin `/api/*` requests
 * only, and it never overwrites an Authorization header a caller set itself.
 *
 * WHAT THIS FILE MUST NEVER HOLD
 * The anon key only. The service-role key in server/.env bypasses row-level
 * security entirely and must never reach a browser — anything shipped to the
 * client is readable by every customer who opens dev tools.
 */

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Missing config is reported rather than thrown.
 *
 * Throwing at module load blanks the whole app with a stack trace, which
 * looks like a broken build. The sign-in screen checks this and explains
 * which variable is absent — the difference between "the app is broken" and
 * "you have not finished configuring it".
 */
export const authConfigured = Boolean(url && anonKey);

export const supabase = authConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The session lives past a page reload, which is what stops a
        // pharmacist being logged out every time they refresh a screen.
        storageKey: 'rxnaija.auth',
      },
    })
  : null;

/** The pharmacy chosen when a user belongs to more than one. */
const TENANT_KEY = 'rxnaija.pharmacyId';
export const getActivePharmacyId = () => localStorage.getItem(TENANT_KEY) || null;
export const setActivePharmacyId = (id) => {
  if (id) localStorage.setItem(TENANT_KEY, id);
  else localStorage.removeItem(TENANT_KEY);
};

/**
 * Attach the bearer token to this app's own API calls.
 *
 * Called once from main.jsx, before React renders.
 */
export function installAuthFetch() {
  if (!authConfigured || window.__rxAuthFetchInstalled) return;
  window.__rxAuthFetchInstalled = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    let path;
    try {
      // Resolve against the page so relative, absolute and Request inputs are
      // all judged the same way.
      path = new URL(
        typeof input === 'string' ? input : input.url,
        window.location.origin,
      );
    } catch {
      return original(input, init);
    }

    // Same-origin API calls only. A token must never be attached to a
    // third-party request — that is how credentials leak to whatever host a
    // future feature happens to call.
    const isOwnApi = path.origin === window.location.origin
      && path.pathname.startsWith('/api/');
    if (!isOwnApi) return original(input, init);

    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    if (!headers.has('Authorization')) {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    // Which pharmacy, when the user owns several. The server treats this as a
    // REQUEST, not a fact — selectTenant only honours it if the user actually
    // has a membership there, so a forged header cannot cross tenants.
    const active = getActivePharmacyId();
    if (active && !headers.has('x-pharmacy-id')) headers.set('x-pharmacy-id', active);

    return original(input, { ...init, headers });
  };
}

export async function getSession() {
  if (!authConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

export async function signOut() {
  setActivePharmacyId(null);
  if (supabase) await supabase.auth.signOut();
}
