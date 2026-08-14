/**
 * May we send THIS kind of message to THIS customer, right now?
 *
 * The one place that question is answered. Every proactive send routes
 * through it, and a send that cannot name its category is refused rather
 * than given the benefit of the doubt.
 *
 * WHY CATEGORIES AND NOT A SINGLE FLAG
 * These are genuinely different questions with different right answers:
 *
 *   "Your order is ready."        the customer asked for this
 *   "Your refill may be due."     health, not commerce
 *   "20% off vitamins!"           marketing
 *
 * One flag forces a choice between marketing someone who only wanted order
 * updates and suppressing a refill reminder because they declined
 * promotions. The second failure is the one that harms somebody, so the
 * dimensions stay separate.
 *
 * THE ORDER OF CHECKS IS THE POLICY
 * Hard restrictions first — blocked, opted out, channel off — because those
 * override any per-category preference. A blocked customer with marketing
 * enabled is still blocked. Only then does the category's own preference
 * matter. Getting this order wrong would let a per-category `true` outrank a
 * global opt-out, which is the one mistake in this file that reaches a
 * customer who told us to stop.
 *
 * PURE. Takes the customer's current state as data, returns a decision.
 * No database, no clock beyond what the caller passes — so every branch is
 * testable without fixtures, and the decision can be recorded verbatim on
 * the message it permitted.
 */

/** The categories a proactive message can declare. */
const CATEGORIES = Object.freeze({
  TRANSACTIONAL: 'transactional',
  ORDER_NOTIFICATION: 'order_notification',
  MEDICATION_RELATED: 'medication_related',
  MARKETING: 'marketing',
  // Not customer communication at all — an alert to the pharmacy's own staff
  // number. Exempt from customer consent because the recipient is the
  // pharmacy, not the customer; it is named here so that exemption is a
  // declared category rather than a forgotten code path.
  STAFF_ALERT: 'staff_alert',
});

const CATEGORY_SET = new Set(Object.values(CATEGORIES));

/** Which customer preference column governs each category. */
const PREFERENCE_FOR = Object.freeze({
  [CATEGORIES.TRANSACTIONAL]: 'comm_transactional',
  [CATEGORIES.ORDER_NOTIFICATION]: 'comm_order_notifications',
  [CATEGORIES.MEDICATION_RELATED]: 'comm_medication',
  [CATEGORIES.MARKETING]: 'comm_marketing',
});

function isKnownCategory(c) {
  return CATEGORY_SET.has(c);
}

/**
 * @param {object} args
 * @param {string} args.category   one of CATEGORIES
 * @param {object} args.customer   the row: status, communication_status, comm_* flags
 * @returns {{allowed: boolean, reason: string}}
 */
function canSendMessage({ category, customer }) {
  // An unclassified send is a bug in the caller, not a message to let
  // through. Refusing here is what makes "every outbound message has a
  // category" enforceable rather than aspirational.
  if (!isKnownCategory(category)) {
    return { allowed: false, reason: 'UNKNOWN_CATEGORY' };
  }
  if (!customer) {
    return { allowed: false, reason: 'CUSTOMER_NOT_FOUND' };
  }

  // Staff alerts go to the pharmacy's own number. The customer's preferences
  // are simply not the relevant question, and gating them on it would mean a
  // customer opting out silently disabled the pharmacy's own notifications.
  if (category === CATEGORIES.STAFF_ALERT) {
    return { allowed: true, reason: 'STAFF_RECIPIENT' };
  }

  // ---- hard restrictions, before any per-category preference -------------

  if (customer.status === 'blocked') {
    return { allowed: false, reason: 'PATIENT_BLOCKED' };
  }

  if (customer.communication_status === 'opted_out') {
    // Covers STOP. Outranks every category flag, including a marketing
    // preference left true from before they opted out — which is exactly the
    // stale-consent case a campaign would otherwise act on.
    return { allowed: false, reason: 'PATIENT_OPTED_OUT' };
  }

  // Deliberately NOT checked: status === 'inactive'. Dormancy means we have
  // not heard from someone recently, not that they withdrew permission. A
  // customer who last ordered in January can still be told their refill is
  // due — treating silence as refusal would quietly delete the audience that
  // reminders exist for.

  // ---- the category's own preference -------------------------------------

  const column = PREFERENCE_FOR[category];
  const enabled = customer[column];

  if (enabled !== true) {
    return {
      allowed: false,
      reason: category === CATEGORIES.MARKETING ? 'MARKETING_NOT_SUBSCRIBED' : `${category.toUpperCase()}_DISABLED`,
    };
  }

  return {
    allowed: true,
    reason: category === CATEGORIES.MARKETING ? 'MARKETING_SUBSCRIBED' : `${category.toUpperCase()}_ENABLED`,
  };
}

/**
 * The unsubscribe line every marketing message carries.
 *
 * Added by the messaging layer, not by whoever writes a campaign — a footer
 * that depends on being remembered is a footer that will be missing from the
 * one message somebody complains about. Only marketing gets it: appending
 * "reply STOP" to an order confirmation invites someone to opt out of the
 * messages they actually wanted.
 */
function marketingFooter(customFooter = null) {
  return customFooter || 'Reply STOP at any time to stop receiving promotional messages.';
}

/** Append the footer if this category needs one, exactly once. */
function withRequiredFooter(body, category, customFooter = null) {
  if (category !== CATEGORIES.MARKETING) return body;
  const footer = marketingFooter(customFooter);
  // A campaign that already wrote its own opt-out line should not get two.
  if (String(body).toLowerCase().includes('stop')) return body;
  return `${body}\n\n${footer}`;
}

module.exports = {
  CATEGORIES, PREFERENCE_FOR, canSendMessage, isKnownCategory,
  marketingFooter, withRequiredFooter,
};
