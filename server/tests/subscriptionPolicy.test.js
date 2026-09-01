/**
 * Whether a pharmacy's assistant is allowed to answer.
 *
 * Every branch here is one a real pharmacy will eventually stand in, and the
 * two ways to get it wrong are not symmetrical: free service forever costs
 * money, and silencing someone who has paid costs the customer. So the tests
 * are mostly about the boundaries — the last hour of a trial, the first hour
 * after it, and the rows that are missing data they should have.
 *
 * PURE. The clock is injected, so day 8 is testable today.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSubscription, staffMessage, daysUntil,
} = require('../services/billing/subscriptionPolicy');
const { PLANS, TRIAL_DAYS, formatNaira } = require('../services/billing/plans');

const NOW = new Date('2026-09-01T12:00:00Z');
const inDays = (n) => new Date(NOW.getTime() + n * 86_400_000);

// ---- the pilot terms ------------------------------------------------------

test('the pilot prices are what was agreed', () => {
  // Written down so a change is a deliberate edit to a test that says what
  // the number was, not a quiet edit to a constant.
  assert.equal(PLANS.pilot_monthly.priceKobo, 500_000, '₦5,000/month');
  assert.equal(PLANS.pilot_annual.priceKobo, 5_000_000, '₦50,000/year');
  assert.equal(TRIAL_DAYS, 7);
});

test('the annual plan is actually cheaper than paying monthly', () => {
  // A "discount" that costs more is the kind of thing nobody checks until a
  // customer does.
  const monthlyForAYear = PLANS.pilot_monthly.priceKobo * 12;
  assert.ok(
    PLANS.pilot_annual.priceKobo < monthlyForAYear,
    `annual ${PLANS.pilot_annual.priceKobo} must undercut ${monthlyForAYear}`,
  );
});

test('no plan carries a conversation limit', () => {
  // The pilot deliberately has none. If one is ever added it must be a
  // decision, not something that arrives with a copy-pasted plan object.
  for (const plan of Object.values(PLANS)) {
    assert.equal(plan.includedConversations, undefined,
      `${plan.id} must not quietly gain an allowance`);
    assert.equal(plan.limit, undefined);
  }
});

test('naira formatting is for reading, not arithmetic', () => {
  assert.equal(formatNaira(500_000), '₦5,000');
  assert.equal(formatNaira(5_000_000), '₦50,000');
});

// ---- trial ----------------------------------------------------------------

test('a pharmacy inside its trial is served', () => {
  const d = evaluateSubscription(
    { subscription_status: 'trialing', trial_ends_at: inDays(5) }, NOW,
  );
  assert.equal(d.allowed, true);
  assert.equal(d.state, 'trial');
  assert.equal(d.inTrial, true);
  assert.equal(d.daysLeft, 5);
  assert.equal(d.warn, false, 'five days out is not yet worth nagging about');
});

test('the trial warns from three days out, not on the last morning', () => {
  // A pharmacy that discovers on day 7 that it needed a card has been
  // ambushed, and the assistant going quiet is the first thing they notice
  // rather than the last thing they were warned about.
  for (const days of [3, 2, 1]) {
    const d = evaluateSubscription(
      { subscription_status: 'trialing', trial_ends_at: inDays(days) }, NOW,
    );
    assert.equal(d.allowed, true, `day ${days} must still be served`);
    assert.equal(d.warn, true, `day ${days} must warn`);
  }
});

test('the last hours of a trial still work', () => {
  // Rounded up on purpose: with six hours left the pharmacy reads "1 day
  // left" while the assistant is demonstrably still working. A countdown
  // that says zero and keeps going teaches people to ignore countdowns.
  const d = evaluateSubscription(
    { subscription_status: 'trialing', trial_ends_at: new Date(NOW.getTime() + 6 * 3600_000) },
    NOW,
  );
  assert.equal(d.allowed, true);
  assert.equal(d.daysLeft, 1);
});

test('an expired trial stops the assistant', () => {
  const d = evaluateSubscription(
    { subscription_status: 'trialing', trial_ends_at: inDays(-1) }, NOW,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.state, 'trial_expired');
  assert.equal(d.needsPayment, true);
});

test('a tenant that never connected WhatsApp has not started its trial', () => {
  // The clock starts at connection, not sign-up (0048). Marking these
  // expired would run down a trial they never got the benefit of — and with
  // no connected number the assistant cannot reply to anyone anyway, so
  // there is nothing to stop.
  const d = evaluateSubscription({ subscription_status: 'trialing', trial_ends_at: null }, NOW);
  assert.equal(d.allowed, true);
  assert.equal(d.state, 'not_started');
  assert.equal(d.daysLeft, TRIAL_DAYS);
});

// ---- paid -----------------------------------------------------------------

test('a paid pharmacy inside its period is served', () => {
  const d = evaluateSubscription(
    { subscription_status: 'active', current_period_end: inDays(20) }, NOW,
  );
  assert.equal(d.allowed, true);
  assert.equal(d.state, 'active');
  assert.equal(d.needsPayment, false);
});

test('an ended period stops the assistant', () => {
  const d = evaluateSubscription(
    { subscription_status: 'active', current_period_end: inDays(-1) }, NOW,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.state, 'subscription_expired');
});

test('past_due stops the assistant even with a future period end', () => {
  // The processor said the payment failed. A period end written optimistically
  // at checkout must not override that.
  const d = evaluateSubscription(
    { subscription_status: 'past_due', current_period_end: inDays(20) }, NOW,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.needsPayment, true);
});

test('cancelled is checked before any date', () => {
  // Cancelling is a decision. A stale period end must not resurrect an
  // account somebody deliberately closed.
  const d = evaluateSubscription(
    { subscription_status: 'cancelled', current_period_end: inDays(200) }, NOW,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.state, 'cancelled');
});

test('an active subscription with no end date FAILS OPEN', () => {
  // A missing period end on a paid account is our data fault. The cost of
  // being wrong here is a few free days; the cost of the other direction is
  // silencing a pharmacy that has paid, because of a row we wrote badly.
  const d = evaluateSubscription({ subscription_status: 'active', current_period_end: null }, NOW);
  assert.equal(d.allowed, true);
  assert.equal(d.warn, true, 'it must still be visible that something is wrong');
});

test('an unknown status is treated as a trial, not as permission', () => {
  const d = evaluateSubscription(
    { subscription_status: 'something_new', trial_ends_at: inDays(-5) }, NOW,
  );
  assert.equal(d.allowed, false, 'an unrecognised status must not become free service');
});

test('a completely empty row does not throw', () => {
  const d = evaluateSubscription({}, NOW);
  assert.equal(typeof d.allowed, 'boolean');
});

// ---- what staff are told --------------------------------------------------

test('every stopped state explains that the inbox still works', () => {
  // A pharmacy that misses a payment must not think it has lost its customer
  // conversations. That fear is how you lose the pharmacy permanently, not
  // how you collect ₦5,000.
  for (const state of [
    { subscription_status: 'trialing', trial_ends_at: inDays(-1) },
    { subscription_status: 'active', current_period_end: inDays(-1) },
    { subscription_status: 'cancelled' },
  ]) {
    const d = evaluateSubscription(state, NOW);
    const msg = staffMessage(d, PLANS.pilot_monthly);
    assert.ok(msg, `${d.state} must say something`);
    assert.match(
      msg, /inbox|data is all still here/i,
      `"${d.state}" must reassure that nothing was taken away — got: ${msg}`,
    );
  }
});

test('nothing in the billing wording is addressed to a patient', () => {
  // A patient messaging a pharmacy has no relationship with our billing and
  // must never see a word about it. If such a string existed, something
  // would eventually send it.
  const states = [
    { subscription_status: 'trialing', trial_ends_at: inDays(2) },
    { subscription_status: 'trialing', trial_ends_at: inDays(-1) },
    { subscription_status: 'active', current_period_end: inDays(2) },
    { subscription_status: 'active', current_period_end: inDays(-1) },
    { subscription_status: 'cancelled' },
    { subscription_status: 'trialing', trial_ends_at: null },
  ];
  for (const s of states) {
    const msg = staffMessage(evaluateSubscription(s, NOW), PLANS.pilot_monthly);
    if (!msg) continue;
    // "Your" here means the pharmacy — staff-facing. What must never appear
    // is anything a patient could be shown about a pharmacy's account.
    assert.doesNotMatch(msg, /this pharmacy (has not|hasn't) paid/i);
    assert.doesNotMatch(msg, /unavailable due to/i);
  }
});

test('the trial-ending message reads correctly on the last day', () => {
  const d = evaluateSubscription(
    { subscription_status: 'trialing', trial_ends_at: inDays(1) }, NOW,
  );
  assert.match(staffMessage(d, PLANS.pilot_monthly), /ends tomorrow/);
});

// ---- the clock ------------------------------------------------------------

test('daysUntil rounds up, and goes negative once passed', () => {
  assert.equal(daysUntil(inDays(3), NOW), 3);
  assert.equal(daysUntil(new Date(NOW.getTime() + 3600_000), NOW), 1, 'an hour left is still a day');
  assert.ok(daysUntil(inDays(-2), NOW) < 0);
  assert.equal(daysUntil(null, NOW), null);
});

// ---- the trial clock ------------------------------------------------------
//
// The clock starts at WhatsApp connection, not sign-up, and sessionManager
// calls startTrialIfUnstarted on EVERY socket open — reconnects, restarts,
// re-pairs. The `trial_started_at is null` guard in the UPDATE is the only
// thing standing between that and an infinitely renewable free trial.

test('the trial start is guarded so it can only ever fire once', () => {
  // Structural. The behavioural version needs a database, which this suite
  // deliberately does not require — but the guard is a single clause, and
  // losing it would be invisible until a pharmacy noticed it could reset its
  // own trial by unplugging the phone.
  const src = require('node:fs').readFileSync(
    require.resolve('../services/billing/subscriptionService'), 'utf8',
  );
  const update = src.match(/update pharmacies[\s\S]*?returning/);
  assert.ok(update, 'expected the trial-start UPDATE');
  assert.match(
    update[0], /trial_started_at is null/,
    'without this clause a reconnect hands out another free trial',
  );
});

test('the trial is started from the connection handler, not from sign-up', () => {
  // If this moves to pharmacy creation, a pharmacy that signs up on Monday
  // and connects on Friday loses four days to our onboarding friction.
  const session = require('node:fs').readFileSync(
    require.resolve('../services/whatsapp/sessionManager'), 'utf8',
  );
  assert.match(session, /startTrialIfUnstarted/,
    'the trial clock must start when WhatsApp connects');

  const pharmacies = require('node:fs').readFileSync(
    require.resolve('../services/pharmacies'), 'utf8',
  );
  assert.doesNotMatch(pharmacies, /startTrialIfUnstarted/,
    'creating a tenant must NOT start the trial — there is no product to trial yet');
});
