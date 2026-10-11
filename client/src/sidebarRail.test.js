/**
 * The sidebar's hover-to-open behaviour, pinned as structural invariants on
 * index.css — the same approach as architecture.test.js. Hover and motion
 * cannot be meaningfully exercised without a real browser, but the rules
 * that make them safe are plain text, and each one below defends a specific
 * way this interaction goes wrong:
 *
 *   - a keyboard user tabbing through a closed strip, reading nothing;
 *   - a tap on a tablet leaving the panel stuck open over the page;
 *   - someone who asked their OS for reduced motion getting a sweeping panel;
 *   - the panel animating `width`, which re-lays-out the column every frame;
 *   - labels hidden in a way that also hides them from screen readers.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');

/**
 * Every rule whose selector mentions `needle`, with the @media prelude it
 * sits inside (or null at top level). A small brace-depth walk — enough for
 * this one stylesheet, which has no nested at-rules beyond @media.
 */
function rulesMatching(needle) {
  const found = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < CSS.length; i += 1) {
    const ch = CSS[i];
    if (ch === '{') {
      const prelude = CSS.slice(start, i).trim();
      const depthBefore = stack.length;
      stack.push(prelude);
      if (!prelude.startsWith('@') && prelude.includes(needle)) {
        const end = CSS.indexOf('}', i);
        const media = stack.slice(0, depthBefore).reverse().find((p) => p.startsWith('@media')) || null;
        found.push({ selector: prelude, body: CSS.slice(i + 1, end), media });
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1;
    }
  }
  return found;
}

/* ==========================================================================
 * AMENDED WHOLESALE 2026-10-11 — the sidebar is always open
 *
 * Ten tests lived here and pinned a sidebar that opened on hover, could be
 * pinned, revealed itself with a clip-path mask rather than by animating
 * width, faded its labels in on a 16ms cascade, and remembered the pin in
 * localStorage. Each named a real failure it defended — a keyboard user
 * tabbing through a closed strip, a tap leaving the panel stuck open over
 * the page, a sweeping panel for somebody who asked for reduced motion.
 *
 * THE PRODUCT CHANGED (SHELL_PLAN.md phase 1, owner 2026-10-11): the
 * sidebar is always open, so none of those states exists. A test for how a
 * panel opens, when nothing opens, is not protection — it is a comment
 * that fails.
 *
 * They are REPLACED, not deleted, and what replaces them is the invariant
 * that keeps the old machinery from creeping back: there is exactly ONE
 * state. That is a stronger claim than any of the ten, because the bugs
 * they guarded were all consequences of having four.
 * ======================================================================== */

// THE MOST IMPORTANT TEST IN THIS FILE.
test('the sidebar has exactly one state', () => {
  // Four states (closed, hover-open, pinned, focus-open) is what produced
  // every failure the ten removed tests defended against. One state cannot
  // be stuck open, cannot hide a label from a keyboard user, and cannot
  // sweep at somebody who asked for no motion.
  //
  // Pinned as the ABSENCE of the machinery, because that is what would come
  // back: a hover rule added "just for wide screens" rebuilds the whole
  // problem one selector at a time.
  expect(rulesMatching('.ui-rail:hover'), 'the sidebar opens on hover again').toEqual([]);
  expect(rulesMatching(".ui-rail[data-pinned='true']"), 'the pin is back').toEqual([]);
  expect(rulesMatching('.ui-rail:has(:focus-visible)'), 'a focus-open state is back').toEqual([]);

  // And the variables those states swapped are gone with them. A rule that
  // still reads --rail-inset is a rule waiting for a state to set it.
  for (const dead of [
    '--rail-inset', '--rail-label-opacity', '--rail-closed-only',
    '--rail-pill-inset', '--rail-shadow', '--rail-rest-ring',
  ]) {
    expect(CSS, `${dead} survives the state it belonged to`).not.toContain(dead);
  }

  // The App no longer carries the pin either — its state, its control and
  // its remembered preference.
  for (const gone of ['railPinned', 'toggleRail', 'rxnaija.rail.pinned', 'ui-rail-pin']) {
    expect(APP, `${gone} survives the pin`).not.toContain(gone);
  }
});

test('every label is readable without moving the pointer', () => {
  // The point of the change, and the thing the old sidebar could not do.
  // Labels used to be opacity-hidden until the panel opened, which is why
  // one of the removed tests had to assert they stayed in the accessibility
  // tree. Nothing hides them now, so nothing has to compensate.
  expect(CSS, 'the label fade is back').not.toContain('.ui-rail-fade');
  expect(APP, 'rows still carry the fade class').not.toContain('ui-rail-fade');

  // And the marks that existed only because a 56px strip had nowhere to put
  // a count. Drawing them now would show every badge twice.
  expect(CSS).not.toContain('.ui-rail-closed-only');
  expect(APP).not.toContain('ui-rail-closed-only');
});

test('the sidebar occupies its width instead of covering the page', () => {
  // The old panel was positioned over the content, because a 56px strip
  // that grew to 214px would have shoved every table sideways as the cursor
  // passed. An always-open sidebar has no such moment, so it takes its
  // space honestly and nothing is ever underneath it.
  expect(APP).toMatch(/w-\[250px\]/);
  expect(APP, 'the rail floats over the page again').not.toMatch(/ui-rail absolute/);

  // No width transition either: there is no second width to animate to, and
  // a sidebar that resizes on load is a page that jumps while you read it.
  expect(APP, 'the shell animates its width').not.toMatch(/transition-\[width\]/);
});
test('only hover and the current page mark a row', () => {
  // AMENDED with the shell. This used to be about the COLLAPSED STRIP:
  // `.ui-rail-pill` was transparent at rest, so each icon was a bare glyph
  // floating in a 56px column — measured at 466px of empty strip, which is
  // what the owner called "sparse".
  //
  // There is no collapsed strip now, and the rule it produced is still
  // right: a row is a tile, and the active one is a tile that is clearly
  // different. What changed is only that the pill is always the full row.
  const pill = rulesMatching('.ui-rail-pill').find((r) => r.media === null
    && r.selector.trim() === '.ui-rail-pill');
  expect(pill, 'the .ui-rail-pill rule is gone').toBeTruthy();
  // AMENDED AGAIN THE SAME DAY, and the reversal is the point. A hairline
  // resting ring was added on 2026-10-10 to fix a SPARSE 56px strip — four
  // bare glyphs floating in a column that was 466px empty. That strip is
  // gone, and at full width the same ring turned the nav into eleven boxes
  // competing with the one that says where you are. The fix outlived its
  // problem, so a row at rest now draws nothing.
  expect(pill.body, 'a resting row marks itself again').not.toMatch(/box-shadow:\s*inset/);

  // Three levels, still kept apart: a hairline at rest, a fill on hover,
  // and a WHITE tile with inset rings for "you are here". The active one
  // goes lighter while the others go darker, so it stays the odd one out
  // for anyone who cannot separate two greys.
  const hover = rulesMatching('.ui-rail-row:hover .ui-rail-pill')[0];
  expect(hover, 'hover no longer changes a row').toBeTruthy();
  expect(hover.body).toMatch(/background-color/);

  const active = rulesMatching('.ui-rail-row[aria-current="page"] .ui-rail-pill')[0];
  expect(active, 'the current page is no longer marked').toBeTruthy();
  expect(active.body).toMatch(/background-color:\s*var\(--ui-sidebar-active\)/);
});
test('the rail draws its icons heavier than the same icon on white', () => {
  // The owner's other words: the icons are "too thin". Icons.jsx draws at
  // stroke-width 2 on a 24 viewBox rendered at 22px — an effective 1.83px —
  // and at --ui-ink-soft on the sidebar's near-white that reads washed out.
  //
  // The COLOUR is design.md's explicit choice for inactive nav and is left
  // alone. The weight is specified nowhere, and is what was actually wrong.
  const rule = rulesMatching('.ui-rail-row svg').find((r) => r.media === null);
  expect(rule, 'the rail no longer weights its icons').toBeTruthy();
  const weight = Number((rule.body.match(/stroke-width:\s*([\d.]+)/) || [])[1]);
  expect(weight, `rail icons draw at ${weight}`).toBeGreaterThan(2);

  // The current page is heavier still, so "you are here" survives for anyone
  // who cannot separate two greys — the same reasoning as the white tile.
  const active = rulesMatching('.ui-rail-row[aria-current="page"] svg').find((r) => r.media === null);
  expect(active, 'the active row draws its icon at the same weight as the rest').toBeTruthy();
  const activeWeight = Number((active.body.match(/stroke-width:\s*([\d.]+)/) || [])[1]);
  expect(activeWeight).toBeGreaterThan(weight);
});

/* ==========================================================================
 * Every module's screens, not only the one you are in (2026-10-10)
 * ======================================================================== */

test('the rail lists every module, not just the one you are in', () => {
  // The owner's call, reversing design.md's contextual nav. The strip used to
  // render `currentModule` alone — two rows on Clinics, in a 610px column,
  // measured at 466px empty. Every screen is now one click from everywhere.
  expect(APP).toMatch(/MODULES\.map\(\(m\) => \{/);
  expect(APP).toMatch(/sidebarFor\(m, \{ websiteEnabled \}\)/);

  // The old contextual branch is gone, not merely bypassed. `currentModule`
  // survives — the BREADCRUMB still needs to know where you are — so this
  // checks the rail specifically rather than the identifier.
  expect(APP).not.toMatch(/\{currentModule\s*\n?\s*\?\s*sidebarFor/);
});

test('a module with nothing to show contributes no heading', () => {
  // Branding's only screen is the website builder, which is gated until the
  // server says it is on. A heading over an empty group is a dead end: it
  // names a part of the app and then offers no way into it.
  expect(APP).toMatch(/if \(items\.length === 0\) return null;/);
});

test('the ends of the rail do not scroll away', () => {
  // Listing sixteen screens makes the list taller than a short viewport, so
  // the middle scrolls. The workspace row must not go with it: it is the way
  // home, and the connection status is the other end.
  //
  // AMENDED 2026-10-11: matched on `ui-rail absolute` until the sidebar
  // stopped floating over the page. The rule is unchanged — the ends stay
  // put — and the class it is read from moved.
  const nav = APP.match(/className="ui-rail [^"]*"/);
  expect(nav, 'the rail nav class is gone').toBeTruthy();
  expect(nav[0], 'the whole nav still scrolls').not.toMatch(/overflow-y-auto/);
  expect(nav[0]).toMatch(/overflow-hidden/);

  // The scrolling middle is its own element, and it is the flexible one.
  expect(APP).toMatch(/className="ui-rail-scroll min-h-0 flex-1 overflow-y-auto/);

  // `min-h-0` is load-bearing, not decoration: a flex child defaults to
  // min-height:auto, which refuses to shrink below its content, so without
  // it the list would push the connection status off the bottom instead of
  // scrolling.
  expect(APP).toMatch(/ui-rail-scroll min-h-0/);
});

test('the current screen scrolls itself into the rail, and the page stays put', () => {
  // A defect the all-modules list CREATED. With sixteen rows the highlighted
  // one is often below the fold — on Consultations it sits under Stock's
  // seven — so the sidebar would open showing a part of the app you are not
  // in, with no sign of where you are.
  expect(APP).toMatch(/activeRowRef/);
  expect(APP).toMatch(/rowRef=\{tab === itemTab \? activeRowRef : null\}/);
  expect(APP).toMatch(/useEffect\(\(\) => \{[\s\S]*?scrollIntoView[\s\S]*?\}, \[tab\]\);/);

  // `block: nearest` twice over: the shortest move, so an already-visible row
  // does not jump; and it will not scroll an ancestor that does not need it,
  // which here would mean scrolling the work surface because the nav moved.
  expect(APP).toMatch(/scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/);

  // NEVER smooth. This fires on every navigation, and a sidebar that slides
  // each time you change screen is motion nobody asked for — and motion that
  // prefers-reduced-motion could not switch off, because it is scripted
  // rather than a CSS transition.
  expect(APP).not.toMatch(/scrollIntoView\([^)]*smooth/);
});
