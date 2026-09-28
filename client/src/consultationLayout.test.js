/**
 * The consultation workspace's layout, pinned as structural invariants on
 * index.css and Consultation.jsx — the same approach as
 * `patientRecordNav.test.js` and `sidebarRail.test.js`, and for the same
 * reason: what a screen LOOKS like cannot be exercised without a real
 * browser, but the rules that keep it honest are plain text.
 *
 * Each test below defends a specific way this screen goes wrong.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const JSX = fs.readFileSync(path.join(SRC, 'Consultation.jsx'), 'utf8');

/** Every class name the workspace asks index.css for. */
const usedClasses = [...JSX.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)]
  .flatMap((m) => (m[1] || m[2]).split(/\s+/))
  .map((c) => c.replace(/\$\{.*/, '').trim())
  .filter((c) => c.startsWith('ui-'));

// THE MOST IMPORTANT TEST IN THIS FILE.
test('every ui- class the workspace uses is actually defined', () => {
  // Phase 1 shipped six `ui-consult-*` class names with NO styles behind them.
  // Nothing failed and no test noticed: the screen rendered, as a column of
  // unstyled boxes. A class name is a promise to the stylesheet, and this is
  // the only thing that checks it was kept.
  // Matched as a WHOLE token, not a substring. The first version used
  // CSS.includes(`.${c}`), and renaming .ui-consult-add to .ui-consult-addX
  // left it green — every prefix of a longer class name counted as defined.
  const defined = (c) => new RegExp(String.raw`\.` + c + String.raw`(?![\w-])`).test(CSS);
  const missing = [...new Set(usedClasses)].filter((c) => !defined(c));
  expect(missing, `no CSS rule for: ${missing.join(', ')}`).toEqual([]);
  // Guard the guard: if the extraction stops finding classes, the test above
  // passes vacuously.
  expect(usedClasses.length).toBeGreaterThan(15);
});

test('a tone is carried by a pill, never by a block that fills the panel', () => {
  // Found by reading the computed styles on the real screen: an emergency
  // referral put `ui-tone-1` on a <dd>, which is display:block — so instead of
  // an amber label the panel got a 662px tinted BAR, and `.ui-consult-summary
  // dd` outranked it on colour so the text was not even amber.
  expect(CSS).toMatch(/\.ui-tone-1\s*\{[^}]*background/);
  // Every tone in this screen goes on a span, and that span is a pill.
  for (const m of JSX.matchAll(/className=\{`([^`]*\$\{[a-zA-Z.]*tone[^`]*)`\}/g)) {
    expect(m[1], `tone used without a pill: ${m[1]}`).toMatch(/ui-\w+-pill/);
  }
  // And no element is given a bare tone as its whole class list.
  expect(JSX).not.toMatch(/className=\{\w*\.?tone\s*\|\|\s*''\}/);
});

test('the workspace names no tone of its own', () => {
  // The first draft of this test asserted the JSX contains an amber tone and
  // no red one. It found ZERO tones and failed — correctly, because the
  // premise was wrong: every tone on this screen comes from
  // consultationFormat.js, where `consultationFormat.test.js` already pins
  // that none of them is red.
  //
  // So the invariant worth having is the one that keeps it that way. A
  // literal `ui-tone-3` typed into this file would be red on a note, and it
  // would be invisible to the format tests.
  expect(JSX).not.toMatch(/ui-tone-\d/);
  // The tones are still reaching the screen, through the format module.
  expect(JSX).toMatch(/statusTone|\btone\b/);
});

test('the note reads as one column on a phone, with no two-line links', () => {
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px)', CSS.indexOf('.ui-consult ')));
  expect(mobile).toMatch(/\.ui-consult-body/);
  // A "Remove" pushed to the right of a wrapped row becomes a second line of
  // clickable text at phone width, which is the one thing that must not happen.
  expect(mobile).toMatch(/\.ui-consult-problems \.ui-psection-link/);
});
