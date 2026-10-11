/**
 * The brand accent stays off call-to-action buttons.
 *
 * design.md, "CTA voice":
 *
 *   Primary: near-black fill (`bg-slate-900` -> #171717), white text, 8px
 *   radius... Deliberately not emerald: keeping the accent off buttons is
 *   what lets it keep meaning "healthy" in a status pill two inches away.
 *
 * and, recorded when the shell was redesigned against the Rhazes reference,
 * the owner's own answer: asked directly whether to take that reference's
 * deep-green primary button, they chose "layout yes, colour no".
 *
 * WHAT WAS ACTUALLY ON SCREEN. Nine solid `bg-teal-700` CTAs — "Publish my
 * website", "Use this design", "Save details", "Save", "Send suggestion" —
 * seven of them in the website module, which was the one part of the app
 * that never took the desk's CTA voice.
 *
 * The collision design.md describes was not hypothetical. `WebsiteHeader`
 * renders a `bg-teal-50 text-teal-800` pill reading "Live" in the same
 * header as a `bg-teal-700` publish button: the accent meaning "this site is
 * healthy and online" an inch from the accent meaning "press me".
 *
 * teal-600 AND LIGHTER ARE LEFT ALONE, and that is the point rather than an
 * exemption. A tick inside a chosen service, the open-state ring on an info
 * toggle, the "Live" pill, the assistant's message bubble — those are
 * identity and status, which is what the accent is FOR. Only the solid
 * CTA weight is forbidden.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Every .jsx under client/src, including the website module. */
function jsxFiles(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsxFiles(full, found);
    else if (entry.name.endsWith('.jsx')) found.push(full);
  }
  return found;
}

const FILES = jsxFiles();

test('there are screens to check at all', () => {
  // A walker that silently found nothing would make every rule below pass
  // while proving none of them.
  expect(FILES.length).toBeGreaterThan(20);
});

test('no call-to-action is filled with the brand accent', () => {
  // The solid-button weights. Anything lighter is status or selection.
  const offenders = [];
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/bg-teal-[789]00/.test(line)) {
        offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    });
  }
  expect(offenders, `accent-filled CTAs are back: ${offenders.join(', ')}`).toEqual([]);
});

test('a hover state cannot put the accent back', () => {
  // The original markup paired `bg-teal-700` with `hover:bg-teal-800`, so
  // fixing only the resting fill would have left the button turning brand
  // green under the cursor — the same claim, made on mouseover.
  const offenders = [];
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    if (/hover:bg-teal-[789]00/.test(src)) offenders.push(path.relative(SRC, file));
  }
  expect(offenders, `accent hover fills: ${offenders.join(', ')}`).toEqual([]);
});

test('the website module uses the same primary fill as the rest of the desk', () => {
  // It was the only module that did not. Asserted positively so the module
  // cannot pass by simply having no buttons left.
  const header = fs.readFileSync(path.join(SRC, 'website', 'WebsiteHeader.jsx'), 'utf8');
  const picker = fs.readFileSync(path.join(SRC, 'website', 'TemplatePicker.jsx'), 'utf8');
  expect(header).toMatch(/bg-slate-900/);
  expect(picker).toMatch(/bg-slate-900/);
});

test('the accent still carries status, which is what it is for', () => {
  // The rule is not "no green anywhere". If this ever fails it means the
  // "Live" pill lost its colour, and the fix above went too far.
  const header = fs.readFileSync(path.join(SRC, 'website', 'WebsiteHeader.jsx'), 'utf8');
  expect(header).toMatch(/published:\s*\{[^}]*bg-teal-600/);
  expect(header).toMatch(/bg-teal-50 text-teal-800/);
});
