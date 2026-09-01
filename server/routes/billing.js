/**
 * Billing — what the pharmacy is on, and what they have paid.
 *
 *   GET /api/billing        the whole picture for the Billing screen
 *   GET /api/billing/status the small version the shell polls for its banner
 *
 * NO PAYMENT ENDPOINTS YET. Paystack is a later phase; until then a plan is
 * changed by a human writing a billing_events row, which is deliberate —
 * during a pilot with a handful of pharmacies, a person deciding is more
 * reliable than an integration nobody has exercised.
 *
 * OWNER-ONLY ON THE FULL VIEW. Payment history is not something a counter
 * assistant needs, and role separation already exists for exactly this. The
 * banner status is readable by anyone, because everyone needs to know why
 * the assistant has stopped.
 */

const express = require('express');

const { requireAuth, requireRole } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { getBillingSummary } = require('../services/billing/subscriptionService');
const { evaluateSubscription, staffMessage } = require('../services/billing/subscriptionPolicy');
const { getPlan, PLANS } = require('../services/billing/plans');

const router = express.Router();

router.get('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const summary = await getBillingSummary(getSql(), req.pharmacyId);
    if (!summary) return res.status(404).json({ error: 'Pharmacy not found', code: 'NOT_FOUND' });

    res.json({
      ...summary,
      // The catalogue, so the screen does not hardcode prices that would then
      // disagree with the server the first time one changes.
      plans: Object.values(PLANS).map((p) => ({
        id: p.id, label: p.label, priceKobo: p.priceKobo, interval: p.interval,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The banner version: one small query, safe to poll, readable by any member.
 *
 * Separate from GET / on purpose — the same reasoning as /api/summary in
 * index.js. The shell needs four fields to decide whether to show a warning
 * strip; making it fetch payment history every 30 seconds to find them would
 * be the polling mistake that exhausted the pooler once already.
 */
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const [row] = await db`
      select plan, subscription_status, trial_ends_at, current_period_end
      from pharmacies where id = ${req.pharmacyId}
    `;
    if (!row) return res.status(404).json({ error: 'Pharmacy not found', code: 'NOT_FOUND' });

    const decision = evaluateSubscription(row);
    res.json({
      state: decision.state,
      allowed: decision.allowed,
      warn: decision.warn,
      inTrial: decision.inTrial,
      needsPayment: decision.needsPayment,
      daysLeft: decision.daysLeft,
      message: staffMessage(decision, getPlan(row.plan)),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
