/**
 * How the Workflows screen words the state of a clinical protocol.
 *
 * The failure each test defends against is a specific wrong sentence in
 * front of a pharmacist about software running in their name.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATES, stateOf, stateText, stateTone, summaryLine, stepsOf, matchProtocols,
} from './workflowFormat.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = fs.readFileSync(path.join(SRC, 'Workflows.jsx'), 'utf8');

test('a protocol switched on for this pharmacy is the only one called Running', () => {
  expect(stateOf({ wiredUp: true, live: true, liveKnown: true })).toBe('running');
  expect(stateText('running')).toMatch(/asking your patients/i);
});

test('wired up but not switched on is NOT described as disabled', () => {
  // Nobody disabled it. It ships ready and this pharmacy has no active row,
  // which is a different fact from a decision somebody took.
  const s = stateOf({ wiredUp: true, live: false, liveKnown: true });
  expect(s).toBe('available');
  expect(stateText(s)).toMatch(/not switched on/i);
  expect(stateText(s), 'it is being reported as a decision nobody made')
    .not.toMatch(/disabled|turned off|blocked/i);
});

test('a draft protocol says plainly that no patient can reach it', () => {
  // THE ONE THE SIDEBAR GOT WRONG. modules.js advertised "Malaria
  // assessment" as active while the protocol says DRAFT, NOT ACTIVE, NOT
  // PATIENT-FACING. The screen has to be unambiguous where the nav was not.
  const s = stateOf({ wiredUp: false, live: false, liveKnown: true });
  expect(s).toBe('draft');
  expect(stateText(s)).toMatch(/never runs/i);
  expect(stateText(s)).toMatch(/no patient message reaches it/i);
});

test('a configuration that could not be read is never reported as switched off', () => {
  // `isProtocolLive` fails CLOSED — "an unreadable configuration is not
  // permission to start a clinical workflow" — which is right for routing
  // and wrong for a screen. Telling a pharmacy a protocol is off when nobody
  // could tell is the WhatsApp chip's bug in the other direction.
  const s = stateOf({ wiredUp: true, live: false, liveKnown: false });
  expect(s).toBe('unknown');
  expect(stateText(s)).toMatch(/could not be read/i);
  expect(stateText(s), 'an unread configuration is being called off')
    .not.toMatch(/\bnot switched on\b|\bnever runs\b/i);
});

test('the unknown state is decided BEFORE emptiness, so it cannot be overridden', () => {
  // Order matters: a protocol that is wired up, reads false, and whose read
  // failed must come back unknown rather than available.
  expect(stateOf({ wiredUp: true, live: false, liveKnown: false })).toBe('unknown');
  // Even a draft whose read failed is reported as unknown rather than guessed.
  expect(stateOf({ wiredUp: false, live: false, liveKnown: false })).toBe('unknown');
  expect(stateOf(null)).toBe('unknown');
});

test('only a running protocol is coloured, and never red', () => {
  // design.md reserves red for a person waiting on a human. A protocol that
  // is not switched on is not an emergency, and a screen with three red
  // cards teaches staff to ignore red where it means somebody is waiting.
  expect(stateTone('running')).toBe('accent');
  for (const s of ['available', 'draft', 'unknown']) expect(stateTone(s)).toBe('quiet');
  expect(SCREEN, 'the Workflows screen introduced a red tone').not.toMatch(/\bbg-red-|text-red-/);
});

test('the summary counts, and never offers a percentage', () => {
  expect(summaryLine({ total: 5, wiredUpCount: 3, liveCount: 0 }))
    .toBe('0 running · 3 ready · 2 draft');
  expect(summaryLine({ total: 3, wiredUpCount: 3, liveCount: 3 })).toBe('3 running');
  // "60% of protocols active" is a number about the software. A pharmacist
  // needs to know how many things are asking their patients questions.
  expect(summaryLine({ total: 5, wiredUpCount: 3, liveCount: 1 })).not.toMatch(/%/);
});

test('a read that never happened says so rather than reporting zero', () => {
  expect(summaryLine(null)).toBe('Not recorded');
  expect(summaryLine(null)).not.toMatch(/0 running/);
});

test('a count of zero is shown, not hidden', () => {
  // fever v1 has NO red flags and v2 has eight. That zero is the most
  // important thing about v1 when the two sit side by side, so a step list
  // that dropped falsy values would delete the point.
  const steps = stepsOf({ counts: { triggers: 7, questions: 7, redFlags: 0, escalationRules: 0 } });
  const redFlags = steps.find((s) => s.label === 'Stops on');
  expect(redFlags).toBeTruthy();
  expect(redFlags.value).toBe(0);
});

test('search finds a protocol by the words somebody would type', () => {
  const list = [
    { name: 'Fever assessment and triage', slug: 'fever_assessment', conditionDomain: 'fever' },
    { name: 'Cough assessment and triage', slug: 'cough_assessment', conditionDomain: 'cough' },
  ];
  expect(matchProtocols(list, 'fever')).toHaveLength(1);
  expect(matchProtocols(list, 'COUGH')).toHaveLength(1);
  expect(matchProtocols(list, '')).toHaveLength(2);
  expect(matchProtocols(list, 'malaria')).toHaveLength(0);
});

test('the four states are the four the screen offers as filters', () => {
  // A filter naming a state nothing can be in is a dead end; a state with no
  // filter is a protocol a pharmacist cannot find.
  expect(STATES.map((s) => s.id)).toEqual(['running', 'available', 'draft', 'unknown']);
  for (const s of STATES) expect(SCREEN).toMatch(new RegExp(`${s.id}|STATES`));
});

test('the screen never offers to create or edit a protocol', () => {
  // The reference has "+ Create workflow". Protocol content is clinical
  // governance, and a web form that writes question sets is that change
  // wearing a UI.
  expect(SCREEN).not.toMatch(/Create workflow|New workflow/i);
  expect(SCREEN, 'the screen grew a write path').not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
});

test('the screen shows the patient-facing questions verbatim', () => {
  // This is the part a patient actually experiences. Paraphrasing it would
  // show a pharmacist something their patients are not being asked.
  expect(SCREEN).toMatch(/\{q\.text\}/);
});
