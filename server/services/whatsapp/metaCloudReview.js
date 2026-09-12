/**
 * Meta WhatsApp Cloud API — the App Review harness.
 *
 * WHAT THIS IS. The smallest real integration with Meta's Graph API that lets
 * RxNaija demonstrate the two permissions it is asking Meta to approve:
 *
 *   whatsapp_business_messaging   → sendTestMessage()
 *   whatsapp_business_management  → createTemplate(), listTemplates()
 *
 * Every call here reaches graph.facebook.com with RxNaija's own token. Nothing
 * is mocked — a reviewer watching the video is watching the real API answer.
 *
 * WHAT THIS IS NOT. It is not a channel. It is not registered with
 * channelProvider.js, it does not touch the conversation engine, it writes
 * nothing to the database, and it has nothing to do with CHANNEL_PROVIDER.
 * Baileys keeps running exactly as before whether or not any of this is
 * configured. The production path is Twilio, built separately after review.
 *
 * WHY THE PHONE NUMBER AND WABA COME FROM ENV. whatsapp_accounts already has
 * phone_number_id and waba_id columns, but a row there means a pharmacy has
 * been onboarded onto a provider — which is exactly what this harness must not
 * do. The harness uses RxNaija's own test assets, so they are configuration.
 *
 * SECRETS. The system-user token lives only in the server environment. It is
 * sent in an Authorization header, never in a URL; it is never logged, never
 * returned, and the error mapping below never echoes a raw Graph response to
 * the caller — only messages written here, or Meta's own user-facing strings.
 */

const crypto = require('node:crypto');
const { env } = require('../../config/env');
const { normalizeMsisdn } = require('./senderIdentity');

const GRAPH_HOST = 'https://graph.facebook.com';
const GRAPH_TIMEOUT_MS = 15000;

/** WhatsApp's own ceiling for a text message body. */
const MAX_TEXT_LENGTH = 4096;
/** Meta's ceiling for a template BODY component. */
const MAX_TEMPLATE_BODY = 1024;

/** Categories a harness template may use. AUTHENTICATION has different component rules. */
const TEMPLATE_CATEGORIES = new Set(['UTILITY', 'MARKETING']);

/** The configuration this harness reads, in one place. */
function readConfig(source = env) {
  const m = source.metaCloud || {};
  return {
    token: m.systemUserToken || '',
    appSecret: m.appSecret || '',
    phoneNumberId: m.phoneNumberId || '',
    wabaId: m.wabaId || '',
    graphVersion: m.graphVersion || 'v26.0',
  };
}

/**
 * What is missing, by VARIABLE NAME only.
 *
 * Names, never values — this list is shown to the owner so they know what to
 * set, and a value in it would be a secret on a screen.
 */
function missingFor(cfg, capability) {
  const missing = [];
  if (!cfg.token) missing.push('META_SYSTEM_USER_TOKEN');
  if (capability === 'messaging' && !cfg.phoneNumberId) missing.push('META_PHONE_NUMBER_ID');
  if (capability === 'templates' && !cfg.wabaId) missing.push('META_WABA_ID');
  return missing;
}

/** Safe for the dashboard: booleans and a version string, nothing secret. */
function publicStatus(cfg = readConfig()) {
  return {
    messaging: missingFor(cfg, 'messaging').length === 0,
    templates: missingFor(cfg, 'templates').length === 0,
    graphVersion: cfg.graphVersion,
  };
}

// ---------------------------------------------------------------- input ---

/**
 * Validate a test-send request.
 *
 * The number goes through the same normaliser inbound messages use, so
 * "0803 123 4567", "+234 803 123 4567" and "2348031234567" all arrive at
 * Meta as the digits-only international form it expects.
 */
function validateRecipient(rawInput, defaultCountryCode = env.defaultCountryCode || '234') {
  const rawTo = typeof rawInput === 'string' ? rawInput.trim() : '';

  if (!rawTo) return { ok: false, error: 'Enter the WhatsApp number to send to.' };
  // Letters mean it is not a phone number at all, however the digits line up.
  if (/[a-z]/i.test(rawTo)) return { ok: false, error: 'That is not a valid phone number.' };

  const to = normalizeMsisdn(rawTo, defaultCountryCode);
  // E.164 allows at most 15 digits; below 10 there is no real subscriber number.
  if (!to || to.length > 15) {
    return { ok: false, error: 'That is not a valid phone number. Include the country code, e.g. +234 803 123 4567.' };
  }
  return { ok: true, to };
}

function validateSend(input, defaultCountryCode = env.defaultCountryCode || '234') {
  const recipient = validateRecipient(input?.to, defaultCountryCode);
  if (!recipient.ok) return recipient;
  const { to } = recipient;
  const message = typeof input?.message === 'string' ? input.message.trim() : '';

  if (!message) return { ok: false, error: 'Enter a message to send.' };
  if (message.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `The message is too long — WhatsApp allows up to ${MAX_TEXT_LENGTH} characters.` };
  }

  return { ok: true, to, message };
}

/**
 * Validate a request to send an APPROVED template to somebody.
 *
 * Separate from validateTemplate, which checks a template being CREATED. Here
 * the template already exists on the account and only its name and language
 * are sent, so the rules are the naming rules and nothing about the body.
 */
function validateTemplateSend(input, defaultCountryCode = env.defaultCountryCode || '234') {
  const recipient = validateRecipient(input?.to, defaultCountryCode);
  if (!recipient.ok) return recipient;

  const templateName = typeof input?.templateName === 'string' ? input.templateName.trim() : '';
  const language = typeof input?.language === 'string' ? input.language.trim() : '';

  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    return { ok: false, error: 'Choose a template to send.' };
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) {
    return { ok: false, error: 'The template language must be a WhatsApp language code, e.g. en_US.' };
  }

  return { ok: true, to: recipient.to, templateName, language };
}

/**
 * Validate a template-creation request against Meta's rules, before Meta has
 * to reject it.
 *
 * Variables ({{1}}) are refused rather than supported: Meta requires an
 * example value for every one, which is a second form this harness does not
 * need in order to demonstrate the permission.
 */
function validateTemplate(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const category = typeof input?.category === 'string' ? input.category.trim().toUpperCase() : '';
  const language = typeof input?.language === 'string' ? input.language.trim() : '';
  const body = typeof input?.body === 'string' ? input.body.trim() : '';

  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    return { ok: false, error: 'Template name must use only lowercase letters, numbers and underscores, e.g. rxnaija_order_ready.' };
  }
  if (!TEMPLATE_CATEGORIES.has(category)) {
    return { ok: false, error: 'Category must be UTILITY or MARKETING.' };
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) {
    return { ok: false, error: 'Language must be a WhatsApp language code, e.g. en or en_US.' };
  }
  if (!body) return { ok: false, error: 'Enter the message body.' };
  if (body.length > MAX_TEMPLATE_BODY) {
    return { ok: false, error: `The message body is too long — templates allow up to ${MAX_TEMPLATE_BODY} characters.` };
  }
  if (/\{\{\s*\d+\s*\}\}/.test(body)) {
    return { ok: false, error: 'Variables like {{1}} are not supported on this test screen. Use fixed text.' };
  }

  return { ok: true, name, category, language, body };
}

// ------------------------------------------------------------ Meta errors ---

class MetaError extends Error {
  constructor(message, status, detail = {}) {
    super(message);
    this.name = 'MetaError';
    this.status = status;
    this.detail = detail; // for server logs only — never sent to the client
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);

/**
 * A Graph API error body → a message an owner can act on.
 *
 * Every branch writes its own sentence. Meta's raw `message` is only passed
 * through where it describes the request itself (a bad parameter) — and even
 * then Meta's dedicated user-facing string wins when it sent one.
 */
function toSafeError(httpStatus, body) {
  const e = body?.error || {};
  const code = Number(e.code);
  const subcode = Number(e.error_subcode);
  const userMsg = e.error_user_msg || e.error_user_title || '';
  const detail = {
    httpStatus, code: e.code, subcode: e.error_subcode, type: e.type, fbtraceId: e.fbtrace_id,
  };

  if (code === 190) {
    return new MetaError(
      'The Meta access token is invalid or has expired. Generate a new system-user token and update META_SYSTEM_USER_TOKEN.',
      502, detail,
    );
  }
  if (code === 10 || (code >= 200 && code <= 299)) {
    return new MetaError(
      'The Meta token does not have permission for this. Check it includes whatsapp_business_messaging and whatsapp_business_management.',
      502, detail,
    );
  }
  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429) {
    return new MetaError('Meta is rate-limiting requests right now. Wait a minute and try again.', 429, detail);
  }
  if (code === 131030) {
    return new MetaError(
      'This number is not on your test number\'s allowed list. Add it in Meta for Developers → WhatsApp → API Setup → "To", then try again.',
      400, detail,
    );
  }
  if (code === 131047) {
    return new MetaError(
      'WhatsApp only allows free-form messages within 24 hours of the recipient messaging you. Send any message from that phone to your business number, then try again.',
      400, detail,
    );
  }
  if (code === 131026) {
    return new MetaError('WhatsApp could not deliver to that number. Check it is registered on WhatsApp.', 400, detail);
  }
  if (code === 100 && subcode === 33) {
    return new MetaError(
      'Meta could not find that phone number ID or WhatsApp Business Account, or this token cannot access it. Check META_PHONE_NUMBER_ID and META_WABA_ID.',
      502, detail,
    );
  }
  if (code === 100 || code === 131008 || code === 131009) {
    const why = userMsg || e.message;
    return new MetaError(why ? `Meta rejected the request: ${why}` : 'Meta rejected the request as invalid.', 400, detail);
  }

  return new MetaError(
    userMsg ? `Meta returned an error: ${userMsg}` : 'Meta returned an unexpected error. Try again in a moment.',
    502, detail,
  );
}

// ---------------------------------------------------------------- Graph ---

/**
 * appsecret_proof — HMAC-SHA256 of the token keyed by the app secret.
 *
 * Sent whenever the secret is configured. With "Require App Secret" switched
 * on in the Meta app, a token lifted from a log or a proxy is useless without
 * the secret, which never leaves this server.
 */
function appSecretProof(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

/**
 * One Graph API call. Returns parsed JSON or throws MetaError.
 *
 * @param {string} path      e.g. `/123/messages` — no host, no version
 * @param {object} options   { method, body, query }
 * @param {object} deps      { cfg, fetchImpl, log }
 */
async function graph(path, { method = 'GET', body, query = {} } = {}, { cfg, fetchImpl = fetch, log = console } = {}) {
  const params = new URLSearchParams(query);
  if (cfg.appSecret) params.set('appsecret_proof', appSecretProof(cfg.token, cfg.appSecret));
  const qs = params.toString();
  const url = `${GRAPH_HOST}/${cfg.graphVersion}${path}${qs ? `?${qs}` : ''}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch (err) {
    // The path, not the URL: the URL can carry appsecret_proof.
    log.error(JSON.stringify({ level: 'error', msg: 'meta graph unreachable', method, path, error: err.name }));
    throw new MetaError('Could not reach Meta. Check the server\'s internet connection and try again.', 502);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok || json?.error) {
    const safe = toSafeError(res.status, json);
    // Technical detail server-side: enough to look the failure up with Meta
    // (fbtrace_id), never the token, never the full response body.
    log.error(JSON.stringify({
      level: 'warn', msg: 'meta graph error', method, path, ...safe.detail,
      metaMessage: json?.error?.message || null,
    }));
    throw safe;
  }
  if (!json) throw new MetaError('Meta sent back a response that could not be read.', 502);
  return json;
}

function notConfigured(cfg, capability) {
  const missing = missingFor(cfg, capability);
  return missing.length
    ? { success: false, status: 503, error: `The Meta test integration is not configured. Set ${missing.join(' and ')} on the server.` }
    : null;
}

function failure(err, log) {
  if (err instanceof MetaError) return { success: false, status: err.status, error: err.message };
  log.error(JSON.stringify({ level: 'error', msg: 'meta harness failure', error: err?.message }));
  return { success: false, status: 500, error: 'Something went wrong on our side. Nothing was sent.' };
}

// ---------------------------------------------------------- operations ---

/** whatsapp_business_messaging — send one text message. */
async function sendTestMessage(input, { cfg = readConfig(), fetchImpl = fetch, log = console } = {}) {
  const blocked = notConfigured(cfg, 'messaging');
  if (blocked) return blocked;

  const v = validateSend(input);
  if (!v.ok) return { success: false, status: 400, error: v.error };

  try {
    const json = await graph(`/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: v.to,
        type: 'text',
        text: { body: v.message },
      },
    }, { cfg, fetchImpl, log });

    const messageId = json?.messages?.[0]?.id;
    if (!messageId) throw new MetaError('Meta accepted the request but returned no message ID.', 502);
    return { success: true, status: 200, messageId };
  } catch (err) {
    return failure(err, log);
  }
}

/**
 * whatsapp_business_messaging — send an APPROVED template to somebody.
 *
 * WHY THIS EXISTS ALONGSIDE THE TEXT SEND. WhatsApp only delivers free-form
 * text within 24 hours of the recipient last writing to the business, and
 * outside that window Meta ACCEPTS the send, returns a message id, and then
 * fails it asynchronously with error 131047 — which arrives on a webhook this
 * harness does not have. So a text send can report success on screen and
 * deliver nothing, which is a poor thing to discover halfway through
 * recording an App Review video. A template has no such window.
 *
 * Templates carrying variables are not supported here: Meta requires a
 * parameter for each, and a template with no variables (hello_world, and the
 * ones this screen creates) needs none.
 */
async function sendTemplateMessage(input, { cfg = readConfig(), fetchImpl = fetch, log = console } = {}) {
  const blocked = notConfigured(cfg, 'messaging');
  if (blocked) return blocked;

  const v = validateTemplateSend(input);
  if (!v.ok) return { success: false, status: 400, error: v.error };

  try {
    const json = await graph(`/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: v.to,
        type: 'template',
        template: { name: v.templateName, language: { code: v.language } },
      },
    }, { cfg, fetchImpl, log });

    const messageId = json?.messages?.[0]?.id;
    if (!messageId) throw new MetaError('Meta accepted the request but returned no message ID.', 502);
    return { success: true, status: 200, messageId };
  } catch (err) {
    return failure(err, log);
  }
}

/** whatsapp_business_management — submit a template for review. */
async function createTemplate(input, { cfg = readConfig(), fetchImpl = fetch, log = console } = {}) {
  const blocked = notConfigured(cfg, 'templates');
  if (blocked) return blocked;

  const v = validateTemplate(input);
  if (!v.ok) return { success: false, status: 400, error: v.error };

  try {
    const json = await graph(`/${encodeURIComponent(cfg.wabaId)}/message_templates`, {
      method: 'POST',
      body: {
        name: v.name,
        category: v.category,
        language: v.language,
        components: [{ type: 'BODY', text: v.body }],
      },
    }, { cfg, fetchImpl, log });

    return {
      success: true,
      status: 200,
      template: { id: json.id || null, name: v.name, status: json.status || 'PENDING', category: json.category || v.category },
    };
  } catch (err) {
    return failure(err, log);
  }
}

/** whatsapp_business_management — list the account's templates. */
async function listTemplates({ cfg = readConfig(), fetchImpl = fetch, log = console } = {}) {
  const blocked = notConfigured(cfg, 'templates');
  if (blocked) return blocked;

  try {
    const json = await graph(`/${encodeURIComponent(cfg.wabaId)}/message_templates`, {
      query: { fields: 'name,status,category,language', limit: '50' },
    }, { cfg, fetchImpl, log });

    // Only the four fields the screen shows — never the raw Graph object.
    const templates = (Array.isArray(json?.data) ? json.data : []).map((t) => ({
      id: t.id || null,
      name: t.name || '',
      status: t.status || '',
      category: t.category || '',
      language: t.language || '',
    }));
    return { success: true, status: 200, templates };
  } catch (err) {
    return failure(err, log);
  }
}

module.exports = {
  readConfig,
  publicStatus,
  validateRecipient,
  validateSend,
  validateTemplateSend,
  validateTemplate,
  sendTemplateMessage,
  toSafeError,
  appSecretProof,
  sendTestMessage,
  createTemplate,
  listTemplates,
  MetaError,
  MAX_TEXT_LENGTH,
};
