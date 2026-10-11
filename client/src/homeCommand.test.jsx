/**
 * Home as a command surface.
 *
 * SHELL_PLAN.md phase 2. This REPLACES `launcher.test.jsx`, which pinned the
 * five module tiles and their hover cards. Those tiles are gone at the
 * owner's choice, so tests for what a tile shows are tests for something
 * that does not render — they go with the component, which is the one case
 * AGENTS.md rule 2 allows.
 *
 * What is KEPT from that file is the thing worth keeping: no figure may be
 * claimed before it is known, and a waiting patient is the only red line on
 * the screen. Both are re-pinned below against the new shape.
 *
 * Rendered with react-dom/server, as the launcher tests were: the node test
 * environment has no DOM, and effects do not run during a static render —
 * which is exactly the "not known yet" state worth checking.
 */

import { test, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import HomeCommand from './HomeCommand.jsx';
import {
  greeting, headline, standing, PLACEHOLDER,
  matchScreens, shouldSearchPatients, MIN_PATIENT_QUERY, NO_MATCH,
} from './homeCommand.js';

const noop = () => {};
const render = (props = {}) => renderToStaticMarkup(
  <HomeCommand onOpen={noop} onOpenPatient={noop} websiteEnabled={false} summary={null} {...props} />,
);

// THE MOST IMPORTANT TEST IN THIS FILE, and it is inherited.
test('no figure is claimed before the dashboard has one', () => {
  // Kept verbatim in spirit from launcher.test.jsx. A zero it has not earned
  // is worse than silence: "No orders waiting" on a screen that has not asked
  // is a claim about the shop.
  const html = render({ summary: null });
  expect(html).not.toMatch(/No orders waiting/);
  expect(html).not.toMatch(/waiting for a pharmacist/);
  expect(html).not.toMatch(/\b0 open conversations\b/);

  // The greeting and the input are there regardless — they need no data.
  expect(html).toMatch(/Good (morning|afternoon|evening)\./);
  expect(html).toContain(PLACEHOLDER);
});

test('a waiting patient is the only urgent line, and only when real', () => {
  // design.md reserves red for a person waiting on a human. On this screen
  // that is literally the second line, and nothing else may take it.
  expect(headline({ handoffs: 0 })).toEqual({
    text: 'Nobody is waiting for a pharmacist.', tone: 'quiet',
  });
  expect(headline({ handoffs: 1 }).tone).toBe('alert');
  expect(headline({ handoffs: 1 }).text).toMatch(/One person/);
  expect(headline({ handoffs: 4 }).text).toMatch(/4 people/);

  // Not known yet is NOTHING, not "nobody".
  expect(headline(null)).toBe(null);
  expect(headline({})).toBe(null);
  expect(headline({ handoffs: null })).toBe(null);

  const html = render({ summary: { handoffs: 2, orders: 0, openConversations: 0 } });
  expect(html).toMatch(/2 people are waiting/);
  expect(html).toMatch(/ui-home-alert/);
});

test('removing the tiles did not remove the figures', () => {
  // The tiles carried a live line per module and a pharmacist read the shop
  // by them. Trading that for air would be a worse screen, not a calmer one.
  const lines = standing({ orders: 2, openConversations: 14, refillsDue: 3 });
  const joined = lines.join(' · ');
  expect(joined).toMatch(/2 orders to confirm/);
  expect(joined).toMatch(/3 refills due/);
  expect(joined).toMatch(/14 open conversations/);

  // The clinic line is NOT repeated here — it is the headline above, and
  // saying it twice would flatten the one thing with a cost back into a row
  // of equals, which is what the tiles did.
  expect(joined).not.toMatch(/waiting for a pharmacist/);

  expect(standing(null)).toEqual([]);
});

test('typing a screen name offers that screen', () => {
  // A prefix beats a substring: somebody typing two letters means the thing
  // that starts with them.
  const co = matchScreens('co');
  expect(co[0].label).toBe('Consultations');

  // The module name is searched too, so the word a pharmacist thinks in
  // finds the screen even when the label does not contain it.
  expect(matchScreens('clinic').map((s) => s.label)).toContain('Triage');

  // Gated items stay out until the server says they are on — offering a
  // screen that does not exist is a dead end.
  expect(matchScreens('website', { websiteEnabled: false })).toEqual([]);
  expect(matchScreens('website', { websiteEnabled: true }).length).toBeGreaterThan(0);

  // Nothing typed, nothing offered.
  expect(matchScreens('')).toEqual([]);
  expect(matchScreens(null)).toEqual([]);
});

test('one character does not ask the server for every patient in the pharmacy', () => {
  // A single letter matches almost everyone, which is a tenant-scoped query
  // that costs something and answers nothing.
  expect(MIN_PATIENT_QUERY).toBeGreaterThan(1);
  expect(shouldSearchPatients('n')).toBe(false);
  expect(shouldSearchPatients('ng')).toBe(true);
  expect(shouldSearchPatients('  n  ')).toBe(false);
  expect(shouldSearchPatients('')).toBe(false);
  expect(shouldSearchPatients(null)).toBe(false);
});

test('the greeting does not invent a name', () => {
  // The reference greets by first name because it has one. This app is handed
  // an email address, and `adetiloyejohn7@gmail.com` does not contain a first
  // name — it contains a guess. The pharmacy name is in the sidebar two
  // inches up, so repeating it here would be saying it twice.
  for (const h of [8, 13, 20]) {
    const text = greeting(new Date(2026, 9, 11, h, 0, 0));
    expect(text).toMatch(/^Good (morning|afternoon|evening)\.$/);
    expect(text).not.toMatch(/@|Dev Pharmacy|Adetiloye/);
  }
  expect(greeting(new Date(2026, 9, 11, 8))).toBe('Good morning.');
  expect(greeting(new Date(2026, 9, 11, 13))).toBe('Good afternoon.');
  expect(greeting(new Date(2026, 9, 11, 20))).toBe('Good evening.');
});

test('the input does not pretend to be an assistant', () => {
  // THE FAILURE THIS SCREEN IS MOST LIKELY TO CAUSE. A big box on a clinical
  // product invites a clinical question, and this one searches patients and
  // screens. The placeholder has to say so plainly, or a pharmacist types
  // "is amlodipine safe in pregnancy" and gets nothing — having been told,
  // by the shape of the thing, that it would answer.
  expect(PLACEHOLDER).toMatch(/search/i);
  expect(PLACEHOLDER).toMatch(/patient/i);
  expect(PLACEHOLDER).toMatch(/screen/i);
  for (const implies of [/^ask/i, /anything/i, /assistant/i, /^chat/i]) {
    expect(PLACEHOLDER, `the placeholder implies an assistant: ${implies}`).not.toMatch(implies);
  }

  // And the empty answer says nothing was matched, not that nothing exists.
  expect(NO_MATCH).toMatch(/matches/i);
});

test('Home has no microphone', () => {
  // The reference has one. A recording here needs a consultation to belong to
  // and a consent recorded against it (0071), neither of which exists until a
  // patient is chosen — so a mic on Home could only ask for a patient first,
  // which is what the input already does. It would be a second route to the
  // same place dressed as a shortcut.
  const html = render({ summary: { handoffs: 0, orders: 0, openConversations: 0 } });
  expect(html).not.toMatch(/Transcribe|Record|microphone/i);
});
