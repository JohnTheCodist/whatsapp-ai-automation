/**
 * The Website tab's API layer.
 *
 * Only the parts that make a DECISION are tested — the thin wrappers around
 * fetch are not worth a test each, but `isWebsiteBuilderEnabled` chooses
 * whether a whole section of the dashboard exists, and it gets that choice
 * from an HTTP status. That is real logic and it has a wrong answer.
 */

import { test, expect, afterEach, vi } from 'vitest';
import * as api from './api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A fetch that answers every call with one status and body. */
function stubFetch(status, body = {}) {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

test('a 404 means the feature is switched off, not that something broke', () => {
  // With WEBSITE_BUILDER_ENABLED unset the routes are not mounted at all, so
  // the express notFound handler answers. The dashboard must read that as
  // "this pharmacy was never offered the feature" and hide the tab silently.
  stubFetch(404, { error: 'Not found' });
  return expect(api.isWebsiteBuilderEnabled()).resolves.toBe(false);
});

test('a 200 means the feature is on', () => {
  stubFetch(200, { site: null });
  return expect(api.isWebsiteBuilderEnabled()).resolves.toBe(true);
});

/**
 * The failure mode that matters more than the happy path.
 *
 * If a real error hid the tab, a pharmacy with a website would open the
 * dashboard during a wobble and find the section simply gone — with nothing
 * anywhere saying why, because hiding it is silent by design. Showing it and
 * letting the panel report the error is the recoverable direction to be wrong
 * in.
 */
test('a server error shows the tab rather than hiding a feature the pharmacy has', async () => {
  for (const status of [500, 503]) {
    stubFetch(status, { error: 'boom' });
    await expect(api.isWebsiteBuilderEnabled()).resolves.toBe(true);
  }
});

test('a network failure also shows the tab', async () => {
  globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  await expect(api.isWebsiteBuilderEnabled()).resolves.toBe(true);
});

test('an API error surfaces the server’s own message, not a generic one', async () => {
  // The server writes these for people — "theme.palette must be one of: …" —
  // and replacing them with "Request failed" throws away the only useful part.
  stubFetch(400, { error: 'theme.palette must be one of: teal, green', code: 'INVALID_THEME' });
  await expect(api.saveTheme({ palette: 'nope' }))
    .rejects.toThrow('theme.palette must be one of: teal, green');
});

test('a non-JSON error body reports the status instead of a JSON parse error', async () => {
  // A proxy failure or the SPA fallback returns HTML. "Unexpected token <"
  // sends people looking in entirely the wrong place.
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token <'); },
  }));
  await expect(api.getWebsite()).rejects.toThrow('The server returned 502.');
});

test('the preview URL changes with the nonce, so the iframe actually reloads', () => {
  // no-store on the response is not enough on its own: an <iframe> with an
  // unchanged src is not re-fetched by the browser at all.
  expect(api.previewUrl(1)).not.toBe(api.previewUrl(2));
  expect(api.previewUrl(7)).toContain('/api/website/preview.html');
});

/**
 * The preview is FETCHED, not framed, and this is the test that says why.
 *
 * An <iframe src="/api/..."> is a navigation: it never reaches the patched
 * fetch in auth.js, so it sends no Authorization header and the route
 * answers 401. That shipped, because DEV_AUTH_BYPASS makes it work on every
 * developer machine and only the live site sees the 401 — as an empty grey
 * box with nothing on screen saying anything was wrong.
 */
test('the preview document goes through fetch, so it carries the bearer token', async () => {
  const calls = [];
  globalThis.fetch = vi.fn(async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => '<!doctype html><p>hi</p>' };
  });

  await expect(api.previewHtml(42)).resolves.toContain('<!doctype html>');
  expect(calls[0]).toContain('/api/website/preview.html?v=42');
});

test('an expired session is reported, never rendered as an empty preview', async () => {
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => '' }));
  await expect(api.previewHtml(1)).rejects.toThrow(/session has expired/i);
});

test('a candidate template is asked for by name, and only when one is given', () => {
  // "View preview" on another design renders that template's seed against
  // this pharmacy's real data. Omitting the argument must produce exactly the
  // URL it always did — every other caller previews the actual draft, and a
  // stray `&template=` would have them all previewing something else.
  expect(api.previewUrl(1)).not.toContain('template=');
  expect(api.previewUrl(1, null)).not.toContain('template=');
  expect(api.previewUrl(1, 'modern')).toContain('&template=modern');
});

/**
 * publicUrl — the string a pharmacy prints.
 *
 * These tests exist because the failure is not a broken page, it is a flyer.
 * The dashboard is served from app.rxnaija.com whether or not subdomains are
 * live, so a version of this that guesses from window.location looks correct
 * in every environment and is wrong in exactly one: the one where subdomains
 * work. By then it is on paper.
 */
test('with no public domain, the address is a path on the dashboard origin', () => {
  // The fallback is not a degraded mode. Without wildcard DNS the path form
  // IS the address, and it keeps working forever afterwards.
  globalThis.window = { location: { origin: 'https://app.rxnaija.com' } };
  expect(api.publicUrl('ikeja-family-pharmacy'))
    .toBe('https://app.rxnaija.com/p/ikeja-family-pharmacy');
});

test('with a public domain, the address becomes the subdomain', () => {
  globalThis.window = { location: { origin: 'https://app.rxnaija.com' } };
  expect(api.publicUrl('ikeja-family-pharmacy', 'rxnaija.com'))
    .toBe('https://ikeja-family-pharmacy.rxnaija.com');
});

test('the subdomain form does not consult the browser at all', () => {
  // Proves the origin is not silently mixed in. If this ever throws, something
  // reintroduced a window.location read on the path that must not have one.
  globalThis.window = undefined;
  expect(api.publicUrl('naspaa', 'rxnaija.com')).toBe('https://naspaa.rxnaija.com');
});

test('no address means no URL, in either shape', () => {
  // The publish bar renders this before an address is chosen.
  globalThis.window = { location: { origin: 'https://app.rxnaija.com' } };
  for (const empty of ['', null, undefined]) {
    expect(api.publicUrl(empty)).toBe(null);
    expect(api.publicUrl(empty, 'rxnaija.com')).toBe(null);
  }
});
