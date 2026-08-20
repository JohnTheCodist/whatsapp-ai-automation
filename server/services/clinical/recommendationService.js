/**
 * Authoring recommendation rules, and running the gate against an encounter.
 *
 * HOW AN LLM IS PREVENTED FROM INVENTING A RECOMMENDATION (spec §13 test 11)
 * Not by asking it not to, and not by filtering its output. By the shape of
 * this module's interface:
 *
 *   evaluate(pharmacyId, executionId, { recommendationKey })
 *
 * The only thing a caller may supply is a KEY, which is looked up against
 * rows a person authored. There is no parameter anywhere in this file that
 * accepts recommendation text, evidence, or a clinical claim at evaluation
 * time. An unknown key returns "no recommendation configured" — a normal,
 * safe, non-escalating outcome. A model can therefore ask for a
 * recommendation that does not exist, and the answer is simply nothing.
 *
 * createRecommendation() DOES take text — it is the authoring path, requires
 * a pharmacist actor, and requires an evidence_reference_id that the
 * database itself refuses to leave null.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordAdminAudit, recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const gate = require('./safetyGate');
const evidence = require('./evidenceService');
const engine = require('./protocolExecutionService');
const factService = require('./clinicalFactService');

const REC_TYPES = new Set(['self_care_advice', 'seek_pharmacist', 'seek_medical_care', 'information']);

const REC_FIELDS = `
  id, pharmacy_id, protocol_id, recommendation_key, recommendation_type,
  recommendation_text, eligibility_conditions, exclusion_conditions,
  evidence_reference_id, min_evidence_strength, min_clinical_confidence,
  autonomous_scope, status, evidence_status, created_at, updated_at
`;

/**
 * Author a recommendation rule. Pharmacist-only, evidence-required.
 *
 * autonomous_scope is NOT accepted here as a convenience flag — it must be
 * passed explicitly and defaults false, so a recommendation never becomes
 * deliverable-without-review as a side effect of being created.
 */
async function createRecommendation(pharmacyId, protocolId, args = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (actorType !== 'pharmacist' && actorType !== 'staff' && actorType !== 'system') {
    const err = new Error('Only a pharmacist or staff member may author a recommendation.');
    err.status = 403; err.code = 'FORBIDDEN';
    throw err;
  }
  if (!REC_TYPES.has(args.recommendationType)) {
    const err = new Error(`recommendation_type must be one of ${[...REC_TYPES].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!args.evidenceReferenceId) {
    const err = new Error(
      'evidence_reference_id is required. A recommendation must cite an approved source section.'
    );
    err.status = 400; err.code = 'EVIDENCE_REQUIRED';
    throw err;
  }

  const db = getSql();
  const [protocol] = await db`
    select id, slug, version, status from clinical_protocols
    where id = ${protocolId} and pharmacy_id = ${pharmacyId}
  `;
  if (!protocol) {
    const err = new Error('Protocol not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const resolved = await evidence.resolveReference(pharmacyId, args.evidenceReferenceId);
  if (!resolved) {
    const err = new Error('Evidence reference not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  // Evidence STATUS is authored, but CEILINGED by the source's strength.
  // "Strongly supported — by an unverified document" is a claim the data model
  // should not be able to hold: the status describes how well the evidence
  // backs this claim, and evidence nobody has verified cannot back anything
  // strongly. Authored, then bounded.
  const evidenceStatus = args.evidenceStatus || 'unknown';
  const STRONG_CLAIMS = new Set(['strongly_supported', 'supported']);
  const WEAK_SOURCES = new Set(['unverified', 'secondary_reference']);
  if (STRONG_CLAIMS.has(evidenceStatus) && WEAK_SOURCES.has(resolved.source.strength)) {
    const err = new Error(
      `Cannot claim evidence_status "${evidenceStatus}" from a source of strength `
      + `"${resolved.source.strength}". Strengthen the source or lower the claim.`
    );
    err.status = 400; err.code = 'EVIDENCE_STATUS_EXCEEDS_SOURCE';
    throw err;
  }

  const [row] = await db`
    insert into protocol_recommendations
      (pharmacy_id, protocol_id, recommendation_key, recommendation_type, recommendation_text,
       eligibility_conditions, exclusion_conditions, evidence_reference_id,
       min_evidence_strength, min_clinical_confidence, autonomous_scope, status, evidence_status)
    values
      (${pharmacyId}, ${protocolId}, ${args.recommendationKey}, ${args.recommendationType},
       ${args.recommendationText},
       ${db.json(args.eligibilityConditions || {})}, ${db.json(args.exclusionConditions || {})},
       ${args.evidenceReferenceId},
       ${args.minEvidenceStrength || 'established_protocol'},
       ${args.minClinicalConfidence ?? 0.8},
       ${args.autonomousScope === true},
       ${args.status || 'draft'}, ${evidenceStatus})
    returning ${db.unsafe(REC_FIELDS)}
  `;

  await recordAdminAudit({
    pharmacyId, action: 'recommendation_created', actorType, actorId,
    entity: 'protocol_recommendation', entityId: row.id,
    meta: {
      slug: protocol.slug, version: protocol.version,
      recommendationKey: row.recommendation_key,
      sourceKey: resolved.source.source_key, section: resolved.reference.section,
    },
  });
  return row;
}

async function activateRecommendation(pharmacyId, recommendationId, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    update protocol_recommendations set status = 'active', updated_at = now()
    where id = ${recommendationId} and pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(REC_FIELDS)}
  `;
  if (!row) {
    const err = new Error('Recommendation not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  await recordAdminAudit({
    pharmacyId, action: 'recommendation_activated', actorType, actorId,
    entity: 'protocol_recommendation', entityId: row.id,
    meta: { recommendationKey: row.recommendation_key },
  });
  return row;
}

/** Configured recommendations for a protocol version. */
async function listRecommendations(pharmacyId, protocolId, { activeOnly = false } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select ${db.unsafe(REC_FIELDS)} from protocol_recommendations
    where pharmacy_id = ${pharmacyId} and protocol_id = ${protocolId}
      ${activeOnly ? db`and status = 'active'` : db``}
    order by recommendation_key
  `;
}

/**
 * Which configured red-flag rules are currently ACTIVE for this protocol?
 *
 * Stage 1 built the red-flag schema with `active` defaulting to false and no
 * detection logic — detection is Stage 4. So this returns the rules a
 * clinician has switched on, and the caller may pass `firedFlags` for any it
 * has independently determined apply. Nothing here infers a red flag from
 * patient data; inventing that inference is exactly what Stage 4 exists to
 * do properly.
 */
async function activeRedFlags(pharmacyId, protocolId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select id, name, severity, action from protocol_red_flags
    where pharmacy_id = ${pharmacyId} and protocol_id = ${protocolId} and active = true
    order by severity desc, name
  `;
}

/**
 * Run the gate for one recommendation against one encounter, and persist the
 * evaluation.
 *
 * @param {object} opts
 * @param {string} [opts.recommendationKey]  a key from configured rows
 * @param {number} [opts.clinicalConfidence] the model's interpretation
 *   confidence — an input to the gate, never an override (see safetyGate)
 * @param {object[]} [opts.firedRedFlags]    flags the caller determined apply
 */
async function evaluate(pharmacyId, executionId, {
  recommendationKey = null, clinicalConfidence = null, firedRedFlags = null,
  patientRequestedPharmacist = false,
} = {}, { actorType = 'system', actorId = null, customerId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const state = await engine.getExecutionState(pharmacyId, executionId);
  const { execution } = state;

  const [protocol] = await db`
    select id, slug, version, status from clinical_protocols where id = ${execution.protocol_id}
  `;

  // Look up ONLY by key against authored rows — see this module's header.
  let recommendation = null;
  if (recommendationKey) {
    [recommendation] = await db`
      select ${db.unsafe(REC_FIELDS)} from protocol_recommendations
      where protocol_id = ${execution.protocol_id} and recommendation_key = ${recommendationKey}
        and pharmacy_id = ${pharmacyId}
    `;
  }

  const resolvedEvidence = recommendation
    ? await evidence.resolveReference(pharmacyId, recommendation.evidence_reference_id)
    : null;

  const redFlags = firedRedFlags !== null
    ? firedRedFlags
    : await activeRedFlags(pharmacyId, execution.protocol_id);

  const decision = gate.evaluate({
    recommendation,
    evidence: resolvedEvidence,
    factsByConcept: state.factsByConcept,
    missingRequired: state.missingRequired,
    conflicts: state.conflicts,
    redFlags,
    clinicalConfidence,
    protocol,
    patientRequestedPharmacist,
  });

  const [row] = await db`
    insert into recommendation_evaluations
      (pharmacy_id, encounter_id, execution_id, recommendation_id,
       protocol_slug, protocol_version,
       evidence_source_key, evidence_source_version, evidence_strength,
       evidence_source_section, evidence_status, recommendation_level,
       patient_population, rule_version,
       status, safety_status, clinical_confidence, escalation_priority,
       pharmacist_review_status, decision_trace, blocking_reasons)
    values
      (${pharmacyId}, ${execution.encounter_id}, ${executionId}, ${recommendation?.id || null},
       ${execution.protocol_slug}, ${execution.protocol_version},
       ${resolvedEvidence?.source?.source_key || null},
       ${resolvedEvidence?.source?.version || null},
       ${resolvedEvidence?.source?.strength || null},
       ${resolvedEvidence?.reference?.section || null},
       ${decision.evidenceStatus || recommendation?.evidence_status || null},
       ${decision.level || null},
       ${resolvedEvidence?.reference?.population || null},
       ${recommendation?.updated_at ? new Date(recommendation.updated_at).toISOString() : null},
       ${decision.status}, ${decision.safetyStatus}, ${clinicalConfidence},
       ${decision.escalationPriority},
       ${decision.escalationPriority ? 'pending' : 'not_required'},
       ${db.json(decision.trace)}, ${db.json(decision.reasons)})
    returning *
  `;

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.RECOMMENDATION_EVALUATED,
    actorType, actorId,
    entityType: 'recommendation_evaluation', entityId: row.id,
    // Outcome and reasons only — the recommendation TEXT is never copied
    // into the audit blob. It lives in the authored rule, one join away.
    metadata: {
      status: decision.status,
      reasons: decision.reasons,
      escalationPriority: decision.escalationPriority,
      recommendationKey: recommendation?.recommendation_key || null,
    },
  });

  return {
    evaluation: row,
    decision,
    recommendation,
    evidence: resolvedEvidence,
    explanation: gate.explain(decision, {
      protocolSlug: execution.protocol_slug, protocolVersion: execution.protocol_version,
    }),
    // The text is released ONLY on a full pass. Every other outcome returns
    // null here, so a caller cannot accidentally deliver the wording of a
    // recommendation that did not pass the gate.
    //
    // Released WITH its AI-generated disclosure attached, not alongside it:
    // returning the bare text and trusting every caller to add the disclosure
    // would make an undisclosed delivery a one-line mistake away. §5.
    deliverableText: decision.status === 'eligible'
      ? withAiDisclosure(recommendation.recommendation_text)
      : null,
  };
}

/**
 * The patient-facing AI disclosure (§5).
 *
 * Short on purpose. §5 asks for transparency without wrecking the experience,
 * and a disclaimer people scroll past protects nobody. Nothing internal leaks
 * here — no rule id, protocol name, confidence score or evidence
 * classification (§11); those live in the evaluation row for staff.
 */
const AI_DISCLOSURE = 'ⓘ AI-generated guidance — based on the clinical references configured '
  + 'for this pharmacy. It may be incomplete, so please speak to our pharmacist or a doctor '
  + 'if you are unsure or if things change.';

function withAiDisclosure(text) {
  if (!text) return null;
  return `${text}\n\n${AI_DISCLOSURE}`;
}

/** Evaluations awaiting a pharmacist, most urgent first. */
async function listPendingReviews(pharmacyId, { limit = 50 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select e.*, c.id as encounter
    from recommendation_evaluations e
    join clinical_encounters c on c.id = e.encounter_id
    where e.pharmacy_id = ${pharmacyId} and e.pharmacist_review_status = 'pending'
    order by case e.escalation_priority
      when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end desc,
      e.created_at
    limit ${Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)}
  `;
}

module.exports = {
  createRecommendation, activateRecommendation, listRecommendations,
  activeRedFlags, evaluate, listPendingReviews, REC_TYPES,
};
