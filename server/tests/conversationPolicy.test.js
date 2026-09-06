/**
 * Conversation segmentation.
 *
 * FROM LIVE DATA
 * Before this policy existed, one patient had a single conversation holding
 * 143 messages across five days — an order, a clinical escalation, a vitamin
 * question and a complaint, all one thread. The inline rule was "newest
 * conversation whose mode is not closed", and nothing ever set closed, so the
 * clause always matched.
 *
 * WHAT THESE TESTS USED TO ASSERT, AND WHY IT WAS WRONG
 * Three of them required that a thread idle past the window returns 'new'.
 * That looked obviously right and was obviously wrong: the branch is only
 * reachable while the thread is still OPEN, and the database holds a unique
 * index permitting one open thread per patient. So the assertion pinned a
 * decision that could not be carried out — every time it fired in production
 * the insert was rejected, the ingest transaction rolled back, and the
 * customer's message was dropped unanswered. Sixteen of them, over three
 * days, before anyone noticed.
 *
 * The tests were green throughout, because a pure function was being asked
 * the wrong question in isolation. They have been corrected, not relaxed:
 * the contract they now describe is stricter than the one they replaced.
 *
 * The tests that matter are the boundary ones, the invariant that no open
 * thread is ever answered 'new', and the two cases where splitting would
 * actively harm someone — a pharmacist mid-reply, and a customer waiting on
 * a clinical answer — which must never close.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveConversation, shouldClose, IDLE_HOURS } = require('../services/whatsapp/conversationPolicy');

const NOW = new Date('2026-08-14T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

// ---- choosing a conversation for an inbound message ---------------------

test('a first-time patient starts a conversation', () => {
  const r = resolveConversation({ latest: null, now: NOW });
  assert.equal(r.action, 'new');
  assert.equal(r.reason, 'first_contact');
});

test('an active thread is continued, not split', () => {
  // "Hello" / "Do you have Coartem?" / "How much?" is one conversation.
  const r = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(0.02) },
    now: NOW,
  });
  assert.equal(r.action, 'reuse');
  assert.equal(r.conversationId, 'c1');
});

test('an OPEN thread is never answered "new", however long it has been quiet', () => {
  // THE INVARIANT. idx_conversations_one_open permits exactly one open thread
  // per patient, so 'new' here is not a policy opinion — it is a rejected
  // insert, a rolled-back transaction and a message the customer never gets
  // an answer to. Swept across the whole idle range rather than one case,
  // because the bug this replaces was a single unreachable-looking branch.
  for (const h of [0, 0.5, IDLE_HOURS - 0.1, IDLE_HOURS, IDLE_HOURS + 0.1, 24 * 7, 24 * 90]) {
    const r = resolveConversation({
      latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(h) },
      now: NOW,
    });
    assert.equal(r.action, 'reuse', `idle ${h}h must reuse the open thread`);
    assert.equal(r.conversationId, 'c1', `idle ${h}h must name the existing thread`);
  }
});

test('the idle boundary changes the reason, not the thread', () => {
  // The boundary still means something — it is how the logs distinguish a
  // live exchange from one the sweep should have retired and has not. It is
  // just no longer allowed to invent a second open conversation.
  const justUnder = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(IDLE_HOURS - 0.1) },
    now: NOW,
  });
  assert.equal(justUnder.reason, 'active', 'just inside the window is a live exchange');

  const justOver = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(IDLE_HOURS + 0.1) },
    now: NOW,
  });
  assert.equal(justOver.action, 'reuse');
  assert.equal(justOver.reason, 'idle_but_open', 'stale, and the sweep has not closed it');
});

test('a customer returning a week later gets a new conversation once the sweep has closed the old one', () => {
  // The split is real, but the sweep performs it by closing. This is the
  // handover between the two halves of the policy, and it is the only
  // sequence that actually produces a second conversation.
  const stillOpen = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(24 * 7) },
    now: NOW,
  });
  assert.equal(stillOpen.action, 'reuse', 'before the sweep runs, the thread is still theirs');

  assert.equal(
    shouldClose({ status: 'open', mode: 'bot', lastMessageAt: hoursAgo(24 * 7), now: NOW }).close,
    true,
    'the sweep is what retires it',
  );

  const afterSweep = resolveConversation({
    latest: { id: 'c1', status: 'closed', last_message_at: hoursAgo(24 * 7) },
    now: NOW,
  });
  assert.equal(afterSweep.action, 'new', 'and then the next message opens a fresh thread');
  assert.equal(afterSweep.reason, 'previous_closed');
});

test('a patient waiting on a pharmacist can still be heard days later', () => {
  // THE PRODUCTION INCIDENT, 2026-09-02 to 2026-09-06.
  //
  // A clinical escalation created a handoff nobody resolved. shouldClose
  // refuses to retire a thread awaiting a pharmacist — correctly; a closed
  // thread drops out of the inbox. So the thread stayed open indefinitely,
  // and under the old rule every later message asked for a second open
  // conversation and was destroyed by the unique index.
  //
  // The person with an unanswered clinical question was therefore the one
  // person guaranteed to be silenced. These two assertions are the whole
  // deadlock, and they must never both flip back.
  const pinnedOpen = shouldClose({
    status: 'open', mode: 'bot', lastMessageAt: hoursAgo(24 * 3),
    hasOpenHandoff: true, now: NOW,
  });
  assert.equal(pinnedOpen.close, false, 'the sweep must keep protecting them');
  assert.equal(pinnedOpen.reason, 'awaiting_pharmacist');

  const heard = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(24 * 3) },
    now: NOW,
  });
  assert.equal(heard.action, 'reuse', 'and their next message must still land somewhere');
  assert.equal(heard.conversationId, 'c1');
});

test('a closed conversation is never reopened', () => {
  // Reopening would resurrect its context — "I want two" referring to a
  // product from a finished order.
  const r = resolveConversation({
    latest: { id: 'c1', status: 'closed', last_message_at: hoursAgo(0.01) },
    now: NOW,
  });
  assert.equal(r.action, 'new');
  assert.equal(r.reason, 'previous_closed');
});

test('a missing timestamp reuses rather than fragmenting', () => {
  // A data problem should not become a visible one for the pharmacist.
  const r = resolveConversation({ latest: { id: 'c1', status: 'open', last_message_at: null }, now: NOW });
  assert.equal(r.action, 'reuse');
});

test('a future timestamp does not split the thread', () => {
  const r = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: new Date(NOW.getTime() + 60000) },
    now: NOW,
  });
  assert.equal(r.action, 'reuse');
});

test('the idle window is configurable without touching the caller', () => {
  const latest = { id: 'c1', status: 'open', last_message_at: hoursAgo(5) };
  // Tuning the window moves the reported reason. It cannot move the action,
  // because no value of idleHours makes a second open thread legal.
  assert.equal(resolveConversation({ latest, now: NOW, idleHours: 4 }).reason, 'idle_but_open');
  assert.equal(resolveConversation({ latest, now: NOW, idleHours: 8 }).reason, 'active');
  assert.equal(resolveConversation({ latest, now: NOW, idleHours: 4 }).action, 'reuse');
});

// ---- closing ------------------------------------------------------------

test('an idle conversation closes', () => {
  const r = shouldClose({ status: 'open', mode: 'bot', lastMessageAt: hoursAgo(30), now: NOW });
  assert.equal(r.close, true);
  assert.equal(r.reason, 'idle_expired');
});

test('an active conversation does not close', () => {
  assert.equal(shouldClose({ status: 'open', mode: 'bot', lastMessageAt: hoursAgo(1), now: NOW }).close, false);
});

test('a conversation waiting on a pharmacist NEVER auto-closes', () => {
  // The one that could actually harm someone: a closed thread drops out of
  // the inbox, and the person waiting is the one with a clinical question.
  const r = shouldClose({
    status: 'open', mode: 'bot', lastMessageAt: hoursAgo(72), hasOpenHandoff: true, now: NOW,
  });
  assert.equal(r.close, false);
  assert.equal(r.reason, 'awaiting_pharmacist');
});

test('a conversation a staff member is handling never auto-closes', () => {
  const r = shouldClose({ status: 'open', mode: 'human', lastMessageAt: hoursAgo(48), now: NOW });
  assert.equal(r.close, false);
  assert.equal(r.reason, 'staff_handling');
});

test('an already-closed conversation is not closed again', () => {
  const r = shouldClose({ status: 'closed', mode: 'bot', lastMessageAt: hoursAgo(99), now: NOW });
  assert.equal(r.close, false);
  assert.equal(r.reason, 'already_closed');
});

test('a missing timestamp is never a reason to close', () => {
  assert.equal(shouldClose({ status: 'open', mode: 'bot', lastMessageAt: null, now: NOW }).close, false);
});
