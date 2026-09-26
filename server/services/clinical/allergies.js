/**
 * A patient's allergy record: reading it, writing it, and the one derived
 * answer every other screen needs — does this patient have allergies?
 *
 * THREE STATES, NEVER TWO (brief §3). An empty list is not "no allergies":
 *
 *   known        an active allergy whose record is not refuted / in error
 *   none_known   none of those, AND a pharmacist asserted "no known allergies"
 *   not_assessed neither — the default, and what an empty record means
 *
 * The state is DERIVED on every read (allergyState below). The only thing
 * stored about it is the NKA assertion on patient_profiles, and recording a
 * current allergy withdraws that assertion in the same transaction, so a
 * stale "no known allergies" can never resurface later.
 *
 * NOTHING IS DELETED. Resolve, inactivate, refute and entered-in-error are
 * all edits; the row and its history stay. Every change writes an internal
 * clinical event (clinicalAudit.js) carrying what changed, from what, and why.
 *
 * WHO MAY DO WHAT is decided here, not in the route, so the rule is tested
 * against the database: anyone may record what a patient said (unconfirmed);
 * only a pharmacist or owner may confirm, refute, mark in error, or assert
 * no known allergies. See allergyInput.js#needsClinicalRole.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE — GOLDEN-001.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const {
  UNTRUE, COMMON_ALLERGENS, MANIFESTATIONS, mergeForCheck, needsClinicalRole, hasClinicalRole,
} = require('./allergyInput');

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const forbidden = (message) => httpError(403, 'FORBIDDEN_ROLE', message);

/** Is this record a current allergy? The single definition. */
function isCurrent(a) {
  return a.clinicalStatus === 'active' && !UNTRUE.includes(a.verificationStatus);
}

/**
 * The overall state, from the records and the NKA assertion.
 * Pure, and exported so the rule has exactly one definition.
 */
function allergyState(allergies, nkaAssertedAt) {
  if ((allergies || []).some(isCurrent)) return 'known';
  if (nkaAssertedAt) return 'none_known';
  return 'not_assessed';
}

const ALLERGY_SELECT = `
  a.id, a.allergen_name, a.allergen_code, a.category, a.type, a.clinical_status,
  a.verification_status, a.criticality, a.severity, a.exposure_route,
  a.onset_date::text as onset_date, a.onset_precision,
  a.last_occurrence_date::text as last_occurrence_date, a.last_occurrence_precision,
  a.source, a.notes, a.status_reason, a.recorded_by, a.updated_by,
  a.created_at, a.updated_at,
  rb.email as recorded_by_email, ub.email as updated_by_email
`;

function shape(row, reactions = []) {
  return {
    id: row.id,
    allergenName: row.allergen_name,
    allergenCode: row.allergen_code,
    category: row.category,
    type: row.type,
    clinicalStatus: row.clinical_status,
    verificationStatus: row.verification_status,
    criticality: row.criticality,
    severity: row.severity,
    exposureRoute: row.exposure_route,
    onset: { date: row.onset_date, precision: row.onset_precision },
    lastOccurrence: { date: row.last_occurrence_date, precision: row.last_occurrence_precision },
    source: row.source,
    notes: row.notes,
    statusReason: row.status_reason,
    recordedBy: row.recorded_by ? { id: row.recorded_by, email: row.recorded_by_email || null } : null,
    updatedBy: row.updated_by ? { id: row.updated_by, email: row.updated_by_email || null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reactions,
  };
}

/** The reactions of a set of allergies, in one round trip, in entered order. */
async function reactionsFor(sql, pharmacyId, allergyIds) {
  const byAllergy = new Map();
  if (!allergyIds.length) return byAllergy;
  const rows = await sql`
    select id, allergy_id, manifestation, description
    from patient_allergy_reactions
    where pharmacy_id = ${pharmacyId} and allergy_id = any(${allergyIds})
    order by position, created_at, id
  `;
  for (const r of rows) {
    if (!byAllergy.has(r.allergy_id)) byAllergy.set(r.allergy_id, []);
    byAllergy.get(r.allergy_id).push({ id: r.id, manifestation: r.manifestation, description: r.description });
  }
  return byAllergy;
}

async function customerExists(sql, pharmacyId, customerId) {
  const [c] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  return Boolean(c);
}

async function readNka(sql, pharmacyId, customerId) {
  const [p] = await sql`
    select p.nka_asserted_at, p.nka_asserted_by, u.email
    from patient_profiles p
    left join auth.users u on u.id = p.nka_asserted_by
    where p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
  `;
  if (!p || !p.nka_asserted_at) return null;
  return { at: p.nka_asserted_at, by: p.nka_asserted_by ? { id: p.nka_asserted_by, email: p.email || null } : null };
}

/**
 * The patient's allergy record: the state, the current allergies, and the
 * history (resolved, inactive, refuted, entered in error).
 *
 * Another pharmacy's patient reads exactly like a patient nobody has
 * assessed — a caller must not be able to tell "not yours" from "nothing
 * here".
 */
async function listAllergies(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  if (!(await customerExists(sql, pharmacyId, customerId))) {
    return { state: 'not_assessed', allergies: [], history: [], nka: null };
  }

  const rows = await sql`
    select ${sql.unsafe(ALLERGY_SELECT)}
    from patient_allergies a
    left join auth.users rb on rb.id = a.recorded_by
    left join auth.users ub on ub.id = a.updated_by
    where a.pharmacy_id = ${pharmacyId} and a.customer_id = ${customerId}
    order by a.allergen_name, a.created_at
  `;
  const reactions = await reactionsFor(sql, pharmacyId, rows.map((r) => r.id));
  const all = rows.map((r) => shape(r, reactions.get(r.id) || []));
  const nka = await readNka(sql, pharmacyId, customerId);

  // Highest criticality first among the current ones, so the allergy a
  // pharmacist most needs to see is at the top. Criticality is what a
  // pharmacist recorded, not something computed here.
  const rank = { high: 0, unable_to_assess: 1, low: 2 };
  const current = all.filter(isCurrent).sort((x, y) => (rank[x.criticality] ?? 3) - (rank[y.criticality] ?? 3)
    || x.allergenName.localeCompare(y.allergenName));
  const history = all.filter((a) => !isCurrent(a))
    .sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));

  return { state: allergyState(all, nka?.at), allergies: current, history, nka };
}

async function getAllergy(pharmacyId, customerId, id, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(ALLERGY_SELECT)}
    from patient_allergies a
    left join auth.users rb on rb.id = a.recorded_by
    left join auth.users ub on ub.id = a.updated_by
    where a.id = ${id} and a.pharmacy_id = ${pharmacyId} and a.customer_id = ${customerId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Allergy not found.');
  const reactions = await reactionsFor(db, pharmacyId, [row.id]);
  return shape(row, reactions.get(row.id) || []);
}

async function writeReactions(tx, pharmacyId, allergyId, reactions) {
  await tx`delete from patient_allergy_reactions where allergy_id = ${allergyId} and pharmacy_id = ${pharmacyId}`;
  for (let i = 0; i < reactions.length; i += 1) {
    const r = reactions[i];
    await tx`
      insert into patient_allergy_reactions ${tx({
    pharmacy_id: pharmacyId,
    allergy_id: allergyId,
    manifestation: r.manifestation,
    description: r.description,
    position: i,
  })}
    `;
  }
}

function actorType(role) {
  return role === 'staff' ? 'staff' : 'pharmacist';
}

/** Every audit row gets its own key — a second edit is a second event. */
function event(pharmacyId, customerId, eventType, allergyId, { actorId, actorRole }, metadata) {
  return {
    pharmacyId,
    customerId,
    eventType,
    actorType: actorType(actorRole),
    actorId,
    entityType: 'patient_allergy',
    entityId: allergyId,
    metadata,
    idempotencyKey: `${eventType}:${allergyId}:${crypto.randomUUID()}`,
  };
}

/**
 * Withdraw "no known allergies" — called whenever a write leaves a CURRENT
 * allergy on the record. Locks the profile row, which is also what the NKA
 * assertion locks, so the two cannot interleave into "known allergy AND no
 * known allergies".
 */
async function withdrawNka(tx, pharmacyId, customerId, actor, reason) {
  const [was] = await tx`
    update patient_profiles set nka_asserted_at = null, nka_asserted_by = null, updated_at = now()
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and nka_asserted_at is not null
    returning id
  `;
  if (was) {
    await recordClinicalEvent(tx, {
      pharmacyId,
      customerId,
      eventType: PATIENT_EVENTS.ALLERGY_NKA_CLEARED,
      actorType: actorType(actor.actorRole),
      actorId: actor.actorId,
      entityType: 'patient_profile',
      entityId: was.id,
      metadata: { reason },
      idempotencyKey: `ALLERGY_NKA_CLEARED:${was.id}:${crypto.randomUUID()}`,
    });
  }
}

/**
 * Record a new allergy.
 *
 * @param {object} fields  from allergyInput.readAllergyInput
 * @param {{ actorId?: string, actorRole?: string }} actor
 */
async function addAllergy(pharmacyId, customerId, fields, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (needsClinicalRole(fields) && !hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can record an allergy as confirmed, refuted or in error. Save it as unconfirmed.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    if (!(await customerExists(tx, pharmacyId, customerId))) {
      throw httpError(404, 'NOT_FOUND', 'Patient not found.');
    }
    const [row] = await tx`
      insert into patient_allergies ${tx({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    allergen_name: fields.allergenName,
    allergen_code: fields.allergenCode,
    category: fields.category,
    type: fields.type,
    clinical_status: fields.clinicalStatus,
    verification_status: fields.verificationStatus,
    criticality: fields.criticality,
    severity: fields.severity,
    exposure_route: fields.exposureRoute,
    onset_date: fields.onsetDate,
    onset_precision: fields.onsetPrecision,
    last_occurrence_date: fields.lastOccurrenceDate,
    last_occurrence_precision: fields.lastOccurrencePrecision,
    source: fields.source,
    notes: fields.notes,
    status_reason: fields.statusReason,
    recorded_by: actorId,
    updated_by: actorId,
  })}
      returning id
    `;
    await writeReactions(tx, pharmacyId, row.id, fields.reactions || []);
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.ALLERGY_RECORDED, row.id, actor, {
      allergen: fields.allergenName,
      verificationStatus: fields.verificationStatus,
      clinicalStatus: fields.clinicalStatus,
      criticality: fields.criticality,
    }));
    if (isCurrent(fields)) {
      await withdrawNka(tx, pharmacyId, customerId, actor, `allergy recorded: ${fields.allergenName}`);
    }
    return getAllergy(pharmacyId, customerId, row.id, { sql: tx });
  });
}

const COLUMN = Object.freeze({
  allergenName: 'allergen_name',
  allergenCode: 'allergen_code',
  category: 'category',
  type: 'type',
  clinicalStatus: 'clinical_status',
  verificationStatus: 'verification_status',
  criticality: 'criticality',
  severity: 'severity',
  exposureRoute: 'exposure_route',
  onsetDate: 'onset_date',
  onsetPrecision: 'onset_precision',
  lastOccurrenceDate: 'last_occurrence_date',
  lastOccurrencePrecision: 'last_occurrence_precision',
  source: 'source',
  notes: 'notes',
  statusReason: 'status_reason',
});

/** The flat, comparable form of a stored record — what a patch merges into. */
function flat(a) {
  return {
    allergenName: a.allergenName,
    allergenCode: a.allergenCode,
    category: a.category,
    type: a.type,
    clinicalStatus: a.clinicalStatus,
    verificationStatus: a.verificationStatus,
    criticality: a.criticality,
    severity: a.severity,
    exposureRoute: a.exposureRoute,
    onsetDate: a.onset.date,
    onsetPrecision: a.onset.precision,
    lastOccurrenceDate: a.lastOccurrence.date,
    lastOccurrencePrecision: a.lastOccurrence.precision,
    source: a.source,
    notes: a.notes,
    statusReason: a.statusReason,
  };
}

/**
 * Edit an allergy, including its status. Reactions, when sent, replace the
 * list. The whole merged record is re-checked against the status rules.
 */
async function updateAllergy(pharmacyId, customerId, id, patch, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    const [lock] = await tx`
      select id from patient_allergies
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!lock) throw httpError(404, 'NOT_FOUND', 'Allergy not found.');
    const before = flat(await getAllergy(pharmacyId, customerId, id, { sql: tx }));
    const beforeReactions = (await reactionsFor(tx, pharmacyId, [id])).get(id) || [];

    if (needsClinicalRole(patch, before) && !hasClinicalRole(actorRole)) {
      throw forbidden('Only a pharmacist can confirm, refute or mark an allergy as entered in error.');
    }
    const checked = mergeForCheck(before, patch);

    // What actually changed, from what, to what — the audit record.
    const changes = {};
    for (const [key, col] of Object.entries(COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    const reactionCodes = (list) => list.map((r) => (r.description ? `${r.manifestation}:${r.description}` : r.manifestation));
    const reactionsChanged = patch.reactions
      && JSON.stringify(reactionCodes(patch.reactions)) !== JSON.stringify(reactionCodes(beforeReactions));

    if (Object.keys(changes).length === 0 && !reactionsChanged) {
      return getAllergy(pharmacyId, customerId, id, { sql: tx });
    }

    const set = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const [, c] of Object.entries(changes)) set[c.col] = c.to;
    await tx`update patient_allergies set ${tx(set)} where id = ${id} and pharmacy_id = ${pharmacyId}`;
    if (reactionsChanged) await writeReactions(tx, pharmacyId, id, patch.reactions);

    const statusMoved = changes.clinicalStatus || changes.verificationStatus;
    const audit = Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }]));
    if (reactionsChanged) audit.reactions = { from: reactionCodes(beforeReactions), to: reactionCodes(patch.reactions) };

    await recordClinicalEvent(tx, event(
      pharmacyId, customerId,
      statusMoved ? PATIENT_EVENTS.ALLERGY_STATUS_CHANGED : PATIENT_EVENTS.ALLERGY_UPDATED,
      id, actor,
      {
        allergen: checked.allergenName || before.allergenName,
        changes: audit,
        ...(statusMoved ? { reason: (checked.statusReason ?? before.statusReason) || null } : {}),
      },
    ));

    const after = { ...before, ...checked };
    if (isCurrent(after) && !isCurrent(before)) {
      await withdrawNka(tx, pharmacyId, customerId, actor, `allergy made current: ${after.allergenName}`);
    }
    return getAllergy(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * Assert, or withdraw, "no known allergies".
 *
 * Asserting is refused while a current allergy is on the record — the two
 * cannot both be true. It needs a pharmacist or owner: it is the claim the
 * next person relies on to decide something is safe to give.
 *
 * @param {'no_known'|'clear'} assert
 */
async function setAllergyStatus(pharmacyId, customerId, assert, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (!['no_known', 'clear'].includes(assert)) {
    const err = httpError(400, 'INVALID_ALLERGY', 'Say "no_known" or "clear".');
    err.field = 'assert';
    throw err;
  }
  if (!hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can record that a patient has no known allergies.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };

  await sql.begin(async (tx) => {
    if (!(await customerExists(tx, pharmacyId, customerId))) {
      throw httpError(404, 'NOT_FOUND', 'Patient not found.');
    }
    // Create the profile if this patient has none yet — the NKA assertion is
    // the first clinical fact some patients will ever have.
    await tx`
      insert into patient_profiles (pharmacy_id, customer_id)
      values (${pharmacyId}, ${customerId})
      on conflict (pharmacy_id, customer_id) do nothing
    `;
    const [profile] = await tx`
      select id, nka_asserted_at from patient_profiles
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;

    if (assert === 'clear') {
      if (profile.nka_asserted_at) {
        await withdrawNka(tx, pharmacyId, customerId, actor, 'withdrawn by a pharmacist');
      }
      return;
    }

    const current = await tx`
      select id from patient_allergies
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        and clinical_status = 'active' and verification_status not in ('refuted', 'entered_in_error')
      limit 1
    `;
    if (current.length) {
      throw httpError(409, 'HAS_ALLERGIES',
        'This patient has a current allergy on record. Resolve or refute it before recording no known allergies.');
    }
    await tx`
      update patient_profiles set nka_asserted_at = now(), nka_asserted_by = ${actorId}, updated_at = now()
      where id = ${profile.id} and pharmacy_id = ${pharmacyId}
    `;
    await recordClinicalEvent(tx, {
      pharmacyId,
      customerId,
      eventType: PATIENT_EVENTS.ALLERGY_NKA_ASSERTED,
      actorType: actorType(actorRole),
      actorId,
      entityType: 'patient_profile',
      entityId: profile.id,
      metadata: {},
      idempotencyKey: `ALLERGY_NKA_ASSERTED:${profile.id}:${crypto.randomUUID()}`,
    });
  });

  return listAllergies(pharmacyId, customerId);
}

/**
 * The compact form other screens show: state + the current allergies with
 * their reactions. Used by the medication context and the record-wide strip.
 */
async function allergySummary(pharmacyId, customerId) {
  const { state, allergies, nka } = await listAllergies(pharmacyId, customerId);
  return {
    state,
    nka,
    allergies: allergies.map((a) => ({
      id: a.id,
      allergenName: a.allergenName,
      type: a.type,
      criticality: a.criticality,
      severity: a.severity,
      verificationStatus: a.verificationStatus,
      reactions: a.reactions.map((r) => r.manifestation),
      // Written out, so a compact view needs no vocabulary of its own; an
      // "other" reaction is its description — "Other" alone says nothing.
      reactionLabels: a.reactions.map((r) => (r.manifestation === 'other'
        ? r.description
        : (MANIFESTATIONS.find((m) => m.value === r.manifestation)?.label || r.manifestation))),
    })),
  };
}

/**
 * The allergen search: drug classes and common non-drug allergens from
 * allergyInput, and individual medicines from the NAFDAC register. Matches
 * anywhere in the name, starts-with first. A free-text allergen is always
 * allowed; this only saves typing and gives a code when there is one.
 */
function searchAllergens(query, { limit = 12 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  let generics = [];
  try {
    // Loaded at boot; required lazily so tests of this module do not pay
    // for reading the 6,670-row register.
    const nafdac = require('../ingestion/nafdacLookup');
    generics = nafdac.genericNames();
  } catch {
    generics = [];
  }
  const score = (label) => {
    const l = label.toLowerCase();
    if (l === q) return 0;
    if (l.startsWith(q)) return 1;
    if (l.split(/[\s/(),-]+/).some((w) => w.startsWith(q))) return 2;
    if (l.includes(q)) return 3;
    return null;
  };
  const out = [];
  for (const a of COMMON_ALLERGENS) {
    const s = score(a.label);
    // A class leads: "sulfa" usually means the class, not one sulfonamide.
    if (s !== null) out.push({ s: a.drugClass ? s - 1 : s, label: a.label, code: `common:${a.key}`, category: a.category, drugClass: Boolean(a.drugClass) });
  }
  for (const g of generics) {
    const s = score(g);
    if (s !== null) out.push({ s: s + 0.5, label: g, code: `nafdac:${g}`.slice(0, 200), category: 'medication', drugClass: false });
  }
  return out
    .sort((x, y) => x.s - y.s || x.label.localeCompare(y.label))
    .slice(0, limit)
    .map(({ s: _s, ...rest }) => rest);
}

module.exports = {
  allergyState, isCurrent, listAllergies, getAllergy, addAllergy, updateAllergy,
  setAllergyStatus, allergySummary, searchAllergens,
};
