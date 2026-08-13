/**
 * The card a pharmacist triages from.
 *
 * WHY THIS IS ASSEMBLED RATHER THAN SUMMARISED BY A MODEL
 * A pharmacist acts clinically on what they read here. A paraphrase that
 * turns three months old into three years old reads perfectly and causes
 * harm. Every other claim in this product is checked against a tool result
 * before it reaches anyone, and the briefing for the person making the
 * medical decision cannot be the one place that rule is relaxed. So the
 * customer's words are quoted, never rewritten — and there is a test below
 * that fails if that changes.
 *
 * The split-on-escalation tests exist because the first version got it
 * wrong in production data: someone escalated for "I'm having severe
 * headache" showed a trigger of "Hello", because they kept typing afterwards
 * and the newest message won.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBriefing } = require('../services/safety/consultationBriefing');

const at = (mins) => new Date(Date.now() - mins * 60000);

const conversation = {
  category: 'symptoms',
  requestedAt: at(20),
  messages: [
    { direction: 'inbound', body: 'Hi', created_at: at(30) },
    { direction: 'inbound', body: 'I have a bad headache', created_at: at(21) },
    { direction: 'outbound', body: 'Would you like me to pass you to them?', created_at: at(20) },
    { direction: 'inbound', body: 'Yes', created_at: at(19) },
    { direction: 'inbound', body: 'Do you have vitamin C?', created_at: at(5) },
  ],
  context: { last_product_name: 'Coartem' },
};

// ---- the bug this file exists for ----

test('the trigger is what they said BEFORE escalating, not their newest message', () => {
  const b = buildBriefing(conversation);
  assert.equal(
    b.trigger, 'I have a bad headache',
    'a customer who keeps typing must not overwrite their own reason for being in the queue',
  );
});

test('messages sent after the handoff are kept separate and counted', () => {
  const b = buildBriefing(conversation);
  assert.deepEqual(b.since, ['Yes', 'Do you have vitamin C?']);
  assert.equal(b.unansweredSince, 2, 'the assistant is muted, so nobody has answered these');
});

test('`said` contains only what came before the escalation', () => {
  const b = buildBriefing(conversation);
  assert.ok(!b.said.includes('Do you have vitamin C?'));
  assert.ok(b.said.includes('I have a bad headache'));
});

// ---- verbatim, always ----

test('the customer is quoted exactly, never paraphrased', () => {
  const odd = "i dey feel am for my chest since morning, e no dey stop";
  const b = buildBriefing({
    category: 'symptoms',
    requestedAt: at(1),
    messages: [{ direction: 'inbound', body: odd, created_at: at(2) }],
  });
  assert.equal(b.trigger, odd, 'exact text — a rewrite is a clinical claim we did not verify');
});

test('long messages are truncated, not summarised', () => {
  const long = 'a'.repeat(500);
  const b = buildBriefing({
    category: 'dosage', requestedAt: at(1),
    messages: [{ direction: 'inbound', body: long, created_at: at(2) }],
  });
  assert.ok(b.trigger.length <= 300);
  assert.ok(long.startsWith(b.trigger), 'truncation must preserve the beginning verbatim');
});

// ---- triage signals ----

test('urgent categories are flagged', () => {
  for (const c of ['emergency', 'overdose', 'adverse_reaction']) {
    assert.equal(buildBriefing({ category: c, requestedAt: at(1), messages: [] }).urgent, true);
  }
});

test('our own failures are marked technical, not clinical', () => {
  for (const c of ['assistant_unavailable', 'unverified_reply', 'filter_error']) {
    const b = buildBriefing({ category: c, requestedAt: at(1), messages: [] });
    assert.equal(b.technical, true, 'a pharmacist skimming should not read this as someone needing help');
    assert.equal(b.urgent, false);
  }
});

test('a clinical category is not marked technical', () => {
  const b = buildBriefing({ category: 'paediatric', requestedAt: at(1), messages: [] });
  assert.equal(b.technical, false);
  assert.match(b.headline, /child/i);
});

test('every category gets a headline in a pharmacist\'s words, not ours', () => {
  for (const c of ['paediatric', 'dosage', 'drug_interaction', 'pregnancy', 'clinical_comparison']) {
    const b = buildBriefing({ category: c, requestedAt: at(1), messages: [] });
    assert.ok(b.headline && b.headline !== c, `raw category leaked for ${c}`);
    assert.doesNotMatch(b.headline, /_/, 'a snake_case category is an internal name');
  }
});

test('an unknown category still produces a usable card', () => {
  const b = buildBriefing({ category: 'something_new', requestedAt: at(1), messages: [] });
  assert.equal(b.headline, 'Needs a person');
});

// ---- waiting time ----

test('waiting time reads as elapsed, not as a clock', () => {
  assert.equal(buildBriefing({ category: 'dosage', requestedAt: at(0), messages: [] }).waiting, 'just now');
  assert.equal(buildBriefing({ category: 'dosage', requestedAt: at(12), messages: [] }).waiting, '12m');
  assert.equal(buildBriefing({ category: 'dosage', requestedAt: at(200), messages: [] }).waiting, '3h 20m');
  assert.equal(buildBriefing({ category: 'dosage', requestedAt: at(120), messages: [] }).waiting, '2h');
});

// ---- context ----

test('an unanswered offer of a pharmacist is distinguishable from a real request', () => {
  const b = buildBriefing({
    category: 'symptoms', requestedAt: at(3), messages: [],
    context: { pending_escalation: { category: 'symptoms' } },
  });
  assert.equal(b.awaitingCustomerAnswer, true, '"we asked and they went quiet" is not "they want you"');
});

test('an empty conversation does not throw', () => {
  const b = buildBriefing({ category: 'dosage', requestedAt: at(1), messages: [], context: {} });
  assert.equal(b.trigger, null);
  assert.deepEqual(b.said, []);
  assert.equal(b.unansweredSince, 0);
});
