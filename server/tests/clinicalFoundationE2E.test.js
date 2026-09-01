/**
 * Stage 1's success criteria (spec §27), as one end-to-end walk:
 *
 *   Customer -> Patient Profile -> Clinical Encounter -> Protocol reference
 *   -> Red-flag framework -> Pharmacist handoff -> Audit trail
 *
 * and then answering, from the database alone, the nine questions §27 says
 * the system must be able to answer. This is the "basic development test
 * case" §26 asks for — one fake patient, one fake encounter, all TEST-only
 * data, no real patient information.
 *
 * Deliberately NOT tested here, because Stage 1 must not implement it: any
 * diagnosis, any treatment or medication recommendation, any inference from
 * symptom to condition. The protocol attached below carries no clinical
 * content at all, and the red-flag rule is created inactive and never fires.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the Stage 1 foundation was NOT verified end to end';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const profiles = require('../services/clinical/patientProfileService');
const encounters = require('../services/clinical/clinicalEncounterService');
const protocols = require('../services/clinical/clinicalProtocolService');
const handoffs = require('../services/clinical/pharmacistHandoffService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Stage1 E2E', ${`stage1-e2e-${Date.now()}`}, 'active')
    returning id
  `;
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name)
    values (${p.id}, '2349130000001', '2349130000001', '2349130000001@s.whatsapp.net', 'Test Patient', 'Test Patient')
    returning id
  `;
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at)
    values (${p.id}, ${customer.id}, 'bot', now())
    returning id
  `;
  ctx = { pharmacyId: p.id, customerId: customer.id, conversationId: conv.id };
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

test('the full Stage 1 chain links end to end', { skip: SKIP && skipReason }, async () => {
  // 1. Customer -> Patient Profile
  const profile = await profiles.getOrCreateProfile(ctx.pharmacyId, ctx.customerId, { actorType: 'system' });
  await profiles.updatePatientProfile(ctx.pharmacyId, ctx.customerId, {
    age_years: 35, sex: 'female',
  }, { actorType: 'pharmacist' });

  // A persistent fact, reported by the patient — NOT confirmed by anyone yet.
  const allergy = await profiles.recordFact(ctx.pharmacyId, ctx.customerId, {
    factType: 'allergy', value: 'TEST ONLY — reported penicillin allergy', source: 'patient_reported',
  }, { actorType: 'customer' });
  assert.equal(allergy.status, 'reported');

  // 2. Protocol reference — metadata only, no clinical content.
  const protocol = await protocols.createProtocol(ctx.pharmacyId, {
    slug: 'test_only_protocol', name: 'TEST ONLY — placeholder protocol', version: '1.0.0',
    conditionDomain: 'TEST ONLY',
  }, { actorType: 'pharmacist' });
  await protocols.activateProtocol(ctx.pharmacyId, protocol.id, { actorType: 'pharmacist' });

  // 3. Red-flag framework — created, and deliberately left INACTIVE.
  const rule = await protocols.createRedFlagRule(ctx.pharmacyId, protocol.id, {
    name: 'TEST ONLY — placeholder red flag', severity: 'review', action: 'pharmacist_review',
  }, { actorType: 'pharmacist' });
  assert.equal(rule.active, false, 'Stage 1 must not activate any real clinical rule');

  // 4. Clinical Encounter — episode data, with the protocol VERSION recorded.
  const encounter = await encounters.createEncounter(ctx.pharmacyId, ctx.customerId, {
    conversationId: ctx.conversationId,
    presentingComplaint: 'TEST ONLY',
    reportedSymptoms: 'TEST ONLY',
    symptomDuration: '2 days',
  }, { actorType: 'ai' });
  await encounters.attachProtocol(ctx.pharmacyId, encounter.id, {
    protocolId: protocol.id, slug: protocol.slug, version: protocol.version,
  });

  // 5. Pharmacist handoff — raised, accepted, completed.
  await handoffs.raiseClinicalHandoff(ctx.pharmacyId, {
    conversationId: ctx.conversationId, customerId: ctx.customerId, encounterId: encounter.id,
    category: 'symptoms', detail: 'TEST ONLY — placeholder escalation',
  }, { actorType: 'ai' });

  const [handoffRow] = await db`
    select id from handoffs where conversation_id = ${ctx.conversationId} and resolved_at is null
  `;
  await handoffs.acceptHandoff(ctx.pharmacyId, handoffRow.id, { actorId: null });
  await handoffs.completeHandoff(ctx.pharmacyId, handoffRow.id, { actorId: null, reason: 'TEST ONLY' });

  Object.assign(ctx, { profileId: profile.id, encounterId: encounter.id, handoffId: handoffRow.id, protocolId: protocol.id });
});

test('§27: "Who is this patient?" — the profile resolves from the WhatsApp customer', { skip: SKIP && skipReason }, async () => {
  const profile = await profiles.getPatientProfile(ctx.pharmacyId, ctx.customerId);
  assert.ok(profile);
  assert.equal(profile.age_years, 35);
  assert.equal(profile.sex, 'female');
});

test('§27: "What information was reported?" — with its provenance intact', { skip: SKIP && skipReason }, async () => {
  const facts = await profiles.listFacts(ctx.pharmacyId, ctx.customerId, {});
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, 'patient_reported');
  assert.equal(facts[0].status, 'reported', 'nothing confirmed it, so it must still read as reported');
});

test('§27: "Which protocol version was associated with the encounter?"', { skip: SKIP && skipReason }, async () => {
  const enc = await encounters.getEncounter(ctx.pharmacyId, ctx.encounterId);
  assert.equal(enc.protocol_slug, 'test_only_protocol');
  assert.equal(enc.protocol_version, '1.0.0');

  // And that exact version is still retrievable even after the protocol
  // moves on — spec §9's whole point.
  await protocols.createProtocol(ctx.pharmacyId, {
    slug: 'test_only_protocol', name: 'TEST ONLY — v2', version: '2.0.0',
  }, { actorType: 'pharmacist' });
  const original = await protocols.getProtocolVersion(ctx.pharmacyId, enc.protocol_slug, enc.protocol_version);
  assert.ok(original, 'the version this encounter used must remain retrievable after a newer one exists');
});

test('§27: "Is pharmacist review pending / has the pharmacist accepted?"', { skip: SKIP && skipReason }, async () => {
  const [row] = await db`select accepted_at, resolved_at, cancelled_at from handoffs where id = ${ctx.handoffId}`;
  assert.equal(handoffs.deriveHandoffStatus(row), 'COMPLETED');
  assert.ok(row.accepted_at, 'the acceptance moment must be recorded, distinct from the completion moment');
});

test('§27: "What happened, who did it, and when?" — from the audit trail alone', { skip: SKIP && skipReason }, async () => {
  const events = await db`
    select event_type, actor_type, visibility, occurred_at from customer_events
    where customer_id = ${ctx.customerId} order by id
  `;
  const types = events.map((e) => e.event_type);

  for (const expected of [
    'PATIENT_PROFILE_CREATED', 'PATIENT_PROFILE_UPDATED', 'CLINICAL_FACT_RECORDED',
    'ENCOUNTER_CREATED', 'ENCOUNTER_STATUS_CHANGED', 'HANDOFF_ACCEPTED', 'ENCOUNTER_COMPLETED',
  ]) {
    assert.ok(types.includes(expected), `the audit trail is missing ${expected}`);
  }

  // Every CLINICAL event is staff-only, and every event names its actor.
  //
  // Scoped to the clinical types on purpose. PHARMACIST_HANDOFF also appears
  // in this list and is deliberately NOT asserted internal: it predates this
  // stage, comes from the general (non-clinical) handoff flow, and is
  // customer_visible because the customer was actually told it happened
  // ("I'm passing you to our pharmacist"). Changing that would be altering
  // existing behaviour outside this stage's scope — it is raised in the
  // Stage 1 report for review instead.
  const { CLINICAL_EVENT_TYPES } = require('../services/clinical/clinicalAudit');
  for (const e of events) {
    if (CLINICAL_EVENT_TYPES.has(e.event_type)) {
      assert.equal(e.visibility, 'internal', `${e.event_type} leaked as customer-visible`);
    }
    assert.ok(e.actor_type, `${e.event_type} has no actor recorded`);
    assert.ok(e.occurred_at, `${e.event_type} has no timestamp`);
  }
});

test('§27: pharmacy-level configuration is audited too, in the admin log', { skip: SKIP && skipReason }, async () => {
  const logs = await db`
    select action from audit_logs where pharmacy_id = ${ctx.pharmacyId} order by id
  `;
  const actions = logs.map((l) => l.action);
  assert.ok(actions.includes('protocol_created'));
  assert.ok(actions.includes('protocol_activated'));
  assert.ok(actions.includes('red_flag_rule_created'));
});

test('the existing customer record is untouched — this stage is purely additive', { skip: SKIP && skipReason }, async () => {
  const [customer] = await db`select full_name, status, communication_status from customers where id = ${ctx.customerId}`;
  assert.equal(customer.full_name, 'Test Patient', 'the WhatsApp identity must be unchanged by any clinical write');
  assert.equal(customer.status, 'active');
  assert.equal(customer.communication_status, 'subscribed');
});

test('no diagnosis, treatment or medication recommendation was stored anywhere', { skip: SKIP && skipReason }, async () => {
  // The explicit Stage 1 restriction, checked rather than assumed: the
  // encounter carries only what was REPORTED, and the protocol carries no
  // content. If a future change starts writing conclusions into these
  // fields, this fails.
  const enc = await encounters.getEncounter(ctx.pharmacyId, ctx.encounterId);
  assert.deepEqual(enc.red_flags_detected, [], 'nothing may populate red_flags_detected in Stage 1');
  assert.equal(enc.assessment_status, null, 'no assessment conclusion may be stored in Stage 1');

  const protocol = await protocols.getProtocolVersion(ctx.pharmacyId, 'test_only_protocol', '1.0.0');
  assert.deepEqual(protocol.permitted_advice, [], 'no advice content may exist in Stage 1');
  assert.deepEqual(protocol.questions, []);
});
