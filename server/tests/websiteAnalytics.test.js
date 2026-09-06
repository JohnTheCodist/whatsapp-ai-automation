/**
 * Website analytics, and the subdomain resolver.
 *
 * Both are here because both are about how the PUBLIC side of the website
 * behaves — one counts what happened on it, the other decides which pharmacy
 * a request is for. Neither may ever get either answer wrong for a tenant.
 *
 * The pure half always runs and is the larger one: the host resolver, the
 * canonical-link rules and the buffering are all decidable without a database.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — website analytics NOT verified';

require('./helpers/testDb').useTestDatabase(TEST_URL);

const analytics = require('../services/website/analytics');
const publicSite = require('../services/website/publicSite');
const { waHref, telHref, mapsHref, trackedHref } = require('../services/website/blocks/render');
const { renderDocument } = require('../services/website/document');
const templates = require('../services/website/templates');

// =====================================================================
// THE SUBDOMAIN RESOLVER — always runs
// =====================================================================

const DOMAIN = 'rxnaija.com';

test('a pharmacy subdomain resolves to its address', () => {
  assert.equal(publicSite.addressFromHost('ikeja-pharmacy.rxnaija.com', DOMAIN), 'ikeja-pharmacy');
  assert.equal(publicSite.addressFromHost('IKEJA-PHARMACY.RxNaija.com', DOMAIN), 'ikeja-pharmacy');
  // A port and a trailing dot are both legal in a Host header.
  assert.equal(publicSite.addressFromHost('ikeja-pharmacy.rxnaija.com:8443', DOMAIN), 'ikeja-pharmacy');
  assert.equal(publicSite.addressFromHost('ikeja-pharmacy.rxnaija.com.', DOMAIN), 'ikeja-pharmacy');
});

test('the base domain itself is not a pharmacy', () => {
  // rxnaija.com is the dashboard. Resolving it as an address would serve a
  // pharmacy's website where the product should be.
  assert.equal(publicSite.addressFromHost('rxnaija.com', DOMAIN), null);
  assert.equal(publicSite.addressFromHost('www.rxnaija.com', DOMAIN), null,
    'www is reserved, so it can never be claimed and must not resolve');
});

test('a host that is not under the base domain never resolves', () => {
  for (const host of [
    'ikeja-pharmacy.evil.com',
    'rxnaija.com.evil.com',
    'notrxnaija.com',
    'ikeja-pharmacy.rxnaija.com.evil.com',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(publicSite.addressFromHost(host, DOMAIN), null, `${JSON.stringify(host)} must not resolve`);
  }
});

test('a nested label is refused rather than guessed at', () => {
  // `a.b.rxnaija.com` is not an address this system issues. Treating the
  // last label as one would let a wildcard certificate cover a name nobody
  // claimed.
  assert.equal(publicSite.addressFromHost('a.b.rxnaija.com', DOMAIN), null);
});

test('with no base domain configured, no host resolves at all', () => {
  // The committed default. Subdomains need wildcard DNS and a wildcard
  // certificate, and until those exist this branch must be inert.
  assert.equal(publicSite.addressFromHost('anything.rxnaija.com', ''), null);
  assert.equal(publicSite.addressFromHost('anything.rxnaija.com', undefined), null);
});

/**
 * The rule that stops one pharmacy's domain serving another's page.
 *
 * When subdomains are live, `ikeja.rxnaija.com/p/other-pharmacy` must serve
 * Ikeja. The hostname is the stronger claim — a visitor typed it, and a
 * certificate was issued for it — so a path must never override it.
 */
test('the hostname wins over the path', () => {
  const saved = process.env.PUBLIC_SITE_DOMAIN;
  process.env.PUBLIC_SITE_DOMAIN = DOMAIN;
  try {
    assert.equal(
      publicSite.resolveSiteKey({ hostname: 'ikeja.rxnaija.com', params: { slug: 'other-pharmacy' } }),
      'ikeja',
    );
    // And with no matching host it falls back to the path form that works today.
    assert.equal(
      publicSite.resolveSiteKey({ hostname: 'rxnaija.com', params: { slug: 'other-pharmacy' } }),
      'other-pharmacy',
    );
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_SITE_DOMAIN;
    else process.env.PUBLIC_SITE_DOMAIN = saved;
  }
});

// =====================================================================
// TRACKED LINKS — always runs
// =====================================================================

const CTX = Object.freeze({
  pharmacy: { public_whatsapp_number: '2348012345678' },
  profile: { phone: '08012345678', maps_url: 'https://maps.google.com/?q=ikeja' },
  trackingBase: '/p/ikeja-pharmacy',
});

test('without a tracking base every link is direct', () => {
  // A preview, or a test. Nothing counted, nothing redirected.
  const plain = { ...CTX, trackingBase: null };
  assert.match(waHref('2348012345678', 'Hi', plain), /^https:\/\/wa\.me\//);
  assert.match(telHref('08012345678', plain), /^tel:/);
  assert.match(mapsHref('https://maps.google.com/?q=ikeja', plain), /^https:\/\/maps\./);
});

test('a canonical link is routed through the counting redirect', () => {
  assert.equal(waHref('2348012345678', null, CTX), '/p/ikeja-pharmacy/go/whatsapp');
  assert.equal(telHref('08012345678', CTX), '/p/ikeja-pharmacy/go/phone');
  assert.equal(mapsHref('https://maps.google.com/?q=ikeja', CTX), '/p/ikeja-pharmacy/go/directions');
});

/**
 * THE RULE THAT KEEPS THE REDIRECT HONEST.
 *
 * `/go/whatsapp` resolves its destination from the pharmacy's own record. So
 * a block that overrides the number with a different one must NOT be tracked
 * — the redirect would send that customer to the canonical number instead,
 * which is a wrong destination bought with a statistic.
 */
test('an overridden number stays a direct link and is not counted', () => {
  const overridden = waHref('2349999999999', 'Hi', CTX);
  assert.match(overridden, /^https:\/\/wa\.me\/2349999999999/,
    'a different number must go where it says, not through the redirect');
  assert.ok(!overridden.includes('/go/'));

  assert.match(telHref('08099999999', CTX), /^tel:/);
  assert.match(mapsHref('https://example.com/elsewhere', CTX), /^https:\/\/example\.com/);
});

test('a number written differently is still the same number', () => {
  // +234 801 234 5678 and 2348012345678 are one number; a formatting
  // difference must not silently disable tracking.
  assert.equal(waHref('+234 801 234 5678', null, CTX), '/p/ikeja-pharmacy/go/whatsapp');
});

test('the prefilled message survives into the redirect, bounded', () => {
  const url = waHref('2348012345678', 'Hello, I have a question', CTX);
  assert.match(url, /\/go\/whatsapp\?m=Hello%2C%20I%20have%20a%20question$/);

  const long = waHref('2348012345678', 'x'.repeat(500), CTX);
  const encoded = decodeURIComponent(long.split('m=')[1]);
  assert.equal(encoded.length, 160, 'the message must be capped, not passed through whole');
});

test('an empty destination stays empty rather than becoming a redirect to nothing', () => {
  assert.equal(waHref('', null, CTX), '');
  assert.equal(telHref(null, CTX), '');
  assert.equal(trackedHref('whatsapp', '', CTX, { canonical: true }), '');
});

/**
 * THE SAFETY NET FOR A MISSED CALL SITE.
 *
 * Tracking was added by swapping the link builders inside eleven block
 * definitions. If one had been missed, that block's button would quietly stay
 * untracked forever and nobody would notice — the page still works. This
 * renders a whole template with tracking on and asserts that no canonical
 * destination escaped as a raw link.
 */
test('no canonical link escapes untracked from a published page', () => {
  const html = renderDocument({
    site: templates.cloneSeed('premium'),
    pharmacy: { name: 'Ikeja Family Pharmacy', public_whatsapp_number: '2348012345678' },
    profile: {
      phone: '08012345678',
      address_line: '12 Allen Avenue',
      city: 'Ikeja',
      maps_url: 'https://maps.google.com/?q=ikeja',
      description: 'Family run.',
    },
    trackingBase: '/p/ikeja-pharmacy',
    year: 2026,
  });

  assert.ok(!html.includes('https://wa.me/2348012345678'),
    'a raw wa.me link means a block was missed when tracking was wired in');
  assert.ok(!html.includes('tel:08012345678'), 'a raw tel: link means a block was missed');
  assert.ok(!html.includes('href="https://maps.google.com'), 'a raw maps link means a block was missed');
  assert.match(html, /\/go\/whatsapp/, 'and the tracked links must actually be there');
});

test('a preview page carries no tracking links at all', () => {
  // The owner looking at their own page must not be counted as engagement —
  // that would make the one number this feature produces a lie.
  const html = renderDocument({
    site: templates.cloneSeed('premium'),
    pharmacy: { name: 'Ikeja Family Pharmacy', public_whatsapp_number: '2348012345678' },
    profile: { phone: '08012345678', city: 'Ikeja' },
    noindex: true,
  });
  assert.ok(!html.includes('/go/'), 'a preview must never route through the counter');
  assert.match(html, /https:\/\/wa\.me\/2348012345678/);
});

// =====================================================================
// BUFFERING — always runs
// =====================================================================

test('recording buffers in memory rather than writing', () => {
  analytics._reset();
  const id = crypto.randomUUID();
  analytics.record(id, 'view');
  analytics.record(id, 'view');
  analytics.record(id, 'whatsapp');
  // Two kinds, three events — a burst of traffic becomes one row per kind.
  assert.equal(analytics._buffer().size, 2);
  assert.equal([...analytics._buffer().values()].reduce((a, b) => a + b, 0), 3);
  analytics._reset();
});

test('an unknown kind or a missing pharmacy is ignored, not recorded', () => {
  // This runs on unauthenticated traffic. It must never throw and never
  // invent a row.
  analytics._reset();
  analytics.record(null, 'view');
  analytics.record(undefined, 'view');
  analytics.record(crypto.randomUUID(), 'not-a-kind');
  analytics.record(crypto.randomUUID(), null);
  assert.equal(analytics._buffer().size, 0);
});

// =====================================================================
// DATABASE
// =====================================================================

const TEST_TAG = 'websiteanalytics';
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

  await db`update pharmacies set public_whatsapp_number = '2348000000101' where id = ${a.id}`;
  await pharmacies.updateProfile(a.id, {
    phone: '08011111111', city: 'Ikeja', address_line: 'ALPHA ROAD',
    maps_url: 'https://maps.google.com/?q=alpha',
  });

  await websiteService.createWebsite(a.id, { templateId: 'professional' });
  await publishService.setWebAddress(a.id, `${TEST_TAG}-alpha`);
  await publishService.publishWebsite(a.id, { userId: userA });

  ctx = { userA, userB, a, b };
});

after(async () => {
  if (SKIP || !ctx) return;
  analytics._reset();
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

test('a flush writes the buffer and a second flush adds to it', { skip: SKIP && skipReason }, async () => {
  analytics._reset();
  analytics.record(ctx.a.id, 'view');
  analytics.record(ctx.a.id, 'view');
  analytics.record(ctx.a.id, 'whatsapp');
  assert.equal((await analytics.flush()).written, 2);
  assert.equal(analytics._buffer().size, 0, 'a successful flush empties the buffer');

  analytics.record(ctx.a.id, 'view');
  await analytics.flush();

  const [row] = await db`
    select count from website_events
     where pharmacy_id = ${ctx.a.id} and kind = 'view' and day = current_date
  `;
  assert.equal(row.count, 3, 'a second flush must add to the day, not replace it');
});

test('flushing an empty buffer is a no-op', { skip: SKIP && skipReason }, async () => {
  analytics._reset();
  assert.equal((await analytics.flush()).written, 0);
});

test('the summary reports totals, conversions and a rate', { skip: SKIP && skipReason }, async () => {
  const s = await analytics.summary(ctx.a.id, { days: 30 });
  assert.equal(s.totals.view, 3);
  assert.equal(s.totals.whatsapp, 1);
  assert.equal(s.conversions, 1);
  assert.ok(Math.abs(s.conversionRate - 1 / 3) < 1e-9);
  assert.ok(Array.isArray(s.daily) && s.daily.length >= 1);
});

test('a pharmacy with no traffic gets a null rate, not zero', { skip: SKIP && skipReason }, async () => {
  // 0% implies a measurement that happened and found nothing. Null says
  // there is nothing to divide by, which is the truth.
  const s = await analytics.summary(ctx.b.id);
  assert.equal(s.totals.view, 0);
  assert.equal(s.conversionRate, null);
});

test('one pharmacy never sees another’s numbers', { skip: SKIP && skipReason }, async () => {
  analytics._reset();
  analytics.record(ctx.b.id, 'view');
  await analytics.flush();

  const alpha = await analytics.summary(ctx.a.id);
  const beta = await analytics.summary(ctx.b.id);
  assert.equal(alpha.totals.view, 3, "Alpha's views must not include Beta's");
  assert.equal(beta.totals.view, 1);
});

test('the summary throws on a missing tenant id', { skip: SKIP && skipReason }, async () => {
  for (const id of [undefined, null, '', 'not-a-uuid']) {
    await assert.rejects(() => analytics.summary(id), /Tenant guard/);
  }
});

test('a click target is resolved from the pharmacy’s own record', { skip: SKIP && skipReason }, async () => {
  const wa = await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'whatsapp', 'Hello');
  assert.equal(wa.pharmacyId, ctx.a.id);
  assert.equal(wa.destination, 'https://wa.me/2348000000101?text=Hello');

  // 2348011111111, not 08011111111: updateProfile normalises a locally-written
  // Nigerian number to international form on the way in, so that is what is
  // stored and what a customer is redirected to. The test asserts the stored
  // truth rather than what was typed.
  const tel = await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'phone');
  assert.equal(tel.destination, 'tel:2348011111111');

  const maps = await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'directions');
  assert.equal(maps.destination, 'https://maps.google.com/?q=alpha');
});

/**
 * The open-redirect check.
 *
 * Nothing in the request says where to go — the destination comes entirely
 * from the pharmacy's record — so there is no parameter to tamper with. This
 * asserts the shape rather than trying to defeat it: an unknown kind, an
 * unpublished site and an unknown address all yield null, and the route 404s
 * rather than redirecting anywhere.
 */
test('an unknown kind, address or unpublished site redirects nowhere', { skip: SKIP && skipReason }, async () => {
  assert.equal(await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'evil'), null);
  assert.equal(await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'https://evil.com'), null);
  assert.equal(await publicSite.getClickTarget('no-such-pharmacy', 'whatsapp'), null);
  assert.equal(await publicSite.getClickTarget(null, 'whatsapp'), null);

  await publishService.unpublishWebsite(ctx.a.id);
  assert.equal(await publicSite.getClickTarget(`${TEST_TAG}-alpha`, 'whatsapp'), null,
    'an unpublished site must not redirect either');
  await publishService.publishWebsite(ctx.a.id, { userId: ctx.userA });
});

test('a published page routes its links through the counter', { skip: SKIP && skipReason }, async () => {
  const site = await publicSite.getPublishedSite(`${TEST_TAG}-alpha`);
  assert.ok(site.published_html.includes(`/p/${TEST_TAG}-alpha/go/whatsapp`),
    'publishing must produce tracked links');
  assert.ok(!site.published_html.includes('https://wa.me/2348000000101'),
    'and no raw link alongside them');
});
