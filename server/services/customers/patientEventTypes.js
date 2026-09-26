/**
 * The event vocabulary for the whole CRM — one file, one source of truth.
 *
 * WHY THIS IS A MODULE AND NOT A DATABASE CHECK CONSTRAINT
 * 0017 put the allowed event types in a CHECK constraint. That is stricter,
 * and it is the wrong strictness: it means every future feature that wants
 * to record a new kind of event needs a migration before it can write a
 * single row. The explicit requirement for this layer is that Segment 2 can
 * call `recordEvent({ eventType: MEDICATION_STARTED })` without touching the
 * schema, so the vocabulary has to live where a feature module can extend
 * it — here.
 *
 * What is NOT given up by moving it: nothing writes to customer_events
 * directly. Every insert goes through recordEvent(), which validates against
 * this registry and rejects anything unknown. The check moved layer, it did
 * not disappear.
 *
 * ADDING AN EVENT TYPE
 * Add it below, in its domain's block. That is the entire process — no
 * migration, no timeline change. The UI renders an unrecognised type from
 * its own name rather than breaking (see CustomerTimeline.jsx), so a new
 * event is visible on the timeline the day it is first recorded, and only
 * needs a renderer entry when it deserves a nicer label or a detail line.
 */

const PATIENT_EVENTS = Object.freeze({
  // ---- identity ----
  PATIENT_CREATED: 'PATIENT_CREATED',

  // ---- conversation ----
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  CONVERSATION_STARTED: 'CONVERSATION_STARTED',
  CONVERSATION_RESOLVED: 'CONVERSATION_RESOLVED',
  // Every workflow_state move, recorded by conversationService. Carries
  // {from, to, reason} so "why did this thread jump to the top of the inbox"
  // is answerable after the fact, not just at the moment it happened.
  CONVERSATION_STATE_CHANGED: 'CONVERSATION_STATE_CHANGED',
  // A staff member said what a conversation was ABOUT (0063). Carries
  // {from, to} because a topic is a judgement, and one pharmacist relabelling
  // another's thread is a thing the next reader should be able to see.
  // Internal: the patient neither set it nor is shown it.
  CONVERSATION_TOPIC_SET: 'CONVERSATION_TOPIC_SET',
  // A record was attached to, or detached from, a conversation (0064).
  // Carries {action, kind, refId} — a POINTER, never a copy of what the
  // record says. Detaching is kept as an event because "this thread was
  // once about that medicine" is a fact the row no longer holds.
  CONVERSATION_LINK_CHANGED: 'CONVERSATION_LINK_CHANGED',
  // A staff-to-staff thread about this patient was started (0066).
  // Carries the SUBJECT only — never a note. An internal note is
  // staff-to-staff and belongs in the thread, not spread across the
  // patient's event log, which other screens read.
  INTERNAL_THREAD_STARTED: 'INTERNAL_THREAD_STARTED',

  // ---- catalogue ----
  PRODUCT_VIEWED: 'PRODUCT_VIEWED',

  // ---- orders ----
  ORDER_CREATED: 'ORDER_CREATED',
  // A second (or third) product added to the SAME cart within one
  // conversation, rather than a separate order being created — see
  // orderService.createOrder's merge-into-open-cart behaviour.
  ORDER_ITEMS_ADDED: 'ORDER_ITEMS_ADDED',
  // A quantity changed, or a line removed, on an order the pharmacy had not
  // yet confirmed — orderService.amendPendingOrder. Removing the LAST line
  // records ORDER_CANCELLED instead, because that is what it is.
  ORDER_ITEMS_AMENDED: 'ORDER_ITEMS_AMENDED',
  ORDER_STOCK_HELD: 'ORDER_STOCK_HELD',
  ORDER_SENT_TO_PHARMACY: 'ORDER_SENT_TO_PHARMACY',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_READY: 'ORDER_READY',
  ORDER_COMPLETED: 'ORDER_COMPLETED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_HOLD_EXPIRED: 'ORDER_HOLD_EXPIRED',

  // ---- pharmacist ----
  PHARMACIST_HANDOFF: 'PHARMACIST_HANDOFF',
  PHARMACIST_RESPONDED: 'PHARMACIST_RESPONDED',

  // Fired ONLY by the contact_pharmacy tool (catalogueTools.js) — the
  // deliberate "I've exhausted what I can do automatically" moment, never
  // by get_pharmacy_info's routine "are you open" lookup, which also
  // returns the phone but is not an escalation. Keeping this narrow is
  // what makes it usable later for "how often does automation give up",
  // per Segment's own stated purpose — a broader trigger would count every
  // hours-and-address question as a failure.
  PHARMACY_CONTACT_PROVIDED: 'PHARMACY_CONTACT_PROVIDED',

  // ---- profile ----
  CUSTOMER_NAME_CAPTURED: 'CUSTOMER_NAME_CAPTURED',

  // ---- internal CRM activity (visibility='internal') ----
  //
  // Staff acting ON a customer record, not the customer doing anything. These
  // record THAT a note or tag changed and by whom — never the note's text.
  // Putting the content in event metadata would copy staff-only prose into a
  // second table, and then "keep notes out of the model" would depend on
  // remembering this table too.
  NOTE_ADDED: 'NOTE_ADDED',
  NOTE_UPDATED: 'NOTE_UPDATED',
  NOTE_DELETED: 'NOTE_DELETED',
  TAG_ADDED: 'TAG_ADDED',
  TAG_REMOVED: 'TAG_REMOVED',

  // ---- communication preferences ----
  COMMUNICATION_OPTED_OUT: 'COMMUNICATION_OPTED_OUT',

  // ---- clinical foundation (Stage 1 — structure only, no treatment logic) --
  //
  // These are the audit trail for the clinical tables added in 0029. No new
  // event table: customer_events already has everything this needs —
  // actor_type distinguishes ai/pharmacist/staff/customer/system, and every
  // one of these is recorded visibility:'internal' by clinicalAudit.js,
  // never customer-facing.
  //
  // Split the same way the module header above explains: an event with a
  // real writer in Stage 1 is listed plainly. One reserved for a LATER
  // stage (Stage 2's protocol matching, Stage 3's questioning, Stage 4's
  // red-flag detection) is marked so, because nothing may emit it yet —
  // recording it early would be the treatment-intelligence line this stage
  // is explicitly told not to cross.
  PATIENT_PROFILE_CREATED: 'PATIENT_PROFILE_CREATED',
  PATIENT_PROFILE_UPDATED: 'PATIENT_PROFILE_UPDATED',
  CLINICAL_FACT_RECORDED: 'CLINICAL_FACT_RECORDED',
  // reported -> confirmed only. Never emitted for anything the AI decided on
  // its own — see patientProfileService.confirmFact's actorType requirement.
  CLINICAL_FACT_CONFIRMED: 'CLINICAL_FACT_CONFIRMED',

  ENCOUNTER_CREATED: 'ENCOUNTER_CREATED',
  ENCOUNTER_STATUS_CHANGED: 'ENCOUNTER_STATUS_CHANGED',
  ENCOUNTER_COMPLETED: 'ENCOUNTER_COMPLETED',
  ENCOUNTER_CANCELLED: 'ENCOUNTER_CANCELLED',

  // NOT listed here: PROTOCOL_CREATED / PROTOCOL_ACTIVATED / PROTOCOL_RETIRED
  // / RED_FLAG_RULE_*. A protocol being configured has no patient attached —
  // customer_events.customer_id is NOT NULL, correctly, since every OTHER
  // row here is a fact about a specific person. Forcing pharmacy-level
  // configuration through this table would mean either violating that
  // constraint or weakening it for everyone else. Those events go through
  // clinicalAudit.recordAdminAudit() instead, backed by the pre-existing
  // `audit_logs` table (pharmacy-scoped, had zero writers before this
  // stage) — see clinicalAudit.js's header for the full reasoning.

  // The gap this closes: POST /:id/takeover (routes/conversations.js) has
  // set handoffs.accepted_at since the hybrid-handoff segment, but recorded
  // no event when it happened — "a pharmacist notified" (PHARMACIST_HANDOFF)
  // and "a pharmacist actually took the conversation" were indistinguishable
  // in the audit trail. pharmacistHandoffService.acceptHandoff() emits this.
  HANDOFF_ACCEPTED: 'HANDOFF_ACCEPTED',

  // These four were RESERVED by Stage 1 with no writer. Stage 2's protocol
  // engine is the writer — which is exactly what reserving them was for: the
  // stage that needed them added a caller, not a migration and not a new
  // registry entry. Stage 2's spec names two of them differently
  // ("QUESTION_PRESENTED", "ANSWER_RECORDED"); they are the same events and
  // are NOT duplicated under new names.
  PATIENT_INFORMATION_CAPTURED: 'PATIENT_INFORMATION_CAPTURED',
  PROTOCOL_SELECTED: 'PROTOCOL_SELECTED',
  QUESTION_ASKED: 'QUESTION_ASKED',          // spec: QUESTION_PRESENTED
  PATIENT_RESPONSE_RECEIVED: 'PATIENT_RESPONSE_RECEIVED', // spec: ANSWER_RECORDED

  // ---- Stage 2 protocol engine ----
  PROTOCOL_STARTED: 'PROTOCOL_STARTED',
  PROTOCOL_STATE_CHANGED: 'PROTOCOL_STATE_CHANGED',
  PROTOCOL_COMPLETED: 'PROTOCOL_COMPLETED',
  FACT_CREATED: 'FACT_CREATED',
  // A fact is never edited in place — "updated" means a NEW row superseded an
  // older one, and this event records that succession.
  FACT_UPDATED: 'FACT_UPDATED',
  // The one that must never be silently swallowed: two sources disagree and a
  // human has to decide. Recorded, surfaced, never auto-resolved.
  FACT_CONFLICT_DETECTED: 'FACT_CONFLICT_DETECTED',

  // ---- Stage 2 Part 2: evidence and the safety gate ----
  // Recorded on EVERY gate run, pass or fail. An eligible recommendation is
  // as much a clinical decision as a blocked one, and both must be
  // reconstructable later.
  RECOMMENDATION_EVALUATED: 'RECOMMENDATION_EVALUATED',
  RECOMMENDATION_DELIVERED: 'RECOMMENDATION_DELIVERED',

  // STILL RESERVED — Stage 4 (red-flag detection) is the writer.
  RED_FLAG_DETECTED: 'RED_FLAG_DETECTED',

  // Pharmacist-only decision support (post Stage 2). A pharmacist asked the
  // LLM for a ranked list of possible causes on an escalated case. This is
  // NOT a recommendation and NOT evidence-gated — it never reaches a
  // patient, is pulled on demand rather than pushed, and exists purely so
  // "who asked for an AI opinion and when" is reconstructable later, the
  // same as every other clinical action in this system.
  DIFFERENTIAL_SUGGESTED: 'DIFFERENTIAL_SUGGESTED',

  // Allergies (0058). The safety-critical record, so every change to it is
  // traceable: who recorded it, who confirmed or refuted it, and why. The
  // status event carries before -> after and the reason in its metadata.
  ALLERGY_RECORDED: 'ALLERGY_RECORDED',
  ALLERGY_UPDATED: 'ALLERGY_UPDATED',
  ALLERGY_STATUS_CHANGED: 'ALLERGY_STATUS_CHANGED',
  // "No known allergies" asserted, or withdrawn (by a pharmacist, or
  // automatically when an allergy is recorded).
  ALLERGY_NKA_ASSERTED: 'ALLERGY_NKA_ASSERTED',
  ALLERGY_NKA_CLEARED: 'ALLERGY_NKA_CLEARED',

  // Conditions — the problem list (0059). Same shape as allergies: the
  // status event carries before -> after and the reason; a deliberate
  // duplicate ("continue anyway") is recorded on CONDITION_RECORDED.
  CONDITION_RECORDED: 'CONDITION_RECORDED',
  CONDITION_UPDATED: 'CONDITION_UPDATED',
  CONDITION_STATUS_CHANGED: 'CONDITION_STATUS_CHANGED',

  // Diagnostic tests (0060). A result is clinical evidence somebody may act
  // on, so ordering it, reporting it and CORRECTING it are all traceable —
  // the correction event carries the reason, and the old values are kept in
  // patient_test_corrections.
  TEST_ORDERED: 'TEST_ORDERED',
  TEST_RESULT_RECORDED: 'TEST_RESULT_RECORDED',
  TEST_UPDATED: 'TEST_UPDATED',
  TEST_STATUS_CHANGED: 'TEST_STATUS_CHANGED',
  TEST_CORRECTED: 'TEST_CORRECTED',

  // Care programmes (0061). A programme organises months of care, so the
  // questions it has to answer later are "when was this person enrolled, who
  // by, what changed, and why did it stop" — the status event carries
  // before -> after and the reason, and the two ending events are their own
  // names because "it was completed" and "it was stopped" are different
  // facts a pharmacist reads differently.
  CARE_PROGRAM_ENROLLED: 'CARE_PROGRAM_ENROLLED',
  CARE_PROGRAM_UPDATED: 'CARE_PROGRAM_UPDATED',
  CARE_PROGRAM_STATUS_CHANGED: 'CARE_PROGRAM_STATUS_CHANGED',
  CARE_PROGRAM_COMPLETED: 'CARE_PROGRAM_COMPLETED',
  CARE_PROGRAM_DISCONTINUED: 'CARE_PROGRAM_DISCONTINUED',
  // The plan inside a programme. Both point at the PROGRAMME, not at the goal
  // or activity row: a goal can be deleted and its history should survive,
  // which an event verified against a deleted row could not.
  CARE_PROGRAM_GOAL_CHANGED: 'CARE_PROGRAM_GOAL_CHANGED',
  CARE_PROGRAM_ACTIVITY_CHANGED: 'CARE_PROGRAM_ACTIVITY_CHANGED',

  // Follow-ups (0062). What needs to happen next for this patient. The five
  // acts are separate names because a pharmacist reading a record later asks
  // different questions of each: when was this raised, when was it moved, was
  // it ever done, and if not, who decided that and why. A follow-up raised
  // inside a care programme keeps the CARE_PROGRAM_ACTIVITY_CHANGED trail it
  // already had, so nothing about that section's history changes.
  FOLLOWUP_CREATED: 'FOLLOWUP_CREATED',
  FOLLOWUP_UPDATED: 'FOLLOWUP_UPDATED',
  FOLLOWUP_RESCHEDULED: 'FOLLOWUP_RESCHEDULED',
  FOLLOWUP_COMPLETED: 'FOLLOWUP_COMPLETED',
  FOLLOWUP_CANCELLED: 'FOLLOWUP_CANCELLED',
  FOLLOWUP_REOPENED: 'FOLLOWUP_REOPENED',

  // ---- RESERVED: no writer exists yet -------------------------------------
  //
  // Declared so the feature that implements them adds a caller, not a
  // migration and not an entry here. Nothing emits these today, and the
  // timeline will simply never show one until something does — which is the
  // correct behaviour for a fact that has not happened.
  //
  // Medication journeys (Segment 2)
  MEDICATION_STARTED: 'MEDICATION_STARTED',
  MEDICATION_REMINDER_SCHEDULED: 'MEDICATION_REMINDER_SCHEDULED',
  MEDICATION_REMINDER_SENT: 'MEDICATION_REMINDER_SENT',
  MEDICATION_REMINDER_RESPONDED: 'MEDICATION_REMINDER_RESPONDED',
  MEDICATION_COMPLETED: 'MEDICATION_COMPLETED',

  // Refills (Segment 3)
  REFILL_DUE: 'REFILL_DUE',
  REFILL_REQUESTED: 'REFILL_REQUESTED',
  REFILL_CONFIRMED: 'REFILL_CONFIRMED',
  REFILL_COMPLETED: 'REFILL_COMPLETED',

  // Delivery
  DELIVERY_REQUESTED: 'DELIVERY_REQUESTED',
  DELIVERY_DISPATCHED: 'DELIVERY_DISPATCHED',
  DELIVERY_COMPLETED: 'DELIVERY_COMPLETED',

  // Payments
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
});

/** Who caused an event. */
const ACTOR_TYPES = Object.freeze(['customer', 'ai', 'pharmacist', 'staff', 'system']);

/**
 * Entity types an event may point back to, and the table each one lives in.
 *
 * The table name is what lets recordEvent() verify that a referenced entity
 * actually exists AND belongs to the same pharmacy — the check that stops one
 * tenant's timeline from ever referencing another tenant's order. An entity
 * type with no table here is structurally unverifiable, so it is not allowed.
 *
 * `payment` and `delivery` are listed with null tables: the type is accepted
 * so a future module can reference it, but until the table exists there is
 * nothing to verify against and recordEvent says so rather than silently
 * skipping the check. (`medication_journey` and `refill` were reserved the
 * same way until 0052 created their tables.)
 */
const ENTITY_TABLES = Object.freeze({
  customer: 'customers',
  message: 'messages',
  order: 'orders',
  order_status_history: 'order_status_history',
  conversation: 'conversations',
  handoff: 'handoffs',
  opt_out: 'opt_outs',
  product: 'products',
  // Internal CRM records. `note` has no table entry on purpose: a NOTE_DELETED
  // event outlives the row it refers to, so verifying the note still exists
  // would make it impossible to record the deletion that just happened.
  note: null,
  tag: 'tags',
  // Clinical foundation (0029).
  patient_profile: 'patient_profiles',
  clinical_fact: 'patient_clinical_facts',
  clinical_encounter: 'clinical_encounters',
  clinical_protocol: 'clinical_protocols',
  red_flag_rule: 'protocol_red_flags',
  // Stage 2 protocol engine (0032).
  protocol_execution: 'protocol_executions',
  protocol_question: 'protocol_questions',
  encounter_answer: 'encounter_answers',
  encounter_fact: 'encounter_facts',
  // Stage 2 Part 2 (0033).
  evidence_source: 'evidence_sources',
  evidence_reference: 'evidence_references',
  protocol_recommendation: 'protocol_recommendations',
  recommendation_evaluation: 'recommendation_evaluations',
  // Medication journeys and refills (0052). Verified like every other
  // entity now that the tables exist: a MEDICATION_STARTED pointing at
  // another pharmacy's journey is refused rather than linked.
  medication_journey: 'medication_journeys',
  refill: 'refills',
  // Allergies (0058).
  patient_allergy: 'patient_allergies',
  // Conditions — the problem list (0059).
  patient_problem: 'patient_problems',
  // Diagnostic tests (0060).
  patient_test: 'patient_tests',
  // Care programmes (0061). Goals and activities have no entity type of their
  // own: their events point at the programme, which outlives them.
  patient_care_program: 'patient_care_programs',
  // Follow-ups (0062) — the same table a care-programme activity lives in,
  // because a follow-up and an activity are the same kind of row.
  patient_task: 'patient_tasks',
  // reserved, no table yet
  payment: null,
  delivery: null,
});

const EVENT_TYPE_SET = new Set(Object.values(PATIENT_EVENTS));

function isKnownEventType(t) {
  return EVENT_TYPE_SET.has(t);
}

function isKnownActorType(t) {
  return ACTOR_TYPES.includes(t);
}

function isKnownEntityType(t) {
  return Object.prototype.hasOwnProperty.call(ENTITY_TABLES, t);
}

/** The table to verify an entity against, or null when there is not one yet. */
function tableForEntity(t) {
  return ENTITY_TABLES[t] ?? null;
}

module.exports = {
  PATIENT_EVENTS, ACTOR_TYPES, ENTITY_TABLES,
  isKnownEventType, isKnownActorType, isKnownEntityType, tableForEntity,
};
