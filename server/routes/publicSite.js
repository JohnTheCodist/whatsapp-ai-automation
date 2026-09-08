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
  publicCsp, MAX_AGE_SECONDS, SHARED_MAX_AGE_SECONDS, addressFromHost,
  getPublishedPage, getPublishedPaths, baseDomain,
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

/**
 * The stored form of a request path: leading and trailing slash, and only the
 * characters pages.js can produce.
 *
 * STRICT ON PURPOSE. Matching exactly what the generator emits turns the
 * lookup into an equality test rather than a normalisation guess, so the
 * router and the sitemap cannot disagree about what a URL is. Anything else
 * is refused before it reaches the database — scanners send a great deal of
 * traversal, encoded nulls and 4KB paths, and none of it should cost a query.
 */
function normalizePath(raw) {
  let path = String(raw || '/');
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  if (!path.startsWith('/')) path = `/${path}`;
  if (!path.endsWith('/')) path += '/';
  if (path.length > 200) return null;
  return /^\/([a-z0-9-]+\/)*$/.test(path) ? path : null;
}

/** The absolute origin for a site, or '' when subdomains are not configured. */
function originFor(address) {
  const domain = baseDomain();
  return domain && address ? `https://${address}.${domain}` : '';
}

/**
 * A real 404 page rather than a bare line of text.
 *
 * Someone who mistypes a URL should still be one click from the pharmacy.
 * Carries noindex, because a soft 404 indexed as content is worse for the site
 * than the missing page ever was — and still says exactly the same thing for
 * "no such address" as for "not published", for the reason in notFound above.
 *
 * Self-contained and tiny: this is the one page that must render when nothing
 * else about the site could be loaded.
 */
function notFoundPage(res) {
  const style = 'body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;'
    + 'display:grid;place-items:center;background:#f7f8f7;color:#16211c}'
    + 'main{text-align:center;padding:2rem}h1{font-size:1.5rem;margin:0 0 .5rem}'
    + 'p{color:#4b5a53;margin:.25rem 0}a{color:#0f766e}';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>Page not found</title>'
    + `<style>${style}</style></head><body><main>`
    + '<h1>Page not found</h1>'
    + '<p>That page does not exist on this website.</p>'
    + '<p><a href="/">Go to the home page</a></p>'
    + '</main></body></html>';

  res.status(404)
    .type('text/html; charset=utf-8')
    .setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.send(html);
}

/**
 * Serve one page of a published site.
 *
 * This replaced a handler that could only ever answer with the single stored
 * page. The same code now serves /, /about/ and
 * /services/blood-pressure-check/, because the page is looked up BY PATH
 * rather than assumed to be the only one there is.
 */
const pageHandler = asyncRoute(async (req, res) => {
  const address = resolveSiteKey(req);
  // A malformed address never reaches the database. Scanners send a great
  // deal of this.
  if (!address) return notFoundPage(res);

  // On the /p/<address>/... shape the address is part of the request path and
  // must not be part of the PAGE path. req.params[0] is whatever followed it;
  // on the subdomain shape there is no slug and the whole path is the page.
  const rest = typeof req.params[0] === 'string' ? req.params[0] : '';
  const path = normalizePath(req.params.slug ? `/${rest}` : req.path);
  if (!path) return notFoundPage(res);

  const page = await getPublishedPage(address, path);
  if (!page) return notFoundPage(res);

  const html = page.html;
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
  //
  // ONLY THE HOME PAGE COUNTS AS A VIEW. A visitor who reads four pages is one
  // visit, not four. Counting every page would silently multiply the one
  // number this feature reports to a pharmacy on the day the site gained more
  // than one page — an improvement in the product showing up as a spike in
  // customer interest that never happened.
  if (page.kind === 'home') analytics.record(page.pharmacy_id, 'view');

  res.type('text/html; charset=utf-8').send(html);
});

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
const goHandler = asyncRoute(async (req, res) => {
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
});

/**
 * robots.txt per pharmacy.
 *
 * Points crawlers at the page and nowhere else. Without this, a crawler
 * follows the domain's root robots.txt, which governs the dashboard — a
 * document that has nothing to say about a pharmacy's marketing site and
 * could easily be tightened one day in a way that silently de-indexes every
 * pharmacy on the platform.
 */
const robotsHandler = asyncRoute(async (req, res) => {
  const address = resolveSiteKey(req);
  if (!address) return notFound(res);

  const site = await getPublishedSite(address);
  if (!site) return notFound(res);

  res.type('text/plain; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${SHARED_MAX_AGE_SECONDS}`);
  // The path this page is REACHABLE at, which differs by shape. On a
  // subdomain the page is the root, and emitting `Allow: /p/<address>`
  // there would point a crawler at a path that 404s on that host — a
  // robots.txt that de-indexes the very site it exists to open up.
  const onHost = Boolean(addressFromHost(req.hostname));
  // The sitemap is advertised only on the shape it is served on, and only
  // when we know the real origin. A Sitemap: line pointing at a URL that
  // 404s is worse than no line at all — it is the first thing a crawler
  // fetches and the first thing it learns not to trust.
  const origin = onHost ? originFor(address) : '';
  res.send(`User-agent: *
Allow: ${onHost ? '/' : `/p/${address}`}
${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ''}`);
});

/**
 * sitemap.xml, listing exactly the pages that are stored.
 *
 * Read from the same table the router serves from, so it cannot advertise a
 * URL that 404s. That is the single commonest defect in a generated site, and
 * making it structurally impossible is worth more than any amount of care.
 *
 * Served only on the subdomain shape. The /p/ form has no origin of its own —
 * its pages live under a path on the dashboard's hostname — and a sitemap
 * full of guessed absolute URLs would be actively misleading.
 */
const sitemapHandler = asyncRoute(async (req, res) => {
  const address = resolveSiteKey(req);
  if (!address) return notFoundPage(res);

  const origin = originFor(address);
  if (!origin) return notFoundPage(res);

  const rows = await getPublishedPaths(address);
  if (!rows.length) return notFoundPage(res);

  const urls = rows.map((row) => {
    // lastmod from the row's real timestamp. "Now" on every fetch is a lie
    // that teaches a crawler the field means nothing.
    const stamp = row.updated_at ? new Date(row.updated_at).toISOString().slice(0, 10) : null;
    return `  <url><loc>${origin}${row.path}</loc>`
      + `${stamp ? `<lastmod>${stamp}</lastmod>` : ''}</url>`;
  }).join('\n');

  res.type('application/xml; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${SHARED_MAX_AGE_SECONDS}`);
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`);
});

/**
 * TWO SHAPES, ONE SET OF HANDLERS.
 *
 *   path:  app.rxnaija.com/p/<address>   mounted at /p
 *   host:  <address>.rxnaija.com/        mounted at / when the host resolves
 *
 * The handlers are shared because resolveSiteKey already prefers the host
 * over the path parameter, so the same code answers both without knowing
 * which it was reached through. Only robots.txt cares, and it asks.
 *
 * Registering the same handler twice rather than redirecting one shape to
 * the other is deliberate: a pharmacy that has printed the /p/ form on a
 * flyer must keep working forever, and a redirect would cost every one of
 * those visitors a round trip.
 */
// ORDER MATTERS. The catch-all must come last, or /p/<address>/robots.txt
// would be looked up as a page called "robots.txt" and 404.
router.get('/:slug', pageHandler);
router.get('/:slug/go/:kind', goHandler);
router.get('/:slug/robots.txt', robotsHandler);
router.get('/:slug/sitemap.xml', sitemapHandler);
router.get('/:slug/*', pageHandler);

const hostRouter = express.Router();
hostRouter.get('/', pageHandler);
hostRouter.get('/go/:kind', goHandler);
hostRouter.get('/robots.txt', robotsHandler);
hostRouter.get('/sitemap.xml', sitemapHandler);

// The /p/ tracking path, accepted on the subdomain too.
//
// A page is rendered ONCE and served on both shapes, so its counted links
// carry one form — /p/<address>/go/whatsapp. On the subdomain that path would
// otherwise match nothing and every WhatsApp button on the site would 404.
// Rendering twice so the URLs could be prettier would double the storage and
// create two versions of a page that must never disagree, to change a string
// no visitor reads.
hostRouter.get('/p/:slug/go/:kind', goHandler);

// Last: anything else on a pharmacy host is a page or a 404, and must never
// fall through to the dashboard. GOLDEN-005c asserts the guard that makes
// that true.
hostRouter.get('/*', pageHandler);

module.exports = { router, hostRouter, notFound };
