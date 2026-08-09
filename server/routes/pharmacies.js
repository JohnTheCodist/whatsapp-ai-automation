/**
 * Pharmacy (tenant) routes.
 *
 * Every route below except POST / operates on req.pharmacyId, which
 * requireAuth resolved from a verified session. No route reads a tenant id
 * from the body, the path, or a query param — the URLs say "me" rather
 * than taking an :id precisely so there is no id in the path that someone
 * could later be tempted to trust.
 */

const express = require('express');
const { requireAuth, requireAuthOnly, requireRole } = require('../middleware/auth');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const pharmacies = require('../services/pharmacies');

const router = express.Router();

/**
 * POST /api/pharmacies — create a tenant, caller becomes owner.
 *
 * requireAuthOnly, not requireAuth: a brand-new user has no membership
 * yet, and demanding one here would make the first pharmacy impossible to
 * create. This is the only route in the application allowed to run
 * without a tenant context.
 */
router.post('/', requireAuthOnly, asyncRoute(async (req, res) => {
  const pharmacy = await pharmacies.createPharmacy(req.user.id, { name: req.body?.name });
  res.status(201).json({ pharmacy });
}));

/** GET /api/pharmacies/me — the tenant this session is acting on. */
router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const pharmacy = await pharmacies.getPharmacy(req.pharmacyId);
  if (!pharmacy) throw new HttpError(404, 'Pharmacy not found', 'NOT_FOUND');
  res.json({
    pharmacy,
    role: req.pharmacyRole,
    // Lets a future switcher exist without another round trip. Only ever
    // the caller's own memberships.
    memberships: req.memberships.map((m) => ({
      pharmacy_id: m.pharmacy_id,
      name: m.name,
      role: m.role,
      status: m.status,
    })),
  });
}));

/** PATCH /api/pharmacies/me — rename. Owner only: it's the public identity. */
router.patch('/me', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  const pharmacy = await pharmacies.updatePharmacy(req.pharmacyId, { name: req.body?.name });
  if (!pharmacy) throw new HttpError(404, 'Pharmacy not found', 'NOT_FOUND');
  res.json({ pharmacy });
}));

/**
 * GET /api/pharmacies/me/profile — the facts the assistant may state.
 *
 * The profile row is created with the tenant, so a missing row here means
 * data corruption, not a normal empty state. Say so rather than papering
 * over it with an empty object.
 */
router.get('/me/profile', requireAuth, asyncRoute(async (req, res) => {
  const profile = await pharmacies.getProfile(req.pharmacyId);
  if (!profile) throw new HttpError(404, 'Profile not found', 'NOT_FOUND');
  res.json({ profile });
}));

/** PATCH /api/pharmacies/me/profile — partial update. Staff cannot edit. */
router.patch('/me/profile', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'Request body must be an object', 'INVALID_BODY');
  }
  const profile = await pharmacies.updateProfile(req.pharmacyId, req.body);
  if (!profile) throw new HttpError(404, 'Profile not found', 'NOT_FOUND');
  res.json({ profile });
}));

/** GET /api/pharmacies/me/members — who can act on this tenant. */
router.get('/me/members', requireAuth, asyncRoute(async (req, res) => {
  const members = await pharmacies.listMembers(req.pharmacyId);
  res.json({ members });
}));

module.exports = router;
