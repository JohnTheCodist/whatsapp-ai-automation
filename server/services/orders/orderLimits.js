/**
 * How much of one product this assistant may put through in a single order.
 *
 * WHAT WAS WRONG WITH A FIXED NUMBER
 * The limit was a constant 100, unrelated to what the pharmacy actually had.
 * It let an assistant accept 100 cards from a shelf holding 135 — clearing
 * three quarters of the stock on one chat message — while refusing 12 from a
 * shelf of 400. The number bore no relationship to the thing it was
 * protecting.
 *
 * Worse, it was never stated. A customer asking for 205 was told "205 is more
 * than this assistant can take" and nothing else, so they guessed: 205, then
 * 135, then 100. Three rounds to discover a constant the system knew all
 * along, and in the middle of it the assistant offered 135 and then refused
 * its own offer.
 *
 * WHY A SHARE OF STOCK
 * A pharmacy counter does not sell its whole shelf to whoever asks first.
 * Stock has to be there for the people who walk in, counts drift between
 * physical reality and the system, and a request for everything is worth a
 * person looking at it. Every one of those says the same thing: a remote
 * order may take a slice, not the lot.
 *
 * WHY LARGE ORDERS ARE ESCALATED, NOT REFUSED
 * A pharmacy that turns away a ₦3m order because a chat assistant has a limit
 * has lost a real sale. The right answer is a human, not a refusal — so above
 * the threshold this reports `review`, and the caller hands the conversation
 * to staff with the request intact.
 *
 * PURE. No database, no clock. Every number in and out.
 */

/**
 * A customer may order up to everything on the shelf.
 *
 * THIS WAS A QUARTER, AND THE QUARTER WAS WRONG
 * Reserving a share for walk-in customers is the right instinct in a shop
 * that decrements stock on reservation. This one does not: an order HOLDS
 * stock, it does not remove it from the count, so keeping three quarters back
 * was protecting inventory from a subtraction that never happens. The cost
 * was real — a customer wanting 135 of the 135 in stock was refused, told a
 * number nobody had explained, and eventually handed to a human for a request
 * the pharmacy could have filled exactly.
 *
 * The only genuine ceiling is what exists. Above that the answer is not a
 * policy, it is a fact — and the customer is told the fact and offered it.
 */

/**
 * The cap when the pharmacy does not count stock at all.
 *
 * stock_tracked = false means "this file had no stock column", not "we have
 * none" — so there is no shelf to take a share OF. Falling back to a fixed
 * number here is the one place a constant is the honest answer, because the
 * quantity is genuinely unknown.
 */
const UNTRACKED_CAP = 20;

/**
 * Order value above which a person must look, rather than the assistant
 * committing the pharmacy.
 *
 * Quantity alone does not catch this: 100 units of something cheap is a
 * normal order, and 100 units at ₦33,780 each is ₦3.4m placed by a chat bot.
 * Configurable because what counts as a large order differs by pharmacy —
 * this default is deliberately conservative, and belongs in the pharmacies
 * table once somebody wants to tune it per shop.
 */
const REVIEW_ABOVE_KOBO = parseInt(process.env.ORDER_REVIEW_ABOVE_KOBO || '50000000', 10); // ₦500,000

/**
 * The most of this product one order may contain.
 *
 * @param {object} args
 * @param {number|null} args.stockQty      units on the shelf, null if unknown
 * @param {boolean} args.stockTracked      does this pharmacy count this product
 * @returns {number} units. 0 means none may be ordered.
 */
function maxOrderableQuantity({ stockQty, stockTracked }) {
  if (!stockTracked) return UNTRACKED_CAP;

  const stock = Number(stockQty);
  if (!Number.isFinite(stock) || stock <= 0) return 0;

  // Everything on the shelf. Nothing held back — see the note above.
  return Math.floor(stock);
}

/**
 * May this line go through, and if not, what should happen?
 *
 * @returns {{ok: true} | {ok: false, action: 'reduce'|'review', max?: number, reason: string}}
 *
 *   reduce — more than a slice of the shelf. The caller states `max` so the
 *            customer is told the number instead of guessing at it.
 *   review — within the quantity rule but worth real money. Not a refusal:
 *            the caller hands this to a person with the request intact.
 */
function checkLine({ quantity, stockQty, stockTracked, unitPriceKobo }) {
  const max = maxOrderableQuantity({ stockQty, stockTracked });

  if (max <= 0) {
    return { ok: false, action: 'reduce', max: 0, reason: 'out_of_stock' };
  }
  if (quantity > max) {
    return { ok: false, action: 'reduce', max, reason: 'above_stock_share' };
  }

  const lineValue = Number(unitPriceKobo || 0) * quantity;
  if (lineValue >= REVIEW_ABOVE_KOBO) {
    return { ok: false, action: 'review', reason: 'high_value', valueKobo: lineValue };
  }

  return { ok: true };
}

module.exports = {
  maxOrderableQuantity,
  checkLine,
  UNTRACKED_CAP,
  REVIEW_ABOVE_KOBO,
};
