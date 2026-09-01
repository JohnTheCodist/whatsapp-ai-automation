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

// ---- what a pharmacist is actually told ---------------------------------
//
// Reported from the live queue, 2026-08-30: a case that had been waiting 48
// hours showed "Assistant could not settle on an answer", "No trigger message
// recorded", and four fragments — "Hellp", "Hii", "My Order list", "Add it".
// The pharmacist could not tell what had happened, whether it was medical, or
// what they were being asked to do.

test('every escalation category says what the pharmacist should do about it', () => {
  const { HEADLINE, SITUATION } = require('../services/safety/consultationBriefing');
  for (const category of Object.keys(HEADLINE)) {
    assert.ok(
      SITUATION[category],
      `category "${category}" has a headline but no situation line — a label is not an instruction`,
    );
  }
});

test('a technical escalation says plainly that it is not medical', () => {
  // The whole cost of getting this wrong is a pharmacist spending triage
  // attention on a system fault, wondering whether somebody is unwell.
  for (const category of ['max_iterations', 'unverified_reply', 'assistant_unavailable', 'assistant_error']) {
    const b = buildBriefing({ category, requestedAt: at(5), messages: [] });
    assert.match(
      b.situation, /NOT a medical question/,
      `"${category}" must tell the pharmacist it is not clinical`,
    );
    assert.equal(b.technical, true);
  }
});

test('an unknown category still gets a usable instruction', () => {
  const b = buildBriefing({ category: 'something_new', requestedAt: at(5), messages: [] });
  assert.ok(b.situation && b.situation.length > 20, 'never leave the pharmacist with a bare label');
});

test('the exchange shows the assistant, not just the patient', () => {
  // Four patient messages alone read as someone repeating themselves. The
  // assistant's replies are what make them a story.
  const b = buildBriefing({
    category: 'max_iterations',
    requestedAt: at(10),
    messages: [
      { direction: 'inbound', body: 'Can u make it 135 cards', created_at: at(14) },
      { direction: 'outbound', body: 'Sorry, I got a bit tangled there.', created_at: at(13) },
      { direction: 'inbound', body: 'I need 135 cards instead', created_at: at(12) },
      { direction: 'outbound', body: 'Sorry, I got a bit tangled there.', created_at: at(11) },
      { direction: 'inbound', body: '135 cards', created_at: at(10) },
    ],
  });

  assert.equal(b.exchange.length, 5);
  assert.deepEqual(
    b.exchange.map((m) => m.from),
    ['patient', 'assistant', 'patient', 'assistant', 'patient'],
  );
  assert.match(b.lastAssistantReply, /tangled/,
    'the pharmacist must know what the patient was last told, or they open by ignoring it too');
});

test('the exchange is still verbatim — nothing is rewritten', () => {
  const said = 'Can u make it 135 cards';
  const b = buildBriefing({
    category: 'max_iterations',
    requestedAt: at(5),
    messages: [{ direction: 'inbound', body: said, created_at: at(6) }],
  });
  assert.equal(b.exchange[0].body, said);
});

test('a long wait does not erase why the case exists', () => {
  // The bug this is named for. The route used to fetch the 12 NEWEST messages
  // per conversation; a patient who kept typing after being escalated pushed
  // their own trigger out of the window, so the briefing emptied itself as the
  // case aged. buildBriefing must still find the trigger when the messages it
  // is handed span the handoff.
  const b = buildBriefing({
    category: 'max_iterations',
    requestedAt: at(2880), // 48 hours ago
    messages: [
      { direction: 'inbound', body: '135 cards', created_at: at(2881) },
      { direction: 'inbound', body: 'Hellp', created_at: at(600) },
      { direction: 'inbound', body: 'Hii', created_at: at(500) },
      { direction: 'inbound', body: 'My Order list', created_at: at(400) },
      { direction: 'inbound', body: 'Add it', created_at: at(300) },
    ],
  });
  assert.equal(b.trigger, '135 cards', 'the reason for escalation must survive the wait');
  assert.equal(b.unansweredSince, 4);
});
