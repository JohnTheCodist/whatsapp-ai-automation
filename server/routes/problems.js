/**
 * A patient's conditions — the problem list.
 *
 *   GET   /api/customers/:id/problems                  current · history · purchase suggestions
 *   GET   /api/customers/:id/problems/options          the vocabulary a form offers
 *   GET   /api/customers/:id/problems/catalogue?q=     condition search
 *   GET   /api/customers/:id/problems/hints?name=      symptom / allergy hints for a name
 *   GET   /api/customers/:id/problems/encounters       this patient's consultations, for linking
 *   POST  /api/customers/:id/problems                  record one (409 DUPLICATE_ACTIVE, unless allowDuplicate)
 *   GET   /api/customers/:id/problems/:problemId       one, in full
 *   PATCH /api/customers/:id/problems/:problemId       edit, including status
 *
 * WHY /problems AND NOT /conditions. /:id/conditions already belongs to the
 * purchase-based condition profile (routes/conditions.js) — an inference,
 * not a record. Two meanings under one URL would be the confusion the
 * separate tables exist to prevent. The screen says Conditions; the URL says
 * what the record is.
 *
 * THERE IS NO DELETE. A wrong record is refuted or marked entered in error.
 *
 * MOUNTED BEFORE routes/customers.js; fixed paths before `/:problemId`.
 * Thin by design: the contract is problemInput.js, the queries and the role
 * rule problems.js — both tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listProblems, getProblem, addProblem, updateProblem, encounterChoices,
} = require('../services/clinical/problems');
const {
  readProblemInput, readProblemPatch, problemOptions, searchCatalogue, conditionHints,
} = require('../services/clinical/problemInput');
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

router.get('/:id/problems/options', requireAuth, (req, res) => {
  res.json(problemOptions());
});

router.get('/:id/problems/catalogue', requireAuth, (req, res, next) => {
  try {
    id(req.params.id, 'Patient');
    res.json({ conditions: searchCatalogue(req.query.q) });
  } catch (err) { next(err); }
});

router.get('/:id/problems/hints', requireAuth, (req, res, next) => {
  try {
    id(req.params.id, 'Patient');
    res.json({ hints: conditionHints(req.query.name) });
  } catch (err) { next(err); }
});

router.get('/:id/problems/encounters', requireAuth, async (req, res, next) => {
  try {
    res.json({ encounters: await encounterChoices(req.pharmacyId, id(req.params.id, 'Patient')) });
  } catch (err) { next(err); }
});

router.get('/:id/problems', requireAuth, async (req, res, next) => {
  try {
    res.json(await listProblems(req.pharmacyId, id(req.params.id, 'Patient')));
  } catch (err) { next(err); }
});

router.post('/:id/problems', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const fields = readProblemInput(req.body, { today: lagosDate() });
    res.status(201).json(await addProblem(req.pharmacyId, patient, fields, actor(req)));
  } catch (err) { next(err); }
});

router.get('/:id/problems/:problemId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getProblem(req.pharmacyId, id(req.params.id, 'Patient'), id(req.params.problemId, 'Condition')));
  } catch (err) { next(err); }
});

router.patch('/:id/problems/:problemId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const problem = id(req.params.problemId, 'Condition');
    const patch = readProblemPatch(req.body, { today: lagosDate() });
    res.json(await updateProblem(req.pharmacyId, patient, problem, patch, actor(req)));
  } catch (err) { next(err); }
});

module.exports = router;
