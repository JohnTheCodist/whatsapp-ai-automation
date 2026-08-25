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
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

const config = require('./src/config');
const database = require('./src/database');
const { detect } = require('./src/detect');
const { newestExport, looksSettled, hashFile, upload, heartbeat } = require('./src/sync');

const log = (...a) => console.log(...a);
const stamp = () => new Date().toLocaleString();

/** The Scheduled Task's name. Stable, so install is idempotent and uninstall can find it. */
const TASK_NAME = 'RxNaija Sync';

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
  // No commands named here. Whoever is standing at a pharmacy computer has no
  // command prompt open and no reason to learn one — the next step is offered
  // as a question a moment later instead. Naming commands to that person is
  // how "connected" turns into "nothing ever synced".
  log('  Next: put your product list in that folder — a spreadsheet exported');
  log('  from your stock software, or one you keep by hand. Either works.');
  log('');
}

// ------------------------------------------------------------------- sync --

async function runOnce({ quiet = false } = {}) {
  const c = config.read();
  if (!c.token) {
    if (!quiet) log('This computer is not paired yet. Run: rxnaija-sync pair SY-XXXX');
    return { ok: false, reason: 'not_paired' };
  }

  const beat = await heartbeat(c);
  if (beat.unpaired) {
    // The server has revoked this device. Forget the dead token rather than
    // keep presenting it — otherwise every later run reports "Paired: yes"
    // about a pairing that no longer exists, and the double-click flow never
    // offers to pair again because it believes it already is.
    config.clearPairing();
    if (!quiet) {
      log(`[${stamp()}] This computer has been disconnected in the dashboard.`);
      log('  Run it again to pair with a new code.');
    }
    return { ok: false, reason: 'unpaired' };
  }

  // ---- reading straight from the POS database -------------------------
  //
  // The whole point of this path is that nobody has to export anything, so it
  // runs before the folder is even looked at. Same upload, same pipeline, same
  // saved mapping — the rows just came from a table instead of a spreadsheet.
  if (c.source === 'database' && c.db?.table) {
    let csv;
    let rowCount;
    try {
      ({ csv, rowCount } = await database.exportToCsv(c.db));
    } catch (e) {
      // A pharmacy's POS goes down, gets moved, has its password changed. That
      // is an ordinary Tuesday, not a crash — and it must not stop the agent
      // running, or one bad night ends the sync permanently.
      if (!quiet) log(`[${stamp()}] Could not read ${c.db.database}.${c.db.table}: ${e.code || e.message}`);
      return { ok: false, reason: 'db_unreadable' };
    }

    if (!rowCount) {
      if (!quiet) log(`[${stamp()}] ${c.db.table} has no rows — nothing to send.`);
      return { ok: false, reason: 'db_empty' };
    }

    const buffer = Buffer.from(csv, 'utf8');
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hash === c.lastHash) {
      if (!quiet) log(`[${stamp()}] Stock is unchanged since the last check. Nothing to do.`);
      return { ok: true, reason: 'unchanged' };
    }

    const fileName = `${c.db.table}.csv`;
    try {
      const result = await upload({ apiUrl: c.apiUrl, token: c.token, buffer, fileName });
      config.write({ lastHash: hash });
      if (result.status === 'needs_review') {
        log(`[${stamp()}] Sent ${rowCount} rows from ${c.db.table}. Someone needs to check the columns in the dashboard before it can be imported (${result.reason}).`);
        return { ok: true, reason: 'needs_review' };
      }
      log(`[${stamp()}] Read ${rowCount} rows from ${c.db.table} — ${result.imported} products updated.`);
      return { ok: true, reason: 'imported', result };
    } catch (e) {
      if (e.code === 'UNPAIRED') {
        log(`[${stamp()}] This computer has been disconnected in the dashboard. Pair it again to resume.`);
        return { ok: false, reason: 'unpaired' };
      }
      log(`[${stamp()}] Could not send the stock list: ${e.message}`);
      return { ok: false, reason: 'failed' };
    }
  }

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

// ---------------------------------------------------------------- install --

/**
 * Register a Windows Scheduled Task so this runs without anyone opening it.
 *
 * WHY THIS HAD TO EXIST
 * `watch` only runs while its window is open, which makes "keep the catalogue
 * current automatically" depend on a pharmacist remembering to leave a black
 * console window open on the shop computer forever. Nobody does that, and the
 * first thing anyone does with an unexplained console window is close it. The
 * catalogue then silently stops updating, which is the exact failure the whole
 * Stock sync panel was built to shout about.
 *
 * Task Scheduler rather than a Windows Service: a service needs an installer
 * running as administrator, and this needs neither. A per-user task can be
 * created without elevation and still survives reboots.
 */
async function cmdInstall() {
  if (process.platform !== 'win32') {
    log('Scheduled installation is Windows-only. On another system, run "watch" from your own scheduler.');
    process.exitCode = 1;
    return;
  }
  if (!config.isPaired()) {
    log('Pair this computer first, then run install.');
    process.exitCode = 1;
    return;
  }

  const exe = process.execPath;
  if (/\bnode\.exe$/i.test(exe)) {
    // Running from source: the task would point at node.exe and lose the
    // script argument, producing a scheduled task that silently does nothing.
    log('Run this from the built rxnaija-sync.exe, not from source — the task needs a single');
    log('executable to point at.');
    process.exitCode = 1;
    return;
  }

  const hours = Math.max(1, Math.round((Number(config.read().intervalMinutes) || 360) / 60));
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);

  try {
    await run('schtasks', [
      '/Create', '/TN', TASK_NAME,
      '/TR', `"${exe}" sync`,
      '/SC', 'HOURLY', '/MO', String(hours),
      '/F',
    ], { windowsHide: true });
  } catch (e) {
    log(`\nCould not create the scheduled task: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
    return;
  }

  log('');
  log(`  Scheduled. This will now check for a new export every ${hours} hours,`);
  log('  on its own, whether or not anyone is signed in to this computer.');
  log('');
  log('  Nothing else to leave open. To stop it:  rxnaija-sync uninstall');
  log('');
}

async function cmdUninstall() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  try {
    await promisify(execFile)('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true });
    log('\n  Stopped. This computer will no longer send your stock file on a schedule.\n');
  } catch {
    log('\n  There was no scheduled task to remove.\n');
  }
}

/** Whether the schedule is currently registered. */
async function scheduleInstalled() {
  if (process.platform !== 'win32') return false;
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  try {
    await promisify(execFile)('schtasks', ['/Query', '/TN', TASK_NAME], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- status --

/** How long ago, in words a person uses. */
function ago(date) {
  if (!date) return null;
  const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Work out what is actually true, separately from printing it.
 *
 * WHY THIS IS NOT JUST A PRINTOUT OF THE CONFIG
 * The previous version listed the config file path, the server URL and a
 * device UUID. None of those are things a pharmacist can act on, and putting
 * them at the top buries the one line that matters — whether their prices are
 * reaching customers. Worse, a screen full of technical detail teaches people
 * that this program is not for them, so when it does need attention they
 * assume it needs a developer.
 *
 * Returns a verdict plus, when something is wrong, the steps to fix it. The
 * fix is part of the diagnosis: a problem stated without a remedy just makes
 * someone feel stuck.
 */
async function assess() {
  const c = config.read();
  const hours = Math.max(1, Math.round((Number(c.intervalMinutes) || 360) / 60));

  if (!c.token) {
    return {
      ok: false,
      headline: 'Not connected to a pharmacy yet',
      detail: 'This computer has not been linked to RxNaija.',
      steps: [
        'Open RxNaija and go to Settings > Stock sync',
        'Click "Connect a computer" and note the code',
        'Run this program again and type that code',
      ],
      c, hours,
    };
  }

  const beat = await heartbeat(c);
  if (beat.unpaired) {
    config.clearPairing();
    return {
      ok: false,
      headline: 'This computer was disconnected',
      detail: 'Somebody removed it in the RxNaija dashboard, so nothing is being sent.',
      steps: [
        'Open RxNaija and go to Settings > Stock sync',
        'Click "Connect a computer"',
        'Run this program again and type the new code',
      ],
      c, hours,
    };
  }
  if (beat.unreachable) {
    return {
      ok: false,
      headline: 'Cannot reach RxNaija',
      detail: 'This computer is not able to get online, or the internet is down.',
      steps: [
        'Check this computer is connected to the internet',
        'Try opening rxnaija.com in a web browser on this computer',
      ],
      c, hours,
    };
  }

  // Relative watch path, left by an older version. Saying so plainly beats
  // letting somebody read "the folder is missing" and go hunting for a folder
  // that is sitting exactly where they made it.
  if (c.watchPath && !path.isAbsolute(c.watchPath)) {
    return {
      ok: false,
      headline: 'The folder setting needs fixing',
      detail: `"${c.watchPath}" is not a full folder path, so this program looks in a different place depending on how it was started.`,
      steps: ['Choose "Change the folder" below and give the full path, e.g. C:\\RxNaija\\export'],
      c, hours,
    };
  }

  // Reading a database: the folder checks below do not apply at all, and
  // telling somebody their export folder is empty when nothing exports to a
  // folder any more would send them looking for a problem that is not there.
  if (c.source === 'database' && c.db?.table) {
    const scheduledDb = await scheduleInstalled();
    if (!scheduledDb) {
      return {
        ok: false,
        headline: 'Automatic sending is not set up',
        detail: `Your stock is read from ${c.db.table}, but only when somebody opens this program.`,
        steps: ['Choose "Set up automatic sending" below'],
        c, hours, scheduled: false, fromDb: true,
      };
    }
    return {
      ok: true,
      headline: 'Everything is working',
      c, hours, scheduled: true, fromDb: true,
    };
  }

  let newest = null;
  let folderMissing = false;
  if (c.watchPath) {
    try { newest = newestExport(c.watchPath); } catch { folderMissing = true; }
  }

  if (folderMissing) {
    return {
      ok: false,
      headline: 'The folder is missing',
      detail: `This program is watching ${c.watchPath}, but that folder does not exist.`,
      steps: [
        `Create the folder ${c.watchPath}, or`,
        'Choose "Change the folder" below to point somewhere else',
      ],
      c, hours,
    };
  }

  if (!newest) {
    return {
      ok: false,
      headline: 'No stock file found',
      detail: `There is no spreadsheet in ${c.watchPath}.`,
      steps: [
        `Save your product list into ${c.watchPath}`,
        'It can be an Excel file (.xlsx or .xls) or a .csv',
        'It needs a column for the product name and one for the price',
      ],
      c, hours, newest,
    };
  }

  const scheduled = await scheduleInstalled();
  const alreadySent = hashFile(newest.path) === c.lastHash;

  if (!scheduled) {
    return {
      ok: false,
      headline: 'Automatic sending is not set up',
      detail: 'Your stock file is only sent when somebody opens this program.',
      steps: ['Choose "Set up automatic sending" below — it takes a second and then runs on its own'],
      c, hours, newest, scheduled, alreadySent,
    };
  }

  return {
    ok: true,
    headline: 'Everything is working',
    c, hours, newest, scheduled, alreadySent,
  };
}

/** Print the verdict. Facts a pharmacist can act on; nothing else. */
function printStatus(s) {
  log('');
  log('  RxNaija Sync');
  log('  ============');
  log('');
  log(`  ${s.ok ? '' : '! '}${s.headline}`);
  if (s.detail) {
    log('');
    log(`  ${s.detail}`);
  }

  if (s.fromDb) {
    log('');
    log(`  Reading from      ${s.c.db.table} in ${s.c.db.database}`);
    log('  Exporting         not needed — read directly from your stock software');
  } else if (s.newest) {
    log('');
    log(`  Your stock file   ${s.newest.name}`);
    log(`  Last changed      ${ago(s.newest.stat.mtime)}`);
    if (s.alreadySent !== undefined) {
      log(`  Sent to RxNaija   ${s.alreadySent ? 'yes' : 'not yet — will send on the next check'}`);
    }
  }
  if (s.ok) {
    log(`  Checks for changes  every ${s.hours} hours, on its own`);
    log('');
    log('  Nothing for you to do. You can close this window.');
  }

  if (s.steps?.length) {
    log('');
    log('  What to do');
    s.steps.forEach((step, i) => log(`    ${s.steps.length > 1 ? `${i + 1}. ` : ''}${step}`));
  }
  log('');
}

async function cmdStatus() {
  printStatus(await assess());
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

/**
 * Offer to set up the schedule, in the flow, rather than naming a command.
 *
 * WHY THIS IS A QUESTION AND NOT A LINE OF DOCUMENTATION
 * The whole reason this ships as one double-clickable file is that a pharmacy
 * computer has nobody who opens a command prompt. Telling that person to "run
 * rxnaija-sync install" is telling them to do the one thing this program was
 * built to avoid — and until they do it, nothing sends on a schedule, so the
 * catalogue silently stops being current while the dashboard shows a computer
 * connected.
 *
 * Defaults to yes because it is what almost everyone wants, and because the
 * cost of it being wrong is one scheduled task nobody notices, against a
 * catalogue that never updates.
 */
async function offerSchedule() {
  if (process.platform !== 'win32') return;
  if (!config.isPaired()) return;
  if (await scheduleInstalled()) return;

  log('');
  log('  One more thing.');
  log('');
  log('  Right now this only sends your stock file when you open it. It can do');
  log('  that by itself every few hours instead, with nothing left open.');
  log('');

  const io = prompter();
  const answer = (await io.ask('  Set that up now? [Y/n] ')).trim().toLowerCase();
  io.close();

  if (answer === '' || answer === 'y' || answer === 'yes') {
    await cmdInstall();
  } else {
    log('\n  Left off. Open this again any time to set it up.\n');
  }
}

/** Keep the window open, or everything above is unreadable. */
async function pauseIfLaunchedFromExplorer() {
  if (!process.stdin.isTTY) return;
  const io = prompter();
  await io.ask('\n  Press Enter to close this window. ');
  io.close();
}

/**
 * Point the agent at the POS database instead of a folder.
 *
 * WHY THIS IS WORTH A GUIDED FLOW RATHER THAN A CONFIG FILE
 * This is the step that removes the last human action from the whole system —
 * after it, nobody exports anything, ever. That makes it worth a few questions
 * asked well, on the one occasion it happens.
 *
 * The pharmacist is not asked to know their schema. They are shown the tables
 * that look like a product list, best first, with a few real rows from the one
 * they pick so they can see for themselves whether it is right. "Does this
 * look like your products?" is a question anyone can answer; "which table is
 * your product master?" is not.
 */
async function setupDatabase() {
  const c = config.read();
  const io = prompter();

  log('');
  log('  Read your stock software\'s database');
  log('  -----------------------------------');
  log('');
  log('  This lets RxNaija read your product list directly, so nobody has to');
  log('  export anything. It only ever READS — it never changes, adds or');
  log('  deletes anything in your stock software.');
  log('');
  log('  You will need the database login your stock software uses. If you do');
  log('  not know it, whoever installed the software will.');
  log('');

  const host = (await io.ask('  Server [127.0.0.1]: ')).trim() || '127.0.0.1';
  const port = (await io.ask('  Port [3306]: ')).trim() || '3306';
  const user = (await io.ask('  Username [root]: ')).trim() || 'root';
  const password = await io.ask('  Password (leave blank if none): ');

  log('\n  Connecting...');
  let conn;
  try {
    conn = await database.connect({ host, port, user, password });
  } catch (e) {
    io.close();
    log('');
    log(`  Could not connect: ${e.code === 'ER_ACCESS_DENIED_ERROR' ? 'that username or password was refused' : (e.code || e.message)}`);
    log('');
    log('  What to do');
    log('    - Check the username and password with whoever installed your stock software');
    log('    - Make sure the stock software is running on this computer');
    log('');
    return;
  }

  try {
    const dbs = await database.listDatabases(conn);
    if (!dbs.length) {
      log('\n  That login worked, but it cannot see any databases.\n');
      return;
    }

    log('\n  Which database belongs to your stock software?\n');
    dbs.forEach((d, i) => log(`    ${i + 1}. ${d}`));
    const dbPick = Number((await io.ask('\n  Number: ')).trim());
    const chosenDb = dbs[dbPick - 1];
    if (!chosenDb) { log('\n  Nothing chosen.\n'); return; }

    log('\n  Looking at the tables...');
    const tables = await database.listTables(conn, chosenDb);
    const likely = tables.slice(0, 8);

    log('\n  Which table holds your products? (most likely first)\n');
    likely.forEach((t, i) => {
      log(`    ${i + 1}. ${t.table}  —  ${t.rows} rows${t.hasName && t.hasPrice ? '  (has a name and a price column)' : ''}`);
    });
    const tPick = Number((await io.ask('\n  Number: ')).trim());
    const chosen = likely[tPick - 1];
    if (!chosen) { log('\n  Nothing chosen.\n'); return; }

    // Shown BEFORE anything is saved. A pharmacist cannot verify a table name,
    // but they can absolutely recognise their own products.
    const rows = await database.sample(conn, chosenDb, chosen.table, 3);
    log(`\n  The first few rows of ${chosen.table}:\n`);
    for (const r of rows) {
      const preview = Object.entries(r).slice(0, 4)
        .map(([k, v]) => `${k}=${v === null ? '(empty)' : String(v).slice(0, 30)}`)
        .join('  ');
      log(`    ${preview}`);
    }

    const yes = (await io.ask('\n  Are these your products? [y/N] ')).trim().toLowerCase();
    io.close();
    if (yes !== 'y' && yes !== 'yes') {
      log('\n  Left as it was. Run this again to try a different table.\n');
      return;
    }

    config.write({
      source: 'database',
      db: { host, port: Number(port), user, password, database: chosenDb, table: chosen.table },
    });

    log('');
    log(`  Set. RxNaija will now read ${chosen.table} directly — no exporting.`);
    log('');
    // Said plainly rather than buried: this is somebody's database password
    // sitting on a shop computer, and they are entitled to know where.
    log(`  Your database password is stored on this computer only, in`);
    log(`  ${config.CONFIG_PATH()}, readable only by administrators.`);
    log('  It is never sent to RxNaija.');
    log('');

    await runOnce();
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * What a double-click actually gets you.
 *
 * WHY A MENU AND NOT A LIST OF COMMANDS
 * Everything this program can do was previously reachable only by typing
 * `rxnaija-sync install` at a command prompt. Pharmacists do not have a
 * command prompt open, were never going to open one, and the program was
 * printing instructions written for whoever built it. A numbered list needs
 * no prior knowledge and no typing beyond one digit.
 *
 * The status is shown FIRST, every time, because the question someone opens
 * this program to answer is almost always "is it still working?" — and if the
 * answer is yes, they should be able to close the window without reading
 * anything else.
 */
async function menu() {
  const s = await assess();
  printStatus(s);

  // A device disconnected in the dashboard has just had its token cleared by
  // assess(). Offer to reconnect rather than showing a menu whose every entry
  // depends on a pairing that no longer exists.
  if (!config.isPaired()) {
    await firstRun();
    await offerSchedule();
    return;
  }

  const scheduled = s.scheduled ?? await scheduleInstalled();

  const fromDb = s.c.source === 'database';

  log('  What would you like to do?');
  log('');
  log('    1   Send my stock list now');
  log(fromDb
    ? '    2   Change which database table to read'
    : '    2   Change the folder it looks in');
  log(scheduled
    ? '    3   Stop sending automatically'
    : '    3   Set up automatic sending  (recommended)');
  log(fromDb
    ? '    4   Go back to reading a folder instead'
    : '    4   Read my stock software\'s database instead  (no exporting)');
  log('    5   Disconnect this computer from RxNaija');
  log('');

  const io = prompter();
  const choice = (await io.ask('  Type a number and press Enter, or just press Enter to close: ')).trim();

  if (choice === '1') {
    io.close();
    log('');
    await runOnce();
    return;
  }

  if (choice === '2') {
    const entered = (await io.ask(`\n  Full path to the folder (now: ${s.c.watchPath}): `)).trim();
    io.close();
    if (!entered) { log('\n  Nothing changed.\n'); return; }
    const resolved = path.resolve(entered);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (e) {
      log(`\n  Could not use that folder: ${e.message}\n`);
      return;
    }
    config.write({ watchPath: resolved });
    log(`\n  Now looking in ${resolved}\n`);
    await runOnce();
    return;
  }

  if (choice === '3') {
    io.close();
    if (scheduled) {
      const confirm = prompter();
      const yes = (await confirm.ask('\n  Stop sending automatically? Your prices will stop updating. [y/N] ')).trim().toLowerCase();
      confirm.close();
      if (yes === 'y' || yes === 'yes') await cmdUninstall();
      else log('\n  Left as it was.\n');
    } else {
      await cmdInstall();
    }
    return;
  }

  if (choice === '4') {
    io.close();
    if (fromDb) {
      // Back to a folder. The saved credentials go with it — keeping somebody's
      // database password on disk for a connection nothing uses any more is
      // not something to do quietly.
      config.write({ source: 'folder', db: null });
      log('\n  Now reading a folder again, and the saved database login has been removed.\n');
      await runOnce();
    } else {
      await setupDatabase();
    }
    return;
  }

  if (choice === '5') {
    const confirm = prompter();
    const yes = (await confirm.ask('\n  Disconnect this computer? Your prices will stop updating until you connect it again. [y/N] ')).trim().toLowerCase();
    confirm.close();
    io.close();
    if (yes === 'y' || yes === 'yes') {
      await cmdUninstall();
      config.clearPairing();
      log('\n  Disconnected. Run this program again to connect it back.\n');
    } else {
      log('\n  Left connected.\n');
    }
    return;
  }

  io.close();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd && process.stdin.isTTY) {
    if (config.isPaired()) {
      await menu();
    } else {
      await firstRun();
      await offerSchedule();
    }
    return pauseIfLaunchedFromExplorer();
  }

  switch (cmd) {
    case 'pair':      return cmdPair(args);
    case 'sync':      return void (await runOnce());
    case 'watch':     return cmdWatch();
    case 'status':    return cmdStatus();
    case 'install':   return cmdInstall();
    case 'uninstall': return cmdUninstall();
    default:
      log('RxNaija Sync\n');
      log('  rxnaija-sync pair SY-XXXX   connect this computer to your pharmacy');
      log('  rxnaija-sync install        run on a schedule, without leaving anything open');
      log('  rxnaija-sync sync           send the latest export now');
      log('  rxnaija-sync watch          keep running in this window and send periodically');
      log('  rxnaija-sync status         show what it is doing');
      log('  rxnaija-sync uninstall      stop the schedule');
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
