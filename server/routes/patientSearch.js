/**
 * Patient search and a patient's care details.
 *
 *   GET   /api/customers/search           name/phone + the eight filters
 *   GET   /api/customers/search/options   what the filter bar can offer
 *   GET   /api/customers/:id/care         assigned pharmacist, age, gender
 *   PATCH /api/customers/:id/care         change any of those three
 *   GET   /api/customers/:id/vitals       a page of readings, newest first
 *   GET   /api/customers/:id/vitals/series every reading, oldest first
 *   POST  /api/customers/:id/vitals       record one reading
 *
 * MOUNTED BEFORE routes/customers.js, deliberately: that router has
 * GET /:id, which would otherwise receive "search" as a patient id.
 *
 * Thin by design; the contract is in patientFilters.js and careInput.js,
 * the queries in patientSearch.js and patientCare.js — all tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { readPatientFilters } = require('../services/customers/patientFilters');
const { searchPatients, searchOptions } = require('../services/customers/patientSearch');
const { getCare, updateCare } = require('../services/customers/patientCare');
const { readCareInput } = require('../services/customers/careInput');
const { listVitals, vitalsSeries, recordVitals } = require('../services/clinical/vitals');
const { readVitalsInput } = require('../services/clinical/vitalsInput');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id names nothing: the same 404 as another pharmacy's patient. */
function patientId(req) {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    const err = new Error('Patient not found.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return id;
}

function actorId(req) {
  const id = req.user?.id;
  return id && id !== '00000000-0000-0000-0000-000000000000' ? id : null;
}

router.get('/search', requireAuth, async (req, res, next) => {
  try {
    res.json(await searchPatients(req.pharmacyId, readPatientFilters(req.query)));
  } catch (err) { next(err); }
});

router.get('/search/options', requireAuth, async (req, res, next) => {
  try {
    res.json(await searchOptions(req.pharmacyId));
  } catch (err) { next(err); }
});

router.get('/:id/care', requireAuth, async (req, res, next) => {
  try {
    res.json(await getCare(req.pharmacyId, patientId(req)));
  } catch (err) { next(err); }
});

router.patch('/:id/care', requireAuth, async (req, res, next) => {
  try {
    const id = patientId(req);
    res.json(await updateCare(req.pharmacyId, id, readCareInput(req.body), { actorId: actorId(req) }));
  } catch (err) { next(err); }
});

// ---- vitals and biometrics (0054) -----------------------------------------

router.get('/:id/vitals', requireAuth, async (req, res, next) => {
  try {
    const id = patientId(req);
    res.json(await listVitals(req.pharmacyId, id, {
      limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (err) { next(err); }
});

/** Every reading in time order, for the chart. */
router.get('/:id/vitals/series', requireAuth, async (req, res, next) => {
  try {
    const id = patientId(req);
    res.json({ readings: await vitalsSeries(req.pharmacyId, id, { limit: req.query.limit }) });
  } catch (err) { next(err); }
});

router.post('/:id/vitals', requireAuth, async (req, res, next) => {
  try {
    const id = patientId(req);
    const reading = await recordVitals(req.pharmacyId, id, readVitalsInput(req.body), {
      actorId: actorId(req),
    });
    res.status(201).json(reading);
  } catch (err) { next(err); }
});

module.exports = router;
