/**
 * Environment loader — fails fast and loudly at boot.
 *
 * The alternative (reading process.env.FOO inline wherever it's needed) is
 * how you discover a missing WhatsApp credential at 9pm, from a customer,
 * three days after deploy. Everything required is declared here and checked
 * once, before the server accepts a request.
 *
 * IMPORTANT — the check runs in assertRequiredEnv(), called from start() in
 * index.js. It deliberately does NOT run on import.
 *
 * A module that throws while being imported poisons everything that
 * transitively requires it: a unit test for a pure string validator three
 * modules downstream cannot even load the file without a production
 * database URL in scope. That pressure is what makes people stop writing
 * tests. Boot-time validation gives the same protection — the server still
 * refuses to start misconfigured — without making the whole dependency
 * graph unloadable.
 *
 * Optional vars degrade explicitly: the feature that needs them reports
 * itself unavailable rather than throwing at call time.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const REQUIRED = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  // Required, not optional, from the moment Baileys is the channel: without
  // it no WhatsApp session can be persisted at all. Booting without it would
  // mean discovering the problem when a pharmacy tries to pair.
  'SESSION_ENCRYPTION_KEY',
];

/** Throws unless every required variable is present. Call once, at boot. */
function assertRequiredEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      `Copy server/.env.example to server/.env and fill them in.`
    );
  }

  // DEV_AUTH_BYPASS disables authentication entirely. It exists so the
  // WhatsApp pairing flow can be exercised locally without standing up a
  // sign-in UI first. In production it would mean anyone on the internet
  // acting as a pharmacy.
  //
  // Refusing to boot is the point. A warning would be read once and ignored;
  // a dead process gets fixed. This is the only correct behaviour for a flag
  // whose failure mode is "no authentication at all".
  if (process.env.DEV_AUTH_BYPASS === 'true' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'DEV_AUTH_BYPASS=true with NODE_ENV=production. Refusing to start.\n' +
      'This flag disables authentication completely. Remove it from the production environment.'
    );
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  isProduction: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL,

  // Applied when a locally-formatted number (leading 0) is normalised.
  // Nigeria by default because that is the launch market; it is a config
  // value rather than a constant so the allowlist does not quietly stop
  // matching the first time this is sold elsewhere.
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '234',
  // ISO 3166-1 alpha-2, NOT the dialing code above. libphonenumber-js needs
  // the country to interpret a locally-written number ("08012345678"), and
  // passing '234' where it expects 'NG' fails by returning null for every
  // local number rather than by raising — so the two are kept as separate,
  // obviously-different values instead of one being derived from the other.
  defaultCountry: process.env.DEFAULT_COUNTRY || 'NG',

  // Local testing only. Never true in production — assertRequiredEnv()
  // refuses to boot rather than allowing it.
  devAuthBypass: process.env.DEV_AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production',

  /**
   * Permission for a NON-production process to open a real WhatsApp socket.
   *
   * WHAT THIS PREVENTS
   * server/.env points at the production database, because that is what makes
   * local development useful. But WhatsApp credentials live in that database,
   * so any locally-started server restores the live session on boot and opens
   * a second socket for the pharmacy's number. WhatsApp permits one: it knocks
   * the production socket off with connectionReplaced (440), and
   * disconnectPolicy correctly refuses to fight back.
   *
   * The pharmacy is then offline until a person notices. Nothing crashes,
   * nothing alerts — customers message a number that no longer answers, which
   * is the worst shape a failure can take in a messaging product.
   *
   * This is not hypothetical. It happened during development: a local server
   * was started to check an unrelated route, and it took the live pharmacy
   * down.
   *
   * Default OFF, so the safe thing needs no thought and the dangerous thing
   * needs a deliberate flag.
   */
  allowLocalWhatsApp: process.env.ALLOW_LOCAL_WHATSAPP === 'true',

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  // Channel provider. `provider` selects which adapter loads; the rest is
  // provider-specific and validated by that adapter, not here, so adding a
  // second provider doesn't mean editing this file.
  channel: {
    provider: process.env.CHANNEL_PROVIDER || 'baileys',
    baileys: {
      // Datacenter IPs are a reported ban signal (ARCHITECTURE.md §6.2).
      // TWO agents are needed: `agent` covers the socket, `fetchAgent`
      // covers media upload/download. Setting only the first still leaks
      // the host IP on every image a pharmacy sends or receives.
      proxyUrl: process.env.BAILEYS_PROXY_URL || '',
      // Human-like reply latency. Instant replies at all hours are a
      // machine signature; this is a safety control, not a UX nicety.
      minReplyDelayMs: parseInt(process.env.BAILEYS_MIN_REPLY_DELAY_MS || '1000', 10),
      maxReplyDelayMs: parseInt(process.env.BAILEYS_MAX_REPLY_DELAY_MS || '3000', 10),
      // Baileys' sendMessage has no timeout of its own. On a half-open socket
      // — one that still reports `connected` because the TCP connection was
      // never cleanly torn down — it waits forever. That hung one worker on a
      // single reply and, because nothing reclaims a job stuck in 'running',
      // silently stopped every reply for that pharmacy with no error logged.
      //
      // 30s: comfortably longer than a healthy send (sub-second) plus the
      // human-latency delay above, short enough that a dead socket surfaces
      // while the customer is still in the conversation.
      sendTimeoutMs: parseInt(process.env.BAILEYS_SEND_TIMEOUT_MS || '30000', 10),
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      // Used to verify the X-Twilio-Signature on inbound webhooks. Must be
      // the exact public URL the provider is configured to POST to,
      // including scheme and any proxy path — a mismatch fails every
      // signature check with no other symptom.
      webhookUrl: process.env.TWILIO_WEBHOOK_URL || '',
    },
  },

  llm: {
    apiKey: process.env.LLM_API_KEY || '',
    apiUrl: process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '20000', 10),
  },

  // Worker loop. In MVP the worker runs in-process; set WORKER_ENABLED=false
  // on any extra web dyno so only one process claims jobs.
  worker: {
    enabled: process.env.WORKER_ENABLED !== 'false',
    pollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '2000', 10),
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '2', 10),
  },
};

function isChannelConfigured() {
  if (env.channel.provider === 'baileys') {
    // Baileys needs no provider credentials — that is the point of it. The
    // only hard requirement is somewhere to put session credentials, and
    // assertRequiredEnv already guarantees that at boot.
    return Boolean(process.env.SESSION_ENCRYPTION_KEY);
  }
  if (env.channel.provider === 'twilio') {
    return Boolean(env.channel.twilio.accountSid && env.channel.twilio.authToken);
  }
  return false;
}

function isLlmConfigured() {
  return Boolean(env.llm.apiKey);
}

module.exports = { env, assertRequiredEnv, isChannelConfigured, isLlmConfigured };
