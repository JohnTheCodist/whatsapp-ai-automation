/**
 * The pharmacist's consultation note — `/api/customers/:id/consultations`.
 *
 * See CONSULTATION_PLAN.md. Mounted on `/api/customers` beside the other
 * record sections, and BEFORE `routes/customers.js`, which owns `/:id`.
 *
 * WHAT THIS DOES NOT DO, DELIBERATELY (§36):
 * nothing here creates a Condition, an Allergy, a Medication or a Vitals
 * reading as a side effect of documenting a consultation, and nothing decides
 * a referral from symptoms. A blood pressure taken during a consultation is
 * recorded through the Vitals module; a diagnosis becomes a Condition only
 * when a pharmacist writes it down in Conditions.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  consultationDefinitions, listConsultations, getConsultation,
  startConsultation, updateConsultation, completeConsultation, markEnteredInError,
  addProblem, updateProblem, removeProblem,
  addIntervention, removeIntervention,
  setReferral, setPrescriptionReview, setCareProgram,
  amendConsultation, consultationHistory,
} = require('../services/clinical/consultations');
const {
  readConsultationInput, readConsultationPatch, readErrorInput, consultationOptions,
  readProblemInput, readInterventionInput, readReferralInput, readPrescriptionInput,
  readAmendmentInput,
} = require('../services/clinical/consultationInput');
const { medicationContext } = require('../services/clinical/medications');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function customerId(req) {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) {
    const err = new Error('That is not a patient id.');
    err.status = 400;
    err.code = 'INVALID_ID';
    throw err;
  }
  return id;
}

/**
 * Who is doing this, and in what role.
 *
 * `actorRole` drives the finalisation gate (§33): anyone may open a
 * consultation and write a draft, only a pharmacist or the owner may finalise
 * it or mark it entered in error. The all-zeros id DEV_AUTH_BYPASS supplies is
 * not a real auth.users row, so it becomes null rather than a foreign key
 * violation — the same shape routes/followups.js uses.
 */
function actor(req) {
  const user = req.user?.id;
  return {
    actorId: user && user !== '00000000-0000-0000-0000-000000000000' ? user : null,
    actorRole: req.pharmacyRole || null,
  };
}

// The types, the reason list, the findings and what this phase cannot do.
router.get('/:id/consultations/options', requireAuth, async (req, res, next) => {
  try {
    const types = await consultationDefinitions(req.pharmacyId);
    res.json(consultationOptions(types));
  } catch (err) { next(err); }
});

router.get('/:id/consultations', requireAuth, async (req, res, next) => {
  try {
    res.json(await listConsultations(req.pharmacyId, customerId(req), {
      type: req.query.type || null,
      status: req.query.status || null,
    }));
  } catch (err) { next(err); }
});

// Registered BEFORE /:consultationId, which would otherwise match "context"
// as a consultation id — the same reason /options is first. Express tries
// routes in order, so a literal path has to precede the parameter that
// would swallow it.
/**
 * §5, §9 and §10 — the patient's existing records, READ.
 *
 * This is `medicationContext`, unchanged and unrenamed: it already assembles
 * conditions, allergies, the last vitals, recent tests, care programmes and
 * follow-ups, and the Medications screen has used it since 0055. A second
 * assembler here would be a second answer to "what does this patient have on
 * record", which §3 exists to prevent. The name is about where it was first
 * needed, not about what it knows.
 *
 * Read-only by construction — nothing in it writes, and the consultation
 * screen links into each section rather than editing from the header (§5).
 */
router.get('/:id/consultations/context', requireAuth, async (req, res, next) => {
  try {
    res.json(await medicationContext(req.pharmacyId, customerId(req)));
  } catch (err) { next(err); }
});

router.get('/:id/consultations/:consultationId', requireAuth, async (req, res, next) => {
  try {
    const found = await getConsultation(req.pharmacyId, customerId(req), req.params.consultationId);
    if (!found) return res.status(404).json({ error: 'Consultation not found.', code: 'NOT_FOUND' });
    res.json(found);
  } catch (err) { next(err); }
});

router.post('/:id/consultations', requireAuth, async (req, res, next) => {
  try {
    const types = await consultationDefinitions(req.pharmacyId);
    const input = readConsultationInput(req.body, types);
    res.status(201).json(await startConsultation(
      req.pharmacyId, customerId(req), input, actor(req),
    ));
  } catch (err) { next(err); }
});

// Saving a draft. A finalised note is refused with 409 rather than quietly
// edited — §32 wants a correction mechanism, which is phase 3.
router.patch('/:id/consultations/:consultationId', requireAuth, async (req, res, next) => {
  try {
    const patch = readConsultationPatch(req.body);
    res.json(await updateConsultation(
      req.pharmacyId, customerId(req), req.params.consultationId, patch, actor(req),
    ));
  } catch (err) { next(err); }
});

// Finalising. Two gates: who may (role) and what the type requires (§23).
router.post('/:id/consultations/:consultationId/completion', requireAuth, async (req, res, next) => {
  try {
    res.json(await completeConsultation(
      req.pharmacyId, customerId(req), req.params.consultationId, actor(req),
    ));
  } catch (err) { next(err); }
});

// Retiring a note that should never have existed. NOT a delete (§39).
router.post('/:id/consultations/:consultationId/error', requireAuth, async (req, res, next) => {
  try {
    const input = readErrorInput(req.body);
    res.json(await markEnteredInError(
      req.pharmacyId, customerId(req), req.params.consultationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

// ---- §12 the problem list -------------------------------------------------

router.post('/:id/consultations/:consultationId/problems', requireAuth, async (req, res, next) => {
  try {
    const input = readProblemInput(req.body);
    res.status(201).json(await addProblem(
      req.pharmacyId, customerId(req), req.params.consultationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

router.put('/:id/consultations/:consultationId/problems/:problemId', requireAuth, async (req, res, next) => {
  try {
    const input = readProblemInput(req.body);
    res.json(await updateProblem(
      req.pharmacyId, customerId(req), req.params.consultationId, req.params.problemId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

router.delete('/:id/consultations/:consultationId/problems/:problemId', requireAuth, async (req, res, next) => {
  try {
    res.json(await removeProblem(
      req.pharmacyId, customerId(req), req.params.consultationId, req.params.problemId, actor(req),
    ));
  } catch (err) { next(err); }
});

// ---- §14 what the pharmacist did ------------------------------------------

router.post('/:id/consultations/:consultationId/interventions', requireAuth, async (req, res, next) => {
  try {
    const input = readInterventionInput(req.body);
    res.status(201).json(await addIntervention(
      req.pharmacyId, customerId(req), req.params.consultationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

router.delete('/:id/consultations/:consultationId/interventions/:interventionId', requireAuth, async (req, res, next) => {
  try {
    res.json(await removeIntervention(
      req.pharmacyId, customerId(req), req.params.consultationId, req.params.interventionId, actor(req),
    ));
  } catch (err) { next(err); }
});

// ---- §17 referral ---------------------------------------------------------
//
// The PHARMACIST decides. §17 says a referral must not be inferred from
// symptoms without a validated clinical rule, and this product has none — so
// nothing reads the assessment and suggests anything here.
router.put('/:id/consultations/:consultationId/referral', requireAuth, async (req, res, next) => {
  try {
    const input = readReferralInput(req.body);
    res.json(await setReferral(
      req.pharmacyId, customerId(req), req.params.consultationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

// ---- §16 prescription review ----------------------------------------------
router.put('/:id/consultations/:consultationId/prescription', requireAuth, async (req, res, next) => {
  try {
    const input = readPrescriptionInput(req.body);
    res.json(await setPrescriptionReview(
      req.pharmacyId, customerId(req), req.params.consultationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

// ---- §21 the care programme this belongs to -------------------------------
//
// A pointer. Nothing here enrols anybody or changes a programme's plan.
router.put('/:id/consultations/:consultationId/care-program', requireAuth, async (req, res, next) => {
  try {
    const id = req.body?.careProgramId || null;
    res.json(await setCareProgram(
      req.pharmacyId, customerId(req), req.params.consultationId, id, actor(req),
    ));
  } catch (err) { next(err); }
});

// ---- §32 amendment and the audit view -------------------------------------
//
// Both are phase 3. Neither is a delete: a finalised note is reopened with a
// reason and its previous text snapshotted, and the history says what
// happened to the note and what it used to say.

router.post('/:id/consultations/:consultationId/amendment', requireAuth, async (req, res, next) => {
  try {
    const input = readAmendmentInput(req.body);
    res.json(await amendConsultation(
      req.pharmacyId, customerId(req), req.params.consultationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

router.get('/:id/consultations/:consultationId/history', requireAuth, async (req, res, next) => {
  try {
    res.json(await consultationHistory(
      req.pharmacyId, customerId(req), req.params.consultationId,
    ));
  } catch (err) { next(err); }
});

module.exports = router;
