/**
 * Clinical encounters — one episode, with a state matrix that refuses
 * illegal moves rather than storing them (same discipline as
 * conversationState.js).
 *
 * The test that matters most: PHARMACIST_REVIEW_REQUIRED has no direct edge
 * to COMPLETED. An encounter cannot be marked done while still waiting on a
 * pharmacist — that is the structural guarantee spec §6 exists to provide,
 * so it is checked here as a rejected transition, not just asserted in a
 * comment.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — clinical encounters were NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const encounters = require('../services/clinical/clinicalEncounterService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Encounter Test A', ${`enc-a-${Date.now()}`}, 'active')
    returning id
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('Encounter Test B', ${`enc-b-${Date.now()}`}, 'active')
    returning id
  `;
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${a.id}, '2349110000001', '2349110000001', '2349110000001@s.whatsapp.net', 'Encounter Tester')
    returning id
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${a.id}, ${customer.id}, 'bot', now())
    returning id
  `;

  ctx = { pharmacyA: a.id, pharmacyB: b.id, customerId: customer.id, conversationId: conv.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id in (${ctx.pharmacyA}, ${ctx.pharmacyB})`.catch(() => {});
});

// ---- pure state matrix ---------------------------------------------------

test('the state matrix has no direct edge from PHARMACIST_REVIEW_REQUIRED to COMPLETED', () => {
  const check = encounters.canTransition(
    encounters.STATES.PHARMACIST_REVIEW_REQUIRED, encounters.STATES.COMPLETED,
  );
  assert.equal(check.allowed, false, 'an encounter must not be closeable while still awaiting pharmacist review');
});

test('COMPLETED and CANCELLED are terminal — nothing transitions out of them', () => {
  for (const to of Object.values(encounters.STATES)) {
    assert.equal(encounters.canTransition(encounters.STATES.COMPLETED, to).allowed, to === encounters.STATES.COMPLETED);
    assert.equal(encounters.canTransition(encounters.STATES.CANCELLED, to).allowed, to === encounters.STATES.CANCELLED);
  }
});

test('a no-op transition (same state twice) is allowed, not an error', () => {
  const check = encounters.canTransition(encounters.STATES.ACTIVE, encounters.STATES.ACTIVE);
  assert.equal(check.allowed, true);
  assert.equal(check.reason, 'NO_CHANGE');
});

// ---- create / read --------------------------------------------------------

test('a conversation does not automatically create an encounter (spec §7)', { skip: SKIP && skipReason }, async () => {
  const list = await encounters.listEncountersForPatient(ctx.pharmacyA, ctx.customerId);
  assert.equal(list.length, 0, 'no encounter should exist until something deliberately creates one');
});

test('createEncounter starts ACTIVE and links to the conversation', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, {
    conversationId: ctx.conversationId,
    presentingComplaint: 'Fever for two days',
    reportedSymptoms: 'Fever, mild headache',
    symptomDuration: '2 days',
  }, { actorType: 'ai' });

  assert.equal(enc.status, encounters.STATES.ACTIVE);
  assert.equal(enc.conversation_id, ctx.conversationId);
  assert.equal(enc.presenting_complaint, 'Fever for two days');

  ctx.encounterId = enc.id;
});

test('the fever report did NOT get stored on the patient profile — episode data stays on the encounter', { skip: SKIP && skipReason }, async () => {
  const profileService = require('../services/clinical/patientProfileService');
  const profile = await profileService.getPatientProfile(ctx.pharmacyA, ctx.customerId);
  // The profile has no symptom/complaint field at all — this test exists to
  // make that a checked fact, not just a schema observation. If someone
  // later "helpfully" adds one and starts writing to it, this fails.
  assert.ok(!('presenting_complaint' in profile), 'patient_profiles must never carry episode-specific fields');
});

test('retrieving previous encounters returns them newest first (spec §25)', { skip: SKIP && skipReason }, async () => {
  const second = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, {
    presentingComplaint: 'Follow-up question',
  });
  const list = await encounters.listEncountersForPatient(ctx.pharmacyA, ctx.customerId);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, second.id, 'the newest encounter must come first');
});

// ---- legal + illegal transitions ------------------------------------------

test('a full legal path: ACTIVE -> PHARMACIST_REVIEW_REQUIRED -> PHARMACIST_ACTIVE -> COMPLETED', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, { presentingComplaint: 'Test path' });

  const reviewRequired = await encounters.moveEncounterStatus(
    ctx.pharmacyA, enc.id, encounters.STATES.PHARMACIST_REVIEW_REQUIRED, { actorType: 'ai' },
  );
  assert.equal(reviewRequired.status, encounters.STATES.PHARMACIST_REVIEW_REQUIRED);

  const active = await encounters.moveEncounterStatus(
    ctx.pharmacyA, enc.id, encounters.STATES.PHARMACIST_ACTIVE, { actorType: 'pharmacist' },
  );
  assert.equal(active.status, encounters.STATES.PHARMACIST_ACTIVE);

  const completed = await encounters.moveEncounterStatus(
    ctx.pharmacyA, enc.id, encounters.STATES.COMPLETED, { actorType: 'pharmacist' },
  );
  assert.equal(completed.status, encounters.STATES.COMPLETED);
  assert.ok(completed.completed_at, 'completed_at must be stamped on reaching a terminal state');
});

test('attempting the illegal shortcut is refused, not silently applied', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, { presentingComplaint: 'Illegal path test' });
  await encounters.moveEncounterStatus(ctx.pharmacyA, enc.id, encounters.STATES.PHARMACIST_REVIEW_REQUIRED, { actorType: 'ai' });

  await assert.rejects(
    () => encounters.moveEncounterStatus(ctx.pharmacyA, enc.id, encounters.STATES.COMPLETED, { actorType: 'pharmacist' }),
    /ILLEGAL_TRANSITION/,
  );

  const stillReview = await encounters.getEncounter(ctx.pharmacyA, enc.id);
  assert.equal(stillReview.status, encounters.STATES.PHARMACIST_REVIEW_REQUIRED, 'the refused transition must not have been stored');
});

test('PENDING -> CANCELLED is a legal, direct path (spec §25)', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, { presentingComplaint: 'Will be cancelled' });
  await encounters.moveEncounterStatus(ctx.pharmacyA, enc.id, encounters.STATES.PHARMACIST_REVIEW_REQUIRED, { actorType: 'ai' });
  const cancelled = await encounters.moveEncounterStatus(
    ctx.pharmacyA, enc.id, encounters.STATES.CANCELLED, { actorType: 'staff', reason: 'duplicate report' },
  );
  assert.equal(cancelled.status, encounters.STATES.CANCELLED);
});

test('tenant isolation: pharmacy B cannot move or read pharmacy A\'s encounter', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, { presentingComplaint: 'Tenant test' });

  const readFromB = await encounters.getEncounter(ctx.pharmacyB, enc.id);
  assert.equal(readFromB, null);

  await assert.rejects(
    () => encounters.moveEncounterStatus(ctx.pharmacyB, enc.id, encounters.STATES.COMPLETED, { actorType: 'pharmacist' }),
    /not found/i,
  );
});

// ---- audit ----------------------------------------------------------------

test('creating and completing an encounter both leave immutable, internal audit events', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.createEncounter(ctx.pharmacyA, ctx.customerId, { presentingComplaint: 'Audit test' });
  await encounters.moveEncounterStatus(ctx.pharmacyA, enc.id, encounters.STATES.COMPLETED, { actorType: 'pharmacist' });

  const events = await db`
    select event_type, visibility, metadata from customer_events
    where entity_type = 'clinical_encounter' and entity_id = ${enc.id}
    order by id
  `;
  assert.equal(events.length, 2);
  assert.equal(events[0].event_type, 'ENCOUNTER_CREATED');
  assert.equal(events[1].event_type, 'ENCOUNTER_COMPLETED');
  for (const e of events) assert.equal(e.visibility, 'internal');
});
