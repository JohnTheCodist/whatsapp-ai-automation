/**
 * The conversation workflow state machine.
 *
 * WHAT THIS ANSWERS
 * `status` (open/closed) answers "is this thread still running". `mode`
 * (bot/human) answers "who is replying". Neither answers the question a
 * pharmacist actually opens the dashboard to ask:
 *
 *     what needs ME, right now?
 *
 * That is what workflow_state is for. It is the axis the inbox groups by and
 * the only one that distinguishes "the assistant has this" from "someone is
 * waiting on a human".
 *
 * WHY A MATRIX RATHER THAN A FREE-TEXT COLUMN
 * Without one, any route or component can set any value, and the states decay
 * into labels that no longer describe reality — an ARCHIVED thread that is
 * somehow also AI_HANDLING. The transitions below are the whole contract, and
 * every write goes through applyTransition().
 *
 * THE RULE THAT MATTERS MOST
 * WAITING_FOR_PHARMACIST has no edge to ARCHIVED. Archiving removes a thread
 * from the inbox, and the person in that state is the one waiting on a
 * clinical answer. The same principle already governs shouldClose() in
 * conversationPolicy — this encodes it as a structural impossibility rather
 * than a rule someone has to remember.
 *
 * Pure. A current state and a proposed one in, a decision out.
 */

const STATES = Object.freeze({
  OPEN: 'open',
  AI_HANDLING: 'ai_handling',
  WAITING_FOR_CUSTOMER: 'waiting_for_customer',
  WAITING_FOR_PHARMACIST: 'waiting_for_pharmacist',
  RESOLVED: 'resolved',
  ARCHIVED: 'archived',
});

const ALL_STATES = Object.freeze(Object.values(STATES));

/**
 * Which workflow states mean the thread is still running.
 *
 * This is the bridge to `status`, which the ingest path and the worker's
 * idle sweep both already depend on. Keeping the mapping here — and enforced
 * by a CHECK constraint in migration 0024 — is what stops workflow_state and
 * status becoming two sources of truth that drift apart.
 */
const LIFECYCLE = Object.freeze({
  [STATES.OPEN]: 'open',
  [STATES.AI_HANDLING]: 'open',
  [STATES.WAITING_FOR_CUSTOMER]: 'open',
  [STATES.WAITING_FOR_PHARMACIST]: 'open',
  [STATES.RESOLVED]: 'closed',
  [STATES.ARCHIVED]: 'closed',
});

/**
 * Legal transitions.
 *
 * Read each line as "from this state, these are the only places it can go".
 */
const TRANSITIONS = Object.freeze({
  // A new or reopened thread. The assistant normally picks it up immediately,
  // but a clinical question can escalate straight past it.
  [STATES.OPEN]: [
    STATES.AI_HANDLING,
    STATES.WAITING_FOR_PHARMACIST,
    STATES.WAITING_FOR_CUSTOMER,
    STATES.RESOLVED,
  ],

  // The assistant is handling it. It either answers (-> waiting for the
  // customer), escalates, or finishes the job.
  [STATES.AI_HANDLING]: [
    STATES.WAITING_FOR_CUSTOMER,
    STATES.WAITING_FOR_PHARMACIST,
    STATES.RESOLVED,
    STATES.OPEN,
  ],

  // We answered; the ball is with the customer. If they never come back, the
  // idle sweep resolves it — archiving directly would skip the record of
  // *why* it ended.
  [STATES.WAITING_FOR_CUSTOMER]: [
    STATES.OPEN,
    STATES.AI_HANDLING,
    STATES.WAITING_FOR_PHARMACIST,
    STATES.RESOLVED,
  ],

  // Someone is waiting on a human. Deliberately NO edge to ARCHIVED — see the
  // header. A pharmacist can answer (-> waiting for customer), hand back to
  // the assistant, or close it out.
  [STATES.WAITING_FOR_PHARMACIST]: [
    STATES.WAITING_FOR_CUSTOMER,
    STATES.AI_HANDLING,
    STATES.RESOLVED,
  ],

  // Done, but still in the inbox's resolved list. Archiving files it away;
  // a customer messaging again reopens it.
  [STATES.RESOLVED]: [
    STATES.ARCHIVED,
    STATES.OPEN,
  ],

  // Filed away. Reopening is allowed but ONLY back to OPEN — an archived
  // thread cannot resume mid-workflow as though nothing happened. The spec
  // asks for reopening to be an explicit transition, and this is it.
  [STATES.ARCHIVED]: [
    STATES.OPEN,
  ],
});

function isState(s) {
  return ALL_STATES.includes(s);
}

/** The `status` value that must accompany a given workflow state. */
function lifecycleFor(state) {
  return LIFECYCLE[state] || null;
}

/**
 * @returns {{allowed: boolean, reason: string}}
 */
function canTransition(from, to) {
  if (!isState(from)) return { allowed: false, reason: 'UNKNOWN_FROM_STATE' };
  if (!isState(to)) return { allowed: false, reason: 'UNKNOWN_TO_STATE' };

  // A no-op is not an error. Two inbound messages in the same second both
  // asking for AI_HANDLING is normal, and making the second one throw would
  // turn ordinary concurrency into a failed message.
  if (from === to) return { allowed: true, reason: 'NO_CHANGE' };

  const legal = TRANSITIONS[from] || [];
  if (!legal.includes(to)) {
    return { allowed: false, reason: `ILLEGAL_TRANSITION_${from}_TO_${to}`.toUpperCase() };
  }
  return { allowed: true, reason: 'OK' };
}

/**
 * The decision a caller applies: the new workflow state AND the `status` that
 * must move with it, so the two can never be written out of step.
 *
 * @returns {{allowed: boolean, reason: string, state?: string, status?: string}}
 */
function applyTransition(from, to) {
  const check = canTransition(from, to);
  if (!check.allowed) return check;
  return {
    allowed: true,
    reason: check.reason,
    state: to,
    status: lifecycleFor(to),
  };
}

/**
 * Inbox priority. Deterministic, derived from the workflow state — never from
 * a model, and never hand-set in the UI.
 *
 * Only one thing is high priority: a person waiting on a pharmacist. If
 * everything urgent is urgent, the colour stops meaning anything, and the one
 * queue that can actually harm someone is the one that must not be diluted.
 */
function priorityFor(state) {
  return state === STATES.WAITING_FOR_PHARMACIST ? 'high' : 'normal';
}

/** Whether a state belongs in the working inbox at all. */
function isActive(state) {
  return lifecycleFor(state) === 'open';
}

/**
 * HANDOFF ≠ AI SILENCE.
 *
 * The three states a pharmacist actually needs to distinguish — "the AI has
 * this", "a human is needed but hasn't taken it yet", "a human is now
 * replying" — are not a fourth thing to store. They are a read of two
 * columns that already exist: `mode` (who is ALLOWED to reply) and
 * `workflow_state` (what the inbox needs to show).
 *
 * The bug this fixes: worker.js used to set `mode = 'human'` at the same
 * moment it raised a handoff — the instant the clinical filter or the
 * customer decided a pharmacist was needed, not the moment one actually
 * showed up. That collapsed HUMAN_PENDING into HUMAN_ACTIVE and muted the
 * assistant for however long the pharmacist queue took, even for questions
 * that had nothing to do with the escalation. `mode` now only becomes
 * 'human' when a pharmacist calls POST /:id/takeover (conversations.js) —
 * an explicit accept, never an automatic side effect of a handoff existing.
 *
 * @param {object} args
 * @param {string} args.mode           'bot' | 'human' — conversations.mode
 * @param {string} [args.workflowState] conversations.workflow_state
 * @returns {'AI_ACTIVE'|'HUMAN_PENDING'|'HUMAN_ACTIVE'}
 */
function deriveOwnership({ mode, workflowState }) {
  // A pharmacist has explicitly taken over (POST /takeover). This is the
  // ONLY thing that mutes the assistant — never the mere existence of an
  // open handoff.
  if (mode === 'human') return 'HUMAN_ACTIVE';
  // A handoff is open and nobody has claimed it yet. The assistant keeps
  // answering within its permitted scope; see handoffService.js for how a
  // second clinical question in this state gets consolidated rather than
  // re-escalated.
  if (workflowState === STATES.WAITING_FOR_PHARMACIST) return 'HUMAN_PENDING';
  return 'AI_ACTIVE';
}

module.exports = {
  STATES, ALL_STATES, TRANSITIONS, LIFECYCLE,
  isState, lifecycleFor, canTransition, applyTransition, priorityFor, isActive, deriveOwnership,
};
