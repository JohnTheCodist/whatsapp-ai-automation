/**
 * Reply validation — the layer that catches the model getting it wrong anyway.
 *
 * A wrong price is a written promise on the customer's phone. The pharmacy
 * either honours it or argues with someone holding a screenshot.
 *
 * Pure — no model, no network, no database.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReply, extractMoney, extractStockClaims } = require('../services/ai/replyValidator');

const TOOL_RESULT = [{
  query: 'panadol',
  products: [
    { name: 'Panadol Extra', price_naira: 1250, stock_qty: 12, stock_tracked: true },
    { name: 'Panadol Advance', price_naira: 980, stock_qty: 0, stock_tracked: true },
  ],
}];

// ---- prices ----

test('a price that came from a tool passes', () => {
  const r = validateReply('Yes, Panadol Extra is ₦1,250. Would you like one?', TOOL_RESULT);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('an invented price is caught', () => {
  const r = validateReply('Panadol Extra is ₦1,500.', TOOL_RESULT);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'unverified_price');
  assert.equal(r.violations[0].value, 1500);
});

test('a plausible-but-wrong price is still caught', () => {
  // The dangerous case: 1200 is close enough that nobody reads it twice.
  const r = validateReply('That will be ₦1,200.', TOOL_RESULT);
  assert.equal(r.ok, false);
});

test('every naira format people actually write is recognised', () => {
  for (const written of ['₦1,250', '₦1250', 'N1,250', 'NGN 1250', '1,250 naira', '1250 NGN']) {
    assert.deepEqual(extractMoney(written), [1250], `failed on "${written}"`);
  }
});

test('decimals are matched against the same underlying value', () => {
  assert.deepEqual(extractMoney('₦1,250.00'), [1250]);
});

test('several prices in one reply are all checked', () => {
  const r = validateReply('Panadol Extra is ₦1,250 and Panadol Advance is ₦980.', TOOL_RESULT);
  assert.equal(r.ok, true);

  const bad = validateReply('Panadol Extra is ₦1,250 and Panadol Advance is ₦999.', TOOL_RESULT);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].value, 999);
});

// ---- the false positives that would ruin it ----

test('a bare number is not treated as money', () => {
  // "we have 4 packs" must not read as ₦4 and fail every ordinary reply.
  const r = validateReply('Yes, we stock it in packs of 24.', TOOL_RESULT);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('a quantity the CUSTOMER introduced is not a claim about the catalogue', () => {
  const r = validateReply('Two packs of Panadol Extra, that is ₦1,250 each. Shall I reserve them?', TOOL_RESULT);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('a reply with no numbers at all passes', () => {
  const r = validateReply('We are open today until 8pm. Anything else?', TOOL_RESULT);
  assert.equal(r.ok, true);
});

test('a drug name ending in "n" before its strength is not read as a price', () => {
  // "Augmentin 625mg" contains "n 625". Matching a bare N followed by digits
  // turned that into a ₦625 price claim — and would have done the same for
  // Ventolin, Amoxicillin and most of the shelf.
  const results = [{ products: [{ name: 'Augmentin 625mg', price_naira: 6400, stock_qty: 4, stock_tracked: true }] }];
  for (const reply of [
    'We have Augmentin 625mg in stock.',
    'Ventolin 100mcg is available.',
    'Amoxicillin 500mg, yes we stock it.',
  ]) {
    assert.equal(validateReply(reply, results).ok, true, `false positive on: ${reply}`);
  }
});

test('a real N-prefixed price is still caught', () => {
  const results = [{ products: [{ name: 'Panadol', price_naira: 1250 }] }];
  assert.equal(validateReply('It is N1,250.', results).ok, true);
  assert.equal(validateReply('It is N1,500.', results).ok, false, 'N-prefix must still work as a currency marker');
});

// ---- stock ----

test('a stock count that came from a tool passes', () => {
  const r = validateReply('We have 12 in stock.', TOOL_RESULT);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('an invented stock count is caught', () => {
  const r = validateReply('We have 7 in stock.', TOOL_RESULT);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'unverified_stock');
});

test('stock phrasings are recognised', () => {
  assert.deepEqual(extractStockClaims('only 3 left'), [3]);
  assert.deepEqual(extractStockClaims('we have 12'), [12]);
  assert.deepEqual(extractStockClaims('5 packs remaining'), [5]);
  assert.deepEqual(extractStockClaims('4 in stock'), [4]);
});

// ---- nothing to check against ----

test('quoting a price when NO tool ran is a violation', () => {
  const r = validateReply('Panadol is ₦1,250.', []);
  assert.equal(r.ok, false, 'a price with no lookup behind it is invention by definition');
});

test('an empty reply is a violation, not a pass', () => {
  for (const text of ['', '   ', null, undefined]) {
    const r = validateReply(text, TOOL_RESULT);
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].type, 'empty_reply');
  }
});

test('facts are found however deeply the tool nested them', () => {
  const nested = [{ data: { results: { items: [{ price_naira: 4321, stock_qty: 9 }] } } }];
  assert.equal(validateReply('It is ₦4,321 and we have 9 in stock.', nested).ok, true);
});

test('a violation says what was quoted and why it failed', () => {
  const r = validateReply('It is ₦9,999.', TOOL_RESULT);
  assert.match(r.violations[0].detail, /9,999/);
  assert.match(r.violations[0].detail, /no tool returned/);
});
