/**
 * The evidence + recommendation layer, end to end against a real database.
 *
 * ALL EVIDENCE HERE IS TEST-ONLY AND CLEARLY LABELLED. Nothing in this file
 * cites a real clinical guideline, and the recommendation text is
 * deliberately non-pharmacological. The point is to prove the gate and the
 * traceability chain work — not to introduce clinical content, which is a
 * later, pharmacist-supervised task.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the recommendation engine was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const evidence = require('../services/clinical/evidenceService');
const recommendations = require('../services/clinical/recommendationService');
const engine = require('../services/clinical/protocolExecutionService');
const encounters = require('../services/clinical/clinicalEncounterService');
const facts = require('../services/clinical/clinicalFactService');
const protocols = require('../services/clinical/clinicalProtocolService');
const fever = require('../services/clinical/protocols/feverAssessmentV1');
const { buildBriefing } = require('../services/clinical/clinicalBriefing');

let db;
let ctx = {};
let phoneSeq = 0;

/** A fresh patient with a started fever run. */
async function newRun() {
  phoneSeq += 1;
  const suffix = String(phoneSeq).padStart(3, '0');
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyId}, ${`2349180000${suffix}`}, ${`2349180000${suffix}`},
            ${`2349180000${suffix}@s.whatsapp.net`}, 'Rec Tester')
    returning id
  `;
  const encounter = await encounters.createEncounter(ctx.pharmacyId, customer.id, {}, { actorType: 'ai' });
  const execution = await engine.startProtocol(ctx.pharmacyId, encounter.id, fever.SLUG, { customerId: customer.id });
  return { customerId: customer.id, encounterId: encounter.id, executionId: execution.id };
}

/** Answer every required question so the run is information-complete. */
async function completeAllQuestions(run) {
  for (const [key, ans] of [
    ['presenting_complaint', 'Fever'],
    ['who_is_this_for', 'for me'],
    ['fever_duration', '2 days'],
    ['fever_severity', '5'],
    ['has_associated_symptoms', 'no'],
  ]) {
    await engine.recordAnswer(ctx.pharmacyId, run.executionId, key, ans, { customerId: run.customerId });
  }
}

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Rec Engine Test', ${`rec-eng-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  const protocol = await fever.install(ctx.pharmacyId, { actorType: 'system' });
  ctx.protocolId = protocol.id;

  // A TEST-ONLY evidence source. Explicitly not real guidance.
  const source = await evidence.createSource(ctx.pharmacyId, {
    sourceKey: 'test_only_source',
    title: 'TEST ONLY — placeholder evidence source, not clinical guidance',
    publisher: 'RxNaija test fixture',
    origin: 'nigerian_guidance',
    strength: 'authoritative_guideline',
    version: '1.0',
  }, { actorType: 'pharmacist' });
  ctx.sourceId = source.id;

  await evidence.approveSource(ctx.pharmacyId, source.id, { actorType: 'pharmacist' });
  const ref = await evidence.addReference(ctx.pharmacyId, source.id, {
    section: '1.1', summary: 'TEST ONLY placeholder section.', population: 'TEST ONLY',
  }, { actorType: 'pharmacist' });
  ctx.referenceId = ref.id;

  // A benign, non-pharmacological recommendation, in autonomous scope.
  const rec = await recommendations.createRecommendation(ctx.pharmacyId, ctx.protocolId, {
    recommendationKey: 'test_rest_and_fluids',
    recommendationType: 'self_care_advice',
    recommendationText: 'TEST ONLY — rest and keep drinking fluids. Come back if you feel worse.',
    evidenceReferenceId: ref.id, evidenceStatus: 'strongly_supported',
    minEvidenceStrength: 'established_protocol',
    minClinicalConfidence: 0.8,
    autonomousScope: true,
    status: 'active',
  }, { actorType: 'pharmacist' });
  ctx.recommendationId = rec.id;
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ---- evidence ingestion boundary -----------------------------------------

test('a new evidence source starts as draft and cannot back a recommendation', { skip: SKIP && skipReason }, async () => {
  const s = await evidence.createSource(ctx.pharmacyId, {
    sourceKey: 'draft_only', title: 'TEST ONLY — unapproved', origin: 'global_guidance',
    strength: 'authoritative_guideline', version: '1.0',
  }, { actorType: 'pharmacist' });
  assert.equal(s.status, 'draft', 'uploading a document must not make it usable evidence');
});

test('only a human may approve an evidence source', { skip: SKIP && skipReason }, async () => {
  const s = await evidence.createSource(ctx.pharmacyId, {
    sourceKey: 'ai_approval_attempt', title: 'TEST ONLY', origin: 'global_guidance',
    strength: 'trusted_reference', version: '1.0',
  }, { actorType: 'pharmacist' });
  await assert.rejects(
    () => evidence.approveSource(ctx.pharmacyId, s.id, { actorType: 'ai' }),
    /pharmacist or staff/i,
    'an automated pipeline must not be able to approve its own ingest',
  );
});

test('a recommendation cannot be authored without an evidence reference', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => recommendations.createRecommendation(ctx.pharmacyId, ctx.protocolId, {
      recommendationKey: 'no_evidence', recommendationType: 'self_care_advice',
      recommendationText: 'TEST ONLY — unsourced',
    }, { actorType: 'pharmacist' }),
    /evidence_reference_id is required|EVIDENCE_REQUIRED/i,
  );
});

// ---- TEST 11: the LLM cannot invent a recommendation ---------------------

test('TEST 11 — asking for a recommendation that was never authored yields nothing, safely', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);

  // This is the shape an LLM-driven caller would use. The only thing it can
  // supply is a key; there is no parameter for text or evidence anywhere.
  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'paracetamol_1g_qds_invented_by_the_model',
    clinicalConfidence: 0.99,
  }, { customerId: run.customerId });

  assert.equal(res.decision.status, 'not_applicable');
  assert.equal(res.deliverableText, null, 'nothing may be delivered for an unauthored recommendation');
  assert.equal(res.evaluation.escalation_priority, null, 'and it must not page a pharmacist either');
});

test('there is no code path that accepts recommendation text at evaluation time', () => {
  // A structural assertion about the interface itself: evaluate() takes a
  // key, never content. If someone later adds a text parameter, this fails.
  const src = require('node:fs').readFileSync(
    require.resolve('../services/clinical/recommendationService'), 'utf8',
  );
  const evalFn = src.slice(src.indexOf('async function evaluate('), src.indexOf('/** Evaluations awaiting'));
  assert.ok(!/recommendationText|recommendation_text\s*=/.test(evalFn),
    'evaluate() must not accept recommendation text as an input');
});

// ---- TEST 1 + 12: the routine, eligible case -----------------------------

test('TEST 1 / 12 — a complete, eligible, well-evidenced case passes and does NOT page a pharmacist', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);

  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.94,
  }, { customerId: run.customerId });

  assert.equal(res.decision.status, 'eligible');
  assert.equal(res.evaluation.safety_status, 'passed');
  assert.equal(res.evaluation.escalation_priority, null);
  assert.equal(res.evaluation.pharmacist_review_status, 'not_required',
    'a routine supported case must not interrupt the pharmacist');
  assert.match(res.deliverableText, /TEST ONLY/);
});

// ---- TEST 4: incomplete information --------------------------------------

test('TEST 4 — incomplete information blocks delivery and requests review', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  // Deliberately answer only one question.
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'presenting_complaint', 'Fever', { customerId: run.customerId });

  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.99,
  }, { customerId: run.customerId });

  // Changed by the evidence-grounded guidance model (§7). Incomplete
  // information now CONTINUES the assessment instead of paging a pharmacist:
  // not having finished asking is not a safety event, and escalating every
  // half-finished conversation is how alert fatigue starts. The assertion this
  // test was written to protect — nothing is delivered — is unchanged.
  assert.equal(res.decision.status, 'continue_assessment');
  assert.equal(res.deliverableText, null);
  assert.equal(res.evaluation.escalation_priority, null);
  assert.equal(res.evaluation.pharmacist_review_status, 'not_required');
});

// ---- TEST 7: conflicting information -------------------------------------

test('TEST 7 — a conflicting fact forces review even when everything else is fine', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);

  // Profile-sourced age vs a different conversational age = conflict.
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'age_years', value: '30', valueNumber: 30, source: 'profile_reused',
  }, { customerId: run.customerId });
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'age_years', value: '45', valueNumber: 45, source: 'patient_reported',
  }, { customerId: run.customerId });

  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.95,
  }, { customerId: run.customerId });

  assert.equal(res.decision.status, 'requires_review');
  assert.ok(res.decision.reasons.includes('conflicting_information'));
  assert.equal(res.deliverableText, null);
});

// ---- TEST 5: red flag -----------------------------------------------------

test('TEST 5 — an active red flag blocks delivery and escalates urgently', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);

  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids',
    clinicalConfidence: 0.99,
    firedRedFlags: [{ name: 'TEST ONLY — placeholder flag', severity: 'emergency', action: 'emergency_referral' }],
  }, { customerId: run.customerId });

  assert.equal(res.decision.status, 'blocked');
  assert.equal(res.evaluation.escalation_priority, 'urgent');
  assert.equal(res.deliverableText, null);
});

// ---- TEST 9: traceability -------------------------------------------------

test('TEST 9 — an eligible evaluation is traceable to its exact source, version and section', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);

  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.94,
  }, { customerId: run.customerId });

  assert.equal(res.evaluation.evidence_source_key, 'test_only_source');
  assert.equal(res.evaluation.evidence_source_version, '1.0');
  assert.equal(res.evaluation.evidence_strength, 'authoritative_guideline');
  assert.match(res.explanation, /EVIDENCE: test_only_source v1\.0 §1\.1/);

  // And the stored trace alone is enough to reconstruct the decision.
  const trace = res.evaluation.decision_trace;
  assert.ok(Array.isArray(trace) && trace.length > 0);
  assert.ok(trace.every((t) => typeof t.check === 'string' && typeof t.passed === 'boolean'));
  assert.ok(trace.every((t) => t.passed), 'an eligible decision must have no failed checks in its trace');
});

test('the persisted evaluation pins the source version, so later revisions do not rewrite history', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);
  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.94,
  }, { customerId: run.customerId });

  // Publish v2.0 of the same source.
  await evidence.createSource(ctx.pharmacyId, {
    sourceKey: 'test_only_source', title: 'TEST ONLY — revised', origin: 'nigerian_guidance',
    strength: 'authoritative_guideline', version: '2.0',
  }, { actorType: 'pharmacist' });

  const [stored] = await db`
    select evidence_source_version from recommendation_evaluations where id = ${res.evaluation.id}
  `;
  assert.equal(stored.evidence_source_version, '1.0',
    'the evaluation must still name the version that actually authorised it');
});

// ---- pharmacist briefing --------------------------------------------------

test('the briefing leads with WHY review is needed and carries provenance', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'presenting_complaint', 'Fever and chills', { customerId: run.customerId });
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_severity', '8', { customerId: run.customerId });

  const res = await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.6,
  }, { customerId: run.customerId });

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  const briefing = buildBriefing({
    decision: res.decision, executionState: state,
    recommendation: res.recommendation, evidence: res.evidence,
    patient: { displayName: 'Rec Tester' },
  });

  // The reason comes before the clinical detail.
  const whyIdx = briefing.indexOf('WHY THIS NEEDS YOU');
  const factsIdx = briefing.indexOf('COLLECTED CLINICAL FACTS');
  assert.ok(whyIdx >= 0 && whyIdx < factsIdx, 'the reason must lead, not be buried below the facts');

  assert.match(briefing, /Required clinical information is still missing/);
  assert.match(briefing, /patient-reported/, 'facts must carry their provenance, not read as measurements');
  assert.match(briefing, /MISSING INFORMATION:/);
  assert.match(briefing, /PROTOCOL: fever_assessment v1\.0\.0/);
});

// ---- escalation priority ordering ----------------------------------------

test('pending reviews come back most urgent first', { skip: SKIP && skipReason }, async () => {
  const pending = await recommendations.listPendingReviews(ctx.pharmacyId, { limit: 50 });
  const rank = { urgent: 4, high: 3, medium: 2, low: 1 };
  for (let i = 1; i < pending.length; i += 1) {
    const prev = rank[pending[i - 1].escalation_priority] || 0;
    const cur = rank[pending[i].escalation_priority] || 0;
    assert.ok(prev >= cur, 'a pharmacist must see the most serious case first');
  }
});

// ---- §1 information status ------------------------------------------------

test('information status distinguishes KNOWN, REQUIRED, NOT_APPLICABLE and REQUIRES_CONFIRMATION', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'presenting_complaint', 'Fever', { customerId: run.customerId });

  const status = await engine.getInformationStatus(ctx.pharmacyId, run.executionId);
  assert.equal(status.get('presenting_complaint').status, 'KNOWN');
  assert.equal(status.get('fever_severity').status, 'REQUIRED');
  assert.equal(status.get('existing_medication_taken').status, 'OPTIONAL');
  // The conditional follow-up is not applicable until the gating answer says yes.
  assert.equal(status.get('associated_symptoms').status, 'NOT_APPLICABLE');
});

test('a conflicted fact marks its question REQUIRES_CONFIRMATION', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'presenting_complaint', value: 'Headache', source: 'profile_reused',
  }, { customerId: run.customerId });
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'presenting_complaint', value: 'Fever', source: 'patient_reported',
  }, { customerId: run.customerId });

  const status = await engine.getInformationStatus(ctx.pharmacyId, run.executionId);
  assert.equal(status.get('presenting_complaint').status, 'REQUIRES_CONFIRMATION',
    'a disputed value must be confirmed, never silently treated as known');
});

// ---- audit ----------------------------------------------------------------

test('every gate run is audited — passes as well as blocks', { skip: SKIP && skipReason }, async () => {
  const run = await newRun();
  await completeAllQuestions(run);
  await recommendations.evaluate(ctx.pharmacyId, run.executionId, {
    recommendationKey: 'test_rest_and_fluids', clinicalConfidence: 0.94,
  }, { customerId: run.customerId });

  const [event] = await db`
    select event_type, visibility, metadata from customer_events
    where customer_id = ${run.customerId} and event_type = 'RECOMMENDATION_EVALUATED'
    order by id desc limit 1
  `;
  assert.ok(event, 'an eligible decision is still a clinical decision and must be recorded');
  assert.equal(event.visibility, 'internal');
  assert.equal(event.metadata.status, 'eligible');

  // The recommendation TEXT must not be copied into the audit blob.
  assert.ok(!JSON.stringify(event.metadata).includes('rest and keep drinking'),
    'audit metadata records the outcome, not the clinical content');
});

test('tenant isolation: another pharmacy cannot evaluate against this run', { skip: SKIP && skipReason }, async () => {
  const [other] = await db`
    insert into pharmacies (name, slug, status) values ('Other Rec', ${`other-rec-${Date.now()}`}, 'active')
    returning id
  `;
  const run = await newRun();
  try {
    await assert.rejects(
      () => recommendations.evaluate(other.id, run.executionId, { recommendationKey: 'test_rest_and_fluids' }),
      /not found/i,
    );
  } finally {
    await db`delete from audit_logs where pharmacy_id = ${other.id}`.catch(() => {});
    await db`delete from pharmacies where id = ${other.id}`.catch(() => {});
  }
});

// ---- the boundary: nothing clinical ships by default ---------------------

test('fever_assessment ships with NO configured recommendations', { skip: SKIP && skipReason }, async () => {
  const [fresh] = await db`
    insert into pharmacies (name, slug, status) values ('Fresh Install', ${`fresh-${Date.now()}`}, 'active')
    returning id
  `;
  try {
    const protocol = await fever.install(fresh.id, { actorType: 'system' });
    const recs = await recommendations.listRecommendations(fresh.id, protocol.id, {});
    assert.equal(recs.length, 0,
      'a freshly installed protocol must carry no recommendations until a pharmacist loads approved evidence');

    const sources = await db`select count(*)::int n from evidence_sources where pharmacy_id = ${fresh.id}`;
    assert.equal(sources[0].n, 0, 'and no evidence sources either');
  } finally {
    await db`delete from audit_logs where pharmacy_id = ${fresh.id}`.catch(() => {});
    await db`delete from pharmacies where id = ${fresh.id}`.catch(() => {});
  }
});
