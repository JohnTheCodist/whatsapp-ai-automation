/**
 * Database access — a single lazily-created Postgres connection pool, plus
 * the tenant guard every query path is expected to pass through.
 *
 * WHY assertPharmacyId EXISTS
 * The API connects with the service_role key, which bypasses Row-Level
 * Security. That makes the application layer solely responsible for tenant
 * isolation, and it means the most dangerous bug in this codebase is a
 * query that forgets `where pharmacy_id = ...`. A missing or undefined
 * tenant id must never reach Postgres and quietly match nothing (or, worse,
 * be interpolated into a query that matches everything). This throws
 * instead — a 500 is recoverable, a cross-tenant data leak is not.
 *
 * Call it at the TOP of every function that touches a tenant table, before
 * any query is built. It is cheap and its whole value is being unmissable.
 */

const postgres = require('postgres');
const { env } = require('../config/env');

let sql = null;

function getSql() {
  if (!sql) {
    sql = postgres(env.databaseUrl, {
      // Still bounded, but no longer starved. The old value here was 2 under
      // the test runner — a workaround for the session-mode cap fixed below,
      // not a real constraint. The runner forks a process per file, each with
      // its own pool, so the lower number is still the safer one; it just no
      // longer has to be pathologically small.
      //
      // Keyed off TEST_DATABASE_URL rather than NODE_ENV: the test files set
      // it themselves, so it is present exactly when the runner is active and
      // needs nothing added to the npm script (which would have to work on
      // both cmd.exe and sh).
      max: parseInt(process.env.PG_POOL_MAX || (process.env.TEST_DATABASE_URL ? '5' : '15'), 10),
      // Was 30. Opening a connection to this pooler costs ~4.8s; a query on
      // one already open costs ~240ms (full numbers in WARM_CONNECTIONS
      // below). So the cost worth engineering away is CONNECTING, not
      // querying.
      //
      // A WhatsApp conversation is not a tight request loop. A customer
      // reads a menu, thinks, types a reply — gaps past 30s are the norm,
      // not the exception. At 30s every such gap closed the idle socket, so
      // the very next message paid the full connect again: this is the
      // "slow and drops" pattern reported live, and it is a cold-start tax
      // on ordinary pauses, not sustained slowness.
      //
      // 300s outlives a normal in-conversation pause. It does not need to
      // outlive a genuinely abandoned conversation — startKeepAlive() below
      // means the pool is never actually idle long enough for this number to
      // matter during business hours; it only bites if the heartbeat itself
      // has stopped, which is the point of keeping it as a real bound rather
      // than removing it.
      // UNDER THE TEST RUNNER THE GOAL INVERTS, so this is not one number.
      //
      // Production wants connections held OPEN — a warm socket is the whole
      // point. The runner wants them RELEASED FAST: it forks a process per
      // test file, each with its own pool, and those pools outlive their
      // usefulness the moment a file's tests finish. Holding them 300s each
      // means dozens of idle sockets stacking up against one pooler while
      // later files are still trying to connect.
      //
      // That is not hypothetical. With 300s applied to tests as well, ten
      // customerProfile tests failed together — not on their assertions, but
      // in setup, unable to get a connection — while passing 10/10 when run
      // alone. The failure looked like a broken profile service and was
      // actually connection starvation, which is the exact confusion this
      // file's other comments exist to prevent.
      //
      // 20s under test: long enough to span the gaps within one file's
      // fixtures, short enough that a finished file stops holding the pool.
      idle_timeout: parseInt(
        process.env.PG_IDLE_TIMEOUT || (process.env.TEST_DATABASE_URL ? '20' : '300'),
        10,
      ),
      // REQUIRED by Supabase's transaction-mode pooler (port 6543), and the
      // reason the whole `max: 2` contortion above exists in the first place.
      //
      // The connection string pointed at port 5432 — SESSION mode — which
      // pins one real Postgres backend per client for the life of the
      // connection and is hard-capped at 15. Every symptom that cost time
      // this build traces to that cap: EMAXCONNSESSION under the test
      // runner, ECONNRESET mid-request, and ENOTFOUND, which looks exactly
      // like a DNS failure and is not one. Transaction mode hands a backend
      // back after each transaction instead, so the same 15 backends serve
      // far more clients.
      //
      // prepare:false is not optional there. A prepared statement is session
      // state, and in transaction mode the next statement may land on a
      // different backend that has never seen it — postgres.js prepares by
      // default, so leaving this out produces "prepared statement does not
      // exist" under concurrency only, which is the worst way to find out.
      //
      // Verified before switching: no LISTEN/NOTIFY, no advisory locks, no
      // session-level SET anywhere in this codebase. The worker's
      // `for update skip locked` is inside a transaction and unaffected.
      prepare: false,
      // 30s, not 10. Two things stack against a short timeout here: this
      // pooler is slow to ACCEPT a connection (~4.8s measured on 6543, vs
      // 176ms on 5432 to the same host — see WARM_CONNECTIONS below), and
      // Baileys generates Curve25519 pre-keys synchronously during pairing,
      // which blocks the event loop and delays the timer that enforces this.
      // A pairing attempt tripped the 10s limit that way and discarded a
      // valid code.
      connect_timeout: parseInt(process.env.PG_CONNECT_TIMEOUT || '30', 10),
      // TCP keepalive probe interval. postgres.js defaults to 60s, which is
      // how the process used to WEDGE rather than merely slow down.
      //
      // OBSERVED: the Supabase pooler drops connections during its bad
      // periods without a FIN — the socket is dead but looks open. At the
      // 60s default, plus TCP retransmission, those sockets stay in the pool
      // for minutes. Every request handed one of them hangs instead of
      // failing, requests queue behind the remaining slots, and once all of
      // them are poisoned the API stops answering entirely while the pooler
      // itself is healthy again (measured: 544ms to connect, API still
      // returning nothing after 25s). Only a restart cleared it.
      //
      // This is the actual "slow and drops" failure, and it is worse than
      // slow: a hang gives the caller nothing to retry on. 15s detects a
      // dead peer roughly four times sooner, and a failed query is
      // recoverable in a way that a hung one is not.
      keep_alive: parseInt(process.env.PG_KEEP_ALIVE || '15', 10),
      // Recycle connections on a schedule so one that has gone subtly bad
      // cannot live forever. postgres.js defaults this to a random 30-60
      // minutes; 10 minutes is short enough to bound the damage and long
      // enough that reconnects stay rare — and warmPool re-establishes them
      // off the critical path anyway.
      max_lifetime: parseInt(process.env.PG_MAX_LIFETIME || '600', 10),
      // Fail a query rather than hang on it.
      //
      // keep_alive above catches a socket whose PEER has died. This catches
      // the other half: a connection that is alive but whose query never
      // comes back, which the pooler produces under load. Without a bound the
      // request waits on the server's own default — long enough that the API
      // held a request open past two minutes with no response and no error,
      // and the dashboard sat on "Loading…" the whole time.
      //
      // 15s is deliberately BELOW the 20s the dashboard allows a request, so
      // the server loses the race on purpose: it returns a real error the UI
      // can show and retry, instead of the browser aborting into silence with
      // nothing to report. It is also comfortably above the heaviest query
      // here (the 30-day insights aggregate, ~10s on a bad day).
      connection: {
        statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '15000', 10),
      },
      // Postgres bigint exceeds JS Number.MAX_SAFE_INTEGER. Money is stored
      // as bigint kobo, so it comes back as a string by default; we coerce
      // to Number deliberately here because no realistic naira amount gets
      // near 2^53 kobo (~90 trillion naira), and a string leaking into
      // arithmetic is the more likely bug.
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (x) => String(x),
          parse: (x) => Number(x),
        },
      },
      onnotice: env.isProduction ? () => {} : undefined,
    });
  }
  return sql;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws unless `pharmacyId` is a syntactically valid tenant id.
 *
 * Deliberately does NOT check the row exists — that would put a database
 * round-trip in front of every call and encourage people to skip it. Its
 * job is to catch undefined/null/'' and anything client-shaped, which is
 * the failure mode that actually happens.
 */
function assertPharmacyId(pharmacyId) {
  if (!pharmacyId || typeof pharmacyId !== 'string' || !UUID_RE.test(pharmacyId)) {
    throw new Error(
      `Tenant guard: invalid pharmacyId (${JSON.stringify(pharmacyId)}). ` +
      `Every tenant query must be scoped to a verified pharmacy.`
    );
  }
}

async function closeSql() {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}

/** Boot-time reachability check, so a bad DATABASE_URL fails at start. */
async function ping() {
  const db = getSql();
  await db`select 1`;
}

let keepAliveTimer = null;

/**
 * How many connections to keep open and warm.
 *
 * MEASURED, on the live pooler, same host, same network:
 *
 *   port 6543 (transaction)  TCP accept 4788ms   warm query median 241ms
 *   port 5432 (session)      TCP accept  176ms   warm query median 123ms
 *
 * The 27x gap on TCP accept is the whole problem, and it is NOT distance —
 * 5432 reaches the same hostname in 176ms. Supabase's transaction pooler is
 * simply slow to accept a NEW connection. Once open, a connection is fine.
 *
 * We stay on 6543 regardless, because session mode's hard 15-backend cap is
 * what caused the EMAXCONNSESSION/ECONNRESET/ENOTFOUND cascade this pool was
 * rebuilt to escape. The fix is therefore not to switch ports but to stop
 * opening connections on the customer's critical path.
 *
 * 3 rather than 1: a single warm connection only covers a strictly serial
 * workload. Two WhatsApp messages arriving together, or one message whose
 * handler queries while the dashboard is polling, needs a second and third —
 * and each of those would otherwise cost ~4.8s while a customer waits.
 * 3 covers realistic concurrency for one pharmacy without holding backends
 * hostage; it is deliberately far below `max`, which remains the ceiling for
 * genuine bursts.
 */
const WARM_CONNECTIONS = parseInt(process.env.PG_WARM_CONNECTIONS || '3', 10);

/**
 * Force `n` connections open at once and keep them that way.
 *
 * The queries must overlap in time — that is the entire mechanism. Awaiting
 * them one after another would hand the same single connection back to the
 * pool between each, and open exactly one. Promise.all is load-bearing here,
 * not stylistic.
 */
function warmPool(n = WARM_CONNECTIONS) {
  const db = getSql();
  return Promise.all(
    Array.from({ length: n }, () => db`select 1`.catch(() => null)),
  );
}

/**
 * Keep the pool warm so no customer-facing query pays the ~4.8s connect.
 *
 * idle_timeout is a bound, not a target — this is what actually keeps the
 * pool from going idle in the first place. The interval is well under
 * idle_timeout on purpose: the heartbeat exists to make that timeout
 * irrelevant during normal operation, not to race it.
 *
 * Failures are swallowed rather than thrown. This runs unattended on a timer
 * with nothing awaiting its result; a transient blip must not become an
 * unhandled rejection that takes down live WhatsApp sessions. The next tick,
 * or the next real query, recovers on its own — that is what a heartbeat is
 * for.
 */
function startKeepAlive(intervalMs = parseInt(process.env.PG_KEEPALIVE_MS || '60000', 10)) {
  if (keepAliveTimer) return keepAliveTimer;
  keepAliveTimer = setInterval(() => {
    // Warms all N, not just one — an idle_timeout expiry would otherwise
    // reap connections 2 and 3 and quietly restore the original problem for
    // anything concurrent.
    warmPool().catch(() => {});
  }, intervalMs);
  keepAliveTimer.unref?.();
  return keepAliveTimer;
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/**
 * Connection-level faults, as opposed to anything the query itself did wrong.
 *
 * A pooled socket can be dead before it is ever used: the pooler drops it
 * during one of its bad periods, nothing tells us, and the next statement
 * sent down it fails immediately. That is not a bad query — the identical
 * statement succeeds on the next connection — so it is the one class of
 * failure worth retrying.
 *
 * Matched on code first and message second: postgres.js surfaces some of
 * these as a bare Error with no `code` at all.
 */
const RETRYABLE_CONNECTION_ERRORS = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH',
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
]);

function isRetryableConnectionError(err) {
  if (!err) return false;
  if (RETRYABLE_CONNECTION_ERRORS.has(err.code)) return true;
  return /ECONNRESET|socket hang up|Connection (closed|ended|destroyed)|write EPIPE/i
    .test(err.message || '');
}

/**
 * Run a read against the database, surviving a connection that was already
 * dead when we were handed it.
 *
 * WHY THIS EXISTS
 * The pool is tuned (above) to FAIL fast rather than hang on a poisoned
 * socket, on the reasoning that a failed query is recoverable and a hung one
 * is not. This is the half that does the recovering — without it the tuning
 * only converts one bad user experience into another, which is what it did:
 * /api/catalogue/products returned a 500 whose entire cause was a stale
 * socket, on a query that is correct and that succeeds on the next attempt.
 *
 * READS ONLY. Every attempt re-runs `fn` from the start, so anything that
 * writes could apply twice — a retried INSERT is a duplicate order. Writes
 * that need this protection should be made idempotent first, or wrapped in a
 * transaction and retried by the caller who knows what re-running means.
 *
 * Retries ONLY connection faults. A syntax error, a constraint violation or
 * a permissions failure is deterministic: re-running it just produces the
 * same error more slowly and hides the real one behind a delay.
 *
 * @param {() => Promise<T>} fn        the read to run; called once per attempt
 * @param {object} [opts]
 * @param {number} [opts.attempts=3]   total attempts, not extra ones
 * @param {number} [opts.delayMs=120]  backoff base; doubles per retry
 * @returns {Promise<T>}
 * @template T
 */
async function readWithRetry(fn, { attempts = 3, delayMs = 120 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableConnectionError(err) || attempt === attempts) throw err;
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'database read hit a dead connection, retrying',
        attempt,
        of: attempts,
        error: err.message,
      }));
      // Short and increasing. The dead socket is discarded by postgres.js on
      // failure, so the next attempt draws a different one — this wait is to
      // let a genuinely struggling pooler breathe, not to wait out a lock.
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

module.exports = {
  getSql, assertPharmacyId, closeSql, ping, warmPool, startKeepAlive, stopKeepAlive,
  readWithRetry, isRetryableConnectionError,
};
