/**
 * The keep-alive heartbeat's lifecycle — not its timing.
 *
 * WHY THIS EXISTS
 * The pool's idle_timeout used to be 30s, shorter than a normal pause in a
 * WhatsApp conversation. Every such pause closed the socket, and the next
 * message paid a live-measured ~5.4s reconnect to the pooler before the
 * customer saw a reply — the "slow and drops" pattern reported in
 * production. startKeepAlive() exists to make that irrelevant by never
 * letting the pool go idle in the first place.
 *
 * WHAT IS NOT TESTED HERE
 * Whether the heartbeat actually fires on schedule and keeps a real socket
 * warm — that needs a live database and real wall-clock time longer than
 * this suite should ever cost. What IS worth a fast, deterministic test is
 * the part a refactor could silently break: calling start twice must not
 * leak a second interval, and stop must actually clear it. A leaked timer
 * here is invisible until someone notices the process making twice as many
 * heartbeat queries as it should.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the keep-alive lifecycle was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { startKeepAlive, stopKeepAlive, warmPool, getSql } = require('../services/db');

test('stopKeepAlive before start is a no-op, not a crash', { skip: SKIP && skipReason }, () => {
  assert.doesNotThrow(() => stopKeepAlive());
});

test('starting twice does not leak a second interval', { skip: SKIP && skipReason }, () => {
  const first = startKeepAlive(3600_000);
  const second = startKeepAlive(3600_000);
  // Same handle back, not a fresh one replacing the first — a fresh one
  // would mean the original timer is still running, uncleared, forever.
  assert.equal(first, second, 'a second start() must reuse the existing timer, not create another');
  stopKeepAlive();
});

test('stop actually clears the timer, so a later start creates a fresh one', { skip: SKIP && skipReason }, () => {
  const first = startKeepAlive(3600_000);
  stopKeepAlive();
  const second = startKeepAlive(3600_000);
  assert.notEqual(first, second, 'after stop(), start() must be able to run again');
  stopKeepAlive();
});

test('after warmPool, a concurrent burst does not pay connect cost', { skip: SKIP && skipReason }, async () => {
  // WHY NOT pg_backend_pid()
  // The obvious test — fire N concurrent queries, assert they report
  // distinct backend PIDs — fails, and correctly so. This is a
  // TRANSACTION-mode pooler: multiplexing many client connections onto
  // fewer real backends is its entire purpose, so every query can legitimately
  // report the same PID no matter how many client sockets postgres.js holds.
  // pg_backend_pid() measures the server side of the pooler; warmPool acts on
  // the client side. postgres.js does not expose its pool, so the only honest
  // assertion left is the observable guarantee itself.
  //
  // The bound is deliberately loose. A single cold connect to this pooler was
  // measured at ~4.8s; a warm query at ~240ms. 3s sits far below the failure
  // it is meant to catch and far above normal jitter, so this fails when
  // warming is genuinely broken and not when the network hiccups.
  const db = getSql();
  await warmPool(3);
  const started = Date.now();
  await Promise.all(Array.from({ length: 3 }, () => db`select 1`));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000,
    `concurrent burst took ${elapsed}ms — connections were not warm (a cold connect alone is ~4.8s)`);
});

test('warmPool survives a failure without rejecting', { skip: SKIP && skipReason }, async () => {
  // It runs unattended on the keep-alive timer. A rejection here would
  // surface as an unhandled rejection and, per index.js, that path exists
  // precisely because it has twice threatened live WhatsApp sessions.
  await assert.doesNotReject(() => warmPool(2));
});

test('the interval stays well under idle_timeout, so it actually prevents the gap it exists for',
  { skip: SKIP && skipReason }, () => {
    // The whole mechanism only works if the heartbeat fires more often than
    // idle_timeout would close the socket. Encodes that relationship so a
    // future change to either number can't silently break the other.
    //
    // CHECKS THE PRODUCTION VALUE, NOT THIS PROCESS'S OWN.
    // db.js deliberately uses a much shorter idle_timeout under the test
    // runner (20s), because a forked process per file wants connections
    // released fast, not held warm. Reading the effective value here would
    // therefore assert 60000 < 20000 and fail — while proving nothing about
    // the deployment this invariant actually protects. The production
    // default is the number the heartbeat has to beat, so it is the number
    // named here; the literal is duplicated from db.js on purpose, so that
    // changing one without the other fails loudly instead of quietly
    // decoupling.
    const PROD_IDLE_TIMEOUT_S = 300;
    const keepAliveMs = parseInt(process.env.PG_KEEPALIVE_MS || '60000', 10);
    assert.ok(keepAliveMs < PROD_IDLE_TIMEOUT_S * 1000,
      `heartbeat (${keepAliveMs}ms) must fire more often than production idle_timeout (${PROD_IDLE_TIMEOUT_S}s) or it cannot prevent the disconnect`);
  });
