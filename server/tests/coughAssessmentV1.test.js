/**
 * cough_assessment v1.0.0 — triage behaviour, driven with real answers.
 *
 * Conditionals are verified by answering the gating question and checking
 * what the engine ACTUALLY asks next, never by asserting the shape of an
 * applicability rule. That distinction already caught one unimplemented
 * operator in this codebase.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — cough v1.0.0 was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const cough = require('../services/clinical/protocols/coughAssessmentV1');
const fever2 = require('../services/clinical/protocols/feverAssessmentV2');
const engine = require('../services/clinical/protocolExecutionService');
const encounters = require('../services/clinical/clinicalEncounterService');
const recommendations = require('../services/clinical/recommendationService');
const protocols = require('../services/clinical/clinicalProtocolService');
const facts = require('../services/clinical/clinicalFactService');

let db;
let ctx = {};
let seq = 0;

async function newRun() {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyId}, ${`2349200000${s}`}, ${`2349200000${s}`},
            ${`2349200000${s}@s.whatsapp.net`}, 'Cough Tester')
    returning id
  `;
  const enc = await encounters.createEncounter(ctx.pharmacyId, customer.id, {}, { actorType: 'ai' });
  const exec = await engine.startProtocol(ctx.pharmacyId, enc.id, cough.SLUG, { customerId: customer.id });
  return { customerId: customer.id, encounterId: enc.id, executionId: exec.id };
}

const answer = (run, key, text) =>
  engine.recordAnswer(ctx.pharmacyId, run.executionId, key, text, { customerId: run.customerId });

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
    insert into pharmacies (name, slug, status) values ('Cough Test', ${`cough-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  await fever2.install(ctx.pharmacyId, { actorType: 'system' });
  ctx.protocol = await cough.install(ctx.pharmacyId, { actorType: 'system' });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ---- TEST 1: simple cough ------------------------------------------------

test('TEST 1 — a simple cough report is recognised and assessment continues', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'presenting_complaint', 'I have been coughing since yesterday');
  await answer(run, 'cough_duration', '1 day');

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.equal(state.execution.state, 'in_progress');
  assert.equal(Number(state.factsByConcept.get('cough_duration_days').value_number), 1);
});

// ---- TEST 2: no repeated questions ---------------------------------------

test('TEST 2 — answered questions are not asked again', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'cough_duration', '5 days');
  await answer(run, 'respiratory_danger_screen', 'none of these');
  await answer(run, 'cough_type', 'dry');

  const pending = await pendingKeys(run);
  assert.ok(!pending.includes('cough_duration'));
  assert.ok(!pending.includes('cough_type'));
});

test('the sputum question is asked only for a productive cough', { skip: SKIP && skipReason }, async () => {
  const productive = await newRun();
  await answer(productive, 'respiratory_danger_screen', 'none of these');
  await answer(productive, 'cough_type', 'I am bringing up phlegm or mucus');
  assert.ok((await pendingKeys(productive)).includes('sputum_description'));

  const dry = await newRun();
  await answer(dry, 'respiratory_danger_screen', 'none of these');
  await answer(dry, 'cough_type', 'dry');
  assert.ok(!(await pendingKeys(dry)).includes('sputum_description'),
    'a dry cough has nothing to describe');
});

// ---- TEST 3: cough + fever, no duplicated questioning ---------------------

test('TEST 3 — fever already known is NOT asked again (§9)', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'respiratory_danger_screen', 'none of these');

  // Fever established elsewhere — a concurrent fever run, or the opening message.
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'fever_present', value: 'true', source: 'patient_reported',
  }, { customerId: run.customerId });

  const pending = await pendingKeys(run);
  assert.ok(!pending.includes('fever_present'),
    'a patient who already said they have fever must not be asked again');
});

test('fever IS asked when it is not already known', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'respiratory_danger_screen', 'none of these');
  assert.ok((await pendingKeys(run)).includes('fever_present'));
});

test('cough + fever does not imply malaria anywhere in this protocol', { skip: SKIP && skipReason }, async () => {
  const blob = JSON.stringify(cough.DEFINITION).toLowerCase();
  assert.ok(!blob.includes('malaria') || /does not imply malaria|not imply malaria/i.test(JSON.stringify(cough.DEFINITION)),
    'malaria may only appear as an explicit disclaimer, never as an inference');
  for (const drug of ['artemether', 'lumefantrine', 'artesunate', 'chloroquine']) {
    assert.ok(!blob.includes(drug), `${drug} must not appear in a cough protocol`);
  }
});

// ---- TEST 4 + 5: danger signs --------------------------------------------

test('TEST 4/5 — a danger sign stops routine questioning', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'respiratory_danger_screen', 'struggling to breathe');

  const pending = await pendingKeys(run);
  for (const skipped of ['cough_type', 'cough_trajectory', 'associated_symptoms', 'medication_taken', 'fever_present']) {
    assert.ok(!pending.includes(skipped), `${skipped} must not be asked once a danger sign fired (§8)`);
  }
});

test('TEST 5 — coughing blood is captured as a danger sign', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'respiratory_danger_screen', 'coughing up blood');

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.match(String(state.factsByConcept.get('respiratory_danger_signs_reported').value), /haemoptysis/);
});

test('every red flag is active, emergency, and escalation-only', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, { activeOnly: true });
  assert.ok(flags.length >= 8);
  for (const f of flags) {
    assert.equal(f.action, 'emergency_referral', 'no red flag may trigger treatment');
  }
});

test('unsourced red flags say so rather than implying a citation', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, {});
  const haemoptysis = flags.find((f) => /haemoptysis/i.test(f.name));
  assert.match(haemoptysis.source_reference, /NOT in the STG criteria/,
    'a flag not in the source must not appear sourced');

  const cyanosis = flags.find((f) => /cyanosis/i.test(f.name));
  assert.match(cyanosis.source_reference, /STG 2022/);
});

// ---- TEST 6: persistent cough, no TB diagnosis ---------------------------

test('TEST 6 — a persistent cough routes to a human without any TB claim', { skip: SKIP && skipReason }, async () => {
  const rule = cough.DEFINITION.escalationRules.find((r) => /persist/i.test(r.trigger));
  assert.ok(rule, 'a persistent-cough routing rule must exist');
  assert.equal(rule.action, 'PHARMACIST_REVIEW');
  assert.match(rule.cite, /ROUTING rule, not a tuberculosis screening criterion/);

  // And no TB question or threshold was invented.
  const questions = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  for (const q of questions) {
    assert.ok(!/tubercul|\bTB\b/i.test(q.text), `question "${q.question_key}" must not screen for TB`);
  }
});

test('no respiratory disease is named as a conclusion', { skip: SKIP && skipReason }, async () => {
  const blob = JSON.stringify(cough.DEFINITION).toLowerCase();
  // These may appear only inside an explicit "DOES NOT EXIST" transition note.
  const transitionsBlob = JSON.stringify(cough.DEFINITION.protocolTransitions).toLowerCase();
  for (const disease of ['pneumonia', 'bronchitis', 'covid', 'influenza', 'sinusitis']) {
    const inTransitions = transitionsBlob.includes(disease);
    const elsewhere = blob.replace(transitionsBlob, '').includes(disease);
    assert.ok(!elsewhere || inTransitions,
      `${disease} may only appear as an unimplemented routing target, never as a conclusion`);
  }
});

// ---- TEST 7 + 8: populations ---------------------------------------------

test('TEST 7 — paediatric populations derive correctly and reuse the fever module', () => {
  assert.equal(cough.derivePopulations, fever2.derivePopulations,
    'population logic must be shared, not a second copy that can drift');
  assert.ok(cough.derivePopulations({ ageYears: 3 }).has(cough.POPULATIONS.CHILD));
  assert.ok(cough.derivePopulations({ ageYears: 0.5 }).has(cough.POPULATIONS.INFANT));
});

test('an unknown age never becomes an adult', () => {
  const pops = cough.derivePopulations({ ageYears: null });
  assert.ok(pops.has(cough.POPULATIONS.UNKNOWN));
  assert.ok(!pops.has(cough.POPULATIONS.ADULT));
});

test('TEST 8 — pregnancy is asked of an adult and not a child', { skip: SKIP && skipReason }, async () => {
  const adult = await newRun();
  await answer(adult, 'who_is_this_for', 'for me');
  await answer(adult, 'patient_age', '30');
  assert.ok((await pendingKeys(adult)).includes('pregnancy_status'));

  const child = await newRun();
  await answer(child, 'who_is_this_for', 'for me');
  await answer(child, 'patient_age', '5');
  assert.ok(!(await pendingKeys(child)).includes('pregnancy_status'));
});

test('age is not re-asked when already on file', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'age_years', value: '42', valueNumber: 42, source: 'profile_reused',
  }, { customerId: run.customerId });

  assert.ok(!(await pendingKeys(run)).includes('patient_age'),
    'a known age must be reused, not re-requested (§10)');
});

// ---- TEST 9: antibiotics blocked -----------------------------------------

test('TEST 9 — an antibiotic cannot be recommended from this protocol', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'amoxicillin_for_cough_invented', clinicalConfidence: 0.99,
  }, { customerId: run.customerId });

  assert.equal(res.decision.status, 'not_applicable');
  assert.equal(res.deliverableText, null);
});

test('COUGH -> ANTIBIOTIC appears nowhere in the protocol (§15)', { skip: SKIP && skipReason }, async () => {
  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  assert.equal(recs.length, 0);

  const blob = JSON.stringify(cough.DEFINITION).toLowerCase();
  for (const drug of ['amoxicillin', 'azithromycin', 'ciprofloxacin', 'co-trimoxazole', 'dextromethorphan', 'codeine']) {
    assert.ok(!blob.includes(drug), `${drug} must not appear in a cough triage protocol`);
  }
  assert.ok(cough.DEFINITION.recommendationBoundaries.forbidden.includes('MEDICATION_RECOMMENDATION'));
});

// ---- TEST 11: conflict preserved -----------------------------------------

test('TEST 11 — a conflicting age is preserved, not overwritten', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'age_years', value: '34', valueNumber: 34, source: 'profile_reused',
  }, { customerId: run.customerId });
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'age_years', value: '40', valueNumber: 40, source: 'patient_reported',
  }, { customerId: run.customerId });

  const all = await facts.listFacts(ctx.pharmacyId, run.encounterId, { concept: 'age_years' });
  const values = all.map((f) => String(f.value));
  assert.ok(values.includes('34') && values.includes('40'), 'both values must survive');
  assert.ok(all.some((f) => f.status === 'conflicted'), 'and the disagreement must be marked');
});

// ---- routing gates --------------------------------------------------------

test('the fever transition is gated on that protocol being active', { skip: SKIP && skipReason }, async () => {
  const gate = await cough.canTransitionToFever(ctx.pharmacyId);
  assert.equal(gate.allowed, true, 'fever v2.0.0 was installed in this fixture');
  assert.equal(gate.version, '2.0.0');
});

test('unimplemented routing targets are declared as non-existent, not inferred', () => {
  const missing = cough.DEFINITION.protocolTransitions.filter((t) => t.targetVersion === null);
  assert.ok(missing.length >= 3);
  for (const t of missing) {
    assert.match(t.note, /DOES NOT EXIST/);
  }
});

// ---- provenance -----------------------------------------------------------

test('a vague medication statement is stored verbatim, not resolved to a drug', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await answer(run, 'respiratory_danger_screen', 'none of these');
  await answer(run, 'medication_taken', 'I took some cough syrup and antibiotics');

  const [row] = await db`
    select raw_response from encounter_answers
    where execution_id = ${run.executionId} and question_key = 'medication_taken'
  `;
  assert.match(row.raw_response, /cough syrup and antibiotics/);
  assert.ok(!/amoxicillin|dextromethorphan/i.test(row.raw_response),
    'the active ingredient must never be inferred (§13)');
});
