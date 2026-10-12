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
  //
  // AMENDED 2026-09-27 with the product: the consultation note joined the
  // Clinical module (0067, CONSULTATION_PLAN.md phase 1) — the pharmacist
  // note, beside the triage desk rather than instead of it. It HAS a screen,
  // so the rule this pins is unchanged.
  //
  // AMENDED AGAIN 2026-10-12, same way and for the same reason:
  // Workflows joined Clinics (AGENTIC_PLAN.md phase 1), showing which
  // clinical protocols the assistant runs, their versions, and whether each
  // is switched on here. It HAS a screen — Workflows.jsx — so the rule this
  // test pins is again unchanged.
  //
  // Worth recording: this screen exists BECAUSE the rule below was being
  // broken somewhere this test could not see. CLINIC_SERVICES listed
  // "Malaria assessment" as active while its protocol says "DRAFT. NOT
  // ACTIVE. NOT PATIENT-FACING." This test guards the SIDEBAR against a
  // service with no screen; nothing guarded the service list against a
  // protocol that never runs. server/tests/protocols.test.js now does.
  const clinics = MODULES.find((m) => m.id === 'clinics');
  expect(clinics.sidebar.map((i) => i.tab)).toEqual(['consultations', 'consultation-notes', 'workflows']);

  // STRENGTHENED at the same time: the list above is a literal, so it would
  // have to be edited for a service to sneak in — but it would then be
  // edited by whoever added it. This states the rule itself, so a clinical
  // service reaching the sidebar fails even if somebody updates the list.
  const serviceIds = new Set(CLINIC_SERVICES.filter((x) => !x.tab).map((x) => x.id));
  for (const item of clinics.sidebar) {
    expect(serviceIds.has(item.tab), `${item.tab} is a clinical service with no screen`).toBe(false);
  }
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

/* ==========================================================================
 * Two screens, two names (2026-10-10)
 *
 * The owner: "there two tabs consultation and consultation notes, it does not
 * make sense". Both said "consultation" AND both drew the same icon, so in
 * the collapsed strip they were indistinguishable.
 *
 * They are NOT merged, because they do different jobs and the boundary is the
 * product:
 *
 *   Triage         who is waiting, what the engine found, is this safe and
 *                  appropriate for a pharmacy consultation
 *   Consultations  what the pharmacist assessed and did about it
 * ======================================================================== */

test('no two screens in a module share a name', () => {
  // The rule the rename restores, checked across every module rather than
  // only the two that collided — a third "Consultations" is the same bug.
  for (const m of MODULES) {
    const labels = m.sidebar.map((i) => i.label.toLowerCase());
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(dupes, `${m.label} has two screens called ${dupes[0]}`).toEqual([]);
  }
});

test('no two screens in a module share an icon', () => {
  // Half the confusion was visual: both Clinics screens drew
  // IconConsultations, so the 56px strip showed the same mark twice. A name
  // nobody can read at a glance is no use if the glyph is a duplicate.
  for (const m of MODULES) {
    const icons = m.sidebar.map((i) => i.Icon);
    const seen = new Set();
    for (const Icon of icons) {
      expect(seen.has(Icon), `${m.label} draws one icon for two screens`).toBe(false);
      seen.add(Icon);
    }
  }
});

test('the triage desk and the consultation note are named for what they do', () => {
  const clinics = MODULES.find((m) => m.id === 'clinics');
  const byTab = Object.fromEntries(clinics.sidebar.map((i) => [i.tab, i]));

  // Triage is the queue: it is the one that carries a badge and the one
  // allowed to go red, because red means a person is waiting on a human.
  expect(byTab.consultations.label).toBe('Triage');
  expect(byTab.consultations.badge).toBe('consultations');
  expect(byTab.consultations.tone).toBe('red');

  // The note is where a consultation is written up. No badge: nobody is
  // waiting on a note.
  expect(byTab['consultation-notes'].label).toBe('Consultations');
  expect(byTab['consultation-notes'].badge).toBeUndefined();

  // THE TAB IDS ARE UNCHANGED, which is the whole reason this was a rename
  // and not a restructure: every onNavigate('consultations') deep link and
  // the patient summary's card keep working. design.md records the same rule
  // for inbox / orders / requests.
  expect(byTab.consultations.tab).toBe('consultations');
  expect(byTab['consultation-notes'].tab).toBe('consultation-notes');
});
