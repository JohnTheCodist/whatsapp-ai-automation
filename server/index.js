/**
 * WhatsApp AI Automation — API entry point.
 *
 * Modular monolith: one Node process, clear module boundaries inside it.
 * Not microservices, because at this stage every "service" would share one
 * database and one deploy anyway — all the operational cost, none of the
 * independence.
 *
 * SCAFFOLD STATE: routes are mounted as they are built. Only /api/health
 * and the webhook stub exist today; see ARCHITECTURE.md for the phase plan.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { env, assertRequiredEnv, isChannelConfigured, isLlmConfigured } = require('./config/env');
const { ping } = require('./services/db');
const { requestId, notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(requestId);
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

// Webhook routes need the RAW body to verify a provider signature — a
// parsed-and-restringified body will not reproduce the bytes the provider
// signed. So JSON parsing is mounted for /api only, and the webhook router
// applies its own raw/urlencoded parser.
app.use('/api', express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------
// Health — unauthenticated on purpose (load balancers can't log in).
// Reports dependency readiness without leaking configuration values.
// ---------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  let database = 'down';
  try {
    await ping();
    database = 'up';
  } catch {
    database = 'down';
  }
  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    dependencies: {
      database,
      channel: isChannelConfigured() ? 'configured' : 'not_configured',
      llm: isLlmConfigured() ? 'configured' : 'not_configured',
    },
  });
});

// ---------------------------------------------------------------------
// Route mounts — added per phase. Kept as explicit anchors so the intended
// surface is visible without hunting through the docs.
//
// Auth is applied per-route inside each router rather than as a blanket
// app.use('/api', requireAuth). Blanket gates need an ever-growing exempt
// list (health, webhooks, tenant creation), and an exempt list is a place
// where a route quietly ends up unauthenticated. Per-route is verbose and
// hard to get wrong; that trade is worth it here.
// ---------------------------------------------------------------------
app.use('/api/pharmacies', require('./routes/pharmacies'));  // Phase 1
app.use('/api/whatsapp', require('./routes/whatsapp'));      // Phase 2
// app.use('/api/catalogue', require('./routes/catalogue'));         // Phase 3
// app.use('/api/conversations', require('./routes/conversations')); // Phase 4
// app.use('/api/orders', require('./routes/orders'));               // Phase 5

app.use(notFound);
app.use(errorHandler);

async function start() {
  // Fail at boot, not on the first customer message. Config first, so a
  // missing DATABASE_URL reports itself as missing config rather than as
  // a confusing connection error.
  assertRequiredEnv();
  await ping();

  if (env.devAuthBypass) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'DEV_AUTH_BYPASS IS ON — every API route is unauthenticated. Local use only.',
    }));
  }

  // Restore sessions that were live when this process last stopped. Not
  // awaited: a slow or unreachable session must not stop the API from
  // accepting requests, and the dashboard is how anyone would diagnose it.
  const { sessionManager } = require('./services/whatsapp/sessionManager');
  const { ingest } = require('./services/whatsapp/inboundIngest');

  // Every inbound message becomes durable rows before anything interprets
  // it. Nothing retries on our behalf under Baileys, so a message dropped
  // here is a customer ignored with no trace.
  sessionManager.on('message', (msg) => {
    ingest(msg).catch((err) => {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'inbound ingest failed',
        accountId: msg.accountId,
        providerMessageId: msg.providerMessageId,
        error: err.message,
      }));
    });
  });

  // Failures inside the manager are reported on 'session-error', never on
  // the reserved 'error' name — see sessionManager's constructor.
  sessionManager.on('session-error', (e) => {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'session error',
      accountId: e.accountId,
      phase: e.phase,
      error: e.error?.message || String(e.error),
    }));
  });

  sessionManager.start().then((n) => {
    if (n > 0) console.log(JSON.stringify({ level: 'info', msg: 'restoring whatsapp sessions', count: n }));
  }).catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'session restore failed', error: err.message }));
  });

  const server = app.listen(env.port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'WhatsApp AI Automation API listening',
      port: env.port,
      nodeEnv: env.nodeEnv,
      channel: isChannelConfigured() ? env.channel.provider : 'not_configured',
      llm: isLlmConfigured() ? 'configured' : 'not_configured',
    }));
  });

  // Close sockets deliberately on shutdown. Without this they die as an
  // abrupt drop, which the next boot has to recover from as if it were a
  // fault rather than a planned restart.
  const shutdown = async (signal) => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    server.close();
    await sessionManager.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error(JSON.stringify({ level: 'fatal', msg: err.message }));
    process.exit(1);
  });
}

module.exports = { app, start };
