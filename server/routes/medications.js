/**
 * A patient's medication record.
 *
 *   GET   /api/customers/:id/medications            what they are on, and were
 *   GET   /api/customers/:id/medications/options    the vocabulary a form offers
 *   POST  /api/customers/:id/medications            add one
 *   GET   /api/customers/:id/medications/:medId     one, in full
 *   PATCH /api/customers/:id/medications/:medId     edit, including status
 *   GET   /api/customers/:id/medication-context     conditions · vitals · visit
 *
 *   GET   /api/customers/:id/medication-reviews            past reviews
 *   GET   /api/customers/:id/medication-reviews/options    the review vocabulary
 *   GET   /api/customers/:id/medication-reviews/reviewable what to review
 *   POST  /api/customers/:id/medication-reviews            start a draft
 *   GET   /api/customers/:id/medication-reviews/:reviewId  one review
 *   PATCH /api/customers/:id/medication-reviews/:reviewId  save, or ?sign=1
 *
 * MOUNTED BEFORE routes/customers.js, like routes/patientSearch.js: that
 * router owns GET /:id and would otherwise receive "medications" as an id.
 *
 * Thin by design. The contract is in services/clinical/medicationInput.js and
 * the queries in services/clinical/medications.js — both tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listMedications, getMedication, addMedication, updateMedication, medicationContext,
} = require('../services/clinical/medications');
const {
  readMedicationInput, readMedicationPatch, medicationOptions,
} = require('../services/clinical/medicationInput');
const {
  listReviews, getReview, startReview, saveReview, reviewableMedications,
} = require('../services/clinical/medicationReviews');
const { readReviewInput, reviewOptions } = require('../services/clinical/medicationReviewInput');
const { lagosDate } = require('../services/refills/refillSchedule');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id names nothing: the same 404 as another pharmacy's patient. */
function id(value, what) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    const err = new Error(`${what} not found.`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return value;
}

function actorId(req) {
  const user = req.user?.id;
  return user && user !== '00000000-0000-0000-0000-000000000000' ? user : null;
}

router.get('/:id/medications/options', requireAuth, (req, res) => {
  res.json(medicationOptions());
});

router.get('/:id/medications', requireAuth, async (req, res, next) => {
  try {
    res.json(await listMedications(req.pharmacyId, id(req.params.id, 'Patient'), {
      status: req.query.status || null,
    }));
  } catch (err) { next(err); }
});

router.post('/:id/medications', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const fields = readMedicationInput(req.body, { today: lagosDate() });
    res.status(201).json(await addMedication(req.pharmacyId, patient, fields, { actorId: actorId(req) }));
  } catch (err) { next(err); }
});

router.get('/:id/medications/:medId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getMedication(
      req.pharmacyId, id(req.params.id, 'Patient'), id(req.params.medId, 'Medication'),
    ));
  } catch (err) { next(err); }
});

router.patch('/:id/medications/:medId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const medication = id(req.params.medId, 'Medication');
    const patch = readMedicationPatch(req.body, { today: lagosDate() });
    res.json(await updateMedication(req.pharmacyId, patient, medication, patch, { actorId: actorId(req) }));
  } catch (err) { next(err); }
});

router.get('/:id/medication-context', requireAuth, async (req, res, next) => {
  try {
    res.json(await medicationContext(req.pharmacyId, id(req.params.id, 'Patient')));
  } catch (err) { next(err); }
});

// ---- the medication review (0056) -----------------------------------------
//
// The fixed paths are declared before `/:reviewId`, or "options" and
// "reviewable" arrive as review ids — the same reason this whole router is
// mounted before routes/customers.js.

router.get('/:id/medication-reviews/options', requireAuth, (req, res) => {
  res.json(reviewOptions());
});

router.get('/:id/medication-reviews/reviewable', requireAuth, async (req, res, next) => {
  try {
    res.json({ medications: await reviewableMedications(req.pharmacyId, id(req.params.id, 'Patient')) });
  } catch (err) { next(err); }
});

router.get('/:id/medication-reviews', requireAuth, async (req, res, next) => {
  try {
    res.json(await listReviews(req.pharmacyId, id(req.params.id, 'Patient')));
  } catch (err) { next(err); }
});

router.post('/:id/medication-reviews', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const review = await startReview(req.pharmacyId, patient, {
      actorId: actorId(req), today: lagosDate(),
    });
    res.status(201).json(review);
  } catch (err) { next(err); }
});

router.get('/:id/medication-reviews/:reviewId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getReview(
      req.pharmacyId, id(req.params.id, 'Patient'), id(req.params.reviewId, 'Medication review'),
    ));
  } catch (err) { next(err); }
});

router.patch('/:id/medication-reviews/:reviewId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const review = id(req.params.reviewId, 'Medication review');
    // Signing is a different act from saving, and it is the only point where
    // the review has to be complete — so it is asked for explicitly rather
    // than inferred from the body being full enough.
    const sign = req.query.sign === '1' || req.body?.sign === true;
    const fields = readReviewInput(req.body, { today: lagosDate(), signing: sign });
    res.json(await saveReview(req.pharmacyId, patient, review, fields, { actorId: actorId(req), sign }));
  } catch (err) { next(err); }
});

module.exports = router;
