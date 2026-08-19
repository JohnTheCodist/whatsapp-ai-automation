/**
 * The safety gate, tested as a PURE function — no database, no fixtures.
 *
 * That is the point of it being pure: the clinical decision logic can be
 * exercised exhaustively and instantly, including combinations that would be
 * awkward to construct in a live database. The DB-backed integration tests
 * live in recommendationEngine.test.js.
 *
 * The single most important test in this file:
 * "confidence of 1.0 cannot rescue any structural failure".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../services/clinical/safetyGate');
const { REASONS } = gate;

/** A recommendation that would pass everything, so each test can break ONE thing. */
function goodRecommendation(over = {}) {
  return {
    recommendation_key: 'test_rec',
    recommendation_type: 'self_care_advice',
    recommendation_text: 'TEST ONLY',
    status: 'active',
    eligibility_conditions: {},
    exclusion_conditions: {},
    min_evidence_strength: 'established_protocol',
    min_clinical_confidence: 0.8,
    autonomous_scope: true,
    // Stated explicitly because the column defaults to 'unknown', which is a
    // hard block: an unreviewed recommendation must not be able to speak. A
    // fixture that expects to PASS therefore has to say what its evidence
    // actually supports — the default failing closed is the point.
    evidence_status: 'strongly_supported',
    ...over,
  };
}
function goodEvidence(over = {}) {
  return {
    source: {
      source_key: 'test_source', version: '1.0', status: 'active',
      strength: 'authoritative_guideline', origin: 'nigerian_guidance',
      ...(over.source || {}),
    },
    reference: { section: '4.2', ...(over.reference || {}) },
  };
}
function baseCtx(over = {}) {
  return {
    recommendation: goodRecommendation(),
    evidence: goodEvidence(),
    factsByConcept: new Map(),
    missingRequired: [],
    conflicts: [],
    redFlags: [],
    clinicalConfidence: 0.95,
    protocol: { status: 'active' },
    ...over,
  };
}

// ---- TEST 1: the happy path ----------------------------------------------

test('TEST 1 — high confidence + strong evidence + eligible patient = ELIGIBLE', () => {
  const d = gate.evaluate(baseCtx());
  assert.equal(d.status, 'eligible');
  assert.equal(d.safetyStatus, 'passed');
  assert.equal(d.escalationPriority, null, 'a clean pass must not page anyone');
  assert.deepEqual(d.reasons, []);
});

// ---- TEST 2 + 10: no evidence -------------------------------------------

test('TEST 2 / 10 — high confidence with NO evidence is blocked, not allowed', () => {
  const d = gate.evaluate(baseCtx({ evidence: null, clinicalConfidence: 1.0 }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes(REASONS.MISSING_EVIDENCE_REFERENCE));
});

test('an unapproved (draft) evidence source cannot back a recommendation', () => {
  const d = gate.evaluate(baseCtx({ evidence: goodEvidence({ source: { status: 'draft' } }) }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes(REASONS.EVIDENCE_SOURCE_NOT_APPROVED));
});

test('evidence weaker than the recommendation requires is blocked', () => {
  const d = gate.evaluate(baseCtx({
    evidence: goodEvidence({ source: { strength: 'unverified' } }),
    recommendation: goodRecommendation({ min_evidence_strength: 'authoritative_guideline' }),
  }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes(REASONS.EVIDENCE_BELOW_REQUIRED_STRENGTH));
});

// ---- TEST 3: low confidence ----------------------------------------------

test('TEST 3 — low confidence + strong evidence = keep assessing, not delivery', () => {
  const d = gate.evaluate(baseCtx({ clinicalConfidence: 0.4 }));
  // Changed by the evidence-grounded guidance model: low confidence now
  // CONTINUES the assessment rather than paging a pharmacist. §3 makes
  // confidence a supplementary uncertainty signal with no clinical authority,
  // and something that cannot authorise a recommendation should not be able to
  // summon a professional either. What is unchanged, and is the point of the
  // test: nothing is delivered.
  assert.equal(d.status, 'continue_assessment');
  assert.ok(d.reasons.includes(REASONS.CONFIDENCE_BELOW_THRESHOLD));
  assert.equal(d.escalationPriority, null);
});

test('confidence that was never assessed is treated as failing, not as passing', () => {
  const d = gate.evaluate(baseCtx({ clinicalConfidence: null }));
  // continue_assessment rather than requires_review since the guidance model —
  // a missing confidence is a caller that has not finished, not a safety
  // event. The invariant this test exists for is untouched: it must not pass.
  assert.equal(d.status, 'continue_assessment');
  assert.notEqual(d.status, 'eligible');
  // CONFIDENCE_UNUSABLE, not BELOW_THRESHOLD: absent confidence is a caller
  // that never established one, which the Part 3 review split out from a
  // genuinely low reading. The behaviour this test protects — absent
  // confidence must never pass — is unchanged.
  assert.ok(d.reasons.includes(REASONS.CONFIDENCE_UNUSABLE));
});

// ---- TEST 4: incomplete information --------------------------------------

test('TEST 4 — strong evidence + missing required information = ask, do not page', () => {
  const d = gate.evaluate(baseCtx({ missingRequired: [{ question_key: 'fever_duration' }] }));
  // Changed by the evidence-grounded guidance model (§7): an unfinished
  // assessment is a reason to ask the next question, not to interrupt a
  // pharmacist. Previously this escalated at 'medium', which meant every
  // half-finished conversation generated an alert.
  assert.equal(d.status, 'continue_assessment');
  assert.ok(d.reasons.includes(REASONS.MISSING_REQUIRED_INFORMATION));
  assert.equal(d.escalationPriority, null);
});

// ---- TEST 5: red flag -----------------------------------------------------

test('TEST 5 — a red flag blocks and escalates at the highest priority', () => {
  const d = gate.evaluate(baseCtx({
    redFlags: [{ name: 'TEST flag', severity: 'emergency', action: 'emergency_referral' }],
  }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes(REASONS.RED_FLAG_PRESENT));
  assert.equal(d.escalationPriority, 'urgent');
});

test('a red flag cannot be outweighed by perfect evidence and perfect confidence', () => {
  const d = gate.evaluate(baseCtx({
    clinicalConfidence: 1.0,
    evidence: goodEvidence({ source: { strength: 'authoritative_guideline' } }),
    redFlags: [{ name: 'TEST flag', severity: 'emergency', action: 'emergency_referral' }],
  }));
  assert.equal(d.status, 'blocked', 'nothing outranks a red flag');
});

// ---- TEST 6: exclusion ----------------------------------------------------

test('TEST 6 — a matching exclusion blocks the recommendation', () => {
  const facts = new Map([['is_pregnant', { concept: 'is_pregnant', value: 'true', status: 'active', value_number: null }]]);
  const d = gate.evaluate(baseCtx({
    factsByConcept: facts,
    recommendation: goodRecommendation({
      exclusion_conditions: { any_of: [{ concept: 'is_pregnant', equals: 'true' }] },
    }),
  }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes(REASONS.EXCLUSION_PRESENT));
  assert.equal(d.escalationPriority, 'high');
});

test('an exclusion that does not match does not block', () => {
  const facts = new Map([['is_pregnant', { concept: 'is_pregnant', value: 'false', status: 'active', value_number: null }]]);
  const d = gate.evaluate(baseCtx({
    factsByConcept: facts,
    recommendation: goodRecommendation({
      exclusion_conditions: { any_of: [{ concept: 'is_pregnant', equals: 'true' }] },
    }),
  }));
  assert.equal(d.status, 'eligible');
});

// ---- TEST 7: conflicting information -------------------------------------

test('TEST 7 — conflicting patient information forces review', () => {
  const d = gate.evaluate(baseCtx({
    conflicts: [{ concept: 'age_years', value: '40' }, { concept: 'age_years', value: '34' }],
  }));
  assert.equal(d.status, 'requires_review');
  assert.ok(d.reasons.includes(REASONS.CONFLICTING_INFORMATION));
});

// ---- TEST 8: multiple concerns -------------------------------------------

test('TEST 8 — several concerns at once escalate at the HIGHEST priority', () => {
  const d = gate.evaluate(baseCtx({
    missingRequired: [{ question_key: 'fever_duration' }],   // medium
    conflicts: [{ concept: 'age_years' }],                    // medium
    clinicalConfidence: 0.2,                                  // low
    redFlags: [{ name: 'TEST', severity: 'urgent', action: 'urgent_referral' }], // urgent
  }));
  assert.equal(d.escalationPriority, 'urgent', 'the most serious concern sets the priority');
  assert.ok(d.reasons.length >= 4, 'and every concern is still recorded, not just the worst');
});

// ---- eligibility / population --------------------------------------------

test('a patient outside the population the guidance covers is not eligible', () => {
  const facts = new Map([['age_years', { concept: 'age_years', value: '4', value_number: 4, status: 'active' }]]);
  const d = gate.evaluate(baseCtx({
    factsByConcept: facts,
    recommendation: goodRecommendation({ eligibility_conditions: { all_of: [{ concept: 'age_years', min: 12 }] } }),
  }));
  assert.equal(d.status, 'blocked');
  assert.ok(d.reasons.includes(REASONS.PATIENT_NOT_ELIGIBLE));
});

test('a conflicted fact cannot satisfy an eligibility condition', () => {
  const facts = new Map([['age_years', { concept: 'age_years', value: '40', value_number: 40, status: 'conflicted' }]]);
  const d = gate.evaluate(baseCtx({
    factsByConcept: facts,
    recommendation: goodRecommendation({ eligibility_conditions: { all_of: [{ concept: 'age_years', min: 12 }] } }),
  }));
  assert.ok(d.reasons.includes(REASONS.PATIENT_NOT_ELIGIBLE),
    'a disputed value must not be used as the basis for eligibility');
});

// ---- TEST 12: routine case does not page anyone --------------------------

test('TEST 12 — a routine eligible case does NOT notify the pharmacist', () => {
  const d = gate.evaluate(baseCtx());
  assert.equal(d.escalationPriority, null);
  assert.equal(d.status, 'eligible');
});

test('a recommendation outside autonomous scope always requires review, even when perfect', () => {
  const d = gate.evaluate(baseCtx({ recommendation: goodRecommendation({ autonomous_scope: false }) }));
  assert.equal(d.status, 'requires_review');
  assert.ok(d.reasons.includes(REASONS.OUTSIDE_AUTONOMOUS_SCOPE));
});

test('no configured recommendation is a quiet non-event, not an escalation', () => {
  const d = gate.evaluate(baseCtx({ recommendation: null }));
  assert.equal(d.status, 'not_applicable');
  assert.equal(d.escalationPriority, null,
    'a protocol with no approved guidance loaded must not page a pharmacist on every encounter');
});

// ---- THE CENTRAL SAFETY PROPERTY ------------------------------------------

test('confidence of 1.0 cannot rescue ANY structural failure', () => {
  const failures = {
    'missing evidence': { evidence: null },
    'unapproved source': { evidence: goodEvidence({ source: { status: 'draft' } }) },
    'weak evidence': {
      evidence: goodEvidence({ source: { strength: 'unverified' } }),
      recommendation: goodRecommendation({ min_evidence_strength: 'authoritative_guideline' }),
    },
    'missing information': { missingRequired: [{ question_key: 'x' }] },
    'conflicting information': { conflicts: [{ concept: 'age_years' }] },
    'red flag': { redFlags: [{ name: 'f', severity: 'urgent', action: 'urgent_referral' }] },
    'exclusion': {
      factsByConcept: new Map([['x', { concept: 'x', value: 'true', status: 'active', value_number: null }]]),
      recommendation: goodRecommendation({ exclusion_conditions: { any_of: [{ concept: 'x', equals: 'true' }] } }),
    },
  };
  for (const [label, override] of Object.entries(failures)) {
    const d = gate.evaluate(baseCtx({ ...override, clinicalConfidence: 1.0 }));
    assert.notEqual(d.status, 'eligible', `confidence 1.0 must not turn "${label}" into a pass`);
  }
});

test('evidence strength ordering is respected and unknown strengths fail closed', () => {
  assert.equal(gate.strengthMeets('authoritative_guideline', 'established_protocol'), true);
  assert.equal(gate.strengthMeets('unverified', 'established_protocol'), false);
  assert.equal(gate.strengthMeets('established_protocol', 'established_protocol'), true);
  assert.equal(gate.strengthMeets('not_a_real_strength', 'established_protocol'), false,
    'an unrecognised strength must not pass by default');
});

test('Nigerian guidance outranks generic international guidance at equal strength', () => {
  const ng = gate.ORIGIN_PRECEDENCE.indexOf('nigerian_guidance');
  const global = gate.ORIGIN_PRECEDENCE.indexOf('global_guidance');
  assert.ok(ng < global, 'guidance written for this population should be preferred');
});

// ---- TEST 9: traceability -------------------------------------------------

test('TEST 9 — the explanation is rendered from the trace and matches the decision', () => {
  const d = gate.evaluate(baseCtx());
  const text = gate.explain(d, { protocolSlug: 'fever_assessment', protocolVersion: '1.0.0' });

  assert.match(text, /RECOMMENDATION STATUS: ELIGIBLE/);
  assert.match(text, /PROTOCOL: fever_assessment v1\.0\.0/);
  assert.match(text, /EVIDENCE: test_source v1\.0 §4\.2/);
  assert.match(text, /EVIDENCE STRENGTH: AUTHORITATIVE_GUIDELINE/);
  assert.match(text, /RED FLAGS: NONE DETECTED/);
  assert.match(text, /DECISION: PASSED SAFETY GATE/);
});

test('a blocked decision never renders as passed', () => {
  const d = gate.evaluate(baseCtx({ evidence: null }));
  const text = gate.explain(d, { protocolSlug: 'fever_assessment', protocolVersion: '1.0.0' });
  assert.match(text, /DECISION: DID NOT PASS SAFETY GATE/);
  assert.match(text, /EVIDENCE: NONE/);
  assert.ok(!/PASSED SAFETY GATE$/m.test(text.replace(/DID NOT PASS SAFETY GATE/g, '')),
    'the explanation must not contradict the decision');
});

test('every trace entry names its check and outcome, so the decision is reconstructable', () => {
  const d = gate.evaluate(baseCtx({ missingRequired: [{ question_key: 'fever_duration' }] }));
  for (const entry of d.trace) {
    assert.ok(typeof entry.check === 'string' && entry.check.length > 0);
    assert.ok(typeof entry.passed === 'boolean');
    if (!entry.passed) assert.ok(entry.reason, 'a failed check must carry a machine-readable reason');
  }
  const missing = d.trace.find((t) => t.check === 'information_complete');
  assert.deepEqual(missing.missing, ['fever_duration'], 'and enough detail to say what was missing');
});

// ---- regression: the confidence check must not fail OPEN -----------------
//
// Found by the Part 3 security review. The check was `Number(value) < threshold`,
// and every comparison involving NaN is false — so NaN, Infinity, and any
// string (including a model returning "high" instead of 0.9) skipped the
// "below threshold" branch entirely and PASSED. Confidence is the one input
// an LLM most directly influences, which makes failing open here the worst
// place in the gate for it to happen.

test('a non-numeric confidence is refused, not read as a high one', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'high', '0.9', {}, [], true]) {
    const d = gate.evaluate(baseCtx({
      clinicalConfidence: bad,
      recommendation: { ...baseCtx().recommendation, min_clinical_confidence: 0 },
    }));
    assert.notEqual(d.status, 'eligible', `confidence ${String(bad)} must never pass the gate`);
    assert.ok(d.reasons.includes('confidence_unusable'), `and must say why for ${String(bad)}`);
  }
});

test('an out-of-range confidence is refused even though it exceeds the threshold', () => {
  const d = gate.evaluate(baseCtx({
    clinicalConfidence: 1.5,
    recommendation: { ...baseCtx().recommendation, min_clinical_confidence: 0.8 },
  }));
  assert.notEqual(d.status, 'eligible', '1.5 is not "very confident", it is a broken caller');
  assert.ok(d.reasons.includes('confidence_unusable'));
});

test('"no confidence supplied" is distinguishable from "confidence too low"', () => {
  const absent = gate.evaluate(baseCtx({ clinicalConfidence: null }));
  const low = gate.evaluate(baseCtx({
    clinicalConfidence: 0.2,
    recommendation: { ...baseCtx().recommendation, min_clinical_confidence: 0.8 },
  }));
  assert.ok(absent.reasons.includes('confidence_unusable'));
  assert.ok(low.reasons.includes('confidence_below_threshold'));
  assert.notDeepEqual(absent.reasons, low.reasons,
    'a broken caller and a genuinely uncertain reading must not look identical to a pharmacist');
});

test('valid confidence values across the whole legal range still behave', () => {
  const rec = { ...baseCtx().recommendation, min_clinical_confidence: 0.5 };
  assert.equal(gate.evaluate(baseCtx({ clinicalConfidence: 0.5, recommendation: rec })).status, 'eligible');
  assert.equal(gate.evaluate(baseCtx({ clinicalConfidence: 1, recommendation: rec })).status, 'eligible');
  assert.notEqual(gate.evaluate(baseCtx({ clinicalConfidence: 0.49, recommendation: rec })).status, 'eligible');
});
