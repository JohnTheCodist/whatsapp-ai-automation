/**
 * What a follow-up can point at (§8, §9) — this patient's own records, as a
 * picker reads them.
 *
 * READ-ONLY, AND IT CREATES NOTHING. The consultations list in particular goes
 * through a plain query rather than `listEncountersForPatient`, which creates
 * a patient profile as a side effect of being asked — the same reason
 * `problems.js#encounterChoices` exists.
 *
 * LABELS, NEVER VALUES. A test appears by name and status, a reading by its
 * date; the numbers stay in the sections that own them.
 *
 * Every list is scoped by pharmacy AND patient in its own WHERE clause, so a
 * picker can never offer another patient's record to point at — and the write
 * path checks the id again anyway (clinicalRefs.assertRecord).
 */

const { getSql, assertPharmacyId } = require('../db');

const LIMIT = 15;

async function followupSources(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  const [customer] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  const empty = {
    consultations: [], medicationReviews: [], carePrograms: [], tests: [], vitals: [], conditions: [],
  };
  if (!customer) return empty;

  const [consultations, reviews, programs, tests, vitals, conditions] = await Promise.all([
    sql`
      select e.id, e.started_at, e.presenting_complaint, e.status
      from clinical_encounters e
      join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
      where e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
      order by e.started_at desc
      limit ${LIMIT}
    `,
    sql`
      select id, reviewed_on::text as reviewed_on, outcome, status
      from medication_reviews
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      order by reviewed_on desc
      limit ${LIMIT}
    `,
    sql`
      select id, program_name, status
      from patient_care_programs
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        and status in ('planned', 'active', 'on_hold')
      order by enrolled_on desc
      limit ${LIMIT}
    `,
    sql`
      select id, test_name, status, performed_at
      from patient_tests
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      order by coalesce(performed_at, created_at) desc
      limit ${LIMIT}
    `,
    sql`
      select id, recorded_at, systolic, diastolic, pulse
      from patient_vitals
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      order by recorded_at desc
      limit ${LIMIT}
    `,
    sql`
      select id, condition_name, clinical_status
      from patient_problems
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        and clinical_status in ('active', 'recurrence', 'relapse')
        and verification_status not in ('refuted', 'entered_in_error')
      order by condition_name
      limit ${LIMIT}
    `,
  ]);

  return {
    consultations: consultations.map((e) => ({
      id: e.id, at: e.started_at, label: e.presenting_complaint || 'Consultation', detail: e.status,
    })),
    medicationReviews: reviews.map((r) => ({
      id: r.id, at: r.reviewed_on, label: 'Medication review', detail: r.outcome || r.status,
    })),
    carePrograms: programs.map((p) => ({ id: p.id, label: p.program_name, detail: p.status })),
    tests: tests.map((t) => ({ id: t.id, at: t.performed_at, label: t.test_name, detail: t.status })),
    vitals: vitals.map((v) => ({
      id: v.id,
      at: v.recorded_at,
      label: 'Vitals reading',
      detail: [
        v.systolic && v.diastolic ? `${v.systolic}/${v.diastolic} mmHg` : null,
        v.pulse ? `${v.pulse} bpm` : null,
      ].filter(Boolean).join(' · ') || null,
    })),
    conditions: conditions.map((c) => ({ id: c.id, label: c.condition_name, detail: c.clinical_status })),
  };
}

module.exports = { followupSources };
