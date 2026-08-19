/**
 * The summary a pharmacist reads instead of the conversation.
 *
 * THE STANDARD THIS HAS TO MEET (spec §8)
 * A pharmacist should understand why review was triggered without scrolling
 * back through the thread. So the briefing leads with the REASON, not with
 * the patient's opening line, and every clinical claim in it carries its
 * provenance — "38.5 (patient-reported)" rather than a bare number that
 * reads like a measurement.
 *
 * IMPORTANT NEGATIVES ARE INCLUDED DELIBERATELY. "No other symptoms
 * reported" is clinically load-bearing information, and a summary that only
 * lists positives quietly loses it.
 *
 * Pure formatting. Every value here comes from the evaluation and the
 * collected facts; nothing is inferred, and no clinical judgement is added.
 */

const gate = require('./safetyGate');

const PRIORITY_LABEL = Object.freeze({
  urgent: 'URGENT', high: 'HIGH', medium: 'MEDIUM', low: 'LOW',
});

/** Why a pharmacist is being asked to look, in plain words, derived from reason codes. */
const REASON_LABEL = Object.freeze({
  [gate.REASONS.RED_FLAG_PRESENT]: 'A configured red flag is present',
  [gate.REASONS.EXCLUSION_PRESENT]: 'A safety exclusion applies to this patient',
  [gate.REASONS.PATIENT_NOT_ELIGIBLE]: 'Patient does not match the population the guidance covers',
  [gate.REASONS.CONFLICTING_INFORMATION]: 'The patient has given conflicting information',
  [gate.REASONS.MISSING_REQUIRED_INFORMATION]: 'Required clinical information is still missing',
  [gate.REASONS.EVIDENCE_BELOW_REQUIRED_STRENGTH]: 'Supporting evidence is weaker than this recommendation requires',
  [gate.REASONS.EVIDENCE_SOURCE_NOT_APPROVED]: 'The cited source has not been approved for use',
  [gate.REASONS.MISSING_EVIDENCE_REFERENCE]: 'No approved evidence supports this recommendation',
  [gate.REASONS.CONFIDENCE_BELOW_THRESHOLD]: 'Interpretation confidence is below the configured threshold',
  [gate.REASONS.OUTSIDE_AUTONOMOUS_SCOPE]: 'This recommendation always requires pharmacist review',
  [gate.REASONS.PROTOCOL_NOT_ACTIVE]: 'The protocol version is not active',
  [gate.REASONS.RECOMMENDATION_NOT_ACTIVE]: 'The recommendation rule is not active',
  [gate.REASONS.NO_RECOMMENDATION_CONFIGURED]: 'No recommendation is configured for this protocol',
  // Not a safetyGate reason — clinicalWorkflow's own three-strikes guard,
  // same fallback shape as 'conflicting_information'. Plain-string key
  // rather than a gate.REASONS symbol because this never reaches the gate:
  // it fires while still collecting information, before there is anything
  // to evaluate.
  stuck_on_question: 'Patient could not get a required question to register after repeated tries',
});

/** Facts a patient answered as "no" / "none" — the important negatives. */
function importantNegatives(facts) {
  return facts.filter((f) => f.status === 'active'
    && (f.value === 'false' || f.value === 'none' || f.value === 'no'));
}

function formatFact(f) {
  const SOURCE_LABEL = {
    patient_reported: 'patient-reported',
    pharmacist_reported: 'pharmacist-recorded',
    measured: 'measured',
    system_derived: 'system-derived',
    ai_extracted: 'AI-extracted',
    profile_reused: 'from profile',
    unknown: 'source unknown',
  };
  const unit = f.unit ? ` ${f.unit}` : '';
  const flag = f.status === 'conflicted' ? '  ⚠ CONFLICT' : '';
  return `  - ${f.concept}: ${f.value}${unit} (${SOURCE_LABEL[f.source] || f.source})${flag}`;
}

/**
 * @param {object} args
 * @param {object} args.decision      from safetyGate.evaluate
 * @param {object} args.executionState from protocolExecutionService
 * @param {object} [args.recommendation]
 * @param {object} [args.evidence]
 * @param {object} [args.patient]     {displayName, ageYears, sex}
 */
function buildBriefing({ decision, executionState, recommendation = null, evidence = null, patient = {} }) {
  const facts = executionState.facts.filter((f) => f.status !== 'superseded');
  const byConcept = executionState.factsByConcept;
  const lines = [];

  // Lead with WHY, at the top, before anything else.
  const priority = decision.escalationPriority;
  lines.push(`PHARMACIST REVIEW — ${priority ? PRIORITY_LABEL[priority] : 'INFORMATION'}`);
  lines.push('');
  lines.push('WHY THIS NEEDS YOU:');
  if (decision.reasons.length === 0) {
    lines.push('  - No blocking reason. Recommendation passed the safety gate.');
  } else {
    for (const r of decision.reasons) lines.push(`  - ${REASON_LABEL[r] || r}`);
  }
  lines.push('');

  // Patient context.
  const bits = [];
  if (patient.displayName) bits.push(patient.displayName);
  const age = byConcept.get('age_years');
  if (age) bits.push(`${age.value} years`);
  const sex = byConcept.get('sex');
  if (sex) bits.push(sex.value);
  lines.push(`PATIENT: ${bits.length ? bits.join(', ') : 'not recorded'}`);

  const complaint = byConcept.get('presenting_complaint');
  lines.push(`PRESENTING COMPLAINT: ${complaint ? complaint.value : 'not recorded'}`);

  const duration = byConcept.get('symptom_duration_days');
  if (duration) lines.push(`DURATION: ${duration.value} days (${duration.status === 'unknown' ? 'patient unsure' : 'patient-reported'})`);
  lines.push('');

  // Everything collected, with provenance.
  lines.push('COLLECTED CLINICAL FACTS:');
  const positives = facts.filter((f) => !importantNegatives(facts).includes(f));
  if (positives.length === 0) lines.push('  (none recorded)');
  for (const f of positives) lines.push(formatFact(f));

  const negatives = importantNegatives(facts);
  if (negatives.length) {
    lines.push('');
    lines.push('IMPORTANT NEGATIVES:');
    for (const f of negatives) lines.push(formatFact(f));
  }

  // Conflicts get their own block — they are the thing most likely to
  // change a pharmacist's reading, and must not be buried in the list.
  if (executionState.conflicts.length) {
    lines.push('');
    lines.push('CONFLICTING INFORMATION (unresolved):');
    for (const c of executionState.conflicts) {
      lines.push(`  - ${c.concept}: "${c.value}" (${c.source})`);
    }
  }

  const redFlagStep = decision.trace.find((t) => t.check === 'no_red_flags');
  lines.push('');
  lines.push(`RED FLAGS: ${redFlagStep && !redFlagStep.passed
    ? (redFlagStep.flags || []).map((f) => `${f.name} [${f.severity} -> ${f.action}]`).join('; ')
    : 'none detected'}`);

  if (executionState.missingRequired.length) {
    lines.push('');
    lines.push('MISSING INFORMATION:');
    for (const q of executionState.missingRequired) lines.push(`  - ${q.question_key}: ${q.text}`);
  }

  lines.push('');
  lines.push(`PROTOCOL: ${executionState.protocolSlug} v${executionState.protocolVersion}`);

  if (recommendation) {
    lines.push('');
    lines.push('RECOMMENDATION CONSIDERED:');
    lines.push(`  ${recommendation.recommendation_key} (${recommendation.recommendation_type})`);
    lines.push(`  "${recommendation.recommendation_text}"`);
    lines.push(`  OUTCOME: ${decision.status.toUpperCase()}`);
  } else {
    lines.push('');
    lines.push('RECOMMENDATION CONSIDERED: none configured');
  }

  if (evidence?.source) {
    lines.push('');
    lines.push('EVIDENCE:');
    lines.push(`  ${evidence.source.title} v${evidence.source.version} §${evidence.reference.section}`);
    lines.push(`  origin: ${evidence.source.origin} | strength: ${evidence.source.strength} | status: ${evidence.source.status}`);
  }

  lines.push('');
  lines.push(`INTERPRETATION CONFIDENCE: ${decision.clinicalConfidence ?? 'not assessed'}`);

  return lines.join('\n');
}

module.exports = { buildBriefing, REASON_LABEL, importantNegatives };
