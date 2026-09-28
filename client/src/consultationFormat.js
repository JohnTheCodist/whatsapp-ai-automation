/**
 * How the consultation note reads.
 *
 * Pure functions, so the wording is testable without a screen — the same
 * reason `followupFormat` and `messageFormat` exist. The wording matters here
 * more than in most sections: a consultation is one pharmacist's account of a
 * medical interaction, written so another pharmacist can act on it.
 */

/** §39 / Medplum ClinicalImpression. */
export const STATUS_LABEL = Object.freeze({
  draft: 'Draft',
  in_progress: 'In progress',
  completed: 'Completed',
  // Not "deleted": the note is still there, and still readable.
  entered_in_error: 'Entered in error',
});

/**
 * Only two states carry a tone, and neither is red.
 *
 * design.md gives red to a person waiting on a human and says only
 * Consultations earns it — and the CONSULTATION DESK is what that refers to,
 * where somebody really is waiting. A note being unfinished is not that, so
 * an open note takes amber and a retired one takes the quiet tone.
 */
export const STATUS_TONE = Object.freeze({
  draft: 'ui-tone-1',
  in_progress: 'ui-tone-1',
  completed: null,
  entered_in_error: 'ui-tone-quiet',
});

export const statusLabel = (s) => STATUS_LABEL[s] || null;
export const statusTone = (s) => STATUS_TONE[s] || null;

/** An open note can still be written to. */
export const isOpen = (c) => c?.status === 'draft' || c?.status === 'in_progress';

/** Nigeria runs on UTC+1, and the pharmacy's day is the one that matters. */
export function lagosToday(now = new Date()) {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function lagos(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 60 * 60 * 1000);
}

/** "27 Sept 2026" — how a note is dated in its history (§28). */
export function dayLabel(iso) {
  const d = lagos(iso);
  if (!d) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Today", or the date. Used at the top of an open note. */
export function whenLabel(iso, today = lagosToday()) {
  const d = lagos(iso);
  if (!d) return null;
  if (d.toISOString().slice(0, 10) === today) return 'Today';
  return dayLabel(iso);
}

/**
 * The one line a history row shows under its title.
 *
 * The reason the patient came, in the pharmacist's own words where they wrote
 * any — never a paraphrase, and never a guess when they wrote nothing.
 */
export function reasonLine(consultation, reasons = []) {
  if (!consultation) return null;
  const coded = reasons.find((r) => r.id === consultation.reasonCode);
  const parts = [coded ? coded.label : null, consultation.reasonText].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : null;
}

/**
 * What a note still needs before it can be finalised, said as one line.
 *
 * The server computes the list from the type; this turns it into the sentence
 * on the button's tooltip. It never says "incomplete" on its own — a
 * pharmacist told only that something is missing has to hunt for it.
 */
export function outstandingLine(outstanding) {
  const items = (outstanding || []).filter(Boolean);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return `${items.length} things still to record: ${items.join(' ')}`;
}

/**
 * What the triage panel says (§6).
 *
 * THE DISTINCTION THIS FUNCTION EXISTS FOR: an encounter that recorded no red
 * flags reports an empty list, and that is NOT the same as "no red flags".
 * The engine looked and found none — so the honest phrasing is "none
 * recorded", which says who looked. Saying "None" would read as a clinical
 * all-clear that nobody signed.
 */
export const NO_RED_FLAGS = 'None recorded';

export function redFlagLine(triage) {
  if (!triage) return null;
  const flags = triage.redFlags || [];
  if (flags.length === 0) return { text: NO_RED_FLAGS, tone: null };
  return { text: flags.join(', '), tone: 'ui-tone-1' };
}

/** A consultation with no episode behind it has no triage — and says nothing. */
export const NO_TRIAGE = 'No triage — this consultation was not raised from a conversation.';

/** Empty states. None of them claims anything about the patient. */
export const EMPTY = Object.freeze({
  none: 'No consultations',
  noneHelp: 'Nothing has been documented for this patient yet.',
  notRecorded: 'Not recorded',
});

/**
 * The summary, as lines a screen can print (§22).
 *
 * The server assembles the parts from what was entered; this only flattens
 * them. It adds nothing, which is the point — a formatter that filled a gap
 * would be inventing a clinical finding two layers from where anyone would
 * look for it.
 */
export function summaryLines(summary) {
  return (summary || []).map((part) => ({
    id: part.id,
    label: part.label,
    text: (part.lines || []).join('\n'),
  }));
}

/* ==========================================================================
 * Phase 2 — problems, interventions, referral
 * ======================================================================== */

/**
 * How a problem reads on screen (§11, §12).
 *
 * The certainty is printed WITH the label, because "angina" and "possible
 * angina" are different clinical statements. `established` prints bare — a
 * pharmacist who said established meant it, and prefixing it would read as
 * hedging something they did not hedge.
 */
export function problemLine(problem, certainties = [], statuses = []) {
  if (!problem) return null;
  const certainty = problem.certainty === 'established'
    ? null
    : (certainties.find((c) => c.id === problem.certainty) || {}).label;
  const status = (statuses.find((s) => s.id === problem.status) || {}).label || null;
  return {
    label: [certainty, problem.label].filter(Boolean).join(' '),
    status,
    // What the pointer resolves to TODAY, read from the owning section — or
    // null, which the screen says rather than dropping the row.
    record: problem.record || null,
    gone: Boolean(problem.refKind && !problem.record),
  };
}

/** A pointer whose record has since been deleted still says it was attached. */
export const RECORD_GONE = 'No longer on the record';

/**
 * §17 — what the referral panel says.
 *
 * THE DISTINCTION THIS FUNCTION EXISTS FOR, on the client as well as the
 * server: a null destination means referral was never considered, and the
 * screen must say nothing rather than "Not required". That sentence on a note
 * where nobody considered it is a decision the software invented.
 */
export const REFERRAL_NOT_CONSIDERED = 'Not recorded';

export function referralLine(consultation, destinations = [], urgencies = []) {
  if (!consultation || !consultation.referralDestination) return null;
  const destination = (destinations.find((d) => d.id === consultation.referralDestination) || {}).label
    || consultation.referralDestination;
  const urgency = (urgencies.find((u) => u.id === consultation.referralUrgency) || {}).label || null;
  return {
    destination,
    urgency,
    reason: consultation.referralReason || null,
    // Emergency is the one that should catch an eye. design.md keeps red for
    // a person waiting on a human, so this takes amber — the strongest tone
    // this screen is entitled to.
    tone: consultation.referralUrgency === 'emergency' || consultation.referralDestination === 'emergency'
      ? 'ui-tone-1'
      : null,
  };
}

/** Empty states for the two lists. Neither claims anything about the patient. */
export const NO_PROBLEMS = 'No problems recorded';
export const NO_INTERVENTIONS = 'No interventions recorded';

/* ==========================================================================
 * Phase 3 — amendment and the audit view (§32)
 * ======================================================================== */

/**
 * What a note says about having been corrected.
 *
 * THE DISTINCTION THIS FUNCTION EXISTS FOR: a note that has never been
 * amended says NOTHING. Not "Original", not "Version 1", not "No amendments" —
 * all three are claims about a history nobody has looked at, and the first
 * two invent a version number this product does not have.
 *
 * A note that HAS been amended must say so wherever it is read, because the
 * text on screen is not what was originally signed and the next pharmacist
 * is entitled to know that before acting on it.
 */
export function amendedNote(consultation) {
  const n = Number(consultation?.amendmentCount) || 0;
  if (n < 1) return null;
  return n === 1 ? 'Amended once' : `Amended ${n} times`;
}

/**
 * Whether the screen may offer to amend this note.
 *
 * Only a FINALISED one. An open note is simply edited, and offering
 * "Amend" on a draft would ask a pharmacist for a reason to change text
 * nobody has signed. A retired note is not amendable at all (§39) — it was
 * withdrawn, and editing it back into the record is what that rule prevents.
 */
export const canAmend = (c) => c?.status === 'completed';

/**
 * Retired notes are not corrected; they are left alone, visibly.
 *
 * This sits in the banner that already explains the status, NOT in a section
 * headed "Amend this note" — which is what the first version did, and a
 * heading that names an action the panel then refuses is a worse answer than
 * no panel at all.
 */
export const AMEND_RETIRED = 'It is not amended either: a note that should never have existed is left as it is.';

/**
 * §32's history, in words.
 *
 * The event log stores machine names (`CONSULTATION_PROBLEM_ADDED`). A
 * pharmacist reading why a record changed should not be made to decode them,
 * and a screen that prints the raw name is telling them the software's
 * business rather than their own.
 */
export const HISTORY_LABEL = Object.freeze({
  CONSULTATION_STARTED: 'Consultation opened',
  CONSULTATION_COMPLETED: 'Finalised',
  CONSULTATION_AMENDED: 'Amended',
  CONSULTATION_ENTERED_IN_ERROR: 'Marked entered in error',
  CONSULTATION_PROBLEM_ADDED: 'Problem list changed',
  CONSULTATION_INTERVENTION_RECORDED: 'Intervention recorded',
  CONSULTATION_REFERRAL_RECORDED: 'Referral decision recorded',
});

/**
 * One line of the history.
 *
 * An event this build has no wording for is shown by its raw name rather
 * than dropped. A history that silently omits what it cannot label is worse
 * than an ugly one: it reads as complete when it is not, which is the one
 * thing an audit trail must never do.
 */
export function historyLine(event) {
  if (!event) return null;
  const label = HISTORY_LABEL[event.eventType] || event.eventType;
  const reason = event.metadata?.reason || null;
  return {
    label,
    reason,
    who: event.actor || null,
    when: dayLabel(event.occurredAt),
    // Unlabelled events are still SHOWN, and marked so the gap is visible.
    unlabelled: !HISTORY_LABEL[event.eventType],
  };
}

/**
 * What one snapshot shows.
 *
 * The lines are the summary the note HAD — already assembled by the server
 * when the snapshot was taken, so the history shows the note the way a
 * pharmacist would have read it rather than making anybody rebuild it from
 * columns. Nothing is recomputed here: a snapshot must keep saying what it
 * said, even after the vocabulary or the summary order changes.
 */
export function snapshotLines(amendment) {
  if (!amendment) return [];
  return summaryLines(amendment.snapshot?.summary || []);
}

export const NO_HISTORY = 'No history recorded';
