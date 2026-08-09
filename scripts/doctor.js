#!/usr/bin/env node
/**
 * Preflight check — run before `npm run migrate`.
 *
 * Answers "is this database ready and is my config right" without applying
 * anything. Output is safe to paste into a chat or an issue: every secret
 * is masked, and connection strings are reduced to host/port/database.
 *
 *   npm run doctor
 */

const path = require('path');
const fs = require('fs');
const postgres = require('postgres');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env'), quiet: true });

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const results = [];
function report(status, label, detail = '') {
  results.push({ status, label, detail });
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: '--  ' }[status];
  console.log(`${mark}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

/** Strips credentials from a Postgres URL so the rest is safe to show. */
function describeUrl(raw) {
  try {
    const u = new URL(raw);
    const port = u.port || '5432';
    return `host=${u.hostname} port=${port} db=${u.pathname.slice(1)} user=${u.username || '(none)'}`;
  } catch {
    return '(unparseable — is it a full postgres:// URL?)';
  }
}

function checkEnvPresence() {
  const envPath = path.join(__dirname, '..', 'server', '.env');
  if (!fs.existsSync(envPath)) {
    report('fail', 'server/.env exists', 'Copy server/.env.example to server/.env and fill it in.');
    return false;
  }
  report('ok', 'server/.env exists');

  let allPresent = true;
  for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const value = process.env[key];
    if (!value) {
      report('fail', `${key} set`, 'Missing.');
      allPresent = false;
      continue;
    }
    if (/\[YOUR-PASSWORD\]|your-project|^$/.test(value)) {
      report('fail', `${key} set`, 'Still contains a placeholder from .env.example.');
      allPresent = false;
      continue;
    }
    const shown = key === 'DATABASE_URL'
      ? describeUrl(value)
      : `${value.slice(0, 8)}… (${value.length} chars)`;
    report('ok', `${key} set`, shown);
  }
  return allPresent;
}

function checkPoolerMode() {
  const url = process.env.DATABASE_URL || '';
  if (url.includes(':6543')) {
    report(
      'warn',
      'Connection port',
      'Port 6543 is the TRANSACTION pooler. It does not support prepared statements or\n' +
      '        some DDL, and migrations can fail oddly. Use the SESSION pooler or the direct\n' +
      '        connection (usually port 5432) for migrations.'
    );
    return;
  }
  report('ok', 'Connection port', 'Not the transaction pooler.');
}

async function checkDatabase(sql) {
  const [{ version }] = await sql`select version()`;
  report('ok', 'Database reachable', version.split(',')[0]);

  const [{ current_user: user, current_database: dbname }] = await sql`
    select current_user, current_database()
  `;
  report('info', 'Connected as', `${user} on ${dbname}`);

  // auth.users — the schema FKs to it. Without it, 0001_init.sql cannot apply.
  const [authSchema] = await sql`
    select 1 as found from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  `;
  if (authSchema) {
    report('ok', 'auth.users present', 'Supabase auth schema found.');
  } else {
    report(
      'fail',
      'auth.users present',
      'Not found. db/migrations/0001_init.sql references auth.users(id).\n' +
      '        This must be a Supabase project, not a bare Postgres instance.'
    );
  }

  // Extensions the migration creates.
  const exts = await sql`
    select name, installed_version from pg_available_extensions
    where name in ('pgcrypto', 'pg_trgm')
  `;
  for (const name of ['pgcrypto', 'pg_trgm']) {
    const row = exts.find((e) => e.name === name);
    if (!row) report('fail', `extension ${name}`, 'Not available on this server.');
    else if (row.installed_version) report('ok', `extension ${name}`, `already installed (${row.installed_version})`);
    else report('ok', `extension ${name}`, 'available, will be created by the migration');
  }

  // What has already been applied.
  const [tracker] = await sql`
    select 1 as found from information_schema.tables
    where table_schema = 'public' and table_name = 'schema_migrations'
  `;

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];

  if (!tracker) {
    report('info', 'Migrations applied', `none yet — ${files.length} pending: ${files.join(', ') || '(no files)'}`);
  } else {
    const applied = (await sql`select filename from schema_migrations order by filename`).map((r) => r.filename);
    const pending = files.filter((f) => !applied.includes(f));
    report('info', 'Migrations applied', applied.join(', ') || '(none)');
    report(pending.length ? 'info' : 'ok', 'Migrations pending', pending.join(', ') || '(none)');
  }

  // Would the migration collide with existing tables?
  const collisions = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('pharmacies', 'products', 'conversations', 'messages', 'orders')
  `;
  if (collisions.length && !tracker) {
    report(
      'warn',
      'Table collisions',
      `${collisions.map((c) => c.table_name).join(', ')} already exist but schema_migrations does not.\n` +
      '        The migration will fail. Is this database already in use by something else?'
    );
  } else {
    report('ok', 'No unexpected table collisions');
  }
}

async function main() {
  console.log('\nWhatsApp AI Automation — preflight\n');

  if (!checkEnvPresence()) {
    console.log('\nFix the FAILs above, then run this again.\n');
    process.exit(1);
  }
  checkPoolerMode();

  let sql;
  try {
    sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15, idle_timeout: 5 });
    await checkDatabase(sql);
  } catch (err) {
    report('fail', 'Database reachable', err.message);
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  console.log(
    `\n${failed ? `${failed} failure(s)` : 'No failures'}` +
    `${warned ? `, ${warned} warning(s)` : ''}. ` +
    `${failed ? 'Do not run the migration yet.' : 'Ready for: npm run migrate'}\n`
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nPreflight crashed: ${err.message}\n`);
  process.exit(1);
});
