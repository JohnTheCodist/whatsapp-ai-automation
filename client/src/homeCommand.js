/**
 * Home, as a command surface.
 *
 * SHELL_PLAN.md phase 2. Home was five module tiles whose descriptions and
 * live figures arrived in a card on hover. The owner chose the Rhazes.ai
 * shape instead: a greeting, the one thing that needs a person, and an input
 * you type into.
 *
 * PURE, like every other format module here, because the wording is most of
 * what this screen IS and it should be checkable without a browser.
 */

import { MODULES, sidebarFor, tileStatus } from './modules.js';

/**
 * The greeting.
 *
 * IT DOES NOT USE A NAME, and that is a decision rather than an omission.
 * The reference greets by first name because it has one. This app is handed
 * an email address and a pharmacy name — and `adetiloyejohn7@gmail.com` does
 * not contain a first name, it contains a guess. Inventing one is the same
 * failure as an allergy card that says "None" because nobody asked.
 *
 * The pharmacy's name is already in the sidebar's workspace row, two inches
 * up and always on screen, so greeting it here would be saying it twice.
 */
function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good morning.';
  if (h < 17) return 'Good afternoon.';
  return 'Good evening.';
}

/**
 * The one line under the greeting.
 *
 * ONE, not five. The tiles showed a figure per module and the hierarchy was
 * flat — "no orders waiting" sat at the same weight as somebody waiting for
 * a pharmacist. Here the second line is reserved for the thing with a cost,
 * and everything else moves to a quiet row below the input.
 *
 * Nothing is claimed before it is known: a count that has not arrived yet
 * renders as null, never as a zero it has not earned.
 */
function headline(summary) {
  if (!summary) return null;
  const waiting = summary.handoffs;
  if (waiting == null) return null;
  if (waiting > 0) {
    return {
      text: waiting === 1
        ? 'One person is waiting for a pharmacist.'
        : `${waiting} people are waiting for a pharmacist.`,
      // The one place on this screen allowed to be urgent. design.md keeps
      // red for a person waiting on a human, and this is literally that.
      tone: 'alert',
    };
  }
  return { text: 'Nobody is waiting for a pharmacist.', tone: 'quiet' };
}

/**
 * Everything the tiles used to say, in one quiet row.
 *
 * Removing the tiles must not remove the FIGURES — a pharmacist opening Home
 * learned how the shop stands at a glance, and losing that would be trading
 * information for air. The clinic line is left out because it is the
 * headline above.
 */
function standing(summary, { websiteEnabled = null } = {}) {
  if (!summary) return [];
  return MODULES
    .filter((m) => m.id !== 'clinics')
    .map((m) => tileStatus(m.id, { ...summary, websiteEnabled }))
    .filter(Boolean)
    .map((s) => s.text);
}

const PLACEHOLDER = 'Search a patient, or jump to a screen…';

/** Every screen the sidebar can reach, flattened for matching. */
function allScreens({ websiteEnabled = null } = {}) {
  return MODULES.flatMap((m) => sidebarFor(m, { websiteEnabled }).map((i) => ({
    tab: i.tab,
    label: i.label,
    module: m.label,
  })));
}

/**
 * Match what was typed against the screens.
 *
 * Prefix first, then anywhere — so typing "co" offers Consultations before
 * it offers Stock sync, which is what somebody typing two letters means.
 * The module name is searched too, so "clinic" finds Triage.
 */
function matchScreens(query, ctx = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const screens = allScreens(ctx);
  const starts = screens.filter((s) => s.label.toLowerCase().startsWith(q));
  const contains = screens.filter((s) => !starts.includes(s)
    && (s.label.toLowerCase().includes(q) || s.module.toLowerCase().includes(q)));
  return [...starts, ...contains].slice(0, 6);
}

/**
 * Is this worth asking the server about?
 *
 * One character matches every patient in the pharmacy, which is a request
 * that costs something and answers nothing.
 */
const MIN_PATIENT_QUERY = 2;

function shouldSearchPatients(query) {
  return String(query || '').trim().length >= MIN_PATIENT_QUERY;
}

/** Headings, said only when that half has something under it. */
const PATIENTS_HEADING = 'Patients';
const SCREENS_HEADING = 'Screens';
const NO_MATCH = 'Nothing matches that.';

/**
 * The recording control that sits under the command box.
 *
 * "Record a consultation", never a bare "Record": the button does not
 * start listening. It opens the screen where a patient is chosen and
 * asked. A button labelled "Record" that then asks a question is a small
 * lie told at the exact moment somebody is about to speak to a patient.
 *
 * WHY IT CANNOT SIMPLY LISTEN. Transcription lives at
 * POST /customers/:id/consultations/:consultationId/scribe — bound to a
 * patient and a note, behind `scribeGate`, which is re-read from the
 * database on every request and fails closed. 0071 added the consent
 * columns so that "we do not record anyone who was not asked" stays true
 * without anybody maintaining it. There is NO patient-free transcribe
 * endpoint, and adding one to put a microphone on this box would be a
 * door marked "dictate your question" that a patient can be recorded
 * through.
 */
const RECORD_LABEL = 'Record a consultation';
const RECORD_NOTE = 'Choose the patient first — they are asked before anything is recorded.';

export {
  greeting, headline, standing, PLACEHOLDER, RECORD_LABEL, RECORD_NOTE,
  allScreens, matchScreens, shouldSearchPatients, MIN_PATIENT_QUERY,
  PATIENTS_HEADING, SCREENS_HEADING, NO_MATCH,
};
