/**
 * The conversation workflow state machine.
 *
 * The tests worth having here are the ones that encode a rule someone would
 * otherwise "fix" by widening the matrix:
 *
 *   - WAITING_FOR_PHARMACIST can never reach ARCHIVED. Archiving drops a
 *     thread out of the inbox, and the person in that state is the one waiting
 *     on a clinical answer.
 *   - ARCHIVED reopens only to OPEN, never straight back into mid-workflow.
 *   - A no-op transition is allowed, because two inbound messages in the same
 *     second both asking for AI_HANDLING is ordinary concurrency, not an error.
 *   - Every state's lifecycle mapping is total, so workflow_state and status
 *     can never be written out of step.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES, ALL_STATES, canTransition, applyTransition,
  lifecycleFor, priorityFor, isActive, deriveOwnership,
} = require('../services/whatsapp/conversationState');

// ---- the safety rule ----------------------------------------------------

test('a thread waiting on a pharmacist can NEVER be archived', () => {
  // The one transition in this file that could actually harm someone: it
  // would remove a person with an unanswered clinical question from the
  // inbox. Structurally impossible, not merely discouraged.
  const r = canTransition(STATES.WAITING_FOR_PHARMACIST, STATES.ARCHIVED);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /ILLEGAL_TRANSITION/);
});

test('a pharmacist can always answer, hand back, or close out', () => {
  for (const to of [STATES.WAITING_FOR_CUSTOMER, STATES.AI_HANDLING, STATES.RESOLVED]) {
    assert.equal(canTransition(STATES.WAITING_FOR_PHARMACIST, to).allowed, true, to);
  }
});

// ---- reopening ----------------------------------------------------------

test('an archived thread reopens only to OPEN, never mid-workflow', () => {
  assert.equal(canTransition(STATES.ARCHIVED, STATES.OPEN).allowed, true);
  for (const to of [STATES.AI_HANDLING, STATES.WAITING_FOR_CUSTOMER, STATES.WAITING_FOR_PHARMACIST]) {
    assert.equal(canTransition(STATES.ARCHIVED, to).allowed, false,
      `archived -> ${to} must not resume as though nothing happened`);
  }
});

test('a resolved thread reopens when the customer comes back', () => {
  assert.equal(canTransition(STATES.RESOLVED, STATES.OPEN).allowed, true);
  assert.equal(canTransition(STATES.RESOLVED, STATES.ARCHIVED).allowed, true);
});

// ---- the happy path the spec describes ----------------------------------

test('the full lifecycle chain is walkable end to end', () => {
  const chain = [
    STATES.OPEN,
    STATES.AI_HANDLING,
    STATES.WAITING_FOR_CUSTOMER,
    STATES.WAITING_FOR_PHARMACIST,
    STATES.RESOLVED,
    STATES.ARCHIVED,
  ];
  for (let i = 0; i < chain.length - 1; i++) {
    const r = canTransition(chain[i], chain[i + 1]);
    assert.equal(r.allowed, true, `${chain[i]} -> ${chain[i + 1]} should be legal`);
  }
});

// ---- concurrency --------------------------------------------------------

test('a no-op transition is allowed, not an error', () => {
  // Two inbound messages in the same second both driving AI_HANDLING is
  // normal. Throwing on the second would turn concurrency into a failed
  // message.
  const r = canTransition(STATES.AI_HANDLING, STATES.AI_HANDLING);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'NO_CHANGE');
});

// ---- refusing to guess --------------------------------------------------

test('an unknown state is refused rather than passed through', () => {
  assert.equal(canTransition('sleeping', STATES.OPEN).allowed, false);
  assert.equal(canTransition(STATES.OPEN, 'sleeping').allowed, false);
  assert.equal(canTransition(undefined, STATES.OPEN).allowed, false);
});

// ---- status can never drift from workflow_state -------------------------

test('every state maps to a lifecycle status', () => {
  // Totality matters: a state with no mapping would let applyTransition
  // write workflow_state while leaving status stale, which is exactly the
  // two-sources-of-truth split the CHECK constraint in 0024 exists to stop.
  for (const s of ALL_STATES) {
    assert.ok(['open', 'closed'].includes(lifecycleFor(s)), `${s} has no lifecycle mapping`);
  }
});

test('applyTransition returns the status that must move with the state', () => {
  const toResolved = applyTransition(STATES.AI_HANDLING, STATES.RESOLVED);
  assert.equal(toResolved.allowed, true);
  assert.equal(toResolved.state, STATES.RESOLVED);
  assert.equal(toResolved.status, 'closed', 'resolving must close the thread in the same write');

  const reopen = applyTransition(STATES.ARCHIVED, STATES.OPEN);
  assert.equal(reopen.status, 'open', 'reopening must reopen the thread in the same write');
});

test('applyTransition refuses illegal moves without returning a state to write', () => {
  const r = applyTransition(STATES.WAITING_FOR_PHARMACIST, STATES.ARCHIVED);
  assert.equal(r.allowed, false);
  assert.equal(r.state, undefined, 'a refused transition must not hand back something writable');
});

// ---- inbox derivation ---------------------------------------------------

test('only a customer waiting on a pharmacist is high priority', () => {
  // If everything urgent is urgent, the colour stops meaning anything.
  assert.equal(priorityFor(STATES.WAITING_FOR_PHARMACIST), 'high');
  for (const s of ALL_STATES.filter((x) => x !== STATES.WAITING_FOR_PHARMACIST)) {
    assert.equal(priorityFor(s), 'normal', `${s} must not compete with a clinical wait`);
  }
});

test('active states are exactly the ones still in the working inbox', () => {
  assert.equal(isActive(STATES.OPEN), true);
  assert.equal(isActive(STATES.AI_HANDLING), true);
  assert.equal(isActive(STATES.WAITING_FOR_CUSTOMER), true);
  assert.equal(isActive(STATES.WAITING_FOR_PHARMACIST), true);
  assert.equal(isActive(STATES.RESOLVED), false);
  assert.equal(isActive(STATES.ARCHIVED), false);
});

// ---- deriveOwnership: HANDOFF ≠ AI SILENCE ------------------------------
//
// The bug this whole mechanism replaces: worker.js used to set mode='human'
// the instant a handoff was RAISED, not when a pharmacist actually ACCEPTED
// one. These tests encode the corrected rule as data — mode is the only
// thing that mutes the assistant, never the mere existence of an open
// handoff.

test('normal conversation, no handoff: AI_ACTIVE', () => {
  assert.equal(deriveOwnership({ mode: 'bot', workflowState: STATES.AI_HANDLING }), 'AI_ACTIVE');
  assert.equal(deriveOwnership({ mode: 'bot', workflowState: STATES.WAITING_FOR_CUSTOMER }), 'AI_ACTIVE');
});

test('a handoff is open but no pharmacist has taken it: HUMAN_PENDING, assistant still bot-owned', () => {
  const r = deriveOwnership({ mode: 'bot', workflowState: STATES.WAITING_FOR_PHARMACIST });
  assert.equal(r, 'HUMAN_PENDING');
});

test('only mode=human — an explicit /takeover — produces HUMAN_ACTIVE', () => {
  assert.equal(deriveOwnership({ mode: 'human', workflowState: STATES.WAITING_FOR_PHARMACIST }), 'HUMAN_ACTIVE');
});

test('mode=human wins even if workflow_state has already moved on (e.g. pharmacist replied)', () => {
  // A pharmacist who has taken over and answered moves workflow_state to
  // WAITING_FOR_CUSTOMER (see conversationService.onPharmacistReplied), but
  // they still own the thread until they release it — mode says so.
  assert.equal(deriveOwnership({ mode: 'human', workflowState: STATES.WAITING_FOR_CUSTOMER }), 'HUMAN_ACTIVE');
});

test('a resolved or archived handoff does not read as pending', () => {
  assert.equal(deriveOwnership({ mode: 'bot', workflowState: STATES.RESOLVED }), 'AI_ACTIVE');
  assert.equal(deriveOwnership({ mode: 'bot', workflowState: STATES.ARCHIVED }), 'AI_ACTIVE');
});
