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
