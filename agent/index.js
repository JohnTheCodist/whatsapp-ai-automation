#!/usr/bin/env node
/**
 * RxNaija Sync — sends a pharmacy's stock export to RxNaija on a schedule.
 *
 *   rxnaija-sync pair SY-XXXX [--folder "C:\path"]   join this computer to a pharmacy
 *   rxnaija-sync sync                                send once, now
 *   rxnaija-sync watch                               keep running on a schedule
 *   rxnaija-sync status                              what it thinks is going on
 *
 * WRITTEN TO BE READ BY THE PERSON IT FAILS IN FRONT OF
 * Every message here is aimed at a pharmacist standing at a shop counter, not
 * at a developer reading a log. "ENOENT" tells them nothing; "the export
 * folder has moved" tells them what to do. This program will spend most of its
 * life unattended on a machine nobody looks at, and the only moments that
 * matter are the ones where something has gone wrong and a non-technical
 * person has to fix it.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const config = require('./src/config');
const { detect } = require('./src/detect');
const { newestExport, looksSettled, hashFile, upload, heartbeat } = require('./src/sync');

const log = (...a) => console.log(...a);
const stamp = () => new Date().toLocaleString();

/**
 * One readline interface for a whole conversation, not one per question.
 *
 * Creating and closing an interface per prompt works at a terminal and breaks
 * the moment stdin is a pipe: the first interface buffers everything
 * available, and closing it ends the stream, so every later question reads EOF
 * and silently returns ''. That matters beyond testing — an installer running
 * this unattended feeds answers in exactly that way, and the failure is a
 * pairing that stops halfway with no error.
 */
function prompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (question) => {
      try {
        return (await rl.question(question)).trim();
      } catch {
        return '';   // stdin closed — treat as "no answer", never crash
      }
    },
    close: () => rl.close(),
  };
}

// ------------------------------------------------------------------- pair --

async function cmdPair(args) {
  const code = (args[0] || '').trim().toUpperCase();
  if (!code) {
    log('Usage: rxnaija-sync pair SY-XXXX');
    log('Get the code from your RxNaija dashboard: Settings > Stock sync.');
    process.exitCode = 1;
    return;
  }

  const folderFlag = args.indexOf('--folder');
  let watchPath = folderFlag !== -1 ? args[folderFlag + 1] : null;

  // Flags so an installer can pair without a human at the keyboard. Silence is
  // never taken as consent: --share is an explicit opt IN, and its absence
  // means the software list is not sent.
  const shareFlag = args.includes('--share');
  const noPrompt = args.includes('--silent');
  const posFlag = args.indexOf('--pos');
  const posArg = posFlag !== -1 ? args[posFlag + 1] : null;

  const apiUrl = process.env.RXNAIJA_API || config.read().apiUrl;
  const io = prompter();

  log('\nLooking at what is installed on this computer...\n');
  const found = await detect();

  // ---- consent. Nothing has left this machine yet, and nothing will until
  // the answer below is yes. See detect.js's header for why this sequence is
  // the whole difference between onboarding software and something else.
  log('To work out which stock software you use, RxNaija would send this list:');
  log('');
  if (found.programs.length === 0) {
    log('  (no programs detected)');
  } else {
    found.programs.slice(0, 25).forEach((p) => log(`  - ${p}`));
    if (found.programs.length > 25) log(`  ... and ${found.programs.length - 25} more`);
  }
  if (found.dbEngines.length) log(`\n  Database software: ${found.dbEngines.join(', ')}`);
  log('');
  log('That is program NAMES only. Not your files, not your patient records,');
  log('not anything inside your stock database.');
  log('');

  let shareFingerprint = shareFlag;
  if (!noPrompt && !shareFlag) {
    const consent = (await io.ask('Send this list so RxNaija can recognise your software? [y/N] ')).toLowerCase();
    shareFingerprint = consent === 'y' || consent === 'yes';
  }
  if (!shareFingerprint) {
    log('\nNot sending it — pairing without it. Syncing works either way.');
  }

  // ---- which one is theirs
  let pos = posArg || null;
  if (!pos && !noPrompt && shareFingerprint && found.programs.length > 0) {
    log('\nWhich of these is your stock software?');
    const shortlist = (found.likely.length ? found.likely : found.programs).slice(0, 15);
    shortlist.forEach((p, i) => log(`  ${i + 1}. ${p}`));
    log(`  ${shortlist.length + 1}. None of these / not sure`);
    const pick = await io.ask('\nNumber (or press Enter to skip): ');
    const n = parseInt(pick, 10);
    if (n >= 1 && n <= shortlist.length) pos = shortlist[n - 1];
  }

  // ---- where the export lands
  if (!watchPath) {
    const suggested = process.platform === 'win32' ? 'C:\\RxNaija\\export' : path.join(config.home(), 'export');
    if (noPrompt) {
      watchPath = suggested;
    } else {
      log('\nWhich folder does your stock software export to?');
      log(`(press Enter to use ${suggested} — you will need to point your POS at it)`);
      const answer = await io.ask('Folder: ');
      watchPath = answer || suggested;
    }
  }
  io.close();

  // ABSOLUTE, always. Someone typing "RxNaija" at the folder prompt means a
  // folder they can point at, but a relative path resolves against whatever
  // directory this process happened to start in — Explorer's, a shortcut's
  // working directory, or C:\Windows\system32 once this runs as a service.
  // The agent would then watch a different folder depending on how it was
  // launched, find nothing, and report "no spreadsheet in RxNaija" about a
  // folder the pharmacist is looking straight at.
  watchPath = path.resolve(watchPath);

  try {
    fs.mkdirSync(watchPath, { recursive: true });
  } catch (e) {
    log(`\nCould not create ${watchPath}: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // ---- redeem
  log('\nConnecting to RxNaija...');
  let res;
  try {
    res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/sync/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        label: `${require('node:os').hostname()}`,
        pos,
        watchPath,
        fingerprint: shareFingerprint
          ? { programs: found.programs.slice(0, 100), dbEngines: found.dbEngines, dbServices: found.dbServices }
          : null,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    log(`\nCould not reach RxNaija (${e.message}). Check this computer's internet connection.`);
    process.exitCode = 1;
    return;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`\n${body.error || 'Pairing failed.'}`);
    process.exitCode = 1;
    return;
  }

  config.write({ apiUrl, token: body.token, deviceId: body.deviceId, watchPath, pos });

  log('\n  Connected.\n');
  log(`  This computer is now linked to your pharmacy.`);
  log(`  Watching: ${watchPath}`);
  log('');
  log('  Next: export your product list from your stock software into that');
  log('  folder, then run:  rxnaija-sync sync');
  log('');
}

// ------------------------------------------------------------------- sync --

async function runOnce({ quiet = false } = {}) {
  const c = config.read();
  if (!c.token) {
    if (!quiet) log('This computer is not paired yet. Run: rxnaija-sync pair SY-XXXX');
    return { ok: false, reason: 'not_paired' };
  }

  await heartbeat(c);

  let file;
  try {
    file = newestExport(c.watchPath);
  } catch (e) {
    if (!quiet) log(`[${stamp()}] The export folder is missing: ${c.watchPath}`);
    return { ok: false, reason: 'no_folder' };
  }

  if (!file) {
    if (!quiet) log(`[${stamp()}] Nothing to send — no spreadsheet in ${c.watchPath}`);
    return { ok: false, reason: 'no_file' };
  }

  if (!looksSettled(file)) {
    if (!quiet) log(`[${stamp()}] ${file.name} is still being written. Leaving it for the next check.`);
    return { ok: false, reason: 'still_writing' };
  }

  const hash = hashFile(file.path);
  if (hash === c.lastHash) {
    if (!quiet) log(`[${stamp()}] ${file.name} has not changed since the last sync. Nothing to do.`);
    return { ok: true, reason: 'unchanged' };
  }

  try {
    const result = await upload({ apiUrl: c.apiUrl, token: c.token, filePath: file.path, fileName: file.name });
    // Recorded only on a successful send, so a failure re-sends the same file
    // next time rather than skipping it forever as "already done".
    config.write({ lastHash: hash });

    if (result.status === 'needs_review') {
      log(`[${stamp()}] Sent ${file.name}. Someone needs to check the columns in the dashboard before it can be imported (${result.reason}).`);
      return { ok: true, reason: 'needs_review' };
    }
    log(`[${stamp()}] Sent ${file.name} — ${result.imported} products updated.`);
    return { ok: true, reason: 'imported', result };
  } catch (e) {
    if (e.code === 'UNPAIRED') {
      log(`[${stamp()}] This computer has been disconnected in the dashboard. Pair it again to resume.`);
      return { ok: false, reason: 'unpaired' };
    }
    log(`[${stamp()}] Could not send ${file.name}: ${e.message}`);
    return { ok: false, reason: 'failed' };
  }
}

// ------------------------------------------------------------------ watch --

async function cmdWatch() {
  const c = config.read();
  if (!c.token) {
    log('This computer is not paired yet. Run: rxnaija-sync pair SY-XXXX');
    process.exitCode = 1;
    return;
  }

  const everyMs = Math.max(5, Number(c.intervalMinutes) || 360) * 60000;
  log(`RxNaija Sync running. Watching ${c.watchPath}, checking every ${Math.round(everyMs / 60000)} minutes.`);
  log('Leave this running, or install it as a service so it starts with the computer.');

  // Immediately, then on the interval. A program that waits six hours before
  // its first check looks broken to whoever just installed it.
  await runOnce();
  setInterval(() => { runOnce().catch(() => {}); }, everyMs);
}

// ----------------------------------------------------------------- status --

async function cmdStatus() {
  const c = config.read();
  log('');
  log(`  Config:    ${config.CONFIG_PATH()}`);
  log(`  Server:    ${c.apiUrl}`);
  log(`  Paired:    ${c.token ? `yes (device ${c.deviceId})` : 'no'}`);
  log(`  Software:  ${c.pos || '(not recorded)'}`);
  log(`  Watching:  ${c.watchPath || '(not set)'}`);
  log(`  Every:     ${c.intervalMinutes} minutes`);

  if (c.watchPath) {
    try {
      const f = newestExport(c.watchPath);
      log(`  Newest:    ${f ? `${f.name} (${f.stat.mtime.toLocaleString()})` : '(no spreadsheet in that folder)'}`);
      if (f) log(`  Sent:      ${hashFile(f.path) === c.lastHash ? 'yes, already sent' : 'no, would send on next check'}`);
    } catch {
      log(`  Newest:    THE FOLDER IS MISSING — ${c.watchPath}`);
    }
  }
  log('');
}

// ------------------------------------------------------------------- main --

/**
 * What happens when somebody double-clicks the .exe.
 *
 * A console program launched from Explorer gets no arguments and closes the
 * instant it returns — so printing usage and exiting shows a black window that
 * flashes and vanishes, which reads as "the program is broken". The person
 * doing this is a pharmacist who was told to run it, not someone who is going
 * to open a command prompt.
 *
 * So: no arguments, a real console, nothing paired yet -> just ask for the
 * code, which is the only thing they were given.
 */
async function firstRun() {
  log('');
  log('  RxNaija Sync');
  log('  ------------');
  log('');
  log('  This connects this computer to your pharmacy on RxNaija,');
  log('  so your stock list updates by itself.');
  log('');
  log('  Get your code from the RxNaija dashboard:');
  log('     Settings > Stock sync > Connect a computer');
  log('');

  const io = prompter();
  const code = await io.ask('  Pairing code (looks like SY-4K7P): ');
  io.close();

  if (!code) {
    log('\n  No code entered. Run this again when you have one.');
    return;
  }
  await cmdPair([code.toUpperCase()]);
}

/** Keep the window open, or everything above is unreadable. */
async function pauseIfLaunchedFromExplorer() {
  if (!process.stdin.isTTY) return;
  const io = prompter();
  await io.ask('\n  Press Enter to close this window. ');
  io.close();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd && process.stdin.isTTY) {
    if (config.isPaired()) {
      // Already set up — the useful thing to show is whether it is working,
      // not a list of commands they will not type.
      await cmdStatus();
      await runOnce();
    } else {
      await firstRun();
    }
    return pauseIfLaunchedFromExplorer();
  }

  switch (cmd) {
    case 'pair':   return cmdPair(args);
    case 'sync':   return void (await runOnce());
    case 'watch':  return cmdWatch();
    case 'status': return cmdStatus();
    default:
      log('RxNaija Sync\n');
      log('  rxnaija-sync pair SY-XXXX   connect this computer to your pharmacy');
      log('  rxnaija-sync sync           send the latest export now');
      log('  rxnaija-sync watch          keep running and send on a schedule');
      log('  rxnaija-sync status         show what it is doing');
      log('');
      if (!config.isPaired()) log('This computer is not paired yet.\n');
  }
}

main().catch(async (e) => {
  console.error(`\n  Something went wrong: ${e.message}`);
  await pauseIfLaunchedFromExplorer();
  process.exit(1);
});

module.exports = { runOnce };
