/**
 * The clinical protocols the assistant runs, as the Workflows screen reads
 * them.
 *
 * PURE — no React, no fetch. The vocabulary is the server's
 * (GET /api/protocols); what is here is how it is worded, grouped and toned.
 *
 * THE WORDING RULE THIS SCREEN LIVES BY. Every line answers "is this thing
 * asking my patients questions tonight?" — and the honest answer has FOUR
 * states, not two:
 *
 *   RUNNING        wired up in code AND active for this pharmacy
 *   AVAILABLE      wired up, but not switched on here
 *   DRAFT          ships, but no router will ever reach it
 *   UNKNOWN        we could not read the configuration
 *
 * The fourth exists because `isProtocolLive` fails CLOSED — its own comment:
 * "An unreadable configuration is not permission to start a clinical
 * workflow." That is right for routing and wrong for a screen: reporting a
 * failed read as "switched off" tells a pharmacy something nobody checked.
 * Same distinction the allergy card has made since 0058.
 *
 * NO RED ANYWHERE. design.md reserves red for a person waiting on a human. A
 * protocol that is not switched on is not an emergency, and a screen where
 * three cards are red teaches staff to ignore red on the one screen where it
 * means somebody is waiting.
 */

/** The four states, in the order a reader cares about them. */
export const STATES = Object.freeze([
  { id: 'running', label: 'Running' },
  { id: 'available', label: 'Not switched on' },
  { id: 'draft', label: 'Draft' },
  { id: 'unknown', label: 'Could not check' },
]);

/**
 * Which state one protocol is in.
 *
 * ORDER MATTERS: the unreadable case is decided FIRST, because a protocol
 * whose configuration could not be read must never be reported with the
 * confidence of one that was read and found off.
 */
export function stateOf(p) {
  if (!p) return 'unknown';
  if (p.liveKnown === false) return 'unknown';
  if (!p.wiredUp) return 'draft';
  return p.live ? 'running' : 'available';
}

/** What each state means, said once, in words a pharmacist can act on. */
export function stateText(state) {
  switch (state) {
    case 'running':
      return 'Asking your patients these questions now.';
    case 'available':
      // NOT "disabled" — nobody disabled it. It ships ready and this pharmacy
      // has no active row for it, which is a different fact from a decision.
      return 'Ready, but not switched on for this pharmacy.';
    case 'draft':
      // The strongest claim on the screen, and the one the sidebar got wrong:
      // no patient message can reach this, by design.
      return 'Ships with the product and never runs. No patient message reaches it.';
    case 'unknown':
      return 'The configuration could not be read, so this is not known.';
    default:
      return '';
  }
}

/**
 * The tone a state carries.
 *
 * Only RUNNING is coloured, and with the brand accent, which design.md says
 * means "healthy / connected / within target" — a protocol doing its job is
 * exactly that. Everything else is ink: not switched on is not a fault.
 */
export function stateTone(state) {
  return state === 'running' ? 'accent' : 'quiet';
}

/**
 * The one-line summary above the list.
 *
 * COUNTS, NEVER A PERCENTAGE. "60% of protocols active" is a number about
 * the software; a pharmacist needs to know how many things are asking their
 * patients questions. Same rule the care-programme screen holds.
 */
export function summaryLine(data) {
  if (!data) return 'Not recorded';
  const { total = 0, wiredUpCount = 0, liveCount = 0 } = data;
  if (total === 0) return 'No clinical protocols ship with this version.';

  const parts = [`${liveCount} running`];
  const idle = wiredUpCount - liveCount;
  if (idle > 0) parts.push(`${idle} ready`);
  const draft = total - wiredUpCount;
  if (draft > 0) parts.push(`${draft} draft`);
  return parts.join(' · ');
}

/**
 * What a protocol DOES, as a short list of facts rather than prose.
 *
 * Counts are used for the clinical lists and the questions are shown in full
 * elsewhere: "what will my patients be asked?" is the question most worth
 * answering on this screen, and it is the part a patient experiences
 * directly. A red-flag rule is not something to review in a card.
 */
export function stepsOf(p) {
  const c = p?.counts || {};
  const steps = [
    { label: 'Recognises', value: c.triggers, unit: 'ways of describing it' },
    { label: 'Asks', value: c.questions, unit: 'questions' },
    { label: 'Stops on', value: c.redFlags, unit: 'red flags' },
    { label: 'Escalates by', value: c.escalationRules, unit: 'rules' },
  ];
  // A zero is shown, never hidden: fever v1 has NO red flags, and that is the
  // most important thing about it beside v2, which has eight.
  return steps.filter((s) => typeof s.value === 'number');
}

/**
 * Free-text filter over the list.
 *
 * Matches the name, the slug and the condition domain — what somebody would
 * actually type. Deliberately NOT the question text: a pharmacist searching
 * "fever" wants the fever protocol, not every protocol that says the word
 * fever inside a question.
 */
export function matchProtocols(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list || [];
  return (list || []).filter((p) => [p.name, p.slug, p.conditionDomain]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(q)));
}
