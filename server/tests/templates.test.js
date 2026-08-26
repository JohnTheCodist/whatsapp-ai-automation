/**
 * The template definitions have to survive Meta's review, and a rejection is
 * discovered days later on somebody else's account. These check the rules that
 * are checkable here rather than finding out then.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TEMPLATES, CATEGORY, getTemplate, fillVariables } = require('../services/whatsapp/templates');

test('every template declares a variable for each placeholder, and no more', () => {
  for (const t of TEMPLATES) {
    const placeholders = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const highest = placeholders.length ? Math.max(...placeholders) : 0;

    assert.equal(
      highest, t.variables.length,
      `${t.key}: body uses {{${highest}}} but declares ${t.variables.length} variable(s). `
      + 'A placeholder with no declared name gets filled with undefined at send time.',
    );

    // 1..n with no gaps. {{1}} and {{3}} with no {{2}} is rejected by Meta and
    // would also silently shift every value one slot left.
    const expected = Array.from({ length: highest }, (_, i) => i + 1);
    assert.deepEqual(
      [...new Set(placeholders)].sort((a, b) => a - b), expected,
      `${t.key}: placeholders must run 1..n with no gaps`,
    );
  }
});

test('no template starts or ends with a variable', () => {
  // Meta rejects these: a template that is entirely substitutable cannot be
  // reviewed, because none of what the customer sees was seen by the reviewer.
  for (const t of TEMPLATES) {
    assert.ok(!/^\s*\{\{\d+\}\}/.test(t.body), `${t.key} starts with a variable`);
    assert.ok(!/\{\{\d+\}\}\s*$/.test(t.body), `${t.key} ends with a variable`);
  }
});

test('no template has two variables in a row', () => {
  for (const t of TEMPLATES) {
    assert.ok(
      !/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(t.body),
      `${t.key} has consecutive variables, which Meta rejects`,
    );
  }
});

test('every template names the pharmacy', () => {
  // A proactive message from an unidentified sender reads as spam to the
  // customer and to a reviewer. Every one of these arrives out of the blue,
  // possibly days after the last contact.
  for (const t of TEMPLATES) {
    assert.ok(
      t.variables.includes('pharmacyName'),
      `${t.key} does not say which pharmacy is writing`,
    );
  }
});

test('nothing is miscategorised as UTILITY', () => {
  // Marketing dressed as utility is the fastest way to lose template
  // privileges for every pharmacy at once. Nothing here should be marketing —
  // this catches a future edit that adds a promotional line to a
  // transactional template.
  const MARKETING_WORDS = /\b(offer|discount|promo|deal|sale|save|free gift|special price)\b/i;
  for (const t of TEMPLATES) {
    if (t.category !== CATEGORY.UTILITY) continue;
    assert.ok(
      !MARKETING_WORDS.test(t.body),
      `${t.key} is UTILITY but reads as marketing — that risks every pharmacy's templates, not just this one`,
    );
  }
});

test('keys are unique', () => {
  const keys = TEMPLATES.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, 'a duplicate key would silently shadow a template');
});

test('fillVariables returns values in the order the template declares', () => {
  const values = { pharmacyName: 'Fedoahs', orderReference: 'ABC-123', totalNaira: '₦4,500' };
  assert.deepEqual(fillVariables('order_confirmed', values), ['Fedoahs', 'ABC-123', '₦4,500']);
});

test('a missing value is refused rather than sent as a gap', () => {
  // "Your order  is ready" looks broken to the customer and counts against
  // the pharmacy's quality rating, which is shared across templates.
  assert.throws(
    () => fillVariables('order_ready', { pharmacyName: 'Fedoahs' }),
    /needs a value for "orderReference"/,
  );
  assert.throws(
    () => fillVariables('order_ready', { pharmacyName: 'Fedoahs', orderReference: '   ' }),
    /needs a value for "orderReference"/,
    'whitespace is not a value',
  );
});

test('an unknown template key throws rather than sending nothing', () => {
  assert.throws(() => fillVariables('does_not_exist', {}), /Unknown template/);
  assert.equal(getTemplate('does_not_exist'), null);
});

test('the pharmacist reply template does not try to carry the answer', () => {
  // Clinical advice must reach the customer verbatim, and a template's text is
  // fixed at approval time — so this one may only be a notification. A future
  // edit adding an "answer" variable would mean either truncating a
  // pharmacist's words or pushing arbitrary prose through a reviewed template.
  const t = getTemplate('pharmacist_replied');
  assert.ok(
    !t.variables.some((v) => /answer|message|reply|text|detail/i.test(v)),
    'pharmacist_replied must notify only — the answer itself is sent free-form inside the window',
  );
});
