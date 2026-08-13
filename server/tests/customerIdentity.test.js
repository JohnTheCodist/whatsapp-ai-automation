/**
 * Identity resolution — one WhatsApp identity, one customer per pharmacy.
 *
 * A duplicate here silently splits a person's history in two and no later
 * feature can put it back together: their orders sit on one record, their
 * conversations on another, and the timeline shows a stranger. So the tests
 * that matter most are the ones about SAMENESS surviving change — a new
 * LID, a new display name, six months of silence.
 *
 * The LID cases are not hypothetical. Every customer on the live account is
 * addressed by LID, and a LID is an identifier WhatsApp assigns and can
 * change. That is exactly why identity moved off wa_jid in 0019.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — identity resolution NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'identtest';

let db;
let resolveCustomer;
let normalizePhone;
let identityKeyFor;
let ctx = null;

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  ({ resolveCustomer, normalizePhone, identityKeyFor } = require('../services/customers/customerIdentity'));

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  ctx = { userA, userB, a, b };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- pure normalisation -------------------------------------------------

test('a locally-written Nigerian number and its international form are the same number', () => {
  assert.equal(normalizePhone('08012345678', 'NG'), '2348012345678');
  assert.equal(normalizePhone('2348012345678', 'NG'), '2348012345678');
  assert.equal(normalizePhone('+234 801 234 5678', 'NG'), '2348012345678');
  assert.equal(normalizePhone('+2348012345678', 'NG'), '2348012345678');
});

test('a foreign number is not silently rewritten as Nigerian', () => {
  // The hand-rolled predecessor turned this UK mobile into 2347911123456 —
  // a real Nigerian number belonging to somebody else. An identity collision
  // between two different people is the worst failure this module can have.
  assert.equal(normalizePhone('+447911123456', 'NG'), '447911123456');
  assert.notEqual(normalizePhone('+447911123456', 'NG'), '2347911123456');
});

test('unusable input is null rather than a plausible-looking guess', () => {
  for (const bad of [null, undefined, '', '   ', 'not a number', '12']) {
    assert.equal(normalizePhone(bad, 'NG'), null, `${JSON.stringify(bad)} must not produce a key`);
  }
});

test('a sender with no phone falls back to the LID, clearly marked', () => {
  assert.equal(identityKeyFor({ phone: null, lid: '198350347493478' }), 'lid:198350347493478');
  // A bare value is always a real phone number; anything else is prefixed,
  // so the two can never be mistaken for one another.
  assert.equal(identityKeyFor({ phone: '2349013993683', lid: '198350347493478' }), '2349013993683');
});

test('nothing identifying at all yields null, not a fabricated key', () => {
  assert.equal(identityKeyFor({}), null);
});

// ---- the requirement: sameness survives change --------------------------

test('the same number resolves to the same customer every time', { skip: SKIP && skipReason }, async () => {
  const phone = '2349011100001';
  const first = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net`, displayName: 'John' });
  const second = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net`, displayName: 'John' });

  assert.equal(first.created, true, 'first contact creates');
  assert.equal(second.created, false, 'second contact must not');
  assert.equal(first.customerId, second.customerId);
});

test('a changed display name does not create a second customer', { skip: SKIP && skipReason }, async () => {
  const phone = '2349011100002';
  const a = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net`, displayName: 'John' });
  const b = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net`, displayName: 'John Doe' });

  assert.equal(a.customerId, b.customerId, 'the name is a profile attribute, never identity');

  // The newer name wins — the profile should reflect what they call
  // themselves now. coalesce is not there to freeze the name; it is there so
  // a message arriving WITHOUT a pushName cannot erase one we already knew,
  // which is the next assertion.
  const [updated] = await db`select display_name from customers where id = ${a.customerId}`;
  assert.equal(updated.display_name, 'John Doe');

  await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net`, displayName: null });
  const [preserved] = await db`select display_name from customers where id = ${a.customerId}`;
  assert.equal(preserved.display_name, 'John Doe', 'a nameless message must not blank an established name');
});

test('the SAME PERSON under a NEW LID is still one customer', { skip: SKIP && skipReason }, async () => {
  // The case 0019 exists for. WhatsApp assigns the LID and can change it;
  // under the old (pharmacy_id, wa_jid) key this produced a second customer
  // with an empty history.
  const phone = '2349011100003';
  const first = await resolveCustomer(db, {
    pharmacyId: ctx.a.id, phone, lid: '111111111111111', jid: '111111111111111@lid',
  });
  const later = await resolveCustomer(db, {
    pharmacyId: ctx.a.id, phone, lid: '999999999999999', jid: '999999999999999@lid',
  });

  assert.equal(first.customerId, later.customerId, 'a new LID must not fork the person');
  assert.equal(later.created, false);

  const [row] = await db`select wa_jid from customers where id = ${first.customerId}`;
  assert.equal(row.wa_jid, '999999999999999@lid', 'and we must reply to the NEW routing');
});

test('a return after six months resolves to the original customer', { skip: SKIP && skipReason }, async () => {
  const phone = '2349011100004';
  const original = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net` });

  // Age the record as if nothing had been heard since August.
  await db`update customers set last_seen_at = now() - interval '183 days' where id = ${original.customerId}`;

  const returning = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net` });
  assert.equal(returning.customerId, original.customerId);
  assert.equal(returning.created, false, 'silence is not a reason to become a new person');
});

// ---- tenancy ------------------------------------------------------------

test('the same number at two pharmacies is two independent customers', { skip: SKIP && skipReason }, async () => {
  const phone = '2349011100005';
  const inA = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net` });
  const inB = await resolveCustomer(db, { pharmacyId: ctx.b.id, phone, jid: `${phone}@s.whatsapp.net` });

  assert.notEqual(inA.customerId, inB.customerId, 'one person may deal with two pharmacies independently');
  assert.equal(inA.created, true);
  assert.equal(inB.created, true);
});

// ---- concurrency: the mandatory one ------------------------------------

test('ten concurrent first messages create exactly one customer', { skip: SKIP && skipReason }, async () => {
  const phone = '2349011100006';
  const results = await Promise.all(
    Array.from({ length: 10 }, () => resolveCustomer(db, {
      pharmacyId: ctx.a.id, phone, jid: `${phone}@s.whatsapp.net`, displayName: 'Racer',
    })),
  );

  const ids = new Set(results.map((r) => r.customerId));
  assert.equal(ids.size, 1, 'a race must not fork one person into several');
  assert.equal(results.filter((r) => r.created).length, 1, 'exactly one call may report creating them');

  const [{ n }] = await db`
    select count(*)::int n from customers where pharmacy_id = ${ctx.a.id} and identity_key = ${phone}`;
  assert.equal(n, 1);
});

test('locally- and internationally-written forms resolve to one customer', { skip: SKIP && skipReason }, async () => {
  // Two spellings of one number must not become two people. This is the
  // whole reason normalisation happens before the lookup rather than after.
  const local = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone: '08033300007', jid: 'x1@s.whatsapp.net' });
  const intl = await resolveCustomer(db, { pharmacyId: ctx.a.id, phone: '2348033300007', jid: 'x2@s.whatsapp.net' });

  assert.equal(local.customerId, intl.customerId);
  assert.equal(local.identityKey, '2348033300007');
});

test('refuses to resolve a customer with nothing identifying', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => resolveCustomer(db, { pharmacyId: ctx.a.id, phone: null, lid: null, jid: null }),
    /nothing to identify them by/,
  );
});
