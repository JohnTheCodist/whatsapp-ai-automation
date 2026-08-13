/**
 * Session manager — owns every live Baileys socket in this process.
 *
 * Under Cloud API, Meta held the connection and POSTed to a webhook. Under
 * Baileys we hold it: one authenticated socket per pharmacy, in memory, for
 * as long as the process lives. This file is the part of the system that
 * Meta used to run for us.
 *
 * WHAT IT IS RESPONSIBLE FOR
 *   - opening, restoring, and closing sockets
 *   - pairing-code onboarding
 *   - reconnection, and knowing when NOT to reconnect (disconnectPolicy.js)
 *   - turning socket events into normalised inbound messages
 *
 * WHAT IT IS NOT RESPONSIBLE FOR
 *   Conversations, the assistant, orders, safety routing. It emits events;
 *   something else decides what they mean. Keeping that line sharp is what
 *   stops this file from becoming the application.
 *
 * SINGLE PROCESS, FOR NOW
 * A socket lives in exactly one process, so running two instances against
 * one database makes them fight over sessions — WhatsApp resolves that by
 * knocking one off (DisconnectReason.connectionReplaced), repeatedly. MVP is
 * deliberately one process. `whatsapp_accounts.worker_id` exists as the seam
 * for later; nothing here assumes the process serving an HTTP request is the
 * process holding the socket.
 */

const EventEmitter = require('node:events');
const {
  makeWASocket,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('baileys');
const pino = require('pino');

const { getSql, assertPharmacyId } = require('../db');
const { env } = require('../../config/env');
const { createAuthStore } = require('./authStore');
const { classifyDisconnect, backoffMs, MAX_RECONNECT_ATTEMPTS } = require('./disconnectPolicy');
const { isDirectUserChat } = require('./jidPolicy');
const { resolveSender } = require('./senderIdentity');

// Baileys is chatty at info level and every line is protocol noise. Warnings
// and errors are worth having; the rest is not, and drowning real problems is
// how they get missed.
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

// A message this fresh is treated as live even if Baileys labelled it
// 'append' instead of 'notify' — see isLiveMessage() for why the label alone
// was found to be unreliable. 3 minutes is generous slack for clock skew and
// delivery lag while still refusing anything that is genuinely old history.
const LIVE_MESSAGE_WINDOW_MS = 3 * 60 * 1000;

/**
 * Should this inbound message be treated as live (worth acting on), or as
 * history backfill (ignore — it was already handled, possibly days ago)?
 *
 * 'notify' is Baileys' label for "a genuinely new message". 'append' and
 * 'prepend' are supposed to mean backfill. In production that label was not
 * trustworthy: after a session restore, real messages sent minutes ago kept
 * arriving tagged 'append', and a batch-level `type !== 'notify'` check that
 * never looked at the message itself discarded every one of them. The
 * customer's message was correctly recent; only Baileys' label was wrong.
 *
 * The label is not the only signal available — the message carries its own
 * timestamp, and genuine backfill is old by construction. So a message
 * counts as live if EITHER Baileys says 'notify', OR it is younger than
 * LIVE_MESSAGE_WINDOW_MS regardless of what it was labelled. That recovers
 * the mislabelled live messages while still refusing to resurrect and reply
 * to real old history, which is the failure this filter existed to prevent.
 *
 * Pure, and exported for that reason: the two ways to get this wrong (miss a
 * live customer, or answer three-day-old history) are both expensive, and
 * neither should depend on a live socket to verify.
 *
 * @param {string} type              Baileys' messages.upsert type
 * @param {number|string|undefined} messageTimestamp  seconds since epoch, as Baileys sends it
 * @param {number} [now]             injectable for tests
 * @returns {{isLive: boolean, ageMs: number|null}}
 */
function isLiveMessage(type, messageTimestamp, now = Date.now()) {
  if (type === 'notify') return { isLive: true, ageMs: 0 };

  if (messageTimestamp === undefined || messageTimestamp === null || messageTimestamp === '') {
    // No timestamp at all is never treated as live — there is nothing to
    // check it against, and the safe failure here is to withhold a reply,
    // not to risk resurrecting unknown-aged history.
    return { isLive: false, ageMs: null };
  }

  const ageMs = now - Number(messageTimestamp) * 1000;
  if (!Number.isFinite(ageMs)) return { isLive: false, ageMs: null };

  return { isLive: ageMs <= LIVE_MESSAGE_WINDOW_MS, ageMs: Math.round(ageMs) };
}

/**
 * Builds proxy agents if configured. TWO are needed and they are separate
 * (ARCHITECTURE.md §6.8): `agent` covers the WebSocket, `fetchAgent` covers
 * media upload and download. Configuring only the first leaves the host IP
 * exposed on every image a pharmacy sends or receives — which defeats the
 * entire reason for using a proxy.
 */
function buildAgents() {
  const url = env.channel.baileys.proxyUrl;
  if (!url) return {};

  let HttpsProxyAgent;
  try {
    ({ HttpsProxyAgent } = require('https-proxy-agent'));
  } catch {
    throw new Error(
      'BAILEYS_PROXY_URL is set but https-proxy-agent is not installed.\n' +
      'Install it (npm i https-proxy-agent) or unset BAILEYS_PROXY_URL.\n' +
      'Starting without the proxy would silently expose the host IP, so this refuses to boot instead.'
    );
  }
  const agent = new HttpsProxyAgent(url);
  return { agent, fetchAgent: agent };
}

/**
 * Does this session need a socket built for it?
 *
 * Pure, and separated out because the bug it encodes is invisible: get it
 * wrong in the "no" direction and reconnects silently stop happening, with
 * no error anywhere — the session just sits in `connecting` forever having
 * actually linked successfully. Get it wrong in the "yes" direction and two
 * live sockets fight over one session until WhatsApp knocks both off.
 *
 * @param {object|undefined} session
 * @returns {boolean}
 */
function needsNewSocket(session) {
  if (!session) return true;        // never connected
  if (!session.sock) return true;   // record exists, socket never built
  if (session.closed) return true;  // socket is dead and must be replaced
  return false;                     // live socket — reuse it
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} accountId -> session record */
    this.sessions = new Map();
    this.stopping = false;

    // 'error' is a RESERVED EventEmitter name: emitting it with no listener
    // registered makes Node throw ERR_UNHANDLED_ERROR, which is unhandled at
    // the top of an async callback and kills the process.
    //
    // That is not theoretical. A statement timeout on a status write was
    // caught, reported via emit('error', ...), and took the entire server
    // down — every pharmacy's session with it. The handler written to report
    // the failure WAS the failure.
    //
    // Failures are now emitted as 'session-error'. This listener exists only
    // so that a stray emit('error') from future code cannot repeat that, and
    // it logs rather than swallowing so the mistake stays visible.
    this.on('error', (err) => {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'sessionManager emitted a reserved "error" event — use "session-error" instead',
        error: err?.message || String(err),
      }));
    });
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Restore every session that was connected when the process last stopped.
   *
   * Staggered deliberately. Fifty sockets opening simultaneously after a
   * deploy is a self-inflicted thundering herd against our own database, and
   * an unusual burst from one IP at exactly the moment we would rather look
   * unremarkable.
   */
  async start({ staggerMs = 750 } = {}) {
    const db = getSql();
    const rows = await db`
      select id, pharmacy_id
      from whatsapp_accounts
      where provider = 'baileys'
        and status in ('connected', 'connecting', 'disconnected')
        and creds_encrypted is not null
      order by last_connected_at asc nulls last
    `;

    this.emit('starting', { count: rows.length });

    for (const row of rows) {
      if (this.stopping) break;
      // Not awaited: one unreachable session must not block the rest from
      // coming up. Failures surface as status rows and 'error' events.
      this.connect(row.pharmacy_id, row.id).catch((err) => {
        this.emit('session-error', { accountId: row.id, phase: 'restore', error: err });
      });
      await new Promise((r) => setTimeout(r, staggerMs));
    }

    return rows.length;
  }

  /**
   * Open (or reopen) a socket for one account.
   *
   * Idempotent: calling it for an account that already has a live socket
   * returns the existing record rather than opening a second one, because a
   * duplicate socket is exactly what triggers connectionReplaced.
   */
  async connect(pharmacyId, accountId) {
    assertPharmacyId(pharmacyId);

    const existing = this.sessions.get(accountId);
    if (!needsNewSocket(existing)) return existing;

    const auth = existing?.auth || (await createAuthStore(pharmacyId, accountId));

    const session = existing || {
      accountId,
      pharmacyId,
      sock: null,
      auth,
      attempts: 0,
      timer: null,
      closed: false,
      intentionalClose: false,
      pairingPhoneNumber: null,
    };
    session.auth = auth;
    session.closed = false;
    session.intentionalClose = false;
    this.sessions.set(accountId, session);

    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        // TTL-bounded cache (5 min, deleteOnExpire) in front of the lazy
        // Postgres store. It cuts repeated key reads per message without
        // reintroducing the unbounded in-memory store v7 removed — the
        // capacity argument in §6.8 still holds.
        keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLogger),
      },
      logger: baileysLogger,
      // The library default, and deliberately not customised.
      //
      // The tuple is [os, browser, version], and Baileys derives the
      // registration's platformType from browser[1] via
      //   proto.DeviceProps.PlatformType[browser[1].toUpperCase()] || CHROME
      //
      // An earlier attempt used Browsers.appropriate('Desktop') to get a
      // recognisable name in the pharmacy's linked-devices list. That maps
      // to PlatformType.DESKTOP, i.e. we announce ourselves as the NATIVE
      // WhatsApp Desktop application — which does not link by pairing code.
      // The phone answered "Couldn't link device" and the server saw no
      // error at all, because nothing had gone wrong on our side.
      //
      // Any browser[1] that is not a known PlatformType falls back to CHROME,
      // so a custom display name is possible later. Establish a link on the
      // known-good default first.
      browser: Browsers.macOS('Chrome'),
      printQRInTerminal: false,
      // The pharmacy may still be using the WhatsApp Business app on this
      // number. Marking ourselves online would steal presence from them and
      // make the app look like it is being used by someone else.
      markOnlineOnConnect: false,
      // We do not need the archive, and syncing it costs time and memory at
      // exactly the moment onboarding is being judged on speed.
      syncFullHistory: false,
      ...buildAgents(),
    });

    session.sock = sock;

    sock.ev.on('creds.update', async () => {
      try {
        await auth.saveCreds();
      } catch (err) {
        // Losing creds updates silently means the session works until the
        // next restart and then mysteriously does not.
        this.emit('session-error', { accountId, phase: 'saveCreds', error: err });
      }
    });

    sock.ev.on('connection.update', (update) => {
      this._onConnectionUpdate(session, update).catch((err) => {
        this.emit('session-error', { accountId, phase: 'connection.update', error: err });
      });
    });

    sock.ev.on('messages.upsert', (payload) => {
      this._onMessages(session, payload).catch((err) => {
        this.emit('session-error', { accountId, phase: 'messages.upsert', error: err });
      });
    });

    await this._setStatus(accountId, 'connecting', 'Opening socket.');
    return session;
  }

  /**
   * Ask WhatsApp for a pairing code the owner types into their phone.
   *
   * Preferred over a QR: the owner is holding the device the code goes into,
   * and photographing a screen is a worse experience than typing eight
   * characters — especially over a support call.
   *
   * @param {string} phoneNumber  E.164, digits only, no '+'
   */
  async requestPairingCode(pharmacyId, accountId, phoneNumber) {
    assertPharmacyId(pharmacyId);

    const digits = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (digits.length < 10) {
      throw new Error(
        `Invalid phone number for pairing: ${JSON.stringify(phoneNumber)}. ` +
        'Expected E.164 digits including country code, e.g. 2348012345678.'
      );
    }

    const session = await this.connect(pharmacyId, accountId);
    if (session.auth.state.creds.registered) {
      throw new Error('This session is already registered. Disconnect it before pairing again.');
    }

    // MUST wait. requestPairingCode writes a node straight to the WebSocket,
    // but connect() returns as soon as makeWASocket() is called — the
    // handshake is still in flight. Calling it immediately throws
    // "Connection Closed", which then looks like a pairing failure rather
    // than a race in our own code. Measured: this is what happens.
    await this._waitForPairingReady(session);

    session.pairingPhoneNumber = digits;
    const code = await session.sock.requestPairingCode(digits);

    // Persistence is BEST-EFFORT and must not fail the request.
    //
    // The moment WhatsApp issues this code it is live and expires in about
    // three minutes. Throwing here because we could not write a row would
    // discard a valid code the user could have typed, and make them wait for
    // another — which is exactly what happened on the first live attempt:
    // the code was obtained successfully and then thrown away by a database
    // connect timeout.
    //
    // The row is a convenience for redisplay after a refresh. The socket is
    // the thing that actually completes pairing, and it is already live.
    try {
      const db = getSql();
      await db`
        update whatsapp_accounts
        set pairing_code = ${code},
            pairing_expires_at = now() + interval '3 minutes',
            status = 'pending_scan',
            status_detail = 'Waiting for the owner to enter the pairing code.',
            updated_at = now()
        where id = ${accountId}
      `;
    } catch (err) {
      this.emit('session-error', { accountId, phase: 'persistPairingCode', error: err });
    }

    this.emit('pairing-code', { accountId, pharmacyId, code });
    return code;
  }

  /** Deliberate shutdown of one session. Suppresses reconnect. */
  async disconnect(accountId, { reason = 'Disconnected by staff.' } = {}) {
    const session = this.sessions.get(accountId);
    if (!session) return false;

    session.intentionalClose = true;
    clearTimeout(session.timer);
    try {
      session.sock?.end(undefined);
    } catch { /* already gone */ }

    session.closed = true;
    this.sessions.delete(accountId);
    await this._setStatus(accountId, 'disconnected', reason);
    return true;
  }

  /** Process shutdown. Closes everything without marking sessions dead. */
  async stop() {
    this.stopping = true;
    for (const session of this.sessions.values()) {
      session.intentionalClose = true;
      clearTimeout(session.timer);
      try {
        session.sock?.end(undefined);
      } catch { /* already gone */ }
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // sending
  // -------------------------------------------------------------------------

  /**
   * Send one text message.
   *
   * The delay is a safety control, not polish. Instant replies to every
   * message at every hour is a machine signature, and mechanical timing is a
   * reported ban signal (§6.2). It is applied here rather than left to
   * callers so it cannot be forgotten at a call site.
   *
   * Callers must also send ONE consolidated message rather than three — that
   * is enforced upstream in the assistant, not here, but it is the same
   * concern.
   */
  async sendText(accountId, jid, text, { delay = true } = {}) {
    const session = this.sessions.get(accountId);
    if (!session || !session.sock) {
      throw new Error(`No live session for account ${accountId}. It may be disconnected or logged out.`);
    }
    if (!text || !String(text).trim()) {
      throw new Error('Refusing to send an empty message.');
    }

    if (delay) {
      const { minReplyDelayMs: min, maxReplyDelayMs: max } = env.channel.baileys;
      const ms = min + Math.floor(Math.random() * Math.max(0, max - min));
      await new Promise((r) => setTimeout(r, ms));
    }

    const sent = await session.sock.sendMessage(jid, { text: String(text) });
    return { providerMessageId: sent?.key?.id || null, jid };
  }

  getStatus(accountId) {
    const s = this.sessions.get(accountId);
    if (!s) return { live: false };
    return {
      live: Boolean(s.sock) && !s.closed,
      attempts: s.attempts,
      registered: Boolean(s.auth?.state?.creds?.registered),
    };
  }

  get liveCount() {
    return this.sessions.size;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Resolve once the socket is far enough along to accept a pairing request.
   *
   * For an unregistered session Baileys emits a `qr` on connection.update as
   * soon as the handshake completes and the server offers pairing. That is
   * the readiness signal — we ignore the QR itself and use the pairing code
   * flow, but its arrival proves the socket can carry a node.
   *
   * A fixed sleep would be the tempting shortcut and would fail on a slow
   * connection exactly where it matters most: a first-time pairing on a poor
   * mobile network.
   */
  _waitForPairingReady(session, timeoutMs = 25000) {
    const sock = session.sock;
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock.ev.off('connection.update', handler); } catch { /* emitter gone */ }
        if (err) reject(err); else resolve();
      };

      const handler = (u) => {
        if (u.qr || u.connection === 'open') return finish();
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          finish(new Error(
            `WhatsApp closed the connection before a pairing code could be requested ` +
            `(${code ?? 'no status code'}). Check the network and try again.`
          ));
        }
      };

      const timer = setTimeout(() => finish(new Error(
        'Timed out waiting for WhatsApp to accept the connection. ' +
        'The network may be blocking it, or WhatsApp may be unreachable.'
      )), timeoutMs);

      sock.ev.on('connection.update', handler);
    });
  }

  async _onConnectionUpdate(session, update) {
    const { connection, lastDisconnect } = update;
    const { accountId } = session;

    if (connection === 'open') {
      session.attempts = 0;
      // The number is only knowable once the socket is up — under Baileys we
      // learn it from WhatsApp rather than being told it during signup.
      const number = session.sock?.user?.id?.split(':')[0] || null;

      // Non-fatal. This is the write that once crashed the process: a
      // statement timeout here propagated out of a socket event handler and
      // killed the server at the exact moment a session had SUCCEEDED in
      // connecting. Failing to record a success must never undo it.
      try {
        const db = getSql();
        await db`
          update whatsapp_accounts
          set status = 'connected',
              status_detail = 'Socket open.',
              display_phone_number = coalesce(${number}, display_phone_number),
              last_connected_at = now(),
              last_seen_at = now(),
              disconnect_reason = null,
              pairing_code = null,
              pairing_expires_at = null,
              updated_at = now()
          where id = ${accountId}
        `;
      } catch (err) {
        this.emit('session-error', { accountId, phase: 'markConnected', error: err });
      }
      // NOTE: 'connected' here means the socket is genuinely open, which is a
      // fact worth recording. It is NOT the same as telling the pharmacy they
      // are live — that requires the self-test round trip, which the
      // onboarding flow performs on receiving this event.
      this.emit('open', { accountId, pharmacyId: session.pharmacyId, phoneNumber: number });
      return;
    }

    if (connection !== 'close') return;

    if (session.intentionalClose || this.stopping) return;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const decision = classifyDisconnect(statusCode, {
      wasRegistered: Boolean(session.auth?.state?.creds?.registered),
    });

    await this._setStatus(accountId, decision.status, decision.detail, statusCode);

    if (decision.clearAuth) {
      try {
        await session.auth.clear();
      } catch (err) {
        this.emit('session-error', { accountId, phase: 'clearAuth', error: err });
      }
    }

    if (decision.action === 'stop') {
      session.closed = true;
      this.sessions.delete(accountId);
      this.emit('session-dead', {
        accountId,
        pharmacyId: session.pharmacyId,
        status: decision.status,
        detail: decision.detail,
        needsHuman: decision.needsHuman,
      });
      return;
    }

    // reconnect
    //
    // Mark the socket dead BEFORE scheduling. connect() is idempotent on
    // purpose — a second live socket for one session makes WhatsApp knock
    // both off with connectionReplaced — but that guard reads
    // session.sock/closed, so a session left looking alive makes the
    // reconnect a silent no-op.
    //
    // That is exactly what happened on the first successful pairing: 515
    // restartRequired arrived, we scheduled a reconnect, connect() saw the
    // dead socket still attached and returned it unchanged, and the session
    // sat at 'connecting' forever having genuinely linked. The session
    // record itself is kept so the reconnect reuses the in-memory creds
    // Baileys just mutated.
    session.closed = true;
    session.attempts += 1;
    if (session.attempts > MAX_RECONNECT_ATTEMPTS) {
      session.closed = true;
      this.sessions.delete(accountId);
      const detail = `Gave up after ${MAX_RECONNECT_ATTEMPTS} consecutive reconnect attempts. Last: ${decision.detail}`;
      await this._setStatus(accountId, 'disconnected', detail, statusCode);
      this.emit('session-dead', {
        accountId,
        pharmacyId: session.pharmacyId,
        status: 'disconnected',
        detail,
        needsHuman: true,
      });
      return;
    }

    const wait = decision.immediate ? 0 : backoffMs(session.attempts);
    this.emit('reconnecting', { accountId, attempt: session.attempts, waitMs: wait });

    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.stopping || session.intentionalClose) return;
      this.connect(session.pharmacyId, accountId).catch((err) => {
        this.emit('session-error', { accountId, phase: 'reconnect', error: err });
      });
    }, wait);
  }

  async _onMessages(session, { messages, type }) {
    // EVERY drop below is announced. An ignored message that leaves no trace
    // is indistinguishable from one that never arrived, and telling those two
    // apart is the only way to debug "the assistant never answered me".
    // Silent `continue` statements here cost an afternoon once already.
    const ignore = (reason, detail) => this.emit('message-ignored', {
      accountId: session.accountId,
      pharmacyId: session.pharmacyId,
      reason,
      ...detail,
    });

    // Announce EVERY batch as it arrives, before any filtering.
    //
    // "The customer's message was dropped by a filter" and "the socket never
    // received it" look identical from the outside and need completely
    // different fixes. Without a log at the point of arrival there is no way
    // to tell them apart, and two debugging rounds were spent on the wrong
    // one of the two.
    this.emit('message-arrived', {
      accountId: session.accountId,
      type,
      count: messages?.length ?? 0,
      jids: (messages || []).map((m) => m.key?.remoteJid).filter(Boolean),
    });

    for (const msg of messages || []) {
      if (msg.key?.fromMe) {
        // Full key, not just the jid. A message wrongly flagged fromMe is
        // indistinguishable from a genuine own-message without seeing what
        // WhatsApp actually sent, and that distinction decides whether this
        // check is protecting us or silently eating customer traffic.
        ignore('from_me', {
          jid: msg.key?.remoteJid,
          altJid: msg.key?.remoteJidAlt,
          participant: msg.key?.participant,
          addressingMode: msg.key?.addressingMode,
          ourId: session.sock?.user?.id,
          ourLid: session.sock?.user?.lid,
          preview: (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').slice(0, 40),
        });
        continue;
      }

      const live = isLiveMessage(type, msg.messageTimestamp);
      if (!live.isLive) {
        // jid and age are the whole diagnostic value here. Without them every
        // drop logs identically and there is no way to tell "the customer's
        // message was wrongly discarded" from "someone's status update was
        // correctly discarded" — which cost a debugging round already.
        ignore('stale_backfill', {
          type,
          ageMs: live.ageMs,
          jid: msg.key?.remoteJid,
          ageMinutes: live.ageMs === null ? null : Math.round(live.ageMs / 60000),
        });
        continue;
      }

      const jid = msg.key?.remoteJid;
      // Groups, broadcasts, newsletters and bots are out of scope. A pharmacy
      // assistant replying inside a group chat broadcasts one customer's
      // medicine enquiry to everyone in it — see jidPolicy.js for why this
      // is an allowlist rather than "anything that isn't a group".
      if (!isDirectUserChat(jid)) {
        ignore('not_direct_chat', { jid, messageType: msg.message ? Object.keys(msg.message)[0] : null });
        continue;
      }

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;

      // WhatsApp addresses us by LID and puts the real number in the alt
      // field. Splitting the JID would give an opaque id that no pharmacist
      // can act on — see senderIdentity.js.
      const sender = resolveSender(msg.key, msg.pushName);

      this.emit('message', {
        accountId: session.accountId,
        pharmacyId: session.pharmacyId,
        providerMessageId: msg.key.id,
        from: jid,
        replyJid: sender.replyJid,
        // Human-recognisable. Falls back to the LID only if WhatsApp gave us
        // no number at all, so this is never null for a routable sender.
        phoneNumber: sender.phone || sender.lid,
        lid: sender.lid,
        displayName: sender.displayName,
        text,
        // Non-text messages still surface, with text:null, so the pipeline
        // can route them to a human rather than dropping them silently.
        hasMedia: Boolean(
          msg.message?.imageMessage || msg.message?.audioMessage ||
          msg.message?.documentMessage || msg.message?.videoMessage
        ),
        timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
        raw: msg,
      });
    }
  }

  /**
   * Record a status change. A database failure here is logged, never thrown.
   *
   * The socket is the source of truth for whether a session is alive; this
   * row is a projection of it for the dashboard. Letting a transient write
   * failure propagate out of a socket event handler is what crashed the
   * process once already, and it would be the wrong trade even if it were
   * safe: a live, working WhatsApp session should not be torn down because
   * Postgres was briefly slow.
   */
  async _setStatus(accountId, status, detail, disconnectCode) {
    try {
      const db = getSql();
      await db`
        update whatsapp_accounts
        set status = ${status},
            status_detail = ${detail || null},
            disconnect_reason = ${disconnectCode !== undefined ? String(disconnectCode) : null},
            last_seen_at = now(),
            updated_at = now()
        where id = ${accountId}
      `;
    } catch (err) {
      this.emit('session-error', { accountId, phase: 'setStatus', error: err });
    }
    // Emitted regardless. Listeners care about the transition, not about
    // whether we managed to persist it.
    this.emit('status', { accountId, status, detail });
  }
}

// One manager per process, matching the one-socket-per-session reality.
const sessionManager = new SessionManager();

module.exports = { sessionManager, SessionManager, needsNewSocket, isLiveMessage };
