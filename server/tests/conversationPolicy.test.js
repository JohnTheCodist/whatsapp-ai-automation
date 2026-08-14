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
 * The tests that matter are the boundary ones: just under the idle window
 * must continue the thread, just over must start a new one, and the two cases
 * where splitting would actively harm someone — a pharmacist mid-reply, and a
 * customer waiting on a clinical answer — must never close.
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

test('the idle boundary is exact', () => {
  const justUnder = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(IDLE_HOURS - 0.1) },
    now: NOW,
  });
  assert.equal(justUnder.action, 'reuse', 'just inside the window continues the thread');

  const justOver = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(IDLE_HOURS + 0.1) },
    now: NOW,
  });
  assert.equal(justOver.action, 'new', 'just outside starts a new one');
  assert.equal(justOver.reason, 'idle_expired');
});

test('a customer returning a week later gets a new conversation, not last week\'s', () => {
  const r = resolveConversation({
    latest: { id: 'c1', status: 'open', last_message_at: hoursAgo(24 * 7) },
    now: NOW,
  });
  assert.equal(r.action, 'new');
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
  assert.equal(resolveConversation({ latest, now: NOW, idleHours: 4 }).action, 'new');
  assert.equal(resolveConversation({ latest, now: NOW, idleHours: 8 }).action, 'reuse');
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
