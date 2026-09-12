/**
 * Recording mode hides the Baileys pairing panel and nothing else of
 * consequence — see reviewMode.js.
 */

import { test, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleGroups } from './reviewMode.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const GROUPS = [
  {
    label: 'Your pharmacy',
    items: [
      { id: 'general', label: 'General', tabs: [{ id: 'assistant', label: 'Assistant' }] },
    ],
  },
  {
    label: 'Connection',
    items: [
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        tabs: [
          { id: 'pairing', label: 'Pairing', reviewHide: true },
          { id: 'api', label: 'API status', reviewHide: true },
          { id: 'meta-review', label: 'Meta App Review Test' },
        ],
      },
      { id: 'stock-sync', label: 'Stock sync', tabs: [{ id: 'devices', label: 'Connected computers' }] },
    ],
  },
];

const tabIds = (groups) => groups.flatMap((g) => g.items).flatMap((i) => i.tabs).map((t) => t.id);

test('off, which is every normal deploy, the screen is untouched', () => {
  // Identity, not a copy: nothing is rebuilt when the flag is off.
  expect(visibleGroups(GROUPS, false)).toBe(GROUPS);
});

test('on, the pairing panel and the raw API status are gone', () => {
  const ids = tabIds(visibleGroups(GROUPS, true));
  expect(ids).not.toContain('pairing');
  expect(ids).not.toContain('api');
});

test('on, the Meta App Review Test panel and the rest of the product remain', () => {
  const visible = visibleGroups(GROUPS, true);
  const ids = tabIds(visible);
  expect(ids).toContain('meta-review');
  expect(ids).toContain('assistant');
  expect(ids).toContain('devices');
  // The product still looks like a product: both groups survive.
  expect(visible.map((g) => g.label)).toEqual(['Your pharmacy', 'Connection']);
});

test('an area whose every panel is hidden disappears rather than opening nothing', () => {
  const groups = [{
    label: 'Connection',
    items: [
      { id: 'whatsapp', label: 'WhatsApp', tabs: [{ id: 'pairing', label: 'Pairing', reviewHide: true }] },
      { id: 'stock-sync', label: 'Stock sync', tabs: [{ id: 'devices', label: 'Connected computers' }] },
    ],
  }];
  const visible = visibleGroups(groups, true);
  expect(visible[0].items.map((i) => i.id)).toEqual(['stock-sync']);
});

test('a group left with no areas disappears too', () => {
  const groups = [{
    label: 'Connection',
    items: [{ id: 'whatsapp', label: 'WhatsApp', tabs: [{ id: 'pairing', label: 'Pairing', reviewHide: true }] }],
  }];
  expect(visibleGroups(groups, true)).toEqual([]);
});

// The wiring, not the rule. Everything above would pass even if REVIEW_MODE
// never read the environment at all, and the flag would then do nothing on
// the one build it exists for — silently, which is the worst shape for this
// to fail in.

test('REVIEW_MODE is on only when the build variable is exactly "true"', async () => {
  for (const [value, expected] of [['true', true], ['false', false], ['TRUE', false], ['1', false]]) {
    vi.resetModules();
    vi.stubEnv('VITE_META_REVIEW_MODE', value);
    const mod = await import('./reviewMode.js');
    expect(mod.REVIEW_MODE, `VITE_META_REVIEW_MODE=${value}`).toBe(expected);
  }
});

test('REVIEW_MODE is off when the variable is unset — the normal deploy', async () => {
  vi.resetModules();
  vi.stubEnv('VITE_META_REVIEW_MODE', undefined);
  const mod = await import('./reviewMode.js');
  expect(mod.REVIEW_MODE).toBe(false);
});

test('Settings actually renders the filtered groups, not the raw list', () => {
  // A source check, in the style of architecture.test.js: if Settings stopped
  // passing ALL_GROUPS through visibleGroups, every test above would still
  // pass and the pairing panel would still be on camera.
  const src = fs.readFileSync(path.join(SRC, 'Settings.jsx'), 'utf8');
  expect(src).toMatch(/const GROUPS = visibleGroups\(ALL_GROUPS\)/);
  expect(src).toMatch(/const ALL_ITEMS = GROUPS\.flatMap/);
  // And the panel it exists to hide is still marked.
  expect(src).toMatch(/id: 'pairing'[\s\S]{0,80}reviewHide: true/);
});

test('the original structure is never mutated', () => {
  const before = JSON.stringify(GROUPS);
  visibleGroups(GROUPS, true);
  expect(JSON.stringify(GROUPS)).toBe(before);
});
