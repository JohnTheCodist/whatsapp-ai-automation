/**
 * /api/whatsapp/cloud — the Meta App Review harness.
 *
 * Owner-only, every route. These send real WhatsApp messages from RxNaija's
 * Meta test number to whatever number is typed in, and submit templates to a
 * real WhatsApp Business Account — both are an owner's decision, never a
 * staff member's. Authentication and role are the application's own
 * middleware; nothing here invents a second auth scheme.
 *
 * Mounted BEFORE /api/whatsapp in index.js, so the Baileys router — which this
 * does not touch — can never shadow a path here.
 *
 * Responses are `{ success, ... }` throughout, with an HTTP status to match.
 * The service returns ready-made safe errors; this file adds nothing to them
 * and in particular never forwards a Graph API body.
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const review = require('../services/whatsapp/metaCloudReview');

const router = express.Router();

/** The service result, minus its internal status field. */
function send(res, result) {
  const { status, ...payload } = result;
  res.status(status || (result.success ? 200 : 500)).json(payload);
}

// Which capabilities are configured — so the screen can say so before the
// owner types anything. Booleans and a version string only.
router.get('/status', requireAuth, requireRole('owner'), (req, res) => {
  res.json(review.publicStatus());
});

// Two kinds of message, one endpoint. The screen has one recipient field and
// one button; splitting this in two would mean the client picking a URL from
// a radio button. Anything other than 'template' is a plain text send, so an
// older client that sends no `kind` behaves exactly as it did.
router.post('/test-send', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  const result = req.body?.kind === 'template'
    ? await review.sendTemplateMessage({
      to: req.body?.to, templateName: req.body?.templateName, language: req.body?.language,
    })
    : await review.sendTestMessage({ to: req.body?.to, message: req.body?.message });
  send(res, result);
}));

router.get('/templates', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  send(res, await review.listTemplates());
}));

router.post('/templates', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  send(res, await review.createTemplate({
    name: req.body?.name,
    category: req.body?.category,
    language: req.body?.language,
    body: req.body?.body,
  }));
}));

module.exports = router;
