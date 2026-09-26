/**
 * A patient's follow-ups: what needs to happen next, why, who, when, and what
 * happened when it did.
 *
 * ONE TABLE, ONE QUEUE (0062). A follow-up raised from a consultation and an
 * activity inside a care programme are the same row in `patient_tasks` — the
 * second just has a `program_id`. So this section is the patient's whole
 * action list, and the Care program tab is the same rows filtered to one
 * programme. There is no second task system, which is what the brief (§22)
 * asked for and what 0061's own header promised.
 *
 * DUE AND OVERDUE ARE DERIVED, never stored (§5): a status somebody has to
 * remember to update is a status that will be wrong. Overdue is counted
 * against the LAGOS day, like every other date in this product, and a task is
 * not late on the day it is due.
 *
 * NOTHING CLINICAL IS STORED HERE (§12). Completing "repeat blood pressure"
 * records the reading in Vitals and points at it; the follow-up keeps the id,
 * never the number.
 *
 * NOTHING IS CREATED AUTOMATICALLY (§27). No reading, result or consultation
 * raises a follow-up on its own. A pharmacist says what needs to happen; this
 * keeps track of it.
 *
 * WHO MAY DO WHAT: anyone may create, edit, reschedule and complete — that is
 * the work. Only a pharmacist or owner may CANCEL, because cancelling says a
 * piece of planned care will not happen.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE — GOLDEN-001.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordClinicalEvent } = require('./clinicalAudit');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { lagosDate } = require('../refills/refillSchedule');
const {
  TASK_SELECT, TASK_FROM, TASK_PROGRAM_JOIN, TASK_COLUMN, shapeTask, insertTask,
} = require('./taskRow');
const { assertRecord, describeRecord } = require('./clinicalRefs');
// Completing a follow-up may RECORD the reading it produced (§12). It is
// written by the Vitals service, into patient_vitals, and this row keeps its
// id — there is no second blood-pressure store here.
const { recordVitals } = require('./vitals');
const {
  FOLLOWUP_OPEN, FOLLOWUP_DROPPED,
  mergeForCheck, needsClinicalRole, hasClinicalRole, nextOccurrence,
} = require('./followupInput');

function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const forbidden = (message) => httpError(403, 'FORBIDDEN_ROLE', message);
const notFound = (what) => httpError(404, 'NOT_FOUND', `${what} not found.`);

const SELECT = `${TASK_SELECT}, pcp.program_name`;
const FROM = `${TASK_FROM} ${TASK_PROGRAM_JOIN}`;

/**
 * Which part of the queue a follow-up is in, TODAY.
 *
 * The only place this product decides what "overdue" means, and it decides it
 * from the due date rather than from a stored status (§5). A follow-up with no
 * due date is upcoming: "review the result when it arrives" is a real
 * follow-up that nobody can date yet (§10), and calling it overdue would be a
 * lie about a date that does not exist.
 */
function bucketOf(task, today) {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'skipped') return 'completed';
  if (!task.dueOn) return 'upcoming';
  if (task.dueOn < today) return 'overdue';
  if (task.dueOn === today) return 'today';
  return 'upcoming';
}

/** Overdue first, then by due date, then undated, then by what was typed first. */
function queueOrder(a, b) {
  const rank = { overdue: 0, today: 1, upcoming: 2, completed: 3, cancelled: 4 };
  if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket];
  if (a.bucket === 'completed' || a.bucket === 'cancelled') {
    // Most recently finished first: what happened last is what a pharmacist
    // is most likely to be looking for.
    const at = (t) => t.completedAt || t.cancelledAt || t.updatedAt;
    return new Date(at(b)) - new Date(at(a));
  }
  if (a.dueOn && b.dueOn && a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
  if (a.dueOn && !b.dueOn) return -1;
  if (!a.dueOn && b.dueOn) return 1;
  return new Date(a.createdAt) - new Date(b.createdAt);
}

async function customerExists(sql, pharmacyId, customerId) {
  const [c] = await sql`select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}`;
  return Boolean(c);
}

/**
 * This patient's follow-ups, as a queue.
 *
 * Another pharmacy's patient reads like a patient with no follow-ups.
 */
async function listFollowups(pharmacyId, customerId, { filter = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const day = today || lagosDate();
  const empty = {
    followups: [],
    counts: { all: 0, today: 0, overdue: 0, upcoming: 0, completed: 0, cancelled: 0, urgent: 0 },
  };
  if (!(await customerExists(sql, pharmacyId, customerId))) return empty;

  const rows = await sql`
    select ${sql.unsafe(SELECT)} ${sql.unsafe(FROM)}
    where a.pharmacy_id = ${pharmacyId} and a.customer_id = ${customerId}
  `;
  const all = rows.map((r) => {
    const task = shapeTask(r);
    return { ...task, bucket: bucketOf(task, day) };
  }).sort(queueOrder);

  const counts = {
    all: all.length,
    today: all.filter((t) => t.bucket === 'today').length,
    overdue: all.filter((t) => t.bucket === 'overdue').length,
    upcoming: all.filter((t) => t.bucket === 'upcoming').length,
    completed: all.filter((t) => t.bucket === 'completed').length,
    cancelled: all.filter((t) => t.bucket === 'cancelled').length,
    // Urgent AND still to do. An urgent thing already done is not a flag.
    urgent: all.filter((t) => t.priority === 'urgent' && FOLLOWUP_OPEN.includes(t.status)).length,
  };

  // Filtering happens here rather than in SQL because every bucket is a fact
  // about TODAY, and the counts above need the whole set anyway.
  const followups = filter ? all.filter((t) => t.bucket === filter) : all;
  return { followups, counts };
}

/** One follow-up, with what raised it and what it produced, both resolved. */
async function getFollowup(pharmacyId, customerId, id, { sql = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const day = today || lagosDate();
  const [row] = await db`
    select ${db.unsafe(SELECT)} ${db.unsafe(FROM)}
    where a.id = ${id} and a.pharmacy_id = ${pharmacyId} and a.customer_id = ${customerId}
  `;
  if (!row) throw notFound('Follow-up');
  const task = shapeTask(row);
  return {
    ...task,
    bucket: bucketOf(task, day),
    // Pointers, resolved for the screen. A record deleted from its own section
    // comes back null and the screen says so, rather than the link vanishing.
    source: await describeRecord(db, pharmacyId, customerId, task.sourceType, task.sourceId),
    linked: await describeRecord(db, pharmacyId, customerId, task.linkedType, task.linkedId),
  };
}

const actorType = (role) => (role === 'staff' ? 'staff' : 'pharmacist');

function event(pharmacyId, customerId, eventType, taskId, { actorId, actorRole }, metadata) {
  return {
    pharmacyId,
    customerId,
    eventType,
    actorType: actorType(actorRole),
    actorId,
    entityType: 'patient_task',
    entityId: taskId,
    metadata,
    idempotencyKey: `${eventType}:${taskId}:${crypto.randomUUID()}`,
  };
}

/** Create one (§7). */
async function createFollowup(pharmacyId, customerId, fields, { actorId = null, actorRole = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (needsClinicalRole(fields.status) && !hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can cancel a follow-up.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };

  return sql.begin(async (tx) => {
    if (!(await customerExists(tx, pharmacyId, customerId))) throw notFound('Patient');
    // What raised it and what it points at are both checked against their own
    // table AND this patient before anything is stored.
    await assertRecord(tx, pharmacyId, customerId, fields.sourceType, fields.sourceId, 'sourceId');
    await assertRecord(tx, pharmacyId, customerId, fields.linkedType, fields.linkedId, 'linkedId');

    const id = await insertTask(tx, pharmacyId, customerId, null, fields, actorId);
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.FOLLOWUP_CREATED, id, actor, {
      title: fields.title,
      kind: fields.kind,
      priority: fields.priority,
      dueOn: fields.dueOn,
      source: fields.sourceType || 'manual',
      sourceId: fields.sourceId || null,
      reason: fields.reason || null,
      repeats: fields.recurrence || null,
    }));
    return getFollowup(pharmacyId, customerId, id, { sql: tx, today });
  });
}

/** The stored follow-up in the flat shape a patch merges into. */
function flat(t) {
  const out = {};
  for (const key of Object.keys(TASK_COLUMN)) out[key] = t[key] ?? null;
  out.recurrence = t.recurrence;
  return out;
}

/** The row, locked, or 404 — every write goes through here. */
async function lockFollowup(tx, pharmacyId, customerId, id) {
  const [row] = await tx`
    select id, title, status, program_id, due_on::text as due_on, rescheduled_count
    from patient_tasks
    where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    for update
  `;
  if (!row) throw notFound('Follow-up');
  return row;
}

/**
 * Edit one, or move it between statuses.
 *
 * Completing, rescheduling and cancelling have their own functions, because
 * each is an act with something to record beyond a new value — an outcome, a
 * date it moved from, a reason it stopped.
 */
async function updateFollowup(pharmacyId, customerId, id, patch, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    await lockFollowup(tx, pharmacyId, customerId, id);
    const stored = await getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
    const before = flat(stored);

    if (patch.status && needsClinicalRole(patch.status) && before.status !== patch.status
        && !hasClinicalRole(actorRole)) {
      throw forbidden('Only a pharmacist can cancel a follow-up.');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sourceId')) {
      await assertRecord(tx, pharmacyId, customerId, patch.sourceType, patch.sourceId, 'sourceId');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'linkedId')) {
      await assertRecord(tx, pharmacyId, customerId, patch.linkedType, patch.linkedId, 'linkedId');
    }

    const checked = mergeForCheck(before, patch);
    const changes = {};
    for (const [key, col] of Object.entries(TASK_COLUMN)) {
      if (Object.prototype.hasOwnProperty.call(checked, key) && checked[key] !== before[key]) {
        changes[key] = { from: before[key], to: checked[key], col };
      }
    }
    const recurrenceChanged = Object.prototype.hasOwnProperty.call(checked, 'recurrence')
      && JSON.stringify(checked.recurrence || null) !== JSON.stringify(before.recurrence || null);
    if (Object.keys(changes).length === 0 && !recurrenceChanged) return stored;

    const set = { updated_at: new Date().toISOString(), updated_by: actorId };
    for (const c of Object.values(changes)) set[c.col] = c.to;
    if (recurrenceChanged) set.recurrence = checked.recurrence ? tx.json(checked.recurrence) : null;
    applyStatusStamps(set, before.status, checked.status, actorId);

    await tx`update patient_tasks set ${tx(set)} where id = ${id} and pharmacy_id = ${pharmacyId}`;
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.FOLLOWUP_UPDATED, id, actor, {
      title: checked.title || before.title,
      changes: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, { from: c.from, to: c.to }])),
    }));
    return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
  });
}

/**
 * The stamps a status change carries, in one place.
 *
 * Completing says who and when; cancelling says when; moving back out of
 * either clears the stamp that no longer describes anything. The audit trail
 * keeps what it said.
 */
function applyStatusStamps(set, beforeStatus, nextStatus, actorId) {
  if (!nextStatus || nextStatus === beforeStatus) return;
  const now = new Date().toISOString();
  if (nextStatus === 'completed') {
    set.completed_at = now;
    set.completed_by = actorId;
  } else if (beforeStatus === 'completed') {
    set.completed_at = null;
    set.completed_by = null;
  }
  if (nextStatus === 'cancelled') {
    set.cancelled_at = now;
    set.cancelled_by = actorId;
  } else if (beforeStatus === 'cancelled') {
    set.cancelled_at = null;
    set.cancelled_by = null;
  }
}

/**
 * Complete one (§12).
 *
 * Its own act, not a status change: an outcome, optionally what it produced,
 * and — if it repeats — exactly one next occurrence, created here in the same
 * transaction and anchored to the day it was DUE rather than the day it was
 * done, so a task ticked off late does not push the whole schedule later.
 *
 * THE RESULT IS A LINK. If the follow-up produced a blood pressure, that
 * reading belongs to Vitals and this row keeps its id.
 */
async function completeFollowup(pharmacyId, customerId, id, fields, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  // THE READING IS WRITTEN FIRST, BY VITALS, AND OUTSIDE THIS TRANSACTION.
  //
  // `recordVitals` owns patient_vitals and opens its own connection, so it
  // cannot join the transaction below — and that is the right way round. A
  // reading taken at the counter HAPPENED: if the completion then fails, the
  // reading still belongs in Vitals and is there. The reverse — a follow-up
  // completed pointing at a reading that was never saved — is the failure
  // worth preventing.
  //
  // The check that the follow-up exists and is this patient's runs before it,
  // so a bad id cannot leave a stray reading behind.
  let recorded = null;
  if (fields.reading) {
    const pre = getSql();
    const [exists] = await pre`
      select id, status from patient_tasks
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    `;
    if (!exists) throw notFound('Follow-up');
    if (exists.status === 'completed') {
      throw httpError(409, 'ALREADY_COMPLETED', 'This follow-up has already been completed.');
    }
    recorded = await recordVitals(pharmacyId, customerId, fields.reading, { actorId });
  }

  return sql.begin(async (tx) => {
    const row = await lockFollowup(tx, pharmacyId, customerId, id);
    if (row.status === 'completed') {
      throw httpError(409, 'ALREADY_COMPLETED', 'This follow-up has already been completed.');
    }
    if (row.status === 'cancelled') {
      throw httpError(409, 'FOLLOWUP_CANCELLED', 'This follow-up was cancelled. Reopen it before completing it.');
    }
    // A reading just recorded is what this follow-up produced, and it needs no
    // further checking — Vitals wrote it against this patient a moment ago.
    if (recorded) {
      fields.linkedType = 'vitals';
      fields.linkedId = recorded.id;
    }
    await assertRecord(tx, pharmacyId, customerId, fields.linkedType, fields.linkedId, 'linkedId');

    const stored = await getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
    await tx`
      update patient_tasks set ${tx({
    status: 'completed',
    outcome: fields.outcome,
    outcome_note: fields.outcomeNote,
    // The DAY the work happened, which may not be today; the timestamp
    // records when it was written down.
    completed_at: fields.completedOn
      ? new Date(`${fields.completedOn}T12:00:00Z`).toISOString()
      : new Date().toISOString(),
    completed_by: actorId,
    ...(fields.linkedType ? { linked_type: fields.linkedType, linked_id: fields.linkedId } : {}),
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  })}
      where id = ${id} and pharmacy_id = ${pharmacyId}
    `;

    let created = null;
    if (stored.recurrence && stored.dueOn) {
      const next = nextOccurrence({ ...stored, id }, { today: day });
      if (next) {
        const newId = await insertTask(tx, pharmacyId, customerId, stored.programId || null, {
          ...next,
          // Carried across because they describe the standing job, not the
          // occurrence that was just done.
          priority: stored.priority,
          reason: stored.reason,
          sourceType: stored.sourceType,
          sourceId: stored.sourceId,
        }, actorId);
        created = { id: newId, dueOn: next.dueOn };
      }
    }

    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.FOLLOWUP_COMPLETED, id, actor, {
      title: stored.title,
      outcome: fields.outcome,
      completedOn: fields.completedOn,
      result: fields.linkedType ? { kind: fields.linkedType, id: fields.linkedId } : null,
      // Recorded here, rather than pointed at something that already existed.
      ...(recorded ? { readingRecorded: true } : {}),
      note: fields.outcomeNote || null,
      ...(created ? { nextDue: created.dueOn, nextFollowupId: created.id } : {}),
    }));
    return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
  });
}

/**
 * Move one (§14).
 *
 * The date it had is kept in the audit trail and the row counts how many times
 * it has moved, so "this has been put off three times" is visible without
 * reading the trail. Nothing is overwritten silently.
 */
async function rescheduleFollowup(pharmacyId, customerId, id, fields, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    const row = await lockFollowup(tx, pharmacyId, customerId, id);
    if (row.status === 'completed') {
      throw httpError(409, 'ALREADY_COMPLETED', 'A completed follow-up cannot be rescheduled. Reopen it first.');
    }
    if (row.due_on === fields.dueOn) {
      throw httpError(400, 'SAME_DATE', 'That is the date it is already due.', { field: 'dueOn' });
    }
    await tx`
      update patient_tasks set ${tx({
    due_on: fields.dueOn,
    due_time: fields.dueTime,
    rescheduled_count: (row.rescheduled_count || 0) + 1,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  })}
      where id = ${id} and pharmacy_id = ${pharmacyId}
    `;
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.FOLLOWUP_RESCHEDULED, id, actor, {
      title: row.title,
      from: row.due_on,
      to: fields.dueOn,
      reason: fields.reason || null,
      times: (row.rescheduled_count || 0) + 1,
    }));
    return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
  });
}

/**
 * Cancel one (§15).
 *
 * The row is KEPT, with the reason and the day it was cancelled — deleting it
 * would lose that the follow-up was ever needed, which is the part somebody
 * asking "why was this never done" needs to see.
 *
 * Only a pharmacist or owner: this says a piece of planned care will not
 * happen.
 */
async function cancelFollowup(pharmacyId, customerId, id, fields, {
  actorId = null, actorRole = null, today = null,
} = {}) {
  assertPharmacyId(pharmacyId);
  if (!hasClinicalRole(actorRole)) {
    throw forbidden('Only a pharmacist can cancel a follow-up.');
  }
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    const row = await lockFollowup(tx, pharmacyId, customerId, id);
    if (row.status === 'cancelled') return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
    if (row.status === 'completed') {
      throw httpError(409, 'ALREADY_COMPLETED', 'This follow-up was completed. It cannot be cancelled afterwards.');
    }
    await tx`
      update patient_tasks set ${tx({
    status: 'cancelled',
    status_reason: fields.statusReason,
    cancelled_at: new Date().toISOString(),
    cancelled_by: actorId,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  })}
      where id = ${id} and pharmacy_id = ${pharmacyId}
    `;
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.FOLLOWUP_CANCELLED, id, actor, {
      title: row.title,
      // The CODE, so "how many were cancelled as duplicates" stays answerable
      // without giving the table a column no screen filters on.
      reason: fields.reason,
      note: fields.note || null,
    }));
    return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
  });
}

/**
 * Reopen one (§29's REOPENED).
 *
 * A follow-up completed or cancelled by mistake goes back into the queue, and
 * the trail says it happened. The outcome it had is cleared — it no longer
 * describes anything — and the audit keeps what it said.
 */
async function reopenFollowup(pharmacyId, customerId, id, { actorId = null, actorRole = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const actor = { actorId, actorRole };
  const day = today || lagosDate();

  return sql.begin(async (tx) => {
    const row = await lockFollowup(tx, pharmacyId, customerId, id);
    if (FOLLOWUP_OPEN.includes(row.status)) {
      return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
    }
    const stored = await getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
    await tx`
      update patient_tasks set ${tx({
    status: 'not_started',
    outcome: null,
    completed_at: null,
    completed_by: null,
    cancelled_at: null,
    cancelled_by: null,
    status_reason: null,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  })}
      where id = ${id} and pharmacy_id = ${pharmacyId}
    `;
    await recordClinicalEvent(tx, event(pharmacyId, customerId, PATIENT_EVENTS.FOLLOWUP_REOPENED, id, actor, {
      title: stored.title,
      from: stored.status,
      outcome: stored.outcome || null,
      reason: stored.statusReason || null,
    }));
    return getFollowup(pharmacyId, customerId, id, { sql: tx, today: day });
  });
}

/**
 * THIS follow-up's history — not the patient's (§18).
 *
 * The events the service already writes, filtered to this row. The patient's
 * whole record is a different screen, and the finished follow-ups are already
 * in the queue's own Completed and Cancelled groups; this answers the question
 * those cannot: what happened to THIS one, in order, and who did it.
 */
async function followupTimeline(pharmacyId, customerId, id, { limit = 40 } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const [row] = await sql`
    select id from patient_tasks
    where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
  `;
  if (!row) throw notFound('Follow-up');

  const bounded = Math.min(Math.max(1, Number(limit) || 40), 200);
  const events = await sql`
    select e.id, e.event_type, e.occurred_at, e.actor_type, e.actor_id, e.metadata,
           u.email as actor_email
    from customer_events e
    left join auth.users u on u.id = e.actor_id
    where e.pharmacy_id = ${pharmacyId} and e.customer_id = ${customerId}
      and e.entity_type = 'patient_task' and e.entity_id = ${id}
    order by e.occurred_at desc, e.id desc
    limit ${bounded}
  `;
  return {
    events: events.map((e) => ({
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
 * What other screens show about this patient's follow-ups (phase 3).
 *
 * The same read the section itself uses, trimmed — so the summary card, the
 * clinical-context brief and the Follow-up tab cannot disagree about what is
 * late or what is next. Compact on purpose: the counts, and the few things
 * actually waiting, with everything else a click away.
 *
 * ONLY OUTSTANDING WORK IS LISTED. A completed follow-up is not something a
 * pharmacist needs to see beside a medicine; it is history, and the section
 * holds it.
 */
async function followupSummary(pharmacyId, customerId, { today = null, limit = 3 } = {}) {
  assertPharmacyId(pharmacyId);
  const day = today || lagosDate();
  const { followups, counts } = await listFollowups(pharmacyId, customerId, { today: day });
  const open = followups.filter((f) => ['overdue', 'today', 'upcoming'].includes(f.bucket));
  return {
    counts,
    // The queue is already ordered overdue first, then by date, so the next
    // few are simply the first few.
    next: open.slice(0, Math.max(1, Number(limit) || 3)).map((f) => ({
      id: f.id,
      title: f.title,
      kind: f.kind,
      priority: f.priority,
      status: f.status,
      dueOn: f.dueOn,
      dueTime: f.dueTime,
      bucket: f.bucket,
      programName: f.programName,
    })),
  };
}

module.exports = {
  listFollowups, getFollowup, createFollowup, updateFollowup,
  completeFollowup, rescheduleFollowup, cancelFollowup, reopenFollowup,
  followupTimeline, followupSummary, bucketOf, FOLLOWUP_DROPPED,
};
