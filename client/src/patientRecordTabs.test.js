/**
 * The shape of a patient's record.
 *
 * The list is the agreement about what a record contains, so it is pinned
 * here: the sections, their order, and which of them have screens. The
 * failure this defends against is a section quietly disappearing from the
 * navigation during a refactor — a pharmacist cannot look for Allergies if
 * nothing says Allergies is part of a record.
 */

import { test, expect } from 'vitest';
import {
  PATIENT_TABS, DEFAULT_PATIENT_TAB, patientTab, resolvePatientTab,
} from './patientRecordTabs.js';

test('the nine sections of a record, in the order the owner named them', () => {
  // AMENDED 2026-09-24 with the product: "Encounters" is now "Follow-up".
  // Consultations are the CLINICAL module's record — what happened — and the
  // patient record carries what needs to happen NEXT (FOLLOWUP_PLAN.md §3).
  // The Encounters entry had never had a screen, so nothing was replaced.
  //
  // AMENDED 2026-09-26, also with the product: "Clinical view", "Form entry"
  // and "Appointments" were REMOVED at the owner's request. All three were
  // placeholders that had never had a screen — the record no longer advertises
  // sections that do not exist. Every entry that remains is built.
  expect(PATIENT_TABS.map((t) => t.label)).toEqual([
    'Patient summary', 'Vitals & biometrics', 'Meds', 'Tests',
    'Follow-up', 'Allergies', 'Conditions', 'Care program', 'Messages',
  ]);
});

// The point of removing them: the navigation no longer names a section a
// pharmacist cannot open. This is the rule, stated so a placeholder cannot
// quietly come back without somebody deciding to.
test('the record advertises no section it cannot open', () => {
  expect(PATIENT_TABS.filter((t) => !t.built)).toEqual([]);
});

test('every section has a unique id and an icon of its own', () => {
  const ids = PATIENT_TABS.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const tab of PATIENT_TABS) {
    expect(typeof tab.Icon, `${tab.id} has an icon`).toBe('function');
  }
  // Two sections sharing a glyph would make the collapsed column ambiguous,
  // and the column is collapsed exactly when only the glyphs are readable.
  const icons = PATIENT_TABS.map((t) => t.Icon);
  expect(new Set(icons).size).toBe(icons.length);
});

test('a record opens on the summary, which is the section that exists', () => {
  expect(DEFAULT_PATIENT_TAB).toBe('summary');
  expect(patientTab(DEFAULT_PATIENT_TAB).built).toBe(true);
});

test('exactly the sections marked built are the ones with a screen', () => {
  // The reminder to keep the flag honest: the shell renders "not built yet"
  // from it, and the summary offers "See all" against it. Vitals joined on
  // 2026-09-20 (Vitals.jsx), Meds on 2026-09-21 (Medications.jsx, phase 1 of
  // MEDICATIONS_PLAN.md), and Care program on 2026-09-24 (CarePrograms.jsx) --
  // which is also where the "Clinic" entry went: it had no screen of its own,
  // so the rename replaced nothing. Follow-up joined on 2026-09-24
  // (Followups.jsx), the same way. Messages joined on 2026-09-25
  // (PatientMessages.jsx, phase 1 of MESSAGES_PLAN.md) -- also a placeholder
  // with no screen of its own, so it replaced nothing either; what it shows
  // is the conversations and messages this product has had since 0001, scoped
  // to one patient, rather than a new store of its own.
  //
  // Since 2026-09-26 this is EVERY section: the three that had no screen were
  // removed rather than left advertising themselves.
  expect(PATIENT_TABS.filter((t) => t.built).map((t) => t.id)).toEqual(['summary', 'vitals', 'meds', 'results', 'followup', 'allergies', 'conditions', 'care', 'messages']);
});

test('an unknown section falls back to the summary rather than rendering nothing', () => {
  expect(patientTab('nope')).toBe(null);
  expect(resolvePatientTab('nope')).toBe('summary');
  expect(resolvePatientTab(undefined)).toBe('summary');
  expect(resolvePatientTab('allergies')).toBe('allergies');
});
