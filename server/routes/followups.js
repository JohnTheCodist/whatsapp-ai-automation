/**
 * A patient's follow-ups — what needs to happen next.
 *
 *   GET    /api/customers/:id/followups?filter=      the queue, with counts
 *   GET    /api/customers/:id/followups/options      the vocabulary a form offers
 *   GET    /api/customers/:id/followups/sources      what this patient has to point at
 *   POST   /api/customers/:id/followups              create
 *   GET    /api/customers/:id/followups/:followupId  one, in full
 *   PATCH  /api/customers/:id/followups/:followupId  edit, or move its status
 *   POST   /api/customers/:id/followups/:followupId/completion   complete it
 *   POST   /api/customers/:id/followups/:followupId/reschedule   move it
 *   POST   /api/customers/:id/followups/:followupId/cancellation cancel it
 *   POST   /api/customers/:id/followups/:followupId/reopen       put it back
 *   GET    /api/customers/:id/followups/:followupId/timeline     THIS one's history
 *
 * THERE IS NO DELETE. A follow-up that will not happen is cancelled, with a
 * reason, and the row stays — deleting it would lose that it was ever needed,
 * which is what somebody asking "why was this never done" needs to see.
 *
 * COMPLETING, RESCHEDULING AND CANCELLING ARE THEIR OWN ROUTES, not status
 * patches: each is an act with something to record beyond a new value — an
 * outcome, the date it moved from, the reason it stopped.
 *
 * MOUNTED BEFORE routes/customers.js; fixed paths before `/:followupId`.
 * Thin by design: the contract is services/clinical/followupInput.js, the
 * queries and the role rule services/clinical/followups.js — both tested.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listFollowups, getFollowup, createFollowup, updateFollowup,
  completeFollowup, rescheduleFollowup, cancelFollowup, reopenFollowup, followupTimeline,
} = require('../services/clinical/followups');
const {
  readFollowupInput, readFollowupPatch, readCompletion, readReschedule,
  readCancellation, followupOptions,
} = require('../services/clinical/followupInput');
const { followupSources } = require('../services/clinical/followupSources');
// The ONE definition of a valid reading. A completion that records a blood
// pressure is checked by the same contract the Vitals screen uses.
const { readVitalsInput } = require('../services/clinical/vitalsInput');
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

router.get('/:id/followups/options', requireAuth, (req, res) => {
  res.json(followupOptions());
});

// What this patient already has that a follow-up can point at (§8, §9).
// Read-only, and every list is this patient's own.
router.get('/:id/followups/sources', requireAuth, async (req, res, next) => {
  try {
    res.json(await followupSources(req.pharmacyId, id(req.params.id, 'Patient')));
  } catch (err) { next(err); }
});

router.get('/:id/followups', requireAuth, async (req, res, next) => {
  try {
    res.json(await listFollowups(req.pharmacyId, id(req.params.id, 'Patient'), {
      filter: req.query.filter || null,
      today: lagosDate(),
    }));
  } catch (err) { next(err); }
});

router.post('/:id/followups', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const fields = readFollowupInput(req.body);
    res.status(201).json(await createFollowup(req.pharmacyId, patient, fields, actor(req)));
  } catch (err) { next(err); }
});

router.get('/:id/followups/:followupId', requireAuth, async (req, res, next) => {
  try {
    res.json(await getFollowup(
      req.pharmacyId,
      id(req.params.id, 'Patient'),
      id(req.params.followupId, 'Follow-up'),
      { today: lagosDate() },
    ));
  } catch (err) { next(err); }
});

router.patch('/:id/followups/:followupId', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const followup = id(req.params.followupId, 'Follow-up');
    const patch = readFollowupPatch(req.body);
    res.json(await updateFollowup(req.pharmacyId, patient, followup, patch, {
      ...actor(req), today: lagosDate(),
    }));
  } catch (err) { next(err); }
});

router.post('/:id/followups/:followupId/completion', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const followup = id(req.params.followupId, 'Follow-up');
    const today = lagosDate();
    const fields = readCompletion(req.body, { today });
    // A reading recorded here goes to Vitals, through the Vitals contract.
    if (req.body && req.body.reading) fields.reading = readVitalsInput(req.body.reading);
    res.json(await completeFollowup(req.pharmacyId, patient, followup, fields, { ...actor(req), today }));
  } catch (err) { next(err); }
});

router.post('/:id/followups/:followupId/reschedule', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const followup = id(req.params.followupId, 'Follow-up');
    const today = lagosDate();
    const fields = readReschedule(req.body, { today });
    res.json(await rescheduleFollowup(req.pharmacyId, patient, followup, fields, { ...actor(req), today }));
  } catch (err) { next(err); }
});

router.post('/:id/followups/:followupId/cancellation', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const followup = id(req.params.followupId, 'Follow-up');
    const fields = readCancellation(req.body);
    res.json(await cancelFollowup(req.pharmacyId, patient, followup, fields, {
      ...actor(req), today: lagosDate(),
    }));
  } catch (err) { next(err); }
});

router.post('/:id/followups/:followupId/reopen', requireAuth, async (req, res, next) => {
  try {
    const patient = id(req.params.id, 'Patient');
    const followup = id(req.params.followupId, 'Follow-up');
    res.json(await reopenFollowup(req.pharmacyId, patient, followup, { ...actor(req), today: lagosDate() }));
  } catch (err) { next(err); }
});

// THIS follow-up's history (§18, §29) — not the patient's, and not the other
// follow-ups': the queue's Completed and Cancelled groups already answer that.
router.get('/:id/followups/:followupId/timeline', requireAuth, async (req, res, next) => {
  try {
    res.json(await followupTimeline(
      req.pharmacyId,
      id(req.params.id, 'Patient'),
      id(req.params.followupId, 'Follow-up'),
      { limit: req.query.limit },
    ));
  } catch (err) { next(err); }
});

module.exports = router;
