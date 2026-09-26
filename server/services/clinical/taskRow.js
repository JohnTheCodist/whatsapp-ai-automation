/**
 * One row of `patient_tasks`, read and written in one place.
 *
 * 0062 made the care-programme activity table the patient's task table: a row
 * with a programme is a care-plan activity, a row without one is a follow-up
 * raised on its own, and both are "a thing to be done for this patient, on a
 * date, by somebody". Two services read it — `carePrograms.js` for a
 * programme's plan and `followups.js` for the patient's queue — so the SELECT
 * list, the shape and the INSERT live here rather than in both.
 *
 * NOTHING CLINICAL IS STORED ON A TASK. `source_type`/`source_id` say what
 * raised it and `linked_type`/`linked_id` say what it produced; both are ids
 * into the sections that own those records, checked before they are stored.
 *
 * PURE SQL AND SHAPE — no tenant logic of its own. Every caller passes a
 * pharmacy-scoped query, which is where GOLDEN-001 is enforced.
 */

const TASK_SELECT = `
  a.id, a.pharmacy_id, a.customer_id, a.program_id, a.goal_id,
  a.title, a.description, a.kind, a.status, a.priority, a.reason,
  a.due_on::text as due_on, a.due_time::text as due_time,
  a.assigned_to_user_id, a.assigned_to_name,
  a.completed_at, a.completed_by, a.outcome, a.outcome_note,
  a.recurrence, a.recurrence_of,
  a.source_type, a.source_id, a.linked_type, a.linked_id,
  a.status_reason, a.cancelled_at, a.cancelled_by, a.rescheduled_count,
  a.position, a.notes, a.recorded_by, a.updated_by, a.created_at, a.updated_at,
  au.email as assigned_to_email, cu.email as completed_by_email
`;

const TASK_FROM = `
  from patient_tasks a
  left join auth.users au on au.id = a.assigned_to_user_id
  left join auth.users cu on cu.id = a.completed_by
`;

/** The programme's name, for a task read outside its own programme. */
const TASK_PROGRAM_JOIN = `
  left join patient_care_programs pcp on pcp.id = a.program_id and pcp.pharmacy_id = a.pharmacy_id
`;

function shapeTask(r) {
  return {
    id: r.id,
    customerId: r.customer_id,
    programId: r.program_id,
    // Present only where the caller joined it — a task read inside its own
    // programme already knows the name.
    programName: r.program_name || null,
    goalId: r.goal_id,
    title: r.title,
    description: r.description,
    kind: r.kind,
    status: r.status,
    priority: r.priority,
    reason: r.reason,
    dueOn: r.due_on,
    // '17:00:00' -> '17:00'. A time nobody set stays null rather than becoming
    // midnight, which would read as a task due at the start of the day.
    dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
    assignedToUserId: r.assigned_to_user_id,
    assignedToName: r.assigned_to_name,
    assignedToEmail: r.assigned_to_email || null,
    completedAt: r.completed_at,
    completedBy: r.completed_by ? { id: r.completed_by, email: r.completed_by_email || null } : null,
    outcome: r.outcome,
    outcomeNote: r.outcome_note,
    recurrence: r.recurrence || null,
    recurrenceOf: r.recurrence_of,
    sourceType: r.source_type,
    sourceId: r.source_id,
    linkedType: r.linked_type,
    linkedId: r.linked_id,
    statusReason: r.status_reason,
    cancelledAt: r.cancelled_at,
    rescheduledCount: r.rescheduled_count,
    position: r.position,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Write one task.
 *
 * `programId` is null for a follow-up raised on its own. `customerId` is
 * always required — 0062 put it on the row precisely so a task without a
 * programme still knows whose it is.
 */
async function insertTask(tx, pharmacyId, customerId, programId, t, actorId) {
  const completing = t.status === 'completed';
  const [row] = await tx`
    insert into patient_tasks ${tx({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    program_id: programId || null,
    goal_id: t.goalId || null,
    title: t.title,
    description: t.description ?? null,
    kind: t.kind,
    status: t.status,
    priority: t.priority || 'routine',
    reason: t.reason ?? null,
    due_on: t.dueOn ?? null,
    due_time: t.dueTime ?? null,
    assigned_to_user_id: t.assignedToUserId ?? null,
    assigned_to_name: t.assignedToName ?? null,
    completed_at: completing ? new Date().toISOString() : null,
    completed_by: completing ? actorId : null,
    outcome: t.outcome ?? null,
    outcome_note: t.outcomeNote ?? null,
    recurrence: t.recurrence ? tx.json(t.recurrence) : null,
    recurrence_of: t.recurrenceOf || null,
    source_type: t.sourceType ?? null,
    source_id: t.sourceId ?? null,
    linked_type: t.linkedType ?? null,
    linked_id: t.linkedId ?? null,
    status_reason: t.statusReason ?? null,
    cancelled_at: t.status === 'cancelled' ? new Date().toISOString() : null,
    cancelled_by: t.status === 'cancelled' ? actorId : null,
    position: t.position ?? 0,
    notes: t.notes ?? null,
    recorded_by: actorId,
    updated_by: actorId,
  })}
    returning id
  `;
  return row.id;
}

/** The columns a patch may set, and the column each one writes. */
const TASK_COLUMN = Object.freeze({
  goalId: 'goal_id',
  title: 'title',
  description: 'description',
  kind: 'kind',
  status: 'status',
  priority: 'priority',
  reason: 'reason',
  dueOn: 'due_on',
  dueTime: 'due_time',
  assignedToUserId: 'assigned_to_user_id',
  assignedToName: 'assigned_to_name',
  outcome: 'outcome',
  outcomeNote: 'outcome_note',
  sourceType: 'source_type',
  sourceId: 'source_id',
  linkedType: 'linked_type',
  linkedId: 'linked_id',
  statusReason: 'status_reason',
  position: 'position',
  notes: 'notes',
});

module.exports = {
  TASK_SELECT, TASK_FROM, TASK_PROGRAM_JOIN, TASK_COLUMN, shapeTask, insertTask,
};
