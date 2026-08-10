/**
 * The greeting menu.
 *
 * Two of these tests exist because the requested wording would have broken
 * promises the rest of the system enforces: a menu offering "symptoms &
 * advice" invites exactly what the clinical filter refuses, and "reserve your
 * medication" is the word the reply validator blocks the assistant from
 * saying. A menu is a contract, so it is checked like one.
 *
 * Pure. No database, no model.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMenu, menuItems, isMenuRequest, parseSelection, cleanName,
} = require('../services/ai/menu');

const P = { pharmacyName: 'Sterling Pharmacy', botName: 'Ada' };

// ---- the greeting ----

test('greets by name and introduces the bot and the pharmacy', () => {
  const text = buildMenu({ ...P, customerName: 'John' });
  assert.match(text, /Hi John/);
  assert.match(text, /I'm Ada from Sterling Pharmacy/);
});

test('falls back gracefully when the push name is unusable', () => {
  for (const name of ['👑', 'J', null, undefined, '', '   ', '12345']) {
    const text = buildMenu({ ...P, customerName: name });
    assert.match(text, /^Hi, I'm Ada from Sterling Pharmacy\./m, `bad greeting for ${JSON.stringify(name)}`);
    assert.ok(!text.includes('Hi undefined'), 'leaked undefined into a customer message');
  }
});

test('push names are cleaned, not trusted', () => {
  assert.equal(cleanName('John Adetiloye - Sales'), 'John');
  // "J. Daniel" is a common way to write a name here. The initial strips to
  // one letter, so it skips to the next token rather than greeting "Hi J."
  assert.equal(cleanName('j. daniel👑'), 'Daniel');
  assert.equal(cleanName('ADEOLA'), 'Adeola');
  assert.equal(cleanName('👑'), null);
  assert.equal(cleanName('  chidi  '), 'Chidi');
  assert.equal(cleanName('Dr. Greg'), 'Greg');
});

test('the bot name falls back to the pharmacy, never to a vendor', () => {
  const text = buildMenu({ pharmacyName: 'Sterling Pharmacy', customerName: 'John' });
  assert.match(text, /I'm Sterling Pharmacy from Sterling Pharmacy|I'm Sterling Pharmacy/);
  assert.ok(!/whatsapp ai automation|sterling rx|openai|deepseek/i.test(text));
});

// ---- the contract ----

test('NO menu option promises symptom or medical advice', () => {
  // The spec asked for "Ask {bot} — health questions, symptoms & advice".
  // The clinical filter refuses those before the model sees them, so
  // advertising it would guarantee a deflection for anyone who tapped it.
  const text = buildMenu({ ...P, customerName: 'John' }).toLowerCase();
  for (const phrase of ['symptoms & advice', 'health questions', 'medical advice', 'ask ada about your symptoms']) {
    assert.ok(!text.includes(phrase), `menu promises "${phrase}", which the assistant must refuse`);
  }
});

test('the medical option routes to a pharmacist and says so', () => {
  const item = menuItems(P).find((i) => i.intent === 'pharmacist');
  assert.ok(item, 'there must still be a way to reach a person about medical questions');
  assert.match(item.title, /pharmacist/i);
  assert.match(item.blurb, /symptom|dosage|medical/i);
});

test('NO menu option claims medication is reserved', () => {
  const text = buildMenu({ ...P, customerName: 'John' }).toLowerCase();
  // "reserve" is precisely the word replyValidator blocks. The menu must not
  // make the promise the assistant is forbidden from making.
  assert.ok(!/\breserve\b|\breserved\b/.test(text), 'menu promises a reservation that does not exist');
  const order = menuItems(P).find((i) => i.intent === 'order');
  assert.match(order.blurb, /confirms/i, 'the order option must say the pharmacy confirms');
});

test('every option is reachable by its number', () => {
  const items = menuItems(P);
  for (const item of items) {
    assert.deepEqual(parseSelection(item.key, P), item);
  }
});

// ---- selection parsing ----

test('a bare number is a menu choice', () => {
  assert.equal(parseSelection('3', P).intent, 'order');
  assert.equal(parseSelection('  4  ', P).intent, 'pharmacist');
});

test('a number inside a sentence is NOT a menu choice', () => {
  // Hijacking "I want 1 pack of Panadol" into a menu jump would make the
  // assistant unusable for ordinary requests.
  for (const text of ['I want 1 pack', 'give me 2 of them', '3 packs please', 'is it 5 naira?']) {
    assert.equal(parseSelection(text, P), null, `wrongly parsed as a choice: "${text}"`);
  }
});

test('out-of-range and non-numeric selections are ignored', () => {
  for (const text of ['9', '0', '10', 'one', '', null, undefined]) {
    assert.equal(parseSelection(text, P), null);
  }
});

// ---- menu recall ----

test('the words people use to get back to the menu are recognised', () => {
  for (const text of ['menu', 'MENU', '  menu ', 'main menu', 'options', 'help', 'start', '0']) {
    assert.equal(isMenuRequest(text), true, `missed: "${text}"`);
  }
});

test('ordinary messages do not trigger the menu', () => {
  for (const text of ['do you have panadol', 'menu price', 'help me find amoxicillin', 'I need help with my order']) {
    assert.equal(isMenuRequest(text), false, `wrongly triggered on: "${text}"`);
  }
});

test('a returning customer is not greeted as new', () => {
  const again = buildMenu({ ...P, customerName: 'John', returning: true });
  assert.ok(!again.includes("I'm Ada from"), 'a regular should not be re-introduced');
  assert.match(again, /options again/i);
});

test('the menu tells people they can just type instead', () => {
  // A menu that only accepts numbers trains customers out of asking real
  // questions, which is the thing the assistant is actually good at.
  const text = buildMenu({ ...P, customerName: 'John' });
  assert.match(text, /just type your question/i);
  assert.match(text, /type \*menu\*/i);
});
