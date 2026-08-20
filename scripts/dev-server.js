/**
 * Development supervisor for the API.
 *
 * WHY THIS EXISTS
 * server/index.js deliberately does NOT handle `uncaughtException`. That is
 * the right call — a thrown exception escaping the stack leaves the process
 * on unknown state, and continuing is worse than restarting. The reasoning
 * in index.js explicitly assumes "restarting takes about four seconds".
 *
 * In production something does that restarting: Render, systemd, a container
 * runtime. In development nothing did. `node server/index.js` under the
 * launcher meant a single uncaught throw — a Baileys socket error, a
 * decryption failure on a malformed frame — killed the API permanently.
 * WhatsApp then kept accepting messages that nothing was listening for, so
 * the symptom was not "the server crashed", it was "some messages get a
 * reply and later ones silently do not".
 *
 * WHAT THIS IS NOT
 * Not a licence to leave crashes unfixed. It prints the exit reason loudly
 * and keeps every crash in a log file precisely so the cause stays visible;
 * a supervisor that hid the failure would be worse than no supervisor.
 *
 * Not for production either. Render restarts the service itself, and running
 * a supervisor inside a supervised container just hides exit codes from the
 * platform that needs them.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'server', 'index.js');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'api.log');

// Backoff so a boot-time failure (bad DATABASE_URL, port in use) does not
// spin at full speed forever. Recovers to fast restarts once the process
// manages to stay up, because the common case here is a one-off socket
// error mid-session, not a broken build.
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 15000;
const HEALTHY_MS = 20000;   // stayed up this long => treat the next crash as fresh

fs.mkdirSync(LOG_DIR, { recursive: true });
const log = fs.createWriteStream(LOG_FILE, { flags: 'a' });

let delay = MIN_DELAY_MS;
let child = null;
let stopping = false;

function stamp(msg) {
  const line = JSON.stringify({ level: 'info', msg, at: new Date().toISOString(), supervisor: true });
  process.stdout.write(`${line}\n`);
  log.write(`${line}\n`);
}

function start() {
  const startedAt = Date.now();
  stamp('starting api');

  child = spawn(process.execPath, [ENTRY], {
    // Inherit stdin so nothing here interferes with terminal input; pipe the
    // output so it can go to BOTH the console and the log file. Without the
    // file, a crash that happens while nobody is watching leaves no evidence
    // at all — which is exactly the situation this was written for.
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdout.on('data', (d) => { process.stdout.write(d); log.write(d); });
  child.stderr.on('data', (d) => { process.stderr.write(d); log.write(d); });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    const upFor = Date.now() - startedAt;
    const why = signal ? `signal ${signal}` : `exit code ${code}`;

    // A clean, deliberate exit is not something to fight.
    if (code === 0 && !signal) {
      stamp(`api exited cleanly (${why}) — not restarting`);
      log.end();
      process.exit(0);
    }

    // Reset the backoff if it managed a normal working life before dying;
    // otherwise keep widening, because repeated instant deaths mean the
    // process cannot boot at all and hammering helps nobody.
    delay = upFor > HEALTHY_MS ? MIN_DELAY_MS : Math.min(delay * 2, MAX_DELAY_MS);

    stamp(`api died (${why}) after ${Math.round(upFor / 1000)}s — restarting in ${delay}ms · full output in logs/api.log`);
    setTimeout(start, delay);
  });
}

// Forward shutdown so Ctrl-C stops the API rather than orphaning it and then
// restarting it a moment later.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    stamp(`supervisor received ${sig} — stopping api`);
    if (child) child.kill(sig);
    setTimeout(() => process.exit(0), 500).unref();
  });
}

start();
