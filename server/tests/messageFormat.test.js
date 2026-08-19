/**
 * Outbound message formatting.
 *
 * The samples below are real replies taken from live traffic, not invented
 * ones — the redundancy and the flat grey wall of text they produced are the
 * reason this module exists.
 *
 * The load-bearing test in here is the last one: formatting must never alter
 * a figure, because these messages have already been checked by
 * replyValidator and a formatter that could change a price would make that
 * check meaningless.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatForWhatsApp, emphasiseFacts, normaliseBullets, tidyWhitespace, breakBullets,
} = require('../services/whatsapp/messageFormat');

// ---- emphasis ----

test('prices are bolded so a customer can find the number', () => {
  const out = emphasiseFacts('Ibuprofen 400mg — ₦430 per card.');
  assert.ok(out.includes('*₦430*'), out);
});

test('order references are bolded — it is what gets read out at the counter', () => {
  const out = emphasiseFacts('Your order reference is DTQ-G29 — the pharmacy will confirm.');
  assert.ok(out.includes('*DTQ-G29*'), out);
});

test('WhatsApp bold is ONE asterisk, not markdown two', () => {
  // `**₦430**` renders as literal asterisks on a phone. This is the single
  // most common way this goes wrong.
  const out = emphasiseFacts('That is ₦1,300.');
  assert.ok(out.includes('*₦1,300*'));
  assert.ok(!out.includes('**'), 'markdown-style bold would render literally');
});

test('an already-emphasised price is not double-wrapped', () => {
  const out = emphasiseFacts('That is *₦1,300* today.');
  assert.ok(!out.includes('**'), out);
});

test('a hyphenated word is not mistaken for an order reference', () => {
  const out = emphasiseFacts('Our follow-up service is free.');
  assert.equal(out, 'Our follow-up service is free.');
});

// ---- lists ----

test('mixed bullet markers are normalised to one shape', () => {
  const out = normaliseBullets('- Panadol\n* Ibuprofen\n· Paracetamol');
  assert.equal(out, '• Panadol\n• Ibuprofen\n• Paracetamol');
});

test('options run together on one line are split apart', () => {
  const out = breakBullets('Here are my picks: • Panadol — ₦1,300. • Ibuprofen — ₦430.');
  assert.ok(out.includes('\n• Ibuprofen'), out);
});

test('a bullet character mid-sentence is left alone', () => {
  const text = 'Open 9am • 5pm daily.';
  assert.equal(breakBullets(text), text);
});

// ---- whitespace ----

test('runaway blank lines are collapsed, single ones kept', () => {
  const out = tidyWhitespace('One\n\n\n\nTwo\n\nThree');
  assert.equal(out, 'One\n\nTwo\n\nThree');
});

test('trailing spaces are stripped', () => {
  assert.equal(tidyWhitespace('Hello   \nthere  '), 'Hello\nthere');
});

// ---- the real thing ----

test('a real catalogue reply comes out scannable', () => {
  const raw = [
    'Sorry to hear you\'re not feeling well. These are all ones we stock and trust:',
    '',
    '- Panadol Extra 500mg x24 — ₦1,300 per card.',
    '- Ibuprofen 400mg — ₦430 per card.',
    '',
    '',
    'Which would you like?',
  ].join('\n');

  const out = formatForWhatsApp(raw);
  assert.ok(out.includes('• Panadol'), 'bullets normalised');
  assert.ok(out.includes('*₦1,300*'), 'price emphasised');
  assert.ok(!out.includes('\n\n\n'), 'blank lines collapsed');
  assert.ok(out.includes('Which would you like?'), 'the question survives');
});

test('an empty or non-string reply is returned untouched', () => {
  assert.equal(formatForWhatsApp(''), '');
  assert.equal(formatForWhatsApp(null), null);
  assert.equal(formatForWhatsApp(undefined), undefined);
});

test('FORMATTING NEVER CHANGES A FIGURE', () => {
  // The guarantee the whole module rests on. These messages have already
  // passed replyValidator; if formatting could alter a number, that check
  // would be verifying something the customer never receives.
  const raw = 'Two cards at ₦1,970 is ₦3,940, reference GRW-YT4, 4 left in stock.';
  const out = formatForWhatsApp(raw);

  // Same thousands-separator discipline as the module's own MONEY pattern —
  // a looser one here matches the trailing comma of a clause and reports a
  // difference that is punctuation, not a figure.
  const figures = (s) => (s.match(/\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g) || []);
  assert.deepEqual(figures(out), figures(raw), 'every digit must survive verbatim');
  assert.ok(out.includes('GRW-YT4'), 'the reference itself is unchanged');
});

test('emphasis stops at the figure — sentence punctuation stays outside', () => {
  // The bug the test above caught: `*₦3,940,*` dragged the clause's comma
  // into the bold, so the message read as though the comma were part of the
  // price.
  const out = formatForWhatsApp('That is ₦3,940, reference GRW-YT4, collected today.');
  assert.ok(out.includes('*₦3,940*,'), out);
  assert.ok(!out.includes('*₦3,940,*'), 'punctuation must not be bolded');
});
