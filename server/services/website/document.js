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
const { esc, assetUrl, waHref } = require('./blocks/render');
const { whatsappGlyph } = require('./blocks/icons');
const { stylesheet } = require('./blocks/stylesheet');
const { resolveTheme } = require('./blocks/theme');
const { breadcrumbsFor } = require('./pages');

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
 * BreadcrumbList, so a search result shows Home › Services › Blood Pressure
 * Checks instead of a bare URL.
 *
 * Emitted only when there is a real trail. A one-item breadcrumb describing
 * the page you are on is not a trail, and marking it up as one asserts a
 * hierarchy that does not exist.
 */
function breadcrumbData(trail, canonicalBase) {
  if (!trail || trail.length < 2) return '';
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.label,
      item: `${canonicalBase}${c.path}`,
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\u003c')}</script>`;
}

/**
 * Service schema for a service page.
 *
 * provider points at the pharmacy by name, and areaServed carries the city.
 * Nothing here is asserted that the profile does not already contain.
 */
function serviceData(page, pharmacy, profile) {
  if (page?.kind !== 'service' || !pharmacy?.name) return '';
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: page.label,
    provider: { '@type': 'Pharmacy', name: pharmacy.name },
  };
  if (page.description) data.description = page.description;
  if (profile?.city) data.areaServed = { '@type': 'City', name: profile.city };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\u003c')}</script>`;
}

/**
 * A JSON-LD block.
 *
 * Only "<" is escaped, and that is exact rather than cautious: the content
 * must remain valid JSON, so HTML-escaping the quotes would break it, and
 * escaping "<" alone is precisely enough that "</script>" cannot terminate
 * the element early from inside a string.
 */
function ldScript(data) {
  const json = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Article schema for a health page.
 *
 * author and reviewedBy are emitted ONLY when a real person is named. Google
 * treats reviewedBy as a credibility signal for health content, which is
 * exactly why software must not be able to produce one on its own: a
 * fabricated reviewer is not a cosmetic defect but a false claim about a
 * named professional, published and indexed.
 *
 * dateModified comes from the article, never from the clock. Stamping today
 * on every render would tell a crawler the content changed when it did not.
 */
function articleData(page, pharmacy, canonicalBase) {
  if (page?.kind !== 'health' || !page.article) return '';
  const a = page.article;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.summary,
  };
  if (canonicalBase && page.path) data.mainEntityOfPage = `${canonicalBase}${page.path}`;
  if (pharmacy?.name) data.publisher = { '@type': 'Pharmacy', name: pharmacy.name };
  if (a.updatedAt) data.dateModified = a.updatedAt;
  if (a.author?.name) {
    data.author = { '@type': 'Person', name: a.author.name };
    if (a.author.title) data.author.jobTitle = a.author.title;
  }
  if (a.reviewer?.name) {
    data.reviewedBy = { '@type': 'Person', name: a.reviewer.name };
    if (a.reviewer.title) data.reviewedBy.jobTitle = a.reviewer.title;
  }
  return ldScript(data);
}
/**
 * The floating WhatsApp button.
 *
 * IN THE DOCUMENT SHELL, NOT IN A BLOCK, and deliberately: it belongs to every
 * page of the site including the generated ones, which are composed from the
 * profile rather than from blocks. Putting it in the block registry would mean
 * adding it to three template seeds and it would still be absent from
 * /services/blood-pressure-check/, which is exactly the page a customer reads
 * before deciding to ask a question.
 *
 * NOTHING IS RENDERED WITHOUT A NUMBER. Same rule as every other WhatsApp
 * control on the site: a floating button that opens nothing is worse than no
 * button, because it is the most prominent thing on the page.
 *
 * It routes through the tracking redirect when there is one, so a tap here is
 * counted the same as a tap on any other WhatsApp button — otherwise the most
 * used control on the site would be the one control the pharmacy's analytics
 * could not see.
 *
 * The label is visible on a wide screen and collapses to the glyph on a
 * phone, where the button sits over content and a pill would cover more of
 * it. aria-label carries the full text either way.
 */
function floatingWhatsapp(ctx) {
  const number = ctx.pharmacy?.public_whatsapp_number;
  const href = waHref(number, null, ctx);
  if (!href) return '';

  const glyph = whatsappGlyph({ className: 'rx-fab-glyph', size: 26 });

  return `<a class="rx-fab" href="${esc(href)}" rel="noopener noreferrer" target="_blank"`
    + ` aria-label="Chat with us on WhatsApp">${glyph}`
    + `<span class="rx-fab-label">Chat with us</span></a>`;
}

/**
 * Render the complete document.
 *
 * ONE HEAD ASSEMBLER FOR EVERY PAGE. The home page composes its body from the
 * owner's blocks and the generated pages compose theirs from the profile, but
 * both arrive here for their title, description, canonical and structured
 * data. Two assemblers would drift, and the way that drift shows up is a
 * second canonical tag or a page quietly missing one — neither of which is
 * visible to anybody looking at the site.
 *
 * `noindex` is set for previews. A draft that a search engine crawled would
 * be a half-finished pharmacy website in results, outranking nothing and
 * embarrassing someone.
 */
function renderDocument({
  site, pharmacy, profile, assets, assetBaseUrl, theme, noindex = false, year, trackingBase,
  page = null, pages = null, canonicalBase = '', bodyHtml = null,
} = {}) {
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

  const body = bodyHtml != null ? bodyHtml : renderSite(site || { blocks: [] }, ctx);
  const resolved = resolveTheme(theme);

  // The page's own metadata wins. Falling back to the site-wide title is what
  // makes this safe to call for the home page, which has no page record.
  const title = page?.title || pageTitle(ctx.pharmacy, ctx.profile);
  const description = page?.description || pageDescription(ctx.pharmacy, ctx.profile);

  // A canonical is only emitted when we know the site's real origin. Guessing
  // one is worse than omitting it: a wrong canonical tells Google to index a
  // URL that may not exist, and it does so silently.
  const canonical = canonicalBase && page?.path ? `${canonicalBase}${page.path}` : '';
  const logo = ctx.profile?.logo_asset_id ? assetUrl(ctx.profile.logo_asset_id, ctx) : '';
  const trail = pages && page ? breadcrumbsFor(pages, page.path) : [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
${ctx.pharmacy?.name ? `<meta property="og:site_name" content="${esc(ctx.pharmacy.name)}">` : ''}
${logo ? `<meta property="og:image" content="${esc(logo)}">` : ''}
<meta name="twitter:card" content="${logo ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${logo ? `<meta name="twitter:image" content="${esc(logo)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${esc(resolved.googleFonts.replace(/\|/g, '&family='))}&display=swap">
<style>${stylesheet(theme)}</style>
${structuredData(ctx.pharmacy, ctx.profile)}
${breadcrumbData(trail, canonicalBase)}
${serviceData(page, ctx.pharmacy, ctx.profile)}
${articleData(page, ctx.pharmacy, canonicalBase)}
</head>
<body>
${body}
${floatingWhatsapp(ctx)}
</body>
</html>`;
}

module.exports = {
  renderDocument, pageTitle, pageDescription, structuredData, breadcrumbData, serviceData, articleData,
};
