/**
 * A patient's medication journeys.
 *
 * Mounted on /api/customers, the same prefix as conditions.js and for the
 * same reason: what a patient takes is a fact about that customer, and a
 * second noun in the URL would imply a second patient record that does not
 * exist.
 *
 *   GET  /api/customers/:id/medications   every journey, active first
 *   POST /api/customers/:id/medications   enrol on a medicine + first dispense
 *
 * Thin by design. Parsing lives in services/refills/refillInput.js and the
 * rules in medicationJourneys.js / refillSchedule.js, where they are tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const journeys = require('../services/refills/medicationJourneys');
const { requireId, readJourneyStart } = require('../services/refills/refillInput');
const { lagosDate } = require('../services/refills/refillSchedule');

const router = express.Router();

/** The staff user, or null under DEV_AUTH_BYPASS — same rule as customers.js. */
function actorId(req) {
  const id = req.user?.id;
  return id && id !== '00000000-0000-0000-0000-000000000000' ? id : null;
}

router.get('/:id/medications', requireAuth, async (req, res, next) => {
  try {
    const customerId = requireId(req.params.id, 'Customer');
    const today = lagosDate();
    res.json({ today, journeys: await journeys.listJourneysForCustomer(req.pharmacyId, customerId, { today }) });
  } catch (err) { next(err); }
});

router.post('/:id/medications', requireAuth, async (req, res, next) => {
  try {
    const customerId = requireId(req.params.id, 'Customer');
    const today = lagosDate();
    const journey = await journeys.startJourney(req.pharmacyId, customerId, {
      ...readJourneyStart(req.body, { today }),
      actorId: actorId(req),
      today,
    });
    res.status(201).json({ journey });
  } catch (err) { next(err); }
});

module.exports = router;
