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
 * The most of any one product a single order may take, as a share of stock.
 *
 * A quarter. Low enough that a shelf survives one enthusiastic customer, high
 * enough that ordinary requests — a month's supply, a family's worth — never
 * touch it.
 */
const MAX_STOCK_SHARE = 0.25;

/**
 * Always allowed if the stock is there, whatever the share works out to.
 *
 * Without this, a quarter of a shelf of 8 is 2, and somebody needing a
 * fortnight's course is refused for no reason a pharmacist would recognise.
 * A small absolute allowance is what makes the share sane at low stock.
 */
const ALWAYS_ALLOWED = 5;

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

  const share = Math.floor(stock * MAX_STOCK_SHARE);
  // Never more than exists, whatever the floor says — promising 5 from a
  // shelf of 3 is how a customer is told their order is placed and then told
  // it is not.
  return Math.max(1, Math.min(Math.max(share, ALWAYS_ALLOWED), stock));
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
  MAX_STOCK_SHARE,
  ALWAYS_ALLOWED,
  UNTRACKED_CAP,
  REVIEW_ABOVE_KOBO,
};
