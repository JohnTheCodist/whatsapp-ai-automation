/**
 * A patient's care programmes, as the dashboard writes them.
 *
 * PURE — no React, no fetch. The vocabulary is the server's
 * (GET /care-programs/options); what is here is how it is written, ordered
 * and toned.
 *
 * THREE RULES THIS FILE EXISTS TO HOLD:
 *
 * 1. PROGRESS IS COUNTS. "Goals 1/3 · Tasks 8/12 · 2 overdue" and never a
 *    percentage — a percentage over tasks answers "how much admin is done"
 *    and, printed beside a patient's name, reads as a claim about the patient
 *    (the plan, question 3).
 *
 * 2. AN EMPTY SECTION SAYS WHAT IT IS. "No goals set" and "No tasks yet" are
 *    facts. "None" would be a claim that the pharmacist decided there were
 *    none, which no part of this system has been told.
 *
 * 3. OVERDUE IS AMBER, NEVER RED. design.md reserves red for "a person is
 *    waiting"; a task that slipped past its date is not that, and colour is
 *    never alone — the row says "overdue" in words.
 */

/** How a programme's status is shown. Only an open one wears the live tone. */
export const PROGRAM_TONE = Object.freeze({
  planned: 'ui-med-draft',
  active: 'ui-med-active',
  on_hold: 'ui-tone-3',
  completed: 'ui-tone-1',
  discontinued: 'ui-tone-quiet',
  cancelled: 'ui-tone-quiet',
});

export const GOAL_TONE = Object.freeze({
  planned: 'ui-med-draft',
  in_progress: 'ui-tone-1',
  achieved: 'ui-med-active',
  not_achieved: 'ui-tone-3',
  cancelled: 'ui-tone-quiet',
});

export const TASK_TONE = Object.freeze({
  not_started: 'ui-med-draft',
  in_progress: 'ui-tone-1',
  completed: 'ui-med-active',
  skipped: 'ui-tone-quiet',
  cancelled: 'ui-tone-quiet',
});

/**
 * The sections of one programme, in the order they are worked through.
 *
 * Monitoring and Timeline joined on 2026-09-24 (phase 2). Neither holds
 * anything: Monitoring READS Vitals and Tests, and Timeline reads the events
 * this programme has already written.
 */
export const PROGRAM_SECTIONS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'plan', label: 'Care plan' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'timeline', label: 'Timeline' },
]);

const OPEN = Object.freeze(['planned', 'active', 'on_hold']);
const TASK_OPEN = Object.freeze(['not_started', 'in_progress']);
const TASK_DROPPED = Object.freeze(['skipped', 'cancelled']);

export const isOpen = (program) => OPEN.includes(program?.status);

export function labelFor(list, value) {
  if (!value) return null;
  const hit = (list || []).find((o) => o.value === value);
  return hit ? hit.label : value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Today, in Lagos — which is the day the pharmacy is having, whatever the
 * browser's clock says its zone is. The server counts overdue the same way
 * (refillSchedule's lagosDate), so a task is late on both sides on the same
 * day; en-CA formats as YYYY-MM-DD, which is the whole reason it is used.
 */
export function lagosToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function dayLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * How long a programme ran: "Started 10 Jun 2026", or "Jun – Sep 2026" once it
 * has ended. A programme with no start date says when it was enrolled instead,
 * which is the date somebody actually wrote down.
 */
export function rangeLabel(program) {
  const from = program?.startDate || program?.enrolledOn || null;
  if (!from) return null;
  if (!program.endDate) return `Started ${dayLabel(from)}`;
  return `${dayLabel(from)} – ${dayLabel(program.endDate)}`;
}

/**
 * Progress, in counts. Every number traces to rows somebody wrote.
 *
 * Returns the parts so a screen can tone the overdue one on its own; joining
 * them with " · " is the row, and there is no percentage in either.
 */
export function progressParts(program) {
  const p = program?.progress;
  if (!p) return [];
  const out = [];
  if (p.goals.total > 0) out.push({ id: 'goals', text: `Goals ${p.goals.achieved}/${p.goals.total}` });
  if (p.activities.total > 0) {
    out.push({ id: 'tasks', text: `Tasks ${p.activities.completed}/${p.activities.total}` });
  }
  if (p.activities.overdue > 0) {
    out.push({ id: 'overdue', text: `${p.activities.overdue} overdue`, tone: 'ui-tone-3' });
  }
  return out;
}

export const progressLine = (program) => progressParts(program).map((x) => x.text).join(' · ') || null;

/**
 * The counts, without the overdue flag — what OTHER screens print beside a
 * programme's name: "Goals 1/3 · Tasks 8/12".
 *
 * One function, used by the patient summary card and the clinical-context
 * brief, so three screens cannot end up saying a programme's progress three
 * different ways. Still no percentage, anywhere.
 */
export function countsLine(program) {
  const p = program?.progress;
  if (!p) return null;
  return `Goals ${p.goals.achieved}/${p.goals.total} · Tasks ${p.activities.completed}/${p.activities.total}`;
}

/**
 * What the programme is waiting on: the next task, or the review, or nothing.
 * "Nothing due" is a fact about the plan; it never says the patient is fine.
 */
export function nextUpLine(program, today) {
  const next = program?.progress?.nextDue || null;
  if (next && next.dueOn) {
    return `${next.title} — ${dueLabel(next.dueOn, today)}`;
  }
  if (program?.nextReviewOn) return `Review — ${dueLabel(program.nextReviewOn, today)}`;
  return 'Nothing due';
}

/**
 * A due date, relative where that is what a person means: "due today",
 * "3 days overdue", "due 1 Oct 2026". Never "in 7 days" for a far date, which
 * is harder to act on than the date itself.
 */
export function dueLabel(iso, today) {
  if (!iso) return null;
  if (!today) return `due ${dayLabel(iso)}`;
  const days = daysBetween(today, iso);
  if (days === null) return `due ${dayLabel(iso)}`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days === -1) return '1 day overdue';
  if (days < -1) return `${-days} days overdue`;
  if (days <= 7) return `due in ${days} days`;
  return `due ${dayLabel(iso)}`;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export const isOverdue = (task, today) => Boolean(
  task && TASK_OPEN.includes(task.status) && task.dueOn && today && task.dueOn < today,
);

/**
 * The task list: what is still to do, the latest date first past its day, then
 * by date. Done and dropped tasks are not in it — they are in the care plan,
 * which is the whole history.
 */
export function taskList(program, today) {
  const open = (program?.activities || []).filter((a) => TASK_OPEN.includes(a.status));
  return open.slice().sort((x, y) => {
    const xo = isOverdue(x, today);
    const yo = isOverdue(y, today);
    if (xo !== yo) return xo ? -1 : 1;
    if (x.dueOn && y.dueOn && x.dueOn !== y.dueOn) return x.dueOn < y.dueOn ? -1 : 1;
    if (x.dueOn && !y.dueOn) return -1;
    if (!x.dueOn && y.dueOn) return 1;
    return (x.position || 0) - (y.position || 0);
  });
}

/** "every month", "every 2 weeks" — or nothing, for a task that happens once. */
export function recurrenceLabel(task) {
  const r = task?.recurrence;
  if (!r || !r.every || !r.unit) return null;
  const unit = r.every === 1 ? r.unit : `${r.unit}s`;
  return r.every === 1 ? `every ${unit}` : `every ${r.every} ${unit}`;
}

/**
 * A goal's target, written: "Below 140 mmHg", "7 %", or the words the
 * pharmacist typed. A goal with no target says so rather than showing nothing,
 * because a blank target column reads as a goal nobody finished writing.
 */
export function targetLabel(goal) {
  if (!goal) return null;
  if (goal.targetValue !== null && goal.targetValue !== undefined) {
    return [goal.targetValue, goal.unit].filter((v) => v !== null && v !== undefined && v !== '').join(' ');
  }
  if (goal.targetText) return goal.targetText;
  return 'No target set';
}

/**
 * A goal's current value, which is READ FROM the record and never stored here.
 *
 * `reading` is what the caller looked up in Vitals or Tests — {value, unit,
 * at} — and when there is none, this says the measurement has not been taken,
 * NOT that the goal is unmet.
 */
export function currentLabel(goal, reading) {
  if (!goal) return null;
  if (!goal.measureSource) return null;
  if (!reading || reading.value === null || reading.value === undefined) return 'Not measured yet';
  // NOT filter(Boolean): a reading of 0 is a reading, and dropping it would
  // print the unit on its own. The same mistake elsewhere in this codebase
  // stored a pulse of 0 on a living patient.
  const value = [reading.value, reading.unit || goal.unit]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ');
  const when = dayLabel(reading.at);
  return when ? `${value} · ${when}` : value;
}

/** What a section says when there is nothing in it — a fact, never "none". */
export const EMPTY_TEXT = Object.freeze({
  programs: 'No care programmes yet',
  past: 'No past programmes',
  goals: 'No goals set',
  plan: 'No activities planned',
  tasks: 'Nothing outstanding',
  monitoring: 'Nothing is being monitored',
  related: 'No records attached yet',
  timeline: 'Nothing has happened yet',
  // Enrolment is a fact this system holds completely — nobody can be in a
  // programme it was never told about — so these two say "no" rather than
  // "not recorded". Nothing about the PATIENT is claimed either way.
  notEnrolled: 'Not enrolled in any',
  noPrograms: 'No care programmes',
});

// ---- monitoring: read from Vitals and Tests, never held here --------------

/**
 * One monitored value, written: "148 mmHg". A metric nobody has measured says
 * NOT MEASURED — never a zero, never a blank that reads as a normal result.
 */
export function monitoringValue(metric) {
  if (!metric || !metric.latest || metric.latest.value === null || metric.latest.value === undefined) {
    return 'Not measured';
  }
  return [metric.latest.value, metric.unit].filter((v) => v !== null && v !== undefined && v !== '').join(' ');
}

/**
 * How it compares with the reading before it — "up 8 mmHg since 1 Sep 2026".
 *
 * A FACT OF ARITHMETIC, AND NOTHING MORE. It never says better, worse,
 * improving or controlled: whether a change is good depends on the person, the
 * medicine and the target, and none of that is decided on this screen.
 */
export function monitoringChange(metric) {
  if (!metric || !metric.latest || !metric.previous) return null;
  const now = Number(metric.latest.value);
  const before = Number(metric.previous.value);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  const when = dayLabel(metric.previous.at);
  const diff = Math.round((now - before) * 100) / 100;
  if (diff === 0) return when ? `unchanged since ${when}` : 'unchanged';
  const size = [Math.abs(diff), metric.unit].filter(Boolean).join(' ');
  const word = diff > 0 ? 'up' : 'down';
  return when ? `${word} ${size} since ${when}` : `${word} ${size}`;
}

/** "3 readings" / "1 reading" / "no readings yet" — what the panel is built on. */
export function readingCount(metric) {
  const n = metric?.count || 0;
  if (n === 0) return 'no readings yet';
  return `${n} reading${n === 1 ? '' : 's'}`;
}

// ---- the timeline: this programme's own events ---------------------------

const ACTION_WORD = Object.freeze({
  added: 'Added', updated: 'Changed', removed: 'Removed',
  completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled',
});

/**
 * One event, as a sentence a pharmacist would say.
 *
 * Built ONLY from what the event recorded. An event whose metadata this screen
 * does not recognise is shown as what it is, not guessed at — a plausible
 * sentence about the wrong thing is worse than a plain one.
 */
export function timelineSentence(event, options) {
  const m = (event && event.metadata) || {};
  switch (event?.eventType) {
    case 'CARE_PROGRAM_ENROLLED': {
      const parts = [];
      if (m.fromTemplate) parts.push('from a template');
      if (m.goals) parts.push(`${m.goals} goal${m.goals === 1 ? '' : 's'}`);
      if (m.activities) parts.push(`${m.activities} task${m.activities === 1 ? '' : 's'}`);
      return { text: 'Enrolled', detail: parts.join(' · ') || null };
    }
    case 'CARE_PROGRAM_COMPLETED':
      return { text: 'Completed', detail: labelFor(options?.outcomes, m.outcome) };
    case 'CARE_PROGRAM_DISCONTINUED':
      return {
        text: 'Discontinued',
        detail: labelFor(options?.discontinuationReasons, m.changes?.discontinuationReason?.to) || m.reason || null,
      };
    case 'CARE_PROGRAM_STATUS_CHANGED': {
      const from = labelFor(options?.statuses, m.changes?.status?.from);
      const to = labelFor(options?.statuses, m.changes?.status?.to);
      return { text: from && to ? `${from} → ${to}` : 'Status changed', detail: m.reason || null };
    }
    case 'CARE_PROGRAM_UPDATED': {
      if (m.action === 'linked') {
        return { text: `Attached a ${(labelFor(options?.linkKinds, m.kind) || m.kind || 'record').toLowerCase()}`, detail: null };
      }
      if (m.action === 'unlinked') {
        return { text: `Detached a ${(labelFor(options?.linkKinds, m.kind) || m.kind || 'record').toLowerCase()}`, detail: null };
      }
      const fields = Object.keys(m.changes || {});
      return { text: 'Edited', detail: fields.length ? fields.map(fieldWord).join(', ') : null };
    }
    case 'CARE_PROGRAM_GOAL_CHANGED':
      return { text: `${ACTION_WORD[m.action] || 'Changed'} a goal`, detail: m.goal || null };
    case 'CARE_PROGRAM_ACTIVITY_CHANGED': {
      const word = ACTION_WORD[m.action] || 'Changed';
      const detail = [m.activity, m.nextDue ? `next due ${dayLabel(m.nextDue)}` : null, m.reason]
        .filter(Boolean).join(' · ');
      return { text: `${word} a task`, detail: detail || null };
    }
    default:
      return { text: 'Recorded', detail: null };
  }
}

const FIELD_WORDS = Object.freeze({
  programName: 'name',
  startDate: 'start date',
  nextReviewOn: 'review date',
  endDate: 'end date',
  responsibleName: 'pharmacist',
  responsibleUserId: 'pharmacist',
  outcomeNotes: 'outcome notes',
  followUpRecommendation: 'what happens next',
  statusReason: 'reason',
});
const fieldWord = (key) => FIELD_WORDS[key] || key;

/** "22 Sep 2026, 14:05" — the clock matters on a timeline, not on a due date. */
export function stampLabel(at) {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dayLabel(at)}, ${time}`;
}

/** How a programme ended, in one line, for the list of past programmes. */
export function outcomeLine(program, options) {
  if (!program) return null;
  if (program.status === 'completed') {
    const label = labelFor(options?.outcomes, program.outcome);
    return label ? `Outcome: ${label.toLowerCase()}` : 'Completed';
  }
  if (program.status === 'discontinued') {
    const label = labelFor(options?.discontinuationReasons, program.discontinuationReason);
    return label ? `Stopped: ${label.toLowerCase()}` : 'Discontinued';
  }
  if (program.status === 'cancelled') return 'Cancelled';
  return null;
}

/** Who is looking after it, or that nobody has been named. */
export function responsibleLine(program) {
  const r = program?.responsible;
  const who = r ? (r.name || r.email) : null;
  return who ? `Pharmacist: ${who}` : 'No pharmacist assigned';
}

/** Why the enrolment form cannot save yet — mirrors the server, never replaces it. */
export function programProblems(form) {
  const out = [];
  if (!String(form?.programName || '').trim()) out.push('Say which programme this is.');
  if (form?.status === 'on_hold' && !String(form?.statusReason || '').trim()) {
    out.push('Say why the programme is on hold.');
  }
  return out;
}

/** Why the ending dialog cannot save yet. */
export function endingProblems(form) {
  const out = [];
  if (form?.status === 'completed' && !form?.outcome) out.push('Say how the programme ended.');
  if (form?.status === 'discontinued' && !form?.discontinuationReason) {
    out.push('Say why the programme was stopped.');
  }
  if (form?.status === 'cancelled' && !String(form?.statusReason || '').trim()) {
    out.push('Say why the programme was cancelled.');
  }
  return out;
}

/** Why the task form cannot save yet. */
export function taskProblems(form) {
  const out = [];
  if (!String(form?.title || '').trim()) out.push('Say what needs to be done.');
  if (form?.repeats && !form?.dueOn) out.push('A repeating task needs a first due date.');
  if (['skipped', 'cancelled'].includes(form?.status) && !String(form?.statusReason || '').trim()) {
    out.push(form.status === 'skipped' ? 'Say why this was skipped.' : 'Say why this was cancelled.');
  }
  return out;
}

/** Why the goal form cannot save yet. */
export function goalProblems(form) {
  const out = [];
  if (!String(form?.title || '').trim()) out.push('Say what the goal is.');
  if (form?.measureSource && !form?.measureCode) out.push('Say which measurement the goal reads.');
  if (form?.measureCode && !form?.measureSource) out.push('Say where the measurement is read from.');
  return out;
}

export { TASK_OPEN, TASK_DROPPED };
