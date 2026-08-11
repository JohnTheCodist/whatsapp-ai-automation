/**
 * What a customer is told when the assistant will not answer.
 *
 * The old message was one line for every case: "let me get one of our
 * pharmacists to help you with that." Someone asking about their child read
 * that as an assistant that had broken, not one observing a boundary — it
 * had just quoted three prices.
 *
 * The load-bearing test here is the urgency split. Offering a choice is the
 * right default and the wrong thing for an overdose: a permission question
 * costs a round trip on WhatsApp, and the person may not send another
 * message.
 *
 * Pure — no database, no sending.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escalationMessage, readEscalationAnswer } = require('../services/safety/escalationMessage');

const NON_URGENT = ['paediatric', 'pregnancy', 'dosage', 'drug_interaction', 'symptoms', 'clinical_comparison', 'prescription'];
const URGENT = ['emergency', 'overdose', 'adverse_reaction'];

// ---- urgency decides whether we ask ----

for (const c of URGENT) {
  test(`${c} escalates without asking permission`, () => {
    const m = escalationMessage(c);
    assert.equal(m.urgent, true);
    assert.equal(m.asksPermission, false, 'asking wastes a round trip when it matters most');
    assert.doesNotMatch(m.text, /would you like/i);
  });

  test(`${c} tells them to seek help now, not just to wait for a reply`, () => {
    const m = escalationMessage(c);
    assert.match(
      m.text, /straight away|hospital|doctor/i,
      'a pharmacist replying on WhatsApp is not the right answer to an emergency',
    );
  });
}

test('an urgent message leads with the advice, not with our own process', () => {
  const m = escalationMessage('overdose');
  const advice = m.text.search(/straight away/i);
  const ours = m.text.search(/alerted our pharmacist/i);
  assert.ok(advice < ours, 'safety advice must come before what we are doing about it');
});

test('the pharmacy phone is offered on urgent messages when known, omitted when not', () => {
  assert.match(escalationMessage('emergency', { pharmacyPhone: '08030000000' }).text, /08030000000/);
  assert.doesNotMatch(escalationMessage('emergency').text, /call us on/);
});

// ---- non-urgent offers a choice, and says why ----

for (const c of NON_URGENT) {
  test(`${c} explains the reason and offers the pharmacist`, () => {
    const m = escalationMessage(c);
    assert.equal(m.urgent, false);
    assert.equal(m.asksPermission, true);
    assert.match(m.text, /would you like me to pass you/i);
    assert.ok(m.text.length > 60, 'a bare offer with no reason is the message this replaces');
  });
}

test('the child case names the boundary in the customer\'s terms', () => {
  const m = escalationMessage('paediatric');
  assert.match(m.text, /child/i);
  assert.match(m.text, /pharmacist/i);
  assert.doesNotMatch(m.text, /error|sorry|unable to process/i, 'a boundary is not a malfunction');
});

// ---- cases where asking would be absurd ----

test('someone who asked for a human is not asked whether they want one', () => {
  const m = escalationMessage('human_requested');
  assert.equal(m.asksPermission, false);
  assert.doesNotMatch(m.text, /would you like/i);
});

test('a technical failure does not explain itself to the customer', () => {
  for (const c of ['assistant_unavailable', 'unverified_reply', 'prompt_injection']) {
    const m = escalationMessage(c);
    assert.equal(m.asksPermission, false);
    assert.doesNotMatch(m.text, /error|failed|unavailable/i, 'our internals are not the customer\'s problem');
  }
});

test('an unknown category escalates rather than assuming the question was trivial', () => {
  const m = escalationMessage('something_new_we_added_later');
  assert.equal(m.asksPermission, false);
  assert.ok(m.text);
});

// ---- reading their answer ----

test('clear acceptances are recognised', () => {
  for (const t of ['yes', 'Yes please', 'yeah', 'ok', 'sure', 'abeg', 'go ahead', 'connect me', 'y']) {
    assert.equal(readEscalationAnswer(t), true, `missed acceptance: "${t}"`);
  }
});

test('clear refusals are recognised', () => {
  for (const t of ['no', 'No thanks', 'nah', 'not now', "it's ok", 'no need', 'later']) {
    assert.equal(readEscalationAnswer(t), false, `missed refusal: "${t}"`);
  }
});

test('anything else is neither — it is a new question, not an answer', () => {
  for (const t of ['how much is panadol', 'what time do you close', '', null, undefined, 'yesterday I bought something and it was fine but now I want to ask about']) {
    assert.equal(readEscalationAnswer(t), null, `should be ambiguous: ${JSON.stringify(t)}`);
  }
});

test('"yesterday" is not "yes"', () => {
  // The word-boundary anchor matters: prefix matching alone would read this
  // as consent to be handed to a pharmacist.
  assert.equal(readEscalationAnswer('yesterday'), null);
});

test('ambiguity never silently means "no"', () => {
  // A clinical question dropped because the matcher did not recognise a
  // phrasing is worse than an unnecessary handoff. Only clear refusals count.
  assert.notEqual(readEscalationAnswer('hmm'), false);
  assert.notEqual(readEscalationAnswer('maybe'), false);
});
