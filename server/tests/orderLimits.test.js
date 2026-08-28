/**
 * How much of a shelf one chat order may take.
 *
 * These are written against the real conversation that prompted them: a
 * customer asked for 205 cards of Claritin from a shelf of 135, and the
 * assistant refused 205, offered 135, refused 135, then accepted 100 — three
 * quarters of the stock, at a total of ₦3.4m, without a person seeing it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  maxOrderableQuantity, checkLine, UNTRACKED_CAP, REVIEW_ABOVE_KOBO,
} = require('../services/orders/orderLimits');

test('the whole shelf is orderable — nothing is held back', () => {
  // This was a quarter. Withholding a share only makes sense where a
  // reservation DECREMENTS stock; here an order holds stock without removing
  // it from the count, so the share was protecting against a subtraction that
  // never happens — while refusing a customer the exact quantity the pharmacy
  // had sitting on the shelf.
  assert.equal(maxOrderableQuantity({ stockQty: 400, stockTracked: true }), 400);
  assert.equal(maxOrderableQuantity({ stockQty: 135, stockTracked: true }), 135);
});

test('a small shelf offers exactly what it has', () => {
  assert.equal(maxOrderableQuantity({ stockQty: 8, stockTracked: true }), 8);
  assert.equal(maxOrderableQuantity({ stockQty: 1, stockTracked: true }), 1);
});

test('never more than actually exists', () => {
  // The floor must not promise 5 from a shelf of 3 — that is how a customer
  // is told their order is placed and then told it is not.
  assert.equal(maxOrderableQuantity({ stockQty: 3, stockTracked: true }), 3);
  assert.equal(maxOrderableQuantity({ stockQty: 1, stockTracked: true }), 1);
});

test('no stock means nothing can be ordered', () => {
  assert.equal(maxOrderableQuantity({ stockQty: 0, stockTracked: true }), 0);
  assert.equal(maxOrderableQuantity({ stockQty: null, stockTracked: true }), 0);
});

test('an untracked product falls back to a fixed cap', () => {
  // stock_tracked false means "the file had no stock column", not "we have
  // none" — there is no shelf to take a share of, so a constant is the honest
  // answer here.
  assert.equal(maxOrderableQuantity({ stockQty: null, stockTracked: false }), UNTRACKED_CAP);
  assert.equal(maxOrderableQuantity({ stockQty: 999, stockTracked: false }), UNTRACKED_CAP);
});

// ---- the conversation that caused this ----

test('the exact request that was accepted before is now refused', () => {
  // 100 of 135 went through and became a ₦3.4m order.
  const d = checkLine({ quantity: 100, stockQty: 135, stockTracked: true, unitPriceKobo: 3378087 });
  assert.equal(d.ok, false);
});

test('the refusal carries the number, so nobody has to guess', () => {
  // The whole failure was a customer trying 205, then 135, then 100 because
  // the assistant only ever said "that is too many".
  const d = checkLine({ quantity: 205, stockQty: 135, stockTracked: true, unitPriceKobo: 1000 });
  assert.equal(d.action, 'reduce');
  assert.equal(d.max, 135, 'the caller cannot state a limit it was not given');
});

test('the same answer whether asked for 205, 135 or 100', () => {
  // The contradiction was: refuse 205, offer 135, refuse 135. One rule
  // evaluated the same way every time cannot do that.
  const at = (q) => checkLine({ quantity: q, stockQty: 135, stockTracked: true, unitPriceKobo: 1000 });
  assert.equal(at(205).max, 135);
  assert.equal(at(500).max, 135);
  assert.equal(at(135).ok, true, 'the number it tells the customer must itself be accepted');
  assert.equal(at(100).ok, true, 'anything at or below the shelf goes through');
});

// ---- money, which quantity alone does not catch ----

test('a high-value order goes to a person rather than through', () => {
  const d = checkLine({
    quantity: 33, stockQty: 135, stockTracked: true, unitPriceKobo: 3378087,
  });
  assert.equal(d.ok, false);
  assert.equal(d.action, 'review', 'a ₦1.1m order must not be committed by an assistant');
});

test('review is NOT refusal — it is a different action', () => {
  // A pharmacy that turns away a large order because a chat assistant has a
  // rule has lost a real sale. The caller must be able to tell these apart.
  const big = checkLine({ quantity: 5, stockQty: 100, stockTracked: true, unitPriceKobo: REVIEW_ABOVE_KOBO });
  assert.equal(big.action, 'review');
  const many = checkLine({ quantity: 500, stockQty: 100, stockTracked: true, unitPriceKobo: 1 });
  assert.equal(many.action, 'reduce');
});

test('an ordinary order passes untouched', () => {
  assert.deepEqual(
    checkLine({ quantity: 2, stockQty: 50, stockTracked: true, unitPriceKobo: 120000 }),
    { ok: true },
  );
});

test('a missing price does not crash the value check', () => {
  // price_kobo is nullable and a null must not become NaN and slip past the
  // comparison silently.
  const d = checkLine({ quantity: 2, stockQty: 50, stockTracked: true, unitPriceKobo: null });
  assert.equal(d.ok, true);
});

// ---- wholesale ----------------------------------------------------------
//
// A large order from a trade account is the point of having trade accounts.
// Escalating it would stop every real order the feature exists to serve, and
// teach staff that the alert means nothing.

test('a trade account is not stopped for order value', () => {
  const big = {
    quantity: 100, stockQty: 500, stockTracked: true,
    unitPriceKobo: 3378087, // ₦33,780.87 — the real Claritin figure
  };
  assert.equal(checkLine({ ...big }).action, 'review', 'retail: ₦3.3m should reach a person');
  assert.equal(checkLine({ ...big, wholesale: true }).ok, true, 'wholesale: this is an ordinary order');
});

test('wholesale is still bounded by the shelf', () => {
  // "No limit" means no VALUE limit. A trade account cannot order stock that
  // does not exist, and must be told the number like anyone else.
  const d = checkLine({
    quantity: 900, stockQty: 135, stockTracked: true, unitPriceKobo: 3378087, wholesale: true,
  });
  assert.equal(d.ok, false);
  assert.equal(d.action, 'reduce');
  assert.equal(d.max, 135);
});

test('the exemption is opt-in, not the default', () => {
  // checkLine is called from two places. If wholesale defaulted to true, a
  // caller that forgot to pass it would silently exempt every retail customer
  // from the value ceiling — a failure that looks like nothing at all.
  const args = { quantity: 100, stockQty: 500, stockTracked: true, unitPriceKobo: 3378087 };
  assert.equal(checkLine(args).action, 'review', 'omitting the flag must mean retail');
});
