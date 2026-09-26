/**
 * The words a pharmacist reads about a refill. One formatter serves both the
 * profile and the call list; if these drift, one screen says "due" about a
 * patient the other calls "lapsed".
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtDay, supplyLabel, messagingBlock, REFILL_STATUS_TONE } from './refillFormat.js';

test('a calendar day is shown as exactly the day the server sent, never the day before', () => {
  // new Date('2026-10-01') is UTC midnight; formatted in a browser west of
  // Greenwich that would read 30 Sep. The formatter must not do that.
  expect(fmtDay('2026-10-01')).toBe('01 Oct 2026');
  expect(fmtDay('2026-01-01')).toBe('01 Jan 2026');
});

test('a missing or broken day is a dash, not "Invalid Date"', () => {
  expect(fmtDay(null)).toBe('—');
  expect(fmtDay('not-a-day')).toBe('—');
});

test('supply wording follows the server status and counts days correctly', () => {
  expect(supplyLabel({ status: 'upcoming', daysLeft: 12 })).toBe('Runs out in 12 days');
  expect(supplyLabel({ status: 'due', daysLeft: 5 })).toBe('Runs out in 5 days');
  expect(supplyLabel({ status: 'due', daysLeft: 1 })).toBe('Runs out tomorrow');
  expect(supplyLabel({ status: 'overdue', daysLeft: 0 })).toBe('Ran out today');
  expect(supplyLabel({ status: 'overdue', daysLeft: -1 })).toBe('Ran out yesterday');
  expect(supplyLabel({ status: 'overdue', daysLeft: -4 })).toBe('Out for 4 days');
  expect(supplyLabel({ status: 'lapsed', daysLeft: -19 })).toBe('Lapsed: out for 19 days');
});

test('refill urgency is a named tone, not a colour written into a component', () => {
  // Lifted out of Tailwind's amber utilities 2026-09-21: a component names
  // the STEP of urgency and a token carries the colour, so changing the
  // app's amber is one edit and every chip on every screen follows.
  expect(Object.values(REFILL_STATUS_TONE)).toEqual([
    'ui-tone-quiet', 'ui-tone-1', 'ui-tone-2', 'ui-tone-3',
  ]);
});

test('refill urgency is never shown in red, which belongs to Consultations', () => {
  // design.md: red means a person is waiting on a human. A lapsed refill is
  // queued work — amber — however long it has been.
  //
  // THE RULE FOLLOWS THE COLOUR. This used to read the Tailwind class names
  // on REFILL_STATUS_TONE; those are now token names that carry no colour at
  // all, so a test left here would have passed for ever on strings it was no
  // longer checking. It reads the token VALUES where they are now defined.
  const css = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.css'),
    'utf8',
  );
  const lines = css.split(/\r?\n/);
  for (const tone of Object.values(REFILL_STATUS_TONE)) {
    const step = tone.replace('ui-tone-', '');
    for (const part of [`--ui-tone-${step}-bg`, `--ui-tone-${step}-fg`]) {
      const line = lines.find((l) => l.trim().startsWith(`${part}:`));
      expect(line, `${part} is defined in index.css`).toBeTruthy();
      const match = line.match(/oklch\(\s*[\d.]+%\s+([\d.]+)\s+([\d.]+)/);
      expect(match, `${part} is an oklch value`).toBeTruthy();
      const [, chroma, hue] = match.map(Number);
      // Achromatic is fine — that is the quiet step. Anything with colour in
      // it must sit in the amber band (40–110°), never the 20–40° of a red.
      if (chroma > 0.02) {
        expect(Number(hue), `${part} is amber, not red`).toBeGreaterThanOrEqual(40);
        expect(Number(hue), `${part} is amber, not red`).toBeLessThanOrEqual(110);
      }
    }
  }
});

test('a patient who cannot be messaged says why, before anyone tries', () => {
  expect(messagingBlock({ optedOut: true, medicationMessages: true })).toBe('Opted out of messages');
  expect(messagingBlock({ optedOut: false, medicationMessages: false })).toBe('Medication messages off');
  expect(messagingBlock({ optedOut: false, medicationMessages: true })).toBe(null);
});
