/**
 * One clinical episode — created, updated, and moved through its states
 * from here and nowhere else, the same discipline conversationState.js
 * established for workflow_state: every write goes through
 * applyTransition() so an illegal move is refused, not stored.
 *
 * A CONVERSATION IS NOT AN ENCOUNTER
 * "What time do you close" never creates a row here. Only something a
 * pharmacist would recognise as a clinical question does — and in Stage 1,
 * nothing automatic decides that yet (that judgement is Stage 2+). This
 * service exposes createEncounter() for a caller (today: a person; later:
 * a detection layer) to use deliberately, not a trigger that fires on every
 * inbound message.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { getOrCreateProfile } = require('./patientProfileService');

const STATES = Object.freeze({
  ACTIVE: 'active',
  WAITING_FOR_PATIENT: 'waiting_for_patient',
  PHARMACIST_REVIEW_REQUIRED: 'pharmacist_review_required',
  PHARMACIST_ACTIVE: 'pharmacist_active',
  REFERRED: 'referred',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const TERMINAL = new Set([STATES.COMPLETED, STATES.CANCELLED]);

/**
 * Legal transitions. Read each line as "from this state, these are the only
 * places it can go" — same shape and same reasoning as
 * conversationState.TRANSITIONS.
 *
 * THE RULE THAT MATTERS MOST, mirrored from that file for the same reason:
 * PHARMACIST_REVIEW_REQUIRED has NO edge to COMPLETED. An encounter cannot
 * be marked done while it is still waiting on a pharmacist — it must pass
 * through PHARMACIST_ACTIVE first, which is the structural guarantee that
 * "needs pharmacist review" can never be silently skipped on the way to
 * "done".
 */
const TRANSITIONS = Object.freeze({
  [STATES.ACTIVE]: [
    STATES.WAITING_FOR_PATIENT, STATES.PHARMACIST_REVIEW_REQUIRED,
    STATES.REFERRED, STATES.COMPLETED, STATES.CANCELLED,
  ],
  [STATES.WAITING_FOR_PATIENT]: [
    STATES.ACTIVE, STATES.PHARMACIST_REVIEW_REQUIRED,
    STATES.REFERRED, STATES.COMPLETED, STATES.CANCELLED,
  ],
  [STATES.PHARMACIST_REVIEW_REQUIRED]: [
    STATES.PHARMACIST_ACTIVE, STATES.WAITING_FOR_PATIENT,
    STATES.REFERRED, STATES.CANCELLED,
    // deliberately no direct edge to COMPLETED — see header
  ],
  [STATES.PHARMACIST_ACTIVE]: [
    STATES.WAITING_FOR_PATIENT, STATES.REFERRED, STATES.COMPLETED, STATES.CANCELLED,
  ],
  [STATES.REFERRED]: [STATES.COMPLETED, STATES.CANCELLED],
  // Terminal. A new symptom report is a NEW encounter, never a reopened
  // one — the same choice conversationPolicy already made for
  // conversations: reviving a closed episode would resurrect stale
  // context ("still having that headache?" answered days later against
  // context that has moved on).
  [STATES.COMPLETED]: [],
  [STATES.CANCELLED]: [],
});

function canTransition(from, to) {
  if (!(from in TRANSITIONS)) return { allowed: false, reason: 'UNKNOWN_FROM_STATE' };
  if (!Object.values(STATES).includes(to)) return { allowed: false, reason: 'UNKNOWN_TO_STATE' };
  if (from === to) return { allowed: true, reason: 'NO_CHANGE' };
  if (!TRANSITIONS[from].includes(to)) {
    return { allowed: false, reason: `ILLEGAL_TRANSITION_${from}_TO_${to}`.toUpperCase() };
  }
  return { allowed: true, reason: 'OK' };
}

const SELECT_FIELDS = `
  id, pharmacy_id, patient_profile_id, conversation_id, status,
  presenting_complaint, reported_symptoms, symptom_duration, severity,
  relevant_history, current_medications_reported, allergies_reported,
  relevant_observations, patient_concerns, red_flags_detected,
  protocol_id, protocol_slug, protocol_version,
  assessment_status, pharmacist_review_status, referral_status,
  started_at, updated_at, completed_at
`;

/**
 * @param {object} args  presenting_complaint etc. — any subset of the
 *   episode-reported fields. Free text (see 0029's header on why).
 */
async function createEncounter(pharmacyId, customerId, args = {}, { actorType = 'system', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const profile = await getOrCreateProfile(pharmacyId, customerId, { actorType, actorId });

  const [row] = await db`
    insert into clinical_encounters (
      pharmacy_id, patient_profile_id, conversation_id,
      presenting_complaint, reported_symptoms, symptom_duration, severity,
      relevant_history, current_medications_reported, allergies_reported,
      relevant_observations, patient_concerns
    ) values (
      ${pharmacyId}, ${profile.id}, ${args.conversationId || null},
      ${args.presentingComplaint || null}, ${args.reportedSymptoms || null},
      ${args.symptomDuration || null}, ${args.severity || null},
      ${args.relevantHistory || null}, ${args.currentMedicationsReported || null},
      ${args.allergiesReported || null}, ${args.relevantObservations || null},
      ${args.patientConcerns || null}
    )
    returning ${db.unsafe(SELECT_FIELDS)}
  `;

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.ENCOUNTER_CREATED,
    actorType, actorId,
    entityType: 'clinical_encounter', entityId: row.id,
    metadata: { conversationId: args.conversationId || null },
  });

  return row;
}

async function getEncounter(pharmacyId, encounterId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select ${db.unsafe(SELECT_FIELDS)} from clinical_encounters
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
  `;
  return row || null;
}

/** Every encounter for a patient, newest first — "retrieve previous encounters" (spec §25). */
async function listEncountersForPatient(pharmacyId, customerId, { limit = 20 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const profile = await getOrCreateProfile(pharmacyId, customerId);
  return db`
    select ${db.unsafe(SELECT_FIELDS)} from clinical_encounters
    where pharmacy_id = ${pharmacyId} and patient_profile_id = ${profile.id}
    order by started_at desc
    limit ${Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)}
  `;
}

/** Merge episode-reported fields into an in-progress encounter. Status is NOT changed here — see moveEncounterStatus. */
async function updateEncounter(pharmacyId, encounterId, fields = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const patch = {};
  const TEXT_FIELDS = [
    'presentingComplaint', 'reportedSymptoms', 'symptomDuration', 'severity', 'relevantHistory',
    'currentMedicationsReported', 'allergiesReported', 'relevantObservations', 'patientConcerns',
    'assessmentStatus', 'pharmacistReviewStatus', 'referralStatus',
  ];
  const COLUMN = {
    presentingComplaint: 'presenting_complaint', reportedSymptoms: 'reported_symptoms',
    symptomDuration: 'symptom_duration', severity: 'severity', relevantHistory: 'relevant_history',
    currentMedicationsReported: 'current_medications_reported', allergiesReported: 'allergies_reported',
    relevantObservations: 'relevant_observations', patientConcerns: 'patient_concerns',
    assessmentStatus: 'assessment_status', pharmacistReviewStatus: 'pharmacist_review_status',
    referralStatus: 'referral_status',
  };
  for (const key of TEXT_FIELDS) {
    if (key in fields) patch[COLUMN[key]] = fields[key] === null ? null : String(fields[key]).trim().slice(0, 5000) || null;
  }

  if (Object.keys(patch).length === 0) return getEncounter(pharmacyId, encounterId);

  const [row] = await db`
    update clinical_encounters set ${db(patch)}, updated_at = now()
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SELECT_FIELDS)}
  `;
  if (!row) {
    const err = new Error('Clinical encounter not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  return row;
}

/**
 * Move an encounter's status, refusing an illegal transition rather than
 * storing it. This is the ONLY function that changes status — the same
 * "one writer" discipline as conversationService.transitionTo.
 */
async function moveEncounterStatus(pharmacyId, encounterId, to, { actorType, actorId = null, reason = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [current] = await db`
    select id, status, patient_profile_id from clinical_encounters
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
  `;
  if (!current) {
    const err = new Error('Clinical encounter not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const check = canTransition(current.status, to);
  if (!check.allowed) {
    const err = new Error(`Cannot move encounter from ${current.status} to ${to}: ${check.reason}`);
    err.status = 409; err.code = check.reason;
    throw err;
  }
  if (check.reason === 'NO_CHANGE') return getEncounter(pharmacyId, encounterId);

  const isTerminal = TERMINAL.has(to);
  const [row] = await db`
    update clinical_encounters
    set status = ${to}, updated_at = now()
        ${isTerminal ? db`, completed_at = now()` : db``}
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SELECT_FIELDS)}
  `;

  const [customerRow] = await db`select customer_id from patient_profiles where id = ${current.patient_profile_id}`;

  await recordClinicalEvent(db, {
    pharmacyId, customerId: customerRow?.customer_id,
    eventType: to === STATES.COMPLETED
      ? PATIENT_EVENTS.ENCOUNTER_COMPLETED
      : to === STATES.CANCELLED
        ? PATIENT_EVENTS.ENCOUNTER_CANCELLED
        : PATIENT_EVENTS.ENCOUNTER_STATUS_CHANGED,
    actorType, actorId,
    entityType: 'clinical_encounter', entityId: encounterId,
    // recordEvent's default idempotency key is (eventType, entityType,
    // entityId), so a second ENCOUNTER_STATUS_CHANGED on the same encounter
    // would be silently dropped and the encounter's history would show one
    // transition no matter how many actually occurred. Found in Part 3
    // while validating audit reconstruction.
    idempotencyKey: `encounter_status:${encounterId}:${current.status}:${to}:${Date.now()}`,
    metadata: { from: current.status, to, reason },
  });

  return row;
}

/** Attach the protocol version active for this encounter — denormalised, see 0029 header on why. */
async function attachProtocol(pharmacyId, encounterId, { protocolId, slug, version }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    update clinical_encounters
    set protocol_id = ${protocolId}, protocol_slug = ${slug}, protocol_version = ${version}, updated_at = now()
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SELECT_FIELDS)}
  `;
  if (!row) {
    const err = new Error('Clinical encounter not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  return row;
}

module.exports = {
  STATES, canTransition,
  createEncounter, getEncounter, listEncountersForPatient, updateEncounter,
  moveEncounterStatus, attachProtocol,
};
