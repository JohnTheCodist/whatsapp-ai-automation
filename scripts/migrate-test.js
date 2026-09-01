#!/usr/bin/env node
/**
 * Apply db/migrations to the TEST database.
 *
 * WHY A WRAPPER RATHER THAN A FLAG ON migrate.js
 * `npm run migrate` is the production deploy step — deploy/update.sh runs it
 * on the live box. Teaching it a `--test` mode would put a branch that
 * redirects the connection string inside the one script whose job is to alter
 * the production schema, and a mistyped flag there is a migration applied to
 * the wrong database. Two scripts with two names cannot be confused by a typo.
 *
 * WHY IT GOES THROUGH THE SAME GUARD AS THE TEST SUITE
 * There is exactly one definition of "these two URLs are the same database"
 * (server/tests/helpers/testDb.js), and it belongs to whichever code is about
 * to write. Migrating is writing — DDL, on every table. If this had its own
 * looser check, the guard would be a thing the tests enforce and the schema
 * tooling quietly does not.
 *
 *   TEST_DATABASE_URL=postgres://... npm run migrate:test
 *
 * Cross-platform without cross-env: the redirect happens in Node, before
 * migrate.js is loaded, rather than in shell syntax that differs between
 * PowerShell, cmd.exe and sh.
 */

const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '..', 'server', '.env'),
  quiet: true,
});

const { useTestDatabase } = require('../server/tests/helpers/testDb');

const TEST_URL = process.env.TEST_DATABASE_URL;

if (!TEST_URL) {
  console.error(
    '\n  TEST_DATABASE_URL is not set, so there is no test database to migrate.\n\n'
    + '  Set it in server/.env to a database that is NOT the one DATABASE_URL\n'
    + '  names, then run this again. See server/.env.example.\n'
  );
  process.exit(1);
}

// Throws, loudly and with instructions, if TEST_DATABASE_URL resolves to the
// same database as DATABASE_URL. Must run before migrate.js is required —
// that module reads process.env.DATABASE_URL as soon as it executes.
useTestDatabase(TEST_URL);

/**
 * Apply db/test-bootstrap.sql, but only to a database that does not already
 * have an auth schema.
 *
 * WHY THIS IS DONE HERE RATHER THAN WITH psql
 * The documented instruction used to be `psql -f db/test-bootstrap.sql`. That
 * is a fine instruction on a machine that has psql, and this project is
 * developed on Windows where it is not installed and is not otherwise needed —
 * so the setup step nobody can run is the setup step that does not happen.
 * postgres.js is already a dependency and executes the file just as well.
 *
 * WHY IT CHECKS FIRST
 * A second Supabase project already has a real auth schema with the genuine
 * auth.users. Running the shim there would either fail on the existing table
 * or, worse, replace auth.uid() on a database that has a working one. Skipping
 * when auth.users already exists means one command is correct for both kinds
 * of test database.
 *
 * SAFE BECAUSE OF WHAT RAN ABOVE. This writes DDL, and the only reason that is
 * acceptable is that useTestDatabase() has already refused to continue if this
 * URL resolves to the same database as DATABASE_URL.
 */
async function bootstrapIfNeeded() {
  const fs = require('node:fs');
  const postgres = require('postgres');

  const sql = postgres(TEST_URL, { max: 1, prepare: false, connect_timeout: 30 });
  try {
    const [{ present }] = await sql`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'auth' and table_name = 'users'
      ) as present
    `;

    if (present) {
      console.log('auth.users already exists — skipping the bootstrap shim.');
      return;
    }

    console.log('No auth schema found. Applying db/test-bootstrap.sql ...');
    const file = path.join(__dirname, '..', 'db', 'test-bootstrap.sql');
    await sql.unsafe(fs.readFileSync(file, 'utf8'));
    console.log('Bootstrap applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

(async () => {
  try {
    await bootstrapIfNeeded();
  } catch (err) {
    console.error(`\n  Could not prepare the test database: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\nMigrating the TEST database.\n');

  // migrate.js calls main() on import; the redirect above is already in place,
  // and dotenv does not overwrite an environment variable that is already set.
  require('./migrate.js');
})();
