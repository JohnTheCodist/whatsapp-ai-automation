/**
 * A medication review, as the dashboard reads it.
 *
 * PURE — no React, no fetch. The wording of a clinical record is the part
 * worth testing: these strings say what a pharmacist found and what they did
 * about it, and a sentence that overstates either is the failure this screen
 * has.
 *
 * THE VOCABULARY IS THE SERVER'S. Problems, interventions, outcomes and the
 * adherence values all come from GET /medication-reviews/options — the same
 * lists the server validates against. What is here is only how they are
 * written on screen, and in which order they are read.
 *
 * NOTHING HERE RANKS. No severity, no risk score, no "3 issues found ⚠". A
 * count is a count; the pharmacist decides what it means.
 */

/**
 * How adherence is shown.
 *
 * Poor adherence wears the app's warning tone because it is work queued for
 * a pharmacist, not an alarm — red in this product is reserved for a person
 * waiting. 'Unknown' is deliberately quiet rather than tonal: it is an
 * honest answer, not a problem.
 */
export const ADHERENCE_TONE = Object.freeze({
  good: 'ui-med-active',
  partial: 'ui-tone-2',
  poor: 'ui-tone-3',
  unknown: 'ui-tone-quiet',
});

/** Where the review was left. Shown as a plain chip, in no ranked order. */
export const OUTCOME_TONE = Object.freeze({
  resolved: 'ui-med-active',
  monitoring: 'ui-tone-1',
  prescriber_follow_up: 'ui-tone-2',
  referred: 'ui-tone-2',
  pending: 'ui-tone-quiet',
});

/** The label for a value, from the server's own list. */
export function labelFor(list, value) {
  if (!value) return null;
  const hit = (list || []).find((o) => o.value === value);
  return hit ? hit.label : value;
}

const DATE = { day: '2-digit', month: 'short', year: 'numeric' };

export function reviewDate(iso) {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { ...DATE, timeZone: 'UTC' });
}

/**
 * "2 problems · 2 interventions", or "Nothing found".
 *
 * A review that found nothing is a real and common result — it says the
 * medicines were checked and were right. It is written as a finding, not as
 * an empty list, because an empty list reads as a review nobody did.
 */
export function findingsLine(review) {
  const problems = review?.problems?.length || 0;
  const actions = review?.actions?.length || 0;
  if (!problems && !actions) return 'Nothing found';
  const parts = [];
  if (problems) parts.push(`${problems} problem${problems === 1 ? '' : 's'}`);
  if (actions) parts.push(`${actions} intervention${actions === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** "Follow up 21 Oct 2026 — Check the blood pressure". Both halves or none. */
export function followUpLine(review) {
  if (!review?.followUpOn || !review?.followUpReason) return null;
  return `Follow up ${reviewDate(review.followUpOn)} — ${review.followUpReason}`;
}

/** Who signed it and when, or that it is still being written. */
export function reviewByLine(review) {
  if (!review) return null;
  if (review.status !== 'signed') return 'Draft — not signed';
  const who = review.reviewer?.email || null;
  const when = reviewDate(review.signedAt);
  // An unattributed review is still a review that happened; it says so
  // rather than naming nobody.
  if (!who) return when ? `Signed ${when}` : 'Signed';
  return when ? `Signed ${when} by ${who}` : `Signed by ${who}`;
}

/**
 * The findings, read the way they were made: each problem with the
 * interventions that answer it, and the general interventions after.
 *
 * This grouping IS the point of the three tables (0056). A flat list of
 * problems beside a flat list of interventions cannot answer "which
 * interaction did you ring the prescriber about".
 */
export function findingsByProblem(review) {
  const problems = review?.problems || [];
  const actions = review?.actions || [];
  const grouped = problems.map((p) => ({
    ...p,
    actions: actions.filter((a) => a.problemId === p.id),
  }));
  return {
    problems: grouped,
    // An intervention belonging to no single problem — "counselling
    // provided" over the whole review — is not an orphan.
    general: actions.filter((a) => !a.problemId),
  };
}

/**
 * Why this draft cannot be signed yet, in the order a pharmacist would fix
 * them. Empty means it can.
 *
 * THIS MIRRORS THE SERVER'S GATE, it does not replace it — the server
 * refuses the same things (medicationReviewInput.js). It exists so the
 * button can say what is missing instead of the form failing on submit.
 */
export function blockingReasons(draft) {
  const reasons = [];
  if (!draft?.outcome) reasons.push('Say how the review was left.');
  if ((draft?.problems?.length || 0) > 0 && (draft?.actions?.length || 0) === 0) {
    reasons.push('Record what you did about the problems you found.');
  }
  if (draft?.followUpOn && !draft?.followUpReason) reasons.push('Say what the follow-up is for.');
  if (draft?.followUpReason && !draft?.followUpOn) reasons.push('Say when to follow up.');
  return reasons;
}

/** What a medicine is called on a review line: "Amlodipine 10 mg". */
export function medicineLabel(m) {
  if (!m) return null;
  return [m.medicineName, m.strength].filter(Boolean).join(' ');
}

/** The heading over the history: how many times this patient was reviewed. */
export function reviewsSummary(reviews) {
  const n = reviews?.length || 0;
  if (n === 0) return 'No medication review recorded';
  return `${n} review${n === 1 ? '' : 's'}`;
}
