/**
 * A patient's care details: the pharmacist they are assigned to, and the
 * age and gender staff record at the counter.
 *
 * TWO HOMES, ONE SCREEN. The assignment lives on customers (0053) — it is a
 * care-relationship fact wanted on every patient list. Age and gender live
 * on patient_profiles, where the assistant already records what a patient
 * tells it in a consultation; staff writing them go through the same
 * updatePatientProfile, so validation and the PATIENT_PROFILE_UPDATED
 * timeline event are shared rather than re-implemented. Whoever wrote last
 * wins — the assistant and the counter are recording the same fact.
 *
 * Kept off the Customer 360 response (customerProfile.js) on purpose: that
 * shape is the CRM's, and customerProfile.test.js holds it to "no clinical
 * fields". Demographics come from the clinical record, so they are read
 * here, behind their own endpoint.
 */

const { getSql, assertPharmacyId } = require('../db');
const { updatePatientProfile } = require('../clinical/patientProfileService');

const ASSIGNABLE_ROLES = new Set(['pharmacist', 'owner']);

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function assertOwnedCustomer(sql, pharmacyId, customerId) {
  const [row] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Patient not found.');
}

/**
 * @returns {{ ageYears: number|null, sex: string|null, ageFromDateOfBirth: boolean,
 *            assignedPharmacist: {id, email}|null }}
 */
async function getCare(pharmacyId, customerId, { today = new Date() } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const [row] = await sql`
    select c.assigned_pharmacist_id, u.email as assigned_pharmacist_email,
           pp.age_years, pp.sex, pp.date_of_birth::text as date_of_birth,
           date_part('year', age(${today}::date, pp.date_of_birth))::int as age_from_dob
    from customers c
    left join auth.users u on u.id = c.assigned_pharmacist_id
    left join patient_profiles pp on pp.customer_id = c.id and pp.pharmacy_id = ${pharmacyId}
    where c.id = ${customerId} and c.pharmacy_id = ${pharmacyId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Patient not found.');
  return {
    ageYears: row.age_from_dob ?? row.age_years ?? null,
    // A date of birth outranks a reported age, and cannot be edited here —
    // the screen says so rather than letting an edit silently not stick.
    ageFromDateOfBirth: row.age_from_dob !== null && row.age_from_dob !== undefined,
    sex: row.sex && row.sex !== 'unknown' ? row.sex : null,
    assignedPharmacist: row.assigned_pharmacist_id
      ? { id: row.assigned_pharmacist_id, email: row.assigned_pharmacist_email }
      : null,
  };
}

/**
 * Partial update: only the keys present change.
 *
 * @param {object} fields
 * @param {string|null} [fields.assignedPharmacistId]  null unassigns
 * @param {number|null} [fields.ageYears]
 * @param {'male'|'female'|null} [fields.sex]
 */
async function updateCare(pharmacyId, customerId, fields = {}, { actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  await assertOwnedCustomer(sql, pharmacyId, customerId);

  if ('assignedPharmacistId' in fields) {
    const pharmacistId = fields.assignedPharmacistId;
    if (pharmacistId !== null) {
      // The composite FK (0053) already refuses someone from another
      // pharmacy; this turns that into a clear 400 and adds the role rule.
      const [member] = await sql`
        select role from pharmacy_members where pharmacy_id = ${pharmacyId} and user_id = ${pharmacistId}
      `;
      if (!member) throw httpError(400, 'NOT_A_MEMBER', 'That person is not a member of this pharmacy.');
      if (!ASSIGNABLE_ROLES.has(member.role)) {
        throw httpError(400, 'NOT_A_PHARMACIST', 'Only a pharmacist or the owner can be assigned to a patient.');
      }
    }
    await sql`
      update customers set assigned_pharmacist_id = ${pharmacistId}
      where id = ${customerId} and pharmacy_id = ${pharmacyId}
    `;
  }

  const profilePatch = {};
  if ('ageYears' in fields) profilePatch.age_years = fields.ageYears;
  if ('sex' in fields) profilePatch.sex = fields.sex;
  if (Object.keys(profilePatch).length > 0) {
    await updatePatientProfile(pharmacyId, customerId, profilePatch, { actorType: 'staff', actorId });
  }

  return getCare(pharmacyId, customerId);
}

module.exports = { getCare, updateCare, ASSIGNABLE_ROLES };
