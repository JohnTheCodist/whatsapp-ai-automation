/**
 * A patient's conditions — the problem list: reading it, writing it, and the
 * compact form other screens show.
 *
 * TWO KINDS OF "CONDITION" LIVE SIDE BY SIDE, never merged:
 *   patient_problems   what a person ASSERTED (this file)
 *   patient_condition  what the purchase engine INFERRED (0037) — "consistent
 *                      with", never a diagnosis
 * The Conditions screen shows the record, and below it the inferences not yet
 * recorded, as suggestions a pharmacist may choose to write down. Nothing is
 * promoted automatically.
 *
 * NOTHING IS DELETED. Resolve, remission, inactive, refute and
 * entered-in-error are edits; the row stays and the history reads honestly.
 * Every change writes an internal clinical event (clinicalAudit.js): who,
 * what changed from what, and why.
 *
 * NO DUPLICATE CURRENT CONDITIONS BY ACCIDENT. A second current Hypertension
 * is refused with 409 and the existing record's id, unless the caller says
 * "continue anyway" — which the audit records.
 *
 * WHO MAY DO WHAT is decided here, so the rule is tested against the
 * database — see problemInput.js#needsClinicalRole.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE — GOLDEN-001.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const {
  UNTRUE, CURRENT_STATUSES, CATALOGUE, mergeForCheck, needsClinicalRole, hasClinicalRole,
} = require('./problemInput');

function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const forbidden = (message) => httpError(403, 'FORBIDDEN_ROLE', message);

/** Is this record a current condition? The single definition. */
function isCurrent(p) {
  return CURRENT_STATUSES.includes(p.clinicalStatus) && !UNTRUE.includes(p.verificationStatus);
}

const PROBLEM_SELECT = `
  p.id, p.condition_name, p.code_system, p.code, p.local_code, p.category,
  p.clinical_status, p.verification_status, p.severity, p.body_site,
  p.onset_date::text as onset_date, p.onset_precision, p.onset_note,
  p.abatement_date::text as abatement_date, p.abatement_precision,
  p.source, p.asserted_by_name, p.encounter_id, p.notes, p.status_reason,
  p.recorded_by, p.updated_by, p.created_at, p.updated_at,
  rb.email as recorded_by_email, ub.email as updated_by_email,
  e.started_at as encounter_started_at, e.presenting_complaint as encounter_complaint
`;

const PROBLEM_FROM = `
  from patient_problems p
  left join auth.users rb on rb.id = p.recorded_by
  left join auth.users ub on ub.id = p.updated_by
  left join clinical_encounters e on e.id = p.encounter_id and e.pharmacy_id = p.pharmacy_id
`;

function shape(row, evidence = []) {
  return {
    id: row.id,
    conditionName: row.condition_name,
    codeSystem: row.code_system,
    code: row.code,
    localCode: row.local_code,
    category: row.category,
    clinicalStatus: row.clinical_status,
    verificationStatus: row.verification_status,
    severity: row.severity,
    bodySite: row.body_site,
    onset: { date: row.onset_date, precision: row.onset_precision, note: row.onset_note },
    abatement: { date: row.abatement_date, precision: row.abatement_precision },
    source: row.source,
    assertedByName: row.asserted_by_name,
    encounter: row.encounter_id
      ? { id: row.encounter_id, startedAt: row.encounter_started_at || null, complaint: row.encounter_complaint || null }
      : null,
    notes: row.notes,
    statusReason: row.status_reason,
    recordedBy: row.recorded_by ? { id: row.recorded_by, email: row.recorded_by_email || null } : null,
    updatedBy: row.updated_by ? { id: row.updated_by, email: row.updated_by_email || null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidence,
  };
}

/** The supporting vitals of a set of conditions, in one round trip. */
async function evidenceFor(sql, pharmacyId, problemIds) {
  const byProblem = new Map();
  if (!problemIds.length) return byProblem;
  const rows = await sql`
    select ev.problem_id, v.id as vitals_id, v.recorded_at, v.systolic, v.diastolic,
           v.pulse, v.temperature_c, v.spo2, v.weight_kg
    from patient_problem_evidence ev
    join patient_vitals v on v.id = ev.vitals_id and v.pharmacy_id = ev.pharmacy_id
    where ev.pharmacy_id = ${pharmacyId} and ev.problem_id = any(${problemIds})
    order by v.recorded_at desc
  `;
  for (const r of rows) {
    if (!byProblem.has(r.problem_id)) byProblem.set(r.problem_id, []);
    byProblem.get(r.problem_id).push({
      vitalsId: r.vitals_id,
      recordedAt: r.recorded_at,
      systolic: r.systolic,
      diastolic: r.diastolic,
      pulse: r.pulse,
      temperature: r.temperature_c === null ? null : Number(r.temperature_c),
      spo2: r.spo2,
      weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    });
  }
  return byProblem;
}

async function customerExists(sql, pharmacyId, customerId) {
  const [c] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  return Boolean(c);
}

/**
 * The purchase engine's conditions that nobody has recorded yet — shown as
 * suggestions, clearly labelled, never as conditions. Hidden once ANY record
 * with the same house code exists (current, resolved or refuted): a
 * pharmacist has already assessed it.
 */
async function purchaseSuggestions(sql, pharmacyId, customerId) {
  const rows = await sql`
    select pc.condition_code, pc.condition_name, pc.first_observed::text as first_observed,
           pc.last_observed::text as last_observed, pc.supporting_transaction_count
    from patient_condition pc
    where pc.pharmacy_id = ${pharmacyId} and pc.customer_id = ${customerId}
      and pc.status = 'CONFIRMED_BY_PURCHASE'
      and not exists (
        select 1 from patient_problems p
        where p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
          and p.local_code = pc.condition_code
      )
    order by pc.condition_name
  `;
  return rows.map((r) => {
    // A specific diagnosis is pre-filled ONLY when the house code names
    // exactly one. DIABETES covers type 1, type 2 and gestational; purchases
    // cannot tell them apart, and picking one would be the software choosing
    // a diagnosis. Then the plain name goes in, and the pharmacist decides.
    const matches = CATALOGUE.filter((c) => c.local === r.condition_code);
    const entry = matches.length === 1 ? matches[0] : null;
    return {
      localCode: r.condition_code,
      name: r.condition_name,
      firstObserved: r.first_observed,
      lastObserved: r.last_observed,
      purchases: r.supporting_transaction_count,
      // What "Record as condition" pre-fills. Verification is left for the
      // pharmacist — the form defaults it to unconfirmed.
      prefill: entry
        ? { conditionName: entry.name, codeSystem: 'icd10', code: entry.code, localCode: entry.local, category: entry.category }
        : { conditionName: r.condition_name, localCode: r.condition_code, category: 'chronic' },
      basis: 'Pharmacy purchase history. Not a diagnosis.',
    };
  });
}

/**
 * The patient's conditions: the current list, the history, and purchase
 * suggestions not yet recorded.
 *
 * Another pharmacy's patient reads exactly like a patient with nothing
 * recorded.
 */
async function listProblems(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  if (!(await customerExists(sql, pharmacyId, customerId))) {
    return { conditions: [], history: [], suggestions: [] };
  }
  const rows = await sql`
    select ${sql.unsafe(PROBLEM_SELECT)} ${sql.unsafe(PROBLEM_FROM)}
    where p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
    order by p.onset_date desc nulls last, p.created_at desc
  `;
  const evidence = await evidenceFor(sql, pharmacyId, rows.map((r) => r.id));
  const all = rows.map((r) => shape(r, evidence.get(r.id) || []));
  const suggestions = await purchaseSuggestions(sql, pharmacyId, customerId);

  // Confirmed first among the current — the list a pharmacist reads to see
  // what this patient HAS. Uncertain ones follow, still visible.
  const certainty = { confirmed: 0, provisional: 1, differential: 2, unconfirmed: 3 };
  const conditions = all.filter(isCurrent).sort((a, b) => (certainty[a.verificationStatus] ?? 4) - (certainty[b.verificationStatus] ?? 4)
    || a.conditionName.localeCompare(b.conditionName));
  const history = all.filter((p) => !isCurrent(p));

  return { conditions, history, suggestions };
}

async function getProblem(pharmacyId, customerId, id, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(PROBLEM_SELECT)} ${db.unsafe(PROBLEM_FROM)}
    where p.id = ${id} and p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Condition not found.');
  const evidence = await evidenceFor(db, pharmacyId, [row.id]);
  const problem = shape(row, evidence.get(row.id) || []);

  // The medicines whose indication is this condition — read, never merged
  // (brief §23). Matched on the house code a medication already carries.
  problem.relatedMedicines = row.local_code
    ? (await db`
        select id, medicine_name, strength, status
        from medication_journeys
        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
          and condition_code = ${row.local_code} and status in ('active', 'draft')
        order by medicine_name
      `).map((m) => ({ id: m.id, medicineName: m.medicine_name, strength: m.strength, status: m.status }))
    : [];
  return problem;
}

/** A consultation id is accepted only if it is THIS patient's, in THIS pharmacy. */
async function assertEncounter(sql, pharmacyId, customerId, encounterId) {
  if (!encounterId) return;
  const [e] = await sql`
    select e.id from clinical_encounters e
    join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
    where e.id = ${encounterId} and e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
  `;
  if (!e) {
    throw httpError(400, 'INVALID_CONDITION', 'That consultation is not one of this patient\'s.', { field: 'encounterId' });
  }
}

/** Supporting readings are accepted only if every one is THIS patient's. */
async function assertVitals(sql, pharmacyId, customerId, ids) {
  if (!ids || !ids.length) return;
  const rows = await sql`
    select id from patient_vitals
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and id = any(${ids})
  `;
  if (rows.length !== ids.length) {
    throw httpError(400, 'INVALID_CONDITION', 'A supporting reading is not one of this patient\'s.', { field: 'evidenceVitalsIds' });
  }
}

async function writeEvidence(tx, pharmacyId, problemId, ids) {
  await tx`delete from patient_problem_evidence where problem_id = ${problemId} and pharmacy_id = ${pharmacyId}`;
  for (const vitalsId of ids) {
    await tx`
      insert into patient_problem_evidence (pharmacy_id, problem_id, vitals_id)
      values (${pharmacyId}, ${problemId}, ${vitalsId})
    `;
  }
}

function actorType(role) {
  return role === 'staff' ? 'staff' : 'pharmacist';
}

function event(pharmacyId, customerId, eventType, problemId, { actorId, actorRole }, metadata) {
  return {
    pharmacyId,
    customerId,
    eventType,
    actorType: actorType(actorRole),
    actorId,
    entityType: 'patient_problem',
    entityId: problemId,
    metadata,
    // Every audit row gets its own key — a second edit is a second event.
    idempotencyKey: `${eventType}:${problemId}:${crypto.randomUUID()}`,
  };
}

/**
 * The current record this one would duplicate, if any: same standard code,
 * or same house code, or else the same name. An encounter diagnosis and a
 * record created already resolved are legitimate history, not duplicates.
 */
async function findDuplicate(sql, pharmacyId, customerId, fields) {
  if (fields.category === 'encounter_diagnosis' || !isCurrent(fields)) return null;
  const [hit] = await sql`
    select id, condition_name from patient_problems
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      and clinical_status in ('active', 'recurrence', 'relapse')
      and verification_status not in ('refuted', 'entered_in_error')
      and category <> 'encounter_diagnosis'
      and (
        (${fields.code}::text is not null and code_system = ${fields.codeSystem} and code = ${fields.code})
        or (${fields.localCode}::text is not null and local_code = ${fields.localCode})
        or lower(trim(condition_name)) = lower(trim(${fields.conditionName}))
      )
    order by created_at
    limit 1
  `;
  return hit || null;
}

/**
 * Record a condition.
 *
 * @param {object} fields  from problemInput.readProblemInput
 * @param {{ actorId?: string, actorRole?: string }} actor
 */
async function addProblem(pharmacyId, customerId, fields, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (needsClinicalRole(fields) && !hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can record a condition as confirmed, differential, refuted or in error. Save it as unconfirmed or provisional.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    if (!(await customerExists(tx, pharmacyId, customerId))) {
      throw httpError(404, 'NOT_FOUND', 'Patient not found.');
    }
    await assertEncounter(tx, pharmacyId, customerId, fields.encounterId);
    await assertVitals(tx, pharmacyId, customerId, fields.evidenceVitalsIds);

    const duplicate = await findDuplicate(tx, pharmacyId, customerId, fields);
    if (duplicate && !fields.allowDuplicate) {
      throw httpError(409, 'DUPLICATE_ACTIVE',
        `This patient already has an active ${duplicate.condition_name} condition.`,
        { existing: { id: duplicate.id, conditionName: duplicate.condition_name } });
    }

    const [row] = await tx`
      insert into patient_problems ${tx({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    condition_name: fields.conditionName,
    code_system: fields.codeSystem,
    code: fields.code,
    local_code: fields.localCode,
    category: fields.category,
    clinical_status: fields.clinicalStatus,
    verification_status: fields.verificationStatus,
    severity: fields.severity,
    body_site: fields.bodySite,
    onset_date: fields.onsetDate,
    onset_precision: fields.onsetPrecision,
    onset_note: fields.onsetNote,
    abatement_date: fields.abatementDate,
    abatement_precision: fields.abatementPrecision,
    source: fields.source,
    asserted_by_name: fields.assertedByName,
    encounter_id: fields.encounterId,
    notes: fields.notes,
    status_reason: fields.statusReason,
    recorded_by: actorId,
    updated_by: actorId,
  })}
      returning id
    `;
    await writeEvidence(tx, pharmacyId, row.id, fields.evidenceVitalsIds || []);
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.CONDITION_RECORDED, row.id, actor, {
      condition: fields.conditionName,
      code: fields.code ? `${fields.codeSystem}:${fields.code}` : null,
      clinicalStatus: fields.clinicalStatus,
      verificationStatus: fields.verificationStatus,
      encounterId: fields.encounterId,
      // "Continue anyway" is a decision someone made, and it is kept.
      ...(duplicate ? { duplicateOf: duplicate.id } : {}),
    }));
    return getProblem(pharmacyId, customerId, row.id, { sql: tx });
  });
}

const COLUMN = Object.freeze({
  conditionName: 'condition_name',
  codeSystem: 'code_system',
  code: 'code',
  localCode: 'local_code',
  category: 'category',
  clinicalStatus: 'clinical_status',
  verificationStatus: 'verification_status',
  severity: 'severity',
  bodySite: 'body_site',
  onsetDate: 'onset_date',
  onsetPrecision: 'onset_precision',
  onsetNote: 'onset_note',
  abatementDate: 'abatement_date',
  abatementPrecision: 'abatement_precision',
  source: 'source',
  assertedByName: 'asserted_by_name',
  encounterId: 'encounter_id',
  notes: 'notes',
  statusReason: 'status_reason',
});

function flat(p) {
  return {
    conditionName: p.conditionName,
    codeSystem: p.codeSystem,
    code: p.code,
    localCode: p.localCode,
    category: p.category,
    clinicalStatus: p.clinicalStatus,
    verificationStatus: p.verificationStatus,
    severity: p.severity,
    bodySite: p.bodySite,
    onsetDate: p.onset.date,
    onsetPrecision: p.onset.precision,
    onsetNote: p.onset.note,
    abatementDate: p.abatement.date,
    abatementPrecision: p.abatement.precision,
    source: p.source,
    assertedByName: p.assertedByName,
    encounterId: p.encounter?.id || null,
    notes: p.notes,
    statusReason: p.statusReason,
  };
}

/** Edit a condition, including its status. Evidence, when sent, is replaced. */
async function updateProblem(pharmacyId, customerId, id, patch, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    const [lock] = await tx`
      select id from patient_problems
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!lock) throw httpError(404, 'NOT_FOUND', 'Condition not found.');
    const stored = await getProblem(pharmacyId, customerId, id, { sql: tx });
    const before = flat(stored);

    if (needsClinicalRole(patch, before) && !hasClinicalRole(actorRole)) {
      throw forbidden('Only a pharmacist can confirm a condition, list it as a differential, refute it or mark it in error.');
    }
    const checked = mergeForCheck(before, patch);
    if (Object.prototype.hasOwnProperty.call(checked, 'encounterId')) {
      await assertEncounter(tx, pharmacyId, customerId, checked.encounterId);
    }

    const changes = {};
    for (const [key, col] of Object.entries(COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    let evidenceChanged = false;
    if (patch.evidenceVitalsIds) {
      await assertVitals(tx, pharmacyId, customerId, patch.evidenceVitalsIds);
      const was = stored.evidence.map((e) => e.vitalsId).sort();
      evidenceChanged = JSON.stringify(was) !== JSON.stringify([...patch.evidenceVitalsIds].sort());
    }
    if (Object.keys(changes).length === 0 && !evidenceChanged) return stored;

    if (Object.keys(changes).length) {
      const set = { updated_at: new Date().toISOString(), updated_by: actorId };
      for (const c of Object.values(changes)) set[c.col] = c.to;
      await tx`update patient_problems set ${tx(set)} where id = ${id} and pharmacy_id = ${pharmacyId}`;
    } else {
      await tx`update patient_problems set updated_at = now(), updated_by = ${actorId} where id = ${id} and pharmacy_id = ${pharmacyId}`;
    }
    if (evidenceChanged) await writeEvidence(tx, pharmacyId, id, patch.evidenceVitalsIds);

    const statusMoved = changes.clinicalStatus || changes.verificationStatus;
    const audit = Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }]));
    if (evidenceChanged) audit.evidenceVitalsIds = { from: stored.evidence.map((e) => e.vitalsId), to: patch.evidenceVitalsIds };

    await recordClinicalEvent(tx, event(
      pharmacyId, customerId,
      statusMoved ? PATIENT_EVENTS.CONDITION_STATUS_CHANGED : PATIENT_EVENTS.CONDITION_UPDATED,
      id, actor,
      {
        condition: checked.conditionName || before.conditionName,
        changes: audit,
        ...(statusMoved ? { reason: (checked.statusReason ?? before.statusReason) || null } : {}),
      },
    ));
    return getProblem(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * This patient's consultations, newest first, for the "documented during"
 * picker. Read-only: unlike listEncountersForPatient it never creates a
 * profile as a side effect.
 */
async function encounterChoices(pharmacyId, customerId, { limit = 20 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const rows = await sql`
    select e.id, e.started_at, e.presenting_complaint, e.status
    from clinical_encounters e
    join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
    where e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
    order by e.started_at desc
    limit ${Math.min(Math.max(Number(limit) || 20, 1), 50)}
  `;
  return rows.map((r) => ({ id: r.id, startedAt: r.started_at, complaint: r.presenting_complaint, status: r.status }));
}

/**
 * The compact form for other screens: current conditions, and the purchase
 * inference kept apart and labelled.
 */
async function problemSummary(pharmacyId, customerId) {
  const { conditions, suggestions } = await listProblems(pharmacyId, customerId);
  return {
    conditions: conditions.map((c) => ({
      id: c.id,
      conditionName: c.conditionName,
      localCode: c.localCode,
      clinicalStatus: c.clinicalStatus,
      verificationStatus: c.verificationStatus,
      severity: c.severity,
    })),
    purchaseSuggested: suggestions.map((s) => ({ localCode: s.localCode, name: s.name })),
  };
}

module.exports = {
  isCurrent, listProblems, getProblem, addProblem, updateProblem, encounterChoices, problemSummary,
};
