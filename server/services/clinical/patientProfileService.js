/**
 * The persistent clinical identity for a customer — separate from both the
 * WhatsApp identity (customers table, Segment 1.6) and any single episode
 * (clinical_encounters, this same migration). See 0029's header for the
 * full reasoning; the short version: a fever two days ago is an encounter,
 * a penicillin allergy is a fact that outlives it.
 *
 * PROVENANCE IS THE POINT
 * Every function that touches patient_clinical_facts takes a `source` and,
 * for anything moving toward 'confirmed', an actor. "The AI extracted this
 * from what the customer said" and "a pharmacist confirmed this" are
 * different levels of trust, and the schema keeps them different rather
 * than collapsing into one overwritten value — see recordFact/confirmFact
 * below for exactly where that line is enforced.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

const SEX_VALUES = new Set(['male', 'female', 'unknown']);
const FACT_TYPES = new Set(['allergy', 'condition', 'medication', 'safety_info']);
const FACT_SOURCES = new Set(['patient_reported', 'pharmacist_recorded', 'system_imported', 'ai_extracted']);
const FACT_STATUSES = new Set(['reported', 'confirmed', 'unknown']);

/** The customer this pharmacy actually owns, or throws. Never an existence oracle. */
async function assertOwnedCustomer(sql, pharmacyId, customerId) {
  const [row] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  if (!row) {
    const err = new Error('Customer not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
}

/**
 * The profile for a customer, or null if one has never been created.
 * Read-only — does NOT create one. See getOrCreateProfile for the write path.
 */
async function getPatientProfile(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select id, customer_id, clinical_name, date_of_birth, age_years, age_reported_at, sex,
           important_safety_information, created_at, updated_at
    from patient_profiles
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
  `;
  return row || null;
}

/**
 * Get the profile, creating it on first use.
 *
 * UNIQUE(pharmacy_id, customer_id) plus ON CONFLICT is what makes this safe
 * under concurrency — two messages arriving at once for a brand-new patient
 * must produce exactly one profile, the same guarantee Segment 1.6 built
 * for customer identity itself, applied here for the same reason.
 */
async function getOrCreateProfile(pharmacyId, customerId, { actorType = 'system', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  await assertOwnedCustomer(db, pharmacyId, customerId);

  const [row] = await db`
    insert into patient_profiles (pharmacy_id, customer_id)
    values (${pharmacyId}, ${customerId})
    on conflict (pharmacy_id, customer_id) do update set customer_id = patient_profiles.customer_id
    returning id, customer_id, clinical_name, date_of_birth, age_years, age_reported_at, sex,
              important_safety_information, created_at, updated_at,
              (xmax = 0) as newly_created
  `;
  // xmax = 0 is Postgres's own tell for "this row was just inserted, not
  // updated by the ON CONFLICT arm" — cheaper and more reliable than a
  // separate SELECT-then-INSERT race.
  if (row.newly_created) {
    await recordClinicalEvent(db, {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.PATIENT_PROFILE_CREATED,
      actorType, actorId,
      entityType: 'patient_profile', entityId: row.id,
      metadata: {},
    });
  }
  delete row.newly_created;
  return row;
}

/** Partial update. Only keys actually present are written — see pharmacies.updateProfile for the same convention. */
async function updatePatientProfile(pharmacyId, customerId, fields = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const profile = await getOrCreateProfile(pharmacyId, customerId, { actorType, actorId });
  const patch = {};

  if ('clinical_name' in fields) {
    const v = fields.clinical_name === null ? null : String(fields.clinical_name).trim().slice(0, 200) || null;
    patch.clinical_name = v;
  }
  if ('date_of_birth' in fields) {
    patch.date_of_birth = fields.date_of_birth || null;
  }
  if ('age_years' in fields) {
    const v = fields.age_years;
    if (v !== null && (typeof v !== 'number' || v < 0 || v > 130)) {
      const err = new Error('age_years must be a number between 0 and 130, or null.');
      err.status = 400; err.code = 'INVALID_FIELD';
      throw err;
    }
    patch.age_years = v;
    patch.age_reported_at = v === null ? null : new Date();
  }
  if ('sex' in fields) {
    if (fields.sex !== null && !SEX_VALUES.has(fields.sex)) {
      const err = new Error(`sex must be one of ${[...SEX_VALUES].join(', ')}, or null.`);
      err.status = 400; err.code = 'INVALID_FIELD';
      throw err;
    }
    patch.sex = fields.sex;
  }
  if ('important_safety_information' in fields) {
    patch.important_safety_information = fields.important_safety_information === null
      ? null
      : String(fields.important_safety_information).trim().slice(0, 2000) || null;
  }

  if (Object.keys(patch).length === 0) return profile;

  const [row] = await db`
    update patient_profiles set ${db(patch)}, updated_at = now()
    where id = ${profile.id} and pharmacy_id = ${pharmacyId}
    returning id, customer_id, clinical_name, date_of_birth, age_years, age_reported_at, sex,
              important_safety_information, created_at, updated_at
  `;

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.PATIENT_PROFILE_UPDATED,
    actorType, actorId,
    entityType: 'patient_profile', entityId: row.id,
    // Field NAMES only, never values — this event can carry actorType 'ai'
    // in a future stage, and even then a clinical value must not be copied
    // into an audit-log metadata blob a wider set of eyes might read.
    metadata: { fields: Object.keys(patch) },
  });

  return row;
}

// ---------------------------------------------------------------------------
// clinical facts — allergies, conditions, medications, with provenance
// ---------------------------------------------------------------------------

/**
 * Record a fact. Defaults status to 'reported' and REFUSES 'confirmed' from
 * this function — confirming is a distinct, deliberate pharmacist action
 * (see confirmFact), never a side effect of recording. This is the
 * enforcement point for spec §16/§17: "the AI must never turn an inference
 * into a confirmed patient fact" is not a prompt instruction here, it is
 * this function returning a 400 if a caller tries.
 */
async function recordFact(pharmacyId, customerId, {
  factType, value, source, encounterId = null,
}, { actorType = 'system', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (!FACT_TYPES.has(factType)) {
    const err = new Error(`fact_type must be one of ${[...FACT_TYPES].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!FACT_SOURCES.has(source)) {
    const err = new Error(`source must be one of ${[...FACT_SOURCES].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  const text = String(value || '').trim();
  if (!text || text.length > 500) {
    const err = new Error('value must be between 1 and 500 characters.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  const db = getSql();
  const profile = await getOrCreateProfile(pharmacyId, customerId, { actorType, actorId });

  const [row] = await db`
    insert into patient_clinical_facts
      (pharmacy_id, patient_profile_id, encounter_id, fact_type, value, status, source, recorded_by)
    values
      (${pharmacyId}, ${profile.id}, ${encounterId}, ${factType}, ${text}, 'reported', ${source}, ${actorId})
    returning id, fact_type, value, status, source, encounter_id, created_at, updated_at
  `;

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.CLINICAL_FACT_RECORDED,
    actorType, actorId,
    entityType: 'clinical_fact', entityId: row.id,
    metadata: { factType, source, status: 'reported' },
  });

  return row;
}

/**
 * Move a fact from 'reported' to 'confirmed'. ONLY a pharmacist or staff
 * member may do this — the actorType check here is the same rule as
 * recordFact's source restriction, from the other direction: an AI can
 * report what it heard, only a person can confirm it is true.
 */
async function confirmFact(pharmacyId, customerId, factId, { actorType, actorId }) {
  assertPharmacyId(pharmacyId);
  if (actorType !== 'pharmacist' && actorType !== 'staff') {
    const err = new Error('Only a pharmacist or staff member may confirm a clinical fact.');
    err.status = 403; err.code = 'FORBIDDEN';
    throw err;
  }

  const db = getSql();
  const [row] = await db`
    update patient_clinical_facts f
    set status = 'confirmed', updated_at = now()
    from patient_profiles p
    where f.patient_profile_id = p.id
      and f.id = ${factId}
      and f.pharmacy_id = ${pharmacyId}
      and p.customer_id = ${customerId}
    returning f.id, f.fact_type, f.value, f.status, f.source
  `;
  if (!row) {
    const err = new Error('Clinical fact not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.CLINICAL_FACT_CONFIRMED,
    actorType, actorId,
    entityType: 'clinical_fact', entityId: row.id,
    metadata: { factType: row.fact_type },
  });

  return row;
}

/** Every fact on file for this patient, newest first. Optionally filtered to one type. */
async function listFacts(pharmacyId, customerId, { factType = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const profile = await getPatientProfile(pharmacyId, customerId);
  if (!profile) return [];

  return factType
    ? db`
        select id, fact_type, value, status, source, encounter_id, created_at, updated_at
        from patient_clinical_facts
        where pharmacy_id = ${pharmacyId} and patient_profile_id = ${profile.id} and fact_type = ${factType}
        order by created_at desc
      `
    : db`
        select id, fact_type, value, status, source, encounter_id, created_at, updated_at
        from patient_clinical_facts
        where pharmacy_id = ${pharmacyId} and patient_profile_id = ${profile.id}
        order by created_at desc
      `;
}

module.exports = {
  getPatientProfile, getOrCreateProfile, updatePatientProfile,
  recordFact, confirmFact, listFacts,
};
