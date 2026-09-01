/**
 * sore_throat_assessment v1.0.0 — answer-driven triage tests.
 *
 * The protocol this file guards is the first where an approved Nigerian
 * source actually carries an antibiotic regimen. The tests therefore care
 * less about "no antibiotic appears" and more about WHY none is reachable:
 * STG conditions its amoxicillin on examination findings that cannot be
 * obtained over WhatsApp. That reasoning is recorded in the data, and these
 * tests assert it stays recorded.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — sore throat v1.0.0 was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const throat = require('../services/clinical/protocols/soreThroatAssessmentV1');
const fever2 = require('../services/clinical/protocols/feverAssessmentV2');
const cough = require('../services/clinical/protocols/coughAssessmentV1');
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
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyId}, ${`2349220000${s}`}, ${`2349220000${s}`},
            ${`2349220000${s}@s.whatsapp.net`}, 'Throat Tester')
    returning id
  `;
  const enc = await encounters.createEncounter(ctx.pharmacyId, c.id, {}, { actorType: 'ai' });
  const ex = await engine.startProtocol(ctx.pharmacyId, enc.id, throat.SLUG, { customerId: c.id });
  return { customerId: c.id, encounterId: enc.id, executionId: ex.id };
}

const answer = (r, k, t) =>
  engine.recordAnswer(ctx.pharmacyId, r.executionId, k, t, { customerId: r.customerId });

async function pendingKeys(r) {
  const status = await engine.getInformationStatus(ctx.pharmacyId, r.executionId);
  return [...status.entries()]
    .filter(([, v]) => v.status === 'REQUIRED' || v.status === 'OPTIONAL')
    .map(([k]) => k);
}

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Throat Test', ${`throat-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  await fever2.install(ctx.pharmacyId, { actorType: 'system' });
  await cough.install(ctx.pharmacyId, { actorType: 'system' });
  ctx.protocol = await throat.install(ctx.pharmacyId, { actorType: 'system' });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ---- TEST 1 / 2 -----------------------------------------------------------

test('TEST 1 — a simple sore throat is recognised and assessment continues', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await answer(r, 'presenting_complaint', 'My throat hurts');
  const pending = await pendingKeys(r);
  assert.ok(pending.includes('sore_throat_duration'), 'duration must be the next thing wanted');
});

test('TEST 2 — duration and fever from one message are not re-asked', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await answer(r, 'sore_throat_duration', '3 days');
  await facts.recordFact(ctx.pharmacyId, r.encounterId, {
    concept: 'fever_present', value: 'true', source: 'patient_reported',
  }, { customerId: r.customerId });
  await answer(r, 'throat_danger_screen', 'none of these');

  const pending = await pendingKeys(r);
  assert.ok(!pending.includes('sore_throat_duration'));
  assert.ok(!pending.includes('fever_present'), 'fever already stated must not be asked again (§12)');
});

test('TEST 3 — a known cough is not re-asked either (§13)', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await answer(r, 'throat_danger_screen', 'none of these');
  await facts.recordFact(ctx.pharmacyId, r.encounterId, {
    concept: 'cough_present', value: 'true', source: 'patient_reported',
  }, { customerId: r.customerId });

  assert.ok(!(await pendingKeys(r)).includes('cough_present'));
});

test('cough + sore throat implies no bacterial diagnosis anywhere', { skip: SKIP && skipReason }, async () => {
  const raw = JSON.stringify(throat.DEFINITION);
  const blob = raw.toLowerCase();

  // A blanket "the phrase never appears" would forbid the protocol from
  // SAYING it does not imply bacterial infection — which is exactly the rule
  // §13 asks to be stated. So the test asserts the stronger, more useful
  // thing: where a disease name appears at all, it appears inside an explicit
  // negation, never as something the protocol concludes.
  const NEGATED = /does not imply|not imply|no .{0,20}diagnosis|must not/i;

  for (const d of ['strep', 'bacterial infection', 'viral infection', 'mononucleosis', 'diphtheria', 'epiglottitis']) {
    if (!blob.includes(d)) continue;
    const sentences = raw.split(/(?<=[.!?])\s+|","|\\n/).filter((s) => s.toLowerCase().includes(d));
    for (const s of sentences) {
      assert.ok(NEGATED.test(s), `"${d}" appears outside a negation: ${s.slice(0, 160)}`);
    }
  }
});

// ---- TEST 4 / 5 / 6: danger signs -----------------------------------------

test('TEST 4/5/6 — a danger sign stops routine questioning', { skip: SKIP && skipReason }, async () => {
  for (const sign of ['unable to swallow at all', 'drooling', 'struggling to breathe']) {
    const r = await newRun();
    await answer(r, 'throat_danger_screen', sign);
    const pending = await pendingKeys(r);
    for (const skipped of ['swallowing_ability', 'sore_throat_severity', 'associated_symptoms', 'medication_taken']) {
      assert.ok(!pending.includes(skipped), `"${sign}" must stop ${skipped} being asked (§9)`);
    }
  }
});

test('every red flag is active, emergency and escalation-only', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, { activeOnly: true });
  assert.ok(flags.length >= 8);
  for (const f of flags) {
    assert.equal(f.action, 'emergency_referral', 'no red flag may trigger treatment');
  }
});

test('each red flag names the STG section it came from, or says it has none', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, {});
  const drooling = flags.find((f) => /drooling/i.test(f.name));
  assert.match(drooling.source_reference, /Peritonsillar abscess/,
    'a sourced flag must cite its own section');

  const muffled = flags.find((f) => /muffled/i.test(f.name));
  assert.match(muffled.source_reference, /NOT in any STG section/,
    'an unsourced flag must say so rather than borrow the citation beside it');
});

test('airway flags disclose that their source is a foreign-body chapter', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, {});
  const stridor = flags.find((f) => /stridor/i.test(f.name));
  assert.match(stridor.source_reference, /foreign-body context|Foreign bodies/i);
  assert.match(stridor.source_reference, /REQUIRES_REVIEW/);
});

// ---- TEST 7 / 8: populations ---------------------------------------------

test('TEST 7 — paediatric populations derive and reuse the shared module', () => {
  assert.equal(throat.derivePopulations, fever2.derivePopulations,
    'population logic must be shared, not a third copy');
  assert.ok(throat.derivePopulations({ ageYears: 4 }).has(throat.POPULATIONS.CHILD));
});

test('TEST 8 — pregnancy is asked of an adult, not a child', { skip: SKIP && skipReason }, async () => {
  const adult = await newRun();
  await answer(adult, 'who_is_this_for', 'for me');
  await answer(adult, 'patient_age', '29');
  assert.ok((await pendingKeys(adult)).includes('pregnancy_status'));

  const child = await newRun();
  await answer(child, 'who_is_this_for', 'for me');
  await answer(child, 'patient_age', '7');
  assert.ok(!(await pendingKeys(child)).includes('pregnancy_status'));
});

// ---- TEST 9 / 14: antibiotics ---------------------------------------------

test('TEST 9/14 — asking for antibiotics does not authorise them', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  const res = await recommendations.evaluate(ctx.pharmacyId, r.executionId, {
    recommendationKey: 'amoxicillin_because_patient_asked', clinicalConfidence: 0.99,
  }, { customerId: r.customerId });

  assert.equal(res.decision.status, 'not_applicable');
  assert.equal(res.deliverableText, null);
});

test("STG's antibiotic rule is recorded as NOT_SUPPORTED, with the reason why", { skip: SKIP && skipReason }, async () => {
  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  const abx = recs.find((x) => /antibiotic_not_reachable/.test(x.recommendation_key));
  assert.ok(abx, 'the unreachable rule must be visible, not simply absent');
  assert.equal(abx.evidence_status, 'not_supported');
  assert.equal(abx.status, 'draft');

  const rule = throat.DEFINITION.recommendationRules.find((x) => /not_reachable/.test(x.recommendationKey));
  assert.match(rule.rationale, /examination findings/i,
    'the recorded reason must be the examination requirement, not a blanket refusal');
  assert.match(rule.rationale, /STG DOES specify amoxicillin/,
    'and must acknowledge the source does carry the regimen');
});

test('no antibiotic is deliverable even at maximum confidence', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  const res = await recommendations.evaluate(ctx.pharmacyId, r.executionId, {
    recommendationKey: 'stg_tonsillitis_antibiotic_not_reachable', clinicalConfidence: 1.0,
  }, { customerId: r.customerId });
  assert.notEqual(res.decision.status, 'eligible');
  assert.equal(res.deliverableText, null);
});

// ---- TEST 10: no diagnosis confirmation ----------------------------------

test('TEST 10 — reported white spots stay a report, never a finding', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await answer(r, 'throat_danger_screen', 'none of these');
  await answer(r, 'associated_symptoms', 'white spots on the tonsils');

  const state = await engine.getExecutionState(ctx.pharmacyId, r.executionId);
  const fact = state.factsByConcept.get('associated_symptoms');
  assert.match(String(fact.value), /white_spots/);
  assert.notEqual(fact.source, 'measured', 'a patient impression is not an examination finding (§23)');

  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  const deliverable = recs.filter((x) => x.status === 'active' && x.autonomous_scope);
  assert.equal(deliverable.length, 0, 'and it authorises nothing');
});

// ---- TEST 12: conflict ----------------------------------------------------

test('TEST 12 — a conflicting age is preserved, not overwritten', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await facts.recordFact(ctx.pharmacyId, r.encounterId, {
    concept: 'age_years', value: '30', valueNumber: 30, source: 'profile_reused',
  }, { customerId: r.customerId });
  await facts.recordFact(ctx.pharmacyId, r.encounterId, {
    concept: 'age_years', value: '25', valueNumber: 25, source: 'patient_reported',
  }, { customerId: r.customerId });

  const all = await facts.listFacts(ctx.pharmacyId, r.encounterId, { concept: 'age_years' });
  const values = all.map((f) => String(f.value));
  assert.ok(values.includes('30') && values.includes('25'));
  assert.ok(all.some((f) => f.status === 'conflicted'));
});

// ---- TEST 11: returning patient -------------------------------------------

test('TEST 11 — known age and allergies are reused, not re-requested', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await answer(r, 'throat_danger_screen', 'none of these');
  await facts.recordFact(ctx.pharmacyId, r.encounterId, {
    concept: 'age_years', value: '41', valueNumber: 41, source: 'profile_reused',
  }, { customerId: r.customerId });
  await facts.recordFact(ctx.pharmacyId, r.encounterId, {
    concept: 'reported_allergies', value: 'penicillin', source: 'profile_reused',
  }, { customerId: r.customerId });

  const pending = await pendingKeys(r);
  assert.ok(!pending.includes('patient_age'));
  assert.ok(!pending.includes('known_allergies'));
});

test('§16 — allergy is a REQUIRED question, so its absence is visible', { skip: SKIP && skipReason }, async () => {
  const qs = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  const allergy = qs.find((q) => q.question_key === 'known_allergies');
  assert.equal(allergy.required, true,
    'absence of allergy information must never be read as absence of allergy');
});

// ---- TEST 13 / 15: evidence status ---------------------------------------

test('TEST 13/15 — the supportive rule is limited_support and does not auto-deliver', { skip: SKIP && skipReason }, async () => {
  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  const supportive = recs.find((x) => /hydration_gargle/.test(x.recommendation_key));
  assert.ok(supportive);
  assert.equal(supportive.evidence_status, 'limited_support');
  assert.equal(supportive.autonomous_scope, false);
  assert.equal(supportive.status, 'draft');
});

test('the evidence source ships DRAFT — nothing is deliverable until approved', { skip: SKIP && skipReason }, async () => {
  const [src] = await db`
    select status from evidence_sources
    where pharmacy_id = ${ctx.pharmacyId} and source_key = 'nigeria_stg_2022'
  `;
  assert.equal(src.status, 'draft');
});

// ---- transitions ----------------------------------------------------------

test('fever and cough transitions are gated on those protocols being active', { skip: SKIP && skipReason }, async () => {
  assert.equal((await throat.canTransitionTo(ctx.pharmacyId, 'fever_assessment')).allowed, true);
  assert.equal((await throat.canTransitionTo(ctx.pharmacyId, 'cough_assessment')).allowed, true);
  assert.equal((await throat.canTransitionTo(ctx.pharmacyId, 'nonexistent_protocol')).allowed, false);
});

test('no malaria logic is duplicated here (§14)', () => {
  const blob = JSON.stringify(throat.DEFINITION).toLowerCase();
  for (const drug of ['artemether', 'lumefantrine', 'artesunate', 'chloroquine']) {
    assert.ok(!blob.includes(drug));
  }
  const fever = throat.DEFINITION.protocolTransitions.find((t) => t.target === 'fever_assessment');
  assert.match(fever.note, /does NOT imply malaria/i);
});

// ---- provenance -----------------------------------------------------------

test('a vague antibiotic statement is stored verbatim (§15)', { skip: SKIP && skipReason }, async () => {
  const r = await newRun();
  await answer(r, 'throat_danger_screen', 'none of these');
  await answer(r, 'medication_taken', 'I took antibiotics');

  const [row] = await db`
    select raw_response from encounter_answers
    where execution_id = ${r.executionId} and question_key = 'medication_taken'
  `;
  assert.match(row.raw_response, /I took antibiotics/);
  assert.ok(!/amoxicillin|cotrimoxazole/i.test(row.raw_response),
    'no drug name may be inferred from a vague statement');
});
