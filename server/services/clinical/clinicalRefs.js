/**
 * "Is this record this patient's, in this pharmacy?" — asked in one place.
 *
 * Several features point at records they do not own: a care-programme activity
 * says what it produced, a programme link says what it is about, and a
 * follow-up says both what raised it (§8) and what it produced (§12). None of
 * those can be a foreign key, because the target is one of several tables.
 *
 * So the check IS the guarantee, and it belongs in one module rather than one
 * per feature. Every query here is scoped by pharmacy_id AND customer_id in
 * its own WHERE clause — GOLDEN-001 — so another pharmacy's record, and
 * another patient's record in the same pharmacy, are both refused.
 *
 * NOTHING CLINICAL IS COPIED OUT. `describeRecord` returns a LABEL for a
 * screen — a date, a name, a status — never a reading, a result value or a
 * diagnosis. The section that owns the record is where those are read.
 */

/**
 * One row per kind: how to find it, and how to write it on a screen.
 *
 * `consultation` and `encounter` are the same table under the two names this
 * product uses for it — the Clinical module calls it a consultation, and the
 * care-programme link vocabulary calls it an encounter.
 */
async function findRecord(sql, pharmacyId, customerId, kind, id) {
  switch (kind) {
    case 'vitals':
      return (await sql`
        select id, to_char(recorded_at, 'DD Mon YYYY') as label,
               nullif(concat_ws(' ', nullif(concat_ws('/', systolic, diastolic), ''), 'mmHg'), 'mmHg') as detail,
               recorded_at as at
        from patient_vitals
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'test':
      return (await sql`
        select id, test_name as label, status as detail, coalesce(performed_at, created_at) as at
        from patient_tests
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'medication':
      return (await sql`
        select id, medicine_name as label, strength as detail, created_at as at
        from medication_journeys
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'condition':
      return (await sql`
        select id, condition_name as label, clinical_status as detail, created_at as at
        from patient_problems
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'medication_review':
      return (await sql`
        select id, to_char(reviewed_on, 'DD Mon YYYY') as label, outcome as detail,
               reviewed_on::timestamptz as at
        from medication_reviews
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'care_program':
      return (await sql`
        select id, program_name as label, status as detail, created_at as at
        from patient_care_programs
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'consultation':
    case 'encounter':
      return (await sql`
        select e.id, to_char(e.started_at, 'DD Mon YYYY') as label,
               e.presenting_complaint as detail, e.started_at as at
        from clinical_encounters e
        join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
        where e.id = ${id} and e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
      `)[0] || null;
    case 'followup':
      // A follow-up is a task row (0062). Its LABEL is what somebody wrote
      // it should be, never what it found — a completed follow-up's result
      // lives in Vitals or Tests, and copying it here would give it a
      // second home.
      return (await sql`
        select id, title as label, status as detail,
               coalesce(due_on::timestamptz, created_at) as at
        from patient_tasks
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    case 'conversation':
      // A thread. The label is its topic if somebody set one, and
      // otherwise the honest "Conversation" — never a line of what was
      // said in it, which belongs in the transcript and nowhere else.
      return (await sql`
        select id, coalesce(topic, 'Conversation') as label, status as detail,
               last_message_at as at
        from conversations
        where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      `)[0] || null;
    default:
      // A kind with no table — 'manual', 'triage', 'other' — names no record,
      // and saying so is not a failure.
      return null;
  }
}

/** Kinds that name a specific row somebody can open. */
const RESOLVABLE = Object.freeze([
  'vitals', 'test', 'medication', 'condition', 'medication_review',
  'care_program', 'consultation', 'encounter',
  // Added for Messages phase 2 (0064/0065): a conversation may point at a
  // follow-up, and a follow-up may record that a conversation raised it.
  'followup', 'conversation',
]);

const namesARecord = (kind) => RESOLVABLE.includes(kind);

/**
 * Refuse an id that is not this patient's own.
 *
 * `field` is what the form should highlight. A kind that names no record
 * (manual, triage) passes: there is nothing to check.
 */
async function assertRecord(sql, pharmacyId, customerId, kind, id, field = 'linkedId') {
  if (!kind || !id || !namesARecord(kind)) return;
  const row = await findRecord(sql, pharmacyId, customerId, kind, id);
  if (!row) {
    const err = new Error('That record is not one of this patient\'s.');
    err.status = 400;
    err.code = 'INVALID_REFERENCE';
    err.field = field;
    throw err;
  }
}

/**
 * How a screen writes a record it is pointing at, or null.
 *
 * A record that has since been deleted from its own section returns null, and
 * the caller says so — dropping the reference instead would lose that it was
 * ever made, which is the only thing the reference was there for.
 */
async function describeRecord(sql, pharmacyId, customerId, kind, id) {
  if (!kind || !id || !namesARecord(kind)) return null;
  const row = await findRecord(sql, pharmacyId, customerId, kind, id);
  if (!row) return null;
  return { id: row.id, label: row.label, detail: row.detail || null, at: row.at || null };
}

module.exports = { assertRecord, describeRecord, namesARecord, RESOLVABLE };
