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
const { generateWelcomeNote } = require('../services/ai/welcomeNoteGenerator');
const { LlmUnavailable } = require('../services/ai/llmClient');
const { buildMenu } = require('../services/ai/menu');

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

/**
 * PATCH /api/pharmacies/me/assistant — bot name, welcome note, menu on/off.
 *
 * Separate from PATCH /me: the registered pharmacy name is a tenant fact
 * with its own rules (slug retry, a 2-character minimum); this is
 * presentation the owner can change or clear freely, including back to
 * "use the pharmacy name".
 */
router.patch('/me/assistant', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new HttpError(400, 'Request body must be an object', 'INVALID_BODY');
  }
  const pharmacy = await pharmacies.updateAssistantSettings(req.pharmacyId, req.body);
  if (!pharmacy) throw new HttpError(404, 'Pharmacy not found', 'NOT_FOUND');
  res.json({ pharmacy });
}));

/**
 * POST /api/pharmacies/me/assistant/welcome-note/generate — draft one line.
 *
 * Returns a DRAFT. It does not save anything — the owner reads it, edits it
 * if they want, and PATCHes /me/assistant themselves. Auto-writing something
 * an owner never approved into a field customers will see is not a shortcut
 * worth taking.
 */
router.post('/me/assistant/welcome-note/generate', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const [pharmacy, profile] = await Promise.all([
    pharmacies.getPharmacy(req.pharmacyId),
    pharmacies.getProfile(req.pharmacyId),
  ]);
  if (!pharmacy) throw new HttpError(404, 'Pharmacy not found', 'NOT_FOUND');

  try {
    const note = await generateWelcomeNote({
      pharmacyName: pharmacy.name,
      botName: req.body?.botName || null,
      city: profile?.city || null,
      delivers: profile?.delivers ?? null,
      extraInfo: profile?.extra_info || null,
    });
    res.json({ note });
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      throw new HttpError(503, 'The assistant is not available right now, so a note could not be drafted. Try writing one directly, or try again shortly.', 'LLM_UNAVAILABLE');
    }
    throw err;
  }
}));

/**
 * POST /api/pharmacies/me/assistant/preview — the exact greeting a customer
 * would get, for whatever is currently in the settings form.
 *
 * Runs buildMenu() — the SAME function the worker calls for a real customer
 * — rather than a hand-copied approximation in the client. The alternative
 * is a settings screen that can silently drift from what the product
 * actually sends, discoverable only by a customer screenshotting a mismatch.
 * Nothing here is saved; it previews values the client hasn't submitted yet.
 */
router.post('/me/assistant/preview', requireAuth, asyncRoute(async (req, res) => {
  const pharmacyName = String(req.body?.pharmacyName || '').trim();
  if (!pharmacyName) throw new HttpError(400, 'pharmacyName is required to preview.', 'MISSING_NAME');

  const menuEnabled = req.body?.menuEnabled !== false;
  const text = menuEnabled
    ? buildMenu({
        pharmacyName,
        botName: req.body?.botName || null,
        welcomeNote: req.body?.welcomeNote || null,
        customerName: req.body?.sampleCustomerName || 'Chidi',
      })
    : `Hi ${req.body?.sampleCustomerName || 'Chidi'} — I'm ${req.body?.botName || pharmacyName} from ${pharmacyName}. How can I help?`;

  res.json({ text });
}));

/** GET /api/pharmacies/me/members — who can act on this tenant. */
router.get('/me/members', requireAuth, asyncRoute(async (req, res) => {
  const members = await pharmacies.listMembers(req.pharmacyId);
  res.json({ members });
}));

module.exports = router;
