/**
 * The words the patient summary puts on a screen about a person.
 *
 * These are not cosmetic strings. "No allergies" and "no allergies
 * recorded" are different claims, and only the second one is true in a
 * product that has never asked. Every test here is about a sentence that
 * could mislead a pharmacist standing at a counter.
 *
 * AMENDED 2026-09-20. The owner asked for the summary to stop repeating
 * itself — a section used to print "1 condition confirmed from purchase
 * history", then "Hypertension", then a "From purchases" tag under it. The
 * tests changed with the product, not to get to green: what they now check
 * is that the source of a claim still TRAVELS with it (as `provenance`, the
 * item's tooltip, and the section it opens) rather than being printed three
 * times. The rule is unchanged; only where it is shown moved.
 */

import { test, expect } from 'vitest';
import { summaryCards, bodyMarkers, identityLine } from './patientSummaryModel.js';
import { PATIENT_TABS } from './patientRecordTabs.js';
import { MODULE_TABS } from './modules.js';

const profile = (over = {}) => ({
  conditions: [],
  medicationJourneys: [],
  refills: {},
  clinical: { encounters: 0, redFlagEncounters: 0, lastEncounterAt: null },
  conversations: { count: 0, active: 0 },
  ...over,
});

const card = (cards, id) => cards.find((c) => c.id === id);

test('a section with no data says "not recorded", never "none"', () => {
  const cards = summaryCards(profile(), null);
  // The one that matters most: an empty allergies line reading "None" is how
  // someone gets told a patient is safe by a system never told otherwise.
  expect(card(cards, 'allergies').line).toBe('Not recorded');
  expect(card(cards, 'allergies').line).not.toMatch(/\bnone\b/i);
  expect(card(cards, 'vitals').line).toBe('Not recorded');
  expect(card(cards, 'results').line).toBe('Not recorded');
});

test('the Allergies card speaks the record\'s three states, and "no known" only when recorded', () => {
  // Loaded but empty: not assessed — never "none".
  const empty = card(summaryCards(profile(), null, { state: 'not_assessed', allergies: [] }), 'allergies');
  expect(empty.line).toBe('Not assessed');
  expect(empty.line).not.toMatch(/\bnone\b/i);

  const nka = card(summaryCards(profile(), null, { state: 'none_known', allergies: [] }), 'allergies');
  expect(nka.line).toBe('No known allergies');

  const known = card(summaryCards(profile(), null, {
    state: 'known',
    allergies: [
      { id: 'a1', allergenName: 'Penicillin', criticality: 'high', verificationStatus: 'confirmed' },
      { id: 'a2', allergenName: 'Peanuts', criticality: null, verificationStatus: 'unconfirmed' },
    ],
  }), 'allergies');
  expect(known.count).toBe(2);
  expect(known.items.map((i) => i.label)).toEqual(['Penicillin', 'Peanuts']);
  expect(known.flag).toBe('High criticality');
  expect(known.tone).toBe('attention');
  expect(known.items[1].provenance).toBe('Unconfirmed');

  // A state the summary does not recognise is not guessed at.
  expect(card(summaryCards(profile(), null, { state: 'weird' }), 'allergies').line).toBe('Not assessed');
});

test('a condition still carries where it came from, as the item\'s own provenance', () => {
  const cards = summaryCards(profile({
    conditions: [{ code: 'DIABETES', name: 'Diabetes', status: 'CONFIRMED_BY_PURCHASE' }],
  }), null);
  const conditions = card(cards, 'conditions');
  expect(conditions.items[0].label).toBe('Diabetes');
  // Not printed beside the name any more — but never lost.
  expect(conditions.items[0].provenance).toMatch(/purchase history/i);
  expect(conditions.items[0].provenance).toMatch(/not a diagnosis/i);
});

test('a section that lists things does not also print a sentence counting them', () => {
  const cards = summaryCards(profile({
    conditions: [{ code: 'DIABETES', name: 'Diabetes', status: 'CONFIRMED_BY_PURCHASE' }],
  }), null);
  const conditions = card(cards, 'conditions');
  expect(conditions.count).toBe(1);
  expect(conditions.line).toBe(null);
});

test('a condition that is not confirmed is not counted as one', () => {
  const cards = summaryCards(profile({
    conditions: [{ code: 'ASTHMA', name: 'Asthma', status: 'PENDING' }],
  }), null);
  expect(card(cards, 'conditions').items).toEqual([]);
  expect(card(cards, 'conditions').count).toBe(0);
  expect(card(cards, 'conditions').line).toBe('Not recorded');
});

test('medicines count only what is still being followed, and a refill due is two words', () => {
  const cards = summaryCards(profile({
    medicationJourneys: [
      { id: '1', medicineName: 'Metformin 500mg', status: 'active', daysSupply: 30 },
      { id: '2', medicineName: 'Nifedipine 20mg', status: 'stopped', daysSupply: 30 },
    ],
    refills: { due: 1, overdue: 0, lapsed: 0 },
  }), null);
  const meds = card(cards, 'meds');
  expect(meds.count).toBe(1);
  expect(meds.items.map((i) => i.label)).toEqual(['Metformin 500mg']);
  expect(meds.flag).toBe('1 refill due');
  expect(meds.tone).toBe('attention');
});

test('a danger sign in a consultation is flagged in two words, not a sentence', () => {
  // The card counts consultations and opens the CLINICAL module's desk, which
  // is where they live (2026-09-24). It is still on the patient summary, and
  // still says the one thing a pharmacist must not miss.
  const cards = summaryCards(profile({
    clinical: { encounters: 3, redFlagEncounters: 1, lastEncounterAt: '2026-09-14T09:00:00Z' },
  }), null);
  const enc = card(cards, 'encounters');
  expect(enc.count).toBe(3);
  expect(enc.flag).toBe('Danger sign');
  expect(enc.tone).toBe('attention');
  expect(enc.module).toBe('consultations');
  expect(enc.tab).toBe(null);
});

test('the Care program card counts what is open and what is late, and never scores the patient', () => {
  const carePrograms = {
    counts: { active: 2, past: 1, overdueTasks: 2, dueForReview: 1 },
    active: [
      {
        id: 'cp1',
        programName: 'Diabetes care',
        progress: {
          goals: { total: 3, achieved: 1, notAchieved: 0, open: 2 },
          activities: { total: 12, completed: 8, open: 4, overdue: 2, dropped: 0 },
        },
      },
      {
        id: 'cp2',
        programName: 'Hypertension management',
        progress: {
          goals: { total: 2, achieved: 0, notAchieved: 0, open: 2 },
          activities: { total: 5, completed: 1, open: 4, overdue: 0, dropped: 0 },
        },
      },
    ],
  };
  const c = card(summaryCards(profile(), null, null, null, null, carePrograms), 'care');
  expect(c.title).toBe('Care program');
  expect(c.tab).toBe('care');
  expect(c.count).toBe(2);
  expect(c.items.map((i) => i.label)).toEqual(['Diabetes care', 'Hypertension management']);
  expect(c.items[0].provenance).toBe('Goals 1/3 · Tasks 8/12');
  // The one thing worth acting on.
  expect(c.flag).toBe('2 tasks overdue');
  expect(c.tone).toBe('attention');
  // THE ONE THAT MATTERS HERE: nothing on this card is a percentage or a
  // score. "67% complete" beside a patient's name is a claim about the person,
  // not about the admin, and this product does not make it.
  expect(JSON.stringify(c)).not.toMatch(/%|percent|score/i);

  // Nothing overdue, but a review has come round: that is the flag instead.
  const quiet = card(summaryCards(profile(), null, null, null, null, {
    counts: { active: 1, past: 0, overdueTasks: 0, dueForReview: 1 }, active: [],
  }), 'care');
  expect(quiet.flag).toBe('1 due for review');
});

test('"no care programmes" is said only when the record was actually read', () => {
  // Not loaded, or it failed: rule 1 — the card must not claim the patient is
  // in nothing when it simply could not tell.
  expect(card(summaryCards(profile(), null), 'care').line).toBe('Not recorded');

  // Loaded and empty: enrolment is a fact this system holds completely, so
  // saying "no care programmes" here is true. It still says nothing about the
  // patient's health.
  const empty = card(summaryCards(profile(), null, null, null, null, {
    counts: { active: 0, past: 0, overdueTasks: 0, dueForReview: 0 }, active: [],
  }), 'care');
  expect(empty.line).toBe('No care programmes');
  expect(empty.count).toBe(0);
  expect(empty.flag).toBeFalsy();
  expect(empty.tone).toBe('normal');
});

test('the Follow-up card counts what is OUTSTANDING, and flags what is late', () => {
  const followups = {
    counts: { all: 9, today: 1, overdue: 2, upcoming: 3, completed: 3, cancelled: 0, urgent: 0 },
    next: [
      { id: 'f1', title: 'Repeat blood pressure', status: 'not_started', dueOn: '2026-09-20', bucket: 'overdue' },
      { id: 'f2', title: 'Review HbA1c result', status: 'not_started', dueOn: null, bucket: 'upcoming' },
    ],
  };
  const c = card(summaryCards(profile(), null, null, null, null, null, followups), 'followup');
  expect(c.title).toBe('Follow-up');
  expect(c.tab).toBe('followup');
  // Six outstanding (2 overdue + 1 today + 3 upcoming) — NOT the nine that
  // include what is already done. A completed follow-up is history.
  expect(c.count).toBe(6);
  expect(c.items.map((i) => i.label)).toEqual(['Repeat blood pressure', 'Review HbA1c result']);
  // A follow-up with no date says so here too, rather than showing nothing.
  expect(c.items[1].provenance).toBe('No date yet');
  expect(c.flag).toBe('2 overdue');
  expect(c.tone).toBe('attention');
  expect(JSON.stringify(c)).not.toMatch(/%|percent|score/i);

  // Nothing late, but something due today: that is the flag instead.
  const dueToday = card(summaryCards(profile(), null, null, null, null, null, {
    counts: { all: 2, today: 1, overdue: 0, upcoming: 1, completed: 0, cancelled: 0 }, next: [],
  }), 'followup');
  expect(dueToday.flag).toBe('1 due today');
});

test('the Follow-up card tells "never asked" apart from "nothing to do"', () => {
  // Not loaded, or it failed: rule 1 — the card must not claim there is
  // nothing outstanding when it could not tell.
  expect(card(summaryCards(profile(), null), 'followup').line).toBe('Not recorded');

  // Read, and the patient has never had one.
  const never = card(summaryCards(profile(), null, null, null, null, null, {
    counts: { all: 0, today: 0, overdue: 0, upcoming: 0, completed: 0, cancelled: 0 }, next: [],
  }), 'followup');
  expect(never.line).toBe('No follow-ups');
  expect(never.tone).toBe('normal');

  // Read, and everything that was raised is finished — a different fact, and
  // worth saying differently.
  const allDone = card(summaryCards(profile(), null, null, null, null, null, {
    counts: { all: 4, today: 0, overdue: 0, upcoming: 0, completed: 4, cancelled: 0 }, next: [],
  }), 'followup');
  expect(allDone.line).toBe('Nothing outstanding');
  expect(allDone.count).toBe(0);
  expect(allDone.flag).toBeFalsy();
});

test('every section names the one it opens, and it EXISTS', () => {
  // AMENDED 2026-09-24 with the product. A card opens a section of THIS record
  // (tab) or a screen in another module (module) — the Consultations card
  // became the second kind when consultations stopped being a record section.
  // The rule is unchanged: nothing on the summary is a dead end.
  //
  // STRENGTHENED 2026-09-26. This only checked the name was a string, so a
  // card naming a section that had been REMOVED would still have passed —
  // which is precisely the failure that removing a tab risks, and which the
  // Appointments card would have become that day. It now checks the section
  // is really there.
  const cards = summaryCards(profile(), null);
  const sections = new Set(PATIENT_TABS.map((t) => t.id));
  const modules = new Set(MODULE_TABS);
  for (const c of cards) {
    expect(typeof (c.tab || c.module), `${c.id} opens something`).toBe('string');
    if (c.tab) {
      expect(sections.has(c.tab), `${c.id} opens "${c.tab}", which is not a section of the record`).toBe(true);
    }
    // Both halves of the rule. A card pointing at another module's screen can
    // go stale exactly the same way a record section can.
    if (c.module) {
      expect(modules.has(c.module), `${c.id} opens "${c.module}", which is not a screen in any module`).toBe(true);
    }
  }
});

test('the figure is marked only where this product knows the anatomy', () => {
  const marks = bodyMarkers(profile({
    conditions: [
      { code: 'HYPERTENSION', name: 'Hypertension', status: 'CONFIRMED_BY_PURCHASE' },
      // An unmapped code gets NO marker rather than a guessed one: a dot in
      // the wrong place on a body is worse than no dot.
      { code: 'GOUT', name: 'Gout', status: 'CONFIRMED_BY_PURCHASE' },
    ],
  }));
  expect(marks.map((m) => m.region)).toEqual(['chest']);
  expect(marks[0].note).toMatch(/from purchases/i);
  expect(marks[0].tab).toBe('conditions');
});

test('an unconfirmed condition never marks the body', () => {
  expect(bodyMarkers(profile({
    conditions: [{ code: 'HYPERTENSION', name: 'Hypertension', status: 'PENDING' }],
  }))).toEqual([]);
});

test('two conditions in one region become one marker that names both', () => {
  const marks = bodyMarkers(profile({
    conditions: [
      { code: 'HYPERTENSION', name: 'Hypertension', status: 'CONFIRMED_BY_PURCHASE' },
      { code: 'ASTHMA', name: 'Asthma', status: 'CONFIRMED_BY_PURCHASE' },
    ],
  }));
  expect(marks).toHaveLength(1);
  expect(marks[0].note).toMatch(/Hypertension/);
  expect(marks[0].note).toMatch(/Asthma/);
});

test('age and sex are two plain facts, and an unrecorded one says so', () => {
  // The "As reported" / "From date of birth" caption was dropped (owner,
  // 2026-09-20): the field that edits the age is directly below on the same
  // screen and states it there.
  expect(identityLine({ ageYears: 64, ageFromDateOfBirth: true, sex: 'female' }))
    .toEqual([{ id: 'age', text: '64 years' }, { id: 'sex', text: 'Female' }]);
  const none = identityLine({ ageYears: null, sex: null });
  expect(none[0].text).toMatch(/not recorded/i);
  expect(none[1].text).toMatch(/not recorded/i);
});

test('the Conditions card lists RECORDED conditions, and counts purchase suggestions apart', () => {
  const problems = {
    conditions: [
      { id: 'c1', conditionName: 'Hypertension', verificationStatus: 'confirmed', localCode: 'HYPERTENSION' },
      { id: 'c2', conditionName: 'Asthma', verificationStatus: 'provisional', localCode: 'ASTHMA_OR_COPD' },
    ],
    suggestions: [{ localCode: 'DIABETES', name: 'Diabetes' }],
  };
  const conditions = card(summaryCards(profile(), null, null, problems), 'conditions');
  expect(conditions.items.map((i) => i.label)).toEqual(['Hypertension', 'Possible asthma']);
  expect(conditions.items[1].provenance).toMatch(/not confirmed/);
  // The inference is a count, never a listed condition.
  expect(conditions.flag).toBe('1 suggested by purchases');
  expect(conditions.items.map((i) => i.label)).not.toContain('Diabetes');

  // Loaded but empty: not recorded — never "none".
  const empty = card(summaryCards(profile(), null, null, { conditions: [], suggestions: [] }), 'conditions');
  expect(empty.line).toBe('Not recorded');
});

test('body markers follow the record, and a purchase inference only where nothing is recorded', () => {
  const marks = bodyMarkers(profile({
    conditions: [
      { code: 'HYPERTENSION', name: 'Hypertension', status: 'CONFIRMED_BY_PURCHASE' },
      { code: 'DIABETES', name: 'Diabetes', status: 'CONFIRMED_BY_PURCHASE' },
    ],
  }), {
    conditions: [{ id: 'c1', conditionName: 'Hypertension', verificationStatus: 'confirmed', localCode: 'HYPERTENSION' }],
  });
  const chest = marks.find((m) => m.region === 'chest');
  const abdomen = marks.find((m) => m.region === 'abdomen');
  // Recorded: named as recorded, with no "(from purchases)" beside it.
  expect(chest.note).toBe('Hypertension');
  // Not recorded: still marked, and still labelled for what it is.
  expect(abdomen.note).toBe('Diabetes (from purchases)');
});

test('the Tests card shows the last results, with abnormal or pending as the flag', () => {
  const tests = {
    counts: { all: 3, ordered: 1, pending: 0, completed: 2, abnormal: 1, historical: 0 },
    pending: 1,
    recent: [
      { id: 't1', testName: 'Fasting blood glucose', result: { value: 108, unit: 'mg/dL', interpretation: 'high' } },
      { id: 't2', testName: 'Malaria RDT', result: { value: 'Negative', unit: null, interpretation: 'negative' } },
    ],
  };
  const card1 = card(summaryCards(profile(), null, null, null, tests), 'results');
  expect(card1.title).toBe('Tests');
  expect(card1.count).toBe(3);
  expect(card1.items.map((i) => i.label)).toEqual(['Fasting blood glucose', 'Malaria RDT']);
  expect(card1.items[0].provenance).toBe('108 mg/dL high');
  expect(card1.flag).toBe('1 abnormal');
  expect(card1.tone).toBe('attention');

  // Nothing abnormal: the flag counts what is still waiting instead.
  const waiting = card(summaryCards(profile(), null, null, null, {
    counts: { all: 1, ordered: 1, abnormal: 0 }, pending: 1, recent: [],
  }), 'results');
  expect(waiting.flag).toBe('1 pending');

  // Not loaded: not recorded — never a count it could not read.
  expect(card(summaryCards(profile(), null), 'results').line).toBe('Not recorded');
});

// ---- Messages (§28), added with Messages phase 2 (0064) -------------------

const messagesCard = (messages) =>
  card(summaryCards(profile(), null, null, null, null, null, null, messages), 'messages');

test('the Messages card counts UNREAD, not how much history exists', () => {
  // A badge counting conversations tells a pharmacist how long this patient
  // has been a customer — which never changes and which nobody needs on a
  // summary. A badge counting unread tells them somebody is waiting for them.
  const c = messagesCard({
    counts: { all: 12, active: 1, archived: 11, unread: 2, awaitingPharmacist: 0 },
    lastContactAt: '2026-09-25T09:47:00Z',
  });
  expect(c.count).toBe(2);
  expect(c.flag).toBe('2 unread');
  expect(c.tone).toBe('attention');
  expect(c.at).toBe('2026-09-25T09:47:00Z');
  expect(c.tab).toBe('messages');
});

test('a patient waiting on a pharmacist outranks anything merely unread', () => {
  // Both are true; only one of them is about the patient rather than about
  // the reader.
  const c = messagesCard({
    counts: { all: 3, active: 1, archived: 2, unread: 5, awaitingPharmacist: 1 },
    lastContactAt: '2026-09-25T09:47:00Z',
  });
  expect(c.flag).toBe('1 waiting for a pharmacist');
  expect(c.tone).toBe('attention');
});

test('the Messages card tells "never messaged" from "nothing unread" from "not read"', () => {
  // Nobody has ever messaged this patient.
  expect(messagesCard({ counts: { all: 0, active: 0, archived: 0, unread: 0, awaitingPharmacist: 0 } }).line)
    .toBe('No messages');

  // There IS history and this reader has seen all of it. Saying "No messages"
  // here would tell a pharmacist the patient has never been in touch, which
  // would change what they say next.
  expect(messagesCard({ counts: { all: 8, active: 0, archived: 8, unread: 0, awaitingPharmacist: 0 } }).line)
    .toBe('Nothing unread');

  // The read failed, or never happened. Neither of the above is knowable.
  expect(messagesCard(null).line).toBe('Not recorded');
  expect(messagesCard(null).tone).toBe('unknown');
  expect(messagesCard({}).line).toBe('Not recorded');

  // And no count stands in for something unknown.
  expect(messagesCard(null).count).toBe(0);
  expect(messagesCard(null).flag).toBe(null);
});
