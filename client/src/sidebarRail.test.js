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
