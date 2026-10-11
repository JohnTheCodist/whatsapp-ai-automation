/**
 * The Catalogue's four states, and the two that must never be confused.
 *
 * SHELL_PLAN.md phase 5. The defect: the product list rendered behind
 * `products?.products?.length > 0` with NO `else`, so a pharmacy with an empty
 * catalogue — which is every pharmacy on its first day — opened the screen and
 * saw a price switch in an empty box. No sentence, no next step, on the one
 * screen this product cannot work without.
 *
 * The failure each test defends against is a specific wrong sentence on a real
 * screen, not a shape.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogueState, catalogueEmptyText } from './catalogueState.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = fs.readFileSync(path.join(SRC, 'UploadCatalogue.jsx'), 'utf8');

test('a catalogue with products in it shows the list and says nothing', () => {
  const s = catalogueState({ products: { products: [{ id: 1 }] } });
  expect(s).toBe('list');
  // The list is the product list's own job. A heading above it announcing
  // that there are products would be the page talking about itself.
  expect(catalogueEmptyText(s)).toBe(null);
});

test('a catalogue nobody has filled says so, and says what to do about it', () => {
  const s = catalogueState({ products: { products: [], counts: { total: 0 } } });
  expect(s).toBe('empty');

  const text = catalogueEmptyText(s);
  expect(text.title).toBe('No products yet');
  // An empty state that only states the emptiness leaves the reader where
  // they already were. The next step is a screen in this app, so it is a
  // button rather than a sentence about the sidebar.
  expect(text.action.label).toBe('Upload a catalogue');
  expect(text.action.tab).toBe('inventory-upload');
});

test('a read that FAILED never claims the catalogue is empty', () => {
  // THE ONE THAT MATTERS. Both blank screens looked identical before this
  // module existed. A pharmacy owner told "no products" when the request
  // actually failed goes and re-uploads a catalogue that is already there.
  const s = catalogueState({ products: null, listStale: true });
  expect(s).toBe('failed');

  const text = catalogueEmptyText(s);
  expect(text.title).toMatch(/could not be loaded/i);
  expect(text.title + text.body, 'a failed read is being described as empty')
    .not.toMatch(/\bno products\b|\bempty catalogue\b|\bnothing\b/i);
  // It offers the thing that might actually work, not a navigation away.
  expect(text.action.retry).toBe(true);
  expect(text.action.tab).toBe(undefined);
});

test('a failure that left an older read behind still refuses to say "empty"', () => {
  // `listStale` is checked BEFORE emptiness on purpose. A failure can leave
  // `products` holding a previous read whose list is empty, and answering
  // "empty" there is a confident claim about a catalogue we could not see —
  // GOLDEN-002c's rule, that "we could not tell" is never "there is nothing
  // there", in the place it applies to stock.
  expect(catalogueState({ products: { products: [] }, listStale: true })).toBe('failed');
});

test('nothing is claimed before the first read lands', () => {
  // A screen that flashes "No products yet" on its way to showing four
  // hundred of them has told the reader something false. Briefly is still
  // false, and it is the moment somebody reaches for the Upload button.
  const s = catalogueState({});
  expect(s).toBe('loading');
  expect(catalogueEmptyText(s)).toBe(null);
});

test('a stale read with products still shows them rather than an error', () => {
  // Staleness is not emptiness either. The list is kept rather than blanked —
  // UploadCatalogue's own comment argues for that — so a failed refresh must
  // not replace four hundred products with an error panel.
  expect(catalogueState({ products: { products: [{ id: 1 }] }, listStale: true })).toBe('list');
});

test('the screen renders the blank states, and only where the list lives', () => {
  // The same component renders the Upload tab (view="upload"), where
  // `showProducts` is false. An empty-catalogue panel there would sit under
  // a file picker and tell somebody mid-upload that they have no products.
  expect(SCREEN).toMatch(/\{showProducts && !analysis && \(\(\) => \{/);
  expect(SCREEN).toMatch(/catalogueState\(\{ products, listStale \}\)/);

  // The decision is NOT re-derived in the screen. A second opinion about
  // which blank state this is would drift from the one that is tested.
  expect(SCREEN, 'the screen decides emptiness for itself')
    .not.toMatch(/products\?\.products\?\.length === 0/);
});
