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

// Baileys is chatty at info level and every line is protocol noise. Warnings
// and errors are worth having; the rest is not, and drowning real problems is
// how they get missed.
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

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

class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} accountId -> session record */
    this.sessions = new Map();
    this.stopping = false;
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
        this.emit('error', { accountId: row.id, phase: 'restore', error: err });
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
    if (existing && existing.sock && !existing.closed) return existing;

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
      // Identifies the linked device in the pharmacy's WhatsApp app. They
      // will see this string, so it should be recognisably us.
      browser: Browsers.appropriate('Desktop'),
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
        this.emit('error', { accountId, phase: 'saveCreds', error: err });
      }
    });

    sock.ev.on('connection.update', (update) => {
      this._onConnectionUpdate(session, update).catch((err) => {
        this.emit('error', { accountId, phase: 'connection.update', error: err });
      });
    });

    sock.ev.on('messages.upsert', (payload) => {
      this._onMessages(session, payload).catch((err) => {
        this.emit('error', { accountId, phase: 'messages.upsert', error: err });
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

    session.pairingPhoneNumber = digits;
    const code = await session.sock.requestPairingCode(digits);

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

  async _onConnectionUpdate(session, update) {
    const { connection, lastDisconnect } = update;
    const { accountId } = session;

    if (connection === 'open') {
      session.attempts = 0;
      const db = getSql();
      // The number is only knowable once the socket is up — under Baileys we
      // learn it from WhatsApp rather than being told it during signup.
      const number = session.sock?.user?.id?.split(':')[0] || null;
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
    const decision = classifyDisconnect(statusCode);

    await this._setStatus(accountId, decision.status, decision.detail, statusCode);

    if (decision.clearAuth) {
      try {
        await session.auth.clear();
      } catch (err) {
        this.emit('error', { accountId, phase: 'clearAuth', error: err });
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
        this.emit('error', { accountId, phase: 'reconnect', error: err });
      });
    }, wait);
  }

  async _onMessages(session, { messages, type }) {
    // 'notify' is a genuinely new message. 'append' is history backfill —
    // replying to those would mean answering questions the pharmacy already
    // handled, possibly days ago.
    if (type !== 'notify') return;

    for (const msg of messages || []) {
      if (msg.key?.fromMe) continue;

      const jid = msg.key?.remoteJid;
      // Groups, broadcasts, newsletters and bots are out of scope. A pharmacy
      // assistant replying inside a group chat broadcasts one customer's
      // medicine enquiry to everyone in it — see jidPolicy.js for why this
      // is an allowlist rather than "anything that isn't a group".
      if (!isDirectUserChat(jid)) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;

      this.emit('message', {
        accountId: session.accountId,
        pharmacyId: session.pharmacyId,
        providerMessageId: msg.key.id,
        from: jid,
        phoneNumber: jid.split('@')[0],
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

  async _setStatus(accountId, status, detail, disconnectCode) {
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
    this.emit('status', { accountId, status, detail });
  }
}

// One manager per process, matching the one-socket-per-session reality.
const sessionManager = new SessionManager();

module.exports = { sessionManager, SessionManager };
