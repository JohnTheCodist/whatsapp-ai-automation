/**
 * Customer/patient list — deliverable #7 of the identity segment.
 *
 * Deliberately minimal: name, phone, status, communication status, and how
 * long since they were last heard from. No analytics, no segmentation, no
 * medication history — those are explicitly later segments. This exists so
 * a pharmacist can see that automatic identity resolution is actually
 * producing one durable customer per real person, not to be a CRM screen.
 *
 * Activity tier is computed at request time via customerActivity.js, never
 * stored — see migration 0015/0016 for why a dormancy label must not be
 * something a background job silently writes into the customer row.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { classifyActivity } = require('../services/customers/customerActivity');
const { getCustomerProfile } = require('../services/customers/customerProfile');
const { listTimeline } = require('../services/customers/customerTimeline');
const crm = require('../services/customers/customerCrm');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const search = (req.query.q || '').trim();

    const rows = search
      ? await db`
          select id, wa_phone, wa_jid, display_name, status, communication_status,
                 first_seen_at, last_seen_at
          from customers
          where pharmacy_id = ${req.pharmacyId}
            and (display_name ilike ${'%' + search + '%'} or wa_phone ilike ${'%' + search + '%'})
          order by last_seen_at desc
          limit ${limit}
        `
      : await db`
          select id, wa_phone, wa_jid, display_name, status, communication_status,
                 first_seen_at, last_seen_at
          from customers
          where pharmacy_id = ${req.pharmacyId}
          order by last_seen_at desc
          limit ${limit}
        `;

    const [counts] = await db`
      select count(*)::int as total,
             count(*) filter (where communication_status = 'opted_out')::int as opted_out,
             count(*) filter (where status = 'blocked')::int as blocked
      from customers where pharmacy_id = ${req.pharmacyId}
    `;

    // Count patients with DIABETES condition confirmed by purchase
    const [conditionCounts] = await db`
      select count(distinct customer_id)::int as diabetic_patients
      from patient_condition
      where pharmacy_id = ${req.pharmacyId}
        and condition_code = 'DIABETES'
        and status = 'CONFIRMED_BY_PURCHASE'
    `;

    const finalCounts = {
      ...counts,
      diabetic_patients: conditionCounts?.diabetic_patients || 0,
    };

    res.json({
      counts: finalCounts,
      customers: rows.map((c) => ({
        ...c,
        activity: classifyActivity(c.last_seen_at),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/:id — Customer 360. Logic lives in
 * services/customers/customerProfile.js, tested directly against real
 * Postgres — see server/tests/customerProfile.test.js, in particular the
 * tenant-isolation case.
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const profile = await getCustomerProfile(req.pharmacyId, req.params.id);
    if (!profile) return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/:id/timeline — paginated activity stream.
 *
 * Same tenant-isolation shape as the profile route: listTimeline scopes by
 * pharmacy_id itself and returns null for a customer that does not belong
 * to this pharmacy, so there is nothing here for a later edit to forget.
 *
 * Query params: limit (default 30, max 100), cursor (opaque, from a
 * previous response's nextCursor), event_type (a category name — orders,
 * messages, pharmacist, system — or all, or one exact event type).
 */
router.get('/:id/timeline', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const result = await listTimeline(req.pharmacyId, req.params.id, {
      limit: req.query.limit,
      cursor: req.query.cursor || null,
      eventType: req.query.event_type || null,
    });
    if (!result) return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Internal CRM — staff only
// ---------------------------------------------------------------------------
//
// These routes serve data the customer must never see. They sit under
// requireAuth like everything else here, and every service call scopes on
// req.pharmacyId — which comes from the verified session, never the URL.
//
// There is deliberately no route that returns notes or tags alongside
// conversation data. Keeping the CRM read path separate from anything the
// assistant touches is what makes the boundary structural rather than a rule
// someone has to remember (see crmBoundary.test.js).

/** The user id to attribute an action to, or null under DEV_AUTH_BYPASS. */
function actorId(req) {
  const id = req.user?.id;
  return id && id !== '00000000-0000-0000-0000-000000000000' ? id : null;
}

router.get('/:id/notes', requireAuth, async (req, res, next) => {
  try {
    res.json({ notes: await crm.listNotes(req.pharmacyId, req.params.id) });
  } catch (err) { next(err); }
});

router.post('/:id/notes', requireAuth, async (req, res, next) => {
  try {
    const note = await crm.addNote(req.pharmacyId, req.params.id, {
      content: req.body?.content,
      authorId: actorId(req),
    });
    res.status(201).json({ note });
  } catch (err) { next(err); }
});

router.patch('/:id/notes/:noteId', requireAuth, async (req, res, next) => {
  try {
    const note = await crm.updateNote(req.pharmacyId, req.params.id, req.params.noteId, {
      content: req.body?.content,
      authorId: actorId(req),
    });
    res.json({ note });
  } catch (err) { next(err); }
});

router.delete('/:id/notes/:noteId', requireAuth, async (req, res, next) => {
  try {
    res.json(await crm.deleteNote(req.pharmacyId, req.params.id, req.params.noteId, {
      authorId: actorId(req),
    }));
  } catch (err) { next(err); }
});

/** Every tag this pharmacy can apply — the picker's options. */
router.get('/tags/all', requireAuth, async (req, res, next) => {
  try {
    res.json({ tags: await crm.listTags(req.pharmacyId) });
  } catch (err) { next(err); }
});

router.get('/:id/tags', requireAuth, async (req, res, next) => {
  try {
    res.json({ tags: await crm.listCustomerTags(req.pharmacyId, req.params.id) });
  } catch (err) { next(err); }
});

router.post('/:id/tags', requireAuth, async (req, res, next) => {
  try {
    const { tagId } = req.body || {};
    if (!tagId) return res.status(400).json({ error: 'tagId is required.', code: 'NO_TAG' });
    res.json(await crm.addTag(req.pharmacyId, req.params.id, tagId, { authorId: actorId(req) }));
  } catch (err) { next(err); }
});

router.delete('/:id/tags/:tagId', requireAuth, async (req, res, next) => {
  try {
    res.json(await crm.removeTag(req.pharmacyId, req.params.id, req.params.tagId, {
      authorId: actorId(req),
    }));
  } catch (err) { next(err); }
});

module.exports = router;
