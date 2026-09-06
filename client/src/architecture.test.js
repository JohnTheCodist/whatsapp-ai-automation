/**
 * Architectural boundaries the dashboard must keep.
 *
 * These are structural invariants, not behaviour: they assert the SHAPE that
 * makes a class of problem possible cannot be introduced, which is the same
 * reasoning as server/tests/golden.test.js. They need no DOM and no network,
 * so they always run.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Every .js/.jsx file under client/src, excluding this one. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(full, found); continue; }
    if (!/\.jsx?$/.test(entry.name)) continue;
    if (full === fileURLToPath(import.meta.url)) continue;
    found.push(full);
  }
  return found;
}

function importsGrapesjs(file) {
  const src = fs.readFileSync(file, 'utf8');
  return /from\s+['"]grapesjs|import\(\s*['"]grapesjs|require\(\s*['"]grapesjs/.test(src);
}

/**
 * The locked rule from WEBSITE_BUILDER_DECISIONS.md:
 *
 *   "GrapesJS is an implementation detail of the advanced editor. No other
 *    part of the application may depend directly on a GrapesJS API."
 *
 * TWO THINGS DEPEND ON THIS, and both are expensive to lose.
 *
 * 1. BUNDLE SIZE. Measured 2026-09-05: the dashboard's main chunk is 143.93 kB
 *    and GrapesJS is a further 1.15 MB. It stays out of the main chunk only
 *    while every path to it is a dynamic import from one lazily-loaded file.
 *    A single static `import 'grapesjs'` anywhere else pulls the whole editor
 *    into the initial download for every pharmacy that never opens it — and
 *    it does so silently, because the app still works, just slower.
 *
 * 2. REPLACEABILITY. The editor is one of two UIs over site_data. It stays
 *    swappable only while nothing else knows it exists.
 *
 * PHASE 1: no file may import it, because Editor.jsx does not exist yet.
 * PHASE 5: this expands to "only website/Editor.jsx may", and the allowlist
 * below is where that exception goes — one line, argued in that commit.
 */
/**
 * PHASE 5 ADDED EXACTLY ONE ENTRY, and this is the argument for it.
 *
 * Editor.jsx is the advanced editor. It is reached only through
 * `lazy(() => import('./Editor.jsx'))` in WebsitePanel.jsx, which is itself
 * reached only through `lazy(() => import('./website/WebsitePanel.jsx'))` in
 * App.jsx — two dynamic boundaries, so GrapesJS lands in its own chunk and
 * the dashboard's initial download never contains it.
 *
 * Measured 2026-09-06, after the change: main 609.89 kB, WebsitePanel 17.69 kB,
 * Editor 1,153.98 kB + 59.87 kB of CSS. The editor chunk is nearly twice the
 * size of the entire rest of the dashboard, which is the whole reason this
 * list exists and the reason a second entry should be argued as hard as this
 * one.
 */
const GRAPESJS_ALLOWED = [
  path.join('website', 'Editor.jsx'),
];

test('only the advanced editor may import grapesjs', () => {
  const offenders = sourceFiles()
    .filter(importsGrapesjs)
    .map((f) => path.relative(SRC, f))
    .filter((rel) => !GRAPESJS_ALLOWED.includes(rel));

  expect(offenders).toEqual([]);
});

/**
 * The dashboard's navigation is a `tab` string in App.jsx synced to the query
 * string, not a router. react-router-dom sits in package.json and is imported
 * nowhere.
 *
 * This is asserted rather than assumed because the website builder is the
 * first feature big enough to want nested URLs, and reaching for the
 * already-installed router is the obvious thing to do. It would work, and it
 * would leave the app with two navigation systems that disagree about what
 * the URL means — App.jsx would keep rewriting the query string underneath
 * the router.
 *
 * If routing is genuinely wanted, it is a deliberate migration of the whole
 * shell, not a second system introduced by one feature. Deleting this test is
 * how that decision gets made.
 */
/**
 * The allowlist above is only half of the bundle guarantee.
 *
 * Editor.jsx may import GrapesJS — but if anything imported Editor.jsx
 * STATICALLY, the 1.15 MB would be pulled straight back into whichever chunk
 * did it. A static `import Editor from './Editor.jsx'` is a one-word change
 * from the lazy form, looks harmless in review, and costs every pharmacy on
 * every page load. Nothing in the build fails; the app just gets slower.
 */
test('the advanced editor is only ever reached through a dynamic import', () => {
  const offenders = sourceFiles()
    .filter((f) => path.basename(f) !== 'Editor.jsx')
    .filter((f) => /^\s*import\s+[^;]*from\s+['"][^'"]*Editor\.jsx['"]/m.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f));

  expect(offenders).toEqual([]);
});

/**
 * And the same for the section as a whole.
 *
 * WebsitePanel pulls in the picker, the guided form, the publish bar and the
 * preview. None of that belongs in the chunk every member of staff downloads
 * to look at the Orders queue.
 */
test('the Website section is only ever reached through a dynamic import', () => {
  const offenders = sourceFiles()
    .filter((f) => !f.includes(`${path.sep}website${path.sep}`))
    .filter((f) => /^\s*import\s+[^;]*from\s+['"][^'"]*WebsitePanel\.jsx['"]/m.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f));

  expect(offenders).toEqual([]);
});

test('the dashboard has exactly one navigation system', () => {
  const offenders = sourceFiles()
    .filter((f) => /from\s+['"]react-router/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f));

  expect(offenders).toEqual([]);
});
