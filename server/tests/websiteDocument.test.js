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

function renderWithPhotos(rows, extra = {}) {
  return renderAllPages({
    site: templates.cloneSeed('professional'),
    pharmacy: PHARMACY,
    profile: PHOTO_PROFILE,
    theme: templates.getTemplate('professional').theme,
    assets: assetMap(rows),
    assetBaseUrl: 'https://cdn.example.com',
    year: 2026,
    ...extra,
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

  // A second page, to show the band and the highlight are not one page's
  // special case. Metro gives the contact page its own heading (see below),
  // so the second example here is the location page, whose heading is still
  // the derived one.
  const location = pages.find((p) => p.path === '/location/').html;
  assert.match(location, METRO_PAGE_HEAD);
  assert.match(location, NAME_ACCENT_SPAN);
});

test('metro highlights the pharmacy\'s own AREA too, on the headings that end with it rather than with the name', () => {
  // Widened deliberately when the Services page was built: its generated
  // heading ends with the area, not the name, and highlighting nothing
  // there left one page in the set visibly plainer than the rest. Both
  // halves are facts already on the profile — this never picks words for
  // being important-looking.
  const pages = renderWithPageCopy({}, { templateId: 'metro' });
  const location = pages.find((p) => p.path === '/location/').html;
  assert.match(location, /<h1>Find us in <span class="rx-name-accent">Ikeja, Lagos<\/span><\/h1>/);

  const services = pages.find((p) => p.path === '/services/').html;
  assert.match(services, /<h1>Pharmacy services in <span class="rx-name-accent">Ikeja, Lagos<\/span><\/h1>/);
});

test('metro\'s highlight is a suffix match, not a guess — a heading ending with neither the name nor the area is left exactly as it was', () => {
  const overridden = renderWithPageCopy(
    { '/about/': { heading: 'Meet Our Team' }, '/services/': { heading: 'Everything We Do' } },
    { templateId: 'metro' },
  );
  const about = overridden.find((p) => p.path === '/about/').html;
  assert.doesNotMatch(about, NAME_ACCENT_SPAN);
  assert.match(about, /<h1>Meet Our Team<\/h1>/);

  const services = overridden.find((p) => p.path === '/services/').html;
  assert.doesNotMatch(services, NAME_ACCENT_SPAN);
  assert.match(services, /<h1>Everything We Do<\/h1>/);
});

test('metro\'s page badge differs per page kind, and the head\'s call to action is only on the pages that ask for one', () => {
  const pages = renderWithPageCopy({}, { templateId: 'metro' });
  const badgeOn = (path) => {
    const m = /<span class="rx-eyebrow rx-eyebrow--outline">([^<]*)<\/span>/.exec(
      pages.find((p) => p.path === path).html,
    );
    return m && m[1];
  };
  assert.equal(badgeOn('/about/'), 'Your Community Pharmacy');
  assert.equal(badgeOn('/services/'), 'Comprehensive Care');
  assert.equal(badgeOn('/contact/'), 'We&#39;re Here for You');

  // Scoped to the head's OWN section: every page has a call to action lower
  // down, so anything looser than this passes on all of them.
  const headOf = (path) => {
    const m = /<section class="rx-block rx-page-head rx-page-head--metro">([\s\S]*?)<\/section>/
      .exec(pages.find((p) => p.path === path).html);
    return m && m[1];
  };
  assert.ok(headOf('/services/').includes('rx-cta-row'), 'the services head asks for the call');
  assert.ok(!headOf('/about/').includes('rx-cta-row'), 'the about head does not');
  // The head's button resolves the SAME number ctaRow does, so the one at
  // the top and the one at the bottom cannot lead somewhere different.
  assert.match(headOf('/services/'), /href="[^"]*wa\.me\/2348012345678/);
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
  assert.match(about, /<p class="rx-lede">More than just a pharmacy — built on trust and care\.<\/p>/);
  // The AREA CLAUSE specifically, not the word "community" anywhere on the
  // page: the story section's own heading legitimately falls back to
  // "Serving our community with Pride" for the same missing-area reason.
  assert.ok(!about.includes('we are here for the'), 'no area on file must not produce an area clause');
});

test('metro\'s About page tells the story ONCE — the description and photo are not also repeated below it', () => {
  const pages = renderWithPhotos([{ id: 'a1', path: 'ph/1.jpg', kind: 'hero', width: 1200, height: 900 }], {
    templateId: 'metro',
  });
  const about = pages.find((p) => p.path === '/about/').html;

  assert.match(about, /<div class="rx-story-grid">/);
  assert.match(about, /<h2>Serving Ikeja, Lagos with <span class="rx-heading-accent">Pride<\/span><\/h2>/);
  assert.match(about, /<span class="rx-eyebrow rx-eyebrow--pill">Our Story<\/span>/);
  // The photo lives in the story's own frame, so the separate grid must be
  // gone — and the description must appear exactly once, not once in the
  // story and again in the panel that used to carry it.
  assert.match(about, /<div class="rx-story-frame">/);
  assert.ok(!about.includes('<div class="rx-photo-grid">'), 'the photo grid must not repeat the story photo');
  // The rendered PARAGRAPH, counted — the same sentence also legitimately
  // fills the page's meta description and its og:/twitter: twins up in the
  // head, so a whole-document count would never be 1.
  assert.equal(
    (about.match(/<p>A community pharmacy serving Allen Avenue since 2011\.<\/p>/g) || []).length,
    1,
  );
});

test('every other template\'s About page still shows the panel and the grid, untouched', () => {
  const pages = renderWithPhotos([{ id: 'a1', path: 'ph/1.jpg', kind: 'hero', width: 1200, height: 900 }]);
  const about = pages.find((p) => p.path === '/about/').html;
  assert.ok(!about.includes('<div class="rx-story-grid">'));
  assert.match(about, /<div class="rx-panel">/);
  assert.match(about, /<div class="rx-photo-grid">/);
});

test('metro\'s story chips are the owner\'s OWN homepage highlights — never seeded, never invented', () => {
  const bare = renderWithPhotos([{ id: 'a1', path: 'ph/1.jpg', kind: 'hero' }], { templateId: 'metro' });
  const bareAbout = bare.find((p) => p.path === '/about/').html;
  // The RENDERED element, not the class name — that name is also a selector
  // in the always-inlined stylesheet, present whether or not it is used.
  assert.ok(!bareAbout.includes('<span class="rx-story-chip'), 'no highlights typed means no chips at all');

  // The same list the owner filled in on the homepage's About block.
  const seed = templates.cloneSeed('metro');
  seed.blocks.find((b) => b.type === 'pharmacy.about').props.highlights = [
    { text: 'Locally Owned' },
    { text: 'Bilingual Staff' },
  ];
  const withChips = renderAllPages({
    site: seed,
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered;
  const about = withChips.find((p) => p.path === '/about/').html;
  assert.match(about, /rx-story-chip rx-story-chip--a">.*?Locally Owned<\/span>/);
  assert.match(about, /rx-story-chip rx-story-chip--b">.*?Bilingual Staff<\/span>/);
});

test('mission and vision render only once the owner has written them — never a seeded default', () => {
  const bare = renderWithPageCopy({}, { templateId: 'metro' });
  const bareAbout = bare.find((p) => p.path === '/about/').html;
  assert.ok(!bareAbout.includes('<div class="rx-mv-grid">'), 'nothing written means no section at all');
  assert.ok(!bareAbout.includes('Our Mission'), 'and no empty card carrying the label alone');

  const written = renderWithPageCopy({
    '/about/': { mission: 'To keep our neighbours well.', vision: 'To become the first call on this street.' },
  }, { templateId: 'metro' });
  const about = written.find((p) => p.path === '/about/').html;
  assert.match(about, /<div class="rx-mv-card rx-mv-card--mission">/);
  assert.match(about, /<h2>Our Mission<\/h2><p>To keep our neighbours well\.<\/p>/);
  assert.match(about, /<h2>Our Vision<\/h2><p>To become the first call on this street\.<\/p>/);
});

test('a mission with no vision renders one card, not an empty second column', () => {
  const pages = renderWithPageCopy({ '/about/': { mission: 'To keep our neighbours well.' } }, { templateId: 'metro' });
  const about = pages.find((p) => p.path === '/about/').html;
  assert.equal((about.match(/class="rx-mv-card/g) || []).length, 1);
  assert.ok(!about.includes('Our Vision'));
});

test('mission and vision are available to every template, not only metro — only the two-tone accent is metro\'s', () => {
  const pages = renderWithPageCopy({ '/about/': { mission: 'To keep our neighbours well.' } });
  const about = pages.find((p) => p.path === '/about/').html;
  assert.match(about, /<div class="rx-mv-card rx-mv-card--mission">/, 'the cards are not gated on the template');
  // The rendered attribute, not the bare class name — that name is also a
  // selector in the always-inlined stylesheet, present on every page.
  assert.ok(!about.includes('class="rx-block rx-mv--metro"'), 'only the accent-coloured variant is');
});

/** The metro seed with the owner's own "why choose us" reasons filled in. */
function renderWithWhyUs(whyUs, overrides = {}) {
  const seed = templates.cloneSeed('metro');
  seed.blocks.find((b) => b.type === 'pharmacy.about').props.whyUs = whyUs;
  return renderAllPages({
    site: seed,
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
    ...overrides,
  }).rendered;
}

test('"why choose us" renders only the reasons the owner wrote, and nothing at all without them', () => {
  const none = renderWithWhyUs([]);
  const bare = none.find((p) => p.path === '/about/').html;
  assert.ok(!bare.includes('<section class="rx-block rx-why'), 'no reasons written means no band at all');
  assert.ok(!bare.includes('Why Choose'), 'and not even the heading on its own');

  const pages = renderWithWhyUs([
    { title: 'Free Delivery', text: 'Bringing meds right to your door.' },
    { title: 'Fast Service' },
  ]);
  const about = pages.find((p) => p.path === '/about/').html;
  assert.match(about, /<h2>Why Choose Ikeja Family Pharmacy\?<\/h2>/);
  assert.match(about, /<h3>Free Delivery<\/h3><p>Bringing meds right to your door\.<\/p>/);
  // A reason with no line under it renders as the title alone, not an empty
  // paragraph.
  assert.match(about, /<h3>Fast Service<\/h3><\/div>/);
});

test('"why choose us" offers the same WhatsApp route the rest of the page does, and no dead card without one', () => {
  const withWa = renderWithWhyUs([{ title: 'Free Delivery' }]);
  const about = withWa.find((p) => p.path === '/about/').html;
  assert.match(about, /<aside class="rx-why-card"><h3>Have Questions\?<\/h3>/);
  assert.match(about, /wa\.me\/2348012345678/);

  const noContact = renderWithWhyUs([{ title: 'Free Delivery' }], {
    pharmacy: { name: 'Ikeja Family Pharmacy' },
    profile: { ...PROFILE, phone: null },
  });
  const bare = noContact.find((p) => p.path === '/about/').html;
  assert.match(bare, /<h3>Free Delivery<\/h3>/, 'the reasons still stand on their own');
  assert.ok(!bare.includes('Have Questions?'), 'but no card inviting a message nothing can send');
});

test('the accent band is metro\'s; every other template gets the same reasons on a plain tint', () => {
  const metro = renderWithWhyUs([{ title: 'Free Delivery' }]);
  assert.match(metro.find((p) => p.path === '/about/').html, /<section class="rx-block rx-why rx-why--metro">/);

  const seed = templates.cloneSeed('professional');
  seed.blocks.find((b) => b.type === 'pharmacy.about').props.whyUs = [{ title: 'Free Delivery' }];
  const plain = renderAllPages({
    site: seed,
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('professional').theme,
    assets: new Map(),
    year: 2026,
  }).rendered;
  const about = plain.find((p) => p.path === '/about/').html;
  assert.match(about, /<section class="rx-block rx-why">/);
  assert.ok(!about.includes('rx-why rx-why--metro'));
});

test('metro\'s story stands on the description alone when the pharmacy has uploaded no photo', () => {
  // The no-description case is unreachable from here by design: pages.js
  // does not create /about/ at all without one, because the page would be
  // the pharmacy's name and nothing else. So the case worth pinning is the
  // other one — words but no picture — where the story keeps its words and
  // simply has no frame to draw.
  const pages = renderAllPages({
    site: templates.cloneSeed('metro'),
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered;
  const about = pages.find((p) => p.path === '/about/').html;
  assert.match(about, /<div class="rx-story-grid">/);
  assert.match(about, /Family run since 2014\./);
  assert.ok(!about.includes('<div class="rx-story-frame">'), 'no photo means no frame, not an empty one');
});

// The services page's card grid. Same guard as above: `.rx-svc-card` is a
// selector in the inlined stylesheet on EVERY page, so these match the
// rendered element, never the bare class name.
const SVC_CARD_LINK = /<li><a class="rx-svc-card" href="([^"]+)">/g;

/** Two services with descriptions and one without, on the given template. */
function renderServicesPage(templateId) {
  const pages = renderAllPages({
    site: templates.cloneSeed(templateId),
    pharmacy: PHARMACY,
    profile: {
      ...PROFILE,
      services: [
        { name: 'Prescription Refills', description: 'Repeat prescriptions dispensed and ready for collection.' },
        { name: 'Blood Pressure Checks', description: 'Have your blood pressure measured by pharmacy staff.' },
        { name: 'Vaccinations' },
      ],
    },
    theme: templates.getTemplate(templateId).theme,
    assets: new Map(),
    year: 2026,
    templateId,
  }).rendered;
  return pages.find((p) => p.path === '/services/').html;
}

test('metro\'s services page lays the services out as blob cards; every other template keeps the plain card grid', () => {
  const metro = renderServicesPage('metro');
  assert.match(metro, /<ul class="rx-svc-cards">/);
  assert.match(metro, /<span class="rx-eyebrow rx-eyebrow--pill">What We Offer<\/span>/);

  const professional = renderServicesPage('professional');
  assert.ok(!professional.includes('<ul class="rx-svc-cards">'), 'the blob grid is metro\'s alone');
  assert.ok(!professional.includes('>What We Offer<'), 'and so is its eyebrow');
});

test('every blob card is a link to that service\'s own page, and each service appears exactly once', () => {
  const html = renderServicesPage('metro');
  const hrefs = [...html.matchAll(SVC_CARD_LINK)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    '/services/prescription-refills/',
    '/services/blood-pressure-check/',
    '/services/vaccinations/',
  ]);
  assert.match(html, /<h3>Prescription Refills<\/h3>/);
  assert.match(html, /<h3>Vaccinations<\/h3>/);
});

/** The markup of one card, by the service page it links to. */
function cardFor(html, path) {
  const from = html.slice(html.indexOf('"' + path + '"'));
  return from.slice(0, from.indexOf('</a>'));
}

test('a card says the service\'s own words, without the search-result lead-in that repeats its heading', () => {
  const html = renderServicesPage('metro');
  // pages.js prefixes every service's meta description with "<service> at
  // <pharmacy> in <area>." — right for a search result, a stutter directly
  // under a heading that already says the service's name.
  const refills = cardFor(html, '/services/prescription-refills/');
  assert.match(refills, /<h3>Prescription Refills<\/h3>/);
  assert.match(refills, /<p>Repeat prescriptions dispensed and ready for collection\.<\/p>/);
  assert.ok(
    !refills.includes('Prescription Refills at Ikeja Family Pharmacy'),
    'the lead-in belongs in the <meta> tag, not on the card',
  );
});

test('a service with nothing but that lead-in on file gets no paragraph at all — never a blank one, never an invented line', () => {
  const html = renderServicesPage('metro');
  // "Vaccinations" is in no catalogue entry and this fixture gives it no
  // description of its own, so the whole of its meta description IS the
  // lead-in — and what is left after removing it is nothing.
  const card = cardFor(html, '/services/vaccinations/');
  assert.match(card, /<h3>Vaccinations<\/h3>/);
  assert.ok(!card.includes('<p>'), 'nothing on file means nothing under the heading');
});

test('the plain card grid every other template uses is untouched — it still carries the full meta description', () => {
  const professional = renderServicesPage('professional');
  assert.match(professional, /<p>Vaccinations at Ikeja Family Pharmacy in Ikeja, Lagos\.<\/p>/);
});
test('the blob tone alternates as rhythm only — it is not decided by anything about the service', () => {
  const html = renderServicesPage('metro');
  const tones = [...html.matchAll(/<span class="rx-svc-blob (rx-svc-blob--[ab])">/g)].map((m) => m[1]);
  assert.deepEqual(tones, ['rx-svc-blob--a', 'rx-svc-blob--b', 'rx-svc-blob--a']);
});

test('the card grid\'s heading does not simply repeat the page\'s own <h1>', () => {
  const html = renderServicesPage('metro');
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/)[1].replace(/<[^>]+>/g, '');
  const h2 = html.match(/<h2>([\s\S]*?)<\/h2>/)[1].replace(/<[^>]+>/g, '');
  assert.notEqual(h2.toLowerCase(), h1.toLowerCase());
});

test('the reveal animation on the cards moves them, and never fades them — a card must never be able to stay invisible', () => {
  const css = stylesheet(templates.getTemplate('metro').theme);
  const rise = css.match(/@keyframes rx-rise\{([\s\S]*?)\}\s*\}/);
  assert.ok(rise, 'the rx-rise keyframes must exist');
  assert.ok(!/opacity/.test(rise[1]), 'rx-rise must be transform-only — opacity has blanked the page before');
  assert.match(css, /\.rx-svc-cards>\*/, 'the cards must be in the stagger');
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\s*\*\{animation:none!important/);
});

// =====================================================================
// THE OWNER'S FAQ ON THE SERVICES PAGE, AND THE COLUMNS FOOTER
// =====================================================================

// Again: a class name is a selector in the always-inlined stylesheet, so
// these match rendered elements.
const COLUMNS_FOOTER = /<footer class="rx-block rx-pharmacy-footer rx-footer--columns">/;
const STATEMENT_FOOTER = /<footer class="rx-block rx-pharmacy-footer">/;

/** Metro, with the owner's own questions written on their home page. */
function renderWithOwnerFaq(faqs, templateId = 'metro') {
  const site = templates.cloneSeed(templateId);
  const faq = site.blocks.find((b) => b.type === 'pharmacy.faq');
  if (faq) faq.props.faqs = faqs;
  return renderAllPages({
    site,
    pharmacy: PHARMACY,
    profile: { ...PROFILE, services: [{ name: 'Vaccinations' }] },
    theme: templates.getTemplate(templateId).theme,
    assets: new Map(),
    year: 2026,
    templateId,
  }).rendered;
}

const OWN_FAQ = [{ question: 'Do I need an appointment for vaccines?', answer: 'No, walk in any time we are open.' }];

test("metro's services page carries the owner's OWN questions, worded exactly as they wrote them", () => {
  const services = renderWithOwnerFaq(OWN_FAQ).find((x) => x.path === '/services/').html;
  assert.match(services, /<summary>Do I need an appointment for vaccines\?/);
  assert.match(services, /<p>No, walk in any time we are open\.<\/p>/);
  // The block's own disclosure markup, not a second implementation of it.
  assert.match(services, /<details class="rx-faq-item">/);
});

test('a pharmacy that has written no questions gets no FAQ section at all — never a seeded one', () => {
  const services = renderWithOwnerFaq([]).find((x) => x.path === '/services/').html;
  assert.ok(!services.includes('<details class="rx-faq-item">'), 'no questions means no accordion');
  assert.ok(!services.includes('>Frequently Asked Questions<'), 'and no heading over nothing');
  // Nor may it invent the kind of policy question a real pharmacy would have
  // to answer for itself.
  assert.ok(!/insurance|Medicaid|Medicare/i.test(services), 'no fabricated policy questions');
});

test("the FAQ is metro's — no other template's services page grows one", () => {
  const services = renderWithOwnerFaq(OWN_FAQ, 'professional').find((x) => x.path === '/services/').html;
  assert.ok(!services.includes('<details class="rx-faq-item">'));
  assert.ok(!services.includes('Do I need an appointment for vaccines?'));
});

test("metro's footer is the four-column one, on every page and not only the home page", () => {
  const pages = renderWithOwnerFaq([]);
  for (const page of pages) {
    assert.match(page.html, COLUMNS_FOOTER, `${page.path} must carry the same footer as every other page`);
  }
});

test('every other template keeps the statement footer it already had', () => {
  for (const id of ['professional', 'modern', 'premium', 'family']) {
    const about = renderWithOwnerFaq([], id).find((x) => x.path === '/about/').html;
    assert.match(about, STATEMENT_FOOTER, `${id} must be untouched`);
    assert.doesNotMatch(about, COLUMNS_FOOTER);
  }
});

test("the columns footer's own facts all come from the profile, and it links only to pages that exist", () => {
  const pages = renderWithOwnerFaq([]);
  const html = pages.find((x) => x.path === '/about/').html;
  const footer = html.slice(html.indexOf('<footer'));

  assert.match(footer, /<p class="rx-footer-blurb">Family run since 2014\.<\/p>/);
  assert.match(footer, /12 Allen Avenue, Ikeja, Lagos/);
  assert.match(footer, /href="tel:08012345678"/);
  assert.match(footer, /Monday: 8:00 am – 8:00 pm/);

  // Every href in the footer is either a page this site actually has or an
  // external contact link — never a /terms/ or /privacy/ that would 404.
  const paths = [...footer.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  const real = new Set(pages.map((x) => x.path));
  for (const path of paths) assert.ok(real.has(path), `${path} is not a page this site has`);
  assert.ok(paths.includes('/services/vaccinations/'), 'the services column links to the service pages');
});

test('a column with nothing true to put in it is omitted whole, heading and all', () => {
  // No services on file, so no service pages, so no Services column.
  const pages = renderAllPages({
    site: templates.cloneSeed('metro'),
    pharmacy: PHARMACY,
    profile: { ...PROFILE, services: [] },
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered;
  const html = pages.find((x) => x.path === '/about/').html;
  const footer = html.slice(html.indexOf('<footer'));
  assert.ok(!footer.includes('>Services<'), 'no service pages means no Services column');
  assert.match(footer, />Contact Info</, 'the columns that do have facts are still there');
});

test('the footer on a generated page is the one the OWNER edited, not a defaults-only copy', () => {
  const site = templates.cloneSeed('metro');
  site.blocks.find((b) => b.type === 'pharmacy.footer').props.copyright = 'Copyright 2026, all rights reserved.';
  const pages = renderAllPages({
    site,
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered;
  for (const page of pages) {
    assert.match(page.html, /Copyright 2026, all rights reserved\./, `${page.path} lost the owner's own line`);
  }
});

test('the WhatsApp mark in the footer and the one on the floating button are the same drawing', () => {
  const html = renderWithOwnerFaq([]).find((x) => x.path === '/about/').html;
  const paths = [...html.matchAll(/<path d="(M12\.04 2C[^"]+)"\/>/g)].map((m) => m[1]);
  assert.equal(paths.length, 2, 'the footer column and the floating button');
  assert.equal(paths[0], paths[1], 'one logo, drawn once');
});

// =====================================================================
// METRO'S CONTACT PAGE
// =====================================================================

test("metro's contact page opens with the warmer heading, and the pharmacy's own name is the accent", () => {
  const contact = renderWithPageCopy({}, { templateId: 'metro' }).find((x) => x.path === '/contact/').html;
  const head = contact.slice(contact.indexOf('<section class="rx-block rx-page-head'));
  assert.match(head, /<h1>Get in Touch with <span class="rx-name-accent">Ikeja Family Pharmacy<\/span><\/h1>/);
  assert.match(head, /<span class="rx-eyebrow rx-eyebrow--outline">We&#39;re Here for You<\/span>/);
});

test('the search-result strings still say "Contact {name}" — only the visible heading changed', () => {
  const pages = renderAllPages({
    site: templates.cloneSeed('metro'),
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  });
  const page = pages.pages.find((x) => x.path === '/contact/');
  assert.equal(page.title, 'Contact Ikeja Family Pharmacy — Pharmacy in Ikeja');
  assert.match(page.description, /^Contact Ikeja Family Pharmacy/);
  const html = pages.rendered.find((x) => x.path === '/contact/').html;
  assert.match(html, /<title>Contact Ikeja Family Pharmacy — Pharmacy in Ikeja<\/title>/);
  // The breadcrumb a search engine reads is the page's nav name, unchanged.
  assert.match(html, /"name":"Contact","item":"\/contact\/"/);
});

test("no other template's contact page changes at all", () => {
  const contact = renderWithPageCopy({}, { templateId: 'professional' }).find((x) => x.path === '/contact/').html;
  assert.match(contact, /<h1>Contact Ikeja Family Pharmacy<\/h1>/);
  assert.ok(!contact.includes('Get in Touch with'));
  assert.ok(!contact.includes("We&#39;re Here for You"));
});

test("the owner's own heading still wins over metro's wording", () => {
  const pages = renderWithPageCopy({ '/contact/': { heading: 'Talk to a pharmacist' } }, { templateId: 'metro' });
  const contact = pages.find((x) => x.path === '/contact/').html;
  assert.match(contact, /<h1>Talk to a pharmacist<\/h1>/);
  assert.ok(!contact.includes('Get in Touch with'));
});

test("metro's contact lede names the area when there is one, drops the clause entirely when there is not, and promises nothing", () => {
  const withArea = renderWithPageCopy({}, { templateId: 'metro' }).find((x) => x.path === '/contact/').html;
  assert.match(withArea, /Reach out to our team in Ikeja, Lagos today\./);

  const bare = renderAllPages({
    site: templates.cloneSeed('metro'),
    pharmacy: PHARMACY,
    profile: { ...PROFILE, city: null, state: null },
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered.find((x) => x.path === '/contact/').html;
  assert.match(bare, /Reach out to our team today\./);
  assert.ok(!/team in\s*(today|\.)/.test(bare), 'no dangling "in" where the area would have been');

  // The reference's own line offers to schedule a consultation. This must
  // not, on either version: that is a service a given pharmacy may not run.
  for (const html of [withArea, bare]) {
    assert.ok(!/consultation|appointment/i.test(html), 'no service this pharmacy has not said it offers');
  }
});

// =====================================================================
// METRO CONTACT CARDS
// =====================================================================

const CONTACT_CARDS = /<ul class="rx-contact-cards">/;

/** Metro's contact page, against whatever the pharmacy has on file. */
function metroContact(profile) {
  return renderAllPages({
    site: templates.cloneSeed('metro'),
    pharmacy: PHARMACY,
    profile,
    theme: templates.getTemplate('metro').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'metro',
  }).rendered.find((x) => x.path === '/contact/').html;
}

/** The headings of the cards that rendered, in order. */
function cardHeadings(html) {
  const grid = html.slice(html.indexOf('<ul class="rx-contact-cards">'));
  return [...grid.slice(0, grid.indexOf('</ul></section>')).matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
}

test("metro's contact page is a card per way of reaching the pharmacy, each with its own action", () => {
  const html = metroContact(PROFILE);
  assert.match(html, CONTACT_CARDS);
  assert.deepEqual(cardHeadings(html), ['Visit Us', 'Call Us', 'Message Us', 'Opening Hours']);
  assert.match(html, /<a class="rx-contact-go" href="https:\/\/maps\.google\.com[^"]*">Get Directions<\/a>/);
  assert.match(html, /<a class="rx-contact-go" href="tel:08012345678">Call Now<\/a>/);
  assert.match(html, /<a class="rx-contact-go" href="https:\/\/wa\.me\/2348012345678"[^>]*>Open WhatsApp<\/a>/);
});

test('a card is dropped whole when the fact behind it is not on file — never a heading over a blank', () => {
  // No address, no maps link, no hours: WhatsApp is all this pharmacy has,
  // because a published site always has that.
  const html = metroContact({ ...PROFILE, address_line: null, city: null, state: null, maps_url: null, phone: null, opening_hours: [] });
  assert.deepEqual(cardHeadings(html), ['Message Us']);
  assert.ok(!html.includes('>Visit Us<'), 'no address means no address card');
  assert.ok(!html.includes('>Opening Hours<'), 'no hours means no hours card');
});

test('an address with no maps link still gets its card, just without a directions link', () => {
  const html = metroContact({ ...PROFILE, maps_url: null });
  assert.ok(cardHeadings(html).includes('Visit Us'));
  assert.match(html, /12 Allen Avenue, Ikeja, Lagos/);
  assert.ok(!html.includes('>Get Directions<'), 'nowhere to send them is not a link');
});

test("the hours card shows the owner's own week and never asserts a day they have not filled in", () => {
  const html = metroContact({
    ...PROFILE,
    opening_hours: [
      { day: 'mon', open: '09:00', close: '17:00' },
      { day: 'tue', open: '09:00', close: '17:00' },
      { day: 'sun', closed: true },
    ],
  });
  assert.match(html, /<span>Mon – Tue:<\/span> <span>9:00 am – 5:00 pm<\/span>/);
  // Sunday is marked shut by the owner, so it is shown as shut.
  assert.match(html, /<li class="rx-closed"><span>Sunday:<\/span> <span>Closed<\/span><\/li>/);
  // Wednesday through Saturday are simply not on file. They are absent, not
  // declared closed — the pharmacy never said that and this must not either.
  assert.ok(!/Wednesday|Thursday|Friday|Saturday/.test(html));
});

test('the contact page invents no fax number and no email address, which the reference has and this product does not', () => {
  const html = metroContact(PROFILE);
  assert.ok(!/\bfax\b/i.test(html), 'pharmacy_profile has no fax column');
  assert.ok(!/mailto:/.test(html), 'nor an email one');
});

test("every other template's contact page is the two-column address and hours it always was", () => {
  const html = renderAllPages({
    site: templates.cloneSeed('professional'),
    pharmacy: PHARMACY,
    profile: PROFILE,
    theme: templates.getTemplate('professional').theme,
    assets: new Map(),
    year: 2026,
    templateId: 'professional',
  }).rendered.find((x) => x.path === '/contact/').html;
  assert.doesNotMatch(html, CONTACT_CARDS);
  assert.match(html, /<h2>Where to find us<\/h2>/);
  assert.match(html, /<h2>Opening hours<\/h2>/);
});

test('metro does not print the same thing twice — the cards REPLACE the call-to-action row and the address/hours split', () => {
  const html = metroContact(PROFILE);
  // Both of those said exactly what the cards now say: the row was the same
  // WhatsApp and phone links, and the split was the same address and hours.
  assert.ok(!html.includes('<div class="rx-cta-row">'), 'the cards carry the actions now');
  assert.ok(!html.includes('<h2>Where to find us</h2>'), 'and the address');
  assert.ok(!html.includes('<h2>Opening hours</h2>'), 'and the hours');

  // Once inside the page's own body, whatever the chrome around it does.
  const body = html.slice(html.indexOf('<div class="rx-page">'), html.indexOf('<footer'));
  assert.equal([...body.matchAll(/12 Allen Avenue, Ikeja, Lagos/g)].length, 1);
  assert.equal([...body.matchAll(/href="tel:08012345678"/g)].length, 1);
});
