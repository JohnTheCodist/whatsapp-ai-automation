/**
 * What the chrome above a screen says it is showing — the breadcrumb, the
 * page heading and the line under it.
 *
 * SHELL_PLAN.md phase 4. Pinned as structural invariants on App.jsx and
 * Customers.jsx, the same approach as sidebarRail.test.js and
 * consultationLayout.test.js: the wiring is React state across two files and
 * cannot be exercised without a browser, but the rules that make it correct
 * are plain text.
 *
 * WRITTEN AFTER THE FACT, and that is worth recording rather than hiding.
 * The commit that made the heading name the patient (a932d33) shipped with
 * no test at all, which AGENTS.md forbids. These cover that behaviour as
 * well as the subtitle it missed.
 *
 * The defect they all defend against is one thing: chrome that confidently
 * describes the screen you LEFT. Standing in Ngozi Okafor's medication
 * record, the breadcrumb said "Patients / All patients", the heading said
 * "Patients", and the line beneath it said "View all your customers'
 * details" — on a clinical record, where the name at the top is the thing a
 * pharmacist checks before acting.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const CUSTOMERS = fs.readFileSync(path.join(SRC, 'Customers.jsx'), 'utf8');
const MODULES = fs.readFileSync(path.join(SRC, 'modules.js'), 'utf8');

/** The keys of App.jsx's SUBTITLE map, read from the source. */
function subtitleKeys() {
  const start = APP.indexOf('const SUBTITLE = {');
  const end = APP.indexOf('};', start);
  expect(start, 'the SUBTITLE map has been renamed or removed').toBeGreaterThan(-1);
  return new Set([...APP.slice(start, end).matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1]));
}

test('the heading and the breadcrumb both name the patient whose record is open', () => {
  // Both, not one. The heading was what the owner was looking at, but the
  // breadcrumb is what says where you can go back TO, and "All patients"
  // while one patient is on screen is the same wrong subject.
  expect(APP).toMatch(/const pageTitle = openPatientName \|\| titleFor\(tab\)/);
  expect(APP).toMatch(/const crumbTitle = openPatientName \|\| crumbFor\(tab\)/);

  // The patient wins over the screen's own wording, not the other way round.
  expect(APP, 'the screen title would win over the patient')
    .not.toMatch(/const pageTitle = titleFor\(tab\) \|\| openPatientName/);
});

test('the line under the heading is ABSENT on a patient record, not just wrong', () => {
  // The defect this closes: the heading was fixed and the sentence beneath
  // it was not, so all nine sections of a record carried a subtitle about
  // the list the pharmacist had left.
  expect(APP).toMatch(/const pageSubtitle = openPatientName \? null : SUBTITLE\[tab\]/);

  // Rendered CONDITIONALLY. An empty <p> still occupies its line and reads
  // as something that failed to load, which is a different wrong answer
  // rather than no answer.
  expect(APP).toMatch(/\{pageSubtitle && \(/);
  expect(APP, 'the subtitle is still read straight out of the map at render')
    .not.toMatch(/<p[^>]*>\{SUBTITLE\[tab\]\}<\/p>/);
});

test('hiding the subtitle can only ever hide the patient case', () => {
  // THE GUARD THAT MAKES THE RULE ABOVE SAFE. `pageSubtitle` is nullable
  // now, so a screen that lost its SUBTITLE entry would silently render no
  // subtitle and look deliberate. Every screen the sidebar can open must
  // have one, which means the only thing the condition can suppress is the
  // record case it was written for.
  const subs = subtitleKeys();
  const tabs = [...MODULES.matchAll(/tab:\s*'([a-z-]+)'/g)].map((m) => m[1]);

  expect(tabs.length, 'no screen tabs were found in modules.js').toBeGreaterThan(0);
  const missing = tabs.filter((t) => !subs.has(t));
  expect(missing, `these screens would render no subtitle at all: ${missing.join(', ')}`).toEqual([]);
});

test('the name comes from the row that was clicked, not a second request', () => {
  // PatientSearch already hands the patient over beside the id. Asking the
  // server again for something just shown on screen is how two answers to
  // one question appear, and the slower one wins the heading.
  expect(CUSTOMERS).toMatch(/onOpen=\{\(id, p\) => \{ onPatientName\?\.\(p\?\.name \|\| null\); setSelectedId\(id\); \}\}/);

  // A patient opened by deep link (Refills, Conditions) arrives with no
  // name, and `|| null` is what makes the heading fall back to "Patients" —
  // vague, which is honest, rather than wrong.
  expect(CUSTOMERS, 'a missing name would be reported as a blank heading')
    .not.toMatch(/onPatientName\?\.\(p\?\.name\)/);
});

test('the name is cleared on the way back, by the state and not only by the button', () => {
  // THE HALF THAT MATTERS. A heading still carrying a patient's name after
  // you have left their record is worse than one that never had it: it is
  // confidently wrong rather than merely vague, and the next thing a
  // pharmacist does on that screen is about somebody else.
  //
  // Covered twice on purpose. The button is the path a person takes; the
  // effect is the one that holds when the record closes some other way —
  // a search, a deep link, a tab change that resets the selection.
  expect(CUSTOMERS).toMatch(/onBack=\{\(\) => \{ onPatientName\?\.\(null\); setSelectedId\(null\); \}\}/);
  expect(CUSTOMERS).toMatch(/if \(!selectedId\) \{ onPatientName\?\.\(null\); \}/);
  expect(CUSTOMERS).toMatch(/\}, \[selectedId, onPatientName\]\);/);
});

test('the shell is told the name and nothing else about the patient', () => {
  // The record stays where it is owned. `selectedId` is Customers' — it owns
  // the list/record switch — and lifting it would make every other caller of
  // Customers responsible for state they do not use. The shell needs one
  // string to write a heading with.
  expect(APP).toMatch(/onPatientName=\{setOpenPatientName\}/);
  expect(APP, 'the shell has taken ownership of which patient is selected')
    .not.toMatch(/setSelectedPatientId|selectedPatientId/);
});
