/**
 * The wording of the consultation note.
 *
 * A consultation is one pharmacist's account of a medical interaction, written
 * so another pharmacist can act on it. Every test here defends a sentence that
 * would be false if the code were slightly different.
 */

import { test, expect } from 'vitest';
import {
  STATUS_LABEL, STATUS_TONE, NO_RED_FLAGS, NO_TRIAGE, EMPTY,
  statusLabel, statusTone, isOpen, lagosToday, dayLabel, whenLabel,
  reasonLine, outstandingLine, redFlagLine, summaryLines,
  problemLine, referralLine, RECORD_GONE, REFERRAL_NOT_CONSIDERED,
  NO_PROBLEMS, NO_INTERVENTIONS,
  amendedNote, canAmend, historyLine, snapshotLines, HISTORY_LABEL, NO_HISTORY,
  AMEND_RETIRED,
} from './consultationFormat.js';

test('a retired note is "entered in error", never "deleted"', () => {
  // §39, and the position the medication review settled for this codebase: a
  // finished clinical record is the record of a professional act. The word
  // matters because the row is still there and still readable.
  expect(STATUS_LABEL.entered_in_error).toBe('Entered in error');
  expect(JSON.stringify(STATUS_LABEL)).not.toMatch(/delete|removed|void/i);
  expect(statusLabel('completed')).toBe('Completed');
  expect(statusLabel('nonsense')).toBe(null);
});

test('an unfinished note is not red — the desk keeps red', () => {
  // design.md gives red to a person waiting on a human and says only
  // Consultations earns it. That is the consultation DESK, where somebody is
  // actually waiting. A note being unfinished is not somebody waiting.
  expect(STATUS_TONE.draft).toBe('ui-tone-1');
  expect(STATUS_TONE.in_progress).toBe('ui-tone-1');
  expect(STATUS_TONE.completed).toBe(null);
  for (const tone of Object.values(STATUS_TONE)) {
    expect(String(tone)).not.toMatch(/red|danger/i);
  }
  expect(statusTone('completed')).toBe(null);
});

test('only an open note can be written to', () => {
  expect(isOpen({ status: 'draft' })).toBe(true);
  expect(isOpen({ status: 'in_progress' })).toBe(true);
  expect(isOpen({ status: 'completed' })).toBe(false);
  expect(isOpen({ status: 'entered_in_error' })).toBe(false);
  expect(isOpen(null)).toBe(false);
});

// THE MOST IMPORTANT TEST IN THIS FILE.
test('"no red flags recorded" is not the same claim as "no red flags"', () => {
  // An encounter whose engine found nothing reports an empty list. Rendering
  // that as "None" reads as a clinical all-clear that nobody signed. "None
  // recorded" says who looked, and leaves the judgement with the pharmacist.
  expect(NO_RED_FLAGS).toBe('None recorded');
  expect(NO_RED_FLAGS).toMatch(/recorded/i);
  expect(NO_RED_FLAGS).not.toBe('None');

  const clear = redFlagLine({ redFlags: [] });
  expect(clear.text).toBe('None recorded');
  expect(clear.tone).toBe(null);

  const flagged = redFlagLine({ redFlags: ['sudden_onset', 'chest_pain'] });
  expect(flagged.text).toBe('sudden_onset, chest_pain');
  expect(flagged.tone).toBe('ui-tone-1');

  // No episode at all: nothing is said about red flags in either direction.
  expect(redFlagLine(null)).toBe(null);
  expect(NO_TRIAGE).toMatch(/not raised from a conversation/i);
});

test('the reason is the pharmacist\'s own words, and absent when they wrote none', () => {
  const reasons = [{ id: 'cough', label: 'Cough' }, { id: 'other', label: 'Other' }];
  expect(reasonLine({ reasonCode: 'cough', reasonText: 'Four days, dry' }, reasons))
    .toBe('Cough — Four days, dry');
  expect(reasonLine({ reasonCode: 'cough', reasonText: null }, reasons)).toBe('Cough');
  expect(reasonLine({ reasonCode: null, reasonText: 'Wants a second opinion' }, reasons))
    .toBe('Wants a second opinion');

  // Nothing written: nothing shown. Not "General", not "Unspecified".
  expect(reasonLine({ reasonCode: null, reasonText: null }, reasons)).toBe(null);
  expect(reasonLine(null, reasons)).toBe(null);
});

test('a note that cannot be finalised says WHAT is missing, not that it is incomplete', () => {
  // A pharmacist told only that something is missing has to hunt for it.
  expect(outstandingLine(['Record your assessment.'])).toBe('Record your assessment.');
  const many = outstandingLine(['Say why the patient was seen.', 'Record the plan.']);
  expect(many).toMatch(/Say why the patient was seen\./);
  expect(many).toMatch(/Record the plan\./);
  expect(outstandingLine([])).toBe(null);
  expect(outstandingLine(null)).toBe(null);
});

test('the formatter adds nothing to the summary the server assembled', () => {
  // §22. A formatter that filled a gap would be inventing a clinical finding
  // two layers from where anybody would look for it.
  const parts = [
    { id: 'reason', label: 'Reason', lines: ['Cough'] },
    { id: 'assessment', label: 'Assessment', lines: ['Uncomplicated acute cough'] },
  ];
  const lines = summaryLines(parts);
  expect(lines.map((l) => l.id)).toEqual(['reason', 'assessment']);
  expect(lines[0].text).toBe('Cough');

  // An empty summary stays empty — no skeleton of headings.
  expect(summaryLines([])).toEqual([]);
  expect(summaryLines(null)).toEqual([]);
});

test('no empty state claims anything about the patient', () => {
  expect(EMPTY.none).toBe('No consultations');
  expect(`${EMPTY.none} ${EMPTY.noneHelp} ${EMPTY.notRecorded}`)
    .not.toMatch(/healthy|well|fine|no problems|nothing wrong|all clear/i);
});

test('the pharmacy clock is Lagos, not the browser\'s', () => {
  // 23:30 UTC is already tomorrow in Lagos. A note written "today" in the
  // pharmacy must not be dated yesterday because of where the viewer is.
  expect(lagosToday(new Date('2026-09-26T23:30:00Z'))).toBe('2026-09-27');
  expect(dayLabel('2026-09-27T09:00:00Z')).toBe('27 Sept 2026');
  expect(whenLabel('2026-09-27T09:00:00Z', '2026-09-27')).toBe('Today');
  expect(whenLabel('2026-09-20T09:00:00Z', '2026-09-27')).toBe('20 Sept 2026');
  expect(dayLabel('nonsense')).toBe(null);
});

// ---- phase 2: problems, interventions, referral ---------------------------

test('a problem shows its uncertainty, and an established one is not hedged', () => {
  // "angina" and "possible angina" are different clinical statements, and the
  // problem list is what another pharmacist reads first.
  const certainties = [{ id: 'possible', label: 'Possible' }, { id: 'established', label: 'Established' }];
  const statuses = [{ id: 'active', label: 'Active' }, { id: 'under_assessment', label: 'Under assessment' }];

  const uncertain = problemLine({ label: 'angina', certainty: 'possible', status: 'under_assessment' }, certainties, statuses);
  expect(uncertain.label).toBe('Possible angina');
  expect(uncertain.status).toBe('Under assessment');

  // A pharmacist who said established meant it. Prefixing would read as
  // hedging something they did not hedge.
  const certain = problemLine({ label: 'Hypertension', certainty: 'established', status: 'active' }, certainties, statuses);
  expect(certain.label).toBe('Hypertension');

  expect(problemLine(null)).toBe(null);
});

test('a problem whose record was deleted still says it was attached', () => {
  const withRecord = problemLine({ label: 'x', certainty: 'possible', refKind: 'vitals', record: { label: '16 Sep 2026' } }, [], []);
  expect(withRecord.gone).toBe(false);
  expect(withRecord.record.label).toBe('16 Sep 2026');

  // The row does not vanish — that the consultation was about it is a fact.
  const gone = problemLine({ label: 'x', certainty: 'possible', refKind: 'vitals', record: null }, [], []);
  expect(gone.gone).toBe(true);
  expect(RECORD_GONE).toBe('No longer on the record');

  // A problem that never pointed at anything is not "gone".
  const noPointer = problemLine({ label: 'x', certainty: 'possible', refKind: null, record: null }, [], []);
  expect(noPointer.gone).toBe(false);
});

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('a referral nobody considered shows NOTHING, not "not required"', () => {
  // §17, and the same distinction the server enforces. "Referral: not
  // required" on a note where nobody considered it is a clinical decision the
  // software invented, and the next pharmacist reads it as one somebody took.
  const destinations = [
    { id: 'none', label: 'No referral required' },
    { id: 'physician', label: 'Refer to physician' },
    { id: 'emergency', label: 'Emergency referral' },
  ];
  const urgencies = [{ id: 'routine', label: 'Routine' }, { id: 'emergency', label: 'Emergency' }];

  expect(referralLine({ referralDestination: null }, destinations, urgencies)).toBe(null);
  expect(referralLine({}, destinations, urgencies)).toBe(null);
  expect(referralLine(null)).toBe(null);

  const decided = referralLine({ referralDestination: 'none' }, destinations, urgencies);
  expect(decided.destination).toBe('No referral required');
  expect(decided.tone).toBe(null);

  const referred = referralLine({
    referralDestination: 'physician', referralUrgency: 'routine', referralReason: 'Persistent elevated BP',
  }, destinations, urgencies);
  expect(referred.destination).toBe('Refer to physician');
  expect(referred.urgency).toBe('Routine');
  expect(referred.reason).toBe('Persistent elevated BP');
  expect(referred.tone).toBe(null);
});

test('an emergency referral is the one that catches the eye — in amber, not red', () => {
  // design.md keeps red for a person waiting on a human and says only
  // Consultations earns it, so this takes the strongest tone it is entitled to.
  const urgent = referralLine({ referralDestination: 'emergency', referralReason: 'x' }, [], []);
  expect(urgent.tone).toBe('ui-tone-1');
  expect(String(urgent.tone)).not.toMatch(/red|danger/i);
});

test('the empty lists claim nothing about the patient', () => {
  expect(NO_PROBLEMS).toBe('No problems recorded');
  expect(NO_INTERVENTIONS).toBe('No interventions recorded');
  expect(REFERRAL_NOT_CONSIDERED).toBe('Not recorded');
  for (const s of [NO_PROBLEMS, NO_INTERVENTIONS, REFERRAL_NOT_CONSIDERED]) {
    expect(s).not.toMatch(/healthy|well|fine|no problems found|nothing wrong|all clear/i);
  }
  // "No problems RECORDED" says who did not record, not that there are none.
  expect(NO_PROBLEMS).toMatch(/recorded/i);
});

// ---- phase 3: amendment and the audit view --------------------------------

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('a note nobody has corrected says NOTHING about versions', () => {
  // "Original", "Version 1" and "No amendments" are all claims about a
  // history nobody has looked at, and the first two invent a version number
  // this product does not have. Silence is the honest answer.
  expect(amendedNote({ amendmentCount: 0 })).toBe(null);
  expect(amendedNote({})).toBe(null);
  expect(amendedNote(null)).toBe(null);

  // A note that HAS been corrected says so wherever it is read: the text on
  // screen is not what was signed, and the next pharmacist acting on it is
  // entitled to know that.
  expect(amendedNote({ amendmentCount: 1 })).toBe('Amended once');
  expect(amendedNote({ amendmentCount: 3 })).toBe('Amended 3 times');
});

test('only a finalised note is offered an amendment', () => {
  expect(canAmend({ status: 'completed' })).toBe(true);
  // A draft is simply edited — asking for a reason to change text nobody has
  // signed is a form getting in the way.
  expect(canAmend({ status: 'draft' })).toBe(false);
  expect(canAmend({ status: 'in_progress' })).toBe(false);
  // §39: a retired note is left as it is.
  expect(canAmend({ status: 'entered_in_error' })).toBe(false);
  expect(canAmend(null)).toBe(false);

  // AMENDED 2026-09-28 after opening the screen: the first version put this
  // sentence in a section headed "Amend this note", which named an action the
  // panel then refused. It now sits in the banner that already explains the
  // status, so a retired note is never offered an amendment at all.
  expect(AMEND_RETIRED).toMatch(/not amended/i);
  expect(AMEND_RETIRED).not.toMatch(/deleted|removed/i);
});

test('the history is readable, and shows an event it cannot label rather than hiding it', () => {
  const line = historyLine({
    eventType: 'CONSULTATION_AMENDED', occurredAt: '2026-09-27T09:00:00Z',
    actor: 'ade@rxnaija.local', metadata: { reason: 'BP was 148/92' },
  });
  expect(line.label).toBe('Amended');
  expect(line.reason).toBe('BP was 148/92');
  expect(line.who).toBe('ade@rxnaija.local');
  expect(line.when).toBe('27 Sept 2026');
  expect(line.unlabelled).toBe(false);

  // A history that silently drops what it cannot name reads as complete when
  // it is not — the one thing an audit trail must never do.
  const odd = historyLine({ eventType: 'SOMETHING_NEW', occurredAt: '2026-09-27T09:00:00Z' });
  expect(odd.label).toBe('SOMETHING_NEW');
  expect(odd.unlabelled).toBe(true);
  expect(historyLine(null)).toBe(null);
});

test('every event the consultation service writes has wording', () => {
  // Read from the SERVER, not a fixture — the failure this prevents is a new
  // event type shipping and the history printing its machine name at a
  // pharmacist. The console already warns about exactly this on the patient
  // timeline, which is a different screen with the same problem.
  const labelled = Object.keys(HISTORY_LABEL);
  for (const t of ['CONSULTATION_STARTED', 'CONSULTATION_COMPLETED', 'CONSULTATION_AMENDED',
    'CONSULTATION_ENTERED_IN_ERROR', 'CONSULTATION_PROBLEM_ADDED',
    'CONSULTATION_INTERVENTION_RECORDED', 'CONSULTATION_REFERRAL_RECORDED']) {
    expect(labelled, `no wording for ${t}`).toContain(t);
  }
  // None of the wording is the machine name with the underscores taken out.
  for (const [type, label] of Object.entries(HISTORY_LABEL)) {
    expect(label).not.toBe(type);
    expect(label).not.toMatch(/_/);
  }
});

test('a snapshot shows what the note said, and nothing is recomputed', () => {
  const amendment = {
    reason: 'Assessment was wrong',
    snapshot: {
      assessmentText: 'Uncomplicated acute cough',
      summary: [{ id: 'assessment', label: 'Assessment', lines: ['Uncomplicated acute cough'] }],
    },
  };
  const lines = snapshotLines(amendment);
  expect(lines.map((l) => l.id)).toEqual(['assessment']);
  expect(lines[0].text).toBe('Uncomplicated acute cough');

  // A snapshot with no stored summary shows nothing rather than being
  // rebuilt — it must keep saying what it said, even after the summary order
  // or the vocabulary changes underneath it.
  expect(snapshotLines({ snapshot: { assessmentText: 'Something' } })).toEqual([]);
  expect(snapshotLines(null)).toEqual([]);
});

test('an empty history claims nothing about the note', () => {
  expect(NO_HISTORY).toBe('No history recorded');
  expect(NO_HISTORY).toMatch(/recorded/i);
  expect(NO_HISTORY).not.toMatch(/unchanged|never|original|untouched/i);
});
