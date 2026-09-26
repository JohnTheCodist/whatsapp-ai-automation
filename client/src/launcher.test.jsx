/**
 * The home launcher's cards.
 *
 * Which module opens where is pinned in modules.test.js. This file pins what
 * a tile shows: at rest, its icon and its name only. Its one-line
 * description and live figure live in the card that opens on hover or
 * keyboard focus — and there is no figure at all until it is known.
 *
 * Changed 2026-09-19 at the owner's request: the description used to sit on
 * the card itself. The rule that it is present for every module is kept
 * (first test); what changed is where it lives, pinned by the tests at the
 * end of this file.
 *
 * Rendered with react-dom/server: the node test environment has no DOM, and
 * effects (the refill and website fetches) do not run during a static render,
 * which is exactly the "not known yet" state worth checking.
 */

import { test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Launcher, { ModuleCard } from './Launcher.jsx';
import { MODULES } from './modules.js';

const noop = () => {};

test('home shows five cards, in order, each with its name and description', () => {
  const html = renderToStaticMarkup(<Launcher onOpen={noop} websiteEnabled summary={null} />);
  let last = -1;
  for (const m of MODULES) {
    const at = html.indexOf(`>${m.label}<`);
    expect(at, m.label).toBeGreaterThan(last);
    last = at;
    expect(html).toContain(m.hint);
  }
  expect(html.match(/<button/g)).toHaveLength(5);
});

test('no card claims a figure before the dashboard has one', () => {
  const html = renderToStaticMarkup(<Launcher onOpen={noop} websiteEnabled summary={null} />);
  expect(html).not.toMatch(/waiting|to confirm|refills due|open conversation|Website live/i);
});

test('the polled figures appear on their cards once known', () => {
  const html = renderToStaticMarkup(
    <Launcher onOpen={noop} websiteEnabled={false} summary={{ orders: 2, handoffs: 1, openConversations: 14 }} />,
  );
  expect(html).toContain('2 orders to confirm');
  expect(html).toContain('1 person waiting');
  expect(html).toContain('14 open conversations');
});

test('a waiting patient is the only red line on the launcher', () => {
  const clinics = MODULES.find((m) => m.id === 'clinics');
  const html = renderToStaticMarkup(
    <ModuleCard module={clinics} status={{ text: '1 person waiting', tone: 'alert' }} onOpen={noop} />,
  );
  expect(html).toContain('bg-red-500');
  expect(html).toContain('text-red-700');

  const stock = MODULES.find((m) => m.id === 'stock');
  const quiet = renderToStaticMarkup(
    <ModuleCard module={stock} status={{ text: '3 orders to confirm', tone: 'work' }} onOpen={noop} />,
  );
  expect(quiet).not.toContain('red-');
});

test('Marketing is a real module now — no "Soon" badge anywhere', () => {
  const html = renderToStaticMarkup(<Launcher onOpen={noop} websiteEnabled summary={null} />);
  expect(html).not.toMatch(/>Soon</);
});

// ---- at rest: icon and name only; the rest in the hover card ------------

/** Each tile's <button> markup, and everything outside the buttons. */
function split(html) {
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) || [];
  return { buttons, outside: buttons.reduce((rest, b) => rest.replace(b, ''), html) };
}

test('at rest a tile is its icon and name — the description is not inside the button', () => {
  // Inside the button it would be on the page, and part of the button's
  // accessible name ("Stock Catalogue, orders and stock sync").
  const html = renderToStaticMarkup(<Launcher onOpen={noop} websiteEnabled summary={null} />);
  const { buttons, outside } = split(html);
  MODULES.forEach((m, i) => {
    expect(buttons[i]).toContain(`>${m.label}<`);
    expect(buttons[i]).not.toContain(m.hint);
    expect(outside).toContain(m.hint);
  });
});

test('each tile is described by its own card, which is a tooltip', () => {
  const html = renderToStaticMarkup(<Launcher onOpen={noop} websiteEnabled summary={null} />);
  for (const m of MODULES) {
    expect(html).toContain(`aria-describedby="module-card-${m.id}"`);
    expect(html).toContain(`id="module-card-${m.id}" role="tooltip"`);
  }
});

test('the live figure is in the card, not on the tile', () => {
  const html = renderToStaticMarkup(
    <Launcher onOpen={noop} websiteEnabled={false} summary={{ orders: 2, handoffs: 1, openConversations: 14 }} />,
  );
  for (const b of split(html).buttons) expect(b).not.toMatch(/to confirm|waiting|open conversations/);
});

test('an icon carries a dot only when something needs a person', () => {
  const stock = MODULES.find((m) => m.id === 'stock');
  const tile = (status) => split(renderToStaticMarkup(<ModuleCard module={stock} status={status} onOpen={noop} />)).buttons[0];
  expect(tile({ text: '3 orders to confirm', tone: 'work' })).toContain('ui-app-icon-dot');
  expect(tile({ text: 'No orders waiting', tone: 'quiet' })).not.toContain('ui-app-icon-dot');
  expect(tile(null)).not.toContain('ui-app-icon-dot');
});

test('the ends of the row open their cards inward, so they stay on screen', () => {
  const html = renderToStaticMarkup(<Launcher onOpen={noop} websiteEnabled summary={null} />);
  const aligns = [...html.matchAll(/data-align="(\w+)"/g)].map((m) => m[1]);
  expect(aligns).toEqual(['start', 'center', 'center', 'center', 'end']);
});
