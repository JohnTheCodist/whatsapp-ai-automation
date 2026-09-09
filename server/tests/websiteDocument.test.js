/**
 * The theme, the stylesheet and the published document.
 *
 * NO DATABASE, so all of it always runs. This is the code that decides what a
 * pharmacy's website literally looks like and what a search engine reads off
 * it, and it is entirely deterministic given a profile — which makes it
 * exactly the kind of thing that should be tested where the tests actually
 * execute rather than behind TEST_DATABASE_URL.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const theme = require('../services/website/blocks/theme');
const { stylesheet } = require('../services/website/blocks/stylesheet');
const { renderDocument, pageTitle, pageDescription } = require('../services/website/document');
const templates = require('../services/website/templates');

const PHARMACY = Object.freeze({ name: 'Ikeja Family Pharmacy', public_whatsapp_number: '2348012345678' });
const PROFILE = Object.freeze({
  phone: '08012345678',
  address_line: '12 Allen Avenue',
  city: 'Ikeja',
  state: 'Lagos',
  maps_url: 'https://maps.google.com/?q=ikeja',
  description: 'Family run since 2014.',
  services: [{ name: 'Prescriptions' }],
  opening_hours: [{ day: 'mon', open: '08:00', close: '20:00' }],
});

// =====================================================================
// THEME
// =====================================================================

test('a valid theme passes and an unknown option is rejected by name', () => {
  assert.equal(theme.validateTheme({ palette: 'green', font: 'bold', corners: 'round' }).ok, true);

  const bad = theme.validateTheme({ palette: 'chartreuse' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /palette/);

  const unknown = theme.validateTheme({ shadows: 'heavy' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /shadows/, 'the error must name the setting that does not exist');
});

test('an empty theme is valid and resolves to a complete look', () => {
  assert.equal(theme.validateTheme({}).ok, true);
  const resolved = theme.resolveTheme({});
  for (const key of ['primary', 'onPrimary', 'ink', 'surface', 'radius', 'fontDisplay', 'fontText']) {
    assert.ok(resolved[key], `${key} must be resolved even for a site that has chosen nothing`);
  }
});

test('brandColor must be a hex, and anything else is refused', () => {
  assert.equal(theme.validateTheme({ brandColor: '#0F766E' }).value.brandColor, '#0f766e');
  for (const bad of ['red', '#fff', 'rgb(1,2,3)', 'javascript:alert(1)', 42, '#gggggg']) {
    assert.equal(theme.validateTheme({ brandColor: bad }).ok, false, `${bad} must be refused`);
  }
});

/**
 * THE GUARDRAIL THAT MAKES A FREE-FORM COLOUR SAFE.
 *
 * brandColor is the only value in the whole theme an owner types rather than
 * picks. It cannot produce an unreadable button because the foreground is
 * derived from its luminance rather than chosen alongside it — so a pale
 * yellow gets dark text automatically.
 */
test('text on a brand colour is chosen by luminance, not by the owner', () => {
  assert.equal(theme.resolveTheme({ brandColor: '#ffe14d' }).onPrimary, '#0f172a', 'dark text on a pale colour');
  assert.equal(theme.resolveTheme({ brandColor: '#0b3d2c' }).onPrimary, '#ffffff', 'light text on a dark colour');
});

test('every curated palette produces readable text on its own primary', () => {
  for (const [id] of Object.entries(theme.PALETTES)) {
    const r = theme.resolveTheme({ palette: id });
    assert.ok(['#0f172a', '#ffffff'].includes(r.onPrimary), `${id} must resolve a foreground`);
  }
});

// =====================================================================
// STYLESHEET
// =====================================================================

test('the stylesheet carries the resolved theme and never leaks an undefined', () => {
  const css = stylesheet({ palette: 'plum', corners: 'sharp' });
  assert.ok(css.includes(theme.PALETTES.plum.primary), 'the chosen palette must reach the CSS');
  assert.ok(!css.includes('undefined'), 'an unresolved value would ship as literal "undefined"');
  assert.ok(!css.includes('NaN'));
});

test('the stylesheet is mobile-first — the grid columns arrive in media queries', () => {
  const css = stylesheet({});
  const base = css.split('@media')[0];
  assert.ok(!base.includes('grid-template-columns'),
    'the phone layout must not have to undo a desktop assumption');
  assert.ok(css.includes('@media (min-width:640px)'));
});

test('an invalid stored theme still produces a usable stylesheet', () => {
  // Data can reach the renderer without passing today's validator — an older
  // version, a migration, a future admin tool. A public page must not break
  // over it.
  const css = stylesheet({ palette: 'does-not-exist', font: 'nope', corners: 'nope' });
  assert.ok(css.includes('--rx-primary'));
  assert.ok(!css.includes('undefined'));
});

// =====================================================================
// DOCUMENT
// =====================================================================

test('the title names the business and where it is', () => {
  // "Ikeja Family Pharmacy" alone competes with every pharmacy of that name
  // in the country. The city is the highest-value thing available here.
  assert.equal(pageTitle(PHARMACY, PROFILE), 'Ikeja Family Pharmacy — Pharmacy in Ikeja');
  assert.equal(pageTitle(PHARMACY, {}), 'Ikeja Family Pharmacy — Pharmacy');
  assert.equal(pageTitle({}, {}), 'Pharmacy — Pharmacy');
});

test('the description uses the pharmacy’s own words when it has them', () => {
  assert.equal(pageDescription(PHARMACY, PROFILE), 'Family run since 2014.');
  // And falls back to facts, never to invented marketing copy.
  const fallback = pageDescription(PHARMACY, { city: 'Ikeja', address_line: '12 Allen Avenue' });
  assert.match(fallback, /12 Allen Avenue/);
});

test('a long description is truncated rather than shipped whole to a meta tag', () => {
  const long = 'a'.repeat(400);
  const d = pageDescription(PHARMACY, { description: long });
  assert.ok(d.length <= 160, `was ${d.length}`);
  assert.ok(d.endsWith('…'));
});

test('a full document renders with the parts a browser and a crawler both need', () => {
  const html = renderDocument({
    site: templates.cloneSeed('professional'),
    pharmacy: PHARMACY, profile: PROFILE, theme: { palette: 'teal' }, year: 2026,
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>Ikeja Family Pharmacy/);
  assert.match(html, /<meta name="description"/);
  assert.match(html, /--rx-primary/, 'the stylesheet must be inlined');
  assert.match(html, /wa\.me\/2348012345678/);
});

/**
 * The published page contains no executable JavaScript at all.
 *
 * The one <script> is `application/ld+json`, which browsers do not run and
 * search engines do read. `script-src 'none'` in the response CSP means
 * anything else would be blocked anyway — this asserts we never emit it in
 * the first place, so the CSP is a second line rather than the only one.
 */
test('the only script tag in a published page is structured data', () => {
  for (const t of templates.TEMPLATES) {
    const html = renderDocument({
      site: templates.cloneSeed(t.id), pharmacy: PHARMACY, profile: PROFILE, theme: t.theme,
    });
    const scripts = html.match(/<script[^>]*>/g) || [];
    for (const tag of scripts) {
      assert.match(tag, /type="application\/ld\+json"/, `${t.id} emitted an executable script tag`);
    }
  }
});

test('structured data cannot be broken out of by pharmacy text', () => {
  // A name containing `</script>` would otherwise close the JSON-LD element
  // early and leave the rest of the object as page content.
  const html = renderDocument({
    site: { blocks: [] },
    pharmacy: { name: 'Bad </script><script>alert(1)</script> Pharmacy' },
    profile: {},
  });
  assert.ok(!html.includes('</script><script>alert(1)'), 'the tag must not be escapable');
  assert.ok(html.includes('\\u003c'), '< must be unicode-escaped inside the JSON');
});

test('a pharmacy with no name emits no structured data rather than an empty claim', () => {
  const html = renderDocument({ site: { blocks: [] }, pharmacy: {}, profile: {} });
  assert.ok(!html.includes('application/ld+json'),
    'asserting an anonymous business to a search engine is worse than asserting nothing');
});

test('a preview is marked noindex and a published page is not', () => {
  const preview = renderDocument({ site: { blocks: [] }, pharmacy: PHARMACY, profile: PROFILE, noindex: true });
  assert.match(preview, /noindex/);
  const live = renderDocument({ site: { blocks: [] }, pharmacy: PHARMACY, profile: PROFILE });
  assert.ok(!live.includes('noindex'));
});

test('head values are escaped, so a quote in a pharmacy name cannot break a meta tag', () => {
  const html = renderDocument({
    site: { blocks: [] },
    pharmacy: { name: 'The "Best" Pharmacy' },
    profile: { description: 'We say "hello".' },
  });
  assert.ok(!/content="[^"]*"Best"/.test(html), 'the attribute must not be escapable');
  assert.ok(html.includes('&quot;'));
});

test('rendering a document is deterministic', () => {
  const args = { site: templates.cloneSeed('premium'), pharmacy: PHARMACY, profile: PROFILE, theme: { palette: 'slate' }, year: 2026 };
  assert.equal(renderDocument(args), renderDocument(args));
});

// =====================================================================
// TEMPLATES
// =====================================================================

test('every registered template is one of the ones this suite knows about', () => {
  // Named explicitly, not just counted — a typo'd id or an accidental
  // duplicate registration should fail this loudly rather than pass because
  // the length still matched. Extend this list in the same commit that adds
  // a template to templates.js.
  const ids = templates.TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids.sort(), ['family', 'metro', 'modern', 'premium', 'professional']);
});

test('each template carries a valid theme of its own', () => {
  // Three templates that all looked the same would be one template with the
  // sections shuffled.
  const seen = new Set();
  for (const t of templates.TEMPLATES) {
    const checked = theme.validateTheme(t.theme);
    assert.equal(checked.ok, true, `${t.id}: ${checked.error}`);
    seen.add(`${t.theme.palette}/${t.theme.font}/${t.theme.corners}`);
  }
  assert.equal(seen.size, templates.TEMPLATES.length, 'each template must look different');
});

test('every template renders a complete page from a pharmacy profile alone', () => {
  for (const t of templates.TEMPLATES) {
    const html = renderDocument({
      site: templates.cloneSeed(t.id), pharmacy: PHARMACY, profile: PROFILE, theme: t.theme, year: 2026,
    });
    assert.match(html, /Ikeja Family Pharmacy/, `${t.id}: the pharmacy name must appear`);
    assert.match(html, /wa\.me\/2348012345678/, `${t.id}: the WhatsApp CTA must appear`);
    assert.match(html, /12 Allen Avenue/, `${t.id}: the address must appear`);
    assert.ok(html.length > 4000, `${t.id}: rendered suspiciously short (${html.length})`);
  }
});

test('the template list ships metadata the picker needs and no seed payload', () => {
  for (const t of templates.listTemplates()) {
    assert.ok(t.name && t.description && t.theme, `${t.id} needs card metadata`);
    assert.ok(Array.isArray(t.blocks), `${t.id} must list its sections for the card`);
    assert.equal(t.seed, undefined, 'the seed stays server-side');
  }
});

// =====================================================================
// PHOTOGRAPHS
// =====================================================================
//
// A real photograph of the shop is the strongest trust signal a small local
// business can put on a page. The risks are narrow and worth pinning: an
// image with no alt is invisible to a screen reader and worthless to a search
// engine; one with no dimensions shifts the page as it loads; and an asset
// map is the one place another tenant's file could leak into a public page.

const { renderAllPages } = require('../services/website/siteRender');

const PHOTO_PROFILE = {
  city: 'Ikeja',
  state: 'Lagos',
  address_line: '12 Allen Avenue',
  description: 'A community pharmacy serving Allen Avenue since 2011.',
  services: [{ name: 'BP check' }],
};

/** An asset map shaped exactly like assetMapFor's output. */
function assetMap(rows) {
  return new Map(rows.map((r) => [r.id, {
    storage_path: r.path, kind: r.kind, width: r.width ?? null, height: r.height ?? null,
  }]));
}

function renderWithPhotos(rows) {
  return renderAllPages({
    site: templates.cloneSeed('professional'),
    pharmacy: PHARMACY,
    profile: PHOTO_PROFILE,
    theme: templates.getTemplate('professional').theme,
    assets: assetMap(rows),
    assetBaseUrl: 'https://cdn.example.com',
    year: 2026,
  }).rendered;
}

const IMG = /<img[^>]*>/g;

test('every image carries alt text, and none of it is invented', () => {
  // PHOTO_PROFILE's one service ("BP check") also matches servicePhotos.js's
  // catalogue, so the home page carries three kinds of <img> at once: the
  // owner's own hero and gallery photos, AND a stock illustration for the
  // service. All three need real alt text; only the first two may claim to
  // depict this pharmacy, because only the first two actually do.
  const pages = renderWithPhotos([
    { id: 'a1', path: 'ph/1.jpg', kind: 'hero', width: 1200, height: 900 },
    { id: 'a2', path: 'ph/2.jpg', kind: 'gallery', width: 800, height: 600 },
  ]);
  let seenOwnPhoto = 0;
  let seenServicePhoto = 0;
  for (const page of pages) {
    for (const img of page.html.match(IMG) || []) {
      assert.match(img, /alt="[^"]+"/, `${page.path}: image with no alt — ${img}`);
      if (img.includes('rx-service-photo')) {
        seenServicePhoto += 1;
        // A stock photo of tablets did not come from this pharmacy's own
        // camera. Claiming it did — even only in metadata a sighted visitor
        // never reads — is the same false claim this codebase refuses to
        // make in visible copy, and it is exactly the kind of mistake that
        // goes unnoticed precisely because nobody sighted checks it.
        assert.doesNotMatch(img, /alt="Ikeja Family Pharmacy, Ikeja, Lagos"/, `${page.path}: a stock photo claiming to BE the pharmacy — ${img}`);
      } else {
        seenOwnPhoto += 1;
        // Accurate, not invented, for the photos that ARE the owner's own:
        // we know whose pharmacy it is and where; we do not know what is in
        // the frame, and must not claim to.
        assert.match(img, /alt="Ikeja Family Pharmacy, Ikeja, Lagos"/, `${page.path}: ${img}`);
      }
    }
  }
  assert.ok(seenOwnPhoto > 0, 'no owner photos rendered at all');
  assert.ok(seenServicePhoto > 0, 'no service photo rendered — profile fixture may have drifted from servicePhotos.js\'s catalogue');
});

test('images declare width and height so the page does not shift as they load', () => {
  const pages = renderWithPhotos([
    { id: 'a1', path: 'ph/1.jpg', kind: 'hero', width: 1200, height: 900 },
  ]);
  const about = pages.find((p) => p.path === '/about/');
  assert.match(about.html, /width="1200" height="900"/);
});

test('a photo with unknown dimensions still renders, without empty attributes', () => {
  // Dimensions are nullable in the schema. A missing one must omit both rather
  // than emit width="" — which is invalid and which browsers treat as zero.
  const pages = renderWithPhotos([{ id: 'a1', path: 'ph/1.jpg', kind: 'hero' }]);
  const about = pages.find((p) => p.path === '/about/');
  assert.match(about.html, /<img[^>]*src="[^"]*ph\/1\.jpg"/);
  assert.doesNotMatch(about.html, /width=""|height=""/);
});

test('only the first photo loads eagerly; the rest wait until scrolled to', () => {
  const pages = renderWithPhotos([
    { id: 'a1', path: 'ph/1.jpg', kind: 'gallery', width: 800, height: 600 },
    { id: 'a2', path: 'ph/2.jpg', kind: 'gallery', width: 800, height: 600 },
    { id: 'a3', path: 'ph/3.jpg', kind: 'gallery', width: 800, height: 600 },
  ]);
  const location = pages.find((p) => p.path === '/location/');
  const imgs = location.html.match(IMG) || [];
  assert.ok(imgs.length >= 3);
  assert.match(imgs[0], /loading="eager"/);
  for (const img of imgs.slice(1)) assert.match(img, /loading="lazy"/);
});

test('the same photo is never rendered twice on one page', () => {
  // hero and gallery are both requested on /about/. A photo that somehow held
  // both kinds must still appear once.
  const pages = renderWithPhotos([
    { id: 'a1', path: 'ph/1.jpg', kind: 'hero', width: 10, height: 10 },
    { id: 'a2', path: 'ph/2.jpg', kind: 'gallery', width: 10, height: 10 },
  ]);
  const about = pages.find((p) => p.path === '/about/');
  const srcs = [...about.html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(srcs).size, srcs.length);
});

test('a pharmacy with no photographs renders no empty gallery', () => {
  const pages = renderWithPhotos([]);
  for (const page of pages) {
    assert.doesNotMatch(page.html, /<div class="rx-photo-grid"/, `${page.path} has an empty gallery`);
    assert.doesNotMatch(page.html, /What to look for/, `${page.path} has an orphan heading`);
  }
});

test('a logo is not silently reused as a shopfront photograph', () => {
  // 'logo' is a kind, and it is not a photo of the premises. Rendering it in
  // the gallery would put a cropped wordmark where a customer expects to see
  // the shop.
  const pages = renderWithPhotos([{ id: 'a1', path: 'ph/logo.png', kind: 'logo', width: 10, height: 10 }]);
  const location = pages.find((p) => p.path === '/location/');
  assert.doesNotMatch(location.html, /<div class="rx-photo-grid"/);
});

// =====================================================================
// pageCopy — an owner's own heading/intro/(for a service page) "about this
// service" wording, overriding the generated default. See websiteService.js's
// validatePageCopy for the shape this is validated to before it ever reaches
// here; these tests are about what RENDERING does with a value already known
// to be well-formed.
// =====================================================================

function renderWithPageCopy(pageCopy, extra = {}) {
  return renderAllPages({
    site: templates.cloneSeed('professional'),
    pharmacy: PHARMACY,
    profile: { ...PROFILE, services: [{ name: 'Blood Pressure Checks' }] },
    theme: templates.getTemplate('professional').theme,
    assets: new Map(),
    assetBaseUrl: 'https://cdn.example.com',
    year: 2026,
    pageCopy,
    ...extra,
  }).rendered;
}

test('a heading override replaces the generated <h1>, and an intro override replaces the generated lede', () => {
  const pages = renderWithPageCopy({
    '/about/': { heading: 'Meet the Team', intro: 'Serving Allen Avenue for over a decade.' },
  });
  const about = pages.find((p) => p.path === '/about/').html;
  assert.match(about, /<h1>Meet the Team<\/h1>/);
  assert.match(about, /Serving Allen Avenue for over a decade\./);
});

test('leaving intro blank keeps the generated intro; overriding it does not require also overriding the heading', () => {
  const pages = renderWithPageCopy({ '/location/': { heading: 'Come Say Hello' } });
  const location = pages.find((p) => p.path === '/location/').html;
  assert.match(location, /<h1>Come Say Hello<\/h1>/);
  // The generated lede for /location/ names the pharmacy and area — still
  // present, because this override only named a heading.
  assert.match(location, /Ikeja Family Pharmacy is a community pharmacy in Ikeja, Lagos\./);
});

test('an "about" override on a service page replaces the canned copy, not alongside it', () => {
  const pages = renderWithPageCopy({
    '/services/blood-pressure-check/': { about: 'We use a manual cuff and note your reading in your file.' },
  });
  const page = pages.find((p) => p.path === '/services/blood-pressure-check/').html;
  assert.match(page, /We use a manual cuff and note your reading in your file\./);
  assert.doesNotMatch(page, /What this involves/);
  assert.doesNotMatch(page, /What to expect/);
});

test('no "about" override leaves the canned copy exactly as it was', () => {
  const pages = renderWithPageCopy({});
  const page = pages.find((p) => p.path === '/services/blood-pressure-check/').html;
  assert.match(page, /What this involves/);
});

test('pageCopy cannot rewrite a reviewed health article — the channel is ignored for that page kind', () => {
  const approved = {
    slug: 'hypertension',
    title: 'High blood pressure: what it is and why checks matter',
    summary: 's', status: 'approved',
    reviewer: { name: 'Dr. Test', title: 'Pharmacist' }, reviewedAt: '2026-01-01',
    intro: 'The real, reviewed introduction.',
    sections: [], relatedServices: [], relatedArticles: [],
  };
  const pages = renderWithPageCopy(
    { '/health/hypertension/': { heading: 'A software-written heading', intro: 'Not reviewed by anyone.' } },
    { health: ['hypertension'], healthLibrary: [approved] },
  );
  const article = pages.find((p) => p.kind === 'health').html;
  assert.match(article, new RegExp(approved.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(article, /A software-written heading/);
  assert.doesNotMatch(article, /Not reviewed by anyone\./);
});

test('an unmentioned page renders with no trace of pageCopy at all', () => {
  const pages = renderWithPageCopy({ '/about/': { heading: 'X' } });
  const contact = pages.find((p) => p.path === '/contact/').html;
  assert.match(contact, /<h1>Contact Ikeja Family Pharmacy<\/h1>/);
});

// =====================================================================
// GENERATED PAGES ON THE METRO TEMPLATE
// =====================================================================

// A class NAME is also a CSS SELECTOR in the shared, always-inlined
// stylesheet, so a bare `.includes('rx-page-head--metro')` is true on every
// page regardless of whether that page actually uses the class — exactly
// the "<img>" hazard this file's stylesheet already carries a warning about,
// one level up. These check the actual rendered element instead.
const METRO_PAGE_HEAD = /<section class="rx-block rx-page-head rx-page-head--metro">/;
const NAME_ACCENT_SPAN = /<span class="rx-name-accent">/;

test('a non-metro template\'s generated pages are completely unaffected by templateId existing at all', () => {
  const withoutId = renderWithPageCopy({});
  const withUnrelatedId = renderWithPageCopy({}, { templateId: 'professional' });
  const about1 = withoutId.find((p) => p.path === '/about/').html;
  const about2 = withUnrelatedId.find((p) => p.path === '/about/').html;
  assert.equal(about1, about2);
  assert.doesNotMatch(about1, METRO_PAGE_HEAD);
  assert.ok(!about1.includes('>Your Community Pharmacy<'), 'the metro badge text must not appear off-template');
});

test('metro\'s generated pages get the coloured band, and the pharmacy\'s own name is highlighted where the heading ends with it', () => {
  const pages = renderWithPageCopy({}, { templateId: 'metro' });
  const about = pages.find((p) => p.path === '/about/').html;
  assert.match(about, METRO_PAGE_HEAD);
  assert.match(about, /<span class="rx-eyebrow rx-eyebrow--outline">Your Community Pharmacy<\/span>/);
  assert.match(about, /<h1>About <span class="rx-name-accent">Ikeja Family Pharmacy<\/span><\/h1>/);

  const contact = pages.find((p) => p.path === '/contact/').html;
  assert.match(contact, /<h1>Contact <span class="rx-name-accent">Ikeja Family Pharmacy<\/span><\/h1>/);
});

test('metro\'s name highlight is a suffix match, not a guess — a heading that does not end with the name is left exactly as it was', () => {
  const pages = renderWithPageCopy({}, { templateId: 'metro' });
  // "Find us in Ikeja, Lagos" does not end with the pharmacy's name.
  const location = pages.find((p) => p.path === '/location/').html;
  assert.doesNotMatch(location, NAME_ACCENT_SPAN);
  assert.match(location, /<h1>Find us in Ikeja, Lagos<\/h1>/);

  // An owner override that does not end with the name must not be forced
  // into one, or split incorrectly.
  const overridden = renderWithPageCopy({ '/about/': { heading: 'Meet Our Team' } }, { templateId: 'metro' });
  const about = overridden.find((p) => p.path === '/about/').html;
  assert.doesNotMatch(about, NAME_ACCENT_SPAN);
  assert.match(about, /<h1>Meet Our Team<\/h1>/);
});

test('metro\'s About page gets a real subheading with no pageCopy override; no other template\'s About page gains one', () => {
  const metro = renderWithPageCopy({}, { templateId: 'metro' });
  const metroAbout = metro.find((p) => p.path === '/about/').html;
  assert.match(metroAbout, /More than just a pharmacy — we are here for the Ikeja, Lagos community, built on trust and care\./);

  const professional = renderWithPageCopy({});
  const proAbout = professional.find((p) => p.path === '/about/').html;
  assert.ok(
    !proAbout.includes('<p class="rx-lede">'),
    'the plain About page head must still carry no lede at all, exactly as before this existed',
  );
});

test('metro\'s About subheading drops the area clause entirely when none is on file, rather than guessing one', () => {
  const pages = renderAllPages({
    site: templates.cloneSeed('metro'),
    pharmacy: PHARMACY,
    profile: { ...PROFILE, city: null, state: null },
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered;
  const about = pages.find((p) => p.path === '/about/').html;
  assert.match(about, /More than just a pharmacy — built on trust and care\./);
  assert.ok(!about.includes('community'));
});
