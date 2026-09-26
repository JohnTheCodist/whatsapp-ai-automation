/**
 * A patient's diagnostic tests.
 *
 *   GET   /api/customers/:id/tests                  the list + a count per filter
 *   GET   /api/customers/:id/tests/options          the vocabulary a form offers
 *   GET   /api/customers/:id/tests/catalogue?q=     the test catalogue
 *   GET   /api/customers/:id/tests/trend?code=      one analyte over time
 *   GET   /api/customers/:id/tests/encounters       this patient's consultations
 *   POST  /api/customers/:id/tests                  order one, or record a completed one
 *   GET   /api/customers/:id/tests/:testId          one test, in full
 *   PATCH /api/customers/:id/tests/:testId          edit, add results, or correct
 *
 * THERE IS NO DELETE. A test that was never done is cancelled, with a
 * reason; a result that was wrong is corrected, and what it said is kept.
 *
 * MOUNTED BEFORE routes/customers.js; fixed paths before `/:testId`.
 * Thin by design: the contract is services/clinical/testInput.js, the
 * queries and the role rule services/clinical/tests.js — both tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listTests, getTest, addTest, updateTest, testTrend, testCatalogue,
} = require('../services/clinical/tests');
const { readTestInput, readTestPatch, testOptions } = require('../services/clinical/testInput');
const { encounterChoices } = require('../services/clinical/problems');
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

function actor(req) {
  const user = req.user?.id;
  return {
    actorId: user && user !== '00000000-0000-0000-0000-000000000000' ? user : null,
    actorRole: req.pharmacyRole || null,
  };
}

router.get('/:id/tests/options', requireAuth, (req, res) => {
  res.json(testOptions());
});

router.get('/:id/tests/catalogue', requireAuth, async (req, res, next) => {
  try {
    id(req.params.id, 'Patient');
    res.json({ tests: await testCatalogue(req.pharmacyId, req.query.q) });
  } catch (err) { next(err); }
});

router.get('/:id/tests/trend', requireAuth, async (req, res, next) => {
  try {
    res.json(await testTrend(req.pharmacyId, id(req.params.id, 'Patient'), {
      code: req.query.code || null,
      name: req.query.name || null,
    }));
  } catch (err) { next(err); }
});

// The same read-only picker the Conditions form uses: it never creates a
// patient profile as a side effect of being read.
router.get('/:id/tests/encounters', requireAuth, async (req, res, next) => {
  try {
    res.json({ encounters: await encounterChoices(req.pharmacyId, id(req.params.id, 'Patient')) });
  } catch (err) { next(err); }
});

router.get('/:id/tests', requireAuth, async (req, res, next) => {
  try {
    res.json(await listTests(req.pharmacyId, id(req.params.id, 'Patient'), {
      filter: req.query.filter || null,
      category: req.query.category || null,
      q: req.query.q || null,
    }));
  } catch (err) { next(err); }
});

router.post('/:id/tests', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const fields = readTestInput(req.body, { today: lagosDate() });
    res.status(201).json(await addTest(req.pharmacyId, patient, fields, actor(req)));
  } catch (err) { next(err); }
});

router.get('/:id/tests/:testId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getTest(req.pharmacyId, id(req.params.id, 'Patient'), id(req.params.testId, 'Test')));
  } catch (err) { next(err); }
});

router.patch('/:id/tests/:testId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const test = id(req.params.testId, 'Test');
    const patch = readTestPatch(req.body, { today: lagosDate() });
    res.json(await updateTest(req.pharmacyId, patient, test, patch, actor(req)));
  } catch (err) { next(err); }
});

module.exports = router;
