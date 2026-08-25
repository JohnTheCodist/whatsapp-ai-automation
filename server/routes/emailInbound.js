/**
 * Catalogues that arrive by email.
 *
 * WHAT PROBLEM THIS SOLVES
 * A cloud POS cannot be reached by a program on the pharmacy's computer —
 * there is nothing on that computer to read. Writing an adapter per vendor
 * means writing one before knowing which vendors exist, and rewriting it every
 * time one changes its API. But almost every POS can already email a scheduled
 * report to a person, so pointing that at us instead is ONE integration that
 * works across vendors, needs no password, and installs nothing.
 *
 * HOW MAIL GETS HERE
 * An inbound-parse service (SendGrid, Mailgun, Postmark, Cloudflare Email
 * Workers) receives the message and POSTs it here as multipart/form-data with
 * the attachment as a file part — the same shape as the dashboard's own upload
 * form, which is why this needs no MIME parser and reuses multer.
 *
 * Deliberately NOT an SMTP server of our own. Running one means MX records,
 * TLS, greylisting, spam filtering and a reputation to maintain, all to
 * receive a spreadsheet — and every hour spent on deliverability is an hour
 * not spent on the pharmacy software.
 *
 * THE THREE LOCKS
 *   1. A shared secret, so only the configured provider can POST here at all.
 *   2. An unguessable address, so a stranger cannot find a pharmacy's inbox.
 *   3. A sender allowlist, so knowing the address is not enough.
 * Any one of these alone would be thin. A price list pushed into a live
 * catalogue changes what real customers are quoted, so this is one of the few
 * places in the app where a wrong answer costs money directly.
 */

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');

const { findEmailInbox, learnSender } = require('../services/sync/syncDevices');
const { ingestCatalogue, recordIngestFailure } = require('../services/sync/ingestCatalogue');

const router = express.Router();

const ALLOWED_EXT = new Set(['.xlsx', '.xls', '.csv']);

// Same ceiling as every other way in. A stock list is a stock list however it
// arrived, and an unbounded attachment is a way to fill a disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

/**
 * Constant-time comparison of the provider secret.
 *
 * A plain === leaks the length of the correct value and, in principle, how far
 * a guess matched. This is cheap insurance on the one door that stands in
 * front of everything else here.
 */
function secretMatches(given) {
  const expected = process.env.EMAIL_INBOUND_SECRET || '';
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pull the inbox token out of whichever field the provider used.
 *
 * Every service names this differently, and several send a full RFC5322 header
 * ("RxNaija Stock" <stock-k7p2m4x8@sync.rxnaija.com>) rather than a bare
 * address. Parsing the angle brackets here means the route does not care which
 * provider is in front of it, which is what keeps that choice reversible.
 */
function extractToken(body) {
  const candidates = [body?.to, body?.recipient, body?.To, body?.envelope_to, body?.['envelope[to]']];
  for (const raw of candidates) {
    if (!raw) continue;
    const text = String(raw);
    const angled = text.match(/<([^>]+)>/);
    const addr = (angled ? angled[1] : text).trim().toLowerCase();
    const m = addr.match(/(?:^|[+\-.])?stock-([a-z0-9]{8,32})@/);
    if (m) return m[1];
  }
  return null;
}

/** The sending address, likewise however the provider spelled the field. */
function extractSender(body) {
  const raw = body?.from || body?.sender || body?.From || body?.envelope_from;
  if (!raw) return null;
  const text = String(raw);
  const angled = text.match(/<([^>]+)>/);
  return (angled ? angled[1] : text).trim().toLowerCase();
}

/** The first attachment that is actually a spreadsheet. */
function pickSpreadsheet(files) {
  for (const f of files || []) {
    if (ALLOWED_EXT.has(path.extname(f.originalname || '').toLowerCase())) return f;
  }
  return null;
}

/**
 * POST /api/email/inbound
 *
 * ALWAYS 200 ON A REJECTED MESSAGE, and that is not laziness.
 *
 * A non-2xx tells the provider the message could not be delivered, and it will
 * retry — for hours, on a schedule nobody controls — and then bounce to the
 * pharmacy, whose staff receive a delivery-failure notice about a system they
 * were told is automatic. None of the rejections below are transient: a PDF
 * attachment, an unknown address and a stranger's mail are all permanently
 * wrong, and retrying cannot fix any of them. So they are accepted and
 * dropped, with the reason returned for the provider's own log.
 *
 * A genuine server fault DOES return 5xx, because that one is worth retrying.
 */
router.post('/inbound', upload.any(), async (req, res, next) => {
  // The secret can come as a header or as a query parameter, because not
  // every provider lets you set custom headers on the webhook.
  const given = req.get('x-rxnaija-secret') || req.query.secret;
  if (!secretMatches(given)) {
    // 401 here, not 200: this is not a pharmacy's message being rejected, it
    // is something POSTing at an endpoint it has no business at.
    return res.status(401).json({ error: 'Not authorised.', code: 'BAD_SECRET' });
  }

  const token = extractToken(req.body);
  if (!token) {
    return res.json({ status: 'ignored', reason: 'no_recognisable_address' });
  }

  const inbox = await findEmailInbox(token);
  if (!inbox) {
    return res.json({ status: 'ignored', reason: 'unknown_address' });
  }

  const sender = extractSender(req.body);
  if (!sender) {
    return res.json({ status: 'ignored', reason: 'no_sender' });
  }

  // First message teaches the address; every later one is checked against it.
  if (!inbox.allowed_sender) {
    await learnSender(inbox.id, sender);
  } else if (inbox.allowed_sender !== sender) {
    // Deliberately not recorded as a sync failure. This pharmacy's POS is
    // fine — somebody else mailed the address — and lighting up the dashboard
    // with "your catalogue failed" would be a false alarm about their setup.
    return res.json({ status: 'ignored', reason: 'sender_not_allowed' });
  }

  const file = pickSpreadsheet(req.files);
  if (!file) {
    // The single most likely real-world failure: a POS that emails its report
    // as a PDF, which is a picture of a table rather than a table. Recorded
    // against the inbox so the pharmacy is told what to change, instead of
    // their catalogue simply never updating.
    await recordIngestFailure(inbox.id, new Error(
      'The email had no Excel or CSV attachment. If your stock report is sent as a PDF, '
      + 'change it to Excel or CSV — a PDF cannot be read as a price list.'
    ));
    return res.json({ status: 'ignored', reason: 'no_spreadsheet_attachment' });
  }

  try {
    const result = await ingestCatalogue({
      pharmacyId: inbox.pharmacy_id,
      deviceId: inbox.id,
      buffer: file.buffer,
      filename: file.originalname,
    });
    return res.json(result);
  } catch (err) {
    await recordIngestFailure(inbox.id, err);
    return next(err);
  }
});

module.exports = router;
