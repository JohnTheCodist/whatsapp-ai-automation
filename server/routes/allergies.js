/**
 * A patient's allergy record.
 *
 *   GET   /api/customers/:id/allergies                 state · current · history
 *   GET   /api/customers/:id/allergies/options         the vocabulary a form offers
 *   GET   /api/customers/:id/allergies/allergens?q=    allergen search
 *   PUT   /api/customers/:id/allergies/status          { assert: 'no_known' | 'clear' }
 *   POST  /api/customers/:id/allergies                 record one
 *   GET   /api/customers/:id/allergies/:allergyId      one, in full
 *   PATCH /api/customers/:id/allergies/:allergyId      edit, including status
 *
 * THERE IS NO DELETE. A wrong record is refuted or marked entered in error,
 * and kept — see 0058's header.
 *
 * MOUNTED BEFORE routes/customers.js, like routes/medications.js: that
 * router owns GET /:id and would otherwise receive "allergies" as an id.
 * The fixed paths are declared before `/:allergyId` for the same reason.
 *
 * Thin by design. The contract is in services/clinical/allergyInput.js, the
 * queries and the role rule in services/clinical/allergies.js — both tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listAllergies, getAllergy, addAllergy, updateAllergy, setAllergyStatus, searchAllergens,
} = require('../services/clinical/allergies');
const {
  readAllergyInput, readAllergyPatch, allergyOptions,
} = require('../services/clinical/allergyInput');
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

/** Who is acting, and in what role — the role decides confirm/refute/NKA. */
function actor(req) {
  const user = req.user?.id;
  return {
    actorId: user && user !== '00000000-0000-0000-0000-000000000000' ? user : null,
    actorRole: req.pharmacyRole || null,
  };
}

router.get('/:id/allergies/options', requireAuth, (req, res) => {
  res.json(allergyOptions());
});

router.get('/:id/allergies/allergens', requireAuth, (req, res, next) => {
  try {
    id(req.params.id, 'Patient');
    res.json({ allergens: searchAllergens(req.query.q) });
  } catch (err) { next(err); }
});

router.put('/:id/allergies/status', requireAuth, async (req, res, next) => {
  try {
    res.json(await setAllergyStatus(req.pharmacyId, id(req.params.id, 'Patient'), req.body?.assert, actor(req)));
  } catch (err) { next(err); }
});

router.get('/:id/allergies', requireAuth, async (req, res, next) => {
  try {
    res.json(await listAllergies(req.pharmacyId, id(req.params.id, 'Patient')));
  } catch (err) { next(err); }
});

router.post('/:id/allergies', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const fields = readAllergyInput(req.body, { today: lagosDate() });
    res.status(201).json(await addAllergy(req.pharmacyId, patient, fields, actor(req)));
  } catch (err) { next(err); }
});

router.get('/:id/allergies/:allergyId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getAllergy(
      req.pharmacyId, id(req.params.id, 'Patient'), id(req.params.allergyId, 'Allergy'),
    ));
  } catch (err) { next(err); }
});

router.patch('/:id/allergies/:allergyId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const allergy = id(req.params.allergyId, 'Allergy');
    const patch = readAllergyPatch(req.body, { today: lagosDate() });
    res.json(await updateAllergy(req.pharmacyId, patient, allergy, patch, actor(req)));
  } catch (err) { next(err); }
});

module.exports = router;
