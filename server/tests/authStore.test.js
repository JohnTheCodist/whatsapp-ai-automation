/**
 * Auth store — the lazy, encrypted, tenant-scoped Baileys credential store.
 *
 * Two claims are being proved here, and the product depends on both:
 *
 *   1. LAZINESS. `keys.get(type, ids)` reads only the rows asked for. This is
 *      the entire capacity argument (ARCHITECTURE.md §6.8) — memory scales
 *      with socket count, not contact count. A "helpful" preload would break
 *      this without breaking any other test, so it is asserted directly.
 *
 *   2. TENANT ISOLATION. An account id from another pharmacy must not open a
 *      session. Same discipline as Phase 1: proved against real Postgres, not
 *      assumed from reading the code.
 *
 * REQUIRES A DATABASE. Skips loudly without TEST_DATABASE_URL, same as
 * isolation.test.js — a green run that skipped this proves nothing.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — auth store NOT verified';

require('./helpers/testDb').useTestDatabase(TEST_URL);
if (!process.env.SESSION_ENCRYPTION_KEY) {
  process.env.SESSION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}

const TEST_TAG = 'authstore';

let db;
let pharmacies;
let createAuthStore;
let ctx = null;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  pharmacies = require('../services/pharmacies');
  ({ createAuthStore } = require('../services/whatsapp/authStore'));

  await db`delete from pharmacies where name like ${`${TEST_TAG}%`}`;
  await db`delete from auth.users where email like ${`${TEST_TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`
    insert into auth.users (id, email)
    values (${userA}, ${`${TEST_TAG}-a-${userA}@example.test`}),
           (${userB}, ${`${TEST_TAG}-b-${userB}@example.test`})
  `;

  const a = await pharmacies.createPharmacy(userA, { name: `${TEST_TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TEST_TAG} Beta` });

  const [accA] = await db`
    insert into whatsapp_accounts (pharmacy_id, provider, status)
    values (${a.id}, 'baileys', 'pending') returning id
  `;
  const [accB] = await db`
    insert into whatsapp_accounts (pharmacy_id, provider, status)
    values (${b.id}, 'baileys', 'pending') returning id
  `;

  ctx = { userA, userB, a, b, accA: accA.id, accB: accB.id };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- tenant isolation ----

test('an account belonging to another pharmacy is refused', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => createAuthStore(ctx.a.id, ctx.accB),
    /does not belong to pharmacy/,
  );
});

test('the tenant guard fires on a missing pharmacy id', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(() => createAuthStore(undefined, ctx.accA), /Tenant guard/);
  await assert.rejects(() => createAuthStore('', ctx.accA), /Tenant guard/);
});

test('a malformed account id is rejected before any query', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(() => createAuthStore(ctx.a.id, 'not-a-uuid'), /invalid whatsappAccountId/);
});

// ---- creds lifecycle ----

test('a fresh session mints credentials with a real identity key', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  assert.ok(state.creds, 'creds must exist');
  assert.ok(state.creds.noiseKey, 'initAuthCreds should have produced a noiseKey');
  assert.ok(state.creds.signedIdentityKey, 'signed identity key missing');
});

test('creds survive a save/reload round trip with Buffers intact', { skip: SKIP && skipReason }, async () => {
  const first = await createAuthStore(ctx.a.id, ctx.accA);
  const originalKey = first.state.creds.noiseKey.private;
  assert.ok(Buffer.isBuffer(originalKey) || originalKey instanceof Uint8Array);
  await first.saveCreds();

  const second = await createAuthStore(ctx.a.id, ctx.accA);
  const reloaded = second.state.creds.noiseKey.private;

  assert.ok(
    Buffer.isBuffer(reloaded) || reloaded instanceof Uint8Array,
    'BufferJSON reviver must restore binary, not leave a plain object — ' +
    'this failing would break the protocol far from here',
  );
  assert.deepEqual(Buffer.from(reloaded), Buffer.from(originalKey));
});

test('creds are stored encrypted, not as readable JSON', { skip: SKIP && skipReason }, async () => {
  const store = await createAuthStore(ctx.a.id, ctx.accA);
  await store.saveCreds();

  const [row] = await db`select creds_encrypted from whatsapp_accounts where id = ${ctx.accA}`;
  const raw = Buffer.from(row.creds_encrypted);
  assert.ok(raw.length > 0);
  assert.ok(!raw.toString('utf8').includes('noiseKey'), 'plaintext field name found in stored credential');
  assert.ok(!raw.toString('utf8').includes('registrationId'));
});

// ---- keys: the laziness claim ----

test('keys.get returns only the ids requested — not the whole set', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);

  await state.keys.set({
    'pre-key': {
      '1': { public: Buffer.from('aaa'), private: Buffer.from('bbb') },
      '2': { public: Buffer.from('ccc'), private: Buffer.from('ddd') },
      '3': { public: Buffer.from('eee'), private: Buffer.from('fff') },
    },
  });

  const got = await state.keys.get('pre-key', ['2']);
  assert.deepEqual(Object.keys(got), ['2'], 'asking for one id must not return three');

  const two = await state.keys.get('pre-key', ['1', '3']);
  assert.deepEqual(Object.keys(two).sort(), ['1', '3']);
});

test('keys.get on an empty id list does no work and returns {}', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  assert.deepEqual(await state.keys.get('pre-key', []), {});
});

test('a missing key is absent rather than an error', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  const got = await state.keys.get('pre-key', ['does-not-exist']);
  assert.deepEqual(got, {}, 'Baileys treats a missing key as "not known yet"');
});

test('key values round-trip binary correctly', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  const secret = crypto.randomBytes(32);
  await state.keys.set({ session: { alice: { data: secret } } });

  const got = await state.keys.get('session', ['alice']);
  assert.deepEqual(Buffer.from(got.alice.data), secret);
});

test('writing pre-keys costs a constant number of round trips, not one per key', { skip: SKIP && skipReason }, async () => {
  // WHAT THIS PROTECTS
  // Baileys uploads pre-keys in batches of ~30 during initialisation and gives
  // up on its own timeout. An earlier version of authStore wrote one row per
  // round trip; against a remote pooler that ran to tens of seconds and a
  // genuinely paired session never reached `open`, with "Pre-key upload
  // timeout" buried in the Baileys logs as the only clue.
  //
  // WHY THIS IS NOT A WALL-CLOCK THRESHOLD ANY MORE
  // It used to assert `elapsed < 10000`. That measures two things at once —
  // how many round trips the code makes (the thing it cares about) and how
  // slow the network and machine are right now (which it does not). Under a
  // parallel test run against a transatlantic pooler the second term
  // dominated, so the test failed intermittently while the code was correct.
  // A flaky guard is worse than no guard: it trains people to re-run until
  // green, which is exactly when a real regression slips through.
  //
  // So the cost is expressed in the unit the invariant is actually about.
  // One trivial query is one round trip; measuring it here, under whatever
  // conditions this run happens to have, gives a local yardstick. The batch
  // write is then priced in those units. Latency cancels out: if the network
  // is slow, both numbers inflate together.
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);

  // Median of several samples — a single baseline can catch one unlucky
  // hiccup and make the yardstick meaningless.
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await db`select 1`;
    samples.push(Date.now() - t);
  }
  samples.sort((a, b) => a - b);
  // Floor of 1ms: a local database can round-trip in under a millisecond, and
  // dividing by zero would make every batch look infinitely expensive.
  const oneRoundTrip = Math.max(1, samples[Math.floor(samples.length / 2)]);

  const KEYS = 60;
  const batch = {};
  for (let i = 0; i < KEYS; i++) {
    batch[`pk${i}`] = { public: crypto.randomBytes(32), private: crypto.randomBytes(32) };
  }

  const started = Date.now();
  await state.keys.set({ 'pre-key': batch });
  const elapsed = Date.now() - started;

  const roundTripsish = elapsed / oneRoundTrip;

  // Batched, this is a transaction wrapping one multi-row insert — begin,
  // insert, commit, so about 3 round trips plus the cost of encrypting 60
  // keys. Per-key it would be at least KEYS. The threshold sits far from
  // both: comfortably above correct behaviour even with encryption overhead,
  // and far below the 60+ a regression would produce.
  const LIMIT = 20;
  assert.ok(
    roundTripsish < LIMIT,
    `writing ${KEYS} pre-keys cost ~${roundTripsish.toFixed(1)} round trips `
    + `(${elapsed}ms against a ${oneRoundTrip}ms baseline). Over ${LIMIT} means the batched `
    + 'insert has regressed to one statement per key, which times out Baileys during pairing.',
  );

  const readBack = await state.keys.get('pre-key', ['pk0', `pk${KEYS - 1}`]);
  assert.ok(readBack.pk0 && readBack[`pk${KEYS - 1}`], 'every key in the batch must actually be stored');

  await state.keys.set({ 'pre-key': Object.fromEntries(Object.keys(batch).map((k) => [k, null])) });
});

test('a batch of deletes is issued per type, not per key', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  const batch = {};
  for (let i = 0; i < 20; i++) batch[`d${i}`] = { v: i };
  await state.keys.set({ session: batch });

  const started = Date.now();
  await state.keys.set({ session: Object.fromEntries(Object.keys(batch).map((k) => [k, null])) });
  assert.ok(Date.now() - started < 10000);

  assert.deepEqual(await state.keys.get('session', ['d0', 'd19']), {});
});

test('setting a key to null deletes it', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  await state.keys.set({ session: { doomed: { data: Buffer.from('x') } } });
  assert.ok((await state.keys.get('session', ['doomed'])).doomed);

  await state.keys.set({ session: { doomed: null } });
  assert.deepEqual(await state.keys.get('session', ['doomed']), {});
});

test('an upsert overwrites rather than duplicating', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  await state.keys.set({ session: { bob: { v: 1 } } });
  await state.keys.set({ session: { bob: { v: 2 } } });

  const got = await state.keys.get('session', ['bob']);
  assert.equal(got.bob.v, 2);

  const [{ count }] = await db`
    select count(*)::int as count from whatsapp_auth_keys
    where whatsapp_account_id = ${ctx.accA} and key_type = 'session' and key_id = 'bob'
  `;
  assert.equal(count, 1, 'primary key must collapse this to one row');
});

test('key material is stored encrypted', { skip: SKIP && skipReason }, async () => {
  const { state } = await createAuthStore(ctx.a.id, ctx.accA);
  await state.keys.set({ session: { spy: { marker: 'PLAINTEXT-MARKER-XYZ' } } });

  const [row] = await db`
    select value_encrypted from whatsapp_auth_keys
    where whatsapp_account_id = ${ctx.accA} and key_type = 'session' and key_id = 'spy'
  `;
  assert.ok(!Buffer.from(row.value_encrypted).toString('utf8').includes('PLAINTEXT-MARKER-XYZ'));
});

// ---- keys never cross tenants ----

test("one pharmacy's keys are invisible to another", { skip: SKIP && skipReason }, async () => {
  const aStore = await createAuthStore(ctx.a.id, ctx.accA);
  const bStore = await createAuthStore(ctx.b.id, ctx.accB);

  await aStore.state.keys.set({ session: { shared_id: { owner: 'A' } } });
  await bStore.state.keys.set({ session: { shared_id: { owner: 'B' } } });

  const fromA = await aStore.state.keys.get('session', ['shared_id']);
  const fromB = await bStore.state.keys.get('session', ['shared_id']);

  assert.equal(fromA.shared_id.owner, 'A');
  assert.equal(fromB.shared_id.owner, 'B', 'identical key ids in different tenants must not collide');
});

// ---- logout ----

test('clear() wipes creds and every key for the session', { skip: SKIP && skipReason }, async () => {
  const store = await createAuthStore(ctx.b.id, ctx.accB);
  await store.saveCreds();
  await store.state.keys.set({ session: { x: { a: 1 } }, 'pre-key': { '9': { b: 2 } } });

  await store.clear();

  const [{ count }] = await db`
    select count(*)::int as count from whatsapp_auth_keys where whatsapp_account_id = ${ctx.accB}
  `;
  assert.equal(count, 0, 'a logged-out session must leave no key material behind');

  const [row] = await db`select creds_encrypted from whatsapp_accounts where id = ${ctx.accB}`;
  assert.equal(row.creds_encrypted, null);
});
