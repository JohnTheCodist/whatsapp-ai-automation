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
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const {
  consultationDefinitions, listConsultations, getConsultation,
  startConsultation, updateConsultation, completeConsultation, markEnteredInError,
  addProblem, updateProblem, removeProblem,
  addIntervention, removeIntervention,
  setReferral, setPrescriptionReview, setCareProgram,
  amendConsultation, consultationHistory, consultationPatient,
  recordScribeConsent, scribeGate, recordScribeUse,
} = require('../services/clinical/consultations');
const {
  readConsultationInput, readConsultationPatch, readErrorInput, consultationOptions,
  readProblemInput, readInterventionInput, readReferralInput, readPrescriptionInput,
  readAmendmentInput,
} = require('../services/clinical/consultationInput');
const { medicationContext, listMedications } = require('../services/clinical/medications');
const { listen, scribeNote, isTranscriptionConfigured } = require('../services/ai/scribe');
const { LlmUnavailable } = require('../services/ai/llmClient');
const { readScribeDraftInput, SCRIBE_REFUSALS } = require('../services/ai/scribeInput');

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
    // Composed here rather than in `consultationOptions`, which is pure and
    // has no business reading the environment. An unconfigured deployment
    // says so and the screen shows no microphone at all — the scribe is an
    // addition to this module, never a dependency of it.
    res.json({
      ...consultationOptions(types),
      scribe: { available: isTranscriptionConfigured() },
    });
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
// §12 and §28 — everything the patient-context column shows, in one call.
//
// COMPOSED HERE rather than by widening `medicationContext`, which the
// Medications screen and the review also read: the banner needs a name and
// an age that no other caller wants, and a shared read that grows a key per
// screen is how it stops being obvious what any of them actually use.
router.get('/:id/consultations/context', requireAuth, async (req, res, next) => {
  try {
    const id = customerId(req);
    // `medicationContext` carries conditions, vitals, allergies, tests, care
    // programmes and follow-ups, but NOT the medication list — its own caller
    // already has that. §12 wants medicines on the banner, so they are read
    // here, through the Medications service that owns them.
    const [context, patient, meds] = await Promise.all([
      medicationContext(req.pharmacyId, id),
      consultationPatient(req.pharmacyId, id),
      listMedications(req.pharmacyId, id, { status: 'current' }),
    ]);
    res.json({ ...context, patient, medications: meds.medications || [] });
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

/* ==========================================================================
 * The AI scribe (SCRIBE_PLAN.md)
 *
 * THREE REQUESTS, NOT ONE, and the split is the safety design rather than
 * REST tidiness:
 *
 *   1. consent    the patient is told, and that is written down
 *   2. listen     audio in, speaker-separated turns out, NOTHING drafted
 *   3. draft      the pharmacist has said which voice is the patient
 *
 * Step 2 stops short on purpose. The one question a model must not answer is
 * WHICH VOICE IS THE PATIENT, because its answer lands in a clinical record
 * as "the patient reported". A person answers it, in one tap, between the
 * two requests.
 *
 * NOTHING HERE WRITES TO THE NOTE. The draft comes back to the screen and
 * the pharmacist accepts it through the ordinary PATCH, as if they had typed
 * it — so the note has exactly one writer and a draft nobody accepted leaves
 * no trace in the record.
 * ======================================================================== */

/**
 * In memory, like the catalogue upload, and for a stronger reason: a patient
 * recording on this box's disk is a copy of health data that nothing in this
 * product knows how to delete.
 */
const AUDIO_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/mpga',
  'audio/wav', 'audio/x-wav', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  'video/webm', 'video/mp4',
]);

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  // The same cap `scribe.js` enforces. Checked twice on purpose: this one
  // stops a large body at the door, and the service one holds for any caller
  // that is not this route.
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // A browser MediaRecorder sends a codec suffix: audio/webm;codecs=opus.
    const base = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(base)) {
      return cb(new Error(`${file.mimetype} is not a recording this can transcribe.`));
    }
    cb(null, true);
  },
}).single('audio');

/** Multer reports its own errors; turn them into something a person can act on. */
function handleAudio(req, res, next) {
  uploadAudio(req, res, (err) => {
    if (!err) return next();
    const e = new Error(err.code === 'LIMIT_FILE_SIZE'
      ? 'That recording is too long to transcribe.'
      : err.message);
    e.status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    e.code = 'BAD_AUDIO';
    next(e);
  });
}

/**
 * Turn the gate into something the screen can say out loud.
 *
 * Each refusal gets its own sentence, because "cannot record" tells a
 * pharmacist nothing about what to do next and the three reasons have three
 * different answers: ask the patient, open a new consultation, or nothing.
 */
/**
 * A provider that is down is NOT an internal error.
 *
 * FOUND BY DRIVING THE ENDPOINT, not by a test. `LlmUnavailable` carries no
 * `status`, so an unreachable transcription provider came back as a 500
 * "Something went wrong" — which tells a pharmacist at a counter nothing,
 * and in particular does not tell them the thing that is true: the
 * microphone is no use right now and the note has to be typed.
 *
 * Degrading to typing is the whole design of this feature, so the sentence
 * says so. Same shape as `routes/pharmacies.js` and `routes/website.js`,
 * which reached this conclusion first.
 */
function refuseUnavailable(err) {
  if (!(err instanceof LlmUnavailable)) return err;
  const e = new Error(
    'Voice transcription is not available right now. Type the note instead, or try again shortly.',
  );
  e.status = 503;
  e.code = 'LLM_UNAVAILABLE';
  // The sentence above is ours and is the actionable half of this reply, so
  // it is marked for the user. Without this, errorHandler masks every 5xx
  // message and a pharmacist is told only that something went wrong.
  e.expose = true;
  return e;
}

function refuseScribe(gate) {
  const err = new Error(SCRIBE_REFUSALS[gate.reason] || SCRIBE_REFUSALS.no_consent);
  err.status = gate.reason === 'not_found' ? 404 : 409;
  err.code = gate.reason === 'not_found' ? 'NOT_FOUND' : gate.reason.toUpperCase();
  return err;
}

// §7. The patient was told. Recorded before any microphone may open.
router.post('/:id/consultations/:consultationId/scribe/consent', requireAuth, async (req, res, next) => {
  try {
    res.json(await recordScribeConsent(
      req.pharmacyId, customerId(req), req.params.consultationId, actor(req),
    ));
  } catch (err) { next(err); }
});

// Audio in, turns out. Nothing is drafted here and nothing is saved.
router.post('/:id/consultations/:consultationId/scribe', requireAuth, handleAudio,
  async (req, res, next) => {
    try {
      if (!isTranscriptionConfigured()) {
        const err = new Error('Voice transcription is not set up for this pharmacy.');
        err.status = 503; err.code = 'SCRIBE_UNAVAILABLE';
        throw err;
      }

      const patient = customerId(req);
      const id = req.params.consultationId;

      // READ NOW, not trusted from the screen. A tab open for an hour holds
      // a consultation that may since have been finalised, and a consent
      // flag in client state is a gate the client can decline to send.
      const gate = await scribeGate(req.pharmacyId, patient, id);
      if (!gate.allowed) throw refuseScribe(gate);

      let parsed;
      try {
        parsed = await listen(req.file?.buffer, { mimetype: req.file?.mimetype });
      } catch (e) {
        throw refuseUnavailable(e);
      }

      // On the record BEFORE the draft step, and whatever the pharmacist
      // does with it. "Was this patient recorded?" has to be answerable even
      // when the answer was thrown away.
      await recordScribeUse(req.pharmacyId, patient, id, {
        speakers: parsed.speakers.length,
        diarised: parsed.diarised,
        turns: parsed.turns.length,
      }, actor(req));

      // The turns and who spoke them. NOT a draft — that waits for a person
      // to say which voice is the patient.
      res.json({
        turns: parsed.turns,
        speakers: parsed.speakers,
        diarised: parsed.diarised,
      });
    } catch (err) { next(err); }
  });

// The pharmacist has named the patient. Draft from THAT VOICE only.
router.post('/:id/consultations/:consultationId/scribe/draft', requireAuth,
  async (req, res, next) => {
    try {
      const patient = customerId(req);
      const id = req.params.consultationId;

      const gate = await scribeGate(req.pharmacyId, patient, id);
      if (!gate.allowed) throw refuseScribe(gate);

      const input = readScribeDraftInput(req.body);
      let result;
      try {
        result = await scribeNote(input.parsed, {
          patientSpeaker: input.patientSpeaker,
          pharmacistSpeaker: input.pharmacistSpeaker,
        });
      } catch (e) {
        throw refuseUnavailable(e);
      }

      // The draft is RETURNED, never written. The pharmacist accepts it
      // through the ordinary PATCH or discards it, and a draft nobody
      // accepted leaves nothing behind.
      // FOUR SECTIONS, each already grounded in the voice that owns it, and
      // each with its own refusal. A note where the assessment was thrown
      // away but the subjective survived is the normal case, not an error —
      // the screen shows what came back and says why the rest did not.
      res.json({
        sections: {
          subjective: result.subjective,
          objective: result.objective,
          assessment: result.assessment,
          plan: result.plan,
        },
        refused: result.refused,
      });
    } catch (err) { next(err); }
  });

module.exports = router;
