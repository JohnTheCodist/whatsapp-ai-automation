/**
 * Catalogue sync — the agent-facing and dashboard-facing halves of the same
 * feature.
 *
 *   Dashboard (requireAuth — a signed-in owner):
 *     GET    /api/sync/devices          what is installed, and is it alive
 *     POST   /api/sync/devices/pair     start a pairing, returns a code
 *     DELETE /api/sync/devices/:id      revoke
 *
 *   Agent (device token — a program on a shop PC):
 *     POST   /api/sync/pair             redeem a code for a token
 *     POST   /api/sync/catalogue        upload today's export
 *     POST   /api/sync/heartbeat        "still here, nothing to send"
 *
 * TWO AUDIENCES, ONE ROUTER, DIFFERENT AUTHENTICATION
 * Kept in one file because they are one protocol and the pair has to stay in
 * step; a change to what the agent sends is a change to what the dashboard
 * shows. But no route trusts the other's credential: requireAuth proves a
 * person, requireDevice proves an install, and neither is accepted where the
 * other is meant.
 */

const express = require('express');
const multer = require('multer');
const path = require('node:path');

const { requireAuth } = require('../middleware/auth');
const { ingestCatalogue, recordIngestFailure } = require('../services/sync/ingestCatalogue');
const {
  createPairing, redeemPairing, authenticateDevice, revokeDevice,
  listDevices, createEmailInbox,
} = require('../services/sync/syncDevices');

const router = express.Router();

const ALLOWED_EXT = new Set(['.xlsx', '.xls', '.csv']);

// Same limits and reasoning as the hand-upload route: in memory, one file,
// 10MB. A sync is not a licence to send something larger than a person could.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error(`"${file.originalname}" is not a spreadsheet. The agent should only send .xlsx, .xls or .csv.`));
    }
    cb(null, true);
  },
}).single('file');

function handleUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That export is larger than 10MB. Send the product list only.'
      : err.message;
    res.status(400).json({ error: message, code: 'UPLOAD_REJECTED' });
  });
}

/**
 * Device authentication.
 *
 * Scoped deliberately narrowly: a device token reaches these routes and
 * nothing else. A pharmacy's server PC is a shared machine, so if this token
 * leaks the blast radius must be "somebody pushed a price list", not "somebody
 * read the customer table". That is why this is its own middleware rather than
 * a second branch inside requireAuth — the two must not be able to drift into
 * accepting each other.
 */
async function requireDevice(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const device = await authenticateDevice(token);
    if (!device) {
      return res.status(401).json({
        error: 'This device is not paired. Pair it again from the dashboard.',
        code: 'DEVICE_NOT_PAIRED',
      });
    }
    req.device = device;
    req.pharmacyId = device.pharmacy_id;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- dashboard --

router.get('/devices', requireAuth, async (req, res, next) => {
  try {
    res.json({
      devices: await listDevices(req.pharmacyId),
      // Sent so the dashboard can show an inbox's full address on its own row
      // rather than only at the moment it was issued. The domain depends on
      // which inbound-parse provider is in front of this server, so the
      // browser must not assemble it from a guess — an address that is subtly
      // wrong gets pasted into a POS and silently delivers nowhere.
      emailDomain: process.env.EMAIL_INBOUND_DOMAIN || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Give this pharmacy an address its cloud POS can mail its stock report to.
 *
 * The domain comes from configuration rather than being built in the browser:
 * it depends on which inbound-parse provider is in front of this and what MX
 * records point where, and a dashboard that guessed would hand a pharmacist an
 * address to paste into their POS that quietly goes nowhere.
 */
router.post('/email-inbox', requireAuth, async (req, res, next) => {
  try {
    const domain = process.env.EMAIL_INBOUND_DOMAIN;
    if (!domain) {
      return res.status(503).json({
        error: 'Email delivery is not configured on this server yet.',
        code: 'EMAIL_NOT_CONFIGURED',
      });
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : null;
    const row = await createEmailInbox(req.pharmacyId, { label });
    res.json({ ...row, address: `stock-${row.email_token}@${domain}` });
  } catch (err) {
    next(err);
  }
});

router.post('/devices/pair', requireAuth, async (req, res, next) => {
  try {
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : null;
    res.json(await createPairing(req.pharmacyId, { label }));
  } catch (err) {
    next(err);
  }
});

router.delete('/devices/:id', requireAuth, async (req, res, next) => {
  try {
    const done = await revokeDevice(req.pharmacyId, req.params.id);
    if (!done) return res.status(404).json({ error: 'No such device.', code: 'NOT_FOUND' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- agent --

/**
 * Redeem a pairing code. The ONE unauthenticated route here — the agent has
 * nothing else to present, and the code is the credential for this single
 * call. Single-use and expiring, enforced in the UPDATE itself.
 */
router.post('/pair', async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'A pairing code is required.', code: 'NO_CODE' });

    const result = await redeemPairing(code, {
      // Program and service NAMES the agent found, with the pharmacist's
      // consent — never file contents. Paired with their answer to "which of
      // these is your stock software?", this is what builds the fingerprint
      // catalogue that lets the next install of the same POS be recognised
      // without asking.
      fingerprint: req.body?.fingerprint || null,
      confirmedPos: typeof req.body?.pos === 'string' ? req.body.pos.slice(0, 120) : null,
      label: typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : null,
      watchPath: typeof req.body?.watchPath === 'string' ? req.body.watchPath.slice(0, 400) : null,
    });

    if (!result) {
      return res.status(400).json({
        error: 'That code is not valid, has expired, or has already been used. Generate a new one from the dashboard.',
        code: 'BAD_PAIRING_CODE',
      });
    }
    res.json({ token: result.token, deviceId: result.deviceId });
  } catch (err) {
    next(err);
  }
});

/** "Running, nothing to send." Keeps last_seen_at honest between exports. */
router.post('/heartbeat', requireDevice, (req, res) => {
  res.json({ ok: true });
});

/**
 * Today's export.
 *
 * THE RULE THIS ROUTE EXISTS TO ENFORCE
 * A synced file imports by itself ONLY when its columns match the mapping a
 * human already confirmed. Anything else is staged and left for review.
 *
 * Nothing here weakens the existing contract that no product row changes until
 * a person agreed what the columns mean — it just stops asking them the same
 * question every night. A renamed column is exactly how a price gets read out
 * of a stock-count field, so a changed shape stops and asks; the cost of
 * asking unnecessarily is one notification, and the cost of not asking is
 * wrong prices quoted to real customers as fact.
 */
router.post('/catalogue', requireDevice, handleUpload, async (req, res, next) => {
  const device = req.device;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file was sent.', code: 'NO_FILE' });
    }

    // The decision about what happens to these rows lives in one place, shared
    // with email ingestion — see ingestCatalogue.js. Two copies of the
    // unattended-import rule would agree today and diverge on the first fix
    // applied to one of them, and the symptom would be a pharmacy's prices
    // going quietly wrong on a schedule.
    const result = await ingestCatalogue({
      pharmacyId: req.pharmacyId,
      deviceId: device.id,
      buffer: req.file.buffer,
      filename: req.file.originalname,
    });

    // 200 even when a human has to look: the agent did its job correctly, and
    // returning 4xx would make a normal, expected state indistinguishable from
    // a broken install in the agent's own logs.
    return res.json(result.status === 'needs_review'
      ? { ...result, message: 'Uploaded. Someone needs to check the columns in the dashboard before this can be imported.' }
      : result);
  } catch (err) {
    await recordIngestFailure(device.id, err);
    return next(err);
  }
});

module.exports = router;
