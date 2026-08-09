/**
 * WhatsApp connection endpoints — Phase 2, task 2.4.
 *
 * The flow a pharmacy owner actually walks through:
 *
 *   GET  /api/whatsapp/status   what is the current state
 *   POST /api/whatsapp/connect  { phoneNumber } -> pairing code to type in
 *   GET  /api/whatsapp/events   SSE, live status while they do it
 *   POST /api/whatsapp/selftest send a message to their own number
 *   POST /api/whatsapp/disconnect
 *
 * WHY SELF-TEST IS SEPARATE FROM "connected"
 * The socket reaching `open` is a fact about the socket. It is not evidence
 * that a message can actually be delivered. Telling a pharmacy they are live
 * on the strength of an open socket is exactly the failure in risk 4f —
 * invisible until a real customer is ignored. So `connected` is recorded
 * when the socket opens, and the UI only claims success after a message has
 * demonstrably made the round trip.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { sessionManager } = require('../services/whatsapp/sessionManager');

const router = express.Router();

/** The account row for this tenant, creating one on first use. */
async function getOrCreateAccount(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [existing] = await db`
    select * from whatsapp_accounts
    where pharmacy_id = ${pharmacyId} and provider = 'baileys'
    order by created_at limit 1
  `;
  if (existing) return existing;

  const [created] = await db`
    insert into whatsapp_accounts (pharmacy_id, provider, status, status_detail)
    values (${pharmacyId}, 'baileys', 'pending', 'Not connected yet.')
    returning *
  `;
  return created;
}

/**
 * Shape the row for the client.
 *
 * Explicitly enumerated rather than spreading the row: `creds_encrypted` is
 * in there, and a credential must never leave the server because someone
 * added a column later and the response happened to include everything.
 */
function present(account, live) {
  return {
    id: account.id,
    status: account.status,
    statusDetail: account.status_detail,
    phoneNumber: account.display_phone_number,
    pairingCode: account.pairing_code,
    pairingExpiresAt: account.pairing_expires_at,
    lastConnectedAt: account.last_connected_at,
    disconnectReason: account.disconnect_reason,
    hasCredentials: Boolean(account.creds_encrypted),
    live: Boolean(live?.live),
    registered: Boolean(live?.registered),
  };
}

// ---------------------------------------------------------------------------

router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const account = await getOrCreateAccount(req.pharmacyId);
    res.json(present(account, sessionManager.getStatus(account.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Start pairing. Returns the code the owner types into their phone under
 * Settings -> Linked devices -> Link with phone number instead.
 */
router.post('/connect', requireAuth, async (req, res, next) => {
  try {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({
        error: 'phoneNumber is required, in international format including country code (e.g. 2348012345678).',
        code: 'MISSING_PHONE',
      });
    }

    const account = await getOrCreateAccount(req.pharmacyId);

    // A live socket already holding this session would fight the new one and
    // produce connectionReplaced on both. Close it deliberately first.
    if (sessionManager.getStatus(account.id).live) {
      await sessionManager.disconnect(account.id, { reason: 'Reconnecting for a new pairing.' });
    }

    // Stale credentials from a previous pairing make requestPairingCode
    // reject with "already registered". Clearing is correct: the owner is
    // explicitly asking to pair this number again.
    const db = getSql();
    await db`
      update whatsapp_accounts set creds_encrypted = null, updated_at = now()
      where id = ${account.id}
    `;
    await db`delete from whatsapp_auth_keys where whatsapp_account_id = ${account.id}`;

    const code = await sessionManager.requestPairingCode(req.pharmacyId, account.id, phoneNumber);

    res.json({
      accountId: account.id,
      pairingCode: code,
      // Formatting hint only; the code is authoritative as returned.
      expiresInSeconds: 180,
      instructions: [
        'On the phone with this number, open WhatsApp',
        'Settings → Linked devices → Link a device',
        'Tap "Link with phone number instead"',
        `Enter this code: ${code}`,
      ],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Live status over Server-Sent Events.
 *
 * SSE rather than WebSocket: this is one-directional server→client, and SSE
 * reconnects on its own. A WebSocket here would be more moving parts for no
 * capability we need.
 */
router.get('/events', requireAuth, async (req, res, next) => {
  try {
    const account = await getOrCreateAccount(req.pharmacyId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers event-streams by default, which makes live updates
      // arrive in a clump at the end and look like nothing is happening.
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', present(account, sessionManager.getStatus(account.id)));

    // Only forward events for THIS tenant's account. The manager is a
    // process-wide singleton carrying every pharmacy's traffic, so an
    // unfiltered pipe here would stream one pharmacy's activity to another.
    const mine = (payload) => payload && payload.accountId === account.id;

    const onStatus = (p) => { if (mine(p)) send('status', p); };
    // NOT named 'open': EventSource fires its own native 'open' event when
    // the stream connects, and a client listening for 'open' would receive
    // both. That reads as "the WhatsApp socket is up" the instant the page
    // loads — a false connected signal, which is the exact failure this
    // whole flow is built to avoid.
    const onOpen = (p) => { if (mine(p)) send('socket-open', p); };
    const onPairing = (p) => { if (mine(p)) send('pairing-code', p); };
    const onDead = (p) => { if (mine(p)) send('session-dead', p); };
    const onReconnecting = (p) => { if (mine(p)) send('reconnecting', p); };
    const onMessage = (p) => {
      if (!mine(p)) return;
      // Message CONTENT is deliberately not streamed here — this endpoint is
      // a connection monitor, not an inbox.
      send('message', { from: p.phoneNumber, at: p.timestamp, hasText: Boolean(p.text) });
    };

    sessionManager.on('status', onStatus);
    sessionManager.on('open', onOpen);
    sessionManager.on('pairing-code', onPairing);
    sessionManager.on('session-dead', onDead);
    sessionManager.on('reconnecting', onReconnecting);
    sessionManager.on('message', onMessage);

    // Proxies and load balancers close an idle connection. A comment line is
    // valid SSE and keeps it warm without the client having to parse it.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sessionManager.off('status', onStatus);
      sessionManager.off('open', onOpen);
      sessionManager.off('pairing-code', onPairing);
      sessionManager.off('session-dead', onDead);
      sessionManager.off('reconnecting', onReconnecting);
      sessionManager.off('message', onMessage);
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Round-trip proof. Sends a message to the pharmacy's own connected number.
 *
 * This is what converts "the socket is open" into "messages actually reach
 * people" — the distinction risk 4f is about.
 */
router.post('/selftest', requireAuth, async (req, res, next) => {
  try {
    const account = await getOrCreateAccount(req.pharmacyId);

    if (!sessionManager.getStatus(account.id).live) {
      return res.status(409).json({
        error: 'No live session. Connect first.',
        code: 'NOT_CONNECTED',
      });
    }
    if (!account.display_phone_number) {
      return res.status(409).json({
        error: 'The connected number is not known yet. Wait for the socket to finish opening.',
        code: 'NO_NUMBER',
      });
    }

    const jid = `${account.display_phone_number}@s.whatsapp.net`;
    const sent = await sessionManager.sendText(
      account.id,
      jid,
      'Self-test from your pharmacy assistant. If you can read this, the connection works.',
      { delay: false }, // a diagnostic, not a customer reply — no ban-signal concern
    );

    res.json({ ok: true, to: account.display_phone_number, providerMessageId: sent.providerMessageId });
  } catch (err) {
    next(err);
  }
});

router.post('/disconnect', requireAuth, async (req, res, next) => {
  try {
    const account = await getOrCreateAccount(req.pharmacyId);
    const wasLive = await sessionManager.disconnect(account.id, { reason: 'Disconnected from the dashboard.' });

    if (!wasLive) {
      const db = getSql();
      await db`
        update whatsapp_accounts
        set status = 'disconnected', status_detail = 'Disconnected from the dashboard.', updated_at = now()
        where id = ${account.id}
      `;
    }
    res.json({ ok: true, wasLive });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
