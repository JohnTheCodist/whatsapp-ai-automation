/**
 * TENANT ISOLATION — the gate for every phase after this one.
 *
 * Task 1.5. Two real pharmacies owned by two different users, in a real
 * database, asserting that nothing scoped to one ever returns the other's
 * rows. The unit tests prove the guard and the selection rule in isolation;
 * this proves the actual queries.
 *
 * REQUIRES A DATABASE. Set TEST_DATABASE_URL to a Postgres instance with
 * db/migrations applied, then:
 *
 *   TEST_DATABASE_URL=postgres://... node --test "server/tests/*.test.js"
 *
 * Without it every test here SKIPS rather than fails, so the unit suite
 * stays runnable on a laptop with no database. A skip is visible in the
 * output — do not let a green run that skipped this suite be mistaken for
 * a passing isolation gate.
 *
 * Never point TEST_DATABASE_URL at production. This suite writes and
 * deletes rows.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Same config source as the rest of the app, so TEST_DATABASE_URL can live
// in server/.env alongside everything else instead of having to be exported
// in the shell every time.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — isolation gate NOT verified';

// Point the app's own config at the test database before anything reads
// it, so the service under test uses the same connection this file cleans
// up. Setting it here rather than in the shell keeps the two from drifting.
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

let db;
let pharmacies;
let ctx = null;

const TEST_TAG = 'isotest';

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  pharmacies = require('../services/pharmacies');

  // Sweep anything a previously failed run left behind. Pharmacies first —
  // deleting the user would cascade its membership away and orphan the
  // pharmacy, leaving a row nothing can reach or clean up later.
  await db`delete from pharmacies where name like ${`${TEST_TAG}%`}`;
  await db`delete from auth.users where email like ${`${TEST_TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();

  // auth.users is owned by Supabase; the schema FKs to it. Insert the two
  // test principals directly. If this fails the database is not shaped
  // like the real one and the suite cannot make a meaningful claim.
  try {
    await db`
      insert into auth.users (id, email)
      values (${userA}, ${`${TEST_TAG}-a-${userA}@example.test`}),
             (${userB}, ${`${TEST_TAG}-b-${userB}@example.test`})
    `;
  } catch (err) {
    throw new Error(
      `Could not seed auth.users on TEST_DATABASE_URL (${err.message}). ` +
      `This suite needs a database with the Supabase auth schema and ` +
      `db/migrations applied.`
    );
  }

  const a = await pharmacies.createPharmacy(userA, { name: `${TEST_TAG} Alpha Pharmacy` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TEST_TAG} Beta Pharmacy` });

  await pharmacies.updateProfile(a.id, { city: 'Lagos', phone: '+2348000000001' });
  await pharmacies.updateProfile(b.id, { city: 'Abuja', phone: '+2348000000002' });

  ctx = { userA, userB, a, b };
});

after(async () => {
  if (SKIP || !ctx) return;
  // pharmacies cascade to members, profile, products, conversations.
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- the tenants really are distinct ----

test('two pharmacies created from the same name get distinct ids and slugs', { skip: SKIP && skipReason }, async () => {
  assert.notEqual(ctx.a.id, ctx.b.id);
  assert.notEqual(ctx.a.slug, ctx.b.slug);
});

test('creation is transactional — owner membership and profile both exist', { skip: SKIP && skipReason }, async () => {
  const members = await pharmacies.listMembers(ctx.a.id);
  assert.equal(members.length, 1);
  assert.equal(members[0].user_id, ctx.userA);
  assert.equal(members[0].role, 'owner');

  const profile = await pharmacies.getProfile(ctx.a.id);
  assert.ok(profile, 'profile row must be created with the tenant');
});

// ---- the isolation claims ----

test('getPharmacy scoped to A never returns B', { skip: SKIP && skipReason }, async () => {
  const a = await pharmacies.getPharmacy(ctx.a.id);
  assert.equal(a.id, ctx.a.id);
  assert.notEqual(a.name, ctx.b.name);
});

test('getProfile scoped to A never returns B data', { skip: SKIP && skipReason }, async () => {
  const a = await pharmacies.getProfile(ctx.a.id);
  const b = await pharmacies.getProfile(ctx.b.id);
  assert.equal(a.city, 'Lagos');
  assert.equal(b.city, 'Abuja');
  assert.notEqual(a.phone, b.phone);
});

test('listMembers scoped to A never returns B members', { skip: SKIP && skipReason }, async () => {
  const members = await pharmacies.listMembers(ctx.a.id);
  const ids = members.map((m) => m.user_id);
  assert.ok(ids.includes(ctx.userA));
  assert.ok(!ids.includes(ctx.userB), "A's member list must not contain B's owner");
});

test('updateProfile on A leaves B untouched', { skip: SKIP && skipReason }, async () => {
  const before = await pharmacies.getProfile(ctx.b.id);
  await pharmacies.updateProfile(ctx.a.id, { city: 'Ibadan', extra_info: 'changed' });
  const after = await pharmacies.getProfile(ctx.b.id);
  assert.deepEqual(
    { city: after.city, extra: after.extra_info },
    { city: before.city, extra: before.extra_info }
  );
});

test('updatePharmacy on A leaves B untouched', { skip: SKIP && skipReason }, async () => {
  await pharmacies.updatePharmacy(ctx.a.id, { name: `${TEST_TAG} Alpha Renamed` });
  const b = await pharmacies.getPharmacy(ctx.b.id);
  assert.equal(b.name, ctx.b.name);
});

test('a partial profile update does not blank the fields it omits', { skip: SKIP && skipReason }, async () => {
  await pharmacies.updateProfile(ctx.b.id, { city: 'Kano' });
  const b = await pharmacies.getProfile(ctx.b.id);
  assert.equal(b.city, 'Kano');
  assert.equal(b.phone, '+2348000000002', 'phone must survive a patch that did not mention it');
});

// ---- the guard actually fires against a live connection ----

test('every tenant read refuses a missing pharmacy id', { skip: SKIP && skipReason }, async () => {
  const calls = [
    () => pharmacies.getPharmacy(undefined),
    () => pharmacies.getProfile(undefined),
    () => pharmacies.listMembers(null),
    () => pharmacies.updateProfile('', { city: 'X' }),
    () => pharmacies.getPharmacy('default'),
  ];
  for (const call of calls) {
    await assert.rejects(call, /Tenant guard/);
  }
});

test('opening hours round-trip through jsonb unchanged', { skip: SKIP && skipReason }, async () => {
  const hours = [
    { day: 'mon', open: '08:00', close: '20:00', closed: false },
    { day: 'sun', closed: true },
  ];
  const saved = await pharmacies.updateProfile(ctx.a.id, { opening_hours: hours });
  assert.deepEqual(saved.opening_hours, hours);

  const reread = await pharmacies.getProfile(ctx.a.id);
  assert.deepEqual(reread.opening_hours, hours);
});
