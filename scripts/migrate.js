#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 *
 * Applies every db/migrations/*.sql not yet recorded in schema_migrations,
 * in filename order, each inside a transaction. No down-migrations: at this
 * stage a bad migration is fixed by writing the next one, and a `down` that
 * has never been tested is worse than not having one.
 */

const fs = require('fs');
const path = require('path');
const postgres = require('postgres');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env'), quiet: true });

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refuse to alter a database that is not on this machine unless the caller
 * says, in so many words, that it means to.
 *
 * WHY. server/.env's DATABASE_URL is the live Supabase project on a
 * developer's machine, and `node scripts/migrate.js` run from a checkout —
 * meaning to migrate a local copy — applied six unreleased migrations to
 * production on 2026-09-21. Nothing asked. The script could not tell a
 * deploy from a slip, because it had no way to be told.
 *
 * THE FLAG, NOT NODE_ENV. The deploy scripts (deploy/update.sh,
 * deploy/setup.sh) pass --production. NODE_ENV would have been quieter, but
 * it is set in an env file that lives only on the server, and a guard that
 * depends on a file nobody can see from the repo is a guard nobody can check.
 * A local database needs no flag, so nothing about everyday use changes.
 */
function refuseUnconfirmedRemote(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = null;
  }
  if (host && LOCAL_HOSTS.has(host)) return;
  if (process.argv.includes('--production')) return;
  // `npm run migrate:test` has already proved this is a test database with
  // useTestDatabase(), which may legitimately be a second remote project.
  if (global.__rxnaijaVerifiedTestDatabase && global.__rxnaijaVerifiedTestDatabase === url) return;

  console.error(
    `\n  Refusing to migrate ${host || 'an unparseable DATABASE_URL'} — it is not a local database.\n\n`
    + '  If you meant to change the production schema, run:\n'
    + '    npm run migrate -- --production\n\n'
    + '  If you meant a local copy, point DATABASE_URL at it first (the local-run\n'
    + '  env.sh does), or use `npm run migrate:test` for the test database.\n',
  );
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy server/.env.example to server/.env first.');
    process.exit(1);
  }

  refuseUnconfirmedRemote(url);

  // prepare:false for the same reason server/services/db.js sets it: a
  // pooled connection (pgbouncer/Supabase in transaction mode) can hand this
  // session a different backend per statement, which has never seen a
  // statement prepared on an earlier one — postgres.js prepares by default,
  // so leaving this out fails as "prepared statement ... does not exist" the
  // moment DATABASE_URL points at a pooled connection instead of a direct one.
  const sql = postgres(url, { max: 1, connect_timeout: 15, prepare: false });

  try {
    await sql`
      create table if not exists schema_migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      )
    `;

    const applied = new Set(
      (await sql`select filename from schema_migrations`).map((r) => r.filename)
    );

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const file of pending) {
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (filename) values (${file})`;
      });
      console.log('ok');
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  process.exit(1);
});
