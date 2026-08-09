/**
 * Every number in a reply must trace to a tool result from this turn.
 *
 * This is layer 3 of hallucination prevention (§7), and it is the only one
 * that catches the model getting it wrong ANYWAY. Layers 1 and 2 — no
 * catalogue knowledge in the model, tenant-bound tools — make invention
 * unlikely. This makes it detectable.
 *
 * A prompt saying "never invent a price" is a request. This is a check.
 *
 * WHAT IT GUARDS
 * Money, hardest. A wrong price is a real loss and a written one: the
 * customer has it on their phone, and the pharmacy either honours it or
 * argues with someone holding a screenshot.
 *
 * Stock counts, second. "We have 4 left" is a promise.
 *
 * WHAT IT DELIBERATELY DOES NOT GUARD
 * Quantities the CUSTOMER introduced ("I want two") are not claims about the
 * catalogue, and flagging them would make every ordinary order a handoff.
 * Only numbers the assistant asserts are checked.
 *
 * Pure. No model, no network, no database.
 */

/**
 * Pull every naira amount out of a reply.
 *
 * Matches ₦1,250 / N1,250 / 1,250 naira / NGN 1250. A bare number with no
 * currency marker is NOT treated as money — "we have 4 packs" would
 * otherwise read as ₦4 and fail every reply that mentions a count.
 */
function extractMoney(text) {
  const found = [];
  const patterns = [
    // The \b before N is load-bearing. Without it, "Augmentin 625mg" matches
    // the final "n" of Augmentin followed by 625 and reads as a ₦625 price —
    // and so does Ventolin, Amoxicillin, and every other drug ending in n
    // before its strength. Nearly every real reply would have been rejected
    // as quoting an unverified price.
    /(?:₦|\bNGN\s*|\bN(?=\s*\d))\s*([\d][\d,]*(?:\.\d{1,2})?)/gi,
    /([\d][\d,]*(?:\.\d{1,2})?)\s*(?:naira|ngn)\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = Number(String(m[1]).replace(/,/g, ''));
      if (Number.isFinite(value)) found.push(value);
    }
  }
  return [...new Set(found)];
}

/**
 * Pull stock claims out of a reply.
 *
 * Only patterns where the assistant is asserting a count it must have got
 * from data — "4 in stock", "we have 4 left". Not "I want 2".
 */
function extractStockClaims(text) {
  const found = [];
  const patterns = [
    /\b(\d{1,6})\s+(?:packs?|units?|pieces?|tablets?|bottles?|sachets?)?\s*(?:are\s+)?(?:left|remaining|in stock|available)\b/gi,
    /\bwe\s+(?:have|got|hold)\s+(\d{1,6})\b/gi,
    /\b(?:only|just)\s+(\d{1,6})\s+(?:left|remaining|in stock)\b/gi,
    /\bstock(?:\s+level)?\s*(?:is|:)\s*(\d{1,6})\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = Number(m[1]);
      if (Number.isFinite(value)) found.push(value);
    }
  }
  return [...new Set(found)];
}

/**
 * Collect every number the tools actually returned, walking the whole result
 * tree so a nested product list is covered without hard-coding its shape.
 */
function collectFacts(toolResults) {
  const prices = new Set();
  const stocks = new Set();

  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;

    if (typeof node.price_naira === 'number') prices.add(node.price_naira);
    if (typeof node.stock_qty === 'number') stocks.add(node.stock_qty);

    for (const value of Object.values(node)) walk(value);
  };

  walk(toolResults);
  return { prices, stocks };
}

/**
 * Largest quantity whose total we will accept as arithmetic.
 *
 * "Two packs at ₦1,970 is ₦3,940" is the assistant doing its job — quoting an
 * order total is the whole point of turning an enquiry into a sale, and a
 * validator that rejects all arithmetic makes that impossible.
 *
 * Bounded because the allowance is not free: every verified price silently
 * permits this many more values. Twenty covers any realistic retail order and
 * keeps the permitted set small enough that an invented figure — ₦1,980
 * against a real ₦1,970 — still fails.
 */
const MAX_QUANTITY = 20;

/**
 * @param {string} text                  the model's draft reply
 * @param {object[]} toolResults         every tool result from this turn
 * @param {object} [options]
 * @param {number[]} [options.knownPrices]
 *   Prices verified EARLIER in this same conversation. A model that recalls
 *   "Coartem is ₦1,970" from two messages ago without re-running the tool is
 *   not inventing — that figure was checked when it was first quoted, and
 *   forcing a lookup on every turn would make the assistant re-query to
 *   answer "yes please".
 * @returns {{ok: boolean, violations: object[]}}
 */
function validateReply(text, toolResults = [], options = {}) {
  const violations = [];

  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, violations: [{ type: 'empty_reply', detail: 'The assistant produced no text.' }] };
  }

  const { prices, stocks } = collectFacts(toolResults);
  for (const p of options.knownPrices || []) {
    if (typeof p === 'number' && Number.isFinite(p)) prices.add(p);
  }

  // Unit prices, plus their multiples as order totals.
  const permitted = new Set(prices);
  for (const price of prices) {
    for (let q = 2; q <= MAX_QUANTITY; q += 1) {
      permitted.add(Number((price * q).toFixed(2)));
    }
  }

  for (const amount of extractMoney(text)) {
    if (!permitted.has(amount)) {
      violations.push({
        type: 'unverified_price',
        value: amount,
        detail: `The reply quotes ₦${amount.toLocaleString('en-NG')}, which is neither a verified price nor a multiple of one.`,
      });
    }
  }

  for (const count of extractStockClaims(text)) {
    if (!stocks.has(count)) {
      violations.push({
        type: 'unverified_stock',
        value: count,
        detail: `The reply claims ${count} in stock, which no tool returned this turn.`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = { validateReply, extractMoney, extractStockClaims, collectFacts, MAX_QUANTITY };
