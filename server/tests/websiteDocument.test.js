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
// TEMPLATES — all three
// =====================================================================

test('all three templates are registered and distinct', () => {
  const ids = templates.TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids.sort(), ['modern', 'premium', 'professional']);
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
