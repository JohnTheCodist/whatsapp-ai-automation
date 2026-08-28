/**
 * Which failures are worth a pharmacist.
 *
 * The safety half of these matters more than the rest of the file: if a
 * clinical category ever starts "recovering", the assistant is quietly
 * handling exactly what it must never handle. Those tests are the point.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classify, recoveryMessage, CLINICAL, RECOVERABLE, MAX_RECOVERIES,
} = require('../services/safety/escalationPolicy');

// ---- the boundary that must not move ----

test('every clinical category escalates, always, at any failure count', () => {
  for (const category of CLINICAL) {
    for (const recoveriesSoFar of [0, 1, 5, 99]) {
      const d = classify({ category, recoveriesSoFar });
      assert.equal(
        d.action, 'escalate',
        `${category} must reach a pharmacist — recovering it means the assistant handled it`,
      );
    }
  }
});

test('an unknown category escalates rather than being quietly absorbed', () => {
  // A clinical category added to the filter later and forgotten here must
  // fail SAFE. Defaulting to recover is how a new "self_harm" category ends
  // up being answered by a chat bot.
  assert.equal(classify({ category: 'something_new_nobody_classified' }).action, 'escalate');
});

test('asking for a human is honoured, not recovered away', () => {
  assert.equal(classify({ category: 'human_requested' }).action, 'escalate');
  assert.equal(classify({ category: 'human_requested', recoveriesSoFar: 9 }).action, 'escalate');
});

// ---- the behaviour that prompted this ----

test("the assistant's own bad turn does not page a pharmacist", () => {
  // The real conversation: customer typed their name, the assistant escalated
  // with "Let me get one of our team to pick this up", never explained why,
  // and carried on two minutes later. Nothing clinical happened.
  for (const category of ['unverified_reply', 'max_iterations', 'assistant_error']) {
    assert.equal(classify({ category, recoveriesSoFar: 0 }).action, 'recover');
  }
});

test('but a conversation that keeps failing does reach a person', () => {
  // Recovering forever is its own failure — a customer told "say that again"
  // three times has been failed, and pretending otherwise is worse.
  assert.equal(classify({ category: 'unverified_reply', recoveriesSoFar: MAX_RECOVERIES }).action, 'escalate');
  assert.equal(classify({ category: 'unverified_reply', recoveriesSoFar: MAX_RECOVERIES }).reason, 'repeatedly_stuck');
});

test('the threshold is a real boundary, not off by one', () => {
  assert.equal(classify({ category: 'max_iterations', recoveriesSoFar: MAX_RECOVERIES - 1 }).action, 'recover');
  assert.equal(classify({ category: 'max_iterations', recoveriesSoFar: MAX_RECOVERIES }).action, 'escalate');
});

// ---- the one that is a security property, not a UX preference ----

test('prompt injection never escalates, however many times it is tried', () => {
  // Escalating would hand anyone who can message the pharmacy a button that
  // summons staff on demand: send the same crafted text repeatedly and the
  // handoff queue fills up. Declining costs the attacker everything.
  for (const recoveriesSoFar of [0, 1, 2, 50]) {
    const d = classify({ category: 'prompt_injection', recoveriesSoFar });
    assert.equal(d.action, 'recover', 'a repeatable escalation trigger is a way to page staff at will');
  }
});

// ---- what the customer actually reads ----

test('recovery messages never blame the customer or mention internals', () => {
  for (const category of RECOVERABLE) {
    const m = recoveryMessage(category);
    assert.ok(m && m.length > 10, `${category} has no recovery message`);
    assert.ok(
      !/error|failed|exception|invalid|unable to process/i.test(m),
      `${category} leaks a malfunction to somebody who cannot act on it: "${m}"`,
    );
  }
});

test('every recovery message gives the customer something to do next', () => {
  // A dead end is what makes a person give up and ring the shop instead.
  for (const category of RECOVERABLE) {
    assert.match(
      recoveryMessage(category), /\?/,
      `${category} leaves the customer with no next step: "${recoveryMessage(category)}"`,
    );
  }
});

test('the injection reply declines without accusing anybody', () => {
  const m = recoveryMessage('prompt_injection');
  assert.ok(
    !/hack|attack|injection|not allowed|refuse/i.test(m),
    'a customer who phrased something oddly must not be told they attacked the system',
  );
});
