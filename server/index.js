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
// ---------------------------------------------------------------------
// Shell badge counts.
//
// Exists because the dashboard shell was polling /api/conversations AND
// /api/orders every 10s purely to read two integers off responses the tabs
// were already fetching — doubling the query load to display two numbers.
// Together with over-eager tab polling that exhausted Supabase's 15-client
// session pooler, which surfaced as ENOTFOUND and ECONNRESET everywhere and
// looked like a network fault.
//
// Two counts, two indexed queries, no joins, no payload.
// ---------------------------------------------------------------------
app.get('/api/summary', require('./middleware/auth').requireAuth, async (req, res, next) => {
  try {
    const { getSql, assertPharmacyId } = require('./services/db');
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const [row] = await db`
      select
        (select count(*)::int from handoffs
           where pharmacy_id = ${req.pharmacyId} and resolved_at is null) as open_handoffs,
        (select count(*)::int from orders
           where pharmacy_id = ${req.pharmacyId} and status = 'pending') as pending_orders,
        (select count(*)::int from product_requests
           where pharmacy_id = ${req.pharmacyId} and status = 'open') as open_requests
    `;
    res.json(row);
  } catch (err) {
    next(err);
  }
});

app.use('/api/overview', require('./routes/overview'));       // dashboard
app.use('/api/pharmacies', require('./routes/pharmacies'));  // Phase 1
app.use('/api/whatsapp', require('./routes/whatsapp'));      // Phase 2
app.use('/api/catalogue', require('./routes/catalogue'));    // Phase 3
app.use('/api/conversations', require('./routes/conversations')); // Phase 4 — staff inbox
app.use('/api/requests', require('./routes/requests'));      // pharmacist alternatives
app.use('/api/customers', require('./routes/customers'));    // patient identity list
app.use('/api/orders', require('./routes/orders'));               // Phase 5 — order queue

app.use(notFound);
app.use(errorHandler);

/**
 * A stray promise rejection must not disconnect every pharmacy.
 *
 * This process holds a live WhatsApp socket per tenant. Node's default is to
 * treat an unhandled rejection as fatal, which means one slow database query
 * on one request ends every session in the process — and that has now
 * happened twice, from two different error paths.
 *
 * So it is logged loudly and the process survives. This is NOT a licence to
 * ignore them: an unhandled rejection is always a bug in the code that
 * produced it, and both of the ones seen so far were fixed at the source.
 * This only stops a local mistake becoming a total outage.
 *
 * uncaughtException is deliberately NOT handled the same way. A rejected
 * promise usually leaves the process coherent; a thrown exception escaping
 * the stack does not, and continuing on unknown state is worse than
 * restarting — session restore takes about four seconds.
 */
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: 'unhandled promise rejection — process kept alive to preserve live sessions',
    error: reason?.message || String(reason),
    stack: reason?.stack?.split('\n').slice(0, 4).join(' | '),
  }));
});

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
    console.log(JSON.stringify({
      level: 'info',
      msg: 'inbound accepted',
      from: msg.phoneNumber,
      hasText: Boolean(msg.text),
      hasMedia: msg.hasMedia,
      providerMessageId: msg.providerMessageId,
    }));
    ingest(msg)
      .then((r) => console.log(JSON.stringify({
        level: 'info', msg: 'inbound ingested', stored: r.stored, reason: r.reason || null, messageId: r.messageId || null,
      })))
      .catch((err) => {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'inbound ingest failed',
          accountId: msg.accountId,
          providerMessageId: msg.providerMessageId,
          error: err.message,
        }));
      });
  });

  // Every message the manager declines to process says so. A drop that
  // leaves no trace is indistinguishable from a message that never arrived,
  // and that ambiguity is what makes "the assistant never answered me"
  // impossible to investigate.
  // Logged before any filtering runs, so "never arrived" is distinguishable
  // from "arrived and was dropped".
  sessionManager.on('message-arrived', (e) => {
    console.log(JSON.stringify({
      level: 'info', msg: 'upsert arrived', type: e.type, count: e.count, jids: e.jids,
    }));
  });

  sessionManager.on('message-ignored', (e) => {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'inbound ignored',
      accountId: e.accountId,
      reason: e.reason,
      jid: e.jid,
      type: e.type,
      messageType: e.messageType,
      count: e.count,
      // How old the message claimed to be. The difference between a
      // wrongly-dropped live message and a correctly-dropped old one is
      // entirely in this number, so omitting it made the log useless for the
      // one question anybody asks it.
      ageMinutes: e.ageMinutes,
      altJid: e.altJid,
      participant: e.participant,
      addressingMode: e.addressingMode,
      ourId: e.ourId,
      ourLid: e.ourLid,
      preview: e.preview,
    }));
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

  if (env.worker.enabled) {
    require('./services/worker').start();
  } else {
    console.log(JSON.stringify({ level: 'info', msg: 'job worker disabled (WORKER_ENABLED=false)' }));
  }

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
