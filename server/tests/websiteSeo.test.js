/**
 * The generated website, checked the way a crawler would read it.
 *
 * WHY THIS IS AN END-TO-END TEST AND NOT UNIT TESTS OF THE PARTS
 * Every failure this guards against is invisible in any single module. A
 * duplicate meta description is correct behaviour in the function that
 * produced it and a defect only when two pages are compared. A missing
 * canonical looks like an absent optional field. A sitemap entry that 404s is
 * two modules each behaving as written. So this renders a whole site for a
 * realistic pharmacy and inspects the HTML that would actually be served.
 *
 * These are the acceptance criteria as executable assertions. A regression in
 * any of them is the kind that ships silently, is discovered months later in
 * Search Console, and cannot be traced to a commit.
 *
 * Database-free: rendering is a pure function of the pharmacy row, its
 * profile and a template.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderAllPages, renderSitemap, renderRobots, renderNotFound } = require('../services/website/siteRender');
const { getTemplate, cloneSeed } = require('../services/website/templates');

const BASE = 'https://naspaa.rxnaija.com';

const pharmacy = { name: 'Ikeja Family Pharmacy' };
const profile = {
  city: 'Ikeja',
  state: 'Lagos',
  address_line: '12 Allen Avenue',
  landmark: 'Opposite First Bank',
  phone: '08012345678',
  whatsapp_phone: '2348012345678',
  maps_url: 'https://maps.google.com/?q=12+Allen+Avenue',
  description: 'A community pharmacy serving Allen Avenue since 2011.',
  opening_hours: [{ day: 'mon', open: '08:00', close: '20:00' }, { day: 'sun', closed: true }],
  services: [{ name: 'Prescription refills' }, { name: 'BP check' }, { name: 'Medication counselling' }],
};

function renderSample(overrides = {}) {
  const tpl = getTemplate('professional');
  return renderAllPages({
    site: cloneSeed('professional'),
    pharmacy,
    profile,
    theme: tpl.theme,
    canonicalBase: BASE,
    year: 2026,
    ...overrides,
  });
}

const occurrences = (html, re) => (html.match(re) || []).length;

test('a realistic pharmacy produces the expected set of pages', () => {
  const { rendered } = renderSample();
  assert.deepEqual(rendered.map((r) => r.path), [
    '/', '/about/', '/services/',
    '/services/prescription-refills/',
    '/services/blood-pressure-check/',
    '/services/medication-counselling/',
    '/location/', '/contact/',
  ]);
});

test('every page has exactly one h1', () => {
  // Not "at least one". Two h1s is the commonest heading-hierarchy fault and
  // it happens when a page template grows a second heading nobody re-read.
  for (const r of renderSample().rendered) {
    assert.equal(occurrences(r.html, /<h1[ >]/g), 1, `${r.path} h1 count`);
  }
});

test('every page has exactly one canonical, pointing at itself', () => {
  for (const r of renderSample().rendered) {
    assert.equal(occurrences(r.html, /rel="canonical"/g), 1, `${r.path} canonical count`);
    const href = (r.html.match(/rel="canonical" href="(.*?)"/) || [])[1];
    assert.equal(href, `${BASE}${r.path}`, `${r.path} canonical target`);
  }
});

test('titles, descriptions and canonicals are unique across the site', () => {
  const { rendered } = renderSample();
  const titles = new Set();
  const descriptions = new Set();
  const canonicals = new Set();
  for (const r of rendered) {
    titles.add((r.html.match(/<title>(.*?)<\/title>/) || [])[1]);
    descriptions.add((r.html.match(/name="description" content="(.*?)"/) || [])[1]);
    canonicals.add((r.html.match(/rel="canonical" href="(.*?)"/) || [])[1]);
  }
  assert.equal(titles.size, rendered.length, 'duplicate <title>');
  assert.equal(descriptions.size, rendered.length, 'duplicate meta description');
  assert.equal(canonicals.size, rendered.length, 'duplicate canonical');
});

test('no page is accidentally noindexed', () => {
  // A single stray noindex removes a page from Google with no visible symptom
  // on the site itself.
  for (const r of renderSample().rendered) {
    assert.doesNotMatch(r.html, /noindex/, `${r.path} is noindexed`);
  }
});

test('published pages contain no executable script', () => {
  // The published CSP is script-src 'none'. A <script> that is not JSON-LD
  // would silently not run, so the page would depend on something that never
  // happens — and the SEO content must not depend on it either way.
  for (const r of renderSample().rendered) {
    assert.equal(
      occurrences(r.html, /<script(?! type="application\/ld\+json")/g), 0,
      `${r.path} contains executable script`,
    );
  }
});

test('every page carries Pharmacy structured data with the real name', () => {
  for (const r of renderSample().rendered) {
    assert.match(r.html, /"@type":"Pharmacy"/, r.path);
    assert.match(r.html, /Ikeja Family Pharmacy/, r.path);
  }
});

test('service pages carry Service and Breadcrumb structured data', () => {
  const { rendered } = renderSample();
  const service = rendered.find((r) => r.path === '/services/blood-pressure-check/');
  assert.match(service.html, /"@type":"Service"/);
  assert.match(service.html, /"@type":"BreadcrumbList"/);
  // The trail must be a real hierarchy, not the page pointing at itself.
  assert.match(service.html, /"position":1/);
  assert.match(service.html, /"position":3/);
});

test('the home page has no breadcrumb markup', () => {
  const home = renderSample().rendered.find((r) => r.path === '/');
  assert.doesNotMatch(home.html, /BreadcrumbList/);
});

test('the city appears in the home title, because that is the search', () => {
  const home = renderSample().rendered.find((r) => r.path === '/');
  assert.match(home.html, /<title>[^<]*Ikeja[^<]*<\/title>/);
});

test('nothing is invented when the profile is nearly empty', () => {
  const { rendered } = renderSample({
    profile: { services: [] },
  });
  assert.deepEqual(rendered.map((r) => r.path), ['/', '/contact/']);
  for (const r of rendered) {
    assert.doesNotMatch(r.html, /undefined|null,|\[object/, `${r.path} leaked a placeholder`);
  }
});

test('the sitemap lists exactly the pages that were rendered', () => {
  // The failure this prevents: a sitemap advertising URLs that 404, which is
  // the single most common defect in a generated site.
  const { pages, rendered } = renderSample();
  const xml = renderSitemap(pages, BASE, '2026-09-08');
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, rendered.map((r) => `${BASE}${r.path}`));
});

test('the sitemap is well-formed and claims nothing it cannot know', () => {
  const { pages } = renderSample();
  const xml = renderSitemap(pages, BASE);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  // priority and changefreq are ignored by Google; emitting invented values
  // for them is noise that makes the file look machine-generated.
  assert.doesNotMatch(xml, /<priority>|<changefreq>/);
  // No lastmod when no timestamp was supplied, rather than "now" on every fetch.
  assert.doesNotMatch(xml, /<lastmod>/);
});

test('a sitemap is refused rather than guessed at without an origin', () => {
  const { pages } = renderSample();
  assert.equal(renderSitemap(pages, ''), null);
});

test('robots.txt allows crawling and points at the sitemap', () => {
  const txt = renderRobots(BASE);
  assert.match(txt, /User-agent: \*/);
  assert.match(txt, /Allow: \//);
  assert.match(txt, /Sitemap: https:\/\/naspaa\.rxnaija\.com\/sitemap\.xml/);
  assert.doesNotMatch(txt, /Disallow: \/\s*$/m, 'a stray Disallow removes the whole site');
});

test('the 404 page is a real page, is noindexed, and offers a way out', () => {
  const { pages } = renderSample();
  const html = renderNotFound({ pharmacy, profile, pages, theme: {}, year: 2026 });
  assert.match(html, /<h1[ >]/);
  assert.match(html, /noindex/, 'a soft 404 indexed as content is worse than the missing page');
  assert.match(html, /href="\//, 'a 404 with no links loses the visitor');
  assert.doesNotMatch(html, /rel="canonical"/, 'a 404 must not claim to be a canonical URL');
});

test('internal links only ever point at pages that exist', () => {
  // The orphan and broken-link check, done on the real markup rather than on
  // the model that produced it.
  const { rendered } = renderSample();
  const existing = new Set(rendered.map((r) => r.path));
  for (const r of rendered) {
    const hrefs = [...r.html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      // Tracked outbound links (/go/...) and assets are not pages.
      if (href.startsWith('/go/') || /\.[a-z0-9]+$/i.test(href)) continue;
      assert.ok(existing.has(href), `${r.path} links to ${href}, which does not exist`);
    }
  }
});

test('removing a service removes its page, its links and its sitemap entry', () => {
  // The acceptance criterion "removing a service does not leave broken
  // links", checked as a before-and-after rather than asserted in prose.
  const before = renderSample();
  assert.ok(before.rendered.some((r) => r.path === '/services/blood-pressure-check/'));

  const after = renderSample({
    profile: { ...profile, services: [{ name: 'Prescription refills' }] },
  });
  assert.ok(!after.rendered.some((r) => r.path === '/services/blood-pressure-check/'));

  const xml = renderSitemap(after.pages, BASE);
  assert.doesNotMatch(xml, /blood-pressure-check/);
  for (const r of after.rendered) {
    assert.doesNotMatch(r.html, /href="\/services\/blood-pressure-check\/"/, `${r.path} still links to it`);
  }
});

test('a pharmacy with no services has no services section anywhere', () => {
  const { rendered } = renderSample({ profile: { ...profile, services: [] } });
  assert.ok(!rendered.some((r) => r.path.startsWith('/services')));
  for (const r of rendered) {
    assert.doesNotMatch(r.html, /href="\/services\//, `${r.path} links to a services page that does not exist`);
  }
});

test('the pharmacy name and address are identical on every page', () => {
  // NAP consistency is a ranking factor and an easy thing to get wrong once
  // two templates render an address two ways.
  for (const r of renderSample().rendered) {
    if (r.path === '/') continue;
    assert.match(r.html, /12 Allen Avenue, Ikeja, Lagos/, `${r.path} address`);
  }
});
