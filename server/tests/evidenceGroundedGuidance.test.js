/**
 * The evidence-grounded AI recommendation model — levels, evidence status,
 * and the pharmacist-notification policy.
 *
 * THE BEHAVIOUR CHANGE THIS FILE PINS DOWN
 * Incomplete information used to page a pharmacist. It no longer does: not
 * knowing something yet is a reason to ask another question, not to interrupt
 * a professional. That is the difference between LEVEL 2 (ask) and LEVEL 3
 * (escalate), and it is the single most consequential rule here — get it
 * wrong in the permissive direction and patients are under-served; get it
 * wrong in the conservative direction and pharmacists drown in alerts and
 * stop reading them, which is worse.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the guidance model was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const gate = require('../services/clinical/safetyGate');
const { getSql } = require('../services/db');
const evidence = require('../services/clinical/evidenceService');
const recommendations = require('../services/clinical/recommendationService');
const engine = require('../services/clinical/protocolExecutionService');
const encounters = require('../services/clinical/clinicalEncounterService');
const fever = require('../services/clinical/protocols/feverAssessmentV1');

// ---- pure gate behaviour --------------------------------------------------

const baseRec = (over = {}) => ({
  recommendation_key: 'r', status: 'active',
  eligibility_conditions: {}, exclusion_conditions: {},
  min_evidence_strength: 'established_protocol', min_clinical_confidence: 0.8,
  autonomous_scope: true, evidence_status: 'strongly_supported', ...over,
});
const baseEvidence = {
  source: { source_key: 's', version: '1', status: 'active', strength: 'authoritative_guideline', origin: 'nigerian_guidance' },
  reference: { section: '1.1', population: 'adults' },
};
const ctx = (over = {}) => ({
  recommendation: baseRec(), evidence: baseEvidence, factsByConcept: new Map(),
  missingRequired: [], conflicts: [], redFlags: [],
  clinicalConfidence: 0.95, protocol: { status: 'active' }, ...over,
});

test('TEST 1 — strongly supported evidence yields Level 1 guidance', () => {
  const d = gate.evaluate(ctx());
  assert.equal(d.status, 'eligible');
  assert.equal(d.level, gate.LEVELS.GUIDELINE_SUPPORTED);
  assert.equal(d.escalationPriority, null);
});

test('TEST 2 — "supported" also yields Level 1', () => {
  const d = gate.evaluate(ctx({ recommendation: baseRec({ evidence_status: 'supported' }) }));
  assert.equal(d.status, 'eligible');
  assert.equal(d.level, gate.LEVELS.GUIDELINE_SUPPORTED);
});

test('TEST 3 — limited support is restricted, not delivered', () => {
  const d = gate.evaluate(ctx({ recommendation: baseRec({ evidence_status: 'limited_support' }) }));
  assert.notEqual(d.status, 'eligible');
  assert.ok(d.reasons.includes('evidence_status_insufficient'));
});

test('TEST 4 — unknown evidence status is blocked', () => {
  const d = gate.evaluate(ctx({ recommendation: baseRec({ evidence_status: 'unknown' }) }));
  assert.equal(d.status, 'blocked');
  assert.equal(d.level, gate.LEVELS.HIGH_RISK);
});

test('an unreviewed recommendation defaults to unknown and therefore cannot speak', () => {
  const { evidence_status, ...noStatus } = baseRec();
  const d = gate.evaluate(ctx({ recommendation: noStatus }));
  assert.equal(d.status, 'blocked', 'absent status must behave exactly as unknown');
});

test('TEST 5 — conflicting evidence is blocked under its own distinct reason', () => {
  const d = gate.evaluate(ctx({ recommendation: baseRec({ evidence_status: 'conflicting' }) }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes('evidence_conflicting'),
    '"sources disagree" must be distinguishable from "evidence is weak" (§10)');
  assert.ok(!d.reasons.includes('evidence_status_insufficient'));
});

test('TEST 6 — missing information ASKS and does NOT page a pharmacist', () => {
  const d = gate.evaluate(ctx({ missingRequired: [{ question_key: 'fever_duration' }] }));
  assert.equal(d.status, 'continue_assessment');
  assert.equal(d.level, gate.LEVELS.UNCERTAIN);
  assert.equal(d.escalationPriority, null,
    'an unfinished assessment must not interrupt a pharmacist (§7)');
});

test('TEST 7 — a red flag escalates urgently', () => {
  const d = gate.evaluate(ctx({ redFlags: [{ name: 'x', severity: 'emergency', action: 'emergency_referral' }] }));
  assert.equal(d.status, 'blocked');
  assert.equal(d.level, gate.LEVELS.HIGH_RISK);
  assert.equal(d.escalationPriority, 'urgent');
});

test('TEST 8/9 — high confidence with no evidence is still blocked', () => {
  const d = gate.evaluate(ctx({ evidence: null, clinicalConfidence: 1.0 }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes('missing_evidence_reference'));
});

test('TEST 10 — low confidence with strong evidence continues, it does not escalate', () => {
  const d = gate.evaluate(ctx({ clinicalConfidence: 0.2 }));
  assert.equal(d.level, gate.LEVELS.UNCERTAIN);
  assert.equal(d.status, 'continue_assessment');
  assert.equal(d.escalationPriority, null,
    'confidence cannot authorise a recommendation (§3), so it must not summon a pharmacist either');
});

test('confidence still cannot rescue anything — every value fails without evidence', () => {
  for (let c = 0; c <= 100; c += 10) {
    const d = gate.evaluate(ctx({ evidence: null, clinicalConfidence: c / 100 }));
    assert.notEqual(d.status, 'eligible');
  }
});

test('TEST 13 — an explicit request for a pharmacist always wins', () => {
  const d = gate.evaluate(ctx({ patientRequestedPharmacist: true }));
  assert.notEqual(d.status, 'eligible', 'even a perfect case must yield to the request');
  assert.equal(d.level, gate.LEVELS.HIGH_RISK);
  assert.ok(d.reasons.includes('patient_requested_pharmacist'));
  assert.ok(d.escalationPriority);
});

test('a red flag alongside missing information is urgent, not merely uncertain', () => {
  const d = gate.evaluate(ctx({
    missingRequired: [{ question_key: 'x' }],
    redFlags: [{ name: 'y', severity: 'emergency', action: 'emergency_referral' }],
  }));
  assert.equal(d.level, gate.LEVELS.HIGH_RISK);
  assert.equal(d.escalationPriority, 'urgent');
});

test('the explanation never contradicts the decision', () => {
  const d = gate.evaluate(ctx({ recommendation: baseRec({ evidence_status: 'conflicting' }) }));
  const text = gate.explain(d, { protocolSlug: 'fever_assessment', protocolVersion: '1.0.0' });
  assert.match(text, /DID NOT PASS SAFETY GATE/);
});

// ---- database-backed ------------------------------------------------------

let db;
let fx = {};
let seq = 0;

async function run() {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const [c] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${fx.pharmacyId}, ${`2349210000${s}`}, ${`2349210000${s}`},
            ${`2349210000${s}@s.whatsapp.net`}, 'Guidance Tester')
    returning id
  `;
  const enc = await encounters.createEncounter(fx.pharmacyId, c.id, {}, { actorType: 'ai' });
  const ex = await engine.startProtocol(fx.pharmacyId, enc.id, fever.SLUG, { customerId: c.id });
  return { customerId: c.id, executionId: ex.id };
}

async function completeAll(r) {
  for (const [k, a] of [
    ['presenting_complaint', 'Fever'], ['who_is_this_for', 'for me'],
    ['fever_duration', '2 days'], ['fever_severity', '5'], ['has_associated_symptoms', 'no'],
  ]) await engine.recordAnswer(fx.pharmacyId, r.executionId, k, a, { customerId: r.customerId });
}

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Guidance Test', ${`guid-${Date.now()}`}, 'active')
    returning id
  `;
  fx = { pharmacyId: p.id };
  const protocol = await fever.install(fx.pharmacyId, { actorType: 'system' });

  const src = await evidence.createSource(fx.pharmacyId, {
    sourceKey: 'test_guidance_source', title: 'TEST ONLY — placeholder', publisher: 'RxNaija test',
    origin: 'nigerian_guidance', strength: 'authoritative_guideline', version: '1.0',
  }, { actorType: 'pharmacist' });
  await evidence.approveSource(fx.pharmacyId, src.id, { actorType: 'pharmacist' });
  const ref = await evidence.addReference(fx.pharmacyId, src.id, {
    section: '2.4', summary: 'TEST ONLY', population: 'adults',
  }, { actorType: 'pharmacist' });
  fx.refId = ref.id;

  await recommendations.createRecommendation(fx.pharmacyId, protocol.id, {
    recommendationKey: 'test_rest_fluids', recommendationType: 'self_care_advice',
    recommendationText: 'TEST ONLY — rest and keep drinking fluids.',
    evidenceReferenceId: ref.id, evidenceStatus: 'strongly_supported',
    minClinicalConfidence: 0.8, autonomousScope: true, status: 'active',
  }, { actorType: 'pharmacist' });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${fx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${fx.pharmacyId}`.catch(() => {});
});

test('TEST 12 — a routine guideline-supported case delivers WITHOUT notifying anyone', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await completeAll(r);
  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'test_rest_fluids', clinicalConfidence: 0.93,
  }, { customerId: r.customerId });

  assert.equal(res.decision.status, 'eligible');
  assert.equal(res.evaluation.recommendation_level, 'level_1_guideline_supported');
  assert.equal(res.evaluation.pharmacist_review_status, 'not_required');
  assert.equal(res.evaluation.escalation_priority, null);
});

test('the delivered text carries its AI disclosure, inseparably', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await completeAll(r);
  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'test_rest_fluids', clinicalConfidence: 0.93,
  }, { customerId: r.customerId });

  assert.match(res.deliverableText, /rest and keep drinking fluids/);
  assert.match(res.deliverableText, /AI-generated guidance/);
  assert.match(res.deliverableText, /pharmacist or a doctor/);
});

test('§11 — nothing internal leaks into what the patient sees', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await completeAll(r);
  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'test_rest_fluids', clinicalConfidence: 0.93,
  }, { customerId: r.customerId });

  const t = res.deliverableText;
  for (const leak of ['strongly_supported', 'level_1', 'test_rest_fluids', 'test_guidance_source',
    'fever_assessment', '0.93', 'safety gate', 'evidence_status']) {
    assert.ok(!t.includes(leak), `patient text must not expose "${leak}"`);
  }
});

test('TEST 6 (integration) — an incomplete assessment asks, and no pharmacist is paged', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await engine.recordAnswer(fx.pharmacyId, r.executionId, 'presenting_complaint', 'Fever', { customerId: r.customerId });

  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'test_rest_fluids', clinicalConfidence: 0.9,
  }, { customerId: r.customerId });

  assert.equal(res.decision.status, 'continue_assessment');
  assert.equal(res.evaluation.recommendation_level, 'level_2_uncertain');
  assert.equal(res.evaluation.pharmacist_review_status, 'not_required');
  assert.equal(res.deliverableText, null, 'and still nothing is delivered');
});

test('TEST 14 — every evaluation records full source traceability (§6)', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await completeAll(r);
  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'test_rest_fluids', clinicalConfidence: 0.93,
  }, { customerId: r.customerId });

  const [row] = await db`
    select protocol_slug, protocol_version, recommendation_id, rule_version,
           evidence_source_key, evidence_source_version, evidence_source_section,
           evidence_status, patient_population, recommendation_level, status, created_at
    from recommendation_evaluations where id = ${res.evaluation.id}
  `;
  for (const [k, v] of Object.entries(row)) {
    assert.ok(v !== null && v !== undefined, `${k} must be recorded for traceability`);
  }
  assert.equal(row.evidence_source_section, '2.4');
  assert.equal(row.patient_population, 'adults');
  assert.equal(row.evidence_status, 'strongly_supported');
});

test('TEST 13 (integration) — asking for a pharmacist routes to one', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await completeAll(r);
  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'test_rest_fluids', clinicalConfidence: 0.99,
    patientRequestedPharmacist: true,
  }, { customerId: r.customerId });

  assert.notEqual(res.decision.status, 'eligible');
  assert.equal(res.evaluation.pharmacist_review_status, 'pending');
  assert.equal(res.deliverableText, null);
});

test('a strong claim cannot be authored from a weak source', { skip: SKIP && skipReason }, async () => {
  const weak = await evidence.createSource(fx.pharmacyId, {
    sourceKey: 'weak_src', title: 'TEST ONLY — unverified', origin: 'other_approved_source',
    strength: 'unverified', version: '1.0',
  }, { actorType: 'pharmacist' });
  const weakRef = await evidence.addReference(fx.pharmacyId, weak.id, { section: '1' }, { actorType: 'pharmacist' });

  const [protocol] = await db`
    select id from clinical_protocols where pharmacy_id = ${fx.pharmacyId} and slug = ${fever.SLUG}
  `;
  await assert.rejects(
    () => recommendations.createRecommendation(fx.pharmacyId, protocol.id, {
      recommendationKey: 'overclaimed', recommendationType: 'self_care_advice',
      recommendationText: 'TEST ONLY', evidenceReferenceId: weakRef.id,
      evidenceStatus: 'strongly_supported',
    }, { actorType: 'pharmacist' }),
    /EVIDENCE_STATUS_EXCEEDS_SOURCE|Cannot claim evidence_status/,
  );
});

test('an unsupported key still yields nothing and pages nobody (§9)', { skip: SKIP && skipReason }, async () => {
  const r = await run();
  await completeAll(r);
  const res = await recommendations.evaluate(fx.pharmacyId, r.executionId, {
    recommendationKey: 'antibiotic_x_invented_by_the_model', clinicalConfidence: 0.99,
  }, { customerId: r.customerId });

  assert.equal(res.decision.status, 'not_applicable');
  assert.equal(res.deliverableText, null);
  assert.equal(res.evaluation.escalation_priority, null);
});
