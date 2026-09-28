/**
 * The pharmacist's consultation note.
 *
 * See CONSULTATION_PLAN.md. This is the assessment layer the product did not
 * have: `clinical_encounters` (0029) records what the patient reported during
 * a WhatsApp conversation, and this records what the PHARMACIST assessed and
 * decided — Medplum's Encounter beside ClinicalImpression, which is the split
 * the brief itself names.
 *
 * IT CREATES NO CLINICAL RECORD OF ITS OWN. §36 of the brief is explicit and
 * it is also the house rule since 0059: nothing here creates a Condition, an
 * Allergy, a Medication or a Vitals reading as a side effect of documenting a
 * consultation. A blood pressure taken during a consultation is recorded
 * through the Vitals module and pointed at; a diagnosis becomes a Condition
 * only when a pharmacist writes it down in Conditions.
 *
 * THE ENCOUNTER IS OPTIONAL. Most community-pharmacy consultations happen at
 * the counter with no WhatsApp thread behind them (plan §11.1). Where there is
 * one, `triageSummary` reads it; where there is not, that section is absent
 * rather than invented.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id AND customer_id IN ITS OWN WHERE
 * CLAUSE — GOLDEN-001.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const {
  consultationSummary, finalisationProblems, assertMayFinalise, assertMayAmend, OPEN_STATUSES,
} = require('./consultationInput');
const { assertRecord, describeRecord } = require('./clinicalRefs');

const crypto = require('node:crypto');

/** Who acted, in the vocabulary customer_events uses. */
const actorTypeOf = (role) => (role === 'staff' ? 'staff' : 'pharmacist');

/**
 * One audit row. Its own idempotency key, because the default is
 * eventType:entityType:entityId — right when the entity itself is the
 * uniqueness, wrong for a note that is started, finalised and possibly
 * retired. Messages phase 2 lost a patient's second relabel to exactly that
 * default.
 */
function auditEvent(pharmacyId, customerId, eventType, consultationId, actor, metadata) {
  return {
    pharmacyId,
    customerId,
    eventType,
    actorType: actorTypeOf(actor.actorRole),
    actorId: actor.actorId || null,
    entityType: 'pharmacist_consultation',
    entityId: consultationId,
    metadata,
    idempotencyKey: `${eventType}:${consultationId}:${crypto.randomUUID()}`,
  };
}

/** The columns a note is read back as, in one place. */
const CONSULTATION_SELECT = `
  id, customer_id, encounter_id, consultation_type, status,
  reason_code, reason_text, duration_text, patient_goal,
  subjective, objective, assessment_text, focused_findings,
  plan_text, plan_actions, notes,
  referral_destination, referral_reason, referral_urgency, referral_notes,
  prescription_issues, prescriber_contacted_at, prescriber_outcome, care_program_id,
  started_at, created_by, updated_by, completed_at, finalised_by,
  error_reason, created_at, updated_at
`;

function shape(row, { definition = null } = {}) {
  if (!row) return null;
  const c = {
    id: row.id,
    customerId: row.customer_id,
    encounterId: row.encounter_id || null,
    consultationType: row.consultation_type,
    typeLabel: definition ? definition.label : null,
    status: row.status,
    reasonCode: row.reason_code || null,
    reasonText: row.reason_text || null,
    durationText: row.duration_text || null,
    patientGoal: row.patient_goal || null,
    subjective: row.subjective || null,
    objective: row.objective || null,
    assessmentText: row.assessment_text || null,
    focusedFindings: row.focused_findings || {},
    planText: row.plan_text || null,
    planActions: row.plan_actions || [],
    notes: row.notes || null,
    startedAt: row.started_at,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    completedAt: row.completed_at || null,
    finalisedBy: row.finalised_by || null,
    errorReason: row.error_reason || null,
    // §17. NULL destination means referral was never considered; 'none' means
    // a pharmacist considered it and decided against. The summary renders
    // only the second, and the screen must keep them apart too.
    referralDestination: row.referral_destination || null,
    referralReason: row.referral_reason || null,
    referralUrgency: row.referral_urgency || null,
    referralNotes: row.referral_notes || null,
    prescriptionIssues: row.prescription_issues || [],
    prescriberContactedAt: row.prescriber_contacted_at || null,
    prescriberOutcome: row.prescriber_outcome || null,
    careProgramId: row.care_program_id || null,
    updatedAt: row.updated_at,
    // Open notes can still be written to; a completed one cannot without an
    // amendment, which is phase 3.
    isOpen: OPEN_STATUSES.includes(row.status),
  };
  // Filled in by getConsultation, which can query. Defaulted here so a note
  // shaped for a list still has the keys and no screen has to guard for them.
  c.problems = [];
  c.interventions = [];
  // §22's summary is DERIVED on every read, never stored — a stored summary
  // goes stale the moment the note is edited.
  c.summary = consultationSummary(c);
  // What still has to be filled before this may be called completed (§23).
  c.outstanding = definition ? finalisationProblems(c, definition) : [];
  return c;
}

/** The types this pharmacy may use: the shipped catalogue plus its own. */
async function consultationDefinitions(pharmacyId, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const rows = await db`
    select slug, label, emphasis, required_sections, sort_order
    from consultation_definitions
    where active and (pharmacy_id is null or pharmacy_id = ${pharmacyId})
    order by sort_order, label
  `;
  // A pharmacy's own row shadows the shipped one of the same slug.
  const bySlug = new Map();
  for (const r of rows) {
    bySlug.set(r.slug, {
      slug: r.slug,
      label: r.label,
      emphasis: r.emphasis || [],
      requiredSections: r.required_sections || [],
    });
  }
  return [...bySlug.values()];
}

/**
 * §6 — the triage summary, READ from the encounter rather than re-entered.
 *
 * The brief is explicit that Consultation must not ask the pharmacist to type
 * again what triage already collected. Everything here comes out of
 * `clinical_encounters`, which the WhatsApp assessment engine wrote during the
 * conversation. Nothing is summarised by a model: the fields are passed
 * through as the normaliser parsed them, which is the rule `Consultations.jsx`
 * has carried since it was built.
 *
 * Returns null when the consultation has no encounter — a counter
 * consultation has no triage, and an empty triage panel claiming "no red
 * flags" would be a safety claim nobody made.
 */
async function triageSummary(pharmacyId, customerId, encounterId, { sql = null } = {}) {
  if (!encounterId) return null;
  const db = sql || getSql();
  const [row] = await db`
    select e.id, e.presenting_complaint, e.reported_symptoms, e.symptom_duration,
           e.severity, e.red_flags_detected, e.status, e.referral_status,
           e.pharmacist_review_status, e.started_at, e.conversation_id
    from clinical_encounters e
    join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
    where e.id = ${encounterId}
      and e.pharmacy_id = ${pharmacyId}
      and pp.customer_id = ${customerId}
  `;
  if (!row) return null;

  const flags = Array.isArray(row.red_flags_detected) ? row.red_flags_detected : [];
  return {
    encounterId: row.id,
    conversationId: row.conversation_id || null,
    chiefConcern: row.presenting_complaint || null,
    reportedSymptoms: row.reported_symptoms || null,
    duration: row.symptom_duration || null,
    severity: row.severity || null,
    // The flags the engine actually detected. An EMPTY list is reported as an
    // empty list, and the screen says "none recorded" rather than "none" —
    // "no red flags" is a clinical statement, and only the engine that looked
    // is entitled to make it.
    redFlags: flags,
    status: row.status,
    referralStatus: row.referral_status || null,
    reviewStatus: row.pharmacist_review_status || null,
    startedAt: row.started_at,
  };
}

/** §40 — this patient's consultations, newest first. */
async function listConsultations(pharmacyId, customerId, { type = null, status = null, limit = 50 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const definitions = await consultationDefinitions(pharmacyId, { sql: db });
  const byType = new Map(definitions.map((d) => [d.slug, d]));

  const rows = await db`
    select ${db.unsafe(CONSULTATION_SELECT)}
    from pharmacist_consultations
    where pharmacy_id = ${pharmacyId}
      and customer_id = ${customerId}
      ${type ? db`and consultation_type = ${type}` : db``}
      ${status ? db`and status = ${status}` : db``}
    order by started_at desc, id desc
    limit ${Math.min(Math.max(Number(limit) || 50, 1), 200)}
  `;

  const [counts] = await db`
    select
      count(*)::int as all,
      count(*) filter (where status in ('draft', 'in_progress'))::int as open,
      count(*) filter (where status = 'completed')::int as completed,
      count(*) filter (where status = 'entered_in_error')::int as in_error,
      max(started_at) as last_at
    from pharmacist_consultations
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
  `;

  return {
    consultations: rows.map((r) => shape(r, { definition: byType.get(r.consultation_type) })),
    counts: {
      all: Number(counts?.all || 0),
      open: Number(counts?.open || 0),
      completed: Number(counts?.completed || 0),
      inError: Number(counts?.in_error || 0),
    },
    lastConsultationAt: counts?.last_at || null,
    types: definitions,
  };
}

/** One note, with its triage summary where it has one. */
async function getConsultation(pharmacyId, customerId, id, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(CONSULTATION_SELECT)}
    from pharmacist_consultations
    where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
  `;
  if (!row) return null;

  const definitions = await consultationDefinitions(pharmacyId, { sql: db });
  const definition = definitions.find((d) => d.slug === row.consultation_type) || null;
  const consultation = shape(row, { definition });
  consultation.definition = definition;
  consultation.triage = await triageSummary(pharmacyId, customerId, row.encounter_id, { sql: db });

  // §12 and §14. Loaded here rather than in `shape`, which is synchronous —
  // and the summary and the finalisation gate are recomputed once they are
  // present, so a note whose assessment is entirely structured finalises
  // correctly (phase 1 wrote `sectionFilled` to accept either).
  consultation.problems = await consultationProblems(db, pharmacyId, customerId, id);
  consultation.interventions = await consultationInterventions(db, pharmacyId, customerId, id);
  consultation.summary = consultationSummary(consultation);
  consultation.outstanding = definition ? finalisationProblems(consultation, definition) : [];

  // §32. DERIVED by counting the snapshots, never a stored counter — a note
  // that has been corrected must say so at a glance, and a column would be one
  // more thing that can disagree with the rows it counts. This is also why
  // 0070 adds no `amended` status: the answer is always the row count.
  const [{ count }] = await db`
    select count(*)::int as count from consultation_amendments
    where pharmacy_id = ${pharmacyId} and consultation_id = ${id}
  `;
  consultation.amendmentCount = count;
  return consultation;
}

/**
 * Open a consultation.
 *
 * Anyone may open one and write a draft — doing the work is not closing the
 * file, which is the rule every clinical module here uses. Only a pharmacist
 * or the owner may finalise it (§33, plan §11.4).
 */
async function startConsultation(pharmacyId, customerId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const [customer] = await tx`
      select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
    `;
    if (!customer) {
      const err = new Error('Patient not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }

    // An encounter, when one is named, must be THIS patient's in THIS
    // pharmacy. A consultation attached to somebody else's episode would put
    // one patient's triage summary on another's note.
    if (input.encounterId) {
      const found = await triageSummary(pharmacyId, customerId, input.encounterId, { sql: tx });
      if (!found) {
        const err = new Error('That episode is not this patient\'s.');
        err.status = 400; err.code = 'INVALID_REFERENCE'; err.field = 'encounterId';
        throw err;
      }
    }

    const [row] = await tx`
      insert into pharmacist_consultations (
        pharmacy_id, customer_id, encounter_id, consultation_type, status,
        reason_code, reason_text, duration_text, patient_goal,
        subjective, objective, assessment_text, focused_findings,
        plan_text, plan_actions, notes, created_by, updated_by
      ) values (
        ${pharmacyId}, ${customerId}, ${input.encounterId || null},
        ${input.consultationType}, 'draft',
        ${input.reasonCode || null}, ${input.reasonText || null},
        ${input.durationText || null}, ${input.patientGoal || null},
        ${input.subjective || null}, ${input.objective || null},
        ${input.assessmentText || null}, ${tx.json(input.focusedFindings || {})},
        ${input.planText || null}, ${tx.json(input.planActions || [])},
        ${input.notes || null}, ${actor.actorId || null}, ${actor.actorId || null}
      )
      returning ${tx.unsafe(CONSULTATION_SELECT)}
    `;

    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_STARTED, row.id, actor,
      { consultationType: input.consultationType, fromEncounter: Boolean(input.encounterId) },
    ));

    return getConsultation(pharmacyId, customerId, row.id, { sql: tx });
  });
}

/**
 * Save a draft.
 *
 * A completed note is refused with 409 rather than quietly edited — §32 asks
 * for a correction mechanism rather than silent overwriting, and phase 3 is
 * where amendment arrives. Until then, "finished" means finished.
 */
async function updateConsultation(pharmacyId, customerId, id, patch, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const [existing] = await tx`
      select id, status from pharmacist_consultations
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!existing) {
      const err = new Error('Consultation not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    if (!OPEN_STATUSES.includes(existing.status)) {
      const err = new Error('This consultation is finalised and cannot be edited.');
      err.status = 409; err.code = 'FINALISED';
      throw err;
    }

    const fields = {
      reason_code: 'reasonCode', reason_text: 'reasonText', duration_text: 'durationText',
      patient_goal: 'patientGoal', subjective: 'subjective', objective: 'objective',
      assessment_text: 'assessmentText', plan_text: 'planText', notes: 'notes',
    };
    const values = { updated_by: actor.actorId || null, updated_at: tx`now()` };
    for (const [column, key] of Object.entries(fields)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) values[column] = patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'focusedFindings')) {
      values.focused_findings = tx.json(patch.focusedFindings);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'planActions')) {
      values.plan_actions = tx.json(patch.planActions);
    }

    // A draft that has been written into is in progress. The distinction is
    // small but it is what lets the desk show "started" apart from "being
    // worked on" without anybody having to remember to set it.
    if (existing.status === 'draft') values.status = 'in_progress';

    await tx`update pharmacist_consultations set ${tx(values)} where id = ${id}`;
    return getConsultation(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * Finalise (§23).
 *
 * Two gates, and they are different: the ROLE gate says who may finish a
 * clinical record, and the COMPLETENESS gate says what a note of this type
 * must contain. The second is driven by the type's own `required_sections`,
 * so a minor ailment is not held to a chronic-disease review's standard.
 */
async function completeConsultation(pharmacyId, customerId, id, actor = {}) {
  assertPharmacyId(pharmacyId);
  assertMayFinalise(actor.actorRole);
  const db = getSql();

  return db.begin(async (tx) => {
    const current = await getConsultation(pharmacyId, customerId, id, { sql: tx });
    if (!current) {
      const err = new Error('Consultation not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    if (current.status === 'completed') {
      const err = new Error('This consultation is already finalised.');
      err.status = 409; err.code = 'ALREADY_FINALISED';
      throw err;
    }
    if (current.status === 'entered_in_error') {
      const err = new Error('A note marked entered in error cannot be finalised.');
      err.status = 409; err.code = 'IN_ERROR';
      throw err;
    }

    const outstanding = finalisationProblems(current, current.definition);
    if (outstanding.length > 0) {
      const err = new Error(outstanding[0]);
      err.status = 400; err.code = 'INCOMPLETE'; err.outstanding = outstanding;
      throw err;
    }

    await tx`
      update pharmacist_consultations
      set status = 'completed', completed_at = now(),
          finalised_by = ${actor.actorId || null}, updated_by = ${actor.actorId || null},
          updated_at = now()
      where id = ${id}
    `;

    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_COMPLETED, id, actor,
      { consultationType: current.consultationType },
    ));

    return getConsultation(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * Retire a note that should never have existed (§39).
 *
 * NOT a delete. The row stays, visibly marked, with the reason — the position
 * the medication review settled for this codebase: a finished clinical record
 * is the record of a professional act and is not removed because somebody
 * would rather it had not happened.
 */
async function markEnteredInError(pharmacyId, customerId, id, { reason }, actor = {}) {
  assertPharmacyId(pharmacyId);
  assertMayFinalise(actor.actorRole);
  const db = getSql();

  return db.begin(async (tx) => {
    const [existing] = await tx`
      select id, status from pharmacist_consultations
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!existing) {
      const err = new Error('Consultation not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    // Phase 3. Re-marking a note that is ALREADY retired would overwrite the
    // reason it was retired for — losing the only explanation the record has,
    // and leaving a second CONSULTATION_ENTERED_IN_ERROR in the history for
    // something that happened once. The row is already withdrawn; there is
    // nothing here to do.
    if (existing.status === 'entered_in_error') {
      const err = new Error('This note is already marked entered in error.');
      err.status = 409; err.code = 'ALREADY_IN_ERROR';
      throw err;
    }

    await tx`
      update pharmacist_consultations
      set status = 'entered_in_error', error_reason = ${reason},
          updated_by = ${actor.actorId || null}, updated_at = now()
      where id = ${id}
    `;

    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_ENTERED_IN_ERROR, id, actor,
      { reason, previousStatus: existing.status },
    ));

    return getConsultation(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * §32 — reopen a finalised note to correct it.
 *
 * THE SNAPSHOT GOES IN BEFORE ANYTHING IS WRITTEN, in the same transaction.
 * 0060 settled that order for diagnostic reports and the reason is the same:
 * if the update succeeds and the snapshot does not, what the record SAID is
 * gone, and §32 exists precisely so that it is not.
 *
 * The note goes back to `in_progress`, not to a status of its own — see
 * 0070, which argues it at length. Two consequences worth stating here:
 *
 *   - `completed_at` and `finalised_by` are CLEARED, which 0067's own CHECK
 *     requires. That is right rather than merely required: a reopened note
 *     has no signature, and naming the person who signed the version being
 *     replaced would attribute a record they have not seen. Who signed it is
 *     in the snapshot, where it stays true.
 *   - Re-finalising goes through `completeConsultation` unchanged, so an
 *     amended note must still satisfy everything its type requires. An
 *     amendment cannot be used to get around the gate.
 *
 * A note marked entered in error is NOT amendable. It was withdrawn; editing
 * it back into the record is the one thing §39 is there to prevent.
 */
async function amendConsultation(pharmacyId, customerId, id, { reason }, actor = {}) {
  assertPharmacyId(pharmacyId);
  assertMayAmend(actor.actorRole);
  const db = getSql();

  return db.begin(async (tx) => {
    const current = await getConsultation(pharmacyId, customerId, id, { sql: tx });
    if (!current) {
      const err = new Error('Consultation not found.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    if (current.status === 'entered_in_error') {
      const err = new Error('A note marked entered in error cannot be amended.');
      err.status = 409; err.code = 'IN_ERROR';
      throw err;
    }
    // Only a FINALISED note is amended. An open one is simply edited, and
    // calling that an amendment would fill the history with entries for
    // ordinary typing before the note was ever signed.
    if (current.status !== 'completed') {
      const err = new Error('This note is not finalised, so it can be edited directly.');
      err.status = 409; err.code = 'NOT_FINALISED';
      throw err;
    }

    // The whole note as it reads now — its own columns, its problems, its
    // interventions and its referral decision. Not a diff: see 0070.
    const snapshot = {
      status: current.status,
      completedAt: current.completedAt,
      finalisedBy: current.finalisedBy,
      consultationType: current.consultationType,
      reasonCode: current.reasonCode,
      reasonText: current.reasonText,
      durationText: current.durationText,
      patientGoal: current.patientGoal,
      subjective: current.subjective,
      objective: current.objective,
      focusedFindings: current.focusedFindings,
      assessmentText: current.assessmentText,
      planText: current.planText,
      planActions: current.planActions,
      notes: current.notes,
      referralDestination: current.referralDestination,
      referralReason: current.referralReason,
      referralUrgency: current.referralUrgency,
      referralNotes: current.referralNotes,
      prescriptionIssues: current.prescriptionIssues,
      prescriberContactedAt: current.prescriberContactedAt,
      prescriberOutcome: current.prescriberOutcome,
      careProgramId: current.careProgramId,
      problems: current.problems,
      interventions: current.interventions,
      // The summary as it READ, so the history can show the note the way a
      // pharmacist would have seen it rather than making a reader rebuild it.
      summary: current.summary,
    };

    const [written] = await tx`
      insert into consultation_amendments (pharmacy_id, consultation_id, snapshot, reason, amended_by)
      values (${pharmacyId}, ${id}, ${tx.json(snapshot)}, ${reason}, ${actor.actorId || null})
      returning id, created_at
    `;

    await tx`
      update pharmacist_consultations
      set status = 'in_progress', completed_at = null, finalised_by = null,
          updated_by = ${actor.actorId || null}, updated_at = now()
      where id = ${id}
    `;

    const [{ count }] = await tx`
      select count(*)::int as count from consultation_amendments
      where pharmacy_id = ${pharmacyId} and consultation_id = ${id}
    `;

    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_AMENDED, id, actor,
      // The reason and which amendment this is. NEVER the snapshot: it lives
      // in its own table, and copying a clinical record into the event log
      // would put the same note in two places that can disagree.
      //
      // Each amendment is its own event, and stays so because `auditEvent`
      // mints a fresh idempotency key per call. That matters here: the
      // DEFAULT key is eventType:entityType:entityId, which would silently
      // discard the SECOND amendment of a note — the exact bug that lost a
      // patient's second conversation relabel in Messages phase 1.
      { reason, amendmentNumber: count },
    ));

    return getConsultation(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * §32's audit view — the history of ONE note.
 *
 * Filtered to this consultation by the entity its events already point at,
 * exactly as `programTimeline` does for a care programme. The patient's whole
 * history is a different screen, and mixing them would bury eight events
 * under three hundred messages.
 *
 * The amendments come back WITH their snapshots, because a history that says
 * "amended, and here is why" without saying what it said is not an audit
 * trail — it is a changelog.
 */
async function consultationHistory(pharmacyId, customerId, id, { limit = 50 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  // Scope first, query second — GOLDEN-001. A consultation id is not a
  // capability, and this refuses another pharmacy AND another patient.
  const found = await getConsultation(pharmacyId, customerId, id);
  if (!found) {
    const err = new Error('Consultation not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const bounded = Math.min(Math.max(1, Number(limit) || 50), 200);
  const events = await sql`
    select e.id, e.event_type, e.occurred_at, e.actor_type, e.actor_id, e.metadata,
           u.email as actor_email
    from customer_events e
    left join auth.users u on u.id = e.actor_id
    where e.pharmacy_id = ${pharmacyId} and e.customer_id = ${customerId}
      and e.entity_type = 'pharmacist_consultation' and e.entity_id = ${id}
    order by e.occurred_at desc, e.id desc
    limit ${bounded}
  `;

  const amendments = await sql`
    select a.id, a.snapshot, a.reason, a.created_at, u.email as amended_by_email
    from consultation_amendments a
    left join auth.users u on u.id = a.amended_by
    where a.pharmacy_id = ${pharmacyId} and a.consultation_id = ${id}
    order by a.created_at desc, a.id desc
  `;

  return {
    events: events.map((e) => ({
      id: String(e.id),
      eventType: e.event_type,
      occurredAt: e.occurred_at,
      actorType: e.actor_type,
      actor: e.actor_email || null,
      metadata: e.metadata,
    })),
    amendments: amendments.map((a) => ({
      id: a.id,
      snapshot: a.snapshot,
      reason: a.reason,
      at: a.created_at,
      by: a.amended_by_email || null,
    })),
  };
}
/**
 * What other screens show (§28-shaped).
 *
 * The SAME read the section uses, trimmed — so the patient summary and the
 * Consultation workspace cannot disagree about how many notes exist or when
 * the last one was.
 */
async function consultationsSummary(pharmacyId, customerId, { limit = 3 } = {}) {
  assertPharmacyId(pharmacyId);
  const { consultations, counts, lastConsultationAt } =
    await listConsultations(pharmacyId, customerId, { limit: 50 });
  return {
    counts,
    lastConsultationAt,
    recent: consultations.slice(0, Math.max(1, Number(limit) || 3)).map((c) => ({
      id: c.id,
      consultationType: c.consultationType,
      typeLabel: c.typeLabel,
      status: c.status,
      startedAt: c.startedAt,
      reasonCode: c.reasonCode,
      reasonText: c.reasonText,
    })),
  };
}

/* ==========================================================================
 * Phase 2 — problems, interventions, referral, and where the note points
 * ======================================================================== */

/**
 * The problems on one note (§12), each with its pointer RESOLVED.
 *
 * The label beside a pointer comes from the section that owns the record —
 * `describeRecord` reads Conditions, Medications, Tests or Vitals on every
 * load. So a dose changed in Medications shows here next time, and a problem
 * can never display a value that has stopped being true.
 *
 * A record deleted from its own section leaves the problem saying so rather
 * than the row vanishing: that the consultation was about it is a fact, and
 * losing it would rewrite the note.
 */
async function consultationProblems(sql, pharmacyId, customerId, consultationId) {
  const rows = await sql`
    select id, position, label, certainty, status, ref_kind, ref_id, note, created_at
    from consultation_problems
    where pharmacy_id = ${pharmacyId}
      and customer_id = ${customerId}
      and consultation_id = ${consultationId}
    order by position, created_at, id
  `;
  return Promise.all(rows.map(async (r) => ({
    id: r.id,
    position: r.position,
    label: r.label,
    certainty: r.certainty,
    status: r.status,
    refKind: r.ref_kind || null,
    refId: r.ref_id || null,
    record: r.ref_kind
      ? await describeRecord(sql, pharmacyId, customerId, r.ref_kind, r.ref_id)
      : null,
    note: r.note || null,
    at: r.created_at,
  })));
}

/** What was done (§14), each optionally about one of the problems above. */
async function consultationInterventions(sql, pharmacyId, customerId, consultationId) {
  const rows = await sql`
    select id, position, kind, problem_id, note, created_at
    from consultation_interventions
    where pharmacy_id = ${pharmacyId}
      and customer_id = ${customerId}
      and consultation_id = ${consultationId}
    order by position, created_at, id
  `;
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    kind: r.kind,
    problemId: r.problem_id || null,
    note: r.note || null,
    at: r.created_at,
  }));
}

/** The note must be open before anything may be added to it. */
async function openConsultation(tx, pharmacyId, customerId, consultationId) {
  const [row] = await tx`
    select id, status from pharmacist_consultations
    where id = ${consultationId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    for update
  `;
  if (!row) {
    const err = new Error('Consultation not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  if (!OPEN_STATUSES.includes(row.status)) {
    const err = new Error('This consultation is finalised and cannot be edited.');
    err.status = 409; err.code = 'FINALISED';
    throw err;
  }
  return row;
}

/**
 * Add a problem (§12).
 *
 * `assertRecord` refuses a pointer that is not THIS patient's, in THIS
 * pharmacy, before anything is written — the check is the guarantee, because
 * the target is one of four tables and cannot be a foreign key.
 *
 * NOTHING HERE CREATES A CONDITION. §36, and the house rule since 0059: an
 * assessment written during a consultation is the pharmacist's impression, and
 * it becomes a Condition only when somebody writes it down in Conditions.
 */
async function addProblem(pharmacyId, customerId, consultationId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);
    await assertRecord(tx, pharmacyId, customerId, input.refKind, input.refId, 'refId');

    // The next number in the list. Read inside the transaction so two
    // problems added at once cannot both claim the same position — 0057's
    // lesson, where a shared now() left a random uuid as the tiebreak.
    const [{ next }] = await tx`
      select coalesce(max(position), 0) + 1 as next
      from consultation_problems
      where consultation_id = ${consultationId} and pharmacy_id = ${pharmacyId}
    `;

    const [row] = await tx`
      insert into consultation_problems
        (pharmacy_id, consultation_id, customer_id, position, label, certainty, status, ref_kind, ref_id, note)
      values
        (${pharmacyId}, ${consultationId}, ${customerId}, ${next}, ${input.label},
         ${input.certainty}, ${input.status}, ${input.refKind}, ${input.refId}, ${input.note})
      returning id
    `;

    await touch(tx, pharmacyId, consultationId, actor);
    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_PROBLEM_ADDED, consultationId, actor,
      // The LABEL and the certainty, which is what the note says. Never the
      // pointed-at record's own values — those live in their section.
      { problemId: row.id, certainty: input.certainty, refKind: input.refKind || null },
    ));

    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/** Edit a problem — its certainty and status change as a consultation runs. */
async function updateProblem(pharmacyId, customerId, consultationId, problemId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);
    await assertRecord(tx, pharmacyId, customerId, input.refKind, input.refId, 'refId');

    const [updated] = await tx`
      update consultation_problems
      set label = ${input.label}, certainty = ${input.certainty}, status = ${input.status},
          ref_kind = ${input.refKind}, ref_id = ${input.refId}, note = ${input.note}
      where id = ${problemId}
        and consultation_id = ${consultationId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
      returning id
    `;
    if (!updated) {
      const err = new Error('That problem is not on this consultation.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }

    await touch(tx, pharmacyId, consultationId, actor);
    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/**
 * Remove a problem from a DRAFT.
 *
 * Allowed only while the note is open, which is the whole protection: once
 * finalised nothing can be removed, and §32's amendment mechanism (phase 3)
 * is the only way a finished note changes.
 */
async function removeProblem(pharmacyId, customerId, consultationId, problemId, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);
    const [gone] = await tx`
      delete from consultation_problems
      where id = ${problemId}
        and consultation_id = ${consultationId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
      returning id
    `;
    if (!gone) {
      const err = new Error('That problem is not on this consultation.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    await touch(tx, pharmacyId, consultationId, actor);
    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/** Record an intervention (§14). Nothing is ever generated. */
async function addIntervention(pharmacyId, customerId, consultationId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);

    // An intervention about a problem must be about a problem on THIS note.
    if (input.problemId) {
      const [problem] = await tx`
        select id from consultation_problems
        where id = ${input.problemId}
          and consultation_id = ${consultationId}
          and pharmacy_id = ${pharmacyId}
      `;
      if (!problem) {
        const err = new Error('That is not one of this consultation\'s problems.');
        err.status = 400; err.code = 'INVALID_REFERENCE'; err.field = 'problemId';
        throw err;
      }
    }

    const [{ next }] = await tx`
      select coalesce(max(position), 0) + 1 as next
      from consultation_interventions
      where consultation_id = ${consultationId} and pharmacy_id = ${pharmacyId}
    `;

    const [row] = await tx`
      insert into consultation_interventions
        (pharmacy_id, consultation_id, customer_id, position, kind, problem_id, note)
      values
        (${pharmacyId}, ${consultationId}, ${customerId}, ${next},
         ${input.kind}, ${input.problemId}, ${input.note})
      returning id
    `;

    await touch(tx, pharmacyId, consultationId, actor);
    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_INTERVENTION_RECORDED, consultationId, actor,
      { interventionId: row.id, kind: input.kind, aboutProblem: Boolean(input.problemId) },
    ));

    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

async function removeIntervention(pharmacyId, customerId, consultationId, interventionId, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);
    const [gone] = await tx`
      delete from consultation_interventions
      where id = ${interventionId}
        and consultation_id = ${consultationId}
        and pharmacy_id = ${pharmacyId}
        and customer_id = ${customerId}
      returning id
    `;
    if (!gone) {
      const err = new Error('That intervention is not on this consultation.');
      err.status = 404; err.code = 'NOT_FOUND';
      throw err;
    }
    await touch(tx, pharmacyId, consultationId, actor);
    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/**
 * The referral decision (§17).
 *
 * The pharmacist decides. §17 is explicit that a referral must not be inferred
 * from symptoms without a validated clinical rule, and this product has none —
 * so nothing here reads the assessment and suggests anything.
 */
async function setReferral(pharmacyId, customerId, consultationId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);
    await tx`
      update pharmacist_consultations
      set referral_destination = ${input.destination},
          referral_reason = ${input.reason},
          referral_urgency = ${input.urgency},
          referral_notes = ${input.notes},
          updated_by = ${actor.actorId || null}, updated_at = now()
      where id = ${consultationId} and pharmacy_id = ${pharmacyId}
    `;
    await recordClinicalEvent(tx, auditEvent(
      pharmacyId, customerId, PATIENT_EVENTS.CONSULTATION_REFERRAL_RECORDED, consultationId, actor,
      { destination: input.destination, urgency: input.urgency },
    ));
    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/** §16 — what was unclear about a prescription, and what the prescriber said. */
async function setPrescriptionReview(pharmacyId, customerId, consultationId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);
    await tx`
      update pharmacist_consultations
      set prescription_issues = ${tx.json(input.issues)},
          prescriber_contacted_at = ${input.prescriberContacted ? tx`now()` : null},
          prescriber_outcome = ${input.prescriberOutcome},
          updated_by = ${actor.actorId || null}, updated_at = now()
      where id = ${consultationId} and pharmacy_id = ${pharmacyId}
    `;
    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/**
 * §21 — associate this consultation with a care programme.
 *
 * A POINTER. The programme keeps its own plan, goals and activities; nothing
 * here duplicates them, and nothing here enrols anybody.
 */
async function setCareProgram(pharmacyId, customerId, consultationId, careProgramId, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    await openConsultation(tx, pharmacyId, customerId, consultationId);

    if (careProgramId) {
      // The programme must be this patient's, in this pharmacy.
      await assertRecord(tx, pharmacyId, customerId, 'care_program', careProgramId, 'careProgramId');
    }

    await tx`
      update pharmacist_consultations
      set care_program_id = ${careProgramId || null},
          updated_by = ${actor.actorId || null}, updated_at = now()
      where id = ${consultationId} and pharmacy_id = ${pharmacyId}
    `;
    return getConsultation(pharmacyId, customerId, consultationId, { sql: tx });
  });
}

/** A note that has been written into is in progress, and carries who last did. */
async function touch(tx, pharmacyId, consultationId, actor) {
  await tx`
    update pharmacist_consultations
    set status = case when status = 'draft' then 'in_progress' else status end,
        updated_by = ${actor.actorId || null}, updated_at = now()
    where id = ${consultationId} and pharmacy_id = ${pharmacyId}
  `;
}

module.exports = {
  consultationDefinitions,
  triageSummary,
  listConsultations,
  getConsultation,
  startConsultation,
  updateConsultation,
  completeConsultation,
  markEnteredInError,
  addProblem,
  updateProblem,
  removeProblem,
  addIntervention,
  removeIntervention,
  setReferral,
  setPrescriptionReview,
  setCareProgram,
  amendConsultation,
  consultationHistory,
  consultationsSummary,
};
