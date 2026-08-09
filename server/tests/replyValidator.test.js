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

// ---- order totals and remembered prices ----

test('an order total is allowed — it is arithmetic on a verified price', () => {
  // Blocking this would mean the assistant can never quote a total, which is
  // the whole point of turning an enquiry into a sale.
  const r = validateReply('Two packs will be ₦3,940.', [], { knownPrices: [1970] });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('a near-miss is still blocked despite the arithmetic allowance', () => {
  // ₦1,980 against a real ₦1,970 is the dangerous kind of wrong: close
  // enough that nobody reads it twice.
  assert.equal(validateReply('That will be ₦1,980.', [], { knownPrices: [1970] }).ok, false);
  assert.equal(validateReply('That will be ₦3,950.', [], { knownPrices: [1970] }).ok, false);
});

test('the arithmetic allowance is bounded', () => {
  const { MAX_QUANTITY } = require('../services/ai/replyValidator');
  const price = 1000;
  assert.equal(validateReply(`₦${price * MAX_QUANTITY}`, [], { knownPrices: [price] }).ok, true);
  assert.equal(
    validateReply(`₦${price * (MAX_QUANTITY + 1)}`, [], { knownPrices: [price] }).ok, false,
    'every verified price silently permits this many more values — it has to stop somewhere',
  );
});

test('a price verified earlier in the conversation counts as known', () => {
  // The model recalling "Coartem is ₦1,970" from two messages ago is not
  // inventing — that figure was checked when first quoted. Requiring a fresh
  // lookup would mean it could not confirm an order it had just priced.
  const r = validateReply('Yes, Coartem is ₦1,970. How many would you like?', [], { knownPrices: [1970] });
  assert.equal(r.ok, true);
});

test('an unremembered price is still invention', () => {
  assert.equal(validateReply('Coartem is ₦1,970.', [], { knownPrices: [] }).ok, false);
});

// ---- promises the system cannot keep ----

test('claiming to have reserved stock is blocked', () => {
  // Real traffic: "Done, I've set aside 3 packs of Amoxicillin 500mg for you."
  // Nothing was set aside, no order existed, and the pharmacy was never told.
  // The customer would arrive expecting held stock.
  const r = validateReply("Done, I've set aside 3 packs of Amoxicillin 500mg for you.", TOOL_RESULT);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].type, 'unfulfillable_promise');
});

test('every shape of completed-action claim is blocked', () => {
  for (const text of [
    'Your order has been placed.',
    "I've told the pharmacist for you.",
    "I have reserved them for you.",
    'They are set aside and ready for collection.',
    "I've arranged delivery for tomorrow.",
  ]) {
    assert.equal(validateReply(text, TOOL_RESULT).ok, false, `should have been blocked: ${text}`);
  }
});

test('an OFFER is fine — the difference is tense', () => {
  // "Shall I set them aside?" is a perfectly good thing to say. Blocking it
  // would leave the assistant unable to move toward a sale at all.
  for (const text of [
    'Shall I set them aside for you?',
    'I can reserve them if you like.',
    'Would you like to come in and collect them?',
  ]) {
    assert.equal(validateReply(text, TOOL_RESULT).ok, true, `should have been allowed: ${text}`);
  }
});

test('the check lifts once the system can genuinely act', () => {
  // When ordering lands this becomes "did the order tool run this turn"
  // rather than being deleted.
  const r = validateReply("I've set them aside for you.", TOOL_RESULT, { canTakeActions: true });
  assert.equal(r.ok, true);
});

test('a violation says what was quoted and why it failed', () => {
  const r = validateReply('It is ₦9,999.', TOOL_RESULT);
  assert.match(r.violations[0].detail, /9,999/, 'the offending figure must be in the message');
  assert.match(r.violations[0].detail, /neither a verified price nor a multiple/);
});
