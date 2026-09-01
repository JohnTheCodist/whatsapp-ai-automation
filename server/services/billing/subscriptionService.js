/**
 * The database side of billing. The decisions live in subscriptionPolicy.js,
 * which is pure; this reads and writes the rows those decisions are made from.
 *
 * Split the same way conversationState/conversationService are: a pure state
 * machine that can be tested exhaustively, and a thin service that is the
 * only thing allowed to write. Every trial clock and every period boundary
 * goes through here, so there is one place to look when a pharmacy asks why
 * their access changed.
 */

const { TRIAL_DAYS, getPlan } = require('./plans');
const { evaluateSubscription, staffMessage } = require('./subscriptionPolicy');
const { usageSince } = require('./usageMeter');

/**
 * Start the free trial the first time a pharmacy connects WhatsApp.
 *
 * `trial_started_at is null` in the WHERE clause is what makes this safe to
 * call on every single socket open — and it IS called on every socket open,
 * including reconnects, restarts and re-pairs. Only the first one wins, so a
 * pharmacy cannot reset its own trial by disconnecting and reconnecting, and
 * a restart does not hand out another seven days.
 *
 * Exactly the discipline markWarmupStarted uses in the worker, and for the
 * same reason: a clock that can be restarted is not a clock.
 *
 * WHY CONNECTION AND NOT SIGN-UP
 * A pharmacy that creates an account on Monday and connects WhatsApp on
 * Friday has had no product for four days. Starting at sign-up bills them
 * for our onboarding friction — and onboarding friction is ours to fix, not
 * theirs to pay for.
 *
 * @returns {Promise<boolean>} true if this call started the trial
 */
async function startTrialIfUnstarted(sql, pharmacyId) {
  if (!pharmacyId) return false;

  const rows = await sql`
    update pharmacies
    set trial_started_at = now(),
        trial_ends_at    = now() + make_interval(days => ${TRIAL_DAYS}),
        updated_at       = now()
    where id = ${pharmacyId}
      and trial_started_at is null
    returning id, trial_ends_at
  `;

  return rows.length > 0;
}

/**
 * Everything the Billing screen needs, in one round trip.
 *
 * Deliberately assembled here rather than in the route: the route's job is
 * HTTP, and a second caller (a reminder job, a support tool) must not have to
 * reimplement what "days left" means.
 */
async function getBillingSummary(sql, pharmacyId) {
  const [pharmacy] = await sql`
    select id, name, plan, subscription_status,
           trial_started_at, trial_ends_at,
           current_period_start, current_period_end
    from pharmacies
    where id = ${pharmacyId}
  `;
  if (!pharmacy) return null;

  const plan = getPlan(pharmacy.plan);
  const decision = evaluateSubscription(pharmacy);

  const payments = await sql`
    select kind, amount_kobo, reference, period_start, period_end, note, created_at
    from billing_events
    where pharmacy_id = ${pharmacyId}
    order by created_at desc
    limit 24
  `;

  // Conversations served in the CURRENT period, or since the trial began if
  // there is no period yet. Shown as a count of work done — never as a cost,
  // and never as a balance. Nobody is billed per conversation, and putting a
  // naira figure next to a number the pharmacy is not being charged is a
  // number that can only mislead.
  const since = pharmacy.current_period_start || pharmacy.trial_started_at || null;
  const usage = await usageSince(sql, pharmacyId, since);

  return {
    plan: {
      id: plan.id,
      label: plan.label,
      priceKobo: plan.priceKobo,
      interval: plan.interval,
    },
    status: pharmacy.subscription_status,
    state: decision.state,
    allowed: decision.allowed,
    needsPayment: decision.needsPayment,
    warn: decision.warn,
    inTrial: decision.inTrial,
    daysLeft: decision.daysLeft,
    expiresAt: decision.expiresAt,
    trialEndsAt: pharmacy.trial_ends_at,
    currentPeriodEnd: pharmacy.current_period_end,
    message: staffMessage(decision, plan),
    usage: {
      conversations: usage.conversations,
      // The notional figure is INTERNAL and is not returned. usage_records
      // has RLS with no client policy for the same reason.
      since,
    },
    payments: payments.map((p) => ({
      kind: p.kind,
      amountKobo: Number(p.amount_kobo),
      reference: p.reference,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      note: p.note,
      createdAt: p.created_at,
    })),
  };
}

module.exports = { startTrialIfUnstarted, getBillingSummary };
