/**
 * A patient's medication, as the dashboard reads it.
 *
 * PURE — labels, the dosing line, and how a history is grouped. No React, no
 * fetch, so the wording is testable. These strings are read as instructions
 * about what a person is putting in their body, which is the reason this
 * file exists rather than the formatting being inline.
 *
 * THE VOCABULARY IS THE SERVER'S. Forms, routes, frequencies, statuses and
 * sources come from GET /medications/options — the same lists the server
 * validates against. What is here is only how they are WRITTEN on screen.
 */

/** The workspace's three sections. */
export const MED_TABS = Object.freeze([
  { id: 'current', label: 'Current' },
  { id: 'history', label: 'History' },
  { id: 'review', label: 'Medication review' },
]);

/** Filters over the history, the brief's list. */
export const HISTORY_FILTERS = Object.freeze([
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'draft', label: 'Draft' },
]);

/**
 * How a status is shown. `tone` is the app's named status tone, so a stopped
 * medicine reads the same here as anywhere else; `--ui-tone-*` carries the
 * colour. Active is the ONLY one in the brand green: it is the answer to
 * "what is this patient taking", and everything else is history.
 */
export const MED_STATUS = Object.freeze({
  draft: { label: 'Draft', tone: 'ui-med-draft' },
  active: { label: 'Active', tone: 'ui-med-active' },
  completed: { label: 'Completed', tone: 'ui-tone-quiet' },
  stopped: { label: 'Stopped', tone: 'ui-tone-2' },
  cancelled: { label: 'Cancelled', tone: 'ui-tone-quiet' },
});

/** Where the record came from — shown only when it is NOT a prescription. */
export const MED_SOURCE = Object.freeze({
  prescribed: null,
  patient_reported: 'Patient reported',
  pharmacist_added: 'Pharmacist added',
  imported: 'Imported',
  historical: 'Historical',
});

const FREQUENCY_WORDS = Object.freeze({
  once_daily: 'Once daily',
  twice_daily: 'Twice daily',
  three_times_daily: 'Three times daily',
  four_times_daily: 'Four times daily',
  every_4_hours: 'Every 4 hours',
  every_6_hours: 'Every 6 hours',
  every_8_hours: 'Every 8 hours',
  every_12_hours: 'Every 12 hours',
  weekly: 'Weekly',
  as_needed: 'As needed',
  other: 'Other',
});

const ROUTE_WORDS = Object.freeze({
  oral: 'Oral',
  topical: 'Topical',
  im: 'IM',
  iv: 'IV',
  sc: 'SC',
  inhaled: 'Inhaled',
  ophthalmic: 'Eye',
  otic: 'Ear',
  nasal: 'Nasal',
  rectal: 'Rectal',
  vaginal: 'Vaginal',
  sublingual: 'Sublingual',
  other: 'Other',
});

export const frequencyLabel = (v) => FREQUENCY_WORDS[v] || null;
export const routeLabel = (v) => ROUTE_WORDS[v] || null;

/** "10 mg tablet" — what the medicine IS, under its name. */
export function productLine(m) {
  return [m.strength, m.form].filter(Boolean).join(' ') || null;
}

/**
 * The dosing line: "1 tablet · Oral · Twice daily · 30 days".
 *
 * ONLY WHAT WAS RECORDED. A pharmacist writing up what a patient says they
 * take often knows the name and nothing else, and a line padded with "—" for
 * every unknown reads as though the blanks were answers.
 */
export function dosingLine(m) {
  return [
    m.dose,
    routeLabel(m.route),
    frequencyLabel(m.frequency),
    durationLabel(m),
  ].filter(Boolean).join(' · ') || null;
}

/** "30 days", or "Ongoing" — which is the normal case, not a missing value. */
export function durationLabel(m) {
  if (m.durationDays == null) return m.status === 'active' ? 'Ongoing' : null;
  return `${m.durationDays} day${m.durationDays === 1 ? '' : 's'}`;
}

/** Who said so. An outside prescriber has a name; one of ours has an email. */
export function prescriberLabel(m) {
  if (!m.prescriber) return null;
  return m.prescriber.name || m.prescriber.email || null;
}

const DATE = { day: '2-digit', month: 'short', year: 'numeric' };

export function medDate(iso) {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { ...DATE, timeZone: 'UTC' });
}

/** "15 Sep 2026 – 15 Oct 2026", or "since 15 Sep 2026" while it is running. */
export function courseLabel(m) {
  const from = medDate(m.startedOn);
  if (!from) return null;
  const to = medDate(m.endedOn);
  if (to) return `${from} – ${to}`;
  return m.status === 'active' || m.status === 'draft' ? `since ${from}` : from;
}

/**
 * History grouped by the month it STARTED, newest month first.
 *
 * Grouped rather than listed because the question a history answers is "what
 * changed, and when" — an undifferentiated list of forty rows answers it
 * only if you already know the dates you are looking for.
 */
export function groupByMonth(medications) {
  const months = new Map();
  for (const m of medications || []) {
    if (!m.startedOn) continue;
    const key = m.startedOn.slice(0, 7);            // YYYY-MM
    if (!months.has(key)) months.set(key, { key, label: monthLabel(key), medications: [] });
    months.get(key).medications.push(m);
  }
  return [...months.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function monthLabel(key) {
  const [year, month] = key.split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1))
    .toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The count line above a list. */
export function medicationsSummary(counts, tab) {
  if (!counts) return '';
  const n = tab === 'current' ? counts.current : counts.history;
  if (n === 0) return tab === 'current' ? 'No current medication' : 'Nothing in the history';
  return `${n} medicine${n === 1 ? '' : 's'}`;
}
