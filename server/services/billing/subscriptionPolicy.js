/**
 * May this pharmacy's assistant answer customers right now?
 *
 * PURE, FOR THE SAME REASON selectTenant IS.
 * This decides whether a paying customer's product works. Every branch is
 * one a pharmacy will eventually stand in, and getting one wrong means
 * either an assistant that goes silent on someone who has paid, or free
 * service forever. A pure function on a clock that is passed in can be
 * walked through exhaustively without a database, a card, or waiting seven
 * days — see tests/subscriptionPolicy.test.js.
 *
 * WHAT "STOPPED" MEANS, AND WHAT IT DOES NOT
 * When this returns allowed:false the ASSISTANT stops replying. The product
 * does not disappear:
 *
 *   - the dashboard still works
 *   - the Inbox still works, and staff can still reply by hand
 *   - messages still arrive and are still stored
 *   - the catalogue, orders and patient records are all still there
 *
 * A pharmacy that misses a payment must not lose access to its own customer
 * conversations. Deleting the product to collect ₦5,000 would be a way to
 * lose the pharmacy permanently.
 *
 * AND THE CUSTOMER IS NEVER TOLD. A patient messaging a pharmacy has no
 * relationship with our billing and must never see a word about it — no
 * "this pharmacy has not paid", no silence they cannot explain. Staff get
 * told, loudly, in the dashboard. See the note on `customerFacing` below.
 */

const { TRIAL_DAYS, formatNaira } = require('./plans');

const DAY_MS = 86_400_000;

/**
 * How many whole days until `when`. Negative once it has passed.
 *
 * Rounded UP deliberately: with 6 hours left a pharmacy should read "1 day
 * left", not "0 days left" while the assistant is demonstrably still
 * working. A countdown that says zero and keeps going teaches people to
 * ignore it, which is the opposite of what a renewal notice is for.
 */
function daysUntil(when, now) {
  if (!when) return null;
  return Math.ceil((new Date(when).getTime() - now.getTime()) / DAY_MS);
}

/**
 * @param {object} pharmacy   plan, subscription_status, trial_ends_at,
 *                            current_period_end
 * @param {Date}   [now]
 * @returns {{
 *   allowed: boolean, state: string, reason: string,
 *   daysLeft: number|null, expiresAt: Date|null,
 *   inTrial: boolean, needsPayment: boolean, warn: boolean
 * }}
 *   `state` is for people: 'trial' | 'active' | 'trial_expired'
 *           | 'subscription_expired' | 'cancelled' | 'not_started'
 *   `reason` is for logs — stable, machine-readable, never shown.
 */
function evaluateSubscription(pharmacy = {}, now = new Date()) {
  const status = pharmacy.subscription_status || 'trialing';

  // Cancelled is a decision, not a lapse. Checked first so a stale
  // current_period_end cannot resurrect an account somebody closed.
  if (status === 'cancelled') {
    return {
      allowed: false, state: 'cancelled', reason: 'cancelled',
      daysLeft: null, expiresAt: null,
      inTrial: false, needsPayment: true, warn: false,
    };
  }

  if (status === 'active') {
    const end = pharmacy.current_period_end;
    const left = daysUntil(end, now);

    // No end date on an active subscription is a data fault, not a licence.
    // Failing OPEN here is deliberate and is the safer direction: the cost
    // of being wrong is a few free days, and the cost of the alternative is
    // silencing a pharmacy that has paid because of our own bad row.
    if (!end) {
      return {
        allowed: true, state: 'active', reason: 'active_no_period_end',
        daysLeft: null, expiresAt: null,
        inTrial: false, needsPayment: false, warn: true,
      };
    }

    if (left > 0) {
      return {
        allowed: true, state: 'active', reason: 'active',
        daysLeft: left, expiresAt: new Date(end),
        inTrial: false, needsPayment: false,
        // Renewal nudge in the last three days. Long enough to act on
        // during a working week, short enough not to become wallpaper.
        warn: left <= 3,
      };
    }

    return {
      allowed: false, state: 'subscription_expired', reason: 'period_ended',
      daysLeft: left, expiresAt: new Date(end),
      inTrial: false, needsPayment: true, warn: false,
    };
  }

  if (status === 'past_due') {
    return {
      allowed: false, state: 'subscription_expired', reason: 'past_due',
      daysLeft: null, expiresAt: pharmacy.current_period_end ? new Date(pharmacy.current_period_end) : null,
      inTrial: false, needsPayment: true, warn: false,
    };
  }

  // ---- trialing -----------------------------------------------------------

  const trialEnd = pharmacy.trial_ends_at;

  // No trial clock yet. This is a tenant that exists but has never connected
  // WhatsApp, so the trial has not begun — see 0048. Allowed, because there
  // is nothing to stop: with no connected number the assistant cannot reply
  // to anyone anyway, and marking them expired would start a countdown they
  // never got the benefit of.
  if (!trialEnd) {
    return {
      allowed: true, state: 'not_started', reason: 'trial_not_started',
      daysLeft: TRIAL_DAYS, expiresAt: null,
      inTrial: true, needsPayment: false, warn: false,
    };
  }

  const left = daysUntil(trialEnd, now);

  if (left > 0) {
    return {
      allowed: true, state: 'trial', reason: 'in_trial',
      daysLeft: left, expiresAt: new Date(trialEnd),
      inTrial: true, needsPayment: false,
      // Warn from three days out. A pharmacy that discovers on day 7 that
      // it needed a card has been ambushed, and the assistant stopping is
      // the first thing they will notice rather than the last.
      warn: left <= 3,
    };
  }

  return {
    allowed: false, state: 'trial_expired', reason: 'trial_ended',
    daysLeft: left, expiresAt: new Date(trialEnd),
    inTrial: false, needsPayment: true, warn: false,
  };
}

/**
 * The sentence staff read in the dashboard.
 *
 * Never sent to a patient. There is no customer-facing wording anywhere in
 * this module, and that absence is deliberate: if the string existed,
 * eventually something would send it. A patient who messages a pharmacy has
 * no relationship with our billing.
 */
function staffMessage(decision, plan = null) {
  // The price, in the sentence that asks for it. A nudge to pay that does
  // not say what it costs makes the owner go and look, and looking is where
  // people stop.
  const price = plan ? ` ${formatNaira(plan.priceKobo)} a ${plan.interval}.` : '';

  switch (decision.state) {
    case 'trial':
      return decision.daysLeft === 1
        ? `Your free trial ends tomorrow. Add a payment method to keep the assistant answering —${price}`
        : `Your free trial ends in ${decision.daysLeft} days. Add a payment method to keep the assistant answering —${price}`;
    case 'trial_expired':
      return 'Your free trial has ended, so the assistant has stopped replying to customers. '
        + 'Your inbox still works and you can reply by hand. '
        + `Choose a plan to switch it back on —${price}`;
    case 'active':
      return decision.warn && decision.daysLeft !== null
        ? `Your plan renews in ${decision.daysLeft} day${decision.daysLeft === 1 ? '' : 's'}.`
        : null;
    case 'subscription_expired':
      return 'Your subscription has ended, so the assistant has stopped replying to customers. '
        + 'Your inbox still works and you can reply by hand. Renew to switch it back on.';
    case 'cancelled':
      return 'Your subscription is cancelled. The assistant is not replying to customers. '
        + 'Your data is all still here — choose a plan whenever you want it back.';
    case 'not_started':
      return `Connect WhatsApp to start your ${TRIAL_DAYS}-day free trial.`;
    default:
      return null;
  }
}

module.exports = { evaluateSubscription, staffMessage, daysUntil };
