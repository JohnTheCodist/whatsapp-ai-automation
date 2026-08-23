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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy server/.env.example to server/.env first.');
    process.exit(1);
  }

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
