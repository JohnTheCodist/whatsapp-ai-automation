/**
 * services/website/pages.js — the site map every other part is derived from.
 *
 * WHY THIS IS WORTH TESTING HARD
 * The router serves from this, the sitemap is generated from it, breadcrumbs
 * and internal links are built from it, and every title and description comes
 * out of it. A page that exists here but nowhere else is a 404 in a sitemap;
 * a page that exists everywhere but here is an orphan nothing links to. Both
 * are ordinary SEO failures and both are impossible while one function
 * decides what exists — provided that function is right.
 *
 * Pure by construction: no database, no clock, no I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPages, navPages, breadcrumbsFor, slugify, catalogueFor,
} = require('../services/website/pages');

const pharmacy = { name: 'Ikeja Family Pharmacy' };
const fullProfile = {
  city: 'Ikeja',
  state: 'Lagos',
  address_line: '12 Allen Avenue',
  description: 'A community pharmacy serving Allen Avenue since 2011.',
  services: [{ name: 'Prescription refills' }, { name: 'BP check' }],
};

const paths = (pages) => pages.map((p) => p.path);

test('every page has a unique path', () => {
  // Two pages at one URL is not a cosmetic problem: whichever the router
  // reaches first silently wins, and the sitemap advertises a duplicate.
  const pages = buildPages({ pharmacy, profile: fullProfile });
  assert.equal(new Set(paths(pages)).size, pages.length);
});

test('every page has a unique, non-generic title', () => {
  const pages = buildPages({ pharmacy, profile: fullProfile });
  const titles = pages.map((p) => p.title);
  assert.equal(new Set(titles).size, titles.length, 'titles must be unique');
  for (const t of titles) {
    assert.ok(t && t.length > 10, `title too thin: ${t}`);
    assert.doesNotMatch(t, /^(home|welcome)/i, `generic title: ${t}`);
  }
});

test('every page has exactly one H1 defined', () => {
  const pages = buildPages({ pharmacy, profile: fullProfile });
  for (const p of pages) {
    assert.ok(p.h1 && p.h1.trim().length > 0, `no h1 for ${p.path}`);
  }
});

test('the city appears in titles, because that is what people search', () => {
  const pages = buildPages({ pharmacy, profile: fullProfile });
  const home = pages.find((p) => p.path === '/');
  assert.match(home.title, /Ikeja/);
});

test('a pharmacy with no city still gets titles that read', () => {
  const pages = buildPages({ pharmacy, profile: { services: [{ name: 'BP check' }] } });
  for (const p of pages) {
    assert.doesNotMatch(p.title, /undefined|null|—\s*$/, p.title);
  }
});

test('pages are not created for information the pharmacy does not have', () => {
  // A generated page with nothing real on it is a thin page, and a site full
  // of them ranks worse than a small site that is entirely substantial.
  const bare = buildPages({ pharmacy, profile: {} });
  assert.deepEqual(paths(bare), ['/', '/contact/']);
  assert.ok(!paths(bare).includes('/about/'), 'no description, no about page');
  assert.ok(!paths(bare).includes('/location/'), 'no address, no location page');
  assert.ok(!paths(bare).includes('/services/'), 'no services, no services page');
});

test('a service the pharmacy does not offer gets no page', () => {
  const pages = buildPages({
    pharmacy,
    profile: { ...fullProfile, services: [{ name: 'Prescription refills' }] },
  });
  assert.ok(paths(pages).includes('/services/prescription-refills/'));
  assert.ok(!paths(pages).includes('/services/blood-glucose-testing/'));
});

test('differently-worded services that mean the same thing share one URL', () => {
  // Owners write "Refills", "Prescription refill", "Repeat prescriptions".
  // Four URLs with the same content compete with each other; one URL with
  // four sources of authority does not.
  const pages = buildPages({
    pharmacy,
    profile: {
      ...fullProfile,
      services: [
        { name: 'Prescription refill' },
        { name: 'Repeat prescriptions' },
        { name: 'Refill my prescription' },
      ],
    },
  });
  const service = paths(pages).filter((p) => p.startsWith('/services/') && p !== '/services/');
  assert.deepEqual(service, ['/services/prescription-refills/']);
});

test('a service outside the catalogue still gets a sensible URL', () => {
  const pages = buildPages({
    pharmacy,
    profile: { ...fullProfile, services: [{ name: 'Wound Dressing & Care' }] },
  });
  assert.ok(paths(pages).includes('/services/wound-dressing-and-care/'));
});

test('a service whose name cannot become a URL is dropped, not guessed at', () => {
  const pages = buildPages({
    pharmacy,
    profile: { ...fullProfile, services: [{ name: '!!!' }, { name: '   ' }, { name: '2024' }] },
  });
  assert.ok(!paths(pages).some((p) => p.startsWith('/services/')), JSON.stringify(paths(pages)));
});

test('every path is URL-safe and ends in a slash', () => {
  const pages = buildPages({
    pharmacy,
    profile: { ...fullProfile, services: [{ name: 'Chemêst & Co' }, { name: 'A/B testing' }] },
  });
  for (const p of pages) {
    assert.match(p.path, /^\/([a-z0-9-]+\/)*$/, `unsafe path: ${p.path}`);
  }
});

test('health pages appear only for topics the owner enabled', () => {
  const library = [
    { slug: 'hypertension', title: 'Understanding high blood pressure', summary: 's' },
    { slug: 'diabetes', title: 'Living with diabetes', summary: 's' },
  ];
  const none = buildPages({ pharmacy, profile: fullProfile, healthLibrary: library });
  assert.ok(!paths(none).includes('/health/'), 'health is opt-in, not default');

  const one = buildPages({
    pharmacy, profile: fullProfile, health: ['hypertension'], healthLibrary: library,
  });
  assert.ok(paths(one).includes('/health/'));
  assert.ok(paths(one).includes('/health/hypertension/'));
  assert.ok(!paths(one).includes('/health/diabetes/'));
});

test('an enabled topic with no article does not create an empty page', () => {
  const pages = buildPages({
    pharmacy, profile: fullProfile, health: ['nonexistent'], healthLibrary: [],
  });
  assert.ok(!paths(pages).includes('/health/'));
});

test('navigation is one level and excludes the home page', () => {
  const pages = buildPages({ pharmacy, profile: fullProfile });
  const nav = navPages(pages);
  assert.ok(!nav.some((p) => p.path === '/'), 'home is the logo, not a nav item');
  assert.ok(!nav.some((p) => p.parent), 'service pages are reached from /services/');
  assert.deepEqual(nav.map((p) => p.nav), ['About', 'Services', 'Location', 'Contact']);
});

test('breadcrumbs run home -> section -> page', () => {
  const pages = buildPages({ pharmacy, profile: fullProfile });
  const crumbs = breadcrumbsFor(pages, '/services/blood-pressure-check/');
  assert.deepEqual(crumbs.map((c) => c.path), ['/', '/services/', '/services/blood-pressure-check/']);
});

test('the home page has no breadcrumbs', () => {
  // A trail whose only entry is the page you are on is decoration.
  const pages = buildPages({ pharmacy, profile: fullProfile });
  assert.deepEqual(breadcrumbsFor(pages, '/'), []);
});

test('breadcrumbs for an unknown path are empty rather than invented', () => {
  const pages = buildPages({ pharmacy, profile: fullProfile });
  assert.deepEqual(breadcrumbsFor(pages, '/nope/'), []);
});

test('every non-home page is reachable from another page', () => {
  // The orphan check. A page in the sitemap that nothing links to is a page
  // Google is told about and given no reason to value.
  const pages = buildPages({ pharmacy, profile: fullProfile });
  const nav = new Set(navPages(pages).map((p) => p.path));
  for (const page of pages) {
    if (page.path === '/') continue;
    const linked = nav.has(page.path) || (page.parent && nav.has(page.parent));
    assert.ok(linked, `orphan page: ${page.path}`);
  }
});

test('catalogue matching does not fire on unrelated words', () => {
  // "Pressure" alone must not become a blood pressure page.
  assert.equal(catalogueFor('Pressure washing'), null);
  assert.equal(catalogueFor('Sugar-free sweets'), null);
  assert.equal(catalogueFor(''), null);
  assert.equal(catalogueFor(null), null);
});

test('slugify refuses rather than producing something unusable', () => {
  assert.equal(slugify(''), null);
  assert.equal(slugify('!!!'), null);
  assert.equal(slugify('2024'), null);
  assert.equal(slugify(null), null);
  assert.equal(slugify(undefined), null);
});
