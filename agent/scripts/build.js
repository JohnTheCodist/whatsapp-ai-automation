#!/usr/bin/env node
/**
 * Builds rxnaija-sync.exe — one file a pharmacist can download and run.
 *
 * WHY A SINGLE EXECUTABLE AT ALL
 * The alternative is asking a pharmacy to install Node and copy a folder onto
 * the computer that runs their till. That is not a thing you can walk someone
 * through over the phone, and every extra step is a pharmacy that never gets
 * connected.
 *
 * HOW
 * Node's own Single Executable Application support: bundle the source to one
 * script, turn it into a blob, then inject that blob into a copy of the node
 * binary. The result needs no Node installed and no dependencies on the target
 * machine.
 *
 * BUILD-TIME DEPENDENCIES ARE NOT RUNTIME DEPENDENCIES
 * esbuild and postject are used here and ship in nothing. The agent itself
 * still imports only Node built-ins, which is exactly what makes this build
 * one bundle step instead of a dependency tree to flatten.
 *
 * WHAT THIS DOES NOT DO
 * Sign the result. An unsigned executable downloaded from the internet gets a
 * SmartScreen warning on Windows, and telling a pharmacist to click past a
 * security warning is teaching them a habit worth more to an attacker than
 * anything in this program. Signing needs a certificate you have to buy — see
 * the note printed at the end.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const AGENT = path.join(__dirname, '..');
const OUT = path.join(AGENT, 'dist');
const BUNDLE = path.join(OUT, 'bundle.js');
const BLOB = path.join(OUT, 'sea-prep.blob');
const SEA_CONFIG = path.join(OUT, 'sea-config.json');

const isWin = process.platform === 'win32';
const EXE = path.join(OUT, isWin ? 'rxnaija-sync.exe' : 'rxnaija-sync');

// Every tool is invoked as a real executable or a .js run by node — never
// through npx and never through a shell.
//
// Two failures got us here. Running through a shell splits node's own path,
// "C:\Program Files\nodejs\node.exe", at the space into "C:\Program". And
// Node 22 refuses to spawn a .cmd without a shell at all (EINVAL, part of the
// fix for CVE-2024-27980), which is what npx is on Windows. Pointing at the
// packages' own entry points sidesteps both, and means the build does not
// depend on npx resolution either.
const ESBUILD = path.join(
  AGENT, 'node_modules', '@esbuild',
  isWin ? 'win32-x64' : `${process.platform}-${process.arch}`,
  isWin ? 'esbuild.exe' : 'bin/esbuild',
);
const POSTJECT_CLI = path.join(AGENT, 'node_modules', 'postject', 'dist', 'cli.js');

const step = (m) => console.log(`\n==> ${m}`);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: AGENT, ...opts });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- bundle ---
step('Bundling to a single script');
run(ESBUILD, [
  'index.js',
  '--bundle',
  '--platform=node',
  '--target=node22',
  '--format=cjs',
  `--outfile=${BUNDLE}`,
]);

// SEA runs the bundle from inside the binary, where there is no __dirname to
// resolve against and no package.json to read. Anything the program needs to
// know about itself has to be in the bundle already — which it is, because the
// agent only ever reads config from ProgramData.
const bundled = fs.statSync(BUNDLE);
console.log(`    bundle: ${(bundled.size / 1024).toFixed(0)} KB`);

// ------------------------------------------------------------------ blob ---
step('Preparing the SEA blob');
fs.writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  // The agent reads no files from disk relative to itself, so there are no
  // assets to carry and no snapshot to build. Keeping both off keeps the
  // build on the supported path rather than the experimental edges of an
  // already-experimental feature.
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);

// ------------------------------------------------------------------- exe ---
step('Copying the Node binary');
fs.copyFileSync(process.execPath, EXE);

// A copied binary keeps the original's Authenticode signature, which no longer
// matches once a blob is injected. Removing it first avoids shipping something
// that looks tampered with rather than merely unsigned — the second is a
// warning, the first is a red flag.
if (isWin) {
  try {
    run('signtool', ['remove', '/s', EXE], { stdio: 'ignore' });
    console.log('    removed the inherited signature');
  } catch {
    console.log('    signtool not available — the inherited signature stays (harmless, still unsigned)');
  }
}

step('Injecting the application');
run(process.execPath, [
  POSTJECT_CLI, EXE, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

const built = fs.statSync(EXE);
console.log(`\n    ${EXE}`);
console.log(`    ${(built.size / 1048576).toFixed(0)} MB\n`);

console.log('Done. That file runs on a Windows PC with no Node installed.');
console.log('');
console.log('Before sending it to a pharmacy:');
console.log('  - It is UNSIGNED. Windows will show a SmartScreen warning, and');
console.log('    coaching someone to click past those is its own security problem.');
console.log('    A code-signing certificate fixes it properly.');
console.log('  - Test it on a machine that has never had Node installed. A build');
console.log('    host always has one, so a missing-runtime bug cannot show up here.');
console.log('');
