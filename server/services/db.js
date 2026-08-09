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
      // Small pool on purpose: Supabase's pooler and shared-tier Postgres
      // both cap connections well below what a default pool would grab, and
      // an exhausted pool fails as mysterious timeouts rather than a clear
      // error. Raise this only alongside a measured need.
      max: parseInt(process.env.PG_POOL_MAX || '10', 10),
      idle_timeout: 30,
      // 30s, not 10. Two things stack against a short timeout here: the
      // Supabase pooler is a transatlantic hop (measured 1.3-2.1s just to
      // connect), and Baileys generates Curve25519 pre-keys synchronously
      // during pairing, which blocks the event loop and delays the timer
      // that enforces this. A pairing attempt tripped the 10s limit that
      // way and discarded a valid code.
      connect_timeout: parseInt(process.env.PG_CONNECT_TIMEOUT || '30', 10),
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

module.exports = { getSql, assertPharmacyId, closeSql, ping };
