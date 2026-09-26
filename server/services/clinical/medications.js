/**
 * The patient's medication record: what they are on, what they have been on,
 * and every clinical detail a pharmacist needs to read it.
 *
 * THE SAME ROWS THE REFILL ENGINE USES. This reads and writes
 * medication_journeys (0052, extended by 0055) — the decision, its rejected
 * alternatives and its risks are in MEDICATIONS_PLAN.md. The refill engine
 * (services/refills/medicationJourneys.js) owns SUPPLY: enrolment, dispenses,
 * run-out dates. This module owns the CLINICAL RECORD: what the medicine is,
 * how it is taken, why, who said so. Two modules, one row, no second copy of
 * the truth.
 *
 * WHERE THE LINE IS, precisely:
 *   refills/medicationJourneys.js   startJourney · recordDispense · stopJourney
 *                                    — anything that touches the refills table
 *   this file                        add · edit · change status · read history
 *                                    — anything that touches only the record
 * A status change that ENDS a medicine closes its open supply here too,
 * because leaving one open would keep a finished course on the call list.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE, never by
 * checking ownership after an unscoped read — GOLDEN-001.
 *
 * NOT INVENTORY. product_id is a reference with the name snapshotted beside
 * it; nothing here reads or writes price, batch, expiry, quantity, supplier
 * or reorder level, and medications.test.js asserts the payload carries no
 * inventory field.
 */

const { getSql, assertPharmacyId } = require('../db');
const { isEnded } = require('./medicationInput');
const { allergySummary } = require('./allergies');
const { problemSummary } = require('./problems');
const { testSummary } = require('./tests');
const { careProgramSummary } = require('./carePrograms');
const { followupSummary } = require('./followups');

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * The columns every read returns, qualified with the journey table: the
 * prescriber join brings a second id, email, created_at and updated_at into
 * scope, and an unqualified list is ambiguous the moment it is joined.
 */
const SELECT = `
  j.id, j.customer_id, j.product_id, j.medicine_name, j.generic_name, j.brand_name,
  j.strength, j.form, j.dose, j.route, j.frequency, j.timing, j.units_per_day,
  j.duration_days, j.started_on::text as started_on, j.ended_on::text as ended_on,
  j.indication, j.condition_code, j.prescriber_id, j.prescriber_name,
  j.instructions, j.notes, j.source, j.status, j.stop_reason, j.encounter_id,
  j.stopped_at, j.created_by, j.updated_by, j.created_at, j.updated_at,
  u.email as prescriber_email
`;

function shape(row) {
  return {
    id: row.id,
    medicineName: row.medicine_name,
    genericName: row.generic_name,
    brandName: row.brand_name,
    productId: row.product_id,
    strength: row.strength,
    form: row.form,
    dose: row.dose,
    route: row.route,
    frequency: row.frequency,
    timing: row.timing,
    unitsPerDay: row.units_per_day === null ? null : Number(row.units_per_day),
    durationDays: row.duration_days,
    startedOn: row.started_on,
    endedOn: row.ended_on,
    indication: row.indication,
    conditionCode: row.condition_code,
    prescriber: row.prescriber_id || row.prescriber_name
      ? { id: row.prescriber_id, name: row.prescriber_name, email: row.prescriber_email || null }
      : null,
    instructions: row.instructions,
    notes: row.notes,
    source: row.source,
    status: row.status,
    stopReason: row.stop_reason,
    encounterId: row.encounter_id,
    endedAt: row.stopped_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * This patient's medicines.
 *
 * @param {{ status?: string }} [opts]  'active' · 'ended' · a single status ·
 *                                      absent for everything
 */
async function listMedications(pharmacyId, customerId, { status = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  // The patient must be this pharmacy's before anything is read. The empty
  // answer is deliberately identical to "this patient has no medicines", so
  // a caller cannot tell "not yours" from "nothing here".
  const [customer] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) return { medications: [], counts: { current: 0, history: 0, total: 0 } };

  const rows = await sql`
    select ${sql.unsafe(SELECT)}
    from medication_journeys j
    left join auth.users u on u.id = j.prescriber_id
    where j.pharmacy_id = ${pharmacyId} and j.customer_id = ${customerId}
      ${status === 'current' ? sql`and j.status in ('draft', 'active')` : sql``}
      ${status === 'history' ? sql`and j.status in ('completed', 'stopped', 'cancelled')` : sql``}
      ${status && !['current', 'history'].includes(status) ? sql`and j.status = ${status}` : sql``}
    order by
      -- Current first, then newest. A pharmacist opening this screen is
      -- answering "what is this patient on" before anything else.
      case when j.status in ('draft', 'active') then 0 else 1 end,
      j.started_on desc, j.created_at desc
  `;

  const all = rows.map(shape);
  const current = all.filter((m) => m.status === 'active' || m.status === 'draft').length;
  return {
    medications: all,
    counts: { current, history: all.length - current, total: all.length },
  };
}

/**
 * One medication, in full.
 *
 * Takes an optional sql handle so a caller inside a transaction can read its
 * own uncommitted write. Without it the read-back runs on a different pooled
 * connection and returns the row as it was BEFORE the update — which is how
 * an edit appeared to save and then come back unchanged.
 */
async function getMedication(pharmacyId, customerId, id, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(SELECT)}
    from medication_journeys j
    left join auth.users u on u.id = j.prescriber_id
    where j.id = ${id} and j.pharmacy_id = ${pharmacyId} and j.customer_id = ${customerId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Medication not found.');
  return shape(row);
}

/** The storage column for each field of the contract. */
const COLUMNS = Object.freeze({
  medicineName: 'medicine_name',
  genericName: 'generic_name',
  brandName: 'brand_name',
  productId: 'product_id',
  strength: 'strength',
  form: 'form',
  dose: 'dose',
  route: 'route',
  frequency: 'frequency',
  timing: 'timing',
  durationDays: 'duration_days',
  startedOn: 'started_on',
  endedOn: 'ended_on',
  indication: 'indication',
  conditionCode: 'condition_code',
  prescriberId: 'prescriber_id',
  prescriberName: 'prescriber_name',
  instructions: 'instructions',
  notes: 'notes',
  source: 'source',
  status: 'status',
  stopReason: 'stop_reason',
});

async function addMedication(pharmacyId, customerId, fields, { actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  const [customer] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) throw httpError(404, 'NOT_FOUND', 'Patient not found.');

  const values = { pharmacy_id: pharmacyId, customer_id: customerId, created_by: actorId };
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (fields[key] !== undefined) values[column] = fields[key];
  }
  // units_per_day is the refill engine's column and stays its meaning: doses
  // a day. Derived from the frequency the pharmacist chose rather than typed
  // twice, and left null for a PRN medicine, which has no schedule to
  // compute a run-out date from.
  if (fields.dosesPerDay !== undefined) values.units_per_day = fields.dosesPerDay;
  if (isEnded(fields.status)) values.stopped_at = new Date().toISOString();

  try {
    const [row] = await sql`insert into medication_journeys ${sql(values)} returning id`;
    // Read back through the one query the list and detail use, so a created
    // medication cannot come back in a shape the next read disagrees with.
    return getMedication(pharmacyId, customerId, row.id);
  } catch (err) {
    // The one-active-per-medicine index from 0052. Two active rows for one
    // medicine would put the patient on the call list twice for one strip.
    if (err.code === '23505') {
      throw httpError(409, 'ALREADY_ON_THIS', 'This patient is already on that medicine.');
    }
    throw err;
  }
}

/**
 * Edit, including a status change.
 *
 * ENDING A MEDICINE CLOSES ITS OPEN SUPPLY, in the same transaction. A
 * completed course whose refill stayed open would keep appearing on the
 * refill call list, and somebody would ring a patient about a medicine they
 * were told to stop taking.
 */
async function updateMedication(pharmacyId, customerId, id, patch, { actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  return sql.begin(async (tx) => {
    const [before] = await tx`
      select id, status from medication_journeys
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!before) throw httpError(404, 'NOT_FOUND', 'Medication not found.');

    const values = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (patch[key] !== undefined) values[column] = patch[key];
    }
    if (patch.dosesPerDay !== undefined) values.units_per_day = patch.dosesPerDay;

    if (patch.status !== undefined && patch.status !== before.status) {
      // The ended_at check in 0055: anything ended records when, anything
      // running cannot.
      values.stopped_at = isEnded(patch.status) ? new Date().toISOString() : null;
      if (!isEnded(patch.status)) values.stop_reason = null;
    }

    try {
      await tx`
        update medication_journeys set ${tx(values)}
        where id = ${id} and pharmacy_id = ${pharmacyId}
      `;
    } catch (err) {
      if (err.code === '23505') {
        throw httpError(409, 'ALREADY_ON_THIS', 'This patient is already on that medicine.');
      }
      throw err;
    }

    if (patch.status !== undefined && isEnded(patch.status) && !isEnded(before.status)) {
      await tx`
        update refills set status = 'cancelled', closed_at = now()
        where journey_id = ${id} and pharmacy_id = ${pharmacyId} and status = 'open'
      `;
    }

    // Read back through the one query the list and detail use, so an edited
    // medication cannot come back in a shape the next read disagrees with.
    return getMedication(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * The context a pharmacist needs beside a medication list, compact and
 * linked rather than a copy of the chart: what they are treated for, what
 * was last measured, when they were last seen.
 *
 * ALLERGIES ARE ABSENT BECAUSE THIS SYSTEM HAS NO ALLERGY RECORD. The
 * payload says so explicitly rather than omitting the key, so the screen can
 * print "Not recorded" and never "None" — see MEDICATIONS_PLAN.md §6.3.
 */
async function medicationContext(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  const [conditions, vitals, encounter, allergies, problems, tests, carePrograms, followups] = await Promise.all([
    sql`
      select condition_code as code, min(condition_name) as name, status
      from patient_condition
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      group by condition_code, status
      order by name
    `,
    sql`
      select recorded_at, systolic, diastolic, pulse, temperature_c
      from patient_vitals
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      order by recorded_at desc limit 1
    `,
    sql`
      select ce.id, ce.started_at
      from clinical_encounters ce
      join patient_profiles pp on pp.id = ce.patient_profile_id and pp.pharmacy_id = ${pharmacyId}
      where ce.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
      order by ce.started_at desc limit 1
    `,
    allergySummary(pharmacyId, customerId),
    problemSummary(pharmacyId, customerId),
    testSummary(pharmacyId, customerId),
    careProgramSummary(pharmacyId, customerId),
    followupSummary(pharmacyId, customerId),
  ]);

  return {
    conditions: conditions.map((c) => ({ code: c.code, name: c.name, status: c.status })),
    lastVitals: vitals[0]
      ? {
        recordedAt: vitals[0].recorded_at,
        systolic: vitals[0].systolic,
        diastolic: vitals[0].diastolic,
        pulse: vitals[0].pulse,
        temperature: vitals[0].temperature_c === null ? null : Number(vitals[0].temperature_c),
      }
      : null,
    lastConsultation: encounter[0] ? { id: encounter[0].id, startedAt: encounter[0].started_at } : null,
    // The allergy record (0058): the three-state answer and the current
    // allergies with their reactions. `state` is never read as "none" unless
    // a pharmacist said so — see allergies.js. Shown, never acted on: no
    // medicine here is checked against it (ALLERGIES_PLAN.md §5.4).
    allergies,
    // The problem list (0059): recorded current conditions, and — kept apart
    // and labelled — purchase inferences nobody has recorded. `conditions`
    // above stays the raw purchase inference for existing readers.
    problems,
    // Recent diagnostic results (0060) — shown beside the medicines, never
    // checked against them.
    tests,
    // Care programmes (0061): what this patient is being followed for, and
    // what is late. A pharmacist writing up a medicine should be able to see
    // that a monthly BP check is three weeks overdue without leaving the
    // screen. Shown, never acted on — nothing here starts or changes a
    // programme.
    carePrograms,
    // Follow-ups (0062): what needs to happen next for this patient, and what
    // is late. A pharmacist writing up a medicine should see that a repeat BP
    // is three weeks overdue without leaving the screen. Shown, never acted
    // on — nothing here creates, completes or cancels a follow-up.
    followups,
  };
}

module.exports = {
  listMedications, getMedication, addMedication, updateMedication, medicationContext,
};
