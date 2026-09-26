/**
 * The patient record's navigation, pinned as structural invariants on
 * index.css — the same approach as sidebarRail.test.js, because hover and
 * motion cannot be meaningfully exercised without a real browser but the
 * rules that make them safe are plain text.
 *
 * Each test below defends a specific way this column goes wrong:
 *
 *   - it starts opening and closing on hover, which is exactly what the
 *     owner asked it not to do and what the app's main rail already does;
 *   - someone who asked their OS for reduced motion gets a sliding panel;
 *   - labels are hidden in a way that also hides them from screen readers;
 *   - the collapsed state stops being one data attribute and becomes two
 *     sources of truth that can disagree.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule whose selector mentions `needle`, with its @media prelude. */
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

test('this column NEVER opens or closes on hover — collapsing it is a choice', () => {
  // The whole point of the second sidebar: the main rail is hover-open, and
  // a record is worked in for minutes with the cursor crossing this column.
  for (const rule of rulesMatching('.ui-precord')) {
    if (!rule.selector.includes(':hover')) continue;
    expect(rule.body, `"${rule.selector}" must not change the column's width on hover`)
      .not.toMatch(/(^|[;{\s])width:|--precord-w:|--precord-label:/);
  }
});

test('collapsed is one state, carried by one data attribute', () => {
  const collapsed = rulesMatching('[data-collapsed="true"]');
  expect(collapsed.length).toBeGreaterThan(0);
  const narrowing = collapsed.find((r) => /--precord-w:/.test(r.body));
  expect(narrowing, 'a [data-collapsed="true"] rule that narrows the column').toBeTruthy();
  expect(narrowing.body).toMatch(/--precord-label:\s*0/);
});

test('the column animates its width, because giving back the space is the point', () => {
  const base = rulesMatching('.ui-precord').find((r) => r.selector === '.ui-precord' && r.media === null);
  expect(base.body).toMatch(/transition:\s*width/);
});

test('labels are hidden from eyes only, never from screen readers', () => {
  const label = rulesMatching('.ui-precord-label').find((r) => r.selector === '.ui-precord-label');
  expect(label.body).toMatch(/opacity:/);
  expect(label.body).not.toMatch(/display:\s*none/);
  expect(label.body).not.toMatch(/visibility:\s*hidden/);
});

test('reduced motion removes every transition in this column', () => {
  const reduced = rulesMatching('.ui-precord').filter((r) => r.media && /prefers-reduced-motion:\s*reduce/.test(r.media));
  expect(reduced.length).toBeGreaterThan(0);
  const body = reduced.map((r) => r.body).join('\n');
  expect(body).toMatch(/transition:\s*none/);
  // The width, the labels and the toggle's arrow all move; all must stop.
  const selectors = reduced.map((r) => r.selector).join(' ');
  for (const part of ['.ui-precord', '.ui-precord-label', '.ui-precord-toggle svg']) {
    expect(selectors, `${part} is covered by the reduced-motion rule`).toContain(part);
  }
});
