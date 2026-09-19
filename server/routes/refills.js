/**
 * The refill call list, and the two things a pharmacist does to a journey
 * from it.
 *
 *   GET  /api/refills                               due / overdue / lapsed today
 *   POST /api/refills/journeys/:journeyId/dispense  the patient came back
 *   POST /api/refills/journeys/:journeyId/stop      no longer followed on it
 *
 * Nothing here sends a message. Reminders to patients are a separate change
 * that goes through communicationPolicy and outboundMessage; this surface is
 * what a pharmacist reads and acts on by hand.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const journeys = require('../services/refills/medicationJourneys');
const { requireId, readDispense, readStop } = require('../services/refills/refillInput');
const { lagosDate } = require('../services/refills/refillSchedule');

const router = express.Router();

function actorId(req) {
  const id = req.user?.id;
  return id && id !== '00000000-0000-0000-0000-000000000000' ? id : null;
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await journeys.listRefillQueue(req.pharmacyId, { today: lagosDate(), limit: req.query.limit }));
  } catch (err) { next(err); }
});

router.post('/journeys/:journeyId/dispense', requireAuth, async (req, res, next) => {
  try {
    const journeyId = requireId(req.params.journeyId, 'Medication journey');
    const today = lagosDate();
    const journey = await journeys.recordDispense(req.pharmacyId, journeyId, {
      ...readDispense(req.body, { today }),
      actorId: actorId(req),
      today,
    });
    res.status(201).json({ journey });
  } catch (err) { next(err); }
});

router.post('/journeys/:journeyId/stop', requireAuth, async (req, res, next) => {
  try {
    const journeyId = requireId(req.params.journeyId, 'Medication journey');
    const journey = await journeys.stopJourney(req.pharmacyId, journeyId, {
      ...readStop(req.body),
      actorId: actorId(req),
      today: lagosDate(),
    });
    res.json({ journey });
  } catch (err) { next(err); }
});

module.exports = router;
