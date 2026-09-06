/**
 * The public pharmacy website.
 *
 * NO AUTHENTICATION, BY DESIGN — this is the page a customer opens. Which
 * makes it the one route in this codebase where a mistake is published rather
 * than merely shown to the wrong staff member, so everything it does is
 * deliberately small: resolve an address, read one indexed row, send a
 * string.
 *
 * MOUNTING ORDER IS LOAD-BEARING. This router must be registered BEFORE the
 * static/SPA block in server/index.js, and `p/` must be in that block's
 * exclusion regex. The fallback answers every unmatched GET with index.html,
 * so without both of those a published pharmacy website returns the dashboard
 * shell with a 200 — a wrong document, not an error, which is the worst shape
 * this failure could take. The /download/:file route above it exists with the
 * same comment for the same reason.
 */

const express = require('express');
const { asyncRoute } = require('../middleware/errorHandler');
const {
  resolveSiteKey, getPublishedSite, getClickTarget, etagFor,
  publicCsp, MAX_AGE_SECONDS, SHARED_MAX_AGE_SECONDS,
} = require('../services/website/publicSite');
const analytics = require('../services/website/analytics');

const router = express.Router();

/**
 * The same body for "no such address" and "not published".
 *
 * Deliberately indistinguishable. Telling a visitor that an address exists
 * but is currently unpublished leaks that a pharmacy is preparing a site, and
 * lets somebody enumerate which addresses are taken before they are live.
 * Plain text rather than the dashboard's 404 JSON, because the audience here
 * is a person who typed a URL, not a client library.
 */
function notFound(res) {
  res.status(404)
    .type('text/plain; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=60');
  res.send('There is no pharmacy website at this address.\n');
}

router.get('/:slug', asyncRoute(async (req, res) => {
  const address = resolveSiteKey(req);
  // A malformed address never reaches the database. Scanners send a great
  // deal of this.
  if (!address) return notFound(res);

  const site = await getPublishedSite(address);
  if (!site) return notFound(res);

  const html = site.published_html;
  const etag = etagFor(html);

  res.setHeader('Content-Security-Policy', publicCsp());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('ETag', etag);
  res.setHeader(
    'Cache-Control',
    `public, max-age=${MAX_AGE_SECONDS}, s-maxage=${SHARED_MAX_AGE_SECONDS}`,
  );

  // A repeat visitor on a slow connection gets 0 bytes instead of ~10KB. The
  // row has already been read by this point — the saving is bandwidth, which
  // on a Nigerian mobile connection is the part that costs the visitor money.
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  // Counted AFTER the decision to serve, so a 304 is not counted as a fresh
  // view. Buffered in memory and flushed on a timer — this must not put a
  // write on the connection pool for every visitor. Nothing about the visitor
  // is recorded; see services/website/analytics.js.
  analytics.record(site.pharmacy_id, 'view');

  res.type('text/html; charset=utf-8').send(html);
}));

/**
 * GET /p/:slug/go/:kind — count a click, then send the visitor on.
 *
 * WHY A REDIRECT EXISTS AT ALL. Published pages carry `script-src 'none'` and
 * contain no JavaScript, so there is no analytics snippet and cannot be one
 * without giving up the guarantee that makes the whole stored-XSS class
 * unreachable. A server-side hop is the only way left to count the thing that
 * actually matters — "47 people tapped WhatsApp this month" is the pharmacy's
 * return on this entire feature.
 *
 * IT IS NOT AN OPEN REDIRECT. Nothing in the request says where to go: the
 * destination is looked up from the pharmacy's own record, and an unknown
 * kind or a pharmacy with no such detail 404s rather than redirecting
 * somewhere arbitrary. The only caller-supplied value is `?m=`, which is
 * carried into the query string of a hardcoded wa.me host.
 *
 * 302, not 301. A permanent redirect would be cached by the browser forever,
 * so the second click would never reach the server and would never be
 * counted — and worse, a pharmacy that changed its WhatsApp number would have
 * customers pinned to the old one.
 */
router.get('/:slug/go/:kind', asyncRoute(async (req, res) => {
  const address = resolveSiteKey(req);
  if (!address) return notFound(res);

  const target = await getClickTarget(address, req.params.kind, req.query?.m);
  if (!target) return notFound(res);

  // Recording must never be what stops a customer reaching WhatsApp. record()
  // is synchronous, in-memory and cannot throw — but the ordering says the
  // intent: the redirect is the product, the count is a side effect.
  analytics.record(target.pharmacyId, req.params.kind);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.redirect(302, target.destination);
}));

/**
 * robots.txt per pharmacy.
 *
 * Points crawlers at the page and nowhere else. Without this, a crawler
 * follows the domain's root robots.txt, which governs the dashboard — a
 * document that has nothing to say about a pharmacy's marketing site and
 * could easily be tightened one day in a way that silently de-indexes every
 * pharmacy on the platform.
 */
router.get('/:slug/robots.txt', asyncRoute(async (req, res) => {
  const address = resolveSiteKey(req);
  if (!address) return notFound(res);

  const site = await getPublishedSite(address);
  if (!site) return notFound(res);

  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${SHARED_MAX_AGE_SECONDS}`);
  res.send(`User-agent: *\nAllow: /p/${address}\n`);
}));

module.exports = router;
