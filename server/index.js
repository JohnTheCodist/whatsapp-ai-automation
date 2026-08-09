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
// app.use('/webhooks', require('./routes/webhooks'));               // Phase 2
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

  app.listen(env.port, () => {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'WhatsApp AI Automation API listening',
      port: env.port,
      nodeEnv: env.nodeEnv,
      channel: isChannelConfigured() ? env.channel.provider : 'not_configured',
      llm: isLlmConfigured() ? 'configured' : 'not_configured',
    }));
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error(JSON.stringify({ level: 'fatal', msg: err.message }));
    process.exit(1);
  });
}

module.exports = { app, start };
