/**
 * The published document — head, styles and body, in one self-contained file.
 *
 * WHAT COMES OUT OF HERE IS THE WHOLE PAGE. No external stylesheet, no
 * JavaScript, no build step, nothing to fetch except the fonts and the
 * pharmacy's own images. That is a deliberate consequence of the published
 * CSP (`default-src 'none'`, `script-src 'none'`): a brochure page needs none
 * of it, and a page that needs none of it cannot be attacked through any of
 * it.
 *
 * SEO IS A REQUIREMENT, NOT A NICETY. The reason a pharmacy wants a website
 * at all is that people search for "pharmacy near me". So the title, the
 * description and the LocalBusiness structured data below are built from the
 * pharmacy's real profile rather than left to a template, and they are the
 * one part of this page a customer never sees but a search engine always
 * does.
 */

const { renderSite } = require('./blocks');
const { esc } = require('./blocks/render');
const { stylesheet } = require('./blocks/stylesheet');
const { resolveTheme } = require('./blocks/theme');

/**
 * A page title that says what the business is and where.
 *
 * "Ikeja Family Pharmacy" alone competes with every other pharmacy of that
 * name in the country. Adding the city is the single highest-value thing that
 * can be done to a title tag for a local business, and the city is already on
 * the profile.
 */
function pageTitle(pharmacy, profile) {
  const name = pharmacy?.name || 'Pharmacy';
  const place = profile?.city || profile?.state;
  return place ? `${name} — Pharmacy in ${place}` : `${name} — Pharmacy`;
}

/**
 * The meta description, from the pharmacy's own words where it has them.
 *
 * Falls back to a factual sentence built from the profile rather than to
 * marketing copy nobody wrote. An invented claim in a meta description is
 * still an invented claim about a real healthcare business.
 */
function pageDescription(pharmacy, profile) {
  if (profile?.description) {
    const flat = String(profile.description).replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
  }
  const name = pharmacy?.name || 'Our pharmacy';
  const where = [profile?.address_line, profile?.city, profile?.state].filter(Boolean).join(', ');
  return where
    ? `${name}. Prescriptions, advice and everyday health at ${where}. Message us on WhatsApp.`
    : `${name}. Prescriptions, advice and everyday health. Message us on WhatsApp.`;
}

/**
 * schema.org LocalBusiness / Pharmacy, as JSON-LD.
 *
 * THE ONE PLACE THIS PAGE EMITS A <script> TAG, and it is why the tag is
 * `type="application/ld+json"` rather than executable. Browsers do not run
 * it, `script-src 'none'` does not block it (it is data, not script), and
 * search engines read it. The content is JSON.stringify of values taken from
 * the profile, then escaped for `<` — the one sequence that could close the
 * tag early from inside a JSON string.
 *
 * Only fields the pharmacy actually has are included. A structured-data block
 * asserting an empty address is worse than none: it tells a search engine
 * something false about a real business.
 */
function structuredData(pharmacy, profile) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Pharmacy',
    name: pharmacy?.name,
  };

  const address = {};
  if (profile?.address_line) address.streetAddress = profile.address_line;
  if (profile?.city) address.addressLocality = profile.city;
  if (profile?.state) address.addressRegion = profile.state;
  if (Object.keys(address).length) {
    data.address = { '@type': 'PostalAddress', ...address, addressCountry: 'NG' };
  }

  if (profile?.phone) data.telephone = profile.phone;
  if (profile?.description) data.description = String(profile.description).replace(/\s+/g, ' ').trim();
  if (profile?.maps_url) data.hasMap = profile.maps_url;

  if (!data.name) return '';

  // `<` is escaped rather than the whole string HTML-escaped: inside a JSON-LD
  // block the content must stay valid JSON, so entity-encoding quotes would
  // break it. Escaping `<` alone is exactly enough to make `</script>`
  // unable to terminate the element early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Render the complete document.
 *
 * `noindex` is set for previews. A draft that a search engine crawled would
 * be a half-finished pharmacy website in results, outranking nothing and
 * embarrassing someone.
 */
function renderDocument({ site, pharmacy, profile, assets, assetBaseUrl, theme, noindex = false, year, trackingBase } = {}) {
  const ctx = {
    pharmacy: pharmacy || {},
    profile: profile || {},
    assets: assets || new Map(),
    assetBaseUrl: assetBaseUrl || '',
    year: year ?? null,
    // Absent for previews: see publishService. Its presence is what turns
    // outbound links into counted redirects.
    trackingBase: trackingBase || null,
  };

  const body = renderSite(site || { blocks: [] }, ctx);
  const resolved = resolveTheme(theme);
  const title = pageTitle(ctx.pharmacy, ctx.profile);
  const description = pageDescription(ctx.pharmacy, ctx.profile);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${esc(resolved.googleFonts.replace(/\|/g, '&family='))}&display=swap">
<style>${stylesheet(theme)}</style>
${structuredData(ctx.pharmacy, ctx.profile)}
</head>
<body>
${body}
</body>
</html>`;
}

module.exports = { renderDocument, pageTitle, pageDescription, structuredData };
