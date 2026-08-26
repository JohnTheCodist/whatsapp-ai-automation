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
// The same normaliser the sender-identity path uses, so "08012345678" and
// "2348012345678" are recognised as one number here too. Comparing raw input
// would let the same phone be claimed twice just by typing it differently.
const { normalizeMsisdn } = require('../services/whatsapp/senderIdentity');

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

  // ON CONFLICT, not a bare insert.
  //
  // The select above is a read, and between it and this write another request
  // can insert the same row. That is not theoretical: two dashboards open at
  // once — the desktop app and a browser — both call /api/whatsapp/status on
  // load, both found nothing here, and both inserted. The pharmacy ended up
  // with two baileys accounts for one number, two sockets, and WhatsApp
  // knocking them off each other with connectionReplaced until the assistant
  // went silent while every health check still read green.
  //
  // DO UPDATE rather than DO NOTHING, because DO NOTHING returns no row on
  // conflict — the loser of the race would get `undefined` and fail with a
  // confusing error instead of simply receiving the row that won. Touching
  // updated_at is a no-op write whose only job is to make RETURNING give it
  // back.
  //
  // The unique index this relies on is migration 0046. Both halves matter:
  // this handles the race gracefully, the index makes it impossible.
  const [created] = await db`
    insert into whatsapp_accounts (pharmacy_id, provider, status, status_detail)
    values (${pharmacyId}, 'baileys', 'pending', 'Not connected yet.')
    on conflict (pharmacy_id, provider) do update set updated_at = now()
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
  const isLive = Boolean(live?.live);

  // THE STORED STATUS CAN LIE, SO IT IS NOT REPORTED ON ITS OWN.
  //
  // account.status is written on transition, so it keeps saying 'connected'
  // long after a socket has died without a clean disconnect — exactly what a
  // failed session restore leaves behind. That combination cost a long
  // debugging session: the dashboard read "connected", the phone showed
  // messages delivered, and nothing arrived, because the socket the row
  // described no longer existed.
  //
  // The in-memory session is the only thing that actually knows. When the two
  // disagree, the live view wins and the disagreement is named rather than
  // hidden, so "connected but nothing works" can never look healthy again.
  const stale = account.status === 'connected' && !isLive;

  return {
    id: account.id,
    status: stale ? 'disconnected' : account.status,
    statusDetail: stale
      ? 'Stored status says connected but no live socket — the session did not restore.'
      : account.status_detail,
    phoneNumber: account.display_phone_number,
    pairingCode: account.pairing_code,
    pairingExpiresAt: account.pairing_expires_at,
    lastConnectedAt: account.last_connected_at,
    disconnectReason: account.disconnect_reason,
    hasCredentials: Boolean(account.creds_encrypted),
    live: isLive,
    registered: Boolean(live?.registered),
    // Explicit rather than inferred from the pair above: a dashboard should
    // not have to know that status='connected' plus live=false means trouble.
    staleStatus: stale,
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

    // ---- is this number already another pharmacy's? -----------------------
    //
    // CHECKED HERE, BEFORE ANYTHING IS DESTROYED. Everything below this point
    // wipes credentials and auth keys to make a fresh pairing possible, so
    // discovering the clash afterwards would mean the owner has already lost
    // the session they had, in exchange for a pairing that cannot work.
    //
    // WHY THIS IS NOT LEFT TO THE UNIQUE INDEX
    // display_phone_number has been unique since 0001, but it is only written
    // AFTER pairing completes — WhatsApp tells us the number, we do not. So
    // the constraint fires at the very end, as a 500 with a Postgres message,
    // after the pharmacist has typed a code into their phone and believes they
    // succeeded. The index is the backstop; this is the answer.
    //
    // This is the failure that took a live pharmacy silent: two pharmacies
    // paired to one number, two sockets, WhatsApp knocking them off each other
    // with connectionReplaced until the assistant stopped answering while
    // every health check still read green.
    const wanted = normalizeMsisdn(phoneNumber);
    if (!wanted) {
      return res.status(400).json({
        error: `"${phoneNumber}" is not a phone number this can use. Give it in international format, e.g. 2348012345678.`,
        code: 'BAD_PHONE',
      });
    }

    const db = getSql();
    const [taken] = await db`
      select a.id, p.name as pharmacy_name
      from whatsapp_accounts a
      join pharmacies p on p.id = a.pharmacy_id
      where a.display_phone_number = ${wanted}
        and a.pharmacy_id <> ${req.pharmacyId}
      limit 1
    `;
    if (taken) {
      return res.status(409).json({
        // Names the pharmacy holding it, because the owner is very often the
        // same person and the answer is "oh, that's my old test one". Without
        // the name this is a dead end they cannot act on.
        error: `That number is already connected to ${taken.pharmacy_name}. A WhatsApp number can only be used by one pharmacy — disconnect it there first, or use a different number.`,
        code: 'NUMBER_IN_USE',
        pharmacyName: taken.pharmacy_name,
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

/**
 * Recent messages for this tenant.
 *
 * Exists because "did my message arrive?" was unanswerable: the session
 * manager emitted inbound messages and nothing stored them, so the only
 * witness was an ephemeral SSE stream. Reading from the durable rows makes
 * the answer checkable rather than inferred.
 */
router.get('/messages', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const db = getSql();

    const rows = await db`
      select m.id, m.direction, m.author, m.body, m.created_at,
             c.wa_phone, c.display_name
      from messages m
      join conversations conv on conv.id = m.conversation_id
      join customers c on c.id = conv.customer_id
      where m.pharmacy_id = ${req.pharmacyId}
      order by m.created_at desc
      limit ${limit}
    `;

    const [counts] = await db`
      select
        (select count(*)::int from messages where pharmacy_id = ${req.pharmacyId}) as messages,
        (select count(*)::int from customers where pharmacy_id = ${req.pharmacyId}) as customers,
        (select count(*)::int from inbound_events where pharmacy_id = ${req.pharmacyId}) as events,
        (select count(*)::int from jobs where pharmacy_id = ${req.pharmacyId} and status = 'queued') as queued_jobs
    `;

    res.json({
      counts,
      messages: rows.map((r) => ({
        id: String(r.id),
        direction: r.direction,
        author: r.author,
        body: r.body,
        from: r.wa_phone,
        name: r.display_name,
        at: r.created_at,
      })),
    });
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
