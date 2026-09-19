/**
 * The home launcher: which modules it shows, and where each one goes.
 *
 * The mapping is the thing that can silently go wrong — a tile that opens
 * the wrong screen still looks fine — so it is pinned here, including the
 * two cases that are not one-to-one: Branding depends on whether the
 * website builder is switched on, and Marketing is not built yet.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES, moduleTarget } from './Launcher.jsx';

const SRC = path.dirname(fileURLToPath(import.meta.url));

test('home shows exactly the five modules, in the order the owner named them', () => {
  expect(MODULES.map((m) => m.label)).toEqual(['Stock', 'Clinics', 'Patients', 'Marketing', 'Branding']);
});

test('each built module opens the screen that does that job today', () => {
  expect(moduleTarget('stock')).toBe('inventory');
  expect(moduleTarget('clinics')).toBe('consultations');
  expect(moduleTarget('patients')).toBe('customers');
});

test('Branding opens the website builder only once the server says it is switched on', () => {
  // null is "not asked yet": a tile must not open a section the rail is
  // still hiding, so it goes to Setup until the answer is a definite yes.
  expect(moduleTarget('branding', { websiteEnabled: true })).toBe('website');
  expect(moduleTarget('branding', { websiteEnabled: false })).toBe('setup');
  expect(moduleTarget('branding', { websiteEnabled: null })).toBe('setup');
});

test('Marketing is the only unbuilt module, and says so on its tile', () => {
  expect(MODULES.filter((m) => m.soon).map((m) => m.id)).toEqual(['marketing']);
  expect(moduleTarget('marketing')).toBe('marketing');
});

test('every tile opens a tab App.jsx actually knows', () => {
  // Read as text rather than imported: App.jsx starts polling on render,
  // and this only needs to know the ids it declares.
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  for (const { id } of MODULES) {
    for (const websiteEnabled of [true, false]) {
      const target = moduleTarget(id, { websiteEnabled });
      expect(app, `App.jsx declares tab "${target}"`).toMatch(new RegExp(`id: '${target}'`));
    }
  }
});

test('an unknown module is an error, never a silent fall back to some screen', () => {
  expect(() => moduleTarget('reports')).toThrow(/Unknown module/);
});
