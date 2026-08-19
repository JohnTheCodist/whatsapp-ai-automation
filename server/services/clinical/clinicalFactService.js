/**
 * Episode observations, with provenance — and the one rule that matters
 * most: NOTHING IS EVER SILENTLY OVERWRITTEN.
 *
 * When a new value arrives for a concept that already has one, this service
 * does one of exactly three things, and never anything else:
 *
 *   same value          -> nothing. No duplicate row (spec test 3).
 *   patient corrects    -> old row becomes `superseded`, new row is `active`,
 *   themselves             both kept, FACT_UPDATED recorded.
 *   sources disagree    -> BOTH rows become `conflicted` and point at each
 *   in a way a human        other, FACT_CONFLICT_DETECTED recorded, and NO
 *   must adjudicate        value is treated as the truth (spec §2, §6).
 *
 * The third case is the one that must never degrade into the second. A
 * patient saying "actually it's 5 not 7" is a correction. A profile saying
 * age 34 while the patient says 40 is a disagreement between two sources,
 * and picking one would be the system inventing a fact. See recordFact's
 * `conflictWith` reasoning.
 *
 * NO CLINICAL INTERPRETATION. This service stores what it is told, with
 * where it came from. It never decides what an observation means.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

const SOURCES = new Set([
  'patient_reported', 'pharmacist_reported', 'measured',
  'system_derived', 'ai_extracted', 'profile_reused', 'unknown',
]);
const NON_VALUE_STATUSES = new Set(['unknown', 'declined']);

/**
 * Sources that may correct each other silently vs sources whose
 * disagreement needs a human.
 *
 * A patient revising their own answer is a correction — they are the same
 * source speaking twice, and the later statement wins. Anything crossing
 * source boundaries (profile vs conversation, patient vs measured) is a
 * genuine conflict: two independent claims about the world that cannot both
 * be right, and no rule in this file is qualified to choose between them.
 */
function isSelfCorrection(previousSource, nextSource) {
  return previousSource === nextSource && previousSource !== 'profile_reused';
}

const FACT_FIELDS = `
  id, encounter_id, patient_profile_id, concept, value, value_number, unit,
  source, status, confidence, answer_id, profile_fact_id, conflicts_with_fact_id,
  collected_at, created_at, updated_at
`;

/**
 * Record an observation.
 *
 * @param {object} args
 * @param {string} args.concept        e.g. 'fever_severity_gauge'
 * @param {string} args.value          canonical string form
 * @param {number} [args.valueNumber]  numeric form where one exists
 * @param {string} args.source         one of SOURCES
 * @param {string} [args.status]       'active' | 'unknown' | 'declined'
 * @returns {{fact: object, outcome: 'created'|'unchanged'|'superseded'|'conflicted'}}
 */
async function recordFact(pharmacyId, encounterId, args = {}, { actorType = 'system', actorId = null, customerId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  if (!SOURCES.has(args.source)) {
    const err = new Error(`source must be one of ${[...SOURCES].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!/^[a-z0-9_]+$/.test(args.concept || '')) {
    const err = new Error('concept must be lowercase letters, numbers and underscores.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  const status = args.status || 'active';
  const value = String(args.value ?? '').trim();
  if (!value && !NON_VALUE_STATUSES.has(status)) {
    const err = new Error('value is required unless status is unknown or declined.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  // The caller may pass the encounter it already holds — seedFromProfile
  // records several facts in a row and would otherwise re-read the same row
  // once per fact, which is a real cost against a pooled remote database,
  // not a theoretical one.
  const encounter = args.encounter || (await db`
    select id, patient_profile_id from clinical_encounters
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
  `)[0];
  if (!encounter) {
    const err = new Error('Clinical encounter not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  // The current live value for this concept, if any.
  const [existing] = await db`
    select ${db.unsafe(FACT_FIELDS)} from encounter_facts
    where encounter_id = ${encounterId} and concept = ${args.concept} and status = 'active'
    order by collected_at desc limit 1
  `;

  const insert = async (rowStatus, conflictsWith = null) => {
    const [row] = await db`
      insert into encounter_facts
        (pharmacy_id, encounter_id, patient_profile_id, concept, value, value_number, unit,
         source, status, confidence, answer_id, profile_fact_id, conflicts_with_fact_id, collected_at)
      values
        (${pharmacyId}, ${encounterId}, ${encounter.patient_profile_id}, ${args.concept},
         ${value || String(status)}, ${args.valueNumber ?? null}, ${args.unit || null},
         ${args.source}, ${rowStatus}, ${args.confidence ?? null},
         ${args.answerId || null}, ${args.profileFactId || null}, ${conflictsWith},
         ${args.collectedAt || new Date()})
      returning ${db.unsafe(FACT_FIELDS)}
    `;
    return row;
  };

  // ---- no prior value: straightforward create ----
  if (!existing) {
    const row = await insert(status);
    await recordClinicalEvent(db, {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.FACT_CREATED,
      actorType, actorId,
      entityType: 'encounter_fact', entityId: row.id,
      // Concept and provenance only — never the clinical VALUE itself. The
      // value lives in the fact row; copying it into an audit blob widens
      // where clinical detail is stored for no traceability gain.
      metadata: { concept: args.concept, source: args.source, status },
    });
    return { fact: row, outcome: 'created' };
  }

  // ---- identical value: do nothing (spec test 3) ----
  const sameValue = existing.value === (value || String(status))
    && String(existing.value_number ?? '') === String(args.valueNumber ?? '');
  if (sameValue && existing.status === status) {
    return { fact: existing, outcome: 'unchanged' };
  }

  // ---- same source revising itself: supersede ----
  if (isSelfCorrection(existing.source, args.source)) {
    const row = await insert(status);
    await db`update encounter_facts set status = 'superseded', updated_at = now() where id = ${existing.id}`;
    await recordClinicalEvent(db, {
      pharmacyId, customerId,
      eventType: PATIENT_EVENTS.FACT_UPDATED,
      actorType, actorId,
      entityType: 'encounter_fact', entityId: row.id,
      metadata: { concept: args.concept, source: args.source, supersededFactId: existing.id },
    });
    return { fact: row, outcome: 'superseded' };
  }

  // ---- different sources disagree: preserve BOTH, resolve neither ----
  const row = await insert('conflicted', existing.id);
  await db`
    update encounter_facts
    set status = 'conflicted', conflicts_with_fact_id = ${row.id}, updated_at = now()
    where id = ${existing.id}
  `;
  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.FACT_CONFLICT_DETECTED,
    actorType, actorId,
    entityType: 'encounter_fact', entityId: row.id,
    metadata: {
      concept: args.concept,
      sources: [existing.source, args.source],
      conflictingFactIds: [existing.id, row.id],
    },
  });
  return { fact: row, outcome: 'conflicted' };
}

/** Live facts for an encounter. Excludes superseded; INCLUDES conflicted, which needs to be seen. */
async function listFacts(pharmacyId, encounterId, { includeSuperseded = false } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select ${db.unsafe(FACT_FIELDS)} from encounter_facts
    where pharmacy_id = ${pharmacyId} and encounter_id = ${encounterId}
      ${includeSuperseded ? db`` : db`and status <> 'superseded'`}
    order by concept, collected_at desc
  `;
}

/** Unresolved disagreements — what a pharmacist must adjudicate before review can complete. */
async function listConflicts(pharmacyId, encounterId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select ${db.unsafe(FACT_FIELDS)} from encounter_facts
    where pharmacy_id = ${pharmacyId} and encounter_id = ${encounterId} and status = 'conflicted'
    order by concept, collected_at
  `;
}

/**
 * A pharmacist picks a winner. The loser becomes `superseded`, NOT deleted —
 * the disagreement having happened is itself part of the record.
 */
async function resolveConflict(pharmacyId, factId, { actorType = 'pharmacist', actorId = null, customerId = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (actorType !== 'pharmacist' && actorType !== 'staff') {
    const err = new Error('Only a pharmacist or staff member may resolve a clinical conflict.');
    err.status = 403; err.code = 'FORBIDDEN';
    throw err;
  }
  const db = getSql();

  const [winner] = await db`
    select ${db.unsafe(FACT_FIELDS)} from encounter_facts
    where id = ${factId} and pharmacy_id = ${pharmacyId} and status = 'conflicted'
  `;
  if (!winner) {
    const err = new Error('Conflicted fact not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  await db.begin(async (tx) => {
    await tx`update encounter_facts set status = 'active', updated_at = now() where id = ${factId}`;
    await tx`
      update encounter_facts set status = 'superseded', updated_at = now()
      where encounter_id = ${winner.encounter_id} and concept = ${winner.concept}
        and id <> ${factId} and status = 'conflicted'
    `;
  });

  await recordClinicalEvent(db, {
    pharmacyId, customerId,
    eventType: PATIENT_EVENTS.FACT_UPDATED,
    actorType, actorId,
    entityType: 'encounter_fact', entityId: factId,
    metadata: { concept: winner.concept, resolution: 'conflict_resolved_by_human' },
  });

  return { ...winner, status: 'active' };
}

/**
 * Carry persistent profile facts into a new encounter (spec §6).
 *
 * Each becomes an encounter fact with source `profile_reused` and a
 * profile_fact_id pointing home. Because `profile_reused` never counts as a
 * self-correction, anything the patient later says that differs will raise a
 * conflict rather than quietly overwriting what was on file — which is
 * exactly the age-34-vs-40 case the spec calls out.
 */
async function seedFromProfile(pharmacyId, encounterId, { actorType = 'system', actorId = null, customerId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [encounter] = await db`
    select id, patient_profile_id from clinical_encounters
    where id = ${encounterId} and pharmacy_id = ${pharmacyId}
  `;
  if (!encounter) {
    const err = new Error('Clinical encounter not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  const [profile] = await db`
    select id, age_years, sex from patient_profiles where id = ${encounter.patient_profile_id}
  `;
  const seeded = [];

  if (profile?.age_years !== null && profile?.age_years !== undefined) {
    const { fact } = await recordFact(pharmacyId, encounterId, {
      concept: 'age_years', value: String(profile.age_years), valueNumber: profile.age_years,
      unit: 'years', source: 'profile_reused', encounter,
    }, { actorType, actorId, customerId });
    seeded.push(fact);
  }
  if (profile?.sex) {
    const { fact } = await recordFact(pharmacyId, encounterId, {
      concept: 'sex', value: profile.sex, source: 'profile_reused', encounter,
    }, { actorType, actorId, customerId });
    seeded.push(fact);
  }

  // Persistent clinical facts (allergies etc) come across as read-only
  // context, keeping their link home so the profile stays the source of
  // truth for anything that outlives this episode.
  const profileFacts = await db`
    select id, fact_type, value from patient_clinical_facts
    where patient_profile_id = ${encounter.patient_profile_id} and pharmacy_id = ${pharmacyId}
      and status in ('reported', 'confirmed')
  `;
  for (const pf of profileFacts) {
    const { fact } = await recordFact(pharmacyId, encounterId, {
      concept: `profile_${pf.fact_type}`, value: pf.value,
      source: 'profile_reused', profileFactId: pf.id, encounter,
    }, { actorType, actorId, customerId });
    seeded.push(fact);
  }

  return seeded;
}

module.exports = {
  recordFact, listFacts, listConflicts, resolveConflict, seedFromProfile,
  SOURCES, isSelfCorrection,
};
