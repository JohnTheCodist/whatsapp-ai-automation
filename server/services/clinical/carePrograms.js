/**
 * A patient's care programmes: enrolling them, the goals, the plan, and what
 * is due.
 *
 * IT ORGANISES THE OTHER RECORDS AND COPIES NONE OF THEM (0061). No reading,
 * no medicine, no result and no diagnosis is written here. A goal says WHERE
 * its current value is read from and is read there on display; an activity
 * says what it produced by id. Conditions stay in patient_problems, medicines
 * in medication_journeys, tests in patient_tests, vitals in patient_vitals.
 *
 * AN ACTIVITY IS THE TASK. This is the first task concept in the product, so
 * there is nothing to integrate with and nothing duplicated: a follow-up is an
 * activity with a due date.
 *
 * ENROLLING IN A TEMPLATE COPIES IT ONCE. The definition's goals and
 * activities become this patient's own rows, dated from the start day, and the
 * template is never consulted again — so editing one of them is editing this
 * patient's plan, not a shared template (the plan, question 1).
 *
 * COMPLETING A RECURRING ACTIVITY CREATES EXACTLY ONE NEXT OCCURRENCE, in the
 * same transaction, linked to the one it followed. The completed one is kept.
 *
 * NOTHING IS DELETED BY A STATUS CHANGE. Completing or discontinuing a
 * programme keeps every goal and activity it had. Goals and activities
 * themselves can be removed while the plan is being written — they are plan
 * items, not clinical records — and the removal is audited.
 *
 * WHO MAY DO WHAT is decided here, so the rule is tested against the
 * database: anyone may enrol a patient, write the plan and tick off a task;
 * only a pharmacist or owner may COMPLETE, DISCONTINUE or CANCEL a programme,
 * because those close a course of care.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE — GOLDEN-001.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { lagosDate } = require('../refills/refillSchedule');
// The sections that OWN the numbers a programme watches. Monitoring reads
// through these rather than querying patient_vitals and patient_test_results
// itself, so a panel here cannot drift from the Vitals or Tests screen.
const { vitalsSeries } = require('./vitals');
const { testTrend } = require('./tests');
const {
  TASK_SELECT, TASK_FROM, shapeTask, insertTask,
} = require('./taskRow');
const {
  OPEN_STATUSES, ENDED_STATUSES, ACTIVITY_DROPPED,
  mergeProgramForCheck, mergeGoalForCheck, mergeActivityForCheck,
  needsClinicalRole, hasClinicalRole, nextOccurrence, progressFrom, planFromDefinition,
  monitoringSpec,
} = require('./careProgramInput');

function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const forbidden = (message) => httpError(403, 'FORBIDDEN_ROLE', message);
const notFound = (what) => httpError(404, 'NOT_FOUND', `${what} not found.`);

const PROGRAM_SELECT = `
  p.id, p.definition_id, p.program_code, p.program_name, p.condition_code, p.status,
  p.enrolled_on::text as enrolled_on, p.start_date::text as start_date,
  p.next_review_on::text as next_review_on, p.end_date::text as end_date,
  p.responsible_user_id, p.responsible_name, p.reason, p.notes,
  p.outcome, p.outcome_notes, p.follow_up_recommendation, p.discontinuation_reason,
  p.status_reason, p.recorded_by, p.updated_by, p.created_at, p.updated_at,
  rb.email as recorded_by_email, ub.email as updated_by_email,
  ru.email as responsible_email,
  d.name as definition_name, d.description as definition_description
`;

const PROGRAM_FROM = `
  from patient_care_programs p
  left join auth.users rb on rb.id = p.recorded_by
  left join auth.users ub on ub.id = p.updated_by
  left join auth.users ru on ru.id = p.responsible_user_id
  left join care_program_definitions d on d.id = p.definition_id
`;

function shapeProgram(row) {
  return {
    id: row.id,
    definitionId: row.definition_id,
    programCode: row.program_code,
    // The name AS ENROLLED. The definition's current name travels beside it so
    // a renamed template is visible, and never replaces what was agreed.
    programName: row.program_name,
    definitionName: row.definition_name || null,
    description: row.definition_description || null,
    conditionCode: row.condition_code,
    status: row.status,
    enrolledOn: row.enrolled_on,
    startDate: row.start_date,
    nextReviewOn: row.next_review_on,
    endDate: row.end_date,
    responsible: row.responsible_user_id || row.responsible_name
      ? {
        id: row.responsible_user_id || null,
        name: row.responsible_name || null,
        email: row.responsible_email || null,
      }
      : null,
    reason: row.reason,
    notes: row.notes,
    outcome: row.outcome,
    outcomeNotes: row.outcome_notes,
    followUpRecommendation: row.follow_up_recommendation,
    discontinuationReason: row.discontinuation_reason,
    statusReason: row.status_reason,
    recordedBy: row.recorded_by ? { id: row.recorded_by, email: row.recorded_by_email || null } : null,
    updatedBy: row.updated_by ? { id: row.updated_by, email: row.updated_by_email || null } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeGoal(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    measure: r.measure,
    measureSource: r.measure_source,
    measureCode: r.measure_code,
    unit: r.unit,
    baselineValue: r.baseline_value === null ? null : Number(r.baseline_value),
    baselineOn: r.baseline_on,
    targetValue: r.target_value === null ? null : Number(r.target_value),
    targetText: r.target_text,
    targetDate: r.target_date,
    achievedOn: r.achieved_on,
    statusReason: r.status_reason,
    position: r.position,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const GOAL_SELECT = `
  id, title, description, status, measure, measure_source, measure_code, unit,
  baseline_value, baseline_on::text as baseline_on, target_value, target_text,
  target_date::text as target_date, achieved_on::text as achieved_on,
  status_reason, position, notes, created_at, updated_at, program_id
`;

async function goalsFor(sql, pharmacyId, programIds) {
  const byProgram = new Map();
  if (!programIds.length) return byProgram;
  const rows = await sql`
    select ${sql.unsafe(GOAL_SELECT)} from care_program_goals
    where pharmacy_id = ${pharmacyId} and program_id = any(${programIds})
    order by position, created_at, id
  `;
  for (const r of rows) {
    if (!byProgram.has(r.program_id)) byProgram.set(r.program_id, []);
    byProgram.get(r.program_id).push(shapeGoal(r));
  }
  return byProgram;
}

async function activitiesFor(sql, pharmacyId, programIds) {
  const byProgram = new Map();
  if (!programIds.length) return byProgram;
  const rows = await sql`
    select ${sql.unsafe(TASK_SELECT)} ${sql.unsafe(TASK_FROM)}
    where a.pharmacy_id = ${pharmacyId} and a.program_id = any(${programIds})
    order by a.position, a.created_at, a.id
  `;
  for (const r of rows) {
    if (!byProgram.has(r.program_id)) byProgram.set(r.program_id, []);
    byProgram.get(r.program_id).push(shapeTask(r));
  }
  return byProgram;
}

async function customerExists(sql, pharmacyId, customerId) {
  const [c] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  return Boolean(c);
}

/**
 * The programmes a pharmacy may enrol someone in: the shipped templates plus
 * its own. The shipped rows have pharmacy_id null and are readable by every
 * tenant — the same shape as the test catalogue (0060).
 */
async function careProgramCatalogue(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const rows = await sql`
    select id, pharmacy_id, code, name, description, condition_code,
           goals, activities, monitoring, default_review_days
    from care_program_definitions
    where active and (pharmacy_id is null or pharmacy_id = ${pharmacyId})
    order by pharmacy_id nulls first, name
  `;
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    conditionCode: r.condition_code,
    goals: r.goals || [],
    activities: r.activities || [],
    monitoring: r.monitoring || [],
    defaultReviewDays: r.default_review_days,
    shipped: r.pharmacy_id === null,
  }));
}

/**
 * This patient's programmes: the open ones, then the ones that have ended,
 * each with its progress counted.
 *
 * Another pharmacy's patient reads like a patient with no programmes.
 */
async function listPrograms(pharmacyId, customerId, { today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const day = today || lagosDate();
  const empty = { active: [], past: [], counts: { active: 0, past: 0, overdueTasks: 0, dueForReview: 0 } };
  if (!(await customerExists(sql, pharmacyId, customerId))) return empty;

  const rows = await sql`
    select ${sql.unsafe(PROGRAM_SELECT)} ${sql.unsafe(PROGRAM_FROM)}
    where p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
    order by p.enrolled_on desc, p.created_at desc
  `;
  const ids = rows.map((r) => r.id);
  const goals = await goalsFor(sql, pharmacyId, ids);
  const activities = await activitiesFor(sql, pharmacyId, ids);

  const all = rows.map((r) => ({
    ...shapeProgram(r),
    progress: progressFrom(goals.get(r.id) || [], activities.get(r.id) || [], { today: day }),
  }));

  const active = all.filter((p) => OPEN_STATUSES.includes(p.status));
  const past = all.filter((p) => ENDED_STATUSES.includes(p.status));
  return {
    active,
    past,
    counts: {
      active: active.length,
      past: past.length,
      overdueTasks: active.reduce((n, p) => n + p.progress.activities.overdue, 0),
      dueForReview: active.filter((p) => p.nextReviewOn && p.nextReviewOn <= day).length,
    },
  };
}

/** One programme with its plan. */
async function getProgram(pharmacyId, customerId, id, { sql = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const day = today || lagosDate();
  const [row] = await db`
    select ${db.unsafe(PROGRAM_SELECT)} ${db.unsafe(PROGRAM_FROM)}
    where p.id = ${id} and p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
  `;
  if (!row) throw notFound('Care programme');
  const goals = (await goalsFor(db, pharmacyId, [id])).get(id) || [];
  const activities = (await activitiesFor(db, pharmacyId, [id])).get(id) || [];
  return {
    ...shapeProgram(row),
    goals,
    activities,
    progress: progressFrom(goals, activities, { today: day }),
  };
}

const actorType = (role) => (role === 'staff' ? 'staff' : 'pharmacist');

function event(pharmacyId, customerId, eventType, programId, { actorId, actorRole }, metadata) {
  return {
    pharmacyId,
    customerId,
    eventType,
    actorType: actorType(actorRole),
    actorId,
    // The PROGRAMME, always — a goal or activity can be removed and its
    // history has to survive that.
    entityType: 'patient_care_program',
    entityId: programId,
    metadata,
    idempotencyKey: `${eventType}:${programId}:${crypto.randomUUID()}`,
  };
}

async function insertGoal(tx, pharmacyId, programId, g, actorId) {
  const [row] = await tx`
    insert into care_program_goals ${tx({
    pharmacy_id: pharmacyId,
    program_id: programId,
    title: g.title,
    description: g.description,
    status: g.status,
    measure: g.measure,
    measure_source: g.measureSource,
    measure_code: g.measureCode,
    unit: g.unit,
    baseline_value: g.baselineValue,
    baseline_on: g.baselineOn,
    target_value: g.targetValue,
    target_text: g.targetText,
    target_date: g.targetDate,
    achieved_on: g.achievedOn,
    status_reason: g.statusReason,
    position: g.position,
    notes: g.notes,
    recorded_by: actorId,
    updated_by: actorId,
  })}
    returning id
  `;
  return row.id;
}

/** A programme's activity is a patient task with a programme id on it. */
async function insertActivity(tx, pharmacyId, customerId, programId, a, actorId) {
  return insertTask(tx, pharmacyId, customerId, programId, a, actorId);
}

/**
 * The open programme this patient already has for the same template, if any.
 * Two live "Diabetes care" programmes are a double-click, not two courses of
 * care — the caller is offered the existing one instead.
 */
async function openDuplicate(sql, pharmacyId, customerId, definitionId) {
  if (!definitionId) return null;
  const [row] = await sql`
    select id, program_name, status from patient_care_programs
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      and definition_id = ${definitionId}
      and status in ('planned', 'active', 'on_hold')
    limit 1
  `;
  return row || null;
}

/**
 * Enrol a patient.
 *
 * `plan` is the goals and activities to create with it — the template's,
 * expanded and possibly edited on the enrolment screen, or nothing.
 */
async function enrolProgram(pharmacyId, customerId, fields, {
  plan = null, actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  if (needsClinicalRole(fields) && !hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can end a care programme.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    if (!(await customerExists(tx, pharmacyId, customerId))) throw notFound('Patient');

    const existing = await openDuplicate(tx, pharmacyId, customerId, fields.definitionId);
    if (existing) {
      throw httpError(409, 'DUPLICATE_ACTIVE_PROGRAM',
        `${existing.program_name} is already open for this patient.`,
        { existing: { id: existing.id, label: existing.program_name } });
    }

    const [row] = await tx`
      insert into patient_care_programs ${tx({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    definition_id: fields.definitionId,
    program_code: fields.programCode,
    program_name: fields.programName,
    condition_code: fields.conditionCode,
    status: fields.status,
    enrolled_on: fields.enrolledOn,
    start_date: fields.startDate,
    next_review_on: fields.nextReviewOn,
    end_date: fields.endDate,
    responsible_user_id: fields.responsibleUserId,
    responsible_name: fields.responsibleName,
    reason: fields.reason,
    notes: fields.notes,
    outcome: fields.outcome,
    outcome_notes: fields.outcomeNotes,
    follow_up_recommendation: fields.followUpRecommendation,
    discontinuation_reason: fields.discontinuationReason,
    status_reason: fields.statusReason,
    recorded_by: actorId,
    updated_by: actorId,
  })}
      returning id
    `;

    const goals = (plan && plan.goals) || [];
    const activities = (plan && plan.activities) || [];
    // Activities may name a goal BY POSITION in the same submission, since
    // neither has an id until now.
    const goalIds = [];
    for (const g of goals) goalIds.push(await insertGoal(tx, pharmacyId, row.id, g, actorId));
    for (const a of activities) {
      const goalId = Number.isInteger(a.goalIndex) && goalIds[a.goalIndex] ? goalIds[a.goalIndex] : null;
      await insertActivity(tx, pharmacyId, customerId, row.id, { ...a, goalId }, actorId);
    }

    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_ENROLLED, row.id, actor,
      {
        program: fields.programName,
        code: fields.programCode,
        status: fields.status,
        fromTemplate: Boolean(fields.definitionId),
        goals: goals.length,
        activities: activities.length,
        reason: fields.reason || null,
      },
    ));
    return getProgram(pharmacyId, customerId, row.id, { sql: tx, today });
  });
}

const PROGRAM_COLUMN = Object.freeze({
  programName: 'program_name',
  status: 'status',
  startDate: 'start_date',
  nextReviewOn: 'next_review_on',
  endDate: 'end_date',
  responsibleUserId: 'responsible_user_id',
  responsibleName: 'responsible_name',
  reason: 'reason',
  notes: 'notes',
  outcome: 'outcome',
  outcomeNotes: 'outcome_notes',
  followUpRecommendation: 'follow_up_recommendation',
  discontinuationReason: 'discontinuation_reason',
  statusReason: 'status_reason',
});

/** The flat, comparable form of a stored programme — what a patch merges into. */
function flatProgram(p) {
  const out = {};
  for (const key of Object.keys(PROGRAM_COLUMN)) out[key] = p[key] ?? null;
  out.responsibleUserId = p.responsible ? p.responsible.id : null;
  out.responsibleName = p.responsible ? p.responsible.name : null;
  return out;
}

/**
 * Edit a programme, or change where it is in its life — including ending it.
 *
 * Ending one is a clinical statement and needs a pharmacist. Nothing is
 * deleted: the goals and activities stay exactly as they are.
 */
async function updateProgram(pharmacyId, customerId, id, patch, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    const [lock] = await tx`
      select id from patient_care_programs
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!lock) throw notFound('Care programme');
    const stored = await getProgram(pharmacyId, customerId, id, { sql: tx, today: day });
    const before = flatProgram(stored);

    if (needsClinicalRole(patch, before) && !hasClinicalRole(actorRole)) {
      throw forbidden('Only a pharmacist can complete, discontinue or cancel a care programme.');
    }
    const checked = mergeProgramForCheck(before, patch, { today: day });

    const changes = {};
    for (const [key, col] of Object.entries(PROGRAM_COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    if (Object.keys(changes).length === 0) return stored;

    const set = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const c of Object.values(changes)) set[c.col] = c.to;
    await tx`update patient_care_programs set ${tx(set)} where id = ${id} and pharmacy_id = ${pharmacyId}`;

    const audit = Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }]));
    const next = checked.status || before.status;
    const statusMoved = Boolean(changes.status);
    // "It was completed" and "it was stopped" are different facts, and a
    // pharmacist reading a timeline reads them differently.
    const eventType = statusMoved && next === 'completed' ? PATIENT_EVENTS.CARE_PROGRAM_COMPLETED
      : statusMoved && next === 'discontinued' ? PATIENT_EVENTS.CARE_PROGRAM_DISCONTINUED
        : statusMoved ? PATIENT_EVENTS.CARE_PROGRAM_STATUS_CHANGED
          : PATIENT_EVENTS.CARE_PROGRAM_UPDATED;

    await recordClinicalEvent(tx, event(pharmacyId, customerId, eventType, id, actor, {
      program: checked.programName || before.programName,
      changes: audit,
      ...(statusMoved ? {
        outcome: (checked.outcome ?? before.outcome) || null,
        reason: (checked.statusReason ?? before.statusReason)
          || (checked.discontinuationReason ?? before.discontinuationReason) || null,
      } : {}),
    }));
    return getProgram(pharmacyId, customerId, id, { sql: tx, today: day });
  });
}

/** The programme row, locked, or 404 — every write inside a programme goes through here. */
async function lockProgram(tx, pharmacyId, customerId, programId) {
  const [row] = await tx`
    select id, program_name, status from patient_care_programs
    where id = ${programId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    for update
  `;
  if (!row) throw notFound('Care programme');
  return row;
}

/** A goal is this programme's, or it does not exist as far as this call goes. */
async function assertGoal(tx, pharmacyId, programId, goalId) {
  if (!goalId) return;
  const [g] = await tx`
    select id from care_program_goals
    where id = ${goalId} and pharmacy_id = ${pharmacyId} and program_id = ${programId}
  `;
  if (!g) {
    throw httpError(400, 'INVALID_CARE_PROGRAM', 'That goal is not one of this programme\'s.', { field: 'goalId' });
  }
}

async function addGoal(pharmacyId, customerId, programId, fields, { actorId = null, actorRole = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    const goalId = await insertGoal(tx, pharmacyId, programId, fields, actorId);
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_GOAL_CHANGED, programId, actor,
      { program: program.program_name, action: 'added', goal: fields.title, goalId, status: fields.status },
    ));
    return getProgram(pharmacyId, customerId, programId, { sql: tx, today });
  });
}

const GOAL_COLUMN = Object.freeze({
  title: 'title',
  description: 'description',
  status: 'status',
  measure: 'measure',
  measureSource: 'measure_source',
  measureCode: 'measure_code',
  unit: 'unit',
  baselineValue: 'baseline_value',
  baselineOn: 'baseline_on',
  targetValue: 'target_value',
  targetText: 'target_text',
  targetDate: 'target_date',
  achievedOn: 'achieved_on',
  statusReason: 'status_reason',
  position: 'position',
  notes: 'notes',
});

async function updateGoal(pharmacyId, customerId, programId, goalId, patch, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    const [row] = await tx`
      select ${tx.unsafe(GOAL_SELECT)} from care_program_goals
      where id = ${goalId} and pharmacy_id = ${pharmacyId} and program_id = ${programId}
      for update
    `;
    if (!row) throw notFound('Goal');
    const before = shapeGoal(row);
    const checked = mergeGoalForCheck(before, patch, { today: day });

    const changes = {};
    for (const [key, col] of Object.entries(GOAL_COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    if (Object.keys(changes).length === 0) return getProgram(pharmacyId, customerId, programId, { sql: tx, today: day });

    const set = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const c of Object.values(changes)) set[c.col] = c.to;
    await tx`update care_program_goals set ${tx(set)} where id = ${goalId} and pharmacy_id = ${pharmacyId}`;

    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_GOAL_CHANGED, programId, actor,
      {
        program: program.program_name,
        action: 'updated',
        goal: checked.title || before.title,
        goalId,
        changes: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }])),
      },
    ));
    return getProgram(pharmacyId, customerId, programId, { sql: tx, today: day });
  });
}

/**
 * Remove a goal from the plan.
 *
 * A goal is a PLAN ITEM, not a clinical record — nothing clinical was ever
 * stored on it — so it can be taken out while the plan is being written. The
 * removal is audited with what it said, and the activities that served it keep
 * their own rows (0061 sets their goal_id to null).
 */
async function removeGoal(pharmacyId, customerId, programId, goalId, { actorId = null, actorRole = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    const [row] = await tx`
      select id, title, status from care_program_goals
      where id = ${goalId} and pharmacy_id = ${pharmacyId} and program_id = ${programId}
    `;
    if (!row) throw notFound('Goal');
    await tx`delete from care_program_goals where id = ${goalId} and pharmacy_id = ${pharmacyId}`;
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_GOAL_CHANGED, programId, actor,
      { program: program.program_name, action: 'removed', goal: row.title, goalId, status: row.status },
    ));
    return getProgram(pharmacyId, customerId, programId, { sql: tx, today });
  });
}

async function addActivity(pharmacyId, customerId, programId, fields, { actorId = null, actorRole = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    await assertGoal(tx, pharmacyId, programId, fields.goalId);
    await assertLink(tx, pharmacyId, customerId, fields.linkedType, fields.linkedId);
    const activityId = await insertActivity(tx, pharmacyId, customerId, programId, fields, actorId);
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_ACTIVITY_CHANGED, programId, actor,
      {
        program: program.program_name,
        action: 'added',
        activity: fields.title,
        activityId,
        kind: fields.kind,
        dueOn: fields.dueOn,
        repeats: fields.recurrence || null,
      },
    ));
    return getProgram(pharmacyId, customerId, programId, { sql: tx, today });
  });
}

// What the CARE PROGRAM tab may patch on an activity: deliberately a subset of
// taskRow's TASK_COLUMN. Priority, reason, source and outcome belong to the
// Follow-up screen, which is where a task is worked rather than planned.
const ACTIVITY_COLUMN = Object.freeze({
  goalId: 'goal_id',
  title: 'title',
  description: 'description',
  kind: 'kind',
  status: 'status',
  dueOn: 'due_on',
  assignedToUserId: 'assigned_to_user_id',
  assignedToName: 'assigned_to_name',
  outcomeNote: 'outcome_note',
  linkedType: 'linked_type',
  linkedId: 'linked_id',
  statusReason: 'status_reason',
  position: 'position',
  notes: 'notes',
});

/**
 * What an activity produced has to be a real record, belonging to this
 * pharmacy AND this patient. There is no foreign key (the target is one of
 * five tables), so this check is the guarantee — and it is checked at the
 * database, never against an id the caller also supplied the tenant for.
 */
async function assertLink(tx, pharmacyId, customerId, kind, refId) {
  if (!kind || !refId) return;
  const [row] = kind === 'vitals'
    ? await tx`select id from patient_vitals where id = ${refId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}`
    : kind === 'test'
      ? await tx`select id from patient_tests where id = ${refId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}`
      : kind === 'medication'
        ? await tx`select id from medication_journeys where id = ${refId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}`
        : kind === 'condition'
          ? await tx`select id from patient_problems where id = ${refId} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}`
          : await tx`
              select e.id from clinical_encounters e
              join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
              where e.id = ${refId} and e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId}
            `;
  if (!row) {
    throw httpError(400, 'INVALID_CARE_PROGRAM', 'That record is not one of this patient\'s.', { field: 'linkedId' });
  }
}

/**
 * Edit an activity, tick it off, or drop it.
 *
 * COMPLETING A RECURRING ONE CREATES EXACTLY ONE NEXT OCCURRENCE, here, in the
 * same transaction. The completed row is kept, and the new one points back at
 * it, so "this is the fourth monthly BP check" is answerable.
 */
async function updateActivity(pharmacyId, customerId, programId, activityId, patch, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    const [row] = await tx`
      select ${tx.unsafe(TASK_SELECT)} ${tx.unsafe(TASK_FROM)}
      where a.id = ${activityId} and a.pharmacy_id = ${pharmacyId} and a.program_id = ${programId}
      for update of a
    `;
    if (!row) throw notFound('Task');
    const stored = shapeTask(row);
    const before = {};
    for (const key of Object.keys(ACTIVITY_COLUMN)) before[key] = stored[key] ?? null;
    before.recurrence = stored.recurrence;

    if (Object.prototype.hasOwnProperty.call(patch, 'goalId')) {
      await assertGoal(tx, pharmacyId, programId, patch.goalId);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'linkedId')) {
      await assertLink(tx, pharmacyId, customerId, patch.linkedType, patch.linkedId);
    }
    const checked = mergeActivityForCheck(before, patch);

    const changes = {};
    for (const [key, col] of Object.entries(ACTIVITY_COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    const recurrenceChanged = Object.prototype.hasOwnProperty.call(checked, 'recurrence')
      && JSON.stringify(checked.recurrence || null) !== JSON.stringify(before.recurrence || null);
    if (Object.keys(changes).length === 0 && !recurrenceChanged) {
      return getProgram(pharmacyId, customerId, programId, { sql: tx, today: day });
    }

    const completing = checked.status === 'completed' && before.status !== 'completed';
    const set = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const c of Object.values(changes)) set[c.col] = c.to;
    if (recurrenceChanged) set.recurrence = checked.recurrence ? tx.json(checked.recurrence) : null;
    if (completing) {
      set.completed_at = new Date().toISOString();
      set.completed_by = actorId;
    }
    // Reopening a task drops the completion it no longer has. The audit keeps it.
    if (before.status === 'completed' && checked.status && checked.status !== 'completed') {
      set.completed_at = null;
      set.completed_by = null;
    }
    // Cancelling says WHEN, the same way completing does (0062's CHECK). This
    // was missing until the column existed: a cancelled activity recorded its
    // reason and not the day somebody decided it.
    if (checked.status === 'cancelled' && before.status !== 'cancelled') {
      set.cancelled_at = new Date().toISOString();
      set.cancelled_by = actorId;
    }
    if (before.status === 'cancelled' && checked.status && checked.status !== 'cancelled') {
      set.cancelled_at = null;
      set.cancelled_by = null;
    }
    await tx`update patient_tasks set ${tx(set)} where id = ${activityId} and pharmacy_id = ${pharmacyId}`;

    let created = null;
    const recurrence = recurrenceChanged ? checked.recurrence : before.recurrence;
    if (completing && recurrence) {
      const nextRow = nextOccurrence({
        ...stored,
        ...checked,
        recurrence,
        dueOn: checked.dueOn !== undefined ? checked.dueOn : stored.dueOn,
        id: activityId,
      }, { today: day });
      if (nextRow) {
        const newId = await insertActivity(tx, pharmacyId, customerId, programId, nextRow, actorId);
        created = { id: newId, dueOn: nextRow.dueOn };
      }
    }

    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_ACTIVITY_CHANGED, programId, actor,
      {
        program: program.program_name,
        action: completing ? 'completed' : ACTIVITY_DROPPED.includes(checked.status) ? checked.status : 'updated',
        activity: checked.title || before.title,
        activityId,
        changes: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }])),
        ...(created ? { nextDue: created.dueOn, nextActivityId: created.id } : {}),
        ...(checked.statusReason ? { reason: checked.statusReason } : {}),
      },
    ));
    return getProgram(pharmacyId, customerId, programId, { sql: tx, today: day });
  });
}

/**
 * Remove an activity from the plan.
 *
 * Same reasoning as a goal: it is a plan item. A task somebody DID is not
 * removed this way — the screen offers "skipped" or "cancelled" for that,
 * which keeps the row and its reason. The service refuses to delete one that
 * has been completed, so a done thing cannot be made to have never happened.
 */
async function removeActivity(pharmacyId, customerId, programId, activityId, { actorId = null, actorRole = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    const [row] = await tx`
      select id, title, status, kind from patient_tasks
      where id = ${activityId} and pharmacy_id = ${pharmacyId} and program_id = ${programId}
    `;
    if (!row) throw notFound('Task');
    if (row.status === 'completed') {
      throw httpError(409, 'ACTIVITY_COMPLETED',
        'This task has been done. Cancel it instead, which keeps what happened.');
    }
    await tx`delete from patient_tasks where id = ${activityId} and pharmacy_id = ${pharmacyId}`;
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_ACTIVITY_CHANGED, programId, actor,
      { program: program.program_name, action: 'removed', activity: row.title, activityId, kind: row.kind },
    ));
    return getProgram(pharmacyId, customerId, programId, { sql: tx, today });
  });
}

/**
 * The template's plan, expanded for this patient — what the enrolment screen
 * shows before anything is saved. Reading the definition is a database act, so
 * it lives here rather than in the pure contract.
 */
async function planForDefinition(pharmacyId, definitionId, { today = null, startDate = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const [row] = await sql`
    select id, code, name, description, condition_code, goals, activities, monitoring, default_review_days
    from care_program_definitions
    where id = ${definitionId} and active and (pharmacy_id is null or pharmacy_id = ${pharmacyId})
  `;
  if (!row) throw notFound('Care programme template');
  const definition = {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    conditionCode: row.condition_code,
    goals: row.goals || [],
    activities: row.activities || [],
    monitoring: row.monitoring || [],
    defaultReviewDays: row.default_review_days,
  };
  return { definition, plan: planFromDefinition(definition, { today: today || lagosDate(), startDate }) };
}

// ---------------------------------------------------------------------------
// The connections (phase 2): monitoring, related records, the timeline
// ---------------------------------------------------------------------------

/** The programme row plus its definition's monitoring list, or 404. */
async function programWithSpec(sql, pharmacyId, customerId, programId) {
  const [row] = await sql`
    select p.id, p.condition_code, p.definition_id, d.monitoring
    from patient_care_programs p
    left join care_program_definitions d on d.id = p.definition_id
    where p.id = ${programId} and p.pharmacy_id = ${pharmacyId} and p.customer_id = ${customerId}
  `;
  if (!row) throw notFound('Care programme');
  return row;
}

/**
 * What this programme watches, READ FROM the sections that own the numbers.
 *
 * Nothing is stored, copied or cached here. Vitals come from vitalsSeries
 * (0054) and test results from testTrend (0060) — the same functions the
 * Vitals and Tests screens use, so a monitoring panel cannot disagree with the
 * section it points at. A metric with no readings says so; it never shows a
 * zero, and it never implies the measurement was normal.
 */
async function programMonitoring(pharmacyId, customerId, programId, { limit = 10 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const program = await programWithSpec(sql, pharmacyId, customerId, programId);
  const goals = (await goalsFor(sql, pharmacyId, [programId])).get(programId) || [];
  const spec = monitoringSpec(program.monitoring || [], goals);
  if (spec.length === 0) return { metrics: [] };

  const wantsVitals = spec.some((m) => m.source === 'vitals');
  const readings = wantsVitals ? await vitalsSeries(pharmacyId, customerId, { limit: 60 }) : [];

  const metrics = [];
  for (const m of spec) {
    let points = [];
    let unit = m.unit;
    if (m.source === 'vitals') {
      points = readings
        .filter((r) => r[m.code] !== null && r[m.code] !== undefined)
        .map((r) => ({ at: r.recordedAt, value: Number(r[m.code]) }));
    } else {
      const trend = await testTrend(pharmacyId, customerId, { code: m.code });
      points = trend.points.map((p) => ({ at: p.at, value: p.value, interpretation: p.interpretation }));
      unit = unit || trend.unit;
    }
    // Oldest first, as both readers return them, so the last is the newest.
    const tail = points.slice(-Math.max(2, Number(limit) || 10));
    metrics.push({
      source: m.source,
      code: m.code,
      label: m.label,
      unit: unit || null,
      // Which section this opens: the one that owns the number.
      tab: m.source === 'vitals' ? 'vitals' : 'results',
      count: points.length,
      latest: points.length ? points[points.length - 1] : null,
      previous: points.length > 1 ? points[points.length - 2] : null,
      points: tail,
    });
  }
  return { metrics };
}

/** One attached record, written the way its own section writes it. */
async function describeLinks(sql, pharmacyId, customerId, rows) {
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r.ref_id);
  }
  const labels = new Map();
  for (const [kind, ids] of byKind) {
    const found = kind === 'condition'
      ? await sql`select id, condition_name as label, clinical_status as detail from patient_problems
                  where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and id = any(${ids})`
      : kind === 'medication'
        ? await sql`select id, medicine_name as label, strength as detail from medication_journeys
                    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and id = any(${ids})`
        : kind === 'test'
          ? await sql`select id, test_name as label, status as detail from patient_tests
                      where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and id = any(${ids})`
          : kind === 'vitals'
            ? await sql`select id, to_char(recorded_at, 'DD Mon YYYY') as label,
                               nullif(concat_ws(' ', nullif(concat_ws('/', systolic, diastolic), ''), 'mmHg'), 'mmHg') as detail
                        from patient_vitals
                        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and id = any(${ids})`
            : await sql`select e.id, to_char(e.started_at, 'DD Mon YYYY') as label,
                               e.presenting_complaint as detail
                        from clinical_encounters e
                        join patient_profiles pp on pp.id = e.patient_profile_id and pp.pharmacy_id = e.pharmacy_id
                        where e.pharmacy_id = ${pharmacyId} and pp.customer_id = ${customerId} and e.id = any(${ids})`;
    for (const f of found) labels.set(`${kind}:${f.id}`, { label: f.label, detail: f.detail });
  }
  return rows.map((r) => {
    const hit = labels.get(`${r.kind}:${r.ref_id}`) || null;
    return {
      id: r.id,
      kind: r.kind,
      refId: r.ref_id,
      note: r.note,
      // A record removed from its own section leaves the link behind; saying
      // so is honester than dropping the row and losing that it was attached.
      label: hit ? hit.label : 'No longer on the record',
      detail: hit ? hit.detail : null,
      missing: !hit,
      createdAt: r.created_at,
    };
  });
}

/**
 * The records this programme is about: the ones a pharmacist attached by hand,
 * and the ones that share its house condition code.
 *
 * DERIVED IS NOT STORED. The second list is a query over the sections that own
 * those records, every time; nothing is copied into the programme, and an
 * item already attached by hand is not listed twice.
 */
async function programRelated(pharmacyId, customerId, programId, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  // The write paths pass their OWN transaction: a read on a fresh connection
  // cannot see what they have just inserted, so attaching a record would
  // answer with the list as it was and the screen would look like nothing
  // happened.
  const db = sql || getSql();
  const program = await programWithSpec(db, pharmacyId, customerId, programId);

  const linkRows = await db`
    select id, kind, ref_id, note, created_at from care_program_links
    where pharmacy_id = ${pharmacyId} and program_id = ${programId}
    order by kind, created_at
  `;
  const links = await describeLinks(db, pharmacyId, customerId, linkRows);
  const attached = new Set(links.map((l) => `${l.kind}:${l.refId}`));

  const code = program.condition_code;
  if (!code) return { links, conditions: [], medicines: [], tests: [] };

  const conditions = (await db`
    select id, condition_name, clinical_status, verification_status
    from patient_problems
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      and local_code = ${code}
      and clinical_status in ('active', 'recurrence', 'relapse')
      and verification_status not in ('refuted', 'entered_in_error')
    order by condition_name
  `).map((c) => ({
    id: c.id, conditionName: c.condition_name, clinicalStatus: c.clinical_status, verificationStatus: c.verification_status,
  })).filter((c) => !attached.has(`condition:${c.id}`));

  const medicines = (await db`
    select id, medicine_name, strength, status from medication_journeys
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      and condition_code = ${code} and status in ('active', 'draft')
    order by medicine_name
  `).map((m) => ({ id: m.id, medicineName: m.medicine_name, strength: m.strength, status: m.status }))
    .filter((m) => !attached.has(`medication:${m.id}`));

  const tests = (await db`
    select t.id, t.test_name, t.status, t.performed_at
    from patient_tests t
    join test_definitions d on d.id = t.definition_id
    where t.pharmacy_id = ${pharmacyId} and t.customer_id = ${customerId}
      and d.condition_code = ${code}
    order by coalesce(t.performed_at, t.created_at) desc
    limit 10
  `).map((t) => ({ id: t.id, testName: t.test_name, status: t.status, performedAt: t.performed_at }))
    .filter((t) => !attached.has(`test:${t.id}`));

  return { links, conditions, medicines, tests };
}

/** Attach a record that already exists to this programme. */
async function addLink(pharmacyId, customerId, programId, fields, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    // The same check an activity's link gets: the right table, and this
    // patient. Nothing is taken on the caller's word.
    await assertLink(tx, pharmacyId, customerId, fields.kind, fields.refId);
    const [existing] = await tx`
      select id from care_program_links
      where pharmacy_id = ${pharmacyId} and program_id = ${programId}
        and kind = ${fields.kind} and ref_id = ${fields.refId}
    `;
    if (existing) {
      throw httpError(409, 'ALREADY_LINKED', 'That record is already attached to this programme.',
        { existing: { id: existing.id } });
    }
    await tx`
      insert into care_program_links ${tx({
    pharmacy_id: pharmacyId,
    program_id: programId,
    kind: fields.kind,
    ref_id: fields.refId,
    note: fields.note,
    created_by: actorId,
  })}
    `;
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_UPDATED, programId, actor,
      { program: program.program_name, action: 'linked', kind: fields.kind, refId: fields.refId },
    ));
    return programRelated(pharmacyId, customerId, programId, { sql: tx });
  });
}

/** Detach a record. The record itself is untouched — only the link is removed. */
async function removeLink(pharmacyId, customerId, programId, linkId, { actorId = null, actorRole = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  return sql.begin(async (tx) => {
    const program = await lockProgram(tx, pharmacyId, customerId, programId);
    const [row] = await tx`
      select id, kind, ref_id from care_program_links
      where id = ${linkId} and pharmacy_id = ${pharmacyId} and program_id = ${programId}
    `;
    if (!row) throw notFound('Attached record');
    await tx`delete from care_program_links where id = ${linkId} and pharmacy_id = ${pharmacyId}`;
    await recordClinicalEvent(tx, event(
      pharmacyId, customerId, PATIENT_EVENTS.CARE_PROGRAM_UPDATED, programId, actor,
      { program: program.program_name, action: 'unlinked', kind: row.kind, refId: row.ref_id },
    ));
    return programRelated(pharmacyId, customerId, programId, { sql: tx });
  });
}

/**
 * THIS PROGRAMME'S history — not the patient's.
 *
 * The events are the ones the service already writes, filtered to this
 * programme by the entity they point at. A patient's whole timeline is a
 * different screen (CustomerTimeline); mixing the two here would bury a
 * programme's six events under three hundred messages.
 */
async function programTimeline(pharmacyId, customerId, programId, { limit = 40 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  await programWithSpec(sql, pharmacyId, customerId, programId);
  const bounded = Math.min(Math.max(1, Number(limit) || 40), 200);
  const rows = await sql`
    select e.id, e.event_type, e.occurred_at, e.actor_type, e.actor_id, e.metadata,
           u.email as actor_email
    from customer_events e
    left join auth.users u on u.id = e.actor_id
    where e.pharmacy_id = ${pharmacyId} and e.customer_id = ${customerId}
      and e.entity_type = 'patient_care_program' and e.entity_id = ${programId}
    order by e.occurred_at desc, e.id desc
    limit ${bounded}
  `;
  return {
    events: rows.map((e) => ({
      id: String(e.id),
      eventType: e.event_type,
      occurredAt: e.occurred_at,
      actorType: e.actor_type,
      actor: e.actor_email || null,
      metadata: e.metadata,
    })),
  };
}

/**
 * What other screens show about this patient's care programmes (phase 3).
 *
 * The same read the section itself uses, trimmed — so the summary card and the
 * clinical context cannot disagree with the Care program tab about what is
 * open, what is due or how many tasks are late. Compact on purpose: three
 * programmes and their counts, with everything else a click away.
 */
async function careProgramSummary(pharmacyId, customerId, { today = null, limit = 3 } = {}) {
  assertPharmacyId(pharmacyId);
  const { active, past, counts } = await listPrograms(pharmacyId, customerId, { today });
  return {
    counts,
    pastCount: past.length,
    active: active.slice(0, Math.max(1, Number(limit) || 3)).map((p) => ({
      id: p.id,
      programName: p.programName,
      status: p.status,
      startDate: p.startDate,
      enrolledOn: p.enrolledOn,
      nextReviewOn: p.nextReviewOn,
      progress: p.progress,
    })),
  };
}

module.exports = {
  careProgramCatalogue, planForDefinition,
  listPrograms, getProgram, enrolProgram, updateProgram,
  addGoal, updateGoal, removeGoal,
  addActivity, updateActivity, removeActivity,
  programMonitoring, programRelated, addLink, removeLink, programTimeline,
  careProgramSummary,
};
