/**
 * A patient's conditions (the problem list), as the dashboard writes them.
 *
 * PURE — no React, no fetch. The failure these words defend against is an
 * uncertain condition read as a diagnosis: "Asthma · Provisional" must never
 * look like "Asthma · Confirmed", and the software must never read as though
 * a pharmacist diagnosed something that was only reported.
 *
 * THE VOCABULARY IS THE SERVER'S (GET /problems/options). What is here is how
 * it is written, grouped and toned.
 */

/** The six FHIR statuses, grouped the way the screen talks about them. */
export const STATUS_GROUP = Object.freeze({
  active: 'active',
  recurrence: 'active',
  relapse: 'active',
  inactive: 'inactive',
  remission: 'resolved',
  resolved: 'resolved',
});

/** Filters over the whole record, the brief's list. */
export const CONDITION_FILTERS = Object.freeze([
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'refuted', label: 'Refuted' },
]);

const UNTRUE = ['refuted', 'entered_in_error'];

/** Does this record pass a filter? Refuted and in-error answer only to "Refuted". */
export function matchesFilter(p, filter) {
  if (!filter) return true;
  const untrue = UNTRUE.includes(p.verificationStatus);
  if (filter === 'refuted') return untrue;
  if (untrue) return false;
  return STATUS_GROUP[p.clinicalStatus] === filter;
}

/**
 * How sure the record is, as the screen must show it. Only Confirmed reads
 * plainly; everything else is visibly qualified.
 */
export const VERIFICATION_TONE = Object.freeze({
  confirmed: 'ui-cond-confirmed',
  provisional: 'ui-med-draft',
  unconfirmed: 'ui-med-draft',
  differential: 'ui-med-draft',
  refuted: 'ui-tone-quiet',
  entered_in_error: 'ui-tone-quiet',
});

export const isCertain = (p) => p.verificationStatus === 'confirmed';

/** Lower-case the first letter unless it starts an acronym (COPD, GORD). */
function lowerFirst(s) {
  if (!s) return s;
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * The name as it should be READ.
 *   provisional   "Possible asthma"
 *   differential  "? Asthma"
 *   otherwise     the name as recorded
 * The recorded name itself is never changed — this is only how it is shown.
 */
export function displayName(p) {
  if (!p) return '';
  if (p.verificationStatus === 'provisional') return `Possible ${lowerFirst(p.conditionName)}`;
  if (p.verificationStatus === 'differential') return `? ${p.conditionName}`;
  return p.conditionName;
}

/** The label for a value, from the server's own list; the raw value if absent. */
export function labelFor(list, value) {
  if (!value) return null;
  const hit = (list || []).find((o) => o.value === value);
  return hit ? hit.label : value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "~2022", "Aug 2026", "15 Aug 2026", or null — at the precision given. */
export function partialDateLabel(d) {
  if (!d || !d.date) return null;
  const [y, m, day] = d.date.split('-');
  if (d.precision === 'year') return `~${y}`;
  if (d.precision === 'month') return `${MONTHS[Number(m) - 1]} ${y}`;
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Back to the form's shape: "2022", "2026-08", "2026-08-15", or "". */
export function partialDateInput(d) {
  if (!d || !d.date) return '';
  if (d.precision === 'year') return d.date.slice(0, 4);
  if (d.precision === 'month') return d.date.slice(0, 7);
  return d.date;
}

/** Onset as a line: the date if known, else the note ("Since childhood"). */
export function onsetLabel(p) {
  return partialDateLabel(p?.onset) || p?.onset?.note || null;
}

/** "22 Sep 2026" for a timestamp. */
export function dayLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Where a record in the history stands. Truth outranks currency. */
export function historyStatus(p, statuses) {
  if (p.verificationStatus === 'refuted') return 'Refuted';
  if (p.verificationStatus === 'entered_in_error') return 'Entered in error';
  return labelFor(statuses, p.clinicalStatus) || p.clinicalStatus;
}

/** "Consultation — 22 Sep 2026", when it was documented at one. */
export function encounterLabel(p) {
  if (!p?.encounter) return null;
  const when = dayLabel(p.encounter.startedAt);
  return when ? `Consultation — ${when}` : 'Consultation';
}

/**
 * The history as a timeline: grouped by the month (or year) it began,
 * newest first; conditions with no onset last, under "Onset unknown".
 */
export function timeline(problems) {
  const groups = new Map();
  for (const p of problems || []) {
    let key;
    let label;
    if (!p.onset?.date) {
      key = '0000';
      label = 'Onset unknown';
    } else if (p.onset.precision === 'year') {
      key = p.onset.date.slice(0, 4);
      label = key;
    } else {
      key = p.onset.date.slice(0, 7);
      const [y, m] = key.split('-');
      label = `${MONTHS[Number(m) - 1]} ${y}`;
    }
    if (!groups.has(key)) groups.set(key, { key, label, problems: [] });
    groups.get(key).problems.push(p);
  }
  // Newest first. A month sorts after its own year ("2026-08" > "2026"),
  // which is the right way round: the precise date is more recent news.
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/** Who wrote it down and who last changed it. */
export function byLine(p) {
  const recorded = p?.recordedBy?.email || null;
  const updated = p?.updatedBy?.email || null;
  const parts = [recorded ? `Recorded by ${recorded}` : 'Recorded'];
  if (updated && updated !== recorded) parts.push(`last changed by ${updated}`);
  return parts.join(', ');
}

/** The hints the server returns for a name, as words. Never a refusal. */
export const HINT_TEXT = Object.freeze({
  symptom: 'This reads like a symptom. Symptoms usually belong in the consultation, not the problem list.',
  allergy: 'Allergies have their own record, with reactions and severity. Use the Allergies tab.',
});

/** Why the form cannot save yet — mirrors the server, does not replace it. */
export function formProblems(form) {
  const out = [];
  if (!String(form?.conditionName || '').trim()) out.push('Say what the condition is.');
  if (UNTRUE.includes(form?.verificationStatus) && !String(form?.statusReason || '').trim()) {
    out.push(form.verificationStatus === 'refuted' ? 'Say why it was refuted.' : 'Say why it was entered in error.');
  }
  if (form?.abatement && !['inactive', 'remission', 'resolved'].includes(form?.clinicalStatus)) {
    out.push('Only a resolved, in-remission or inactive condition has a resolution date.');
  }
  return out;
}
