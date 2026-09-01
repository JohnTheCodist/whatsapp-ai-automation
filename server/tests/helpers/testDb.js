/**
 * The one thing standing between `npm test` and the production database.
 *
 * WHAT THIS REPLACES
 * Every database-backed test file used to redirect itself with one line:
 *
 *     if (TEST_URL) process.env.DATABASE_URL = TEST_URL;
 *
 * That line is correct. The problem was never the redirect — it was that
 * nothing checked WHERE it redirected TO. server/.env.example says to set
 * TEST_DATABASE_URL to the same value as DATABASE_URL ("ONE PROJECT FOR NOW,
 * decided 2026-08-08"), with an instruction to split them before the first
 * real pharmacy. That pharmacy arrived; the values did not get split. Measured
 * 2026-08-29: the two strings were byte-identical, and the database on the
 * other end held five pharmacies, a connected WhatsApp socket, and messages
 * from that morning.
 *
 * So 34 test files, ~87 DELETE statements and a direct `insert into auth.users`
 * were all pointed at live customer data. Nothing was lost — the deletes are
 * carefully scoped by row id or by tag prefix — but "carefully scoped" is a
 * property of today's tests, not a guarantee about tomorrow's, and the
 * suite's own header says: "Never point TEST_DATABASE_URL at production."
 *
 * WHY A THROW AND NOT A WARNING
 * Same reasoning as config/env.js refusing to boot on DEV_AUTH_BYPASS in
 * production: "A warning would be read once and ignored; a dead process gets
 * fixed." A comment telling somebody not to do this already existed, in three
 * files, and it did not work. This is the version that cannot be skipped by
 * not reading it.
 *
 * WHY THE COMPARISON IS NOT A STRING EQUALITY CHECK
 * The obvious fix — refuse when the two strings match — is defeated by the
 * obvious workaround. The same Supabase database is reachable as:
 *
 *   ...pooler.supabase.com:6543/postgres   transaction pooler (production)
 *   ...pooler.supabase.com:5432/postgres   session pooler
 *   db.<ref>.supabase.co:5432/postgres     direct connection
 *
 * Three different strings, one database. Somebody hitting this error and
 * changing the port has not separated anything; they have silenced the guard
 * while keeping the hazard. So the comparison is on database IDENTITY — the
 * Supabase project ref, which appears either in the username (`postgres.<ref>`)
 * or in the hostname (`db.<ref>.supabase.co`) — falling back to host + database
 * + user for a non-Supabase Postgres.
 *
 * A second Supabase project has a different ref and passes cleanly, which is
 * the point: this blocks the one dangerous configuration, not the fix.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '..', '.env');

/**
 * The DATABASE_URL as DECLARED in server/.env.
 *
 * Read from the raw file rather than from process.env, and this is the whole
 * reason the check can work at all: by the time a test calls in here it has
 * usually already loaded dotenv, and the caller is about to overwrite
 * process.env.DATABASE_URL with the test URL. Comparing two values that one
 * of them is about to become would compare a variable against itself.
 *
 * Parsed with a deliberately small reader instead of dotenv, so that reading
 * the file cannot mutate the environment as a side effect.
 */
function declaredProductionUrl() {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    // No server/.env — a CI runner passing everything as real environment
    // variables. Fall back to what is in scope; if CI has set both, the
    // identity comparison below still catches a collision.
    return process.env.DATABASE_URL || null;
  }

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)$/);
    if (!m) continue;
    // Strip surrounding quotes and any trailing comment-free whitespace.
    return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return null;
}

/**
 * A stable identity for "which database is this", robust to the three ways
 * the same Supabase project can be addressed.
 *
 * Returns null for anything unparseable rather than throwing — an
 * unrecognisable URL is handled by the caller, which fails closed.
 */
function databaseIdentity(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  const user = decodeURIComponent(u.username || '');
  const host = u.hostname || '';
  const database = (u.pathname || '').replace(/^\//, '');

  // `new URL` accepts "postgres://" happily — it is a structurally valid URL
  // with an empty host. Left alone, that produced the identity "pg::5432::",
  // which is a non-null answer to "which database is this" for a string that
  // names no database at all. Two different malformed values would then
  // compare equal, and a malformed one against a real one would compare
  // unequal and be waved through as "a different database".
  //
  // Caught by GOLDEN-002c, 2026-08-29. A URL with no host is not a database
  // reference, and the caller treats null as "cannot prove these differ" —
  // which is the direction to fail in.
  if (!host) return null;

  // Supabase project ref, wherever it happens to be written.
  //   pooler:  username is `postgres.abcdefghijklmnop`
  //   direct:  hostname is `db.abcdefghijklmnop.supabase.co`
  const fromUser = user.match(/^postgres\.([a-z0-9]{16,})$/i);
  const fromHost = host.match(/^db\.([a-z0-9]{16,})\.supabase\./i);
  const ref = (fromUser && fromUser[1]) || (fromHost && fromHost[1]) || null;

  if (ref) return `supabase:${ref.toLowerCase()}`;

  // Plain Postgres: host, port and database name together. The port IS
  // significant here — two Postgres instances on one host are two databases,
  // unlike the Supabase pooler where the port only selects a mode.
  return `pg:${host.toLowerCase()}:${u.port || '5432'}:${database}:${user}`;
}

/**
 * Point the application's database at the test database, refusing if that
 * turns out to be production.
 *
 * Call this INSTEAD of `if (TEST_URL) process.env.DATABASE_URL = TEST_URL`,
 * and call it before requiring services/db — config/env.js snapshots
 * process.env.DATABASE_URL at module load, so a require that happens first
 * freezes the wrong value and the redirect silently does nothing.
 *
 * @param {string|undefined} testUrl  process.env.TEST_DATABASE_URL
 * @returns {boolean} true if the redirect happened; false when there is no
 *                    test database configured and the caller should skip.
 */
function useTestDatabase(testUrl) {
  // Unset is the safe, supported state: every caller already treats a falsy
  // TEST_DATABASE_URL as "skip this suite, loudly". Nothing to guard.
  if (!testUrl) return false;

  const productionUrl = declaredProductionUrl();

  if (productionUrl) {
    const testId = databaseIdentity(testUrl);
    const prodId = databaseIdentity(productionUrl);

    // Fail closed. An unparseable URL is not evidence of safety, and the cost
    // of a false positive here is a clear error message, while the cost of a
    // false negative is the live database.
    if (!testId || !prodId) {
      throw new Error(refusal(
        'TEST_DATABASE_URL or DATABASE_URL could not be parsed as a connection URL, '
        + 'so this suite cannot prove they are different databases.'
      ));
    }

    if (testId === prodId) {
      throw new Error(refusal(
        `TEST_DATABASE_URL and DATABASE_URL point at the same database (${prodId}).`
      ));
    }
  }

  process.env.DATABASE_URL = testUrl;
  return true;
}

/**
 * The message somebody reads at 2am when this fires.
 *
 * It states what was found, why it is refusing, and the exact next step —
 * because an error that only says "refusing" gets worked around, and the
 * easiest workaround here (change the port) reintroduces the hazard.
 */
function refusal(what) {
  return [
    '',
    '  REFUSING TO RUN THE DATABASE TEST SUITE.',
    '',
    `  ${what}`,
    '',
    '  This suite writes and deletes rows. It creates pharmacies, customers,',
    '  conversations, orders and auth.users records, and removes them again —',
    '  against whatever TEST_DATABASE_URL names. That must never be the',
    '  database serving real pharmacies.',
    '',
    '  Set TEST_DATABASE_URL to a SEPARATE database:',
    '',
    '    - a second Supabase project, or',
    '    - any other Postgres.',
    '',
    '  Then, for either one:',
    '',
    '        npm run migrate:test',
    '',
    '  (it applies db/test-bootstrap.sql itself if the auth schema is missing)',
    '',
    '  Or leave TEST_DATABASE_URL empty: the database suites will skip and',
    '  say so, and the pure unit tests still run.',
    '',
    '  Changing the port or switching pooler mode does NOT separate them —',
    '  that is the same database by another name, and this check knows it.',
    '',
  ].join('\n');
}

module.exports = { useTestDatabase, databaseIdentity, declaredProductionUrl };
