/**
 * Who may be sent what.
 *
 * The tests that matter most here are the ones where two rules disagree: a
 * customer who declined marketing but needs a refill reminder, and a customer
 * whose marketing flag is still true from before they sent STOP. Those are
 * the cases a single opt-in boolean gets wrong, and the second one is how a
 * campaign messages somebody who told the pharmacy to stop.
 *
 * Pure function, so no database and no fixtures — every branch is reachable
 * directly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CATEGORIES, canSendMessage, isKnownCategory, withRequiredFooter,
} = require('../services/whatsapp/communicationPolicy');

/** A customer in the default state a new patient is created in. */
const fresh = (over = {}) => ({
  status: 'active',
  communication_status: 'subscribed',
  comm_transactional: true,
  comm_order_notifications: true,
  comm_medication: true,
  comm_marketing: false,
  ...over,
});

// ---- defaults for a brand-new patient -----------------------------------

test('a new patient can be sent transactional, order and medication messages', () => {
  const c = fresh();
  for (const cat of [CATEGORIES.TRANSACTIONAL, CATEGORIES.ORDER_NOTIFICATION, CATEGORIES.MEDICATION_RELATED]) {
    assert.equal(canSendMessage({ category: cat, customer: c }).allowed, true, cat);
  }
});

test('a new patient is NOT marketable — messaging a pharmacy is not consent', () => {
  const r = canSendMessage({ category: CATEGORIES.MARKETING, customer: fresh() });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'MARKETING_NOT_SUBSCRIBED');
});

test('an explicitly subscribed customer can be marketed to', () => {
  const r = canSendMessage({ category: CATEGORIES.MARKETING, customer: fresh({ comm_marketing: true }) });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'MARKETING_SUBSCRIBED');
});

// ---- the cases a single boolean gets wrong -------------------------------

test('declining marketing does NOT suppress a refill reminder', () => {
  // The failure this whole category split exists to prevent: someone who
  // does not want promotions still needs to be told their medication is due.
  const c = fresh({ comm_marketing: false, comm_medication: true });
  assert.equal(canSendMessage({ category: CATEGORIES.MARKETING, customer: c }).allowed, false);
  assert.equal(canSendMessage({ category: CATEGORIES.MEDICATION_RELATED, customer: c }).allowed, true);
});

test('an opt-out outranks a stale marketing flag left true', () => {
  // A campaign built from an old audience list would otherwise act on
  // comm_marketing and message someone who has since sent STOP.
  const c = fresh({ comm_marketing: true, communication_status: 'opted_out' });
  const r = canSendMessage({ category: CATEGORIES.MARKETING, customer: c });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'PATIENT_OPTED_OUT', 'the global opt-out must win over the category flag');
});

test('an opt-out blocks every customer-facing category, including order updates', () => {
  const c = fresh({ communication_status: 'opted_out' });
  for (const cat of [CATEGORIES.TRANSACTIONAL, CATEGORIES.ORDER_NOTIFICATION,
    CATEGORIES.MEDICATION_RELATED, CATEGORIES.MARKETING]) {
    assert.equal(canSendMessage({ category: cat, customer: c }).allowed, false, cat);
  }
});

test('a blocked patient receives nothing, whatever their preferences say', () => {
  const c = fresh({ status: 'blocked', comm_marketing: true, comm_medication: true });
  const r = canSendMessage({ category: CATEGORIES.MEDICATION_RELATED, customer: c });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'PATIENT_BLOCKED');
});

test('INACTIVE is not a communication restriction', () => {
  // Dormancy means we have not heard from them, not that they refused. A
  // customer who last ordered in January can still be told a refill is due —
  // treating silence as refusal would delete the audience reminders exist for.
  const c = fresh({ status: 'inactive', comm_medication: true });
  assert.equal(canSendMessage({ category: CATEGORIES.MEDICATION_RELATED, customer: c }).allowed, true);
});

// ---- refusing to guess ---------------------------------------------------

test('an unclassified send is refused, not allowed by default', () => {
  const r = canSendMessage({ category: undefined, customer: fresh() });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'UNKNOWN_CATEGORY');
});

test('a made-up category is refused', () => {
  assert.equal(canSendMessage({ category: 'promotional_blast', customer: fresh() }).allowed, false);
  assert.equal(isKnownCategory('promotional_blast'), false);
});

test('a missing customer is refused rather than treated as permissive', () => {
  const r = canSendMessage({ category: CATEGORIES.ORDER_NOTIFICATION, customer: null });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'CUSTOMER_NOT_FOUND');
});

test('a disabled category is refused with a reason naming it', () => {
  const c = fresh({ comm_order_notifications: false });
  const r = canSendMessage({ category: CATEGORIES.ORDER_NOTIFICATION, customer: c });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /ORDER_NOTIFICATION/);
});

// ---- staff alerts --------------------------------------------------------

test('staff alerts are not gated on customer consent', () => {
  // The recipient is the pharmacy's own number. Gating this on the customer
  // would mean one customer opting out silently disabled the pharmacy's
  // own order notifications.
  const c = fresh({ communication_status: 'opted_out', status: 'blocked' });
  assert.equal(canSendMessage({ category: CATEGORIES.STAFF_ALERT, customer: c }).allowed, true);
});

// ---- the unsubscribe footer ---------------------------------------------

test('marketing messages get an unsubscribe line automatically', () => {
  const out = withRequiredFooter('20% off vitamins this weekend.', CATEGORIES.MARKETING);
  assert.match(out, /STOP/i);
  assert.ok(out.startsWith('20% off vitamins this weekend.'));
});

test('non-marketing messages do NOT get one', () => {
  // "Reply STOP" on an order confirmation invites someone to opt out of the
  // messages they actually wanted.
  const body = 'Your order ABC-123 is ready to collect.';
  assert.equal(withRequiredFooter(body, CATEGORIES.ORDER_NOTIFICATION), body);
  assert.equal(withRequiredFooter(body, CATEGORIES.MEDICATION_RELATED), body);
});

test('a campaign that wrote its own opt-out line does not get two', () => {
  const body = 'Big sale! Reply STOP to unsubscribe.';
  assert.equal(withRequiredFooter(body, CATEGORIES.MARKETING), body);
});
