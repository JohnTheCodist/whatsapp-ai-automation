/**
 * Name handling, and the guard that stops a name being invented.
 *
 * The model extracts, the application verifies. isGroundedIn() is the whole
 * safety property: a name that does not appear in the customer's own words
 * cannot be stored, whatever the model returns. Everything else in this file
 * is about not fabricating the parts of a name the customer did not give.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanName, isGroundedIn, splitName, looksLikeNameReply,
} = require('../services/customers/customerName');

// ---- the guard ----------------------------------------------------------

test('a name the customer actually typed is accepted', () => {
  assert.equal(isGroundedIn('John Adeyemi', 'John Adeyemi'), true);
  assert.equal(isGroundedIn('John Adeyemi', 'my name is John Adeyemi'), true);
  assert.equal(isGroundedIn('John Adeyemi', 'My full name is john adeyemi pls'), true);
});

test('a name the customer never typed is REJECTED — the model cannot invent one', () => {
  assert.equal(isGroundedIn('John Adeyemi', 'I want two Coartem'), false);
  assert.equal(isGroundedIn('Sarah Johnson', 'hello'), false);
});

test('a surname invented to make one word look complete is REJECTED', () => {
  // The customer said "John". A model completing it to "John Adeyemi" is
  // exactly the failure this guard exists for.
  assert.equal(isGroundedIn('John Adeyemi', 'my name is John'), false);
  assert.equal(isGroundedIn('John', 'my name is John'), true);
});

test('the WhatsApp display name cannot be smuggled in as the customer name', () => {
  // pushName is "John's iPhone"; the customer never typed it in this message.
  assert.equal(isGroundedIn("John's iPhone", 'my name is John Adeyemi'), false);
});

test('a name carried over from an earlier unrelated sentence is REJECTED', () => {
  // Only the CURRENT message counts — otherwise "do you have Panadol for
  // Grace" could later become the customer's own name.
  assert.equal(isGroundedIn('Grace', 'I want to order now'), false);
});

test('grounding is word-level, not substring — "Ada" is not inside "Canada"', () => {
  assert.equal(isGroundedIn('Ada', 'I am travelling to Canada'), false);
  assert.equal(isGroundedIn('Ada', 'my name is Ada'), true);
});

test('hyphens and apostrophes survive as part of one word', () => {
  assert.equal(isGroundedIn("O'Brien", "my name is O'Brien"), true);
  assert.equal(isGroundedIn('Ada-Obi', 'I am Ada-Obi'), true);
});

test('an empty or unusable proposal is never grounded', () => {
  assert.equal(isGroundedIn('', 'John'), false);
  assert.equal(isGroundedIn(null, 'John'), false);
  assert.equal(isGroundedIn('John', ''), false);
});

// ---- cleaning -----------------------------------------------------------

test('lead-in phrases are stripped, not stored as part of the name', () => {
  assert.equal(cleanName('my name is John Adeyemi'), 'John Adeyemi');
  assert.equal(cleanName('My full name is John Adeyemi'), 'John Adeyemi');
  assert.equal(cleanName("I'm John"), 'John');
  assert.equal(cleanName('call me John'), 'John');
});

test('Nigerian-English lead-ins and politeness are handled', () => {
  assert.equal(cleanName('na John Adeyemi'), 'John Adeyemi');
  assert.equal(cleanName('John Adeyemi pls'), 'John Adeyemi');
  assert.equal(cleanName('John Adeyemi abeg'), 'John Adeyemi');
});

test('quotes and trailing punctuation go, internal marks stay', () => {
  assert.equal(cleanName('"John Adeyemi"'), 'John Adeyemi');
  assert.equal(cleanName('John Adeyemi.'), 'John Adeyemi');
  assert.equal(cleanName("O'Brien"), "O'Brien");
  assert.equal(cleanName('Ada-Obi'), 'Ada-Obi');
});

test('input with no letters is not a name', () => {
  assert.equal(cleanName('12345'), null);
  assert.equal(cleanName('???'), null);
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(null), null);
});

test('an absurdly long string is refused rather than truncated into nonsense', () => {
  assert.equal(cleanName('a'.repeat(200)), null);
});

// ---- splitting ----------------------------------------------------------

test('one word gives a first name and a NULL surname — never an invented one', () => {
  assert.deepEqual(splitName('John'), { firstName: 'John', lastName: null, fullName: 'John' });
});

test('two words split as expected', () => {
  assert.deepEqual(splitName('John Adeyemi'), {
    firstName: 'John', lastName: 'Adeyemi', fullName: 'John Adeyemi',
  });
});

test('three or more words keep everything after the first as the surname', () => {
  // No reliable rule separates a middle name from a compound surname, and
  // guessing wrong is worse than not guessing.
  assert.deepEqual(splitName('Ngozi Chukwuemeka Okonkwo'), {
    firstName: 'Ngozi', lastName: 'Chukwuemeka Okonkwo', fullName: 'Ngozi Chukwuemeka Okonkwo',
  });
});

test('splitting cleans first, so a lead-in never lands in first_name', () => {
  assert.deepEqual(splitName('my name is John Adeyemi'), {
    firstName: 'John', lastName: 'Adeyemi', fullName: 'John Adeyemi',
  });
});

test('unusable input splits to all nulls rather than throwing', () => {
  assert.deepEqual(splitName(''), { firstName: null, lastName: null, fullName: null });
  assert.deepEqual(splitName('!!!'), { firstName: null, lastName: null, fullName: null });
});

// ---- reply detection ----------------------------------------------------

test('plausible answers to "what is your name" are recognised', () => {
  assert.equal(looksLikeNameReply('John Adeyemi'), true);
  assert.equal(looksLikeNameReply('my name is John'), true);
  assert.equal(looksLikeNameReply('John'), true);
});

test('an order or question is not mistaken for a name reply', () => {
  assert.equal(looksLikeNameReply('I want 2 Coartem'), false);
  assert.equal(looksLikeNameReply('do you have paracetamol?'), false);
  assert.equal(looksLikeNameReply('a'.repeat(100)), false);
});
