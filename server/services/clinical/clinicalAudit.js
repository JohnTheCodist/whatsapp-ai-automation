/**
 * Two audit trails, because there are genuinely two different kinds of fact
 * — and one existing table for each, reused rather than duplicated.
 *
 * recordClinicalEvent() — PATIENT-scoped clinical events (an encounter
 * created, a fact recorded, a handoff accepted). Backed by customer_events
 * + recordEvent (Segment 1.5). customer_events.customer_id is NOT NULL —
 * correctly, since every row there is a fact about a specific patient.
 *
 * recordAdminAudit() — PHARMACY-scoped configuration events (a protocol
 * created, a red-flag rule activated). These have no patient attached at
 * all — a pharmacist configuring "fever v1.0" is not a fact about any
 * customer — so they cannot go through customer_events without either
 * violating its NOT NULL constraint or weakening a guarantee that
 * constraint correctly protects. Backed instead by `audit_logs`
 * (db/migrations/0001_init.sql) — pharmacy-scoped, append-only, and
 * (verified before use) had ZERO writers anywhere in this codebase. This
 * is the "existing model reused, not duplicated" the Stage 1 spec asks
 * for, just for the pharmacy-level half of the audit trail rather than
 * the patient-level half.
 *
 * WHY A WRAPPER AROUND EITHER, RATHER THAN CALLING THEM DIRECTLY
 * Two things must be true of every clinical audit row, with no exceptions a
 * future caller could forget: recordClinicalEvent's visibility is always
 * 'internal' (a clinical trail is staff-only by definition), and both
 * functions validate the event/action type against this module's own
 * registry so a typo fails at the call site with a clinical-shaped error.
 */

const { recordEvent } = require('../customers/customerEvents');
const { getSql } = require('../db');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

const CLINICAL_EVENT_TYPES = new Set([
  PATIENT_EVENTS.PATIENT_PROFILE_CREATED,
  PATIENT_EVENTS.PATIENT_PROFILE_UPDATED,
  PATIENT_EVENTS.CLINICAL_FACT_RECORDED,
  PATIENT_EVENTS.CLINICAL_FACT_CONFIRMED,
  PATIENT_EVENTS.ENCOUNTER_CREATED,
  PATIENT_EVENTS.ENCOUNTER_STATUS_CHANGED,
  PATIENT_EVENTS.ENCOUNTER_COMPLETED,
  PATIENT_EVENTS.ENCOUNTER_CANCELLED,
  PATIENT_EVENTS.HANDOFF_ACCEPTED,

  // Stage 2 protocol engine. The first four were reserved by Stage 1 and
  // already listed here before they had a writer — which is why Stage 2
  // needed no change to this wrapper's guarantees, only callers.
  PATIENT_EVENTS.PATIENT_INFORMATION_CAPTURED,
  PATIENT_EVENTS.PROTOCOL_SELECTED,
  PATIENT_EVENTS.QUESTION_ASKED,
  PATIENT_EVENTS.PATIENT_RESPONSE_RECEIVED,
  PATIENT_EVENTS.PROTOCOL_STARTED,
  PATIENT_EVENTS.PROTOCOL_STATE_CHANGED,
  PATIENT_EVENTS.PROTOCOL_COMPLETED,
  PATIENT_EVENTS.FACT_CREATED,
  PATIENT_EVENTS.FACT_UPDATED,
  PATIENT_EVENTS.FACT_CONFLICT_DETECTED,
  PATIENT_EVENTS.RECOMMENDATION_EVALUATED,
  PATIENT_EVENTS.RECOMMENDATION_DELIVERED,

  // Still reserved — Stage 4 writes this.
  PATIENT_EVENTS.RED_FLAG_DETECTED,

  // Pharmacist-only decision support.
  PATIENT_EVENTS.DIFFERENTIAL_SUGGESTED,
]);

/**
 * @param {object} sql
 * @param {object} event  everything recordEvent takes EXCEPT visibility,
 *   which this always sets to 'internal'. Requires a real customerId —
 *   for pharmacy-level configuration events with no patient, use
 *   recordAdminAudit instead.
 */
async function recordClinicalEvent(sql, event) {
  if (!CLINICAL_EVENT_TYPES.has(event.eventType)) {
    throw new Error(
      `recordClinicalEvent: "${event.eventType}" is not a registered clinical event type. `
      + `Add it to CLINICAL_EVENT_TYPES in clinicalAudit.js (and to PATIENT_EVENTS if it doesn't exist yet).`
    );
  }
  return recordEvent(sql, { ...event, visibility: 'internal' });
}

const ADMIN_ACTIONS = new Set([
  'protocol_created', 'protocol_activated', 'protocol_deprecated', 'protocol_retired',
  'protocol_question_created',
  'red_flag_rule_created', 'red_flag_rule_activated', 'red_flag_rule_deactivated',
  // Stage 2 Part 2 — evidence and recommendation configuration. These are
  // pharmacy-level authoring actions with no patient attached, so they take
  // the admin trail, not customer_events.
  'evidence_source_created', 'evidence_source_approved',
  'evidence_reference_created',
  'recommendation_created', 'recommendation_activated', 'recommendation_retired',
]);

// audit_logs.actor_type only accepts user/assistant/system/provider — no
// 'pharmacist' or 'staff'. Every human actor in THIS system is staff acting
// through the dashboard, which is what 'user' means in that table's own
// vocabulary (it predates this segment and was written for the general
// case). Mapped here, once, rather than at every call site.
const ADMIN_ACTOR_TYPE = Object.freeze({
  pharmacist: 'user', staff: 'user', customer: 'user',
  ai: 'assistant', system: 'system',
});

/**
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} args.action     one of ADMIN_ACTIONS
 * @param {string} [args.actorType] 'pharmacist' | 'staff' | 'ai' | 'system'
 * @param {string} [args.actorId]
 * @param {string} [args.entity]    e.g. 'clinical_protocol'
 * @param {string} [args.entityId]
 * @param {object} [args.meta]
 */
async function recordAdminAudit({
  pharmacyId, action, actorType = 'system', actorId = null, entity = null, entityId = null, meta = {},
}) {
  if (!ADMIN_ACTIONS.has(action)) {
    throw new Error(`recordAdminAudit: "${action}" is not a registered admin action. Add it to ADMIN_ACTIONS in clinicalAudit.js.`);
  }
  const db = getSql();
  await db`
    insert into audit_logs (pharmacy_id, actor_id, actor_type, action, entity, entity_id, meta)
    values (${pharmacyId}, ${actorId}, ${ADMIN_ACTOR_TYPE[actorType] || 'system'}, ${action},
            ${entity}, ${entityId}, ${db.json(meta)})
  `;
}

module.exports = { recordClinicalEvent, recordAdminAudit, CLINICAL_EVENT_TYPES, ADMIN_ACTIONS };
