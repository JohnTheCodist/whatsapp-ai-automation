#!/usr/bin/env node
/**
 * The regression gate: run the suite, compare it to test-baseline.json, and
 * exit non-zero only for things that are actually new.
 *
 * WHY NOT JUST `npm test` IN CI
 * Because `npm test` exits 1 today, and will keep exiting 1 until seven known
 * failures are fixed. A gate that is red on every commit from the day it is
 * installed does not block anything — it gets ignored, then disabled, and the
 * one time it was right nobody was reading it. A gate has to be green when
 * the code is in its known state, or it is decoration.
 *
 * So the question this asks is not "did every test pass" but "did anything
 * get WORSE" — which is the actual question a regression gate exists to
 * answer, and the only one that can be enforced honestly against a suite
 * with a known-bad baseline.
 *
 * WHAT BLOCKS
 *   1. A failing test whose name is not in the baseline  -> a new regression
 *   2. Fewer passing tests than the baseline             -> tests stopped running
 *   3. More skipped tests than the baseline              -> coverage silently lost
 *
 * (3) is not pedantry. Every database suite in this repo skips itself when
 * TEST_DATABASE_URL is unset, and prints a cheerful `ok ... # SKIP`. A change
 * that made three more suites skip would look like a clean run in every
 * reporter, and 386 tests already prove nothing. Skips going UP is the exact
 * shape of an accident nobody notices.
 *
 * WHAT WARNS BUT DOES NOT BLOCK
 *   - A known failure that now passes. Good news, and the baseline is stale,
 *     but failing the build for it would punish somebody for fixing a bug.
 *
 * Usage:
 *   npm run test:ci             lint + suite + this comparison
 *   node scripts/check-baseline.js --json    machine-readable summary
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE_FILE = path.join(ROOT, 'test-baseline.json');

const asJson = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Running the suite
// ---------------------------------------------------------------------------

/**
 * Node's default reporter is TAP when stdout is not a TTY, but CI environments
 * vary and a reporter change would silently break the parsing below. Asking
 * for it explicitly means the format this parses is the format it gets.
 */
function runSuite() {
  // Files enumerated here rather than passed as a glob with `shell: true`.
  // On Windows process.execPath is "C:\Program Files\nodejs\node.exe", and
  // handing that to cmd.exe unquoted fails with "'C:\Program' is not
  // recognized" — the suite never runs and the gate reports a parse error
  // instead of a result. No shell means no quoting rules to get wrong, on
  // any platform.
  const dir = path.join(ROOT, 'server', 'tests');
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('server', 'tests', f));

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-reporter=tap', ...files],
      { cwd: ROOT },
    );

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
  });
}

/**
 * Pull results out of TAP.
 *
 * Failures are `not ok <n> - <name>`; skips are `ok <n> - <name> # SKIP ...`,
 * which is why the skip suffix has to be stripped rather than the whole line
 * being treated as a failure. Counts come from the trailing `# pass` / `# fail`
 * / `# skipped` summary lines rather than being recounted here — the runner's
 * own arithmetic is the thing being compared against.
 */
function parseTap(out) {
  const failures = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*not ok\s+\d+\s+-\s+(.*)$/);
    if (m) failures.push(m[1].replace(/\s+#\s.*$/, '').trim());
  }

  const num = (label) => {
    const m = out.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? parseInt(m[1], 10) : null;
  };

  return {
    failures,
    total: num('tests'),
    pass: num('pass'),
    failed: num('fail'),
    skipped: num('skipped'),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compare(actual, baseline) {
  const known = new Set(baseline.knownFailures.map((f) => f.name));
  const seen = new Set(actual.failures);

  const blocking = [];
  const warnings = [];

  const newFailures = actual.failures.filter((n) => !known.has(n));
  if (newFailures.length) {
    blocking.push({
      kind: 'new_failures',
      detail: newFailures,
      message: `${newFailures.length} test(s) failed that are not in the baseline.`,
    });
  }

  if (actual.pass !== null && actual.pass < baseline.counts.pass) {
    blocking.push({
      kind: 'fewer_passing',
      message: `Passing count fell from ${baseline.counts.pass} to ${actual.pass}. `
        + 'Tests that used to run are no longer running or no longer passing.',
    });
  }

  if (actual.skipped !== null && actual.skipped > baseline.counts.skipped) {
    blocking.push({
      kind: 'more_skipped',
      message: `Skipped count rose from ${baseline.counts.skipped} to ${actual.skipped}. `
        + 'A suite stopped running. A skip is not a pass.',
    });
  }

  const fixed = [...known].filter((n) => !seen.has(n));
  if (fixed.length) {
    warnings.push({
      kind: 'baseline_stale',
      detail: fixed,
      message: `${fixed.length} known failure(s) now pass. Remove them from `
        + 'test-baseline.json and AGENTS.md in your next commit.',
    });
  }

  if (actual.skipped !== null && actual.skipped < baseline.counts.skipped) {
    warnings.push({
      kind: 'fewer_skipped',
      message: `Skipped count fell from ${baseline.counts.skipped} to ${actual.skipped} — `
        + 'more of the suite is running than the baseline assumed. If this is '
        + 'because TEST_DATABASE_URL is now configured, update the baseline.',
    });
  }

  return { blocking, warnings };
}

// ---------------------------------------------------------------------------

function line(s = '') { process.stdout.write(`${s}\n`); }

(async () => {
  if (!fs.existsSync(BASELINE_FILE)) {
    line('test-baseline.json is missing. There is nothing to compare against.');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));

  const { out } = await runSuite();
  const actual = parseTap(out);

  if (actual.total === null) {
    line('Could not read a TAP summary from the test run. Raw output follows.\n');
    line(out.slice(-4000));
    process.exit(1);
  }

  const { blocking, warnings } = compare(actual, baseline);

  if (asJson) {
    line(JSON.stringify({ actual, baseline: baseline.counts, blocking, warnings }, null, 2));
    process.exit(blocking.length ? 1 : 0);
  }

  line('');
  line('  Regression gate');
  line('  ---------------');
  line(`  baseline   ${baseline.commit} (${baseline.measuredOn})`);
  line('');
  line(`               ${'now'.padStart(6)}  ${'baseline'.padStart(8)}`);
  line(`  total      ${String(actual.total).padStart(6)}  ${String(baseline.counts.total).padStart(8)}`);
  line(`  pass       ${String(actual.pass).padStart(6)}  ${String(baseline.counts.pass).padStart(8)}`);
  line(`  skipped    ${String(actual.skipped).padStart(6)}  ${String(baseline.counts.skipped).padStart(8)}`);
  line(`  failed     ${String(actual.failed).padStart(6)}  ${String(baseline.counts.failed).padStart(8)}`);
  line('');

  for (const w of warnings) {
    line(`  NOTE  ${w.message}`);
    for (const d of w.detail || []) line(`          - ${d}`);
    line('');
  }

  if (!blocking.length) {
    line('  PASS — no new failures, nothing stopped running, nothing new skipped.');
    line('');
    process.exit(0);
  }

  for (const b of blocking) {
    line(`  BLOCKED  ${b.message}`);
    for (const d of b.detail || []) line(`             - ${d}`);
    line('');
  }

  line('  Do not fix this by weakening or skipping a test (AGENTS.md, rule 2).');
  line('  If the product behaviour genuinely changed, change the test and the');
  line('  baseline together, in the same commit, with the reason recorded.');
  line('');
  process.exit(1);
})();
