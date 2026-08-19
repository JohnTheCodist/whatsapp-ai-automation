/**
 * The deterministic recommendation gate.
 *
 * PURE. No database, no clock, no model. Everything it needs is passed in,
 * so the same inputs always produce the same decision — which is what makes
 * a clinical safety decision testable and auditable at all. If this file
 * ever needs an `await`, something has gone wrong with the design.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE
 * AI confidence is an INPUT, never an override. It is checked LAST, and it
 * can only ever subtract. There is no arrangement of confidence values that
 * turns a missing red-flag check, an absent evidence reference, or an unmet
 * exclusion into a pass — because confidence is not consulted until every
 * structural check has already passed. High confidence plus no evidence is
 * not a recommendation; it is a model being confident about nothing.
 *
 * THE EXPLANATION IS THE EVALUATION
 * evaluate() returns a `trace`: every check, in order, with its inputs and
 * outcome. explain() renders that array and nothing else. There is no
 * second code path that composes a narrative, so an explanation that
 * disagrees with the decision is not a bug this system can have (spec §9).
 *
 * NO CLINICAL KNOWLEDGE LIVES HERE. This file cannot tell you what a fever
 * is. It evaluates configured conditions against collected facts. Every
 * clinical judgement it appears to make was authored by a person in
 * protocol_recommendations and evidence_sources.
 */

/**
 * Evidence hierarchy, strongest first. Configurable per spec §3 — pass a
 * different array as `strengthRank` to reorder without touching this file.
 */
const STRENGTH_RANK = Object.freeze([
  'authoritative_guideline',
  'regulatory_source',
  'local_clinical_guideline',
  'established_protocol',
  'trusted_reference',
  'secondary_reference',
  'unverified',
]);

/**
 * Origin precedence, most locally-applicable first.
 *
 * Nigerian guidance outranks generic international guidance (spec §10) —
 * not because it is inherently better evidence, but because it is written
 * for the population actually being served, including local resistance
 * patterns and what is actually available in a Nigerian pharmacy. Used to
 * choose BETWEEN competing sources; it never rescues a source that failed
 * the strength check.
 */
const ORIGIN_PRECEDENCE = Object.freeze([
  'nigerian_guidance',
  'regulatory_source',
  'institutional_protocol',
  'local_protocol',
  'global_guidance',
  'other_approved_source',
]);

const PRIORITY = Object.freeze({ low: 1, medium: 2, high: 3, urgent: 4 });

/** Stable, queryable reason codes. Never prose — prose is rendered from these. */
const REASONS = Object.freeze({
  NO_RECOMMENDATION_CONFIGURED: 'no_recommendation_configured',
  PROTOCOL_NOT_ACTIVE: 'protocol_not_active',
  RECOMMENDATION_NOT_ACTIVE: 'recommendation_not_active',
  MISSING_EVIDENCE_REFERENCE: 'missing_evidence_reference',
  EVIDENCE_SOURCE_NOT_APPROVED: 'evidence_source_not_approved',
  EVIDENCE_BELOW_REQUIRED_STRENGTH: 'evidence_below_required_strength',
  MISSING_REQUIRED_INFORMATION: 'missing_required_information',
  CONFLICTING_INFORMATION: 'conflicting_information',
  PATIENT_NOT_ELIGIBLE: 'patient_not_eligible',
  RED_FLAG_PRESENT: 'red_flag_present',
  EXCLUSION_PRESENT: 'exclusion_present',
  CONFIDENCE_BELOW_THRESHOLD: 'confidence_below_threshold',
  // Distinct from BELOW_THRESHOLD on purpose: "the model was 0.4 sure" and
  // "the model returned something that is not a confidence" are different
  // failures, and a pharmacist reading the reason should be able to tell
  // them apart — the second points at a broken caller, not a hard case.
  CONFIDENCE_UNUSABLE: 'confidence_unusable',
  OUTSIDE_AUTONOMOUS_SCOPE: 'outside_autonomous_scope',
  EVIDENCE_STATUS_INSUFFICIENT: 'evidence_status_insufficient',
  EVIDENCE_CONFLICTING: 'evidence_conflicting',
  PATIENT_REQUESTED_PHARMACIST: 'patient_requested_pharmacist',
});

/**
 * How well the cited evidence supports THIS recommendation (§4). Distinct
 * from a SOURCE's `strength`, which describes the document's authority —
 * a strong document can still only weakly support a particular claim.
 */
const EVIDENCE_STATUS = Object.freeze({
  STRONGLY_SUPPORTED: 'strongly_supported',
  SUPPORTED: 'supported',
  LIMITED_SUPPORT: 'limited_support',
  NOT_SUPPORTED: 'not_supported',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
});

/** Only these two may normally produce direct patient-facing guidance (§4). */
const GUIDANCE_CAPABLE = new Set([EVIDENCE_STATUS.STRONGLY_SUPPORTED, EVIDENCE_STATUS.SUPPORTED]);

/** These can never yield a treatment recommendation (§4). */
const GUIDANCE_FORBIDDEN = new Set([
  EVIDENCE_STATUS.NOT_SUPPORTED, EVIDENCE_STATUS.CONFLICTING, EVIDENCE_STATUS.UNKNOWN,
]);

const LEVELS = Object.freeze({
  GUIDELINE_SUPPORTED: 'level_1_guideline_supported',
  UNCERTAIN: 'level_2_uncertain',
  HIGH_RISK: 'level_3_high_risk',
});

/**
 * Reasons that mean "we have not finished asking", NOT "a human is needed".
 *
 * §7 is explicit that a pharmacist must not be paged merely because the
 * assistant cannot yet answer confidently. These reasons therefore carry NO
 * escalation priority: they route to LEVEL 2, which asks another question.
 *
 * Confidence sits here deliberately. §3 makes it a supplementary uncertainty
 * signal, never a clinical authority — and something that cannot authorise a
 * recommendation should not be able to summon a pharmacist either.
 */
const ASK_DO_NOT_ESCALATE = new Set([
  REASONS.MISSING_REQUIRED_INFORMATION,
  REASONS.CONFIDENCE_BELOW_THRESHOLD,
  REASONS.CONFIDENCE_UNUSABLE,
]);

/**
 * How serious is each failure? Drives escalation priority. When several
 * apply at once the HIGHEST wins (spec §13 test 8) — a red flag alongside
 * missing information is an urgent case, not a medium one.
 */
const REASON_PRIORITY = Object.freeze({
  [REASONS.RED_FLAG_PRESENT]: 'urgent',
  [REASONS.EXCLUSION_PRESENT]: 'high',
  [REASONS.PATIENT_NOT_ELIGIBLE]: 'medium',
  [REASONS.CONFLICTING_INFORMATION]: 'medium',
  [REASONS.EVIDENCE_BELOW_REQUIRED_STRENGTH]: 'medium',
  [REASONS.EVIDENCE_SOURCE_NOT_APPROVED]: 'medium',
  [REASONS.MISSING_EVIDENCE_REFERENCE]: 'medium',
  [REASONS.EVIDENCE_STATUS_INSUFFICIENT]: 'medium',
  [REASONS.EVIDENCE_CONFLICTING]: 'medium',
  [REASONS.PATIENT_REQUESTED_PHARMACIST]: 'medium',
  [REASONS.OUTSIDE_AUTONOMOUS_SCOPE]: 'low',
  [REASONS.RECOMMENDATION_NOT_ACTIVE]: 'low',
  [REASONS.PROTOCOL_NOT_ACTIVE]: 'medium',
  [REASONS.NO_RECOMMENDATION_CONFIGURED]: 'low',
  // MISSING_REQUIRED_INFORMATION and the CONFIDENCE_* reasons are deliberately
  // ABSENT — they live in ASK_DO_NOT_ESCALATE and carry no priority at all.
  // They previously sat here at 'medium'/'low', which meant every unfinished
  // assessment paged a pharmacist. See ASK_DO_NOT_ESCALATE for why that is
  // now Level 2 instead.
});

/** Failures that mean "never deliver this", vs "a human should look". */
const HARD_BLOCKS = new Set([
  REASONS.RED_FLAG_PRESENT,
  REASONS.EXCLUSION_PRESENT,
  REASONS.PATIENT_NOT_ELIGIBLE,
  REASONS.MISSING_EVIDENCE_REFERENCE,
  REASONS.EVIDENCE_SOURCE_NOT_APPROVED,
  REASONS.EVIDENCE_BELOW_REQUIRED_STRENGTH,
  // §4: not_supported / conflicting / unknown must never yield a treatment
  // recommendation. Hard blocks, not judgement calls.
  REASONS.EVIDENCE_STATUS_INSUFFICIENT,
  REASONS.EVIDENCE_CONFLICTING,
]);

function strengthMeets(actual, required, rank = STRENGTH_RANK) {
  const a = rank.indexOf(actual);
  const r = rank.indexOf(required);
  // An unranked strength is not "good enough by default" — unknown evidence
  // standing fails, it does not pass silently.
  if (a === -1 || r === -1) return false;
  return a <= r;
}

/**
 * Evaluate a closed condition vocabulary against collected facts.
 * Identical in spirit to protocolExecutionService.isApplicable, and equally
 * closed: an operator this function does not recognise makes the clause
 * FALSE rather than throwing or assuming.
 */
function clauseHolds(clause, factsByConcept) {
  if (!clause || typeof clause !== 'object' || !clause.concept) return false;
  const fact = factsByConcept.get(clause.concept);
  if (!fact) return false;
  if (fact.status !== 'active') return false;

  if ('equals' in clause) return String(fact.value) === String(clause.equals);
  if ('not_equals' in clause) return String(fact.value) !== String(clause.not_equals);
  if ('min' in clause) return fact.value_number !== null && Number(fact.value_number) >= clause.min;
  if ('max' in clause) return fact.value_number !== null && Number(fact.value_number) <= clause.max;
  if ('includes' in clause) return String(fact.value).split(',').includes(String(clause.includes));
  if ('exists' in clause) return clause.exists === true;
  return false;
}

function conditionsHold(conditions, factsByConcept) {
  if (!conditions || Object.keys(conditions).length === 0) return true;
  if (Array.isArray(conditions.all_of)) return conditions.all_of.every((c) => clauseHolds(c, factsByConcept));
  if (Array.isArray(conditions.any_of)) return conditions.any_of.some((c) => clauseHolds(c, factsByConcept));
  return false;
}

/** Do any exclusion conditions fire? Empty exclusions never fire. */
function anyExclusionHolds(conditions, factsByConcept) {
  if (!conditions || Object.keys(conditions).length === 0) return false;
  if (Array.isArray(conditions.any_of)) return conditions.any_of.some((c) => clauseHolds(c, factsByConcept));
  if (Array.isArray(conditions.all_of)) return conditions.all_of.every((c) => clauseHolds(c, factsByConcept));
  return false;
}

/**
 * Run the gate.
 *
 * @param {object} ctx
 * @param {object|null} ctx.recommendation  the configured rule, or null
 * @param {object|null} ctx.evidence        {source, reference} or null
 * @param {Map} ctx.factsByConcept          concept -> fact row
 * @param {object[]} ctx.missingRequired    unanswered required questions
 * @param {object[]} ctx.conflicts          conflicted facts
 * @param {object[]} ctx.redFlags           ACTIVE red-flag rules that fired
 * @param {number|null} ctx.clinicalConfidence
 * @param {object} [ctx.protocol]           {status}
 * @returns {{status, safetyStatus, escalationPriority, reasons, trace}}
 */
function evaluate(ctx = {}) {
  const {
    recommendation = null, evidence = null, factsByConcept = new Map(),
    missingRequired = [], conflicts = [], redFlags = [],
    clinicalConfidence = null, protocol = null,
    strengthRank = STRENGTH_RANK,
    patientRequestedPharmacist = false,
  } = ctx;

  const trace = [];
  const reasons = [];
  const step = (check, passed, detail = {}) => {
    trace.push({ check, passed, ...detail });
    return passed;
  };
  const fail = (check, reason, detail = {}) => {
    trace.push({ check, passed: false, reason, ...detail });
    reasons.push(reason);
  };

  // ---- 0. is there anything to evaluate at all? ----
  if (!recommendation) {
    fail('recommendation_configured', REASONS.NO_RECOMMENDATION_CONFIGURED);
    return finalise('not_applicable', reasons, trace, { clinicalConfidence });
  }
  step('recommendation_configured', true, { recommendationKey: recommendation.recommendation_key });

  // ---- 1. protocol active and versioned ----
  if (protocol && protocol.status !== 'active') {
    fail('protocol_active', REASONS.PROTOCOL_NOT_ACTIVE, { protocolStatus: protocol.status });
  } else {
    step('protocol_active', true);
  }
  if (recommendation.status !== 'active') {
    fail('recommendation_active', REASONS.RECOMMENDATION_NOT_ACTIVE, { status: recommendation.status });
  } else {
    step('recommendation_active', true);
  }

  // ---- 2. evidence: exists, approved, strong enough ----
  //
  // Checked BEFORE anything about the patient. A recommendation with no
  // approved source is not a close call to be weighed against how well the
  // patient matches — it is not a recommendation at all.
  if (!evidence || !evidence.reference || !evidence.source) {
    fail('evidence_present', REASONS.MISSING_EVIDENCE_REFERENCE);
  } else {
    step('evidence_present', true, {
      sourceKey: evidence.source.source_key,
      sourceVersion: evidence.source.version,
      section: evidence.reference.section,
      origin: evidence.source.origin,
    });

    if (evidence.source.status !== 'active') {
      fail('evidence_approved', REASONS.EVIDENCE_SOURCE_NOT_APPROVED, { sourceStatus: evidence.source.status });
    } else {
      step('evidence_approved', true);
    }

    const required = recommendation.min_evidence_strength;
    if (!strengthMeets(evidence.source.strength, required, strengthRank)) {
      fail('evidence_strength', REASONS.EVIDENCE_BELOW_REQUIRED_STRENGTH, {
        actual: evidence.source.strength, required,
      });
    } else {
      step('evidence_strength', true, { actual: evidence.source.strength, required });
    }
  }

  // ---- 3. is the patient's information complete and coherent? ----
  if (missingRequired.length > 0) {
    fail('information_complete', REASONS.MISSING_REQUIRED_INFORMATION, {
      missing: missingRequired.map((q) => q.question_key || q),
    });
  } else {
    step('information_complete', true);
  }

  if (conflicts.length > 0) {
    fail('information_coherent', REASONS.CONFLICTING_INFORMATION, {
      concepts: [...new Set(conflicts.map((c) => c.concept))],
    });
  } else {
    step('information_coherent', true);
  }

  // ---- 4. does this patient match who the guidance is for? ----
  if (!conditionsHold(recommendation.eligibility_conditions, factsByConcept)) {
    fail('patient_eligible', REASONS.PATIENT_NOT_ELIGIBLE, {
      conditions: recommendation.eligibility_conditions,
    });
  } else {
    step('patient_eligible', true);
  }

  // ---- 5. red flags ----
  //
  // Cannot be outweighed. A red flag does not lower a score to be balanced
  // against strong evidence — it ends the evaluation's eligibility outright,
  // at the highest escalation priority.
  if (redFlags.length > 0) {
    fail('no_red_flags', REASONS.RED_FLAG_PRESENT, {
      flags: redFlags.map((f) => ({ name: f.name, severity: f.severity, action: f.action })),
    });
  } else {
    step('no_red_flags', true);
  }

  // ---- 6. exclusions / contraindications ----
  if (anyExclusionHolds(recommendation.exclusion_conditions, factsByConcept)) {
    fail('no_exclusions', REASONS.EXCLUSION_PRESENT, {
      conditions: recommendation.exclusion_conditions,
    });
  } else {
    step('no_exclusions', true);
  }

  // ---- 7. confidence — LAST, and only ever subtractive ----
  //
  // Everything structural has already been decided. Confidence cannot
  // rescue any failure above; it can only add one of its own.
  const threshold = Number(recommendation.min_clinical_confidence ?? 0.8);

  // VALIDATE BEFORE COMPARING, because `<` fails OPEN on anything non-numeric.
  // Every comparison involving NaN is false, so a bare `value < threshold`
  // test silently PASSES for NaN, Infinity, and any string — including the
  // very plausible case of a model returning "high" instead of 0.9. An
  // unusable confidence value is not a high one; it means confidence was
  // never established, which is a review, not a pass.
  const isUsableConfidence = typeof clinicalConfidence === 'number'
    && Number.isFinite(clinicalConfidence)
    && clinicalConfidence >= 0
    && clinicalConfidence <= 1;

  if (!isUsableConfidence) {
    fail('confidence_threshold', REASONS.CONFIDENCE_UNUSABLE, {
      actual: clinicalConfidence === null ? null : String(clinicalConfidence),
      required: threshold,
      detail: clinicalConfidence === null || clinicalConfidence === undefined
        ? 'no confidence supplied'
        : 'confidence must be a number between 0 and 1',
    });
  } else if (clinicalConfidence < threshold) {
    fail('confidence_threshold', REASONS.CONFIDENCE_BELOW_THRESHOLD, {
      actual: clinicalConfidence, required: threshold,
    });
  } else {
    step('confidence_threshold', true, { actual: clinicalConfidence, required: threshold });
  }

  // ---- 8. is this recommendation allowed to go out unsupervised? ----
  if (!recommendation.autonomous_scope) {
    fail('autonomous_scope', REASONS.OUTSIDE_AUTONOMOUS_SCOPE);
  } else {
    step('autonomous_scope', true);
  }

  // ---- 9. does the evidence actually SUPPORT this claim? (§4) ----
  //
  // Separate from step 2, which asked whether the source is authoritative and
  // approved. This asks whether that source supports THIS recommendation.
  // A strong document can still only weakly support a particular statement.
  const evStatus = recommendation.evidence_status || EVIDENCE_STATUS.UNKNOWN;
  if (evStatus === EVIDENCE_STATUS.CONFLICTING) {
    // Its own reason code: "the sources disagree" is a different situation
    // from "the evidence is weak", and §10 requires it be preserved and
    // explained rather than silently resolved in one source's favour.
    fail('evidence_status', REASONS.EVIDENCE_CONFLICTING, { evidenceStatus: evStatus });
  } else if (GUIDANCE_FORBIDDEN.has(evStatus)) {
    fail('evidence_status', REASONS.EVIDENCE_STATUS_INSUFFICIENT, { evidenceStatus: evStatus });
  } else if (evStatus === EVIDENCE_STATUS.LIMITED_SUPPORT) {
    // Not a hard block: §4 says LIMITED_SUPPORT "may require cautious
    // communication or review depending on the protocol". It costs the
    // recommendation its Level 1 status without forbidding it outright.
    fail('evidence_status', REASONS.EVIDENCE_STATUS_INSUFFICIENT, { evidenceStatus: evStatus, limited: true });
  } else {
    step('evidence_status', true, { evidenceStatus: evStatus });
  }

  // ---- 10. did the patient ask for a human? (§7) ----
  //
  // Last, and unconditional. Someone who asks for a pharmacist gets one,
  // regardless of how well the evidence supports whatever they were about to
  // be told. This is the one gate input that is not a clinical judgement.
  if (patientRequestedPharmacist) {
    fail('patient_did_not_request_pharmacist', REASONS.PATIENT_REQUESTED_PHARMACIST);
  } else {
    step('patient_did_not_request_pharmacist', true);
  }

  const level = deriveLevel(reasons);

  // `continue_assessment` requires that EVERY reason is one more question can
  // actually resolve. Keying this off the level was wrong: conflicting
  // information and out-of-scope recommendations are not high-risk, but no
  // further question fixes them either — a human has to adjudicate. Asking the
  // patient more questions about a contradiction they have already stated
  // would be a loop, not an assessment.
  const allAnswerable = reasons.every((r) => ASK_DO_NOT_ESCALATE.has(r));

  let status;
  if (reasons.length === 0) status = 'eligible';
  else if (reasons.some((r) => HARD_BLOCKS.has(r))) status = 'blocked';
  else if (allAnswerable) status = 'continue_assessment';
  else status = 'requires_review';

  return finalise(status, reasons, trace, { clinicalConfidence, level, evidenceStatus: evStatus });
}

/**
 * Which of the three levels does this outcome sit at? (§1)
 *
 * LEVEL 3 when anything demands a human: a hard block, or an explicit request.
 * LEVEL 1 only when nothing failed at all.
 * LEVEL 2 for everything in between — the "ask another question" space.
 */
function deriveLevel(reasons) {
  if (reasons.length === 0) return LEVELS.GUIDELINE_SUPPORTED;
  if (reasons.some((r) => HARD_BLOCKS.has(r) || r === REASONS.PATIENT_REQUESTED_PHARMACIST)) {
    return LEVELS.HIGH_RISK;
  }
  // Everything remaining is uncertainty, not danger. If EVERY reason is an
  // ask-reason this is plainly Level 2; a mix of ask-reasons and softer
  // failures (outside autonomous scope, inactive rule) is still Level 2,
  // because none of them is a safety event.
  return LEVELS.UNCERTAIN;
}

function finalise(status, reasons, trace, { clinicalConfidence, level = null, evidenceStatus = null }) {
  let escalationPriority = null;
  for (const r of reasons) {
    // Ask-reasons carry no priority by construction (they are absent from
    // REASON_PRIORITY), so an unfinished assessment cannot page anyone. Guarded
    // explicitly as well, so adding one back to REASON_PRIORITY by mistake
    // does not quietly restore the alert flood.
    if (ASK_DO_NOT_ESCALATE.has(r)) continue;
    const p = REASON_PRIORITY[r];
    if (!p) continue;
    if (!escalationPriority || PRIORITY[p] > PRIORITY[escalationPriority]) escalationPriority = p;
  }

  // "no recommendation configured" is not a safety event and must not page
  // anyone — it is the ordinary state of a protocol with no approved
  // guidance loaded, which is where every protocol starts.
  if (status === 'not_applicable' && reasons.length === 1
      && reasons[0] === REASONS.NO_RECOMMENDATION_CONFIGURED) {
    escalationPriority = null;
  }

  const safetyStatus = status === 'eligible' ? 'passed'
    : (status === 'blocked' ? 'blocked' : 'review_required');

  return {
    status, safetyStatus, escalationPriority, reasons, trace, clinicalConfidence,
    level: level || deriveLevel(reasons),
    evidenceStatus,
  };
}

/**
 * Render the decision for a human. Reads ONLY the trace — see this file's
 * header on why there is no second narrative path.
 */
function explain(decision, { protocolSlug, protocolVersion } = {}) {
  const lines = [];
  lines.push(`RECOMMENDATION STATUS: ${decision.status.toUpperCase()}`);
  if (protocolSlug) lines.push(`PROTOCOL: ${protocolSlug} v${protocolVersion}`);

  const ev = decision.trace.find((t) => t.check === 'evidence_present' && t.passed);
  if (ev) {
    lines.push(`EVIDENCE: ${ev.sourceKey} v${ev.sourceVersion} §${ev.section} (${ev.origin})`);
  } else {
    lines.push('EVIDENCE: NONE');
  }
  const strength = decision.trace.find((t) => t.check === 'evidence_strength');
  if (strength) {
    lines.push(`EVIDENCE STRENGTH: ${String(strength.actual || 'unknown').toUpperCase()}`
      + (strength.passed ? '' : ` (below required ${strength.required})`));
  }

  for (const [check, label] of [
    ['patient_eligible', 'PATIENT ELIGIBILITY'],
    ['no_red_flags', 'RED FLAGS'],
    ['no_exclusions', 'EXCLUSIONS'],
    ['information_complete', 'REQUIRED INFORMATION'],
    ['information_coherent', 'INFORMATION COHERENCE'],
  ]) {
    const t = decision.trace.find((x) => x.check === check);
    if (!t) continue;
    if (check === 'no_red_flags') {
      lines.push(`${label}: ${t.passed ? 'NONE DETECTED' : (t.flags || []).map((f) => f.name).join(', ')}`);
    } else if (check === 'no_exclusions') {
      lines.push(`${label}: ${t.passed ? 'NONE DETECTED' : 'PRESENT'}`);
    } else if (check === 'information_complete') {
      lines.push(`${label}: ${t.passed ? 'COMPLETE' : `MISSING (${(t.missing || []).join(', ')})`}`);
    } else if (check === 'information_coherent') {
      lines.push(`${label}: ${t.passed ? 'CONSISTENT' : `CONFLICTS (${(t.concepts || []).join(', ')})`}`);
    } else {
      lines.push(`${label}: ${t.passed ? 'MATCHED' : 'NOT MATCHED'}`);
    }
  }

  lines.push(`CLINICAL CONFIDENCE: ${decision.clinicalConfidence ?? 'not assessed'}`);
  lines.push(`DECISION: ${decision.status === 'eligible' ? 'PASSED SAFETY GATE' : 'DID NOT PASS SAFETY GATE'}`);
  if (decision.reasons.length) lines.push(`REASONS: ${decision.reasons.join(', ')}`);
  if (decision.escalationPriority) lines.push(`ESCALATION PRIORITY: ${decision.escalationPriority.toUpperCase()}`);

  return lines.join('\n');
}

module.exports = {
  evaluate, explain,
  STRENGTH_RANK, ORIGIN_PRECEDENCE, REASONS, REASON_PRIORITY, HARD_BLOCKS, PRIORITY,
  EVIDENCE_STATUS, GUIDANCE_CAPABLE, GUIDANCE_FORBIDDEN, LEVELS, ASK_DO_NOT_ESCALATE, deriveLevel,
  strengthMeets, conditionsHold, anyExclusionHolds, clauseHolds,
};
