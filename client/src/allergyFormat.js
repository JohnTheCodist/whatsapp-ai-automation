/**
 * A patient's allergy record, as the dashboard writes it.
 *
 * PURE — no React, no fetch. These are the words a pharmacist reads before
 * handing over a medicine, and the one this file exists to protect is the
 * word it never writes: an empty record is "Not assessed", never "None".
 *
 * THE VOCABULARY IS THE SERVER'S (GET /allergies/options). What is here is
 * only how it is written, and which tone each value wears.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every state carries an icon and a word.
 * And no red: design.md keeps red for "a person is waiting". A known allergy
 * and a high criticality wear the amber attention ramp — the owner's call,
 * ALLERGIES_PLAN.md §5.1.
 */

/** The three states, and how each is said. */
export const ALLERGY_STATE = Object.freeze({
  known: { icon: 'alert', tone: 'ui-allergy-known' },
  none_known: { icon: 'check', tone: 'ui-allergy-none', label: 'No known allergies' },
  not_assessed: { icon: 'unknown', tone: 'ui-allergy-unassessed', label: 'Allergies not assessed' },
});

/** "2 known allergies", "No known allergies", "Allergies not assessed". */
export function stateLabel(state, count = 0) {
  if (state === 'known') return `${count} known ${count === 1 ? 'allergy' : 'allergies'}`;
  if (state === 'none_known') return ALLERGY_STATE.none_known.label;
  // Anything unrecognised reads as the cautious answer, never as "none".
  return ALLERGY_STATE.not_assessed.label;
}

/**
 * The one-line strip shown across the patient record:
 *   "Allergies: Penicillin, Peanuts"  ·  "No known allergies"  ·  "Allergies not assessed"
 * Names only, up to `max`, then "+2" — it is a pointer to the tab, not the tab.
 */
export function stripLabel(summary, max = 3) {
  if (!summary || summary.state !== 'known') return stateLabel(summary?.state);
  const names = (summary.allergies || []).map((a) => a.allergenName);
  const shown = names.slice(0, max).join(', ');
  const more = names.length > max ? ` +${names.length - max}` : '';
  return `Allergies: ${shown}${more}`;
}

/** Tone for a criticality chip. Only High draws the eye. */
export const CRITICALITY_TONE = Object.freeze({
  high: 'ui-tone-3',
  low: 'ui-tone-quiet',
  unable_to_assess: 'ui-tone-quiet',
});

/** Tone for a verification chip. Unconfirmed is outlined: unfinished, not safe. */
export const VERIFICATION_TONE = Object.freeze({
  confirmed: 'ui-allergy-confirmed',
  unconfirmed: 'ui-med-draft',
  refuted: 'ui-tone-quiet',
  entered_in_error: 'ui-tone-quiet',
});

/** The label for a value, from the server's own list; the raw value if absent. */
export function labelFor(list, value) {
  if (!value) return null;
  const hit = (list || []).find((o) => o.value === value);
  return hit ? hit.label : value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A date at the precision it was given.
 *   year  -> "~2021"      the tilde says "about", which is what the patient said
 *   month -> "Mar 2021"
 *   day   -> "15 Mar 2021"
 *   none  -> null         unknown, shown as a dash by the caller
 */
export function partialDateLabel(d) {
  if (!d || !d.date) return null;
  const [y, m, day] = d.date.split('-');
  if (d.precision === 'year') return `~${y}`;
  if (d.precision === 'month') return `${MONTHS[Number(m) - 1]} ${y}`;
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * What a form sends back for a partial date: the shape the server reads
 * precision from. { date: '2021-01-01', precision: 'year' } -> "2021".
 */
export function partialDateInput(d) {
  if (!d || !d.date) return '';
  if (d.precision === 'year') return d.date.slice(0, 4);
  if (d.precision === 'month') return d.date.slice(0, 7);
  return d.date;
}

/**
 * The reactions, as a line: "Rash · Facial swelling · Joint pain".
 * "Other" is replaced by what it was — "Other" alone tells nobody anything.
 */
export function reactionsLine(reactions, manifestations) {
  const parts = (reactions || []).map((r) => {
    const code = typeof r === 'string' ? r : r.manifestation;
    if (code === 'other') return (typeof r === 'object' && r.description) || 'Other reaction';
    return labelFor(manifestations, code) || code;
  });
  return parts.join(' · ') || null;
}

/** "Medication · Allergy" — what it is, under its name. */
export function kindLine(a, options) {
  return [
    a.category && a.category !== 'unknown' ? labelFor(options?.categories, a.category) : null,
    a.type && a.type !== 'unknown' ? labelFor(options?.types, a.type) : null,
  ].filter(Boolean).join(' · ') || null;
}

/**
 * Where a record in the history now stands: "Resolved", "Inactive",
 * "Refuted", "Entered in error". Truth outranks currency — a refuted record
 * reads as Refuted, whatever its clinical status.
 */
export function historyStatus(a) {
  if (a.verificationStatus === 'refuted') return 'Refuted';
  if (a.verificationStatus === 'entered_in_error') return 'Entered in error';
  if (a.clinicalStatus === 'resolved') return 'Resolved';
  if (a.clinicalStatus === 'inactive') return 'Inactive';
  return 'Active';
}

/** Who wrote it down and who last changed it. */
export function byLine(a) {
  const who = (u) => u?.email || null;
  const recorded = who(a.recordedBy);
  const updated = who(a.updatedBy);
  const parts = [];
  parts.push(recorded ? `Recorded by ${recorded}` : 'Recorded');
  if (updated && updated !== recorded) parts.push(`last changed by ${updated}`);
  return parts.join(', ');
}

/**
 * Why the form cannot save yet, said before the button is pressed. Mirrors
 * the server's own refusals (allergyInput.js); does not replace them.
 */
export function formProblems(form) {
  const out = [];
  if (!String(form?.allergenName || '').trim()) out.push('Say what the patient reacts to.');
  if ((form?.reactions || []).includes('other') && !String(form?.otherReaction || '').trim()) {
    out.push('Say what the other reaction was.');
  }
  if (['refuted', 'entered_in_error'].includes(form?.verificationStatus) && !String(form?.statusReason || '').trim()) {
    out.push(form.verificationStatus === 'refuted' ? 'Say why it was refuted.' : 'Say why it was entered in error.');
  }
  return out;
}
