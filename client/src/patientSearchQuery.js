/**
 * The patient search's filters, as the dashboard holds them.
 *
 * The ORDER and the NAMES are the owner's: Age, Condition, Gender,
 * Medication, Last visit, Follow-up due, Assigned pharmacist, Risk flag.
 * The VALUES each one can take come from the server
 * (GET /api/customers/search/options), which also validates them — so this
 * file never lists a value of its own, and the screen cannot offer one the
 * server would refuse.
 */

export const FILTERS = Object.freeze([
  { key: 'age', label: 'Age' },
  { key: 'condition', label: 'Condition' },
  { key: 'gender', label: 'Gender' },
  { key: 'medication', label: 'Medication' },
  { key: 'lastVisit', label: 'Last visit' },
  { key: 'followUp', label: 'Follow-up due' },
  { key: 'pharmacist', label: 'Assigned pharmacist' },
  { key: 'risk', label: 'Risk flag' },
]);

/**
 * The chronic switch is a filter the server runs like any other, but it is
 * NOT one of the eight: it is a visible switch on the toolbar rather than a
 * value inside the panel. So it is kept out of FILTERS — out of the grid,
 * out of the chips and out of the count on the filter button — because all
 * three exist to surface what is hidden, and a switch is already showing its
 * own state.
 */
export const CHRONIC = Object.freeze({ key: 'chronic', label: 'Only chronic patients' });

export const EMPTY_FILTERS = Object.freeze({
  ...Object.fromEntries(FILTERS.map((f) => [f.key, ''])),
  [CHRONIC.key]: false,
});

/** How many of the eight are set — drives the button's badge and the chips. */
export function activeFilterCount(filters) {
  return FILTERS.filter(({ key }) => Boolean(filters?.[key])).length;
}

/** Anything narrowing the list, including the switch and the search text. */
export function isNarrowed(q, filters) {
  return activeFilterCount(filters) > 0 || Boolean(filters?.[CHRONIC.key]) || (q || '').trim() !== '';
}

/**
 * The query string for GET /api/customers/search. Blank values are left
 * out entirely: the server reads a missing key as "not filtering", and an
 * empty one would only be noise in the URL.
 */
export function buildSearchQuery(q, filters) {
  const params = new URLSearchParams();
  const text = (q || '').trim();
  if (text) params.set('q', text);
  for (const { key } of FILTERS) {
    if (filters?.[key]) params.set(key, filters[key]);
  }
  // The switch has one spelling on the wire — present and "on", or absent.
  // The server refuses anything else rather than reading it as off.
  if (filters?.[CHRONIC.key]) params.set(CHRONIC.key, 'on');
  return params.toString();
}

/** The label of a chosen value, for the active pill, or '' if unknown. */
export function optionLabel(options, key, value) {
  return (options?.[key] || []).find((o) => o.value === value)?.label || '';
}

/** Words for the result count. */
export function resultSummary({ total, shown, filtered }) {
  if (total === 0) return filtered ? 'No patients match' : 'No patients yet';
  const noun = total === 1 ? 'patient' : 'patients';
  if (shown < total) return `Showing ${shown} of ${total} ${noun}`;
  return `${total} ${noun}`;
}

export const RISK_LABEL = Object.freeze({
  red_flag: 'Danger sign',
  lapsed: 'Lapsed',
  follow_up: 'Follow-up',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Last visit" in words, counted in Lagos calendar days from the server's
 * `today` — never the browser's clock, which may sit in another timezone.
 */
export function visitLabel(lastVisitOn, today) {
  if (!lastVisitOn) return 'Never';
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastVisitOn}T00:00:00Z`)) / DAY_MS);
  if (Number.isNaN(days)) return '—';
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  return new Date(`${lastVisitOn}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
