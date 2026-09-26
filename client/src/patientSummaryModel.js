/**
 * The patient summary, as data.
 *
 * PURE — takes the profile payload (GET /api/customers/:id) and the care
 * payload (GET /api/customers/:id/care) and returns one entry per section of
 * the record: a heading, the few items worth showing, a count, and the tab it
 * opens. No React, no fetch, so the wording is testable, which matters more
 * here than usual: these lines are read as statements about a person.
 *
 * SHORT, BECAUSE A SUMMARY THAT IS READ IS THE POINT (amended 2026-09-20 at
 * the owner's request). An earlier version wrote a sentence per section —
 * "1 condition confirmed from purchase history", then "Hypertension", then a
 * "From purchases" tag under it — which said the same thing three times and
 * made a column of eight sections unreadable. Now the section shows its
 * count and its items, and nothing else.
 *
 * TWO RULES SURVIVE THE TRIM, because they are not decoration:
 *
 * 1. NOTHING IS INVENTED. A section the pharmacy has no data for says
 *    "Not recorded", never "None" — "no allergies recorded" and "no
 *    allergies" are different claims, and only one is true here. An empty
 *    Allergies line reading "None" is how a pharmacist is told someone is
 *    safe to give penicillin to by a system that has never been told
 *    otherwise. Two words carry that, so brevity costs nothing.
 *
 * 2. THE SOURCE STILL TRAVELS WITH THE CLAIM, as `provenance` on the item.
 *    It is no longer printed beside every row — it is the item's tooltip,
 *    and the section it opens states it in full. A condition in this product
 *    is confirmed by PURCHASE HISTORY, not by a doctor, and that fact must
 *    remain reachable from wherever the condition is named.
 */

import { displayName } from './conditionFormat.js';
import { countsLine, EMPTY_TEXT as CARE_EMPTY } from './carePlanFormat.js';
import {
  outstandingCount, dueLabel, lagosToday, emptyText as followupEmptyText,
} from './followupFormat.js';

/** Conditions, to the part of the body a marker belongs on. */
const CONDITION_REGION = Object.freeze({
  HYPERTENSION: 'chest',
  DIABETES: 'abdomen',
  ASTHMA: 'chest',
  // The engine's and the problem list's house code for asthma is this one;
  // ASTHMA above never matched anything the engine produces.
  ASTHMA_OR_COPD: 'chest',
});

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Two words, or none. The empty state of a section nobody has filled in. */
const NOT_RECORDED = 'Not recorded';

/**
 * Entries for the record's sections, in the order they are read.
 *
 * `count` is what the header shows. `line` appears ONLY when there is
 * nothing to list — a section with items does not also need a sentence
 * counting them.
 */
/**
 * The Allergies card, from the allergy record (0058).
 *
 * `allergies` absent — not loaded, or it failed — keeps rule 1's
 * "Not recorded": the summary must not guess. Loaded, it speaks the record's
 * three states, and "No known allergies" appears ONLY when a pharmacist
 * recorded it. An empty record is "Not assessed", never "None".
 */
function allergiesCard(allergies) {
  const base = { id: 'allergies', title: 'Allergies', tab: 'allergies' };
  if (!allergies || !allergies.state) {
    return { ...base, count: 0, line: NOT_RECORDED, items: [], tone: 'unknown' };
  }
  if (allergies.state === 'known') {
    const list = allergies.allergies || [];
    const high = list.filter((a) => a.criticality === 'high').length;
    return {
      ...base,
      count: list.length,
      line: null,
      items: list.slice(0, 5).map((a) => ({
        id: a.id,
        label: a.allergenName,
        provenance: a.verificationStatus === 'confirmed' ? 'Confirmed' : 'Unconfirmed',
      })),
      flag: high ? 'High criticality' : null,
      tone: 'attention',
    };
  }
  if (allergies.state === 'none_known') {
    return { ...base, count: 0, line: 'No known allergies', items: [], tone: 'normal' };
  }
  return { ...base, count: 0, line: 'Not assessed', items: [], tone: 'unknown' };
}

/**
 * The Conditions card, from the problem list (0059) when it is loaded.
 *
 * Recorded current conditions are the items, named the way the Conditions
 * tab names them ("Possible asthma" for a provisional one). The purchase
 * inference is NOT listed as a condition: it is counted in the flag,
 * "N suggested by purchases", and lives in the tab's labelled block.
 * `problems` absent — not loaded, or failed — keeps the older
 * purchase-based card below, unchanged.
 */
function recordedConditionsCard(problems) {
  const current = problems.conditions || [];
  const suggested = (problems.suggestions || []).length;
  return {
    id: 'conditions',
    title: 'Conditions',
    tab: 'conditions',
    count: current.length,
    line: current.length ? null : NOT_RECORDED,
    items: current.map((c) => ({
      id: c.id,
      label: displayName(c),
      provenance: c.verificationStatus === 'confirmed' ? 'Confirmed' : `${c.verificationStatus[0].toUpperCase()}${c.verificationStatus.slice(1)} — not confirmed`,
    })),
    flag: suggested ? `${suggested} suggested by purchases` : null,
    tone: current.length ? 'normal' : 'unknown',
  };
}

/**
 * The Tests card, from the test record (0060) when it is loaded.
 *
 * The last few reported tests by name, the ones still awaiting a result as
 * the flag, and nothing invented: `tests` absent keeps "Not recorded".
 */
function testsCard(tests) {
  const base = { id: 'results', title: 'Tests', tab: 'results' };
  if (!tests || !tests.counts) {
    return { ...base, count: 0, line: NOT_RECORDED, items: [], tone: 'unknown' };
  }
  const recent = tests.recent || [];
  const waiting = tests.pending || 0;
  return {
    ...base,
    count: tests.counts.all || 0,
    line: tests.counts.all ? null : NOT_RECORDED,
    items: recent.map((t) => ({
      id: t.id,
      label: t.testName,
      provenance: t.result
        ? [t.result.value, t.result.unit, t.result.interpretation].filter(Boolean).join(' ')
        : 'Awaiting a result',
    })),
    flag: tests.counts.abnormal ? `${tests.counts.abnormal} abnormal` : waiting ? `${waiting} pending` : null,
    tone: tests.counts.abnormal ? 'attention' : 'normal',
  };
}

/**
 * The Care program card, from the care-programme record (0061).
 *
 * "No care programmes" is safe to say here, unlike "no allergies": whether
 * somebody was enrolled is a fact this system holds completely — nobody can be
 * in a programme it has not been told about. What it never says is anything
 * about the patient, so there is no percentage and no score, only what is open
 * and what is late.
 */
function careCard(carePrograms) {
  const base = { id: 'care', title: 'Care program', tab: 'care' };
  // Not loaded, or it failed: rule 1 — say nothing rather than "none".
  if (!carePrograms || !carePrograms.counts) {
    return { ...base, count: 0, line: NOT_RECORDED, items: [], tone: 'unknown' };
  }
  const { counts } = carePrograms;
  const active = carePrograms.active || [];
  const overdue = counts.overdueTasks || 0;
  const review = counts.dueForReview || 0;
  return {
    ...base,
    count: counts.active || 0,
    line: counts.active ? null : CARE_EMPTY.noPrograms,
    items: active.map((p) => ({
      id: p.id,
      label: p.programName,
      // Counts, never a percentage — the same rule the section itself holds,
      // through the same function, so the two cannot drift apart.
      provenance: countsLine(p),
    })),
    flag: overdue ? plural(overdue, 'task') + ' overdue' : review ? `${review} due for review` : null,
    tone: overdue || review ? 'attention' : 'normal',
  };
}

/**
 * The Follow-up card, from the patient's action queue (0062).
 *
 * WHAT IS OUTSTANDING, not what has ever been done: a completed follow-up is
 * history, and the section holds it. "No follow-ups" is safe to say once the
 * record has been read — a follow-up this system was never told about cannot
 * exist — and it still says nothing about the patient's health.
 */
function followupCard(followups) {
  const base = { id: 'followup', title: 'Follow-up', tab: 'followup' };
  // Not loaded, or it failed: rule 1 — say nothing rather than "none".
  if (!followups || !followups.counts) {
    return { ...base, count: 0, line: NOT_RECORDED, items: [], tone: 'unknown' };
  }
  const { counts } = followups;
  const open = outstandingCount(counts);
  const overdue = counts.overdue || 0;
  const today = lagosToday();
  return {
    ...base,
    count: open,
    line: followupEmptyText(counts),
    items: (followups.next || []).map((f) => ({
      id: f.id,
      label: f.title,
      // When it is due, in the words the queue itself uses.
      provenance: dueLabel(f, today),
    })),
    // The one thing worth acting on, and only when it is true.
    flag: overdue ? `${overdue} overdue` : counts.today ? `${counts.today} due today` : null,
    tone: overdue || counts.today ? 'attention' : 'normal',
  };
}

/**
 * Messages (§28): unread first, then when anybody last spoke.
 *
 * The count is UNREAD, not the number of conversations. A badge counting
 * threads tells a pharmacist how much history exists, which never changes and
 * which nobody needs on a summary; a badge counting unread tells them
 * somebody is waiting for THEM. Three states told apart, as everywhere else:
 * the read failed ("Not recorded"), nobody has ever messaged ("No messages"),
 * and everything has been read ("Nothing unread").
 */
function messagesCard(messages) {
  const base = { id: 'messages', title: 'Messages', tab: 'messages' };
  if (!messages || !messages.counts) {
    // `flag: null` explicitly, so the card has ONE shape whichever branch
    // produced it — a key that is sometimes absent is a key every consumer
    // has to remember might be.
    return { ...base, count: 0, line: NOT_RECORDED, items: [], flag: null, tone: 'unknown' };
  }
  const { counts } = messages;
  const unread = counts.unread || 0;
  return {
    ...base,
    count: unread,
    line: unread ? null : (counts.all ? 'Nothing unread' : 'No messages'),
    items: [],
    // Somebody has not been answered. That outranks "you have not looked".
    flag: counts.awaitingPharmacist
      ? `${counts.awaitingPharmacist} waiting for a pharmacist`
      : (unread ? `${unread} unread` : null),
    tone: counts.awaitingPharmacist || unread ? 'attention' : 'normal',
    at: messages.lastContactAt || null,
  };
}

export function summaryCards(profile, care, allergies = null, problems = null, tests = null, carePrograms = null, followups = null, messages = null) {
  if (!profile) return [];
  const conditions = profile.conditions || [];
  const confirmed = conditions.filter((c) => c.status === 'CONFIRMED_BY_PURCHASE');
  const journeys = profile.medicationJourneys || [];
  const active = journeys.filter((j) => j.status === 'active');
  const refills = profile.refills || {};
  const due = (refills.due || 0) + (refills.overdue || 0) + (refills.lapsed || 0);
  const clinical = profile.clinical || {};

  return [
    problems ? recordedConditionsCard(problems) : {
      id: 'conditions',
      title: 'Conditions',
      tab: 'conditions',
      count: confirmed.length,
      line: confirmed.length ? null : NOT_RECORDED,
      items: confirmed.map((c) => ({
        id: c.code,
        label: c.name,
        // Not printed. The tooltip, and the reason the Conditions section
        // exists to be opened.
        provenance: 'Confirmed from purchase history, not a diagnosis',
      })),
      tone: confirmed.length ? 'normal' : 'unknown',
    },
    {
      id: 'meds',
      title: 'Meds',
      tab: 'meds',
      count: active.length,
      line: active.length ? null : NOT_RECORDED,
      items: active.slice(0, 5).map((j) => ({
        id: j.id,
        label: j.medicineName,
        provenance: j.daysSupply ? `${j.daysSupply} days supply` : null,
      })),
      // The one word a pharmacist has to act on, and only when true.
      flag: due ? plural(due, 'refill due') : null,
      tone: due ? 'attention' : 'normal',
    },
    // NOT "none". See rule 1 above — this is the card that rule is for.
    allergiesCard(allergies),
    {
      id: 'vitals', title: 'Vitals & biometrics', tab: 'vitals', count: 0, line: NOT_RECORDED, items: [], tone: 'unknown',
    },
    testsCard(tests),
    {
      // Consultations are the CLINICAL module's record, not a section of the
      // patient record (2026-09-24). The card still counts them and still
      // flags a danger sign — that is worth seeing on a patient's summary —
      // but it opens the Consultations desk, because that is where they live.
      // A card names a record section (tab) or a module screen (module).
      id: 'encounters',
      title: 'Consultations',
      tab: null,
      module: 'consultations',
      count: clinical.encounters || 0,
      line: clinical.encounters ? null : NOT_RECORDED,
      items: [],
      flag: clinical.redFlagEncounters ? 'Danger sign' : null,
      tone: clinical.redFlagEncounters ? 'attention' : 'normal',
      at: clinical.lastEncounterAt || null,
    },
    careCard(carePrograms),
    followupCard(followups),
    messagesCard(messages),
  ];
}

/**
 * Where to put a marker on the figure, and what it says.
 *
 * Only what is genuinely recorded, and only where this product knows the
 * anatomy: a condition whose code is not in CONDITION_REGION gets no marker
 * at all rather than a guessed one. A dot on a body is read as a finding,
 * and a dot in the wrong place is worse than no dot.
 */
export function bodyMarkers(profile, problems = null) {
  if (!profile) return [];
  const byRegion = new Map();
  const add = (region, note, tab) => {
    if (!region) return;
    const existing = byRegion.get(region);
    byRegion.set(region, existing ? { ...existing, note: `${existing.note}; ${note}` } : { region, note, tab });
  };

  const recordedCodes = new Set();
  for (const c of problems?.conditions || []) {
    if (c.localCode) recordedCodes.add(c.localCode);
    add(CONDITION_REGION[c.localCode], displayName(c), 'conditions');
  }
  for (const c of profile.conditions || []) {
    if (c.status !== 'CONFIRMED_BY_PURCHASE' || recordedCodes.has(c.code)) continue;
    add(CONDITION_REGION[c.code], `${c.name} (from purchases)`, 'conditions');
  }
  // A danger sign is not anatomical — the consultation recorded it, not a
  // body part — so it marks the head, which is where the conversation was.
  if (profile.clinical?.redFlagEncounters) {
    add('head', `${plural(profile.clinical.redFlagEncounters, 'consultation')} with a danger sign`, 'encounters');
  }
  return [...byRegion.values()];
}

/**
 * The identity line under the name: age and sex.
 *
 * No "As reported" / "From date of birth" note any more (owner, 2026-09-20).
 * Where the age came from is a question for the field that edits it — which
 * is directly below on the same screen and says so — not a caption under
 * every record's first line.
 */
export function identityLine(care) {
  if (!care) return [];
  return [
    { id: 'age', text: care.ageYears != null ? `${care.ageYears} years` : 'Age not recorded' },
    { id: 'sex', text: care.sex ? care.sex[0].toUpperCase() + care.sex.slice(1) : 'Sex not recorded' },
  ];
}
