/**
 * A patient's follow-ups, as the dashboard writes them.
 *
 * PURE — no React, no fetch. The vocabulary is the server's
 * (GET /followups/options); what is here is how it is written, grouped and
 * toned.
 *
 * THIS SCREEN IS A CLINICAL ACTION QUEUE (§30), not a reminder app: what is
 * late, what is due, what it is for, who has it. The wording rules that carry
 * that:
 *
 * 1. OVERDUE IS AMBER, NEVER RED. design.md reserves red for "a person is
 *    waiting" — a task past its date is not that. Colour is never alone: the
 *    row says "4 days overdue" in words.
 * 2. URGENT IS A WORD, NOT A COLOUR. An urgent follow-up is marked; it does
 *    not turn the row into an alarm, because a screen where everything shouts
 *    is a screen nobody reads.
 * 3. AN EMPTY QUEUE SAYS WHAT IT IS. "No follow-ups" is a fact about the
 *    record; it never implies the patient needs nothing.
 */

const OPEN = Object.freeze(['not_started', 'in_progress']);

/** The buckets the server sorts into, in the order they are worked. */
export const BUCKETS = Object.freeze([
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
]);

/** How a status is shown. Only a finished one wears the settled tone. */
export const STATUS_TONE = Object.freeze({
  not_started: 'ui-med-draft',
  in_progress: 'ui-tone-1',
  completed: 'ui-med-active',
  skipped: 'ui-tone-quiet',
  cancelled: 'ui-tone-quiet',
});

export const BUCKET_TONE = Object.freeze({
  overdue: 'ui-tone-3',
  today: 'ui-tone-1',
  upcoming: 'ui-tone-quiet',
  completed: 'ui-tone-quiet',
  cancelled: 'ui-tone-quiet',
});

export const EMPTY_TEXT = Object.freeze({
  none: 'No follow-ups',
  noneHelp: 'This patient currently has no follow-up actions.',
  noUpcoming: 'No upcoming follow-ups',
  noUpcomingHelp: 'You can create a follow-up after the next consultation or care activity.',
  filtered: 'Nothing matches this filter.',
  noSource: 'Raised by hand',
  // Said on OTHER screens, where the record was read and held nothing. A
  // follow-up queue this system has never been told about cannot exist, so
  // "none" is true here — and it still says nothing about the patient.
  noneOutstanding: 'Nothing outstanding',
  noFollowups: 'No follow-ups',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Today, in Lagos — the day the pharmacy is having, whatever the browser's
 * clock says. The server buckets against the same day, so a task is late on
 * both sides at the same moment.
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

export function labelFor(list, value) {
  if (!value) return null;
  const hit = (list || []).find((o) => o.value === value);
  return hit ? hit.label : value;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * When it is due, the way somebody would say it.
 *
 * A follow-up with NO date says so plainly: "no date yet" is true, and
 * inventing one would put a made-up deadline in front of a pharmacist.
 */
export function dueLabel(followup, today) {
  if (!followup) return null;
  // A FINISHED follow-up is not late. It was due on a day, and that day has
  // passed — "1 day overdue" on something already done is the screen saying
  // there is work outstanding when there is none.
  if (!OPEN.includes(followup.status)) {
    return followup.dueOn ? `Was due ${dayLabel(followup.dueOn)}` : 'No date was set';
  }
  if (!followup.dueOn) return 'No date yet';
  const time = followup.dueTime ? ` at ${followup.dueTime}` : '';
  if (!today) return `Due ${dayLabel(followup.dueOn)}${time}`;
  const days = daysBetween(today, followup.dueOn);
  if (days === null) return `Due ${dayLabel(followup.dueOn)}${time}`;
  if (days === 0) return `Due today${time}`;
  if (days === 1) return `Due tomorrow${time}`;
  if (days === -1) return '1 day overdue';
  if (days < -1) return `${-days} days overdue`;
  if (days <= 7) return `Due in ${days} days${time}`;
  return `Due ${dayLabel(followup.dueOn)}${time}`;
}

/** Still to do, and past its day. Never true for something already finished. */
export const isOverdue = (f, today) => Boolean(
  f && OPEN.includes(f.status) && f.dueOn && today && f.dueOn < today,
);

/**
 * The second line of a row: what it is for, who has it, and where it came
 * from — the three things that make a task actionable weeks later.
 */
export function contextLine(followup, options) {
  if (!followup) return null;
  return [
    labelFor(options?.types, followup.kind),
    followup.reason,
    followup.assignedToName || followup.assignedToEmail,
    sourceLine(followup, options),
  ].filter(Boolean).join(' · ') || null;
}

/** Where it came from (§8), written for a row. */
export function sourceLine(followup, options) {
  if (!followup) return null;
  // A follow-up raised inside a care programme says which one, whatever its
  // source says — the programme is how a pharmacist found it.
  if (followup.programName) return `from ${followup.programName}`;
  if (!followup.sourceType || followup.sourceType === 'manual') return null;
  const kind = labelFor(options?.sourceTypes, followup.sourceType);
  const when = followup.source?.at ? dayLabel(followup.source.at) : null;
  return when ? `from ${kind} — ${when}` : `from ${kind}`;
}

/** What it produced (§12), once it is done. A pointer, never a value. */
export function resultLine(followup, options) {
  if (!followup || !followup.linkedType) return null;
  const kind = labelFor(options?.linkKinds, followup.linkedType);
  if (!followup.linked) return `${kind} — no longer on the record`;
  return [kind, followup.linked.label, followup.linked.detail].filter(Boolean).join(' · ');
}

/** How it went, in the words the pharmacist chose. */
export function outcomeLine(followup, options) {
  if (!followup || !followup.outcome) return null;
  const label = labelFor(options?.outcomes, followup.outcome);
  return followup.outcomeNote ? `${label} — ${followup.outcomeNote}` : label;
}

/** "Moved twice" — visible without reading the audit trail (§14). */
export function movedLine(followup) {
  const n = followup?.rescheduledCount || 0;
  if (!n) return null;
  return n === 1 ? 'Rescheduled once' : `Rescheduled ${n} times`;
}

/**
 * The queue, grouped the way it is worked (§4).
 *
 * Completed and cancelled are kept out of the working groups: they are the
 * history, and a pharmacist scanning for what to do next should not read past
 * them.
 */
export function grouped(followups) {
  const out = BUCKETS.map((b) => ({ ...b, items: [] }));
  const byId = Object.fromEntries(out.map((g) => [g.id, g]));
  for (const f of followups || []) {
    const group = byId[f.bucket];
    if (group) group.items.push(f);
  }
  return out.filter((g) => g.items.length > 0);
}

/**
 * The headline a pharmacist reads first (§17, §26).
 *
 * Counts, and the next thing to do. Nothing here is a percentage or a score:
 * this is a list of work, not a measure of a person.
 */
export function headline(counts, next, today) {
  if (!counts) return null;
  const parts = [];
  if (counts.overdue > 0) parts.push({ id: 'overdue', text: `${counts.overdue} overdue`, tone: 'ui-tone-3' });
  if (counts.today > 0) parts.push({ id: 'today', text: `${counts.today} due today` });
  if (counts.upcoming > 0) parts.push({ id: 'upcoming', text: `${counts.upcoming} upcoming` });
  if (parts.length === 0) return { parts: [], next: null, line: 'Nothing outstanding' };
  return {
    parts,
    next: next ? { title: next.title, due: dueLabel(next, today) } : null,
    line: parts.map((p) => p.text).join(' · '),
  };
}

// ---- this follow-up's history (§18, §29) ---------------------------------

/** "22 Sep 2026, 14:05" — the clock matters on a history, not on a due date. */
export function stampLabel(at) {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dayLabel(at)}, ${time}`;
}

const FIELD_WORDS = Object.freeze({
  title: 'what needs to happen',
  kind: 'type',
  priority: 'priority',
  reason: 'why',
  dueOn: 'due date',
  dueTime: 'time',
  assignedToName: 'who has it',
  assignedToUserId: 'who has it',
  statusReason: 'reason',
  outcomeNote: 'notes',
  sourceType: 'what raised it',
  sourceId: 'what raised it',
  linkedType: 'what it produced',
  linkedId: 'what it produced',
});
const fieldWord = (key) => FIELD_WORDS[key] || key;

/**
 * One event, as a sentence a pharmacist would say.
 *
 * Built ONLY from what the event recorded. An event this screen does not
 * recognise is shown as what it is rather than described wrongly — a confident
 * sentence about the wrong thing is the worse failure.
 */
export function timelineSentence(event, options) {
  const m = (event && event.metadata) || {};
  switch (event?.eventType) {
    case 'FOLLOWUP_CREATED': {
      const detail = [
        labelFor(options?.types, m.kind),
        m.priority === 'urgent' ? 'urgent' : null,
        m.dueOn ? `due ${dayLabel(m.dueOn)}` : 'no date yet',
        m.source && m.source !== 'manual' ? `from ${(labelFor(options?.sourceTypes, m.source) || m.source).toLowerCase()}` : null,
      ].filter(Boolean).join(' · ');
      return { text: 'Created', detail: detail || null };
    }
    case 'FOLLOWUP_RESCHEDULED': {
      const from = m.from ? dayLabel(m.from) : 'no date';
      return {
        text: `Moved from ${from} to ${dayLabel(m.to)}`,
        detail: [m.reason, m.times > 1 ? `moved ${m.times} times` : null].filter(Boolean).join(' · ') || null,
      };
    }
    case 'FOLLOWUP_COMPLETED': {
      const outcome = labelFor(options?.outcomes, m.outcome);
      return {
        text: outcome ? `Completed — ${outcome}` : 'Completed',
        detail: [
          m.note,
          // Recorded here, rather than pointed at something that existed.
          m.readingRecorded ? 'reading recorded in Vitals' : null,
          !m.readingRecorded && m.result ? `linked to a ${(labelFor(options?.linkKinds, m.result.kind) || m.result.kind).toLowerCase()}` : null,
        ].filter(Boolean).join(' · ') || null,
      };
    }
    case 'FOLLOWUP_CANCELLED': {
      const why = labelFor(options?.cancelReasons, m.reason);
      return { text: why ? `Cancelled — ${why}` : 'Cancelled', detail: m.note || null };
    }
    case 'FOLLOWUP_REOPENED':
      return { text: 'Reopened', detail: m.outcome || m.reason || null };
    case 'FOLLOWUP_UPDATED': {
      const fields = Object.keys(m.changes || {});
      return { text: 'Edited', detail: fields.length ? fields.map(fieldWord).join(', ') : null };
    }
    default:
      return { text: 'Recorded', detail: null };
  }
}

/**
 * The counts, for a screen that is not the Follow-up section (§26).
 *
 * One function, used by the patient summary card and the clinical-context
 * brief, so three screens cannot find three ways to say the same thing. Counts
 * only: this is a list of work, never a measure of a person.
 */
export function summaryParts(counts) {
  if (!counts) return [];
  const out = [];
  if (counts.overdue > 0) out.push({ id: 'overdue', text: `${counts.overdue} overdue`, tone: 'ui-tone-3' });
  if (counts.today > 0) out.push({ id: 'today', text: `${counts.today} due today` });
  if (counts.upcoming > 0) out.push({ id: 'upcoming', text: `${counts.upcoming} upcoming` });
  return out;
}

/** How many things are actually waiting — what a card's count should be. */
export const outstandingCount = (counts) => (counts
  ? (counts.overdue || 0) + (counts.today || 0) + (counts.upcoming || 0)
  : 0);

/**
 * Which empty sentence is TRUE of this record, or null when there is work to
 * show. "Nothing outstanding" and "No follow-ups" are different claims —
 * everything raised has been dealt with, versus none was ever raised — and
 * every screen that says one of them asks HERE, so two cannot disagree.
 *
 * It exists because they did: the summary card asked whether any had ever
 * been raised, the medication context brief did not, and on 2026-09-25 the
 * brief told a pharmacist "Nothing outstanding" about a patient who had
 * never had a single follow-up. Found by opening the screen.
 *
 * Neither sentence is "Not recorded" — that belongs to the read that failed
 * or never happened, which is the caller's own to say, because only the
 * caller knows whether it asked.
 */
export function emptyText(counts) {
  if (!counts) return null;
  if (outstandingCount(counts) > 0) return null;
  return counts.all ? EMPTY_TEXT.noneOutstanding : EMPTY_TEXT.noFollowups;
}

/** Why the create form cannot save yet — mirrors the server, never replaces it. */
export function formProblems(form) {
  const out = [];
  if (!String(form?.title || '').trim()) out.push('Say what needs to happen.');
  if (form?.repeats && !form?.dueOn) out.push('A repeating follow-up needs a first due date.');
  if (form?.dueTime && !form?.dueOn) out.push('Say which day, as well as the time.');
  if (form?.sourceId && !form?.sourceType) out.push('Say what kind of record raised this.');
  return out;
}

/** Why the completion panel cannot save yet (§12). */
export function completionProblems(form) {
  const out = [];
  if (!form?.outcome) out.push('Say how the follow-up turned out.');
  if (form?.linkedType && !form?.linkedId) out.push('Choose the record it produced, or clear the kind.');
  // Recording a reading and pointing at one are two answers to "what did this
  // produce". The server refuses both together; the panel says so first.
  if (form?.recordReading && form?.linkedId) {
    out.push('Record a reading, or point at one — not both.');
  }
  if (form?.recordReading && !hasAnyReading(form.reading)) {
    out.push('Enter at least one measurement, or turn off recording a reading.');
  }
  return out;
}

/** A reading with nothing in it is a mis-click, not a reading of nothing. */
export function hasAnyReading(reading) {
  return Object.values(reading || {}).some((v) => String(v ?? '').trim() !== '');
}

/** Why the cancel dialog cannot save yet (§15). */
export function cancelProblems(form) {
  return form?.reason ? [] : ['Say why this follow-up is being cancelled.'];
}

export { OPEN };
