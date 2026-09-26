/**
 * A patient's diagnostic tests: ordering one, recording what came back,
 * correcting it without losing what it said, and reading it over time.
 *
 * ONE ROW PER TEST EVENT (0060), with its values beside it. The three levels
 * FHIR separates stay distinct — why it was asked for, what the report says,
 * and each value with its own unit, range and reading — but a community
 * pharmacy's order and report are one event, so they are one row.
 *
 * NOTHING FINAL IS SILENTLY OVERWRITTEN. Editing a final, amended or
 * corrected report snapshots it into patient_test_corrections FIRST, with a
 * reason, and moves it to 'corrected'. "It used to say 8.1 %" stays
 * answerable.
 *
 * NO TEST BECOMES A DIAGNOSIS. A result may be shown beside a condition a
 * pharmacist recorded (through the catalogue's condition_code) and beside the
 * medicines for it. Neither is created, changed or implied here.
 *
 * WHO MAY DO WHAT is decided here, so the rule is tested against the
 * database: anyone may order a test or write down what a result said
 * (preliminary); only a pharmacist or owner may finalise, amend, correct or
 * cancel.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE — GOLDEN-001.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const {
  REPORTED, NEEDS_REASON, mergeForCheck, needsClinicalRole, hasClinicalRole, isAbnormal,
} = require('./testInput');

/** Reports that have been signed off, and may only be CORRECTED. */
const FINALISED = Object.freeze(['final', 'amended', 'corrected']);
/** What the screen calls "Completed". */
const COMPLETED = FINALISED;

function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const forbidden = (message) => httpError(403, 'FORBIDDEN_ROLE', message);

const TEST_SELECT = `
  t.id, t.definition_id, t.test_code, t.test_name, t.category, t.status, t.priority,
  t.reason, t.specimen, t.ordered_on::text as ordered_on, t.ordered_by, t.orderer_name,
  t.performed_at, t.performed_precision, t.performed_by_name,
  t.source, t.source_name, t.historical, t.encounter_id, t.report_summary, t.notes,
  t.status_reason, t.recorded_by, t.updated_by, t.created_at, t.updated_at,
  rb.email as recorded_by_email, ub.email as updated_by_email,
  e.started_at as encounter_started_at, e.presenting_complaint as encounter_complaint,
  d.condition_code as definition_condition_code
`;

const TEST_FROM = `
  from patient_tests t
  left join auth.users rb on rb.id = t.recorded_by
  left join auth.users ub on ub.id = t.updated_by
  left join clinical_encounters e on e.id = t.encounter_id and e.pharmacy_id = t.pharmacy_id
  left join test_definitions d on d.id = t.definition_id
`;

function shapeResult(r) {
  return {
    id: r.id,
    analyteName: r.analyte_name,
    analyteCode: r.analyte_code,
    valueNumber: r.value_number === null ? null : Number(r.value_number),
    unit: r.unit,
    valueCode: r.value_code,
    valueDisplay: r.value_display,
    valueText: r.value_text,
    referenceLow: r.reference_low === null ? null : Number(r.reference_low),
    referenceHigh: r.reference_high === null ? null : Number(r.reference_high),
    referenceText: r.reference_text,
    interpretation: r.interpretation,
    notes: r.notes,
  };
}

function shape(row, results = []) {
  return {
    id: row.id,
    definitionId: row.definition_id,
    testCode: row.test_code,
    testName: row.test_name,
    category: row.category,
    status: row.status,
    priority: row.priority,
    reason: row.reason,
    specimen: row.specimen,
    orderedOn: row.ordered_on,
    ordererName: row.orderer_name,
    performed: { at: row.performed_at, precision: row.performed_precision },
    performedByName: row.performed_by_name,
    source: row.source,
    sourceName: row.source_name,
    historical: row.historical,
    encounter: row.encounter_id
      ? { id: row.encounter_id, startedAt: row.encounter_started_at || null, complaint: row.encounter_complaint || null }
      : null,
    reportSummary: row.report_summary,
    notes: row.notes,
    statusReason: row.status_reason,
    conditionCode: row.definition_condition_code || null,
    recordedBy: row.recorded_by ? { id: row.recorded_by, email: row.recorded_by_email || null } : null,
    updatedBy: row.updated_by ? { id: row.updated_by, email: row.updated_by_email || null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    results,
    // What a pharmacist scans for: is there anything here to look at.
    abnormal: results.some((r) => isAbnormal(r.interpretation)),
    critical: results.some((r) => ['critical_high', 'critical_low'].includes(r.interpretation)),
  };
}

async function resultsFor(sql, pharmacyId, testIds) {
  const byTest = new Map();
  if (!testIds.length) return byTest;
  const rows = await sql`
    select id, test_id, analyte_name, analyte_code, value_number, unit, value_code,
           value_display, value_text, reference_low, reference_high, reference_text,
           interpretation, notes
    from patient_test_results
    where pharmacy_id = ${pharmacyId} and test_id = any(${testIds})
    order by position, created_at, id
  `;
  for (const r of rows) {
    if (!byTest.has(r.test_id)) byTest.set(r.test_id, []);
    byTest.get(r.test_id).push(shapeResult(r));
  }
  return byTest;
}

async function customerExists(sql, pharmacyId, customerId) {
  const [c] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  return Boolean(c);
}

/**
 * This patient's tests, newest first, with a count for each filter.
 *
 * Another pharmacy's patient reads like a patient with no tests.
 */
async function listTests(pharmacyId, customerId, { filter = null, category = null, q = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const empty = { tests: [], counts: { all: 0, ordered: 0, pending: 0, completed: 0, abnormal: 0, historical: 0 } };
  if (!(await customerExists(sql, pharmacyId, customerId))) return empty;

  const rows = await sql`
    select ${sql.unsafe(TEST_SELECT)} ${sql.unsafe(TEST_FROM)}
    where t.pharmacy_id = ${pharmacyId} and t.customer_id = ${customerId}
    order by coalesce(t.performed_at, t.ordered_on::timestamptz, t.created_at) desc, t.created_at desc
  `;
  const results = await resultsFor(sql, pharmacyId, rows.map((r) => r.id));
  const all = rows.map((r) => shape(r, results.get(r.id) || []));

  const counts = {
    all: all.length,
    ordered: all.filter((t) => t.status === 'ordered').length,
    pending: all.filter((t) => t.status === 'pending').length,
    completed: all.filter((t) => COMPLETED.includes(t.status)).length,
    abnormal: all.filter((t) => t.abnormal).length,
    historical: all.filter((t) => t.historical).length,
  };

  // Filtering happens here rather than in SQL because "abnormal" is a fact
  // about a test's RESULTS, and the counts above need the whole set anyway.
  const needle = (q || '').trim().toLowerCase();
  const tests = all.filter((t) => {
    if (filter === 'ordered' && t.status !== 'ordered') return false;
    if (filter === 'pending' && t.status !== 'pending') return false;
    if (filter === 'completed' && !COMPLETED.includes(t.status)) return false;
    if (filter === 'abnormal' && !t.abnormal) return false;
    if (filter === 'historical' && !t.historical) return false;
    if (category && t.category !== category) return false;
    if (needle && !t.testName.toLowerCase().includes(needle)) return false;
    return true;
  });
  return { tests, counts };
}

async function getTest(pharmacyId, customerId, id, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(TEST_SELECT)} ${db.unsafe(TEST_FROM)}
    where t.id = ${id} and t.pharmacy_id = ${pharmacyId} and t.customer_id = ${customerId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Test not found.');
  const results = await resultsFor(db, pharmacyId, [row.id]);
  const shaped = shape(row, results.get(row.id) || []);

  shaped.corrections = (await db`
    select c.id, c.snapshot, c.reason, c.created_at, u.email as corrected_by_email
    from patient_test_corrections c
    left join auth.users u on u.id = c.corrected_by
    where c.pharmacy_id = ${pharmacyId} and c.test_id = ${id}
    order by c.created_at desc
  `).map((c) => ({
    id: c.id, snapshot: c.snapshot, reason: c.reason, at: c.created_at, by: c.corrected_by_email || null,
  }));

  // RELATED, never derived: a condition a pharmacist recorded that shares
  // this test's house code, and the medicines for it. Read-only, and shown
  // only when they exist (brief §29).
  if (shaped.conditionCode) {
    shaped.relatedConditions = (await db`
      select id, condition_name, clinical_status, verification_status
      from patient_problems
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        and local_code = ${shaped.conditionCode}
        and clinical_status in ('active', 'recurrence', 'relapse')
        and verification_status not in ('refuted', 'entered_in_error')
      order by condition_name
    `).map((c) => ({
      id: c.id, conditionName: c.condition_name, clinicalStatus: c.clinical_status, verificationStatus: c.verification_status,
    }));
    shaped.relatedMedicines = (await db`
      select id, medicine_name, strength
      from medication_journeys
      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        and condition_code = ${shaped.conditionCode} and status in ('active', 'draft')
      order by medicine_name
    `).map((m) => ({ id: m.id, medicineName: m.medicine_name, strength: m.strength }));
  } else {
    shaped.relatedConditions = [];
    shaped.relatedMedicines = [];
  }
  return shaped;
}

/** A consultation is accepted only if it is THIS patient's, in THIS pharmacy. */
async function assertEncounter(sql, pharmacyId, customerId, encounterId) {
  if (!encounterId) return;
  const [e] = await sql`
    select e.id from clinical_encounters e
    join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
    where e.id = ${encounterId} and e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
  `;
  if (!e) {
    throw httpError(400, 'INVALID_TEST', 'That consultation is not one of this patient\'s.', { field: 'encounterId' });
  }
}

async function writeResults(tx, pharmacyId, testId, results) {
  await tx`delete from patient_test_results where test_id = ${testId} and pharmacy_id = ${pharmacyId}`;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    await tx`
      insert into patient_test_results ${tx({
    pharmacy_id: pharmacyId,
    test_id: testId,
    analyte_name: r.analyteName,
    analyte_code: r.analyteCode,
    position: i,
    value_number: r.valueNumber,
    unit: r.unit,
    value_code: r.valueCode,
    value_display: r.valueDisplay,
    value_text: r.valueText,
    reference_low: r.referenceLow,
    reference_high: r.referenceHigh,
    reference_text: r.referenceText,
    interpretation: r.interpretation,
    notes: r.notes,
  })}
    `;
  }
}

const actorType = (role) => (role === 'staff' ? 'staff' : 'pharmacist');

function event(pharmacyId, customerId, eventType, testId, { actorId, actorRole }, metadata) {
  return {
    pharmacyId,
    customerId,
    eventType,
    actorType: actorType(actorRole),
    actorId,
    entityType: 'patient_test',
    entityId: testId,
    metadata,
    idempotencyKey: `${eventType}:${testId}:${crypto.randomUUID()}`,
  };
}

const COLUMN = Object.freeze({
  testCode: 'test_code',
  testName: 'test_name',
  category: 'category',
  status: 'status',
  priority: 'priority',
  reason: 'reason',
  specimen: 'specimen',
  orderedOn: 'ordered_on',
  ordererName: 'orderer_name',
  performedAt: 'performed_at',
  performedPrecision: 'performed_precision',
  performedByName: 'performed_by_name',
  source: 'source',
  sourceName: 'source_name',
  historical: 'historical',
  encounterId: 'encounter_id',
  reportSummary: 'report_summary',
  notes: 'notes',
  statusReason: 'status_reason',
});

/** The flat, comparable form of a stored test — what a patch merges into. */
function flat(t) {
  return {
    testCode: t.testCode,
    testName: t.testName,
    category: t.category,
    status: t.status,
    priority: t.priority,
    reason: t.reason,
    specimen: t.specimen,
    orderedOn: t.orderedOn,
    ordererName: t.ordererName,
    performedAt: t.performed.at ? new Date(t.performed.at).toISOString().slice(0, 10) : null,
    performedPrecision: t.performed.precision,
    performedByName: t.performedByName,
    source: t.source,
    sourceName: t.sourceName,
    historical: t.historical,
    encounterId: t.encounter?.id || null,
    reportSummary: t.reportSummary,
    notes: t.notes,
    statusReason: t.statusReason,
    results: t.results,
  };
}

/** Order a test, or record a completed one in a single step. */
async function addTest(pharmacyId, customerId, fields, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (needsClinicalRole(fields) && !hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can finalise, amend, correct or cancel a test. Save the result as preliminary.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    if (!(await customerExists(tx, pharmacyId, customerId))) {
      throw httpError(404, 'NOT_FOUND', 'Patient not found.');
    }
    await assertEncounter(tx, pharmacyId, customerId, fields.encounterId);

    const [row] = await tx`
      insert into patient_tests ${tx({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    definition_id: fields.definitionId,
    test_code: fields.testCode,
    test_name: fields.testName,
    category: fields.category,
    status: fields.status,
    priority: fields.priority,
    reason: fields.reason,
    specimen: fields.specimen,
    ordered_on: fields.orderedOn,
    ordered_by: actorId,
    orderer_name: fields.ordererName,
    performed_at: fields.performedAt,
    performed_precision: fields.performedPrecision,
    performed_by_name: fields.performedByName,
    source: fields.source,
    source_name: fields.sourceName,
    historical: fields.historical,
    encounter_id: fields.encounterId,
    report_summary: fields.reportSummary,
    notes: fields.notes,
    status_reason: fields.statusReason,
    recorded_by: actorId,
    updated_by: actorId,
  })}
      returning id
    `;
    await writeResults(tx, pharmacyId, row.id, fields.results || []);
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId,
      fields.results.length ? PATIENT_EVENTS.TEST_RESULT_RECORDED : PATIENT_EVENTS.TEST_ORDERED,
      row.id, actor,
      {
        test: fields.testName,
        status: fields.status,
        source: fields.source,
        results: fields.results.map((r) => ({
          analyte: r.analyteName,
          value: r.valueNumber ?? r.valueCode ?? (r.valueText ? '(text)' : null),
          interpretation: r.interpretation,
        })),
      },
    ));
    return getTest(pharmacyId, customerId, row.id, { sql: tx });
  });
}

/**
 * Edit a test, add its results, or correct a report.
 *
 * A FINALISED report is snapshotted before anything changes and comes out
 * 'corrected' with a reason — the caller cannot edit one silently.
 */
async function updateTest(pharmacyId, customerId, id, patch, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    const [lock] = await tx`
      select id from patient_tests
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!lock) throw httpError(404, 'NOT_FOUND', 'Test not found.');
    const stored = await getTest(pharmacyId, customerId, id, { sql: tx });
    const before = flat(stored);
    // NOTHING TO DO IS NOTHING TO DO — decided before the correction rules,
    // so re-saving a finalised report unchanged does not demand a reason for
    // a change nobody made.
    const shortResult = (r) => `${r.analyteName}=${r.valueNumber ?? r.valueCode ?? r.valueText ?? ''}${r.unit || ''}:${r.interpretation || ''}`;
    const resultsChanged = Boolean(patch.results)
      && JSON.stringify((patch.results || []).map(shortResult)) !== JSON.stringify(before.results.map(shortResult));
    const touches = Object.entries(COLUMN).some(([key]) => (
      Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== before[key]
    ));
    if (!touches && !resultsChanged) return stored;

    // Changing a signed-off report is a CORRECTION, not an edit: it keeps
    // what the report said, and says why.
    const correcting = FINALISED.includes(before.status);
    const effective = { ...patch };
    // A corrected report SAYS it was corrected. A caller that sends the
    // status back unchanged (a form round-tripping what it loaded) does not
    // get to keep "Completed" on a report whose values just changed. An
    // explicit move elsewhere — amended, cancelled — is respected.
    if (correcting && (!effective.status || FINALISED.includes(effective.status))) {
      effective.status = effective.status === 'amended' ? 'amended' : 'corrected';
    }

    if (needsClinicalRole(effective, before) && !hasClinicalRole(actorRole)) {
      throw forbidden('Only a pharmacist can finalise, amend, correct or cancel a test.');
    }
    if (correcting && !effective.statusReason) {
      throw httpError(400, 'INVALID_TEST', 'Say why this result is being corrected.', { field: 'statusReason' });
    }
    const checked = mergeForCheck(before, effective);
    if (Object.prototype.hasOwnProperty.call(checked, 'encounterId')) {
      await assertEncounter(tx, pharmacyId, customerId, checked.encounterId);
    }

    const changes = {};
    for (const [key, col] of Object.entries(COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    if (Object.keys(changes).length === 0 && !resultsChanged) return stored;

    // The snapshot goes in BEFORE anything is written.
    if (correcting) {
      await tx`
        insert into patient_test_corrections ${tx({
    pharmacy_id: pharmacyId,
    test_id: id,
    snapshot: tx.json({
      status: before.status,
      performedAt: before.performedAt,
      reportSummary: before.reportSummary,
      results: before.results,
    }),
    reason: checked.statusReason || before.statusReason,
    corrected_by: actorId,
  })}
      `;
    }

    const set = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const c of Object.values(changes)) set[c.col] = c.to;
    await tx`update patient_tests set ${tx(set)} where id = ${id} and pharmacy_id = ${pharmacyId}`;
    if (resultsChanged) await writeResults(tx, pharmacyId, id, patch.results);

    const statusMoved = Boolean(changes.status);
    const audit = Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }]));
    if (resultsChanged) {
      audit.results = { from: before.results.map(shortResult), to: patch.results.map(shortResult) };
    }
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId,
      // RESULTS BEFORE STATUS: entering a result moves the status as a
      // consequence, and "a result was recorded" is what happened. A status
      // change on its own — finalised, cancelled — is its own event.
      correcting ? PATIENT_EVENTS.TEST_CORRECTED
        : resultsChanged ? PATIENT_EVENTS.TEST_RESULT_RECORDED
          : statusMoved ? PATIENT_EVENTS.TEST_STATUS_CHANGED : PATIENT_EVENTS.TEST_UPDATED,
      id, actor,
      {
        test: checked.testName || before.testName,
        changes: audit,
        ...(statusMoved || correcting ? { reason: (checked.statusReason ?? before.statusReason) || null } : {}),
      },
    ));
    return getTest(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * One analyte's values over time, oldest first — the trend (brief §22).
 *
 * Only numbers, only where the unit agrees, and only from reports somebody
 * has seen (preliminary and above). A chart of one point is not a trend, so
 * the caller is told how many there are and draws nothing below three.
 */
async function testTrend(pharmacyId, customerId, { code = null, name = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (!code && !name) return { points: [], unit: null, analyte: null };
  const sql = getSql();
  const rows = await sql`
    select r.analyte_name, r.analyte_code, r.value_number, r.unit, r.interpretation,
           r.reference_low, r.reference_high, t.performed_at, t.id as test_id
    from patient_test_results r
    join patient_tests t on t.id = r.test_id and t.pharmacy_id = r.pharmacy_id
    where r.pharmacy_id = ${pharmacyId} and t.customer_id = ${customerId}
      and r.value_number is not null and t.performed_at is not null
      and t.status in ('preliminary', 'final', 'amended', 'corrected')
      ${code ? sql`and r.analyte_code = ${code}` : sql`and lower(r.analyte_name) = lower(${name})`}
    order by t.performed_at
  `;
  if (!rows.length) return { points: [], unit: null, analyte: null };
  // One unit only: 100 mg/dL and 5.5 mmol/L on one axis is a lie.
  const unit = rows[0].unit;
  const points = rows
    .filter((r) => (r.unit || null) === (unit || null))
    .map((r) => ({
      at: r.performed_at,
      value: Number(r.value_number),
      interpretation: r.interpretation,
      testId: r.test_id,
    }));
  const ranges = rows[0].reference_low !== null || rows[0].reference_high !== null
    ? { min: rows[0].reference_low === null ? null : Number(rows[0].reference_low),
      max: rows[0].reference_high === null ? null : Number(rows[0].reference_high) }
    : null;
  return { analyte: rows[0].analyte_name, code: rows[0].analyte_code, unit, points, ranges };
}

/** The catalogue a form offers: this pharmacy's own rows and the shipped ones. */
async function testCatalogue(pharmacyId, query, { limit = 15 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const q = String(query || '').trim();
  const rows = await sql`
    select id, code, name, category, result_type, specimen_default, unit,
           reference_low, reference_high, coded_options, analytes, condition_code
    from test_definitions
    where (pharmacy_id is null or pharmacy_id = ${pharmacyId}) and active
      ${q.length >= 2 ? sql`and (name ilike ${`%${q}%`} or code ilike ${`%${q}%`})` : sql``}
    order by name
    limit ${Math.min(Math.max(Number(limit) || 15, 1), 60)}
  `;
  return rows.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
    category: d.category,
    resultType: d.result_type,
    specimen: d.specimen_default,
    unit: d.unit,
    referenceLow: d.reference_low === null ? null : Number(d.reference_low),
    referenceHigh: d.reference_high === null ? null : Number(d.reference_high),
    codedOptions: d.coded_options || [],
    analytes: d.analytes || [],
    conditionCode: d.condition_code,
  }));
}

/**
 * The compact form other screens show: the last few reported tests, and how
 * many need looking at.
 */
async function testSummary(pharmacyId, customerId, { limit = 3 } = {}) {
  const { tests, counts } = await listTests(pharmacyId, customerId);
  const reported = tests.filter((t) => REPORTED.includes(t.status)).slice(0, limit);
  return {
    counts,
    pending: counts.ordered + counts.pending,
    recent: reported.map((t) => ({
      id: t.id,
      testName: t.testName,
      status: t.status,
      performedAt: t.performed.at,
      abnormal: t.abnormal,
      critical: t.critical,
      // The headline value, for a one-line summary: the first result.
      result: t.results[0]
        ? {
          value: t.results[0].valueNumber ?? t.results[0].valueDisplay ?? t.results[0].valueText,
          unit: t.results[0].unit,
          interpretation: t.results[0].interpretation,
        }
        : null,
    })),
  };
}

module.exports = {
  FINALISED, COMPLETED, NEEDS_REASON,
  listTests, getTest, addTest, updateTest, testTrend, testCatalogue, testSummary,
};
