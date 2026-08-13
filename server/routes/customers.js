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

    res.json({
      counts,
      customers: rows.map((c) => ({
        ...c,
        activity: classifyActivity(c.last_seen_at),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
