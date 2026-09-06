/**
 * Publishing, and the public page.
 *
 * The pure half — address rules, the public resolver, the CSP — always runs.
 * That half matters most: the address is permanent once printed, and the
 * resolver is the only function in this codebase that turns unauthenticated
 * input into a database lookup.
 *
 * The database half is gated on TEST_DATABASE_URL, and the redirect is
 * declared ABOVE the app requires for the reason GOLDEN-004 exists.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — publishing NOT verified';

require('./helpers/testDb').useTestDatabase(TEST_URL);

const { normalizeWebAddress, suggestWebAddress, RESERVED } = require('../services/website/webAddress');
const publicSite = require('../services/website/publicSite');

// =====================================================================
// THE WEB ADDRESS — always runs
// =====================================================================

test('a sensible address is accepted and lowercased', () => {
  for (const input of ['ikeja-family-pharmacy', 'IkejaPharmacy', '  allen-pharmacy  ']) {
    const r = normalizeWebAddress(input);
    assert.equal(r.ok, true, `${input}: ${r.error}`);
    assert.equal(r.value, r.value.toLowerCase());
  }
});

test('an address that could not survive as a hostname is refused', () => {
  // Refused now even though a path would tolerate them, because this same
  // value becomes a subdomain later and taking an address back off a pharmacy
  // that has printed it is not something the product can do.
  const bad = [
    ['ab', 'too short'],
    ['a'.repeat(41), 'too long'],
    ['-pharmacy', 'leading hyphen'],
    ['pharmacy-', 'trailing hyphen'],
    ['my--pharmacy', 'double hyphen'],
    ['xn-pharmacy', 'punycode prefix'],
    ['12345', 'all digits'],
    ['my pharmacy', 'space'],
    ['my_pharmacy', 'underscore'],
    ['phar.macy', 'dot'],
    ['phärmacy', 'non-ascii'],
    ['PHARMACY/../etc', 'path traversal'],
  ];
  for (const [value, why] of bad) {
    assert.equal(normalizeWebAddress(value).ok, false, `${value} (${why}) must be refused`);
  }
});

test('a non-string address is refused rather than coerced', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(normalizeWebAddress(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

/**
 * The reserved list is not only about infrastructure.
 *
 * `secure`, `login` and `verify` are on it because a real, working page at
 * secure.rxnaija.com — served over our certificate, controlled by whoever
 * signed up first — is a credential-harvesting site. That is the category
 * people leave out, so it gets its own test.
 */
test('names that would make a phishing page are reserved', () => {
  for (const name of ['login', 'signin', 'secure', 'verify', 'account', 'billing', 'password']) {
    const r = normalizeWebAddress(name);
    assert.equal(r.ok, false, `${name} must be reserved`);
    assert.equal(r.code, 'ADDRESS_RESERVED');
  }
});

test('infrastructure and product names are reserved', () => {
  for (const name of ['www', 'mail', 'api', 'app', 'admin', 'p', 'staging', 'cdn']) {
    assert.equal(normalizeWebAddress(name).ok, false, `${name} must be reserved`);
  }
});

test('the reservation message does not explain why a name is reserved', () => {
  // "secure is reserved because it would look like a login page" is a hint
  // worth not giving.
  const r = normalizeWebAddress('secure');
  assert.ok(!/phish|login page|reserved because/i.test(r.error), r.error);
});

test('a suggested address is derived from the name, or nothing at all', () => {
  assert.equal(suggestWebAddress('Ikeja Family Pharmacy'), 'ikeja-family-pharmacy');
  assert.equal(suggestWebAddress("O'Brien & Sons Pharmacy"), 'o-brien-sons-pharmacy');
  // Reduces to a reserved or unusable value → no suggestion, so the form asks
  // rather than proposing something that will be rejected.
  assert.equal(suggestWebAddress('!!!'), null);
  assert.equal(suggestWebAddress('www'), null);
});

test('every reserved name would otherwise have been a legal address', () => {
  // A reserved list containing values the format rules already reject is a
  // list that has quietly stopped protecting anything.
  for (const name of RESERVED) {
    if (name.length < 3 || name.length > 40) continue;
    assert.ok(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name), `${name} is not address-shaped`);
  }
});

// =====================================================================
// THE PUBLIC RESOLVER — always runs
// =====================================================================

test('the resolver accepts a real address and lowercases it', () => {
  assert.equal(publicSite.resolveSiteKey({ params: { slug: 'Ikeja-Pharmacy' } }), 'ikeja-pharmacy');
});

test('malformed input never reaches the database', () => {
  // This is the only function in the codebase turning unauthenticated input
  // into a lookup. Scanners send a great deal of the following.
  const junk = [
    undefined, null, 42, {}, [],
    '', 'a', '-x-', 'x-', 'my--site', 'a'.repeat(64),
    '../../etc/passwd', 'foo/bar', 'foo?x=1', 'foo%00', "foo' or '1'='1",
    '<script>', 'foo bar', 'FOO.BAR',
  ];
  for (const slug of junk) {
    assert.equal(
      publicSite.resolveSiteKey({ params: { slug } }), null,
      `${JSON.stringify(slug)} must not resolve`,
    );
  }
  assert.equal(publicSite.resolveSiteKey({}), null);
  assert.equal(publicSite.resolveSiteKey(undefined), null);
});

test('an address the validator would accept is one the resolver accepts', () => {
  // If these two ever disagree, a pharmacy can claim an address that can
  // never be served — a website that exists and is unreachable.
  for (const name of ['abc', 'ikeja-family-pharmacy', 'pharmacy24', 'a-b-c', 'x'.repeat(40)]) {
    const claimed = normalizeWebAddress(name);
    if (!claimed.ok) continue;
    assert.equal(
      publicSite.resolveSiteKey({ params: { slug: claimed.value } }), claimed.value,
      `${name} is claimable but not resolvable`,
    );
  }
});

test('the ETag changes with the page and not otherwise', () => {
  assert.equal(publicSite.etagFor('<p>a</p>'), publicSite.etagFor('<p>a</p>'));
  assert.notEqual(publicSite.etagFor('<p>a</p>'), publicSite.etagFor('<p>b</p>'));
  assert.match(publicSite.etagFor('x'), /^W\/"/);
});

test('the published CSP forbids script entirely', () => {
  // The published page contains no JavaScript, so the stored-XSS class is
  // unreachable rather than defended against. This asserts the header agrees.
  //
  // Phase 6 turned PUBLIC_CSP from a constant into publicCsp(), because the
  // storage origin uploaded images are served from comes from configuration.
  const csp = publicSite.publicCsp();
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);
});

// =====================================================================
// DATABASE
// =====================================================================

const TEST_TAG = 'websitepub';
let db;
let pharmacies;
let websiteService;
let publishService;
let ctx = null;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  pharmacies = require('../services/pharmacies');
  websiteService = require('../services/website/websiteService');
  publishService = require('../services/website/publishService');

  await db`delete from pharmacies where name like ${`${TEST_TAG}%`}`;
  await db`delete from auth.users where email like ${`${TEST_TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`
    insert into auth.users (id, email)
    values (${userA}, ${`${TEST_TAG}-a-${userA}@example.test`}),
           (${userB}, ${`${TEST_TAG}-b-${userB}@example.test`})
  `;

  const a = await pharmacies.createPharmacy(userA, { name: `${TEST_TAG} Alpha Pharmacy` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TEST_TAG} Beta Pharmacy` });

  await db`update pharmacies set public_whatsapp_number = '2348000000011' where id = ${a.id}`;
  await db`update pharmacies set public_whatsapp_number = '2348000000022' where id = ${b.id}`;
  await pharmacies.updateProfile(a.id, { city: 'Ikeja', address_line: 'ALPHA STREET' });
  await pharmacies.updateProfile(b.id, { city: 'Abuja', address_line: 'BETA STREET' });

  await websiteService.createWebsite(a.id, { templateId: 'professional' });
  await websiteService.createWebsite(b.id, { templateId: 'modern' });

  ctx = { userA, userB, a, b };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

test('publishing without an address is refused, not half-done', { skip: SKIP && skipReason }, async () => {
  const r = await publishService.publishWebsite(ctx.a.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_ADDRESS');
  const site = await websiteService.getWebsite(ctx.a.id);
  assert.equal(site.status, 'draft', 'a refused publish must leave the status alone');
});

test('an address can be claimed once, by one pharmacy', { skip: SKIP && skipReason }, async () => {
  const claimed = await publishService.setWebAddress(ctx.a.id, `${TEST_TAG}-alpha`);
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.site.subdomain, `${TEST_TAG}-alpha`);

  // B cannot take A's. Enforced by the unique constraint, not a pre-check,
  // so it holds under a race.
  const stolen = await publishService.setWebAddress(ctx.b.id, `${TEST_TAG}-alpha`);
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, 'ADDRESS_TAKEN');

  const ok = await publishService.setWebAddress(ctx.b.id, `${TEST_TAG}-beta`);
  assert.equal(ok.ok, true, ok.error);
});

test('publishing renders the page and records what went live', { skip: SKIP && skipReason }, async () => {
  const r = await publishService.publishWebsite(ctx.a.id, { userId: ctx.userA });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.site.status, 'published');
  assert.ok(r.site.published_at);

  const [row] = await db`
    select published_html, published_data from pharmacy_websites where pharmacy_id = ${ctx.a.id}
  `;
  assert.ok(row.published_html.startsWith('<!doctype html>'));
  assert.match(row.published_html, /ALPHA STREET/);
  // PHASE 7 CHANGED THIS. A published page no longer carries a raw wa.me
  // link: canonical WhatsApp, phone and directions links now route through
  // /p/<address>/go/... so the taps can be counted without any JavaScript on
  // the page. The destination is still the pharmacy's own number — it is
  // resolved server-side by the redirect, and the test below asserts that.
  assert.match(row.published_html, new RegExp(`/p/${TEST_TAG}-alpha/go/whatsapp`));
  assert.ok(!row.published_html.includes('wa.me/2348000000011'),
    'the raw link is replaced, not accompanied');
  assert.ok(row.published_data, 'the snapshot of what was published must be stored');
});

/**
 * THE PUBLISHING INVARIANT, COMPLETE.
 *
 * Phase 1 could only assert half of this — that a draft save leaves the
 * published columns alone. Now there is something published to compare
 * against, so it can be asserted the way an owner would experience it: edit
 * all afternoon, and the page your customers are looking at does not move
 * until you say so.
 */
test('editing the draft does not change the live page until you publish', { skip: SKIP && skipReason }, async () => {
  const [before] = await db`select published_html from pharmacy_websites where pharmacy_id = ${ctx.a.id}`;

  await websiteService.saveSiteData(ctx.a.id, {
    blocks: [{ type: 'pharmacy.hero', version: 1, props: { heading: 'DRAFT ONLY HEADING' } }],
  });

  const [during] = await db`select published_html from pharmacy_websites where pharmacy_id = ${ctx.a.id}`;
  assert.equal(during.published_html, before.published_html, 'the live page must not move');
  assert.ok(!during.published_html.includes('DRAFT ONLY HEADING'));

  const served = await publicSite.getPublishedSite(`${TEST_TAG}-alpha`);
  assert.ok(!served.published_html.includes('DRAFT ONLY HEADING'),
    'and the public route must not serve the draft either');

  await publishService.publishWebsite(ctx.a.id, { userId: ctx.userA });
  const [after] = await db`select published_html from pharmacy_websites where pharmacy_id = ${ctx.a.id}`;
  assert.match(after.published_html, /DRAFT ONLY HEADING/, 'publishing must move it');
});

test('a profile change refreshes the live page without republishing', { skip: SKIP && skipReason }, async () => {
  // The whole point of inheritance: change your phone number in Settings and
  // the published page catches up on its own.
  await pharmacies.updateProfile(ctx.a.id, { address_line: 'ALPHA MOVED' });
  const result = await publishService.rerenderPublished(ctx.a.id);
  assert.equal(result.skipped, false);

  const served = await publicSite.getPublishedSite(`${TEST_TAG}-alpha`);
  assert.match(served.published_html, /ALPHA MOVED/);
});

test('a re-render for an unpublished pharmacy is a no-op, not an error', { skip: SKIP && skipReason }, async () => {
  const r = await publishService.rerenderPublished(ctx.b.id);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true, 'the job runs for every profile save; most have nothing to render');
});

test('unpublishing takes the page down but keeps the snapshot', { skip: SKIP && skipReason }, async () => {
  const r = await publishService.unpublishWebsite(ctx.a.id);
  assert.equal(r.ok, true);
  assert.equal(r.site.status, 'unpublished');

  assert.equal(await publicSite.getPublishedSite(`${TEST_TAG}-alpha`), null,
    'the public route must stop serving it immediately');

  const [row] = await db`select published_html from pharmacy_websites where pharmacy_id = ${ctx.a.id}`;
  assert.ok(row.published_html, 'the snapshot is kept, so republishing is instant and lossless');

  // And unpublishing twice is refused rather than silently succeeding.
  assert.equal((await publishService.unpublishWebsite(ctx.a.id)).code, 'NOT_PUBLISHED');
});

test('republishing brings the same page straight back', { skip: SKIP && skipReason }, async () => {
  const r = await publishService.publishWebsite(ctx.a.id, { userId: ctx.userA });
  assert.equal(r.ok, true);
  const served = await publicSite.getPublishedSite(`${TEST_TAG}-alpha`);
  assert.ok(served, 'it must be reachable again');
});

test('every publish records a revision, and history stays bounded', { skip: SKIP && skipReason }, async () => {
  const before = (await publishService.listRevisions(ctx.a.id)).length;
  await publishService.publishWebsite(ctx.a.id, { userId: ctx.userA });
  const after = await publishService.listRevisions(ctx.a.id);
  assert.equal(after.length, Math.min(before + 1, publishService.KEEP_REVISIONS));
  assert.ok(after[0].created_at, 'revisions come back newest first');
});

test('revision history is pruned rather than growing forever', { skip: SKIP && skipReason }, async () => {
  for (let i = 0; i < publishService.KEEP_REVISIONS + 3; i += 1) {
    await publishService.publishWebsite(ctx.a.id, { userId: ctx.userA });
  }
  const [{ n }] = await db`
    select count(*)::int as n from website_revisions where pharmacy_id = ${ctx.a.id}
  `;
  assert.equal(n, publishService.KEEP_REVISIONS);
});

test('restoring a revision goes to the draft, never straight to live', { skip: SKIP && skipReason }, async () => {
  const revisions = await publishService.listRevisions(ctx.a.id);
  const [liveBefore] = await db`select published_html from pharmacy_websites where pharmacy_id = ${ctx.a.id}`;

  const r = await publishService.restoreRevision(ctx.a.id, revisions[revisions.length - 1].id);
  assert.equal(r.ok, true, r.error);

  const [liveAfter] = await db`select published_html from pharmacy_websites where pharmacy_id = ${ctx.a.id}`;
  assert.equal(liveAfter.published_html, liveBefore.published_html,
    'an owner restoring something must not discover they have already replaced their public page');
});

test('another pharmacy’s revision id is not found, rather than forbidden', { skip: SKIP && skipReason }, async () => {
  await publishService.publishWebsite(ctx.b.id, { userId: ctx.userB });
  const bRevisions = await publishService.listRevisions(ctx.b.id);
  assert.ok(bRevisions.length > 0);

  const r = await publishService.restoreRevision(ctx.a.id, bRevisions[0].id);
  assert.equal(r.ok, false);
  // 404, not 403 — confirming an id exists is itself a disclosure. Same
  // reasoning as selectTenant in middleware/auth.js.
  assert.equal(r.code, 'NOT_FOUND');
});

test('a malformed revision id is refused without a query', { skip: SKIP && skipReason }, async () => {
  for (const id of ['abc', '-1', '1; drop table website_revisions', null, undefined, 1.5]) {
    const r = await publishService.restoreRevision(ctx.a.id, id);
    assert.equal(r.ok, false, `${JSON.stringify(id)} must be refused`);
    assert.equal(r.code, 'NOT_FOUND');
  }
});

/**
 * THE ISOLATION CLAIM, IN ITS PUBLISHED FORM.
 *
 * A cross-tenant bug here does not show one pharmacy another's data — it
 * PUBLISHES it, under the wrong business's name, with the wrong WhatsApp
 * number on the contact button, to anyone who visits.
 */
test('a published page serves only its own pharmacy’s content', { skip: SKIP && skipReason }, async () => {
  const alpha = await publicSite.getPublishedSite(`${TEST_TAG}-alpha`);
  const beta = await publicSite.getPublishedSite(`${TEST_TAG}-beta`);
  assert.ok(alpha && beta);

  // PHASE 7: the number is no longer in the markup — the WhatsApp button
  // points at this pharmacy's own /go/ redirect, which resolves the number
  // server-side. So the isolation claim moves to where the truth now lives,
  // and gets STRONGER for it: the page must carry only its own address, and
  // that address must resolve to only its own number.
  assert.ok(alpha.published_html.includes(`/p/${TEST_TAG}-alpha/go/`), 'Alpha links to its own address');
  assert.ok(!alpha.published_html.includes(`${TEST_TAG}-beta`), "Alpha must not link to Beta's address");
  assert.ok(!alpha.published_html.includes('2348000000022'), "Alpha must not carry Beta's number");
  assert.ok(!alpha.published_html.includes('BETA STREET'), "Alpha must not carry Beta's address");

  const alphaTarget = await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'whatsapp');
  const betaTarget = await publicSite.getClickTarget(`${TEST_TAG}-beta`, 'whatsapp');
  assert.match(alphaTarget.destination, /2348000000011/, "Alpha's button must reach Alpha");
  assert.match(betaTarget.destination, /2348000000022/, "Beta's button must reach Beta");

  assert.ok(beta.published_html.includes(`/p/${TEST_TAG}-beta/go/`), 'Beta links to its own address');
  assert.ok(!beta.published_html.includes('2348000000011'), "Beta must not carry Alpha's number");
});

test('an address that belongs to nobody resolves to nothing', { skip: SKIP && skipReason }, async () => {
  assert.equal(await publicSite.getPublishedSite('no-such-pharmacy-anywhere'), null);
  assert.equal(await publicSite.getPublishedSite(''), null);
  assert.equal(await publicSite.getPublishedSite(null), null);
});

test('every publish function throws on a missing tenant id', { skip: SKIP && skipReason }, async () => {
  for (const id of [undefined, null, '', 'not-a-uuid', 123]) {
    await assert.rejects(() => publishService.publishWebsite(id), /Tenant guard/);
    await assert.rejects(() => publishService.unpublishWebsite(id), /Tenant guard/);
    await assert.rejects(() => publishService.setWebAddress(id, 'abc'), /Tenant guard/);
    await assert.rejects(() => publishService.listRevisions(id), /Tenant guard/);
    await assert.rejects(() => publishService.rerenderPublished(id), /Tenant guard/);
  }
});
