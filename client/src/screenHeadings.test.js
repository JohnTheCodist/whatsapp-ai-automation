/**
 * A screen does not say its own name twice — and the one screen that must.
 *
 * SHELL_PLAN.md phase 5. Measured on the running app: Orders rendered the
 * page title "Orders" and then, about sixty pixels below it, a card header
 * reading "Orders". The Inbox did the same. The repeated word said nothing
 * and pushed the first real thing on the screen further down.
 *
 * This is not a new opinion. App.jsx already excludes the consultation screen
 * from the shell chrome on exactly this argument — a fixed title above forced
 * the screen "to re-state where you were underneath it, which is how one page
 * ended up with five stacked place markers".
 *
 * THE LAST TEST IS THE IMPORTANT ONE. Stock sync has the same repeated
 * heading and must KEEP it, because the component renders under two different
 * page titles. Without that test the obvious next commit is "finish the job",
 * which fixes one screen and orphans a panel in Settings.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const ORDERS = read('Orders.jsx');
const INBOX = read('Inbox.jsx');
const SYNC = read('CatalogueSync.jsx');
const APP = read('App.jsx');
const SETTINGS = read('Settings.jsx');

test('Orders does not repeat the page title inside the page', () => {
  expect(ORDERS, 'the duplicate "Orders" heading is back')
    .not.toMatch(/<h2[^>]*>Orders<\/h2>/);

  // The band itself stays. What sits in it is live — how many orders are
  // waiting on somebody's decision — and that is not a title.
  expect(ORDERS).toMatch(/awaiting your decision/);
  // With the label gone the status would drift left under `justify-between`,
  // away from the corner every other screen puts it in.
  expect(ORDERS).toMatch(/<header className="[^"]*justify-end[^"]*"/);
});

test('the Inbox does not repeat the page title inside the page', () => {
  expect(INBOX, 'the duplicate "Inbox" heading is back')
    .not.toMatch(/<h2[^>]*>Inbox<\/h2>/);
  // BOTH branches, asserted separately. Written first as a single
  // `/waiting for a person|Nothing needs a person/`, which a mutation then
  // walked straight through: deleting the quiet wording left the busy
  // wording matching, and the test stayed green while the header lost the
  // half that is true almost all of the time.
  expect(INBOX, 'the busy state lost its wording').toMatch(/waiting for a person/);
  expect(INBOX, 'the quiet state lost its wording').toMatch(/Nothing needs a person/);
  expect(INBOX).toMatch(/<header className="[^"]*justify-end[^"]*"/);
});

test('both screens are rendered in exactly one place, which is what makes that safe', () => {
  // THE GUARD. Dropping a component's own heading is only correct while the
  // page above it always says the same word. The moment Orders is rendered
  // inside Overview, or the Inbox inside a dashboard, the heading is the only
  // thing naming the panel and removing it was wrong.
  for (const name of ['Orders', 'Inbox']) {
    const importers = [APP, SETTINGS]
      .filter((src) => new RegExp(`import ${name} from './${name}\\.jsx'`).test(src));
    expect(importers.length, `${name} is imported somewhere new — re-check its heading`).toBe(1);
    expect(APP).toMatch(new RegExp(`import ${name} from './${name}\\.jsx'`));
  }
});

test('Stock sync KEEPS its heading, because it renders under two different titles', () => {
  // CatalogueSync.jsx is imported by App.jsx (the Stock sync tab, where the
  // page title is "Stock sync" and the heading does repeat it) AND by
  // Settings.jsx, where the page is titled something else entirely and this
  // heading is the only thing naming the panel.
  //
  // So the repetition is real on one screen and the heading is load-bearing
  // on the other. It stays, and this test exists so that "finish the job" is
  // a decision somebody makes on purpose rather than by pattern-matching.
  expect(SYNC).toMatch(/Stock sync/);
  expect(APP).toMatch(/import CatalogueSync from '\.\/CatalogueSync\.jsx'/);
  expect(SETTINGS, 'Settings no longer renders the sync panel — the heading rule may have changed')
    .toMatch(/import CatalogueSync from '\.\/CatalogueSync\.jsx'/);
});
