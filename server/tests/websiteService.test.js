/**
 * Pharmacy website service — Phase 1.
 *
 * TWO HALVES, AND THE FIRST ONE MATTERS MOST.
 *
 * The validation tests below need no database and therefore ALWAYS run. That
 * is deliberate: 386 tests in this repository skip without TEST_DATABASE_URL,
 * and a suite that skips proves nothing. normalizeSiteData is the only thing
 * standing between a browser and a jsonb column that the public site will
 * later be rendered from, so it is tested where the tests actually execute.
 *
 * The database half is gated the same way as isolation.test.js. Set
 * TEST_DATABASE_URL to a NON-PRODUCTION Postgres with db/migrations applied.
 */

const path = require('node:path');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// ---------------------------------------------------------------------
// REDIRECT BEFORE REQUIRING ANYTHING FROM THE APP. Order is load-bearing.
//
// config/env.js reads process.env once, at require time, and services/db.js
// connects with that captured value — so a require of any service ABOVE this
// line pins the connection to whatever DATABASE_URL was at that moment, which
// in this repo is production. This file was originally written with the
// requires first, and its before() hook ran its DELETEs and INSERTs against
// the live database on 2026-09-05. The guard in helpers/testDb.js had passed;
// the redirect had simply come too late to matter.
//
// helpers/testDb.js now also corrects an already-loaded env, so this ordering
// is no longer the only thing standing between this suite and production
// (see GOLDEN-004). It is still written in the correct order, because relying
// on the safety net when the plain fix is free is how the net gets tested in
// anger.
// ---------------------------------------------------------------------
const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — website record behaviour NOT verified';

require('./helpers/testDb').useTestDatabase(TEST_URL);

const websiteService = require('../services/website/websiteService');
const { normalizeSiteData, normalizeContentPatch, validatePageCopy } = websiteService;
const templates = require('../services/website/templates');

// =====================================================================
// STRUCTURE — no database, always runs
// =====================================================================

test('site_data must be an object, not a string or an array', () => {
  // A client that sends the blocks array directly instead of {blocks:[...]}
  // is a mistake worth naming, not one to coerce into working.
  for (const bad of ['', 'x', 42, null, undefined, [], [{ type: 'rx-hero' }]]) {
    const r = normalizeSiteData(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(r.code, 'INVALID_SITE_DATA');
  }
});

test('site_data.blocks must be an array', () => {
  const r = normalizeSiteData({ blocks: { 0: { type: 'rx-hero' } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_SITE_DATA');
});

// PHASE 2 CHANGED THE STORED SHAPE, and these tests changed with it.
//
// Phase 1 stored {type, props} where type was a name from a flat list and
// props were unvalidated. Phase 2 stores {type, version, props} where type is
// a registered block id, the version is explicit, and every prop is checked
// against the block contract. That is a deliberate product change — the props
// became the input to a server renderer that publishes to the open internet,
// and unvalidated input to that is not something to keep compatibility with.
//
// The rules these tests state are the same rules; only the vocabulary moved.

test('a valid block is accepted and keeps its props', () => {
  const r = normalizeSiteData({
    blocks: [{ type: 'pharmacy.hero', props: { heading: 'Open six days a week' } }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.blocks, [
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Open six days a week' } },
  ]);
});

/**
 * The rule the whole no-sanitiser design rests on.
 *
 * Because the server renders every byte of a published page from a fixed set
 * of block renderers, an unknown block type has no rendering. It is rejected
 * HERE, at save time, rather than skipped at render time — a section that
 * silently vanishes between saving and publishing is the bug an owner
 * reports as "your builder deleted my page", and it would be invisible in
 * the logs.
 */
test('an unknown block type is rejected at save time, not skipped at render time', () => {
  const r = normalizeSiteData({ blocks: [{ type: 'rx-not-a-real-block', props: {} }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_BLOCK');
  assert.match(r.error, /rx-not-a-real-block/);
});

test('a block type that is a script tag, an object or a number is rejected like any other unknown', () => {
  // Not because these are dangerous in themselves — nothing interpolates a
  // block type into markup — but because the allowlist must not have a
  // clever exception, which is how allowlists stop being allowlists.
  for (const bad of ['<script>', { type: 'rx-hero' }, 7, null, undefined]) {
    const r = normalizeSiteData({ blocks: [{ type: bad, props: {} }] });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(r.code, 'UNKNOWN_BLOCK');
  }
});

test('block props must be an object, so the renderer never reads properties off an array', () => {
  const r = normalizeSiteData({ blocks: [{ type: 'pharmacy.hero', props: ['heading'] }] });
  assert.equal(r.ok, false);
  // Phase 2: the per-block failure now comes from the block contract, so the
  // code names the props rather than the document shape.
  assert.equal(r.code, 'INVALID_BLOCK_PROPS');
});

test('a block with no props at all is accepted and gets an empty object', () => {
  const r = normalizeSiteData({ blocks: [{ type: 'pharmacy.footer' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.blocks[0].props, {});
});

test('anything the client attaches beyond type, version and props is dropped rather than stored', () => {
  // Stored unknown fields become fields somebody later has to support,
  // because by then a site in production contains them. `version` joined the
  // kept set in Phase 2 — it is what keeps old sites renderable.
  const r = normalizeSiteData({
    blocks: [{ type: 'pharmacy.hero', props: {}, __html: '<script>x</script>', id: 'gjs-1' }],
    meta: 'ignored',
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value.blocks[0]).sort(), ['props', 'type', 'version']);
  assert.deepEqual(Object.keys(r.value), ['blocks']);
});

test('an oversized site_data is refused rather than truncated', () => {
  // Half a website stored silently is worse than a save that reports failure.
  //
  // Phase 2 note: this can no longer be provoked with one enormous string,
  // because every text prop is now length-capped by the block contract long
  // before the document cap is reached. It takes many legitimately-sized
  // blocks instead — which is the case the document cap actually exists for.
  const review = { name: 'A customer', text: 'x'.repeat(600), rating: 5 };
  const blocks = Array.from({ length: 60 }, () => ({
    type: 'pharmacy.reviews',
    props: { reviews: Array.from({ length: 12 }, () => ({ ...review })) },
  }));
  const r = normalizeSiteData({ blocks });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SITE_DATA_TOO_LARGE');
});

test('a page cannot have an unbounded number of blocks', () => {
  const blocks = Array.from({ length: 61 }, () => ({ type: 'pharmacy.footer', props: {} }));
  const r = normalizeSiteData({ blocks });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_SITE_DATA');
});

// PHASE 3 GAVE `theme` A CONTRACT.
//
// Phase 1 accepted any object as a theme, because nothing rendered it yet.
// Phase 3 renders it into a stylesheet on a public page, so it is now six
// palettes, four type pairings, three radii and one validated hex — and an
// arbitrary `{primary: '#0f766e'}` is refused because "primary" is not a
// setting an owner can choose. `content` is unchanged and still free-form.
test('a content patch must carry content or theme, and each must be valid', () => {
  assert.equal(normalizeContentPatch({}).code, 'NOTHING_TO_UPDATE');
  assert.equal(normalizeContentPatch({ content: 'x' }).code, 'INVALID_CONTENT');
  assert.equal(normalizeContentPatch({ theme: [] }).code, 'INVALID_THEME');
  assert.equal(normalizeContentPatch({ theme: { primary: '#0f766e' } }).code, 'INVALID_THEME',
    'a raw colour is not a theme setting — the owner picks a palette');
  assert.equal(normalizeContentPatch({ theme: { palette: 'teal' } }).ok, true);
});

// =====================================================================
// pageCopy — an owner's own wording for a generated page. See its header
// comment in websiteService.js for the shape and why it exists.
// =====================================================================

test('pageCopy trims whitespace, drops blank fields, and drops unknown keys', () => {
  const r = validatePageCopy({ '/about/': { heading: '  Our Story  ', intro: '   ', bogus: 'x' } });
  assert.deepEqual(r, { ok: true, value: { '/about/': { heading: 'Our Story' } } });
});

test('an entry left entirely blank is dropped rather than stored as an empty override', () => {
  const r = validatePageCopy({ '/about/': { heading: '' }, '/contact/': { intro: '   ' } });
  assert.deepEqual(r, { ok: true, value: {} });
});

test('pageCopy stores a mission and a vision, capped like every other field', () => {
  const r = validatePageCopy({ '/about/': { mission: '  To serve our neighbours well.  ', vision: 'To become their first call.' } });
  assert.deepEqual(r, {
    ok: true,
    value: { '/about/': { mission: 'To serve our neighbours well.', vision: 'To become their first call.' } },
  });

  const tooLong = validatePageCopy({ '/about/': { mission: 'A'.repeat(601) } });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /mission must be 600 characters or fewer/);
});

test('pageCopy rejects a key that is not a real page path', () => {
  const r = validatePageCopy({ about: { heading: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_CONTENT');
});

test('pageCopy rejects a field over its length cap, naming the field', () => {
  const r = validatePageCopy({ '/about/': { heading: 'A'.repeat(121) } });
  assert.equal(r.ok, false);
  assert.match(r.error, /heading.*120 characters or fewer/);
});

test('pageCopy rejects more pages than the cap allows', () => {
  const many = {};
  for (let i = 0; i < 41; i += 1) many[`/p${i}/`] = { heading: 'x' };
  const r = validatePageCopy(many);
  assert.equal(r.ok, false);
});

test('pageCopy rejects a non-string field value', () => {
  const r = validatePageCopy({ '/about/': { heading: 123 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be a string/);
});

test('a content patch carrying pageCopy validates it and leaves the rest of content alone', () => {
  const r = normalizeContentPatch({
    content: { health: ['hypertension'], pageCopy: { '/about/': { heading: '  Hi  ' } } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.content.health, ['hypertension']);
  assert.deepEqual(r.value.content.pageCopy, { '/about/': { heading: 'Hi' } });
});

test('a content patch carrying an invalid pageCopy is rejected before anything is stored', () => {
  const r = normalizeContentPatch({ content: { pageCopy: { 'not-a-path': { heading: 'x' } } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_CONTENT');
});

// =====================================================================
// TEMPLATE REGISTRY — no database, always runs
// =====================================================================

test('every registered template has the fields the picker and the record both need', () => {
  assert.ok(templates.TEMPLATES.length > 0, 'the registry must not be empty');
  for (const t of templates.TEMPLATES) {
    assert.equal(typeof t.id, 'string', 'id');
    assert.ok(t.id.length > 0, 'id must not be empty');
    assert.equal(typeof t.version, 'number', `${t.id}.version`);
    assert.equal(typeof t.name, 'string', `${t.id}.name`);
    assert.equal(typeof t.description, 'string', `${t.id}.description`);
    assert.equal(typeof t.preview, 'string', `${t.id}.preview`);
    assert.ok(Array.isArray(t.seed?.blocks), `${t.id}.seed.blocks`);
  }
});

test('template ids are unique, because a site stores the id and nothing else', () => {
  const ids = templates.TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

/**
 * The integrity check that would have caught a template referencing a block
 * nobody wrote a renderer for. Without this, the failure surfaces when a
 * pharmacy picks that template and their save is rejected — which reads to
 * them as the builder being broken.
 */
test('every block in every template seed is a type the renderer knows', () => {
  for (const t of templates.TEMPLATES) {
    const checked = normalizeSiteData(t.seed);
    assert.equal(checked.ok, true, `template ${t.id} has an invalid seed: ${checked.error}`);
  }
});

test('cloneSeed hands back a copy, so one pharmacy editing cannot alter the template', () => {
  // The registry is frozen, so the immediate symptom of sharing a reference
  // would be a throw. The reason this test exists is the case where somebody
  // removes the freeze for convenience: then the bug is silent, and it is one
  // pharmacy's hero text appearing on every pharmacy created afterwards.
  const a = templates.cloneSeed('professional');
  const b = templates.cloneSeed('professional');
  assert.notEqual(a, b, 'each call must return a distinct object');
  assert.notEqual(a.blocks, b.blocks);
  a.blocks[0].props.heading = 'mutated';
  assert.notEqual(b.blocks[0].props.heading, 'mutated');
  assert.notEqual(templates.getTemplate('professional').seed.blocks[0].props.heading, 'mutated');
});

test('an unknown template id yields null rather than a partly-built site', () => {
  assert.equal(templates.getTemplate('nope'), null);
  assert.equal(templates.getTemplate(undefined), null);
  assert.equal(templates.cloneSeed('nope'), null);
});

test('listTemplates ships manifests only — never the seed payload', () => {
  // The picker needs metadata. Shipping seeds would put the whole template
  // library through the pool every time somebody opens the Website tab.
  for (const t of templates.listTemplates()) {
    assert.equal(t.seed, undefined, `${t.id} must not carry its seed to the client`);
  }
});

// =====================================================================
// ARCHITECTURAL BOUNDARY — no database, always runs
// =====================================================================

/**
 * The locked rule from WEBSITE_BUILDER_DECISIONS.md:
 *
 *   "GrapesJS is an implementation detail of the advanced editor. No other
 *    part of the application may depend directly on a GrapesJS API."
 *
 * The server is the half that must never know GrapesJS exists — it renders
 * from structured data, and the day it imports the editor is the day the
 * editor stops being replaceable. A rule in a document does not enforce
 * itself; this does.
 *
 * The client half of the rule (only Editor.jsx may import it) is asserted in
 * Phase 5, when that file exists.
 */
test('nothing under server/ imports grapesjs', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (full === __filename) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/require\(['"]grapesjs|from ['"]grapesjs/.test(src)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);

  assert.deepEqual(offenders, [], `server modules must not import grapesjs: ${offenders.join(', ')}`);
});

// =====================================================================
// DATABASE — gated on TEST_DATABASE_URL
//
// TEST_URL, SKIP and the redirect are declared at the TOP of this file, not
// here, and the comment there explains why moving them back would point this
// suite at production.
// =====================================================================

const TEST_TAG = 'websitetest';
let db;
let pharmacies;
let ctx = null;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  pharmacies = require('../services/pharmacies');

  await db`delete from pharmacies where name like ${`${TEST_TAG}%`}`;
  await db`delete from auth.users where email like ${`${TEST_TAG}-%@example.test`}`;

  const userId = crypto.randomUUID();
  await db`
    insert into auth.users (id, email)
    values (${userId}, ${`${TEST_TAG}-${userId}@example.test`})
  `;
  const pharmacy = await pharmacies.createPharmacy(userId, { name: `${TEST_TAG} Owner Pharmacy` });
  ctx = { userId, pharmacy };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id = ${ctx.pharmacy.id}`;
  await db`delete from auth.users where id = ${ctx.userId}`;
  await db.end({ timeout: 5 });
});

test('a pharmacy with no website gets null, not an error', { skip: SKIP && skipReason }, async () => {
  // The most-visited state this feature has. A 404 here would make the
  // ordinary path the error path.
  const site = await websiteService.getWebsite(ctx.pharmacy.id);
  assert.equal(site, null);
});

test('saving a site that does not exist reports NO_WEBSITE rather than creating one', { skip: SKIP && skipReason }, async () => {
  const r = await websiteService.saveSiteData(ctx.pharmacy.id, { blocks: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_WEBSITE');
});

test('an unknown template is refused before any row is written', { skip: SKIP && skipReason }, async () => {
  const r = await websiteService.createWebsite(ctx.pharmacy.id, { templateId: 'does-not-exist' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_TEMPLATE');
  assert.equal(await websiteService.getWebsite(ctx.pharmacy.id), null, 'no row may be left behind');
});

test('creating from a template clones its seed and records the version', { skip: SKIP && skipReason }, async () => {
  const r = await websiteService.createWebsite(ctx.pharmacy.id, { templateId: 'professional' });
  assert.equal(r.ok, true);
  assert.equal(r.site.template_id, 'professional');
  assert.equal(r.site.template_version, templates.getTemplate('professional').version);
  assert.deepEqual(r.site.site_data, templates.getTemplate('professional').seed);
  assert.equal(r.site.status, 'draft');
});

test('a second create is refused rather than silently discarding the first', { skip: SKIP && skipReason }, async () => {
  // Two clicks on "Use this template" race. Check-then-insert has a window
  // where the second click wins and throws away what the first one built.
  const r = await websiteService.createWebsite(ctx.pharmacy.id, { templateId: 'professional' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WEBSITE_EXISTS');
});

test('saving the draft round-trips through jsonb unchanged', { skip: SKIP && skipReason }, async () => {
  // Versions written explicitly, because that is the shape that comes back:
  // the contract fills in the current version on save so stored data always
  // pins the block it was authored against.
  const siteData = {
    blocks: [
      { type: 'pharmacy.header', version: 1, props: {} },
      { type: 'pharmacy.hero', version: 1, props: { heading: 'Ikeja’s community pharmacy', subheading: 'Since 2014' } },
      { type: 'pharmacy.whatsappCta', version: 1, props: { label: 'Chat with us' } },
    ],
  };
  const saved = await websiteService.saveSiteData(ctx.pharmacy.id, siteData);
  assert.equal(saved.ok, true);

  const read = await websiteService.getWebsite(ctx.pharmacy.id);
  assert.deepEqual(read.site_data, siteData);
});

/**
 * THE PUBLISHING INVARIANT — the Phase 1 half.
 *
 * A pharmacy must be able to change its website without the public site
 * changing. Phase 4 completes this test by publishing first and asserting
 * the served page is unchanged; what can be asserted today is the mechanism
 * that makes it true: saving a draft writes site_data and touches neither
 * published_data nor status.
 */
test('saving a draft leaves the published state completely untouched', { skip: SKIP && skipReason }, async () => {
  const before = await db`
    select published_data, published_html, published_at, status
    from pharmacy_websites where pharmacy_id = ${ctx.pharmacy.id}
  `;

  await websiteService.saveSiteData(ctx.pharmacy.id, {
    blocks: [{ type: 'rx-footer', props: { note: 'edited after the snapshot' } }],
  });

  const after = await db`
    select published_data, published_html, published_at, status
    from pharmacy_websites where pharmacy_id = ${ctx.pharmacy.id}
  `;
  assert.deepEqual(after[0], before[0], 'a draft save must not alter anything published');
});

test('content and theme merge independently, so two guided steps cannot undo each other', { skip: SKIP && skipReason }, async () => {
  await websiteService.saveContent(ctx.pharmacy.id, { content: { about: 'Family run since 2014' } });
  // A real theme setting since Phase 3 — see the note on the content-patch
  // test above.
  await websiteService.saveContent(ctx.pharmacy.id, { theme: { palette: 'green' } });

  const site = await websiteService.getWebsite(ctx.pharmacy.id);
  assert.deepEqual(site.content, { about: 'Family run since 2014' }, 'theme write must not clear content');
  assert.deepEqual(site.theme, { palette: 'green' });
});

// ---------------------------------------------------------------------
// Switching template on an EXISTING site.
//
// The operation "Change design" performs. It is deliberately not
// createWebsite: that refuses once a site exists, for a good reason (see the
// second-create test above), and reusing it would mean either weakening that
// guard or deleting and recreating a row that other tables reference.
// ---------------------------------------------------------------------

test('switching to an unknown template changes nothing', { skip: SKIP && skipReason }, async () => {
  const before = await websiteService.getWebsite(ctx.pharmacy.id);
  const r = await websiteService.switchTemplate(ctx.pharmacy.id, 'does-not-exist');

  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_TEMPLATE');
  const after = await websiteService.getWebsite(ctx.pharmacy.id);
  assert.equal(after.template_id, before.template_id);
  assert.deepEqual(after.site_data, before.site_data);
});

/**
 * THE TEMPLATE-SWITCH SAFETY INVARIANT.
 *
 * Changing design must change the DESIGN — the block composition — and
 * nothing an owner typed or chose. theme and content live in their own
 * columns precisely so this is expressible: a switch rewrites site_data and
 * leaves both alone. If a future change makes switchTemplate write to either,
 * this test is what says so, and the failure it prevents is a pharmacy losing
 * its colours and its health-guide choices for pressing "Use this design".
 */
test('switching template replaces the structure and keeps the pharmacy’s own settings', { skip: SKIP && skipReason }, async () => {
  const before = await websiteService.getWebsite(ctx.pharmacy.id);
  assert.equal(before.template_id, 'professional', 'precondition for this test');

  const r = await websiteService.switchTemplate(ctx.pharmacy.id, 'modern');
  assert.equal(r.ok, true);

  const modern = templates.getTemplate('modern');
  assert.equal(r.site.template_id, 'modern');
  assert.equal(r.site.template_version, modern.version);
  assert.deepEqual(r.site.site_data, modern.seed, 'the new design supplies the whole structure');

  // The half that matters: nothing the owner set went with it.
  assert.deepEqual(r.site.theme, before.theme, 'theme must survive a design change');
  assert.deepEqual(r.site.content, before.content, 'guided answers and health choices must survive');
  assert.equal(r.site.subdomain, before.subdomain, 'the web address is not part of a design');
});

test('switching template does not publish, and does not touch what is published', { skip: SKIP && skipReason }, async () => {
  // The whole draft/published separation in one assertion: an owner comparing
  // designs cannot accidentally replace the page their customers are looking
  // at. Publishing stays a separate, deliberate click.
  const before = await db`
    select published_data, published_html, published_at, status
    from pharmacy_websites where pharmacy_id = ${ctx.pharmacy.id}
  `;

  const r = await websiteService.switchTemplate(ctx.pharmacy.id, 'premium');
  assert.equal(r.ok, true);
  assert.equal(r.site.status, before[0].status, 'a design change must not alter publication status');

  const after = await db`
    select published_data, published_html, published_at, status
    from pharmacy_websites where pharmacy_id = ${ctx.pharmacy.id}
  `;
  assert.deepEqual(after[0], before[0], 'switching designs must not alter anything published');
});

test('an invalid draft is rejected without overwriting the stored one', { skip: SKIP && skipReason }, async () => {
  const before = await websiteService.getWebsite(ctx.pharmacy.id);
  const r = await websiteService.saveSiteData(ctx.pharmacy.id, {
    blocks: [{ type: 'rx-invented-block', props: {} }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_BLOCK');

  const after = await websiteService.getWebsite(ctx.pharmacy.id);
  assert.deepEqual(after.site_data, before.site_data, 'a rejected save must change nothing');
});
