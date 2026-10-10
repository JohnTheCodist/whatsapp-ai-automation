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

test('keyboard focus inside the sidebar opens it, not only the mouse', () => {
  const rules = rulesMatching('.ui-rail:has(:focus-visible)');
  const open = rules.find((r) => r.media === null);
  expect(open, 'a top-level .ui-rail:has(:focus-visible) rule').toBeTruthy();
  expect(open.body).toMatch(/--rail-label-opacity:\s*1/);
});

test('hover opens the sidebar only for a real pointer, so a tap cannot leave it stuck open', () => {
  const hovers = rulesMatching('.ui-rail:hover');
  expect(hovers.length).toBeGreaterThan(0);
  for (const rule of hovers) {
    expect(rule.media, `"${rule.selector}" must sit inside an @media block`).not.toBeNull();
  }
  const opening = hovers.find((r) => /--rail-label-opacity:\s*1/.test(r.body));
  expect(opening.media).toMatch(/hover:\s*hover/);
  expect(opening.media).toMatch(/pointer:\s*fine/);
});

test('reduced motion removes the sweep and the slide, keeping only a short fade', () => {
  const reduced = rulesMatching('.ui-rail').filter((r) => r.media && /prefers-reduced-motion:\s*reduce/.test(r.media));
  expect(reduced.length).toBeGreaterThan(0);
  const body = reduced.map((r) => r.body).join('\n');
  expect(body).toMatch(/--rail-dur:\s*0ms/);
  expect(body).toMatch(/--rail-label-shift:\s*0px/);
  expect(body).toMatch(/--rail-label-stagger:\s*0ms/);
});

test('the panel is revealed with clip-path, never by animating its width', () => {
  const rail = rulesMatching('.ui-rail').find((r) => r.selector === '.ui-rail' && r.media === null);
  expect(rail.body).toMatch(/clip-path:/);
  expect(rail.body).toMatch(/transition:[\s\S]*clip-path/);
  for (const rule of rulesMatching('.ui-rail')) {
    expect(rule.body, `"${rule.selector}" must not transition width`).not.toMatch(/transition[^;]*\bwidth\b/);
  }
});

test('labels are hidden from eyes only, never from screen readers', () => {
  const fade = rulesMatching('.ui-rail-fade').find((r) => r.selector === '.ui-rail-fade');
  expect(fade.body).toMatch(/opacity:/);
  expect(fade.body).not.toMatch(/display:\s*none/);
  expect(fade.body).not.toMatch(/visibility:\s*hidden/);
});

// ---- pinned (2026-10-04, at the owner’s request) ------------------------

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('pinning is a third way into the SAME open state, not a second sidebar', () => {
  // design.md said "there is no toggle". The owner asked for one, so the doc
  // was amended rather than contradicted — and the thing that keeps a pin
  // from becoming a second sidebar is that it sets NO styles of its own: it
  // sets exactly the variables hover and focus set.
  const open = CSS.match(/\.ui-rail:has\(:focus-visible\)\s*\{([^}]*)\}/);
  expect(open, 'the keyboard-open rule has gone').toBeTruthy();
  const pinned = CSS.match(/\.ui-rail\[data-pinned='true'\]\s*\{([^}]*)\}/);
  expect(pinned, 'there is no pinned rule').toBeTruthy();

  const vars = (body) => (body.match(/--rail-[\w-]+(?=\s*:)/g) || []).sort();
  expect(vars(pinned[1]), 'pinned sets a different set of variables than hover/focus')
    .toEqual(vars(open[1]));

  // The labels really are revealed, not merely declared.
  expect(pinned[1]).toMatch(/--rail-label-opacity:\s*1/);
});

test('a pinned panel pushes the page; a hovered one covers it', () => {
  // A panel that is not going to close itself must not sit on top of the
  // first 214px of every screen. Hover keeps covering, because content that
  // jumped sideways as the cursor crossed would be worse than no sidebar.
  expect(APP, 'the strip\u2019s footprint does not follow the pin')
    .toMatch(/railPinned \? 'w-\[214px\]' : 'w-14'/);

  // The pinned panel drops the shadow: a layer that is now part of the page
  // should not keep pretending to float above it.
  const pinned = CSS.match(/\.ui-rail\[data-pinned='true'\]\s*\{([^}]*)\}/);
  expect(pinned[1]).toMatch(/--rail-shadow:\s*none/);
});

test('the pin says what it is to a screen reader, not only with a glyph', () => {
  // The control is "\u00bb" / "\u00ab", which is nothing at all to a screen
  // reader. The state rides on aria-pressed and the label is real text.
  expect(APP).toMatch(/aria-pressed=\{railPinned\}/);
  expect(APP).toMatch(/Keep the sidebar open/);
  expect(APP).toMatch(/Unpin the sidebar/);
  // The glyph itself is hidden from the accessibility tree.
  expect(APP).toMatch(/aria-hidden="true">\{railPinned \? '\u00ab' : '\u00bb'\}/);
});

test('a browser that refuses localStorage still gets a working sidebar', () => {
  // Private windows, blocked site data, and the thumbnail capture all throw
  // on access. Unpinned is the documented default, so falling back to it
  // changes nothing — but throwing would take the whole app down.
  const read = APP.match(/localStorage\.getItem\('rxnaija\.rail\.pinned'\)/);
  expect(read, 'the preference is not read at all').toBeTruthy();

  // Both the read and the write are guarded.
  const guarded = [...APP.matchAll(/try \{[^}]*rxnaija\.rail\.pinned[^}]*\}\s*catch/g)];
  expect(guarded.length, 'an unguarded localStorage call will throw in a private window')
    .toBe(2);
});

/* ==========================================================================
 * The collapsed strip's weight (2026-10-10)
 * ======================================================================== */

test('every icon in the collapsed strip sits on a tile, not loose in the column', () => {
  // The owner's words: the collapsed strip "looks sparse". Measured on a real
  // screen — four 36px rows in a 610px rail, 466px of it empty — and the
  // cause was that `.ui-rail-pill` was TRANSPARENT at rest, so each icon was
  // a bare glyph floating in a 56px column.
  //
  // design.md already specified otherwise: the collapsed strip is "36px icon
  // TILES". This was restoring the spec, not adding to it.
  const pill = rulesMatching('.ui-rail-pill').find((r) => r.media === null
    && r.selector.trim() === '.ui-rail-pill');
  expect(pill, 'the .ui-rail-pill rule is gone').toBeTruthy();
  expect(pill.body, 'the resting pill draws no mark at all')
    .toMatch(/box-shadow:\s*var\(--rail-rest-ring/);

  // A RING rather than a fill, and the reason is measurable. A resting fill
  // had to live between the sidebar's 97.9% lightness and hover's 94.6% —
  // about one and a half per cent — and the first attempt at 4% landed on
  // 94.8%, so close to hover that pointing at a row did nothing visible.
  // A hairline costs no lightness, so hover keeps its fill change.
  const closed = rulesMatching('.ui-rail').find((r) => r.media === null
    && r.selector.trim() === '.ui-rail');
  expect(closed.body).toMatch(/--rail-rest-ring:\s*inset/);
  expect(closed.body, 'the resting mark is a fill, which collides with hover')
    .toMatch(/--rail-rest-tile:\s*transparent/);

  // And it is cleared in every OPEN state — a mark on every full-width row
  // would be a boxed list rather than a panel.
  for (const sel of ['.ui-rail:hover', ".ui-rail[data-pinned='true']", '.ui-rail:has(:focus-visible)']) {
    const open = rulesMatching(sel).find((r) => r.selector.includes(sel));
    expect(open, `no rule for ${sel}`).toBeTruthy();
    expect(open.body, `${sel} keeps the resting ring`).toMatch(/--rail-rest-ring:\s*none/);
  }
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
