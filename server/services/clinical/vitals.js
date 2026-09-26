/**
 * Vitals and biometrics: recording a reading, and reading them back.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE, never by
 * checking ownership after an unscoped lookup — the rule GOLDEN-001 exists
 * for. The tests plant a reading on the same customer id under a second
 * pharmacy and prove it is never returned.
 *
 * WHAT IS DERIVED AND WHAT IS STORED. Stored: the numbers a person measured.
 * Derived on every read: BMI, and which readings sit outside the usual adult
 * range (vitalRanges.js). Neither is a column — see 0054's header.
 *
 * AGE TRAVELS WITH THE READINGS, because the ranges are adult ranges and
 * must not be applied to a child. listVitals fetches the patient's age
 * alongside them rather than letting each caller remember to.
 */

const { getSql, assertPharmacyId } = require('../db');
const { VITALS, ADULT_FROM, bmi, bmiClass, abnormalFlags } = require('./vitalRanges');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** The storage column for each reading, and back again. */
const COLUMNS = Object.freeze({
  systolic: 'systolic',
  diastolic: 'diastolic',
  pulse: 'pulse',
  spo2: 'spo2',
  respiratoryRate: 'respiratory_rate',
  temperature: 'temperature_c',
  weight: 'weight_kg',
  height: 'height_cm',
  muac: 'muac_cm',
});

/**
 * The reference bounds, for an adult only.
 *
 * Returned with the readings rather than published as a constant the client
 * could import, so the dashboard cannot draw a band for a patient the server
 * would not flag.
 */
function rangesFor(ageYears) {
  if (ageYears == null || ageYears < ADULT_FROM) return null;
  const out = {};
  for (const v of VITALS) {
    if (v.min === undefined) continue;
    out[v.key] = { min: v.min, max: v.max };
  }
  return out;
}

function shape(row, ageYears) {
  const reading = {
    id: row.id,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    notes: row.notes,
    systolic: row.systolic,
    diastolic: row.diastolic,
    pulse: row.pulse,
    spo2: row.spo2,
    respiratoryRate: row.respiratory_rate,
    // numeric comes back from postgres.js as a string, because it is exact
    // and a float would not be. The API hands out numbers, so the one place
    // that knows the column is numeric is the one place that converts.
    temperature: row.temperature_c == null ? null : Number(row.temperature_c),
    weight: row.weight_kg == null ? null : Number(row.weight_kg),
    height: row.height_cm == null ? null : Number(row.height_cm),
    muac: row.muac_cm == null ? null : Number(row.muac_cm),
  };
  const value = bmi(reading.weight, reading.height);
  return {
    ...reading,
    bmi: value,
    bmiClass: bmiClass(value, ageYears),
    // Which numbers on this row are outside the usual adult range. Empty for
    // a child or an unknown age, by design — see vitalRanges.js.
    abnormal: abnormalFlags(reading, ageYears),
  };
}

/**
 * This patient's readings, newest first, one page at a time.
 *
 * @param {string} pharmacyId
 * @param {string} customerId
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<{ total: number, ageYears: number|null, readings: object[] }>}
 */
async function listVitals(pharmacyId, customerId, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const size = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const from = Math.max(0, Number(offset) || 0);

  // The age the ranges are read against, from the date of birth where there
  // is one and the reported age otherwise — the same precedence as the
  // patient search (patientSearch.js).
  const [profile] = await sql`
    select coalesce(date_part('year', age(current_date, pp.date_of_birth))::int, pp.age_years) as age_years
    from customers c
    left join patient_profiles pp on pp.customer_id = c.id and pp.pharmacy_id = ${pharmacyId}
    where c.id = ${customerId} and c.pharmacy_id = ${pharmacyId}
  `;
  // No row means the patient is not this pharmacy's. Deliberately the same
  // empty answer as a patient with no readings: a caller must not be able to
  // tell "not yours" from "nothing recorded".
  if (!profile) return { total: 0, ageYears: null, readings: [] };

  const rows = await sql`
    select id, recorded_at, recorded_by, notes,
           systolic, diastolic, pulse, spo2, respiratory_rate, temperature_c,
           weight_kg, height_cm, muac_cm,
           count(*) over ()::int as total
    from patient_vitals
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    order by recorded_at desc, id
    limit ${size} offset ${from}
  `;

  return {
    total: rows[0]?.total ?? 0,
    ageYears: profile.age_years ?? null,
    // The bounds the chart shades as "the usual range", sent ONLY for an
    // adult. The dashboard never holds a clinical range of its own: if it
    // did, the band on the chart and the red in the table could disagree,
    // and the one a pharmacist believes is whichever they happened to look
    // at. For a child or an unknown age this is null, so there is nothing to
    // draw — the same rule as the flags.
    ranges: rangesFor(profile.age_years ?? null),
    readings: rows.map((r) => shape(r, profile.age_years ?? null)),
  };
}

/**
 * Every reading for the chart, oldest first.
 *
 * Separate from listVitals because the two answer different questions: the
 * table shows a page of the most recent, the chart needs the series in time
 * order. Bounded, because a chart of ten years of daily readings is not a
 * chart anybody reads.
 */
async function vitalsSeries(pharmacyId, customerId, { limit = 100 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const rows = await sql`
    select * from (
      select id, recorded_at, systolic, diastolic, pulse, spo2, respiratory_rate,
             temperature_c, weight_kg, height_cm, muac_cm
      from patient_vitals
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      order by recorded_at desc
      limit ${Math.min(Math.max(1, Number(limit) || 100), 500)}
    ) recent
    order by recorded_at
  `;
  return rows.map((r) => shape(r, null));
}

/**
 * Record one reading.
 *
 * @param {object} fields  already validated by vitalsInput.js — this service
 *                         stores what it is given and does not re-decide
 *                         which numbers are plausible; the column CHECKs in
 *                         0054 are the last word on that.
 */
async function recordVitals(pharmacyId, customerId, fields, { actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  // Prove the patient is this pharmacy's BEFORE writing, or a foreign
  // customer id would get a reading filed against it.
  const [customer] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) {
    const err = new Error('Patient not found.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const values = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    values[column] = fields[key] === undefined || fields[key] === '' ? null : fields[key];
  }

  const [row] = await sql`
    insert into patient_vitals ${sql({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    recorded_by: actorId,
    ...(fields.recordedAt ? { recorded_at: fields.recordedAt } : {}),
    notes: fields.notes || null,
    ...values,
  })}
    returning id, recorded_at, recorded_by, notes,
              systolic, diastolic, pulse, spo2, respiratory_rate, temperature_c,
              weight_kg, height_cm, muac_cm
  `;
  return shape(row, null);
}

module.exports = {
  listVitals, vitalsSeries, recordVitals, DEFAULT_LIMIT, MAX_LIMIT,
};
