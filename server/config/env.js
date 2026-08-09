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
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  isProduction: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL,

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  // Channel provider. `provider` selects which adapter loads; the rest is
  // provider-specific and validated by that adapter, not here, so adding a
  // second provider doesn't mean editing this file.
  channel: {
    provider: process.env.CHANNEL_PROVIDER || 'twilio',
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
  if (env.channel.provider === 'twilio') {
    return Boolean(env.channel.twilio.accountSid && env.channel.twilio.authToken);
  }
  return false;
}

function isLlmConfigured() {
  return Boolean(env.llm.apiKey);
}

module.exports = { env, assertRequiredEnv, isChannelConfigured, isLlmConfigured };
