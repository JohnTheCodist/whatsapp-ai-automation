/**
 * fever_assessment v2.0.0 — triage behaviour, exercised end to end.
 *
 * WHY THESE TESTS DRIVE REAL ANSWERS INSTEAD OF ASSERTING SHAPES
 * The malaria draft protocol's conditional test checked that a question's
 * applicability JSON mentioned "convulsions" — and passed, while the operator
 * it used (`contains`) was not implemented at all, so the conditional could
 * never fire. Asserting the shape of a rule proves nothing about whether the
 * rule works. Every conditional below is verified by answering the gating
 * question and checking what the engine ACTUALLY asks next.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — fever v2.0.0 was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const fever2 = require('../services/clinical/protocols/feverAssessmentV2');
const fever1 = require('../services/clinical/protocols/feverAssessmentV1');
const malaria = require('../services/clinical/protocols/nigeriaMalariaAssessmentV1');
const engine = require('../services/clinical/protocolExecutionService');
const encounters = require('../services/clinical/clinicalEncounterService');
const recommendations = require('../services/clinical/recommendationService');
const protocols = require('../services/clinical/clinicalProtocolService');

let db;
let ctx = {};
let seq = 0;

async function newRun() {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyId}, ${`2349190000${s}`}, ${`2349190000${s}`},
            ${`2349190000${s}@s.whatsapp.net`}, 'Fever Tester')
    returning id
  `;
  const enc = await encounters.createEncounter(ctx.pharmacyId, customer.id, {}, { actorType: 'ai' });
  const exec = await engine.startProtocol(ctx.pharmacyId, enc.id, fever2.SLUG, { customerId: customer.id });
  return { customerId: customer.id, encounterId: enc.id, executionId: exec.id };
}

const answer = (run, key, text) =>
  engine.recordAnswer(ctx.pharmacyId, run.executionId, key, text, { customerId: run.customerId });

/** Which questions the engine currently considers applicable-and-unanswered. */
async function pendingKeys(run) {
  const status = await engine.getInformationStatus(ctx.pharmacyId, run.executionId);
  return [...status.entries()]
    .filter(([, v]) => v.status === 'REQUIRED' || v.status === 'OPTIONAL')
    .map(([k]) => k);
}

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Fever V2 Test', ${`feverv2-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  await fever1.install(ctx.pharmacyId, { actorType: 'system' });      // v1.0.0 stays
  ctx.protocol = await fever2.install(ctx.pharmacyId, { actorType: 'system' });
  await malaria.install(ctx.pharmacyId, { actorType: 'system' });      // draft
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ---- versioning ----------------------------------------------------------

test('v2.0.0 is active and v1.0.0 still exists untouched', { skip: SKIP && skipReason }, async () => {
  const active = await protocols.getActiveProtocol(ctx.pharmacyId, fever2.SLUG);
  assert.equal(active.version, '2.0.0', 'the newest active version answers new runs');

  const v1 = await protocols.getProtocolVersion(ctx.pharmacyId, fever1.SLUG, '1.0.0');
  assert.ok(v1, 'v1.0.0 must still be retrievable — old encounters reference it');
});

// ---- populations (pure) --------------------------------------------------

test('populations are derived from age, never assumed', () => {
  const P = fever2.POPULATIONS;
  assert.ok(fever2.derivePopulations({ ageYears: 0.5 }).has(P.INFANT));
  assert.ok(fever2.derivePopulations({ ageYears: 6 }).has(P.CHILD));
  assert.ok(fever2.derivePopulations({ ageYears: 30 }).has(P.ADULT));
  assert.ok(fever2.derivePopulations({ ageYears: 70 }).has(P.OLDER_ADULT));
});

test('an unknown or declined age yields UNKNOWN, not a default of adult', () => {
  const P = fever2.POPULATIONS;
  for (const v of [null, undefined, NaN]) {
    const pops = fever2.derivePopulations({ ageYears: v });
    assert.ok(pops.has(P.UNKNOWN), `age ${String(v)} must be UNKNOWN`);
    assert.ok(!pops.has(P.ADULT), 'and must NOT silently become an adult');
  }
});

test('pregnancy is an overlay, not a replacement for the age band', () => {
  const P = fever2.POPULATIONS;
  const pops = fever2.derivePopulations({ ageYears: 28, pregnancyStatus: 'pregnant' });
  assert.ok(pops.has(P.PREGNANT));
  assert.ok(pops.has(P.ADULT), 'a pregnant adult is still an adult');
});

// ---- TEST 1: simple fever ------------------------------------------------

test('TEST 1 — a simple fever report is recognised and assessment continues', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'presenting_complaint', 'I have had fever since yesterday');
  await answer(run, 'fever_duration', '1 day');

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.equal(state.execution.state, 'in_progress');
  const facts = state.factsByConcept;
  assert.ok(facts.get('presenting_complaint'));
  assert.equal(Number(facts.get('symptom_duration_days').value_number), 1);
});

// ---- conditional questions, ACTUALLY exercised ---------------------------

test('the thermometer branch asks for a reading only when one exists', { skip: SKIP && skipReason }, async () => {
  const withReading = await newRun();
  await answer(withReading, 'temperature_available', 'I have a reading');
  let pending = await pendingKeys(withReading);
  assert.ok(pending.includes('measured_temperature'), 'must ask for the number');
  assert.ok(!pending.includes('fever_severity'), 'and must NOT also ask the subjective gauge');

  const feelsHot = await newRun();
  await answer(feelsHot, 'temperature_available', 'it just feels hot');
  pending = await pendingKeys(feelsHot);
  assert.ok(pending.includes('fever_severity'), 'must ask the gauge');
  assert.ok(!pending.includes('measured_temperature'), 'and must not demand a thermometer they lack');
});

test('the `contains` operator genuinely gates on a multi-choice selection', { skip: SKIP && skipReason }, async () => {
  // This is the test whose absence let a broken operator ship in the malaria
  // protocol: it drives a real answer and checks what is asked next.
  const clear = await newRun();
  await answer(clear, 'danger_signs_screen', 'none of these');
  const pending = await pendingKeys(clear);
  assert.ok(pending.includes('associated_symptoms'),
    'with no danger signs, routine questioning must continue');

  const danger = await newRun();
  await answer(danger, 'danger_signs_screen', 'fits or convulsions');
  const dangerPending = await pendingKeys(danger);
  assert.ok(!dangerPending.includes('associated_symptoms'),
    'once a danger sign fires, routine questioning must STOP (§8)');
  assert.ok(!dangerPending.includes('medication_taken'));
});

test('contains matches whole tokens, not substrings', () => {
  const clause = { all_of: [{ concept: 'danger_signs_reported', contains: 'none' }] };
  const facts = (value) => new Map([['danger_signs_reported', { value, status: 'active', value_number: null }]]);

  assert.equal(engine.isApplicable(clause, facts('none')), true);
  assert.equal(engine.isApplicable(clause, facts('none,headache')), true, 'and within a comma-joined list');

  // The mis-gate this guards against: substring matching would make a value of
  // 'none_of_the_above' satisfy contains:'none', silently continuing routine
  // questioning for a patient who had in fact reported a danger sign.
  assert.equal(engine.isApplicable(clause, facts('none_of_the_above')), false);
  assert.equal(engine.isApplicable(clause, facts('convulsions')), false);
});

test('pregnancy is asked of a 28-year-old and NOT of a 6-year-old', { skip: SKIP && skipReason }, async () => {
  const adult = await newRun();
  await answer(adult, 'who_is_this_for', 'for me');
  await answer(adult, 'patient_age', '28');
  assert.ok((await pendingKeys(adult)).includes('pregnancy_status'));

  const child = await newRun();
  await answer(child, 'who_is_this_for', 'for me');
  await answer(child, 'patient_age', '6');
  assert.ok(!(await pendingKeys(child)).includes('pregnancy_status'),
    'asking a child about pregnancy damages trust in the whole conversation');
});

// ---- TEST 2: multiple facts, no repeat questions --------------------------

test('TEST 2 — answered questions are not asked again', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'fever_duration', '3 days');
  await answer(run, 'temperature_available', 'I have a reading');
  await answer(run, 'measured_temperature', '39');

  const pending = await pendingKeys(run);
  assert.ok(!pending.includes('fever_duration'));
  assert.ok(!pending.includes('measured_temperature'));

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.equal(Number(state.factsByConcept.get('body_temperature_c').value_number), 39);
});

// ---- TEST 3: red flag ----------------------------------------------------

test('TEST 3 — danger signs are registered as ACTIVE emergency red flags', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, { activeOnly: true });
  assert.ok(flags.length >= 8, 'the danger-sign set must be live for a patient-facing protocol');
  for (const f of flags) {
    assert.equal(f.severity, 'emergency');
    assert.equal(f.action, 'emergency_referral', 'every action must be escalation, never treatment');
  }
});

test('every red flag records that its fever applicability needs review', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, {});
  for (const f of flags) {
    assert.match(f.source_reference, /REQUIRES_REVIEW|NOT a listed STG/,
      `${f.name} must not imply it was authored for undifferentiated fever`);
  }
});

// ---- TEST 4: malaria transition is GATED ---------------------------------

test('TEST 4 — the malaria transition does NOT fire while that protocol is draft', { skip: SKIP && skipReason }, async () => {
  const gate = await fever2.canTransitionToMalaria(ctx.pharmacyId);
  assert.equal(gate.allowed, false, 'fever must never hand off into an unreviewed protocol');
  assert.equal(gate.reason, 'malaria_protocol_not_active');
});

test('fever does not become malaria — no antimalarial anywhere in this protocol', { skip: SKIP && skipReason }, async () => {
  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  assert.equal(recs.length, 0);

  const blob = JSON.stringify(fever2.DEFINITION).toLowerCase();
  for (const drug of ['artemether', 'lumefantrine', 'artesunate', 'amodiaquine', 'quinine', 'chloroquine']) {
    assert.ok(!blob.includes(drug), `${drug} must not appear in a fever triage protocol`);
  }
});

test('the transition is declared as relevance, explicitly not diagnosis', { skip: SKIP && skipReason }, async () => {
  const t = fever2.DEFINITION.protocolTransitions[0];
  assert.equal(t.target, 'nigeria_malaria_assessment');
  assert.match(t.note, /NOT a malaria diagnosis/i);
  assert.ok(t.requires.some((r) => /APPROVED/.test(r)));
});

// ---- TEST 5: respiratory presentation ------------------------------------

test('TEST 5 — respiratory symptoms are captured without inventing a diagnosis', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'danger_signs_screen', 'trouble breathing');

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  const fact = state.factsByConcept.get('danger_signs_reported');
  assert.match(String(fact.value), /respiratory_distress/);

  const blob = JSON.stringify(fever2.DEFINITION).toLowerCase();
  assert.ok(!blob.includes('pneumonia'), 'a symptom pattern must not become a named disease');
});

// ---- TEST 8: unsupported recommendation ----------------------------------

test('TEST 8 — a medicine cannot be recommended from this protocol', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'paracetamol_invented_by_the_model', clinicalConfidence: 0.99,
  }, { customerId: run.customerId });

  assert.equal(res.decision.status, 'not_applicable');
  assert.equal(res.deliverableText, null);
});

test('the protocol declares MEDICATION_RECOMMENDATION forbidden, with its reason', { skip: SKIP && skipReason }, async () => {
  const b = fever2.DEFINITION.recommendationBoundaries;
  assert.ok(b.forbidden.includes('MEDICATION_RECOMMENDATION'));
  assert.ok(b.permitted.includes('URGENT_REFERRAL'));
  assert.match(b.reason, /undifferentiated/i);
});

// ---- provenance ----------------------------------------------------------

test('a relayed thermometer reading is patient-reported, not "measured"', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'temperature_available', 'I have a reading');
  await answer(run, 'measured_temperature', '38.7');

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  const temp = state.factsByConcept.get('body_temperature_c');
  assert.equal(Number(temp.value_number), 38.7);
  assert.notEqual(temp.source, 'measured',
    'the pharmacy measured nothing — reserving `measured` for a clinician reading keeps it meaningful');
});

test('the original wording of a medication history is preserved (§11)', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'danger_signs_screen', 'none of these');
  await answer(run, 'medication_taken', 'I took malaria medicine');

  const answers = await db`
    select raw_response, normalized_value from encounter_answers
    where execution_id = ${run.executionId} and question_key = 'medication_taken'
  `;
  assert.match(answers[0].raw_response, /I took malaria medicine/);
  assert.ok(!/artemether|lumefantrine/i.test(JSON.stringify(answers[0])),
    'a vague statement must never be upgraded into a specific drug name');
});
