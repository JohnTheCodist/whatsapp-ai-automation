/**
 * The sections of one patient's record, in the order the owner named them.
 *
 * PURE — a list and two lookups, no React, no fetch. The record's navigation
 * (PatientRecord.jsx) renders this; nothing else decides what a record
 * contains, so adding a section is one entry here rather than an edit in
 * three files.
 *
 * `built: false` is a section whose screen does not exist yet. It is kept in
 * the list on purpose: the navigation is the agreed shape of a record, and a
 * pharmacist should be able to see that allergies WILL live here before they
 * do. The shell says plainly that the section is not built rather than
 * showing an empty panel that looks like a patient with no allergies — which
 * is the one way this screen could mislead someone clinically.
 *
 * Labels are sentence case, per design.md. The owner's list was written in
 * title case ("Vital & Biometrics"); the wording is theirs, the casing is
 * the system's.
 */

import {
  IconPerson, IconPulse, IconPill, IconFlask, IconClipboard,
  IconAlertTriangle, IconHeart, IconConsultations, IconInbox,
} from './Icons.jsx';

export const PATIENT_TABS = Object.freeze([
  { id: 'summary', label: 'Patient summary', Icon: IconPerson, built: true },
  { id: 'vitals', label: 'Vitals & biometrics', Icon: IconPulse, built: true },
  { id: 'meds', label: 'Meds', Icon: IconPill, built: true },
  { id: 'results', label: 'Tests', Icon: IconFlask, built: true },
  // Renamed from "Encounters" on 2026-09-24 and built. Consultations live in
  // the CLINICAL module, which documents what happened; the patient record
  // carries what needs to happen next (FOLLOWUP_PLAN.md §3). The Encounters
  // entry had never had a screen, so nothing was replaced.
  { id: 'followup', label: 'Follow-up', Icon: IconClipboard, built: true },
  { id: 'allergies', label: 'Allergies', Icon: IconAlertTriangle, built: true },
  { id: 'conditions', label: 'Conditions', Icon: IconHeart, built: true },
  // Renamed from "Clinic" on 2026-09-24 and built. The Clinic entry had never
  // had a screen, so nothing was replaced; what it pointed at is now the
  // patient's care programmes (CARE_PROGRAM_PLAN.md).
  { id: 'care', label: 'Care program', Icon: IconConsultations, built: true },
  { id: 'messages', label: 'Messages', Icon: IconInbox, built: true },
]);

/** Where a record opens: the summary, which is the section that exists. */
export const DEFAULT_PATIENT_TAB = PATIENT_TABS[0].id;

/** One section by id, or null — never a guess at the nearest match. */
export function patientTab(id) {
  return PATIENT_TABS.find((t) => t.id === id) || null;
}

/**
 * The tab to show for a requested id. An unknown id — a stale link, a typo
 * in a future deep link — falls back to the summary rather than rendering
 * nothing, because a blank record reads as a patient with no history.
 */
export function resolvePatientTab(id) {
  return patientTab(id) ? id : DEFAULT_PATIENT_TAB;
}

/** The key the collapsed/expanded choice is remembered under, per browser. */
export const NAV_STATE_KEY = 'rxnaija.patientRecordNav';
