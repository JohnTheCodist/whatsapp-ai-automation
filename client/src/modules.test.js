/**
 * The module map — the single place that decides which screen lives where.
 *
 * What can silently go wrong here is not a crash. It is a tab that belongs to
 * two modules (so the breadcrumb lies), a sidebar item for a screen App.jsx
 * does not render (so a click opens a blank canvas), or an old tab id that no
 * longer resolves (so every bookmark and every onNavigate(...) in the app
 * quietly lands somewhere else). Each of those is pinned below.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODULES, MODULE_TABS, CLINIC_SERVICES, moduleOfTab, itemOfTab, sidebarFor, moduleHome, tileStatus,
} from './modules.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');

test('home has exactly five modules, in the order the owner named them', () => {
  expect(MODULES.map((m) => m.label)).toEqual(['Stock', 'Clinics', 'Patients', 'Marketing', 'Branding']);
});

test('AI is not a module — it is a screen inside Marketing', () => {
  expect(MODULES.map((m) => m.id)).not.toContain('ai');
  expect(moduleOfTab('ai').id).toBe('marketing');
});

test('every tab belongs to exactly one module', () => {
  // One owner per tab is what lets the breadcrumb say where you are. A tab in
  // two sidebars would light up in both and belong to neither.
  expect(new Set(MODULE_TABS).size).toBe(MODULE_TABS.length);
});

test('every sidebar item opens a screen App.jsx actually renders', () => {
  for (const tab of MODULE_TABS) {
    expect(APP, `App.jsx renders tab "${tab}"`).toMatch(new RegExp(`tab === '${tab}'`));
  }
});

test('every tab that existed before the reorganisation still resolves to a module', () => {
  // Bookmarks, ?tab= URLs and every onNavigate(...) in the app use these.
  const legacy = [
    'overview', 'ai', 'consultations', 'inbox', 'orders', 'requests',
    'customers', 'website', 'inventory', 'inventory-upload',
  ];
  for (const tab of legacy) expect(moduleOfTab(tab), tab).not.toBeNull();
});

test('each existing screen sits in the module the plan assigns it', () => {
  const where = (tab) => moduleOfTab(tab).id;
  expect(['overview', 'inventory', 'inventory-upload', 'stock-sync', 'orders', 'requests', 'wholesale'].map(where))
    .toEqual(Array(7).fill('stock'));
  expect(where('consultations')).toBe('clinics');
  expect(['customers', 'refills', 'conditions'].map(where)).toEqual(Array(3).fill('patients'));
  expect(['inbox', 'templates', 'ai'].map(where)).toEqual(Array(3).fill('marketing'));
  expect(where('website')).toBe('branding');
});

test('Setup, Billing and Home belong to no module', () => {
  for (const tab of ['setup', 'billing', 'home']) expect(moduleOfTab(tab)).toBeNull();
});

test('each module opens on its first screen', () => {
  expect(moduleHome('stock')).toBe('overview');
  expect(moduleHome('clinics')).toBe('consultations');
  expect(moduleHome('patients')).toBe('customers');
  expect(moduleHome('marketing')).toBe('inbox');
});

test('Branding opens the website only once the server says it is switched on', () => {
  // null is "not asked yet" and must behave like false: a card must never
  // open a screen the sidebar is still hiding.
  expect(moduleHome('branding', { websiteEnabled: true })).toBe('website');
  expect(moduleHome('branding', { websiteEnabled: false })).toBe('setup');
  expect(moduleHome('branding', { websiteEnabled: null })).toBe('setup');

  const branding = MODULES.find((m) => m.id === 'branding');
  expect(sidebarFor(branding, { websiteEnabled: true }).map((i) => i.tab)).toEqual(['website']);
  expect(sidebarFor(branding, { websiteEnabled: null })).toEqual([]);
});

test('an unknown module is an error, never a silent fall back to some screen', () => {
  expect(() => moduleHome('reports')).toThrow(/Unknown module/);
  expect(() => tileStatus('reports', {})).toThrow(/Unknown module/);
});

test('itemOfTab gives the sidebar label used as the page title', () => {
  expect(itemOfTab('inventory').label).toBe('Catalogue');
  expect(itemOfTab('customers').label).toBe('All patients');
  expect(itemOfTab('setup')).toBeNull();
});

// ---------------------------------------------------------------- clinics ---

test('the clinical service registry lists only what exists, and nothing unbuilt', () => {
  expect(CLINIC_SERVICES.map((s) => s.id)).toEqual(['fever', 'malaria', 'cough', 'sore-throat']);
  expect(CLINIC_SERVICES.every((s) => s.status === 'active')).toBe(true);
  // The brief's future services must not appear until they are built.
  for (const unbuilt of ['blood-pressure', 'glucose', 'malaria-rdt', 'weight', 'family-planning',
    'cholesterol', 'vaccination', 'medication-review', 'online-consultation']) {
    expect(CLINIC_SERVICES.map((s) => s.id)).not.toContain(unbuilt);
  }
});

test('a clinical service with no screen adds no sidebar item', () => {
  // They run inside the assistant today. A sidebar item for one would open a
  // page with nothing on it.
  const clinics = MODULES.find((m) => m.id === 'clinics');
  expect(clinics.sidebar.map((i) => i.tab)).toEqual(['consultations']);
});

// ------------------------------------------------------------ tile status ---

test('a tile says nothing until its figure is known — never an unearned zero', () => {
  for (const id of ['stock', 'clinics', 'patients', 'marketing', 'branding']) {
    expect(tileStatus(id, {}), id).toBeNull();
  }
});

test('tile lines count properly, singular and plural', () => {
  expect(tileStatus('stock', { orders: 1 }).text).toBe('1 order to confirm');
  expect(tileStatus('stock', { orders: 3 }).text).toBe('3 orders to confirm');
  expect(tileStatus('stock', { orders: 0 }).text).toBe('No orders waiting');
  expect(tileStatus('clinics', { handoffs: 1 }).text).toBe('1 person waiting');
  expect(tileStatus('clinics', { handoffs: 2 }).text).toBe('2 people waiting');
  expect(tileStatus('patients', { refillsDue: 0 }).text).toBe('No refills due');
  expect(tileStatus('patients', { refillsDue: 4 }).text).toBe('4 refills due');
  expect(tileStatus('marketing', { openConversations: 1 }).text).toBe('1 open conversation');
});

test('red is reserved for somebody waiting on a pharmacist', () => {
  expect(tileStatus('clinics', { handoffs: 1 }).tone).toBe('alert');
  expect(tileStatus('stock', { orders: 9 }).tone).not.toBe('alert');
  expect(tileStatus('patients', { refillsDue: 9 }).tone).not.toBe('alert');
});

test('the Branding line reports the website\'s real state, and nothing while the builder is off', () => {
  expect(tileStatus('branding', { websiteEnabled: true, websiteStatus: 'published' }).text).toBe('Website live');
  expect(tileStatus('branding', { websiteEnabled: true, websiteStatus: 'none' }).text).toBe('No website yet');
  expect(tileStatus('branding', { websiteEnabled: false, websiteStatus: 'published' })).toBeNull();
});
