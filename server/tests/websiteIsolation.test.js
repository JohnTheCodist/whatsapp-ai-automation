/**
 * WEBSITE TENANT ISOLATION — the gate for the website builder.
 *
 * Two real pharmacies owned by two different users, in a real database,
 * asserting that nothing scoped to one ever touches the other's website.
 * websiteService.test.js proves the validators in isolation; this proves the
 * actual queries.
 *
 * WHY THIS FEATURE NEEDS ITS OWN ISOLATION SUITE
 * A leak here is not the same shape as a leak anywhere else in this codebase.
 * Every other tenant table is read by staff who are already inside the
 * dashboard. This one is rendered onto the PUBLIC INTERNET under a pharmacy's
 * own name — so a cross-tenant bug does not show one pharmacy another's data,
 * it PUBLISHES it, to search engines, with the wrong business's WhatsApp
 * number on the contact button.
 *
 * REQUIRES A DATABASE. Set TEST_DATABASE_URL to a NON-PRODUCTION Postgres
 * with db/migrations applied, then:
 *
 *   TEST_DATABASE_URL=postgres://... node --test "server/tests/*.test.js"
 *
 * Without it every test here SKIPS rather than fails. A skip is visible in
 * the output — do not let a green run that skipped this suite be mistaken
 * for a passing isolation gate.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — website isolation gate NOT verified';

require('./helpers/testDb').useTestDatabase(TEST_URL);

const TEST_TAG = 'websiteiso';

let db;
let pharmacies;
let websiteService;
let ctx = null;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  pharmacies = require('../services/pharmacies');
  websiteService = require('../services/website/websiteService');

  // Sweep anything a previously failed run left behind. Pharmacies first —
  // deleting the user cascades its membership away and orphans the pharmacy,
  // leaving a row nothing can reach to clean up later.
  await db`delete from pharmacies where name like ${`${TEST_TAG}%`}`;
  await db`delete from auth.users where email like ${`${TEST_TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();

  try {
    await db`
      insert into auth.users (id, email)
      values (${userA}, ${`${TEST_TAG}-a-${userA}@example.test`}),
             (${userB}, ${`${TEST_TAG}-b-${userB}@example.test`})
    `;
  } catch (err) {
    throw new Error(
      `Could not seed auth.users on TEST_DATABASE_URL (${err.message}). `
      + `This suite needs a database with the Supabase auth schema and `
      + `db/migrations applied.`
    );
  }

  const a = await pharmacies.createPharmacy(userA, { name: `${TEST_TAG} Alpha Pharmacy` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TEST_TAG} Beta Pharmacy` });

  // Distinct WhatsApp numbers, because the CTA on a published page is built
  // from this and it is the single most damaging field to get wrong.
  await db`update pharmacies set public_whatsapp_number = '2348000000001' where id = ${a.id}`;
  await db`update pharmacies set public_whatsapp_number = '2348000000002' where id = ${b.id}`;

  await websiteService.createWebsite(a.id, { templateId: 'professional' });
  await websiteService.createWebsite(b.id, { templateId: 'professional' });

  await websiteService.saveSiteData(a.id, {
    blocks: [{ type: 'pharmacy.hero', version: 1, props: { heading: 'ALPHA ONLY' } }],
  });
  await websiteService.saveSiteData(b.id, {
    blocks: [{ type: 'pharmacy.hero', version: 1, props: { heading: 'BETA ONLY' } }],
  });

  ctx = { userA, userB, a, b };
});

after(async () => {
  if (SKIP || !ctx) return;
  // pharmacies cascade to pharmacy_websites, website_revisions and
  // pharmacy_assets — all three declare on delete cascade.
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- the websites really are distinct ----

test('each pharmacy gets its own website row', { skip: SKIP && skipReason }, async () => {
  const a = await websiteService.getWebsite(ctx.a.id);
  const b = await websiteService.getWebsite(ctx.b.id);
  assert.ok(a && b);
  assert.notEqual(a.pharmacy_id, b.pharmacy_id);
});

// ---- the isolation claims ----

test('getWebsite scoped to A never returns B’s site_data', { skip: SKIP && skipReason }, async () => {
  const a = await websiteService.getWebsite(ctx.a.id);
  assert.equal(a.site_data.blocks[0].props.heading, 'ALPHA ONLY');
  assert.notEqual(
    JSON.stringify(a.site_data).includes('BETA ONLY'), true,
    "A's website must contain nothing of B's",
  );
});

test('saving A’s website leaves B’s completely untouched', { skip: SKIP && skipReason }, async () => {
  const before = await websiteService.getWebsite(ctx.b.id);

  await websiteService.saveSiteData(ctx.a.id, {
    blocks: [{ type: 'pharmacy.hero', version: 1, props: { heading: 'ALPHA EDITED' } }],
  });
  await websiteService.saveContent(ctx.a.id, { theme: { primary: '#111111' } });

  const after = await websiteService.getWebsite(ctx.b.id);
  assert.deepEqual(after.site_data, before.site_data);
  assert.deepEqual(after.theme, before.theme);
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime(),
    "B's row must not even be touched");
});

test('creating a website for A does not create or alter one for B', { skip: SKIP && skipReason }, async () => {
  // A already has one, so this is refused — the point is that the refusal is
  // decided against A's row and never reaches B's.
  const before = await websiteService.getWebsite(ctx.b.id);
  const r = await websiteService.createWebsite(ctx.a.id, { templateId: 'professional' });
  assert.equal(r.code, 'WEBSITE_EXISTS');

  const after = await websiteService.getWebsite(ctx.b.id);
  assert.deepEqual(after, before);
});

test('exactly one website row exists per pharmacy, enforced by the primary key', { skip: SKIP && skipReason }, async () => {
  const rows = await db`
    select pharmacy_id, count(*)::int as n
    from pharmacy_websites
    where pharmacy_id in (${ctx.a.id}, ${ctx.b.id})
    group by pharmacy_id
  `;
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.n, 1);
});

/**
 * The one that matters most.
 *
 * The WhatsApp CTA is the entire commercial point of a pharmacy's website,
 * and it is built from pharmacies.public_whatsapp_number. If a render ever
 * resolved that against the wrong tenant, every customer clicking "Chat with
 * us" on Alpha's website would open a conversation with Beta — and both
 * pharmacies would experience it as their own site working normally.
 *
 * Asserted at the data layer here, and against real rendered HTML in the test
 * below — which Phase 2's renderer made possible earlier than expected.
 */
test('each pharmacy’s published WhatsApp number is its own', { skip: SKIP && skipReason }, async () => {
  const [a] = await db`select public_whatsapp_number from pharmacies where id = ${ctx.a.id}`;
  const [b] = await db`select public_whatsapp_number from pharmacies where id = ${ctx.b.id}`;
  assert.equal(a.public_whatsapp_number, '2348000000001');
  assert.equal(b.public_whatsapp_number, '2348000000002');
  assert.notEqual(a.public_whatsapp_number, b.public_whatsapp_number);
});

/**
 * THE SAME CLAIM, IN THE FORM A CUSTOMER WOULD EXPERIENCE IT.
 *
 * The data-layer test above proves the two numbers are stored apart. This one
 * proves they stay apart all the way through the renderer to the markup — the
 * only place the mistake would actually reach a person. A bug that mixed
 * tenants at render would leave both rows perfectly correct and still put
 * Beta's number on Alpha's contact button, and both pharmacies would
 * experience their own site as working normally.
 *
 * Real pharmacies, real profiles, real rendered HTML — no fixtures.
 */
test('a rendered pharmacy website never contains another pharmacy’s details', { skip: SKIP && skipReason }, async () => {
  const blocks = require('../services/website/blocks');
  const { getPharmacy, getProfile } = require('../services/pharmacies');

  const renderFor = async (pharmacyId) => {
    const pharmacy = await getPharmacy(pharmacyId);
    const profile = await getProfile(pharmacyId);
    const site = await websiteService.getWebsite(pharmacyId);
    return blocks.renderSite(
      { blocks: [...site.site_data.blocks, { type: 'pharmacy.contact', version: 1, props: {} }] },
      { pharmacy, profile, assets: new Map() },
    );
  };

  const alpha = await renderFor(ctx.a.id);
  const beta = await renderFor(ctx.b.id);

  assert.match(alpha, /ALPHA/, "Alpha's page must contain Alpha's own content");
  assert.ok(!alpha.includes('2348000000002'), "Alpha's page must not carry Beta's WhatsApp number");
  assert.ok(!alpha.includes('BETA'), "Alpha's page must not carry Beta's copy");

  assert.match(beta, /BETA/, "Beta's page must contain Beta's own content");
  assert.ok(!beta.includes('2348000000001'), "Beta's page must not carry Alpha's WhatsApp number");
  assert.ok(!beta.includes('ALPHA'), "Beta's page must not carry Alpha's copy");
});

/**
 * The tenant guard must fail loudly rather than matching everything.
 *
 * assertPharmacyId exists because the API connects as service_role and
 * bypasses RLS, so a query that reaches Postgres with an undefined tenant is
 * the worst bug this codebase can contain. Every website function is checked
 * here rather than one representative, because the guard is per-function and
 * a new function added without it would not be caught by testing its
 * neighbour.
 */
test('every website function throws on a missing or malformed tenant id', { skip: SKIP && skipReason }, async () => {
  const bad = [undefined, null, '', 'not-a-uuid', 123, {}];
  for (const id of bad) {
    await assert.rejects(
      () => websiteService.getWebsite(id),
      /Tenant guard/, `getWebsite(${JSON.stringify(id)})`,
    );
    await assert.rejects(
      () => websiteService.createWebsite(id, { templateId: 'professional' }),
      /Tenant guard/, `createWebsite(${JSON.stringify(id)})`,
    );
    await assert.rejects(
      () => websiteService.saveSiteData(id, { blocks: [] }),
      /Tenant guard/, `saveSiteData(${JSON.stringify(id)})`,
    );
    await assert.rejects(
      () => websiteService.saveContent(id, { theme: {} }),
      /Tenant guard/, `saveContent(${JSON.stringify(id)})`,
    );
  }
});

test('deleting a pharmacy takes its website with it, leaving no orphan row', { skip: SKIP && skipReason }, async () => {
  // A website that outlives its tenant is a row with a public URL and no
  // owner — unreachable through the API and invisible to every tenant-scoped
  // query, which is exactly how it would sit there serving a closed
  // pharmacy's page.
  const userC = crypto.randomUUID();
  await db`insert into auth.users (id, email) values (${userC}, ${`${TEST_TAG}-c-${userC}@example.test`})`;
  const c = await pharmacies.createPharmacy(userC, { name: `${TEST_TAG} Gamma Pharmacy` });
  await websiteService.createWebsite(c.id, { templateId: 'professional' });

  await db`delete from pharmacies where id = ${c.id}`;

  const rows = await db`select 1 from pharmacy_websites where pharmacy_id = ${c.id}`;
  assert.equal(rows.length, 0);
  await db`delete from auth.users where id = ${userC}`;
});
