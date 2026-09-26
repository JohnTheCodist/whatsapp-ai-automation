/**
 * A patient's care programmes.
 *
 *   GET    /api/customers/:id/care-programs                    the list, with progress
 *   GET    /api/customers/:id/care-programs/options            the vocabulary a form offers
 *   GET    /api/customers/:id/care-programs/catalogue          the templates
 *   GET    /api/customers/:id/care-programs/plan?definitionId=  a template, expanded
 *   POST   /api/customers/:id/care-programs                    enrol
 *   GET    /api/customers/:id/care-programs/:programId         one programme, in full
 *   PATCH  /api/customers/:id/care-programs/:programId         edit, or change its status
 *   POST   /api/customers/:id/care-programs/:programId/goals
 *   PATCH  /api/customers/:id/care-programs/:programId/goals/:goalId
 *   DELETE /api/customers/:id/care-programs/:programId/goals/:goalId
 *   POST   /api/customers/:id/care-programs/:programId/activities
 *   PATCH  /api/customers/:id/care-programs/:programId/activities/:activityId
 *   DELETE /api/customers/:id/care-programs/:programId/activities/:activityId
 *   GET    /api/customers/:id/care-programs/:programId/monitoring   read from Vitals and Tests
 *   GET    /api/customers/:id/care-programs/:programId/related      links + records sharing its code
 *   POST   /api/customers/:id/care-programs/:programId/links        attach an existing record
 *   DELETE /api/customers/:id/care-programs/:programId/links/:linkId
 *   GET    /api/customers/:id/care-programs/:programId/timeline     THIS programme's history
 *
 * THERE IS NO DELETE FOR A PROGRAMME. One enrolled by mistake is cancelled,
 * with a reason; one that ended is completed or discontinued, with an outcome.
 * The row stays either way — that is what makes it a record.
 *
 * Goals and tasks CAN be deleted, while the plan is being written: nothing
 * clinical is stored on them. A task already done cannot — the service refuses
 * and the screen offers "cancelled", which keeps what happened.
 *
 * MOUNTED BEFORE routes/customers.js; fixed paths before `/:programId`.
 * Thin by design: the contract is services/clinical/careProgramInput.js, the
 * queries and the role rule services/clinical/carePrograms.js — both tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  careProgramCatalogue, planForDefinition, listPrograms, getProgram, enrolProgram,
  updateProgram, addGoal, updateGoal, removeGoal, addActivity, updateActivity, removeActivity,
  programMonitoring, programRelated, addLink, removeLink, programTimeline,
} = require('../services/clinical/carePrograms');
const {
  readProgramInput, readProgramPatch, readGoalInput, readGoalPatch,
  readActivityInput, readActivityPatch, readLinkInput, careProgramOptions,
} = require('../services/clinical/careProgramInput');
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

router.get('/:id/care-programs/options', requireAuth, (req, res) => {
  res.json(careProgramOptions());
});

router.get('/:id/care-programs/catalogue', requireAuth, async (req, res, next) => {
  try {
    id(req.params.id, 'Patient');
    res.json({ programs: await careProgramCatalogue(req.pharmacyId) });
  } catch (err) { next(err); }
});

// What enrolling in this template WOULD create, so the pharmacist sees the
// goals and tasks before saving rather than after (the plan, question 1).
router.get('/:id/care-programs/plan', requireAuth, async (req, res, next) => {
  try {
    id(req.params.id, 'Patient');
    const definitionId = id(req.query.definitionId, 'Care programme template');
    res.json(await planForDefinition(req.pharmacyId, definitionId, {
      today: lagosDate(),
      startDate: req.query.startDate || null,
    }));
  } catch (err) { next(err); }
});

router.get('/:id/care-programs', requireAuth, async (req, res, next) => {
  try {
    res.json(await listPrograms(req.pharmacyId, id(req.params.id, 'Patient'), { today: lagosDate() }));
  } catch (err) { next(err); }
});

router.post('/:id/care-programs', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const today = lagosDate();
    // A template is read from the database FIRST, so the name, code and
    // condition stored are the catalogue's and not the client's claim about it.
    let definition = null;
    let plan = null;
    if (req.body && req.body.definitionId) {
      const expanded = await planForDefinition(req.pharmacyId, id(req.body.definitionId, 'Care programme template'), {
        today,
        startDate: req.body.startDate || null,
      });
      definition = expanded.definition;
      // The screen may have edited the plan before saving. What it sends wins;
      // what the template said is the default.
      plan = req.body.plan
        ? {
          goals: (req.body.plan.goals || []).map((g, i) => readGoalInput({ position: i, ...g }, { today })),
          activities: (req.body.plan.activities || []).map((a, i) => ({
            ...readActivityInput({ position: i, ...a }),
            goalIndex: Number.isInteger(a.goalIndex) ? a.goalIndex : null,
          })),
        }
        : expanded.plan;
    }
    const fields = readProgramInput(req.body, { today, definition });
    res.status(201).json(await enrolProgram(req.pharmacyId, patient, fields, { plan, ...actor(req) }));
  } catch (err) { next(err); }
});

router.get('/:id/care-programs/:programId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getProgram(
      req.pharmacyId,
      id(req.params.id, 'Patient'),
      id(req.params.programId, 'Care programme'),
      { today: lagosDate() },
    ));
  } catch (err) { next(err); }
});

router.patch('/:id/care-programs/:programId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const patch = readProgramPatch(req.body);
    res.json(await updateProgram(req.pharmacyId, patient, program, patch, {
      ...actor(req), today: lagosDate(),
    }));
  } catch (err) { next(err); }
});

router.post('/:id/care-programs/:programId/goals', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const fields = readGoalInput(req.body, { today: lagosDate() });
    res.status(201).json(await addGoal(req.pharmacyId, patient, program, fields, actor(req)));
  } catch (err) { next(err); }
});

router.patch('/:id/care-programs/:programId/goals/:goalId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const goal = id(req.params.goalId, 'Goal');
    const patch = readGoalPatch(req.body);
    res.json(await updateGoal(req.pharmacyId, patient, program, goal, patch, {
      ...actor(req), today: lagosDate(),
    }));
  } catch (err) { next(err); }
});

router.delete('/:id/care-programs/:programId/goals/:goalId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const goal = id(req.params.goalId, 'Goal');
    res.json(await removeGoal(req.pharmacyId, patient, program, goal, actor(req)));
  } catch (err) { next(err); }
});

router.post('/:id/care-programs/:programId/activities', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const fields = readActivityInput(req.body);
    res.status(201).json(await addActivity(req.pharmacyId, patient, program, fields, actor(req)));
  } catch (err) { next(err); }
});

router.patch('/:id/care-programs/:programId/activities/:activityId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const activity = id(req.params.activityId, 'Task');
    const patch = readActivityPatch(req.body);
    res.json(await updateActivity(req.pharmacyId, patient, program, activity, patch, {
      ...actor(req), today: lagosDate(),
    }));
  } catch (err) { next(err); }
});

router.delete('/:id/care-programs/:programId/activities/:activityId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const activity = id(req.params.activityId, 'Task');
    res.json(await removeActivity(req.pharmacyId, patient, program, activity, actor(req)));
  } catch (err) { next(err); }
});

// ---- the connections: read-only, except for attaching a record -------------

router.get('/:id/care-programs/:programId/monitoring', requireAuth, async (req, res, next) => {
  try {
    res.json(await programMonitoring(
      req.pharmacyId,
      id(req.params.id, 'Patient'),
      id(req.params.programId, 'Care programme'),
      { limit: req.query.limit },
    ));
  } catch (err) { next(err); }
});

router.get('/:id/care-programs/:programId/related', requireAuth, async (req, res, next) => {
  try {
    res.json(await programRelated(
      req.pharmacyId,
      id(req.params.id, 'Patient'),
      id(req.params.programId, 'Care programme'),
    ));
  } catch (err) { next(err); }
});

router.post('/:id/care-programs/:programId/links', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const fields = readLinkInput(req.body);
    res.status(201).json(await addLink(req.pharmacyId, patient, program, fields, actor(req)));
  } catch (err) { next(err); }
});

router.delete('/:id/care-programs/:programId/links/:linkId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const program = id(req.params.programId, 'Care programme');
    const link = id(req.params.linkId, 'Attached record');
    res.json(await removeLink(req.pharmacyId, patient, program, link, actor(req)));
  } catch (err) { next(err); }
});

// THIS programme's history, not the patient's — the patient's whole timeline
// is its own screen.
router.get('/:id/care-programs/:programId/timeline', requireAuth, async (req, res, next) => {
  try {
    res.json(await programTimeline(
      req.pharmacyId,
      id(req.params.id, 'Patient'),
      id(req.params.programId, 'Care programme'),
      { limit: req.query.limit },
    ));
  } catch (err) { next(err); }
});

module.exports = router;
