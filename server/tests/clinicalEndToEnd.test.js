/**
 * Stage 2 Part 3 — end-to-end validation of the clinical engine.
 *
 * SOFTWARE VALIDATION, NOT CLINICAL VALIDATION. Every scenario proves the
 * engine behaved as its configuration said it should. None of it says the
 * configuration is clinically correct — that is a pharmacist's judgement,
 * made outside this repository, and no test here should be read as evidence
 * of it.
 *
 * All evidence and recommendations below are TEST-ONLY fixtures and cite
 * nothing real.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the end-to-end clinical flow was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const evidence = require('../services/clinical/evidenceService');
const recommendations = require('../services/clinical/recommendationService');
const workflow = require('../services/clinical/clinicalWorkflow');
const engine = require('../services/clinical/protocolExecutionService');
const fever = require('../services/clinical/protocols/feverAssessmentV1');
const scenario = require('./helpers/clinicalScenario');

let db;
let ctx = {};

/** The full set of answers that completes a fever run. */
const COMPLETE_TURNS = [
  { send: 'I have a fever', answering: 'presenting_complaint', expect: { outcome: 'CONTINUE' } },
  { send: 'for me', answering: 'who_is_this_for', expect: { outcome: 'CONTINUE' } },
  { send: '2 days', answering: 'fever_duration', expect: { outcome: 'CONTINUE' } },
  { send: '4', answering: 'fever_severity', expect: { outcome: 'CONTINUE' } },
  { send: 'no', answering: 'has_associated_symptoms' },
];

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('E2E Clinical', ${`e2e-clin-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };

  const protocol = await fever.install(ctx.pharmacyId, { actorType: 'system' });
  ctx.protocolId = protocol.id;

  const source = await evidence.createSource(ctx.pharmacyId, {
    sourceKey: 'e2e_test_source',
    title: 'TEST ONLY — placeholder evidence, not clinical guidance',
    origin: 'nigerian_guidance', strength: 'authoritative_guideline', version: '1.0',
  }, { actorType: 'pharmacist' });
  await evidence.approveSource(ctx.pharmacyId, source.id, { actorType: 'pharmacist' });
  const ref = await evidence.addReference(ctx.pharmacyId, source.id, {
    section: '2.1', summary: 'TEST ONLY.',
  }, { actorType: 'pharmacist' });
  ctx.referenceId = ref.id;

  // Autonomous, benign, non-pharmacological.
  const rec = await recommendations.createRecommendation(ctx.pharmacyId, ctx.protocolId, {
    recommendationKey: 'e2e_rest_fluids',
    recommendationType: 'self_care_advice',
    recommendationText: 'TEST ONLY — rest and keep taking fluids. Come back if anything changes.',
    evidenceReferenceId: ref.id, evidenceStatus: 'strongly_supported',
    minClinicalConfidence: 0.8,
    autonomousScope: true,
    status: 'active',
  }, { actorType: 'pharmacist' });
  ctx.recommendationKey = rec.recommendation_key;

  // A second rule excluded for pregnancy, to exercise the exclusion path.
  const excluded = await recommendations.createRecommendation(ctx.pharmacyId, ctx.protocolId, {
    recommendationKey: 'e2e_excluded_if_pregnant',
    recommendationType: 'self_care_advice',
    recommendationText: 'TEST ONLY — excluded-population rule.',
    evidenceReferenceId: ref.id, evidenceStatus: 'strongly_supported',
    exclusionConditions: { any_of: [{ concept: 'is_pregnant', equals: 'true' }] },
    minClinicalConfidence: 0.8,
    autonomousScope: true,
    status: 'active',
  }, { actorType: 'pharmacist' });
  ctx.excludedKey = excluded.recommendation_key;
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ==========================================================================
// SCENARIO 1 — routine low-risk case: engine asks, then recommends
// ==========================================================================

test('SCENARIO 1 — routine low-risk case runs to a recommendation without a pharmacist', { skip: SKIP && skipReason }, async () => {
  const { results } = await scenario.run(ctx.pharmacyId, {
    name: 'routine low-risk',
    protocolSlug: fever.SLUG,
    turns: [
      ...COMPLETE_TURNS.slice(0, 4),
      {
        send: 'no', answering: 'has_associated_symptoms',
        confidence: 0.95, recommendationKey: 'e2e_rest_fluids',
        expect: { outcome: 'RECOMMENDATION', priority: null, recommendationDelivered: true },
      },
    ],
    expectFinal: {
      protocolState: 'ready_for_review',
      facts: { presenting_complaint: 'I have a fever', symptom_duration_days: '2', fever_severity_gauge: '4' },
      missingRequired: [],
      handoffRaised: false,
      evaluationStatus: 'eligible',
    },
  });

  const last = results[results.length - 1];
  assert.match(last.recommendationText, /TEST ONLY/);
});

// ==========================================================================
// SCENARIO 2 — missing information: CONTINUE, never a guess
// ==========================================================================

test('SCENARIO 2 — incomplete information keeps asking and never recommends', { skip: SKIP && skipReason }, async () => {
  await scenario.run(ctx.pharmacyId, {
    name: 'missing information',
    protocolSlug: fever.SLUG,
    turns: [
      { send: 'I feel feverish', answering: 'presenting_complaint',
        expect: { outcome: 'CONTINUE', recommendationDelivered: false } },
      // Even asking for a recommendation now must not produce one.
      { send: 'for me', answering: 'who_is_this_for',
        confidence: 0.99, recommendationKey: 'e2e_rest_fluids',
        expect: { outcome: 'CONTINUE', recommendationDelivered: false } },
    ],
    expectFinal: { protocolState: 'awaiting_information', handoffRaised: false },
  });
});

// ==========================================================================
// SCENARIO 3 — high confidence + supported = allowed
// SCENARIO 4 — high confidence + UNsupported = blocked
// ==========================================================================

test('SCENARIO 3/4 — the same confidence is allowed with evidence and refused without it', { skip: SKIP && skipReason }, async () => {
  // Supported.
  const supported = await scenario.run(ctx.pharmacyId, {
    name: 'high confidence supported',
    protocolSlug: fever.SLUG,
    turns: [...COMPLETE_TURNS.slice(0, 4), {
      send: 'no', answering: 'has_associated_symptoms',
      confidence: 0.97, recommendationKey: 'e2e_rest_fluids',
      expect: { outcome: 'RECOMMENDATION', recommendationDelivered: true },
    }],
  });
  assert.ok(supported.results.at(-1).recommendationText);

  // Unsupported — an unauthored key, identical confidence.
  const unsupported = await scenario.run(ctx.pharmacyId, {
    name: 'high confidence unsupported',
    protocolSlug: fever.SLUG,
    turns: [...COMPLETE_TURNS.slice(0, 4), {
      send: 'no', answering: 'has_associated_symptoms',
      confidence: 0.97, recommendationKey: 'invented_by_the_model_paracetamol',
      expect: { recommendationDelivered: false },
    }],
    expectFinal: { evaluationStatus: 'not_applicable' },
  });
  assert.equal(unsupported.results.at(-1).recommendationText, null,
    'identical confidence must not deliver anything without an authored, evidenced rule');
});

// ==========================================================================
// SCENARIO 5 — red flag
// ==========================================================================

test('SCENARIO 5 — a red flag escalates urgently and blocks any recommendation', { skip: SKIP && skipReason }, async () => {
  const { results } = await scenario.run(ctx.pharmacyId, {
    name: 'red flag',
    protocolSlug: fever.SLUG,
    turns: [{
      send: 'I have a fever', answering: 'presenting_complaint',
      confidence: 0.99, recommendationKey: 'e2e_rest_fluids',
      firedRedFlags: [{ name: 'TEST ONLY — placeholder emergency flag', severity: 'emergency', action: 'emergency_referral' }],
      expect: { outcome: 'URGENT', priority: 'urgent', recommendationDelivered: false },
    }],
    expectFinal: { handoffRaised: true },
  });

  // The patient is told to seek care, and it does not read like reassurance.
  assert.match(results[0].patientMessage, /straight away|pharmacist/i);
});

// ==========================================================================
// SCENARIO 6 — conflicting information
// ==========================================================================

test('SCENARIO 6 — conflicting information stops the flow and asks a human', { skip: SKIP && skipReason }, async () => {
  const facts = require('../services/clinical/clinicalFactService');
  const { customerId, conversationId } = await scenario.setupPatient(ctx.pharmacyId, {
    profile: { age_years: 34 },
  });

  // First turn creates the encounter and seeds age 34 from the profile.
  await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId, protocolSlug: fever.SLUG,
    patientMessage: 'I have a fever', answeringKey: 'presenting_complaint',
  });

  const [encounter] = await db`
    select id from clinical_encounters where conversation_id = ${conversationId} limit 1
  `;
  // The patient now says something different.
  await facts.recordFact(ctx.pharmacyId, encounter.id, {
    concept: 'age_years', value: '41', valueNumber: 41, source: 'patient_reported',
  }, { customerId });

  const result = await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId, protocolSlug: fever.SLUG,
    patientMessage: 'for me', answeringKey: 'who_is_this_for',
    confidence: 0.99, recommendationKey: 'e2e_rest_fluids',
  });

  assert.equal(result.outcome, 'REVIEW');
  assert.equal(result.reason, 'conflicting_information');
  assert.equal(result.recommendationText, null, 'a disputed record must not yield a recommendation');
});

// ==========================================================================
// SCENARIO 7 — pharmacist escalation (exclusion)
// ==========================================================================

test('SCENARIO 7 — a population exclusion blocks and escalates to a pharmacist', { skip: SKIP && skipReason }, async () => {
  const facts = require('../services/clinical/clinicalFactService');
  const { customerId, conversationId } = await scenario.setupPatient(ctx.pharmacyId, {});

  for (const t of COMPLETE_TURNS.slice(0, 4)) {
    await workflow.handleTurn(ctx.pharmacyId, {
      conversationId, customerId, protocolSlug: fever.SLUG,
      patientMessage: t.send, answeringKey: t.answering,
    });
  }
  const [encounter] = await db`
    select id from clinical_encounters where conversation_id = ${conversationId} limit 1
  `;
  await facts.recordFact(ctx.pharmacyId, encounter.id, {
    concept: 'is_pregnant', value: 'true', source: 'patient_reported',
  }, { customerId });

  const result = await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId, protocolSlug: fever.SLUG,
    patientMessage: 'no', answeringKey: 'has_associated_symptoms',
    confidence: 0.99, recommendationKey: 'e2e_excluded_if_pregnant',
  });

  assert.equal(result.recommendationText, null);
  assert.ok(['REVIEW', 'URGENT'].includes(result.outcome));
  assert.ok((result.reasons || []).includes('exclusion_present'));

  const [h] = await db`select count(*)::int n from handoffs where conversation_id = ${conversationId}`;
  assert.ok(h.n > 0, 'an excluded patient must reach a pharmacist');
});

// ==========================================================================
// SCENARIO 8 — system failure
// ==========================================================================

test('SCENARIO 8 — an unavailable protocol fails safe to REVIEW, never to a guess', { skip: SKIP && skipReason }, async () => {
  const { customerId, conversationId } = await scenario.setupPatient(ctx.pharmacyId, {});

  const result = await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId,
    protocolSlug: 'protocol_that_does_not_exist',
    patientMessage: 'I have a fever',
  });

  assert.equal(result.outcome, 'REVIEW');
  assert.equal(result.failedSafe, true);
  assert.equal(result.reason, 'clinical_engine_unavailable');
  assert.equal(result.recommendationText, null);
  assert.ok(result.patientMessage.length > 0, 'the patient must still get a reply');
  // And the reply must contain nothing clinical.
  assert.ok(!/fever|temperature|paracetamol|dose|malaria/i.test(result.patientMessage),
    'a system failure must not be papered over with clinical-sounding text');
});

test('a failure at every stage still ends in REVIEW, never CONTINUE or RECOMMENDATION', { skip: SKIP && skipReason }, async () => {
  // Each fallback reason the workflow can produce must map to a safe outcome.
  for (const reason of [
    'clinical_engine_unavailable', 'fact_extraction_failed',
    'protocol_state_unavailable', 'recommendation_engine_unavailable',
    'no_question_available_for_missing_information',
  ]) {
    const fb = workflow.safeFallback(reason);
    assert.equal(fb.outcome, 'REVIEW', `${reason} must fail safe`);
    assert.equal(fb.recommendationText, null);
    assert.equal(fb.failedSafe, true);
    assert.ok(fb.patientMessage.length > 0);
  }
});

test('an invalid protocol version cannot be started', { skip: SKIP && skipReason }, async () => {
  const { customerId, conversationId } = await scenario.setupPatient(ctx.pharmacyId, {});
  const encounters = require('../services/clinical/clinicalEncounterService');
  const enc = await encounters.createEncounter(ctx.pharmacyId, customerId, { conversationId }, { actorType: 'ai' });
  await assert.rejects(
    () => engine.startProtocol(ctx.pharmacyId, enc.id, 'no_such_protocol', { customerId }),
    /NO_ACTIVE_PROTOCOL|No active protocol/,
  );
});

// ==========================================================================
// §2 — THE LLM BOUNDARY
// ==========================================================================

test('§2 — an LLM-authored recommendation is rejected outright', { skip: SKIP && skipReason }, async () => {
  const rejected = workflow.rejectUnapprovedRecommendation(
    'Take 1g paracetamol every 6 hours and 500mg amoxicillin three times daily.'
  );
  assert.equal(rejected.approved, false);
  assert.equal(rejected.text, null, 'the rejected content must not be handed back to the caller');
  assert.equal(rejected.reason, 'llm_authored_recommendation_rejected');
});

test('§2 — releaseRecommendation re-runs the gate and cannot be handed a pre-approval', { skip: SKIP && skipReason }, async () => {
  const { customerId, conversationId } = await scenario.setupPatient(ctx.pharmacyId, {});
  // Only one question answered, so the gate must refuse regardless of what
  // any earlier step believed.
  await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId, protocolSlug: fever.SLUG,
    patientMessage: 'fever', answeringKey: 'presenting_complaint',
  });
  const [execution] = await db`
    select pe.id from protocol_executions pe
    join clinical_encounters ce on ce.id = pe.encounter_id
    where ce.conversation_id = ${conversationId} limit 1
  `;

  const released = await workflow.releaseRecommendation(ctx.pharmacyId, execution.id, {
    recommendationKey: 'e2e_rest_fluids', clinicalConfidence: 1.0, customerId,
  });
  assert.equal(released.approved, false);
  assert.equal(released.text, null);
});

test('§2 — the conversation layer receives the APPROVED question text, not a free-form one', { skip: SKIP && skipReason }, async () => {
  const { customerId, conversationId } = await scenario.setupPatient(ctx.pharmacyId, {});
  const result = await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId, protocolSlug: fever.SLUG,
  });
  assert.equal(result.outcome, 'CONTINUE');
  assert.ok(result.question?.key, 'the question must be identified by its protocol key');

  const [q] = await db`
    select text from protocol_questions
    where protocol_id = ${ctx.protocolId} and question_key = ${result.question.key}
  `;
  assert.equal(result.question.text, q.text,
    'the text handed to the conversation layer must be the authored question');
});

// ==========================================================================
// §4 — SELECTIVE ESCALATION
// ==========================================================================

test('§4 — a routine passing case raises NO handoff at all', { skip: SKIP && skipReason }, async () => {
  const { conversationId } = await scenario.run(ctx.pharmacyId, {
    name: 'no unnecessary ping',
    protocolSlug: fever.SLUG,
    turns: [...COMPLETE_TURNS.slice(0, 4), {
      send: 'no', answering: 'has_associated_symptoms',
      confidence: 0.95, recommendationKey: 'e2e_rest_fluids',
      expect: { outcome: 'RECOMMENDATION' },
    }],
    expectFinal: { handoffRaised: false },
  });

  const [h] = await db`select count(*)::int n from handoffs where conversation_id = ${conversationId}`;
  assert.equal(h.n, 0, 'a well-supported low-risk case must not interrupt the pharmacist');
});

test('§4 — merely asking protocol questions does not raise a handoff', { skip: SKIP && skipReason }, async () => {
  const { conversationId } = await scenario.run(ctx.pharmacyId, {
    name: 'questions only',
    protocolSlug: fever.SLUG,
    turns: [
      { send: 'I have a fever', answering: 'presenting_complaint', expect: { outcome: 'CONTINUE' } },
      { send: 'for me', answering: 'who_is_this_for', expect: { outcome: 'CONTINUE' } },
    ],
    expectFinal: { handoffRaised: false },
  });
  const [h] = await db`select count(*)::int n from handoffs where conversation_id = ${conversationId}`;
  assert.equal(h.n, 0);
});

test('§4 — an escalated case carries a briefing a pharmacist can act on', { skip: SKIP && skipReason }, async () => {
  const { conversationId } = await scenario.setupPatient(ctx.pharmacyId, {});
  const { customerId } = await (async () => {
    const [c] = await db`select customer_id from conversations where id = ${conversationId}`;
    return { customerId: c.customer_id };
  })();

  await workflow.handleTurn(ctx.pharmacyId, {
    conversationId, customerId, protocolSlug: fever.SLUG,
    patientMessage: 'I have a fever and I feel very weak', answeringKey: 'presenting_complaint',
    firedRedFlags: [{ name: 'TEST ONLY — placeholder flag', severity: 'urgent', action: 'urgent_referral' }],
  });

  const [handoff] = await db`
    select detail from handoffs where conversation_id = ${conversationId} order by requested_at desc limit 1
  `;
  assert.ok(handoff, 'a red flag must raise a handoff');

  // The pharmacist must be able to act without reading the thread.
  for (const expected of [/WHY THIS NEEDS YOU/, /PRESENTING COMPLAINT/, /RED FLAGS/, /PROTOCOL: fever_assessment v1\.0\.0/]) {
    assert.match(handoff.detail, expected, `briefing is missing ${expected}`);
  }
});

// ==========================================================================
// §6 — AUDIT RECONSTRUCTION
// ==========================================================================

test('§6 — a full encounter can be reconstructed from the audit trail alone', { skip: SKIP && skipReason }, async () => {
  const { customerId } = await scenario.run(ctx.pharmacyId, {
    name: 'audit reconstruction',
    protocolSlug: fever.SLUG,
    turns: [...COMPLETE_TURNS.slice(0, 4), {
      send: 'no', answering: 'has_associated_symptoms',
      confidence: 0.95, recommendationKey: 'e2e_rest_fluids',
      expect: { outcome: 'RECOMMENDATION' },
    }],
  });

  const events = await scenario.auditTrail(customerId);
  const types = events.map((e) => e.event_type);

  // The spec's required list, mapped onto this system's existing vocabulary
  // (QUESTION_ASKED == QUESTION_PRESENTED, PATIENT_RESPONSE_RECEIVED ==
  // ANSWER_RECEIVED — reused rather than duplicated under new names).
  for (const required of [
    'PROTOCOL_SELECTED', 'PROTOCOL_STARTED', 'ENCOUNTER_CREATED',
    'QUESTION_ASKED', 'PATIENT_RESPONSE_RECEIVED', 'FACT_CREATED',
    'PROTOCOL_STATE_CHANGED', 'RECOMMENDATION_EVALUATED', 'RECOMMENDATION_DELIVERED',
  ]) {
    assert.ok(types.includes(required), `audit trail cannot answer "what happened" — missing ${required}`);
  }

  // "Which protocol version?" — answerable.
  const started = events.find((e) => e.event_type === 'PROTOCOL_STARTED');
  assert.equal(started.metadata.version, '1.0.0');

  // "Why was the recommendation allowed?" — answerable.
  const evaluated = events.find((e) => e.event_type === 'RECOMMENDATION_EVALUATED');
  assert.equal(evaluated.metadata.status, 'eligible');
  assert.deepEqual(evaluated.metadata.reasons, []);

  // Every clinical event is staff-only and attributed.
  const { CLINICAL_EVENT_TYPES } = require('../services/clinical/clinicalAudit');
  for (const e of events) {
    if (CLINICAL_EVENT_TYPES.has(e.event_type)) assert.equal(e.visibility, 'internal');
    assert.ok(e.actor_type && e.occurred_at);
  }
});

test('§6 — two different patients asked the SAME question are both recorded', { skip: SKIP && skipReason }, async () => {
  // REGRESSION. recordEvent's default idempotency key is (eventType,
  // entityType, entityId), and a protocol question's id is shared by every
  // patient. Without an explicit per-execution key, only the first patient
  // ever asked a question produced a QUESTION_ASKED event and everyone
  // afterwards was silently deduplicated — an audit trail that cannot show
  // a question was put to the patient in front of you.
  const a = await scenario.setupPatient(ctx.pharmacyId, {});
  const b = await scenario.setupPatient(ctx.pharmacyId, {});

  for (const p of [a, b]) {
    await workflow.handleTurn(ctx.pharmacyId, {
      conversationId: p.conversationId, customerId: p.customerId, protocolSlug: fever.SLUG,
    });
  }

  for (const [label, p] of [['first', a], ['second', b]]) {
    const events = await scenario.auditTrail(p.customerId);
    assert.ok(events.some((e) => e.event_type === 'QUESTION_ASKED'),
      `the ${label} patient must have their own QUESTION_ASKED event`);
  }
});

test('§6 — every state transition in a run is recorded, not collapsed to one', { skip: SKIP && skipReason }, async () => {
  // The same collision one level down: entityId was the execution, so a
  // run's second and later transitions deduplicated against the first.
  const { customerId } = await scenario.run(ctx.pharmacyId, {
    name: 'state history',
    protocolSlug: fever.SLUG,
    turns: [
      { send: 'I have a fever', answering: 'presenting_complaint' },
      { send: 'for me', answering: 'who_is_this_for' },
      { send: '2 days', answering: 'fever_duration' },
      { send: '4', answering: 'fever_severity' },
      { send: 'no', answering: 'has_associated_symptoms' },
    ],
  });

  const events = await scenario.auditTrail(customerId);
  const asked = events.filter((e) => e.event_type === 'QUESTION_ASKED');
  assert.ok(asked.length >= 4,
    `expected a QUESTION_ASKED per question put to the patient, got ${asked.length}`);

  // in_progress -> awaiting_information -> ready_for_review must both appear.
  const changes = events.filter((e) => e.event_type === 'PROTOCOL_STATE_CHANGED');
  const transitions = changes.map((e) => `${e.metadata.from}->${e.metadata.to}`);
  assert.ok(transitions.includes('in_progress->awaiting_information'), `missing first transition: ${transitions}`);
  assert.ok(transitions.includes('awaiting_information->ready_for_review'), `missing final transition: ${transitions}`);
});

test('§6 — a blocked encounter records WHY it was blocked', { skip: SKIP && skipReason }, async () => {
  const { customerId } = await scenario.run(ctx.pharmacyId, {
    name: 'audit blocked',
    protocolSlug: fever.SLUG,
    turns: [...COMPLETE_TURNS.slice(0, 4), {
      send: 'no', answering: 'has_associated_symptoms',
      confidence: 0.1, recommendationKey: 'e2e_rest_fluids',
      expect: { outcome: 'RESOLVED' },
    }],
  });

  const events = await scenario.auditTrail(customerId);
  const evaluated = events.filter((e) => e.event_type === 'RECOMMENDATION_EVALUATED').pop();
  // RESOLVED, not REVIEW. Low confidence is uncertainty, not a safety event,
  // so it no longer pages a pharmacist — the patient gets the sourced safety
  // net and an OFFER of a human instead. With zero recommendations approved,
  // the old behaviour escalated EVERY completed assessment at low priority,
  // which is the alert flood the product decision rejects.
  //
  // Escalation is now reserved for a real safety signal: a hard block, or a
  // gate priority of high/urgent. What this test protects is unchanged — the
  // audit still names the specific rule, not merely that something failed.
  assert.equal(evaluated.metadata.status, 'continue_assessment');
  assert.ok(evaluated.metadata.reasons.includes('confidence_below_threshold'),
    'the audit must say which rule blocked it, not merely that something did');
});

// ==========================================================================
// the default-off switch
// ==========================================================================

test('the clinical workflow is OFF by default for a new pharmacy', { skip: SKIP && skipReason }, async () => {
  const [fresh] = await db`
    insert into pharmacies (name, slug, status) values ('Fresh Flag', ${`fresh-flag-${Date.now()}`}, 'active')
    returning id
  `;
  try {
    assert.equal(await workflow.isClinicalWorkflowEnabled(fresh.id), false,
      'a pharmacy must opt in deliberately, after loading approved evidence');
  } finally {
    await db`delete from pharmacies where id = ${fresh.id}`.catch(() => {});
  }
});
