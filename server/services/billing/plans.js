/**
 * What a pharmacy can buy.
 *
 * PILOT PRICING, SET 2026-08-30 AND DELIBERATELY DISCOUNTED
 * These are early-access numbers for the first pharmacies, who are taking a
 * risk on unproven software. They are not the eventual price and are not
 * expected to cover cost at volume — measured LLM spend is roughly ₦34 per
 * conversation, so a pharmacy running more than about five conversations a
 * day costs more than ₦5,000/month to serve.
 *
 * That is a known, accepted trade for the pilot. What buys it back is the
 * meter (usageMeter.js): by the time these prices need to change, there will
 * be real data about what a pharmacy's traffic actually looks like, instead
 * of another guess.
 *
 * NO CONVERSATION LIMIT ON ANY PLAN, ON PURPOSE. A pilot pharmacy leaning on
 * the assistant heavily is the outcome being paid for. Throttling the one
 * customer who loves the product is how a pilot produces no evidence.
 *
 * PURE DATA. No database, no clock.
 */

/** Integer kobo everywhere, same as orders. 100 kobo = ₦1. */
const PLANS = Object.freeze({
  pilot_monthly: Object.freeze({
    id: 'pilot_monthly',
    label: 'Pilot — monthly',
    priceKobo: 500_000,        // ₦5,000
    intervalDays: 30,
    interval: 'month',
  }),
  pilot_annual: Object.freeze({
    id: 'pilot_annual',
    label: 'Pilot — yearly',
    priceKobo: 5_000_000,      // ₦50,000 — ₦4,167/month, ~17% off
    intervalDays: 365,
    interval: 'year',
  }),
});

/**
 * How long a new pharmacy gets free.
 *
 * Counted from WhatsApp connection rather than sign-up — see 0048. A tenant
 * that has not connected a number has no product to trial, and starting the
 * clock at sign-up bills them for our onboarding friction.
 */
const TRIAL_DAYS = 7;

/**
 * The internal reference price per conversation. NOT a charge.
 *
 * Nobody is billed per conversation. This exists so the meter records a
 * comparable number across pharmacies and across time, which is what makes
 * the eventual pricing decision evidence rather than instinct.
 *
 * Configurable because it is a modelling assumption, not a fact — and it is
 * stamped onto each usage_record at write time, so changing it never
 * rewrites history.
 */
const NOTIONAL_CONVERSATION_KOBO = parseInt(
  process.env.NOTIONAL_CONVERSATION_KOBO || '7500', 10,
); // ₦75

function getPlan(id) {
  return PLANS[id] || PLANS.pilot_monthly;
}

/** ₦5,000 — for a screen, never for arithmetic. */
function formatNaira(kobo) {
  const naira = Math.round(Number(kobo || 0)) / 100;
  return `₦${naira.toLocaleString('en-NG', {
    minimumFractionDigits: naira % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

module.exports = {
  PLANS, TRIAL_DAYS, NOTIONAL_CONVERSATION_KOBO, getPlan, formatNaira,
};
