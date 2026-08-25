/**
 * Authentication + tenant resolution.
 *
 * THE ONE RULE: req.pharmacyId is derived from a verified session and a
 * real membership row. It is never read from the request body, a query
 * param, or an unverified header. A client that could name its own tenant
 * is a client that could read another pharmacy's customers.
 *
 * An X-Pharmacy-Id header IS accepted — but only as a *selection* among
 * memberships the caller provably has. A header naming a pharmacy the
 * caller does not belong to is rejected outright, never honoured. That
 * keeps a future multi-pharmacy switcher from needing this file rewritten,
 * without weakening anything today.
 *
 * The selection rule lives in selectTenant() below as a pure function, on
 * purpose. It is the single most security-critical decision in the
 * codebase, and a pure function is one that can be tested exhaustively
 * without a database, a network, or a mock — see tests/selectTenant.test.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { env } = require('../config/env');
const { getSql, readWithRetry } = require('../services/db');

let supabase = null;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return supabase;
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Decide which of the caller's memberships this request operates on.
 *
 * PURE. No IO. Every branch is a security decision:
 *
 *   - No memberships          → 403. Cannot act on a tenant you have none of.
 *   - No header               → first membership. v1 has no switcher.
 *   - Header matches one      → that membership.
 *   - Header matches none     → 403, NOT 404. Telling a caller whether a
 *                               tenant id exists is itself a disclosure.
 *   - Header is not a string  → 403. Node joins duplicate headers into
 *                               "a, b"; a caller sending the header twice
 *                               must not get a lucky match.
 *
 * UUID comparison is case-insensitive because Postgres treats uuid that
 * way — the same id in different case is the same id, and rejecting it
 * would be a bug, not a defence.
 *
 * @param {Array<{pharmacy_id:string, role:string, status:string}>} memberships
 * @param {unknown} requestedId  raw header value, untrusted
 * @returns {{ok:true, membership:object} | {ok:false, status:number, code:string, error:string}}
 */
function selectTenant(memberships, requestedId) {
  if (!Array.isArray(memberships) || memberships.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'NO_MEMBERSHIP',
      error: 'No pharmacy membership. Create a pharmacy first.',
    };
  }

  // Absent header: no preference, take the first membership.
  if (requestedId === undefined || requestedId === null) {
    return { ok: true, membership: memberships[0] };
  }

  // Present but not a string — an array, a number, an object. Refuse
  // rather than coerce; a value we cannot read is not a value we can
  // authorise against.
  if (typeof requestedId !== 'string') {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_TENANT',
      error: 'Not a member of that pharmacy',
    };
  }

  const wanted = requestedId.trim().toLowerCase();

  // Empty or whitespace-only is as good as absent.
  if (wanted === '') {
    return { ok: true, membership: memberships[0] };
  }

  const match = memberships.find(
    (m) => typeof m.pharmacy_id === 'string' && m.pharmacy_id.toLowerCase() === wanted
  );

  if (!match) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_TENANT',
      error: 'Not a member of that pharmacy',
    };
  }

  return { ok: true, membership: match };
}

/**
 * How long to wait for Supabase to confirm a token before giving up.
 *
 * This is a network call to a third party, and it sits in front of EVERY
 * authenticated request. Unbounded, a slow Supabase does not degrade the
 * dashboard — it hangs it completely, with no error anywhere: the browser
 * eventually reports ERR_TIMED_OUT on every /api call at once, which reads as
 * "the server is down" while /api/health answers in a second, because health
 * carries no token and never reaches this line.
 *
 * Eight seconds is far longer than the call takes when anything is working,
 * and short enough that a failure is reported rather than sat through.
 */
const AUTH_VERIFY_TIMEOUT_MS = 8000;

async function verifyUser(req, res) {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header', code: 'NO_TOKEN' });
    return null;
  }

  let data;
  let error;
  // Cleared in `finally`, not unref'd. unref stops the timer holding the event
  // loop open, which is right for a long-lived server and wrong everywhere
  // else: in a script whose only pending work IS this call, the process simply
  // exits before the timeout can fire, and the request neither succeeds nor
  // fails. Clearing it is correct in both cases and leaks nothing either way.
  let timer;
  try {
    ({ data, error } = await Promise.race([
      getSupabase().auth.getUser(token),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('auth_verify_timeout')), AUTH_VERIFY_TIMEOUT_MS);
      }),
    ]));
  } catch (err) {
    if (err.message === 'auth_verify_timeout') {
      // 503, NOT 401. "Your session is invalid" would be a lie that makes
      // people sign in again — and signing in goes through the same service
      // that has just stopped answering, so it cannot work and they learn
      // nothing from trying.
      res.status(503).json({
        error: 'Could not confirm your sign-in — the authentication service is not responding. Nothing was changed. Try again shortly.',
        code: 'AUTH_UNAVAILABLE',
      });
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (error || !data?.user) {
    res.status(401).json({ error: 'Invalid or expired session', code: 'BAD_TOKEN' });
    return null;
  }
  return data.user;
}

async function getMemberships(userId) {
  const db = getSql();
  // readWithRetry: this runs on every authenticated request. A dead-on-handoff
  // pooled connection here otherwise surfaces as "signed in, but the dashboard
  // never loads" — indistinguishable from a real outage to whoever hits it,
  // and it is a plain read, so a retry cannot duplicate anything.
  return readWithRetry(() => db`
    select m.pharmacy_id, m.role, p.name, p.status
    from pharmacy_members m
    join pharmacies p on p.id = m.pharmacy_id
    where m.user_id = ${userId}
    order by m.created_at
  `);
}

/** Valid session required. No membership required — for pharmacy creation. */
async function requireAuthOnly(req, res, next) {
  try {
    const user = await verifyUser(req, res);
    if (!user) return;
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Local-testing shortcut. Resolves to the first pharmacy in the database,
 * creating one if none exists, with NO credential check whatsoever.
 *
 * Gated twice: `env.devAuthBypass` is already false unless NODE_ENV is
 * non-production, and assertRequiredEnv() refuses to boot if the flag is set
 * in production. It also logs on every single request, because a bypass that
 * runs silently is one somebody forgets is on.
 */
async function devBypass(req, res, next) {
  const db = getSql();
  let [row] = await db`select id, name from pharmacies order by created_at limit 1`;

  if (!row) {
    const [created] = await db`
      insert into pharmacies (name, slug, status)
      values ('Dev Pharmacy', ${'dev-pharmacy-' + Date.now()}, 'onboarding')
      returning id, name
    `;
    row = created;
  }

  console.warn(JSON.stringify({
    level: 'warn',
    msg: 'DEV_AUTH_BYPASS active — request served with no authentication',
    path: req.originalUrl,
    pharmacyId: row.id,
  }));

  req.user = { id: '00000000-0000-0000-0000-000000000000', email: 'dev@localhost' };
  req.pharmacyId = row.id;
  req.pharmacyRole = 'owner';
  req.pharmacyStatus = 'onboarding';
  req.memberships = [{ pharmacy_id: row.id, role: 'owner', name: row.name }];
  next();
}

/** Valid session AND a real membership. The default for every tenant route. */
async function requireAuth(req, res, next) {
  try {
    // AWAITED, not returned bare. `return devBypass(...)` hands back a promise
    // nothing is watching: Express 4 does not catch async middleware
    // rejections, so a database timeout in here became an unhandled rejection
    // and killed the process — taking every pharmacy's live WhatsApp socket
    // with it. Measured, not hypothetical.
    if (env.devAuthBypass) return await devBypass(req, res, next);

    const user = await verifyUser(req, res);
    if (!user) return;
    req.user = user;

    const memberships = await getMemberships(user.id);
    const decision = selectTenant(memberships, req.headers['x-pharmacy-id']);

    if (!decision.ok) {
      return res.status(decision.status).json({ error: decision.error, code: decision.code });
    }

    req.pharmacyId = decision.membership.pharmacy_id;
    req.pharmacyRole = decision.membership.role;
    req.pharmacyStatus = decision.membership.status;
    req.memberships = memberships;
    next();
  } catch (err) {
    next(err);
  }
}

/** Route guard for owner-only actions (billing, disconnecting WhatsApp). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.pharmacyRole || !roles.includes(req.pharmacyRole)) {
      return res.status(403).json({ error: 'Insufficient role', code: 'FORBIDDEN_ROLE' });
    }
    next();
  };
}

module.exports = { requireAuth, requireAuthOnly, requireRole, selectTenant };
