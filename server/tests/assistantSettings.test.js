/**
 * Assistant identity settings — bot name, welcome note, menu on/off.
 *
 * Kept as its own file rather than folded into pharmacies.test.js because the
 * interesting behaviour is specific to this one function: partial updates
 * must not clobber fields the caller did not mention, and clearing a field
 * back to "use the fallback" has to be a real, supported input rather than
 * something that only works by accident.
 *
 * Skips loudly without TEST_DATABASE_URL, same as the other integration
 * suites — a green run that skipped this proves nothing about the update.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — assistant settings NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'asstsettings';

let db;
let pharmacies;
let ctx = null;

before(async () => {
  if (SKIP) return;
  ({ getSql: db } = require('../services/db'));
  db = db();
  pharmacies = require('../services/pharmacies');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userId = crypto.randomUUID();
  await db`insert into auth.users (id, email) values (${userId}, ${`${TAG}-a-${userId}@example.test`})`;
  const p = await pharmacies.createPharmacy(userId, { name: `${TAG} Alpha Pharmacy` });
  ctx = { userId, pharmacyId: p.id };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`;
  await db`delete from auth.users where id = ${ctx.userId}`;
  await db.end({ timeout: 5 });
});

test('a new pharmacy has no bot name and the menu on', { skip: SKIP && skipReason }, async () => {
  const p = await pharmacies.getPharmacy(ctx.pharmacyId);
  assert.equal(p.bot_name, null);
  assert.equal(p.menu_enabled, true);
});

test('setting the bot name and welcome note together', { skip: SKIP && skipReason }, async () => {
  const r = await pharmacies.updateAssistantSettings(ctx.pharmacyId, {
    botName: 'Ada', welcomeNote: 'We deliver across Ikeja.',
  });
  assert.equal(r.bot_name, 'Ada');
  assert.equal(r.welcome_note, 'We deliver across Ikeja.');
});

test('updating one field leaves the others exactly as they were', { skip: SKIP && skipReason }, async () => {
  // The failure mode this guards against: a settings form that saves the
  // whole object on every field blur would silently wipe the welcome note
  // the moment someone only meant to toggle the menu off.
  await pharmacies.updateAssistantSettings(ctx.pharmacyId, { menuEnabled: false });
  const p = await pharmacies.getPharmacy(ctx.pharmacyId);
  assert.equal(p.menu_enabled, false);
  assert.equal(p.bot_name, 'Ada', 'bot name must survive an update that never mentioned it');
  assert.equal(p.welcome_note, 'We deliver across Ikeja.');
});

test('an empty string clears the bot name back to "use the pharmacy name"', { skip: SKIP && skipReason }, async () => {
  const r = await pharmacies.updateAssistantSettings(ctx.pharmacyId, { botName: '' });
  assert.equal(r.bot_name, null, 'empty input must be a real way to clear, not rejected or stored as ""');
});

test('whitespace-only input clears rather than storing blank spaces', { skip: SKIP && skipReason }, async () => {
  const r = await pharmacies.updateAssistantSettings(ctx.pharmacyId, { welcomeNote: '   ' });
  assert.equal(r.welcome_note, null);
});

test('an over-length bot name is refused, not silently truncated', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => pharmacies.updateAssistantSettings(ctx.pharmacyId, { botName: 'A'.repeat(41) }),
    /40 characters/,
  );
});

test('an over-length welcome note is refused', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => pharmacies.updateAssistantSettings(ctx.pharmacyId, { welcomeNote: 'A'.repeat(301) }),
    /300 characters/,
  );
});

test('menuEnabled accepts a real boolean and coerces truthy input', { skip: SKIP && skipReason }, async () => {
  const on = await pharmacies.updateAssistantSettings(ctx.pharmacyId, { menuEnabled: true });
  assert.equal(on.menu_enabled, true);
});

test('the tenant guard fires on a missing pharmacy id', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(() => pharmacies.updateAssistantSettings(undefined, { botName: 'X' }), /Tenant guard/);
});

test('an unknown pharmacy id returns null rather than throwing', { skip: SKIP && skipReason }, async () => {
  const r = await pharmacies.updateAssistantSettings(crypto.randomUUID(), { botName: 'X' });
  assert.equal(r, null);
});

test('changing the alert number clears the LID cached for the old one', { skip: SKIP && skipReason }, async () => {
  // worker.js learns notify_lid from a staff reply so it can still recognise
  // that person on a later message with no phone number at all (LID
  // addressing — see the migration comment on notify_lid). If the pharmacy
  // then hands the alert number to someone else, that stale LID must not go
  // on quietly answering as staff — it belongs to a different person now.
  await pharmacies.updateAssistantSettings(ctx.pharmacyId, { notifyPhone: '2348011112222' });
  await db`update pharmacies set notify_lid = '198350347493478' where id = ${ctx.pharmacyId}`;

  const unchanged = await pharmacies.updateAssistantSettings(ctx.pharmacyId, { botName: 'Bola' });
  assert.equal(unchanged.notify_phone, '2348011112222', 'sanity: alert number untouched by this call');
  let [row] = await db`select notify_lid from pharmacies where id = ${ctx.pharmacyId}`;
  assert.equal(row.notify_lid, '198350347493478', 'a call that never mentions notifyPhone must not clear it');

  await pharmacies.updateAssistantSettings(ctx.pharmacyId, { notifyPhone: '2348033334444' });
  [row] = await db`select notify_lid from pharmacies where id = ${ctx.pharmacyId}`;
  assert.equal(row.notify_lid, null, 'a genuinely new alert number must not inherit the old one\'s LID');
});
