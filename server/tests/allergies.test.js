/**
 * The allergy record, against real Postgres.
 *
 * THE MANDATORY CASE FIRST: an allergy belongs to a pharmacy, and pharmacy B
 * must never read or write one of pharmacy A's (GOLDEN-001).
 *
 * Then the rule the whole record exists for — THREE STATES, NEVER TWO. An
 * empty record is "not assessed", never "no allergies"; "no known allergies"
 * is a claim a pharmacist makes, withdrawn the moment an allergy is recorded.
 * And nothing is deleted: a wrong record is refuted, kept, and traceable.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the allergy record NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'allrgtest';
const TODAY = '2026-09-22';

let db;
let allergies;
let ctx = null;

const { readAllergyInput, readAllergyPatch } = require('../services/clinical/allergyInput');
const input = (b) => readAllergyInput(b, { today: TODAY });
const patch = (b) => readAllergyPatch(b, { today: TODAY });
const PHARMACIST = (userId) => ({ actorId: userId, actorRole: 'pharmacist' });
const STAFF = (userId) => ({ actorId: userId, actorRole: 'staff' });

let phone = 2349080000000;
async function patient(pharmacyId) {
  phone += 1;
  const p = String(phone);
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${pharmacyId}, ${p}, ${p}, ${`${p}@s.whatsapp.net`}, 'Allergy Tester', 'Allergy Tester')
    returning id
  `;
  return c.id;
}

async function events(customerId, type) {
  return db`
    select event_type, actor_type, actor_id, metadata, visibility from customer_events
    where customer_id = ${customerId} and event_type = ${type}
    order by occurred_at, id
  `;
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  allergies = require('../services/clinical/allergies');

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const staffA = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}),
    (${userB}, ${`${TAG}-b-${userB}@example.test`}),
    (${staffA}, ${`${TAG}-s-${staffA}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });
  ctx = { a, b, userA, userB, staffA };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;
  await db.end({ timeout: 5 });
});

// ---- the mandatory case ---------------------------------------------------

test('pharmacy B cannot read, record, edit or assess an allergy on pharmacy A\'s patient', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const mine = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Penicillin' }), PHARMACIST(ctx.userA));

  // Read: exactly what an unassessed patient looks like — "not yours" and
  // "nothing here" must be indistinguishable.
  const theirs = await allergies.listAllergies(ctx.b.id, p);
  assert.deepEqual(theirs, { state: 'not_assessed', allergies: [], history: [], nka: null });

  await assert.rejects(() => allergies.getAllergy(ctx.b.id, p, mine.id), (e) => e.status === 404);
  await assert.rejects(
    () => allergies.updateAllergy(ctx.b.id, p, mine.id, patch({ severity: 'mild' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => allergies.addAllergy(ctx.b.id, p, input({ allergenName: 'X' }), PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => allergies.setAllergyStatus(ctx.b.id, p, 'no_known', PHARMACIST(ctx.userB)),
    (e) => e.status === 404,
  );

  const still = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(still.allergies.length, 1);
  assert.equal(still.allergies[0].severity, null);
});

// ---- the record -----------------------------------------------------------

test('every field a pharmacist entered comes back as entered, reactions in order', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const saved = await allergies.addAllergy(ctx.a.id, p, input({
    allergenName: 'Amoxicillin',
    allergenCode: 'nafdac:Amoxicillin',
    category: 'medication',
    type: 'allergy',
    verificationStatus: 'confirmed',
    criticality: 'high',
    severity: 'moderate',
    exposureRoute: 'oral',
    onset: '2021',
    lastOccurrence: '2023-06',
    source: 'patient',
    notes: 'Generalised rash after the first dose. No breathing difficulty.',
    reactions: ['rash', 'facial_swelling', { manifestation: 'other', description: 'Joint pain' }, 'itching'],
  }), PHARMACIST(ctx.userA));

  // Read back fresh, as a refresh would.
  const back = await allergies.getAllergy(ctx.a.id, p, saved.id);
  assert.equal(back.allergenName, 'Amoxicillin');
  assert.equal(back.allergenCode, 'nafdac:Amoxicillin');
  assert.equal(back.category, 'medication');
  assert.equal(back.type, 'allergy');
  assert.equal(back.verificationStatus, 'confirmed');
  assert.equal(back.clinicalStatus, 'active');
  // Severity and criticality are two facts, stored separately.
  assert.equal(back.severity, 'moderate');
  assert.equal(back.criticality, 'high');
  assert.equal(back.exposureRoute, 'oral');
  assert.deepEqual(back.onset, { date: '2021-01-01', precision: 'year' });
  assert.deepEqual(back.lastOccurrence, { date: '2023-06-01', precision: 'month' });
  assert.equal(back.source, 'patient');
  assert.match(back.notes, /No breathing difficulty/);
  assert.deepEqual(back.reactions.map((r) => r.manifestation), ['rash', 'facial_swelling', 'other', 'itching']);
  assert.equal(back.reactions[2].description, 'Joint pain');
  // Who typed it — the existing user model, nothing new.
  assert.equal(back.recordedBy.id, ctx.userA);
  assert.match(back.recordedBy.email, /@example\.test$/);
});

test('an edit changes what it names, leaves the rest, and replaces the reactions', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const a = await allergies.addAllergy(ctx.a.id, p, input({
    allergenName: 'Ibuprofen', category: 'medication', severity: 'mild', notes: 'Keep this',
    reactions: ['rash', 'itching'],
  }), PHARMACIST(ctx.userA));

  const edited = await allergies.updateAllergy(ctx.a.id, p, a.id, patch({
    severity: 'severe', criticality: 'high', reactions: ['wheezing', 'shortness_of_breath'],
  }), PHARMACIST(ctx.userA));
  assert.equal(edited.severity, 'severe');
  assert.equal(edited.criticality, 'high');
  assert.equal(edited.notes, 'Keep this');
  assert.equal(edited.category, 'medication');
  // A removed reaction does not linger.
  assert.deepEqual(edited.reactions.map((r) => r.manifestation), ['wheezing', 'shortness_of_breath']);
  const [{ n }] = await db`select count(*)::int as n from patient_allergy_reactions where allergy_id = ${a.id}`;
  assert.equal(n, 2);
});

// ---- three states, never two ----------------------------------------------

test('an empty record is NOT ASSESSED — never "no allergies"', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.state, 'not_assessed');
  assert.equal(r.nka, null);
});

test('"no known allergies" is a claim a pharmacist makes, with a name and a time', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const r = await allergies.setAllergyStatus(ctx.a.id, p, 'no_known', PHARMACIST(ctx.userA));
  assert.equal(r.state, 'none_known');
  assert.ok(r.nka.at);
  assert.equal(r.nka.by.id, ctx.userA);

  // And it survives a refresh — it is stored, not inferred.
  assert.equal((await allergies.listAllergies(ctx.a.id, p)).state, 'none_known');

  // Withdrawing it goes back to not assessed, not to "known".
  const cleared = await allergies.setAllergyStatus(ctx.a.id, p, 'clear', PHARMACIST(ctx.userA));
  assert.equal(cleared.state, 'not_assessed');
});

test('recording an allergy withdraws "no known allergies" in the same breath', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await allergies.setAllergyStatus(ctx.a.id, p, 'no_known', PHARMACIST(ctx.userA));
  const a = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Latex', category: 'environmental' }), STAFF(ctx.staffA));

  const r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.state, 'known');
  assert.equal(r.nka, null, 'the old assertion is gone, not hidden');

  // So when that allergy is later refuted, the patient is NOT silently back
  // to "no known allergies" — somebody has to assess them again.
  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({
    verificationStatus: 'refuted', statusReason: 'Wore latex gloves at the clinic without reaction.',
  }), PHARMACIST(ctx.userA));
  assert.equal((await allergies.listAllergies(ctx.a.id, p)).state, 'not_assessed');

  const cleared = await events(p, 'ALLERGY_NKA_CLEARED');
  assert.equal(cleared.length, 1);
  assert.match(cleared[0].metadata.reason, /Latex/);
});

test('"no known allergies" is refused while a current allergy is on the record', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Peanuts', category: 'food' }), PHARMACIST(ctx.userA));
  await assert.rejects(
    () => allergies.setAllergyStatus(ctx.a.id, p, 'no_known', PHARMACIST(ctx.userA)),
    (e) => e.status === 409 && e.code === 'HAS_ALLERGIES',
  );
  assert.equal((await allergies.listAllergies(ctx.a.id, p)).state, 'known');
});

// ---- status, without deleting anything ------------------------------------

test('a refuted allergy is kept in the history with its reason, never deleted', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const a = await allergies.addAllergy(ctx.a.id, p, input({
    allergenName: 'Penicillin', category: 'medication', reactions: ['rash'],
  }), STAFF(ctx.staffA));

  const refuted = await allergies.updateAllergy(ctx.a.id, p, a.id, patch({
    verificationStatus: 'refuted', statusReason: 'Tolerated a full amoxicillin course in 2025.',
  }), PHARMACIST(ctx.userA));
  assert.equal(refuted.verificationStatus, 'refuted');
  assert.notEqual(refuted.clinicalStatus, 'active', 'an untrue record is not a current allergy');

  const r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.allergies.length, 0);
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].statusReason, 'Tolerated a full amoxicillin course in 2025.');
  assert.deepEqual(r.history[0].reactions.map((x) => x.manifestation), ['rash'], 'the history keeps what was reported');

  // The database itself refuses the impossible state, whatever the caller.
  await assert.rejects(
    () => db`update patient_allergies set clinical_status = 'active' where id = ${a.id}`,
    /patient_allergies_untrue_not_active/,
  );
});

test('entered in error is kept too, and says why', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const a = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Shellfish', category: 'food' }), STAFF(ctx.staffA));
  const wrong = await allergies.updateAllergy(ctx.a.id, p, a.id, patch({
    verificationStatus: 'entered_in_error', statusReason: 'Recorded on the wrong patient.',
  }), PHARMACIST(ctx.userA));
  assert.equal(wrong.verificationStatus, 'entered_in_error');
  const r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.state, 'not_assessed');
  assert.equal(r.history[0].id, a.id);
  // Refusing an untrue status with no reason, at the database.
  await assert.rejects(
    () => db`update patient_allergies set status_reason = null where id = ${a.id}`,
    /patient_allergies_untrue_has_reason/,
  );
});

test('resolved and inactive leave the current list and stay in the history', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const a = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Eggs', category: 'food' }), PHARMACIST(ctx.userA));
  const b = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Pollen', category: 'environmental' }), PHARMACIST(ctx.userA));

  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({ clinicalStatus: 'resolved', statusReason: 'Outgrown' }), PHARMACIST(ctx.userA));
  let r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.state, 'known');
  assert.deepEqual(r.allergies.map((x) => x.allergenName), ['Pollen']);
  assert.deepEqual(r.history.map((x) => x.allergenName), ['Eggs']);

  await allergies.updateAllergy(ctx.a.id, p, b.id, patch({ clinicalStatus: 'inactive' }), PHARMACIST(ctx.userA));
  r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.state, 'not_assessed');
  assert.equal(r.history.length, 2);

  // Making one active again is a current allergy again.
  await allergies.updateAllergy(ctx.a.id, p, b.id, patch({ clinicalStatus: 'active' }), PHARMACIST(ctx.userA));
  assert.equal((await allergies.listAllergies(ctx.a.id, p)).state, 'known');
});

test('the current list leads with high criticality', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Aspirin', criticality: 'low' }), PHARMACIST(ctx.userA));
  await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Zinc oxide' }), PHARMACIST(ctx.userA));
  await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Peanuts', criticality: 'high' }), PHARMACIST(ctx.userA));
  const r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.allergies[0].allergenName, 'Peanuts');
});

// ---- who may do what ------------------------------------------------------

test('staff may record what a patient said; only a pharmacist may confirm, refute or assert NKA', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  // Writing down what the patient said: open to anyone, as unconfirmed.
  const a = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Sulfa drugs' }), STAFF(ctx.staffA));
  assert.equal(a.verificationStatus, 'unconfirmed');
  // Staff can still edit the clinical detail they took down.
  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({ reactions: ['hives'] }), STAFF(ctx.staffA));

  const refused = (e) => e.status === 403 && e.code === 'FORBIDDEN_ROLE';
  await assert.rejects(
    () => allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'X', verificationStatus: 'confirmed' }), STAFF(ctx.staffA)),
    refused,
  );
  await assert.rejects(
    () => allergies.updateAllergy(ctx.a.id, p, a.id, patch({ verificationStatus: 'confirmed' }), STAFF(ctx.staffA)),
    refused,
  );
  await assert.rejects(
    () => allergies.updateAllergy(ctx.a.id, p, a.id, patch({ verificationStatus: 'refuted', statusReason: 'x' }), STAFF(ctx.staffA)),
    refused,
  );
  const q = await patient(ctx.a.id);
  await assert.rejects(() => allergies.setAllergyStatus(ctx.a.id, q, 'no_known', STAFF(ctx.staffA)), refused);
  await assert.rejects(() => allergies.setAllergyStatus(ctx.a.id, q, 'no_known', { actorId: null, actorRole: null }), refused);

  // A pharmacist can, and so can an owner.
  const ok = await allergies.updateAllergy(ctx.a.id, p, a.id, patch({ verificationStatus: 'confirmed' }), PHARMACIST(ctx.userA));
  assert.equal(ok.verificationStatus, 'confirmed');
  const owner = await allergies.setAllergyStatus(ctx.a.id, q, 'no_known', { actorId: ctx.userA, actorRole: 'owner' });
  assert.equal(owner.state, 'none_known');

  // Nothing the refused calls tried to write was written.
  const back = await allergies.getAllergy(ctx.a.id, p, a.id);
  assert.deepEqual(back.reactions.map((r) => r.manifestation), ['hives']);
});

// ---- the audit trail ------------------------------------------------------

test('every change is traceable: who, what changed, from what, and why', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const a = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Codeine', severity: 'mild' }), STAFF(ctx.staffA));
  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({ severity: 'moderate' }), PHARMACIST(ctx.userA));
  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({ severity: 'severe' }), PHARMACIST(ctx.userA));
  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({
    verificationStatus: 'refuted', statusReason: 'It was nausea from an empty stomach.',
  }), PHARMACIST(ctx.userA));
  // Saving with no change writes nothing.
  await allergies.updateAllergy(ctx.a.id, p, a.id, patch({ severity: 'severe' }), PHARMACIST(ctx.userA));

  const recorded = await events(p, 'ALLERGY_RECORDED');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor_type, 'staff');
  assert.equal(recorded[0].actor_id, ctx.staffA);
  assert.equal(recorded[0].visibility, 'internal', 'a clinical trail is staff-only');

  // Two edits of the same field are two events — not collapsed by an
  // idempotency key that only knows the allergy's id.
  const updated = await events(p, 'ALLERGY_UPDATED');
  assert.equal(updated.length, 2);
  assert.deepEqual(updated[0].metadata.changes.severity, { from: 'mild', to: 'moderate' });
  assert.deepEqual(updated[1].metadata.changes.severity, { from: 'moderate', to: 'severe' });

  const status = await events(p, 'ALLERGY_STATUS_CHANGED');
  assert.equal(status.length, 1);
  assert.deepEqual(status[0].metadata.changes.verificationStatus, { from: 'unconfirmed', to: 'refuted' });
  assert.equal(status[0].metadata.reason, 'It was nausea from an empty stomach.');
  assert.equal(status[0].actor_id, ctx.userA);
});

// ---- the rest of the product ----------------------------------------------

test('triage receives the current allergies as one line, and never a refuted one', { skip: SKIP && skipReason }, async () => {
  const encounters = require('../services/clinical/clinicalEncounterService');
  const facts = require('../services/clinical/clinicalFactService');
  const p = await patient(ctx.a.id);
  await allergies.addAllergy(ctx.a.id, p, input({
    allergenName: 'Penicillin', verificationStatus: 'confirmed', reactions: ['rash', 'facial_swelling'],
  }), PHARMACIST(ctx.userA));
  await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Peanuts', reactions: ['wheezing'] }), PHARMACIST(ctx.userA));
  const gone = await allergies.addAllergy(ctx.a.id, p, input({ allergenName: 'Latex' }), PHARMACIST(ctx.userA));
  await allergies.updateAllergy(ctx.a.id, p, gone.id, patch({ verificationStatus: 'refuted', statusReason: 'x' }), PHARMACIST(ctx.userA));

  const enc = await encounters.createEncounter(ctx.a.id, p, { presentingComplaint: 'Allergy seed test' });
  await facts.seedFromProfile(ctx.a.id, enc.id, { customerId: p });
  const rows = await db`
    select concept, value, status from encounter_facts
    where encounter_id = ${enc.id} and concept like 'profile_allerg%'
  `;
  // ONE fact: two allergies under one concept would be read as a conflict.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].concept, 'profile_allergies');
  assert.equal(rows[0].status, 'active');
  assert.match(rows[0].value, /Penicillin — rash, facial swelling \(confirmed\)/);
  assert.match(rows[0].value, /Peanuts — wheezing \(unconfirmed\)/);
  assert.doesNotMatch(rows[0].value, /Latex/);
});

test('0058 carries an old allergy fact across once, and leaves the old row in place', { skip: SKIP && skipReason }, async () => {
  const p = await patient(ctx.a.id);
  const [profile] = await db`
    insert into patient_profiles (pharmacy_id, customer_id) values (${ctx.a.id}, ${p}) returning id
  `;
  await db`
    insert into patient_clinical_facts (pharmacy_id, patient_profile_id, fact_type, value, status, source)
    values (${ctx.a.id}, ${profile.id}, 'allergy', 'Sulfa drugs', 'confirmed', 'pharmacist_recorded'),
           (${ctx.a.id}, ${profile.id}, 'condition', 'Asthma', 'reported', 'patient_reported')
  `;

  // The carry-across statement exactly as it is in the migration, run twice.
  const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '0058_patient_allergies.sql'), 'utf8');
  const start = migration.indexOf('insert into patient_allergies');
  const end = migration.indexOf(';', start);
  const carry = migration.slice(start, end);
  await db.unsafe(carry);
  await db.unsafe(carry);

  const r = await allergies.listAllergies(ctx.a.id, p);
  assert.equal(r.allergies.length, 1, 'copied once, however many times the migration runs');
  assert.equal(r.allergies[0].allergenName, 'Sulfa drugs');
  assert.equal(r.allergies[0].verificationStatus, 'confirmed');
  assert.equal(r.allergies[0].source, 'pharmacist');
  const [{ n }] = await db`select count(*)::int as n from patient_clinical_facts where patient_profile_id = ${profile.id}`;
  assert.equal(n, 2, 'the old rows are left where they were');
});
