/**
 * Render an entire pharmacy website: every page, and the sitemap that lists
 * exactly those pages.
 *
 * THE SITEMAP CANNOT DISAGREE WITH THE SITE. Both come from the same array in
 * the same call, so a sitemap entry that 404s would require the renderer to
 * have skipped a page it was handed. This is the whole reason pages.js exists
 * as one function rather than as a router table plus a sitemap list — those
 * two drift the first time somebody adds a page to one of them.
 *
 * REGENERATED WHOLE, NEVER PATCHED. Publishing renders the complete set and
 * replaces it. A pharmacy that removes "BP checks" does not need anybody to
 * remember to delete /services/blood-pressure-check/ — it simply is not in
 * the next render, and the publish deletes what is no longer there. Removing
 * a service leaving a live orphan page is exactly the failure this shape
 * makes unreachable.
 */

const { renderSite } = require('./blocks');
const { renderDocument } = require('./document');
const { renderPageBody } = require('./pageContent');
const { buildPages, navPages } = require('./pages');
const { esc } = require('./blocks/render');
const { publishableArticles } = require('./health');

/**
 * Render every page of a site.
 *
 * @returns {{pages: object[], rendered: object[]}} the page model and, for
 *   each, `{ path, kind, title, html }` ready to store.
 */
function renderAllPages({
  site, pharmacy, profile, assets, assetBaseUrl, theme, year,
  trackingBase = null, canonicalBase = '', noindex = false,
  health = [],
  // Defaults to APPROVED articles only. A caller cannot widen this by
  // omission, and an unreviewed article therefore cannot become a page
  // through any path that forgets to filter.
  healthLibrary = publishableArticles(),
  // The owner's own wording for a generated page's heading/intro/(for a
  // service page) the "what this involves" paragraph, keyed by path — see
  // websiteService.js's validatePageCopy for the shape. Applied in
  // pageContent.js; everything else about a page (whether it exists at all,
  // its URL, its structured data) is still entirely derived from the
  // profile, exactly as before this existed.
  pageCopy = {},
  // Which template the OWNER'S HOMEPAGE is built from — read by pageContent.js
  // so a generated page can (optionally) pick up that template's visual
  // language instead of the plain default every template got before Metro.
  // Never used to change what a page IS (its URL, its facts) — only how the
  // same derived content is dressed, exactly like theme already does.
  templateId = null,
} = {}) {
  const pages = buildPages({ pharmacy, profile, health, healthLibrary });

  const ctx = {
    pharmacy: pharmacy || {},
    profile: profile || {},
    assets: assets || new Map(),
    assetBaseUrl: assetBaseUrl || '',
    year: year ?? null,
    trackingBase,
    pageCopy: pageCopy || {},
    templateId,
    // The site map, so the header block can link to the pages that exist
    // rather than to nothing. Set here because this is the only place that
    // knows the whole site.
    sitePages: navPages(pages),
  };

  const rendered = pages.map((page) => {
    // The home page is what the OWNER composed out of blocks. Every other
    // page is derived from the profile. Both go through renderDocument, so
    // they cannot end up with different metadata rules.
    const bodyHtml = page.kind === 'home'
      ? renderSite(site || { blocks: [] }, ctx)
      : renderPageBody(page, pages, ctx, { year });

    const html = renderDocument({
      site, pharmacy, profile, assets, assetBaseUrl, theme, noindex, year, trackingBase,
      page, pages, canonicalBase, bodyHtml,
    });

    return { path: page.path, kind: page.kind, title: page.title, html };
  });

  return { pages, rendered };
}

/**
 * sitemap.xml for exactly the pages that exist.
 *
 * No <priority> and no <changefreq>. Google has said publicly that it ignores
 * both, and emitting invented numbers for them is the kind of detail that
 * makes a sitemap look machine-generated without making it more useful.
 *
 * lastmod is included only when a real timestamp is known. A lastmod of "now"
 * on every page every time the sitemap is fetched is a lie that trains a
 * crawler to distrust the field.
 */
function renderSitemap(pages, canonicalBase, lastmod = null) {
  if (!canonicalBase) return null;
  const stamp = lastmod ? new Date(lastmod).toISOString().slice(0, 10) : null;
  const urls = pages.map((p) => {
    const loc = `${canonicalBase}${p.path}`;
    return `  <url><loc>${esc(loc)}</loc>${stamp ? `<lastmod>${stamp}</lastmod>` : ''}</url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * robots.txt.
 *
 * Allows everything and points at the sitemap. A pharmacy website has nothing
 * to hide from a crawler, and the commonest way a small site disappears from
 * search is a stray Disallow nobody meant to ship.
 */
function renderRobots(canonicalBase) {
  const lines = ['User-agent: *', 'Allow: /'];
  if (canonicalBase) lines.push('', `Sitemap: ${canonicalBase}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}

/**
 * The 404 body.
 *
 * A real page rather than a bare string: someone who mistypes a URL should
 * still be one click from the pharmacy, and a 404 that offers nothing is a
 * visitor lost. It carries noindex, because a soft-404 indexed as content is
 * worse for the site than the missing page ever was.
 */
function renderNotFound({ pharmacy, profile, pages, theme, year } = {}) {
  const name = pharmacy?.name || 'this pharmacy';
  const links = (pages || []).filter((p) => !p.parent).slice(0, 6)
    .map((p) => `<li><a href="${esc(p.path)}">${esc(p.nav || 'Home')}</a></li>`).join('');
  const body = `<section class="rx-block rx-narrow">`
    + `<h1>Page not found</h1>`
    + `<p class="rx-lede">That page does not exist on ${esc(name)}'s website.</p>`
    + (links ? `<ul>${links}</ul>` : '<p><a href="/">Go to the home page</a></p>')
    + `</section>`;

  return renderDocument({
    pharmacy, profile, theme, year, noindex: true,
    page: { path: null, title: `Page not found — ${name}`, description: 'That page does not exist.' },
    bodyHtml: body,
  });
}

module.exports = { renderAllPages, renderSitemap, renderRobots, renderNotFound };
