/**
 * The wording of the patient's Messages section.
 *
 * These are about claims, not formatting. Every one of them defends a
 * sentence that would be false if the code were slightly different, and a
 * false sentence here is a pharmacist believing a patient got a message they
 * never received, or that nobody is waiting when somebody is.
 */

import { test, expect } from 'vitest';
import {
  AUTHOR_LABEL, DELIVERY,
  deliveryLabel, didNotArrive, summaryParts, emptyText,
  timeLabel, dayLabel, lastActivityLabel, byDay, topicLine, stateLabel, previewLine,
  lagosToday, unreadLabel, linkLine, LINK_GONE, NO_LINKS,
  noteAuthor, INTERNAL_BANNER, PATIENT_BANNER, NO_INTERNAL_THREADS, NO_INTERNAL_HELP,
} from './messageFormat.js';

// §11 of the brief: "Do not make the AI appear to be a pharmacist."
test('the assistant is never labelled as a person', () => {
  expect(AUTHOR_LABEL.assistant).toBe('Assistant');
  expect(AUTHOR_LABEL.customer).toBe('Patient');
  for (const [author, label] of Object.entries(AUTHOR_LABEL)) {
    if (author === 'assistant') {
      expect(label).not.toMatch(/pharmacist|pharmacy|doctor|nurse|staff/i);
    }
  }
  // And the pharmacy is not labelled as the assistant either.
  expect(AUTHOR_LABEL.staff).not.toMatch(/assistant|bot|ai/i);
});

// §34: "Do not make a failed message appear as successfully delivered."
// §8: "Do not display delivery states that the underlying provider cannot
// actually verify."
test('a message we cannot confirm is not reported as sent', () => {
  const out = (deliveryStatus) => ({ direction: 'outbound', deliveryStatus });

  expect(deliveryLabel(out('delivered')).label).toBe('Delivered');
  expect(deliveryLabel(out('failed')).label).toBe('Not delivered');

  // The one that matters: no status came back. Not "Sent", not "Delivered",
  // not "Sending" — nothing, so the screen shows nothing.
  expect(deliveryLabel(out(null))).toBe(null);
  expect(deliveryLabel(out(undefined))).toBe(null);
  // A state the provider never reports cannot be rendered into a claim.
  expect(deliveryLabel(out('probably_fine'))).toBe(null);

  // The patient's own message has no delivery state — we did not send it.
  expect(deliveryLabel({ direction: 'inbound', deliveryStatus: 'read' })).toBe(null);
  expect(deliveryLabel(null)).toBe(null);
});

test('only a message that did NOT arrive is coloured, and it says so plainly', () => {
  expect(didNotArrive({ direction: 'outbound', deliveryStatus: 'failed' })).toBe(true);
  expect(didNotArrive({ direction: 'outbound', deliveryStatus: 'undelivered' })).toBe(true);
  expect(didNotArrive({ direction: 'outbound', deliveryStatus: 'delivered' })).toBe(false);
  expect(didNotArrive({ direction: 'inbound', deliveryStatus: null })).toBe(false);

  // A tick on every message is a tick nobody reads. Only the failures carry a
  // tone, so the one that needs attention is the one that gets it.
  const toned = Object.entries(DELIVERY).filter(([, v]) => v.tone);
  expect(toned.map(([k]) => k).sort()).toEqual(['failed', 'undelivered']);
});

test('the summary counts what is there, and says who is waiting first', () => {
  const parts = summaryParts({ all: 5, active: 1, archived: 4, awaitingPharmacist: 1 });
  expect(parts[0].id).toBe('waiting');
  // Amber. design.md gives red to a person waiting on a human AND says only
  // Consultations earns it, so this screen takes the next tone down rather
  // than diluting the one that means "drop everything".
  expect(parts[0].tone).toBe('ui-tone-1');
  expect(parts.map((p) => p.id)).toEqual(['waiting', 'active', 'archived']);

  // Nothing waiting: no red anywhere.
  const calm = summaryParts({ all: 4, active: 0, archived: 4, awaitingPharmacist: 0 });
  expect(calm.some((p) => p.tone)).toBe(false);
  expect(calm.map((p) => p.text)).toEqual(['4 in history']);

  expect(summaryParts(null)).toEqual([]);
});

// The distinction the follow-up card had to be FIXED to make on 2026-09-25 —
// a screen said "Nothing outstanding" about a patient who had never had one.
// Messages makes it from the start, and with three states rather than two.
test('"no messages" and "no active conversations" are different facts', () => {
  // Nobody has ever messaged this patient.
  expect(emptyText({ all: 0, active: 0, archived: 0 }, 'active').title).toBe('No messages');

  // There IS history — saying "No messages" here would tell a pharmacist this
  // patient has never been spoken to, which is false and would change what
  // they say next.
  const quiet = emptyText({ all: 9, active: 0, archived: 9 }, 'active');
  expect(quiet.title).toBe('No active conversations');
  expect(quiet.help).toMatch(/history/i);

  // There is something to show, so no empty state at all.
  expect(emptyText({ all: 9, active: 1, archived: 8 }, 'active')).toBe(null);

  // Not read. The caller says "Not recorded" its own way — this function must
  // not guess on its behalf.
  expect(emptyText(null)).toBe(null);
});

test('no empty state claims anything about the patient', () => {
  for (const counts of [{ all: 0, active: 0, archived: 0 }, { all: 3, active: 0, archived: 3 }]) {
    const e = emptyText(counts, 'active');
    expect(`${e.title} ${e.help}`).not.toMatch(/healthy|well|fine|no problems|nothing needed|all clear/i);
  }
});

test('the pharmacy clock is Lagos, not the browser\'s', () => {
  // 23:30 UTC is already tomorrow in Lagos. A message that arrived "today" in
  // the pharmacy must not be filed under yesterday because of the viewer.
  expect(lagosToday(new Date('2026-09-24T23:30:00Z'))).toBe('2026-09-25');
  expect(timeLabel('2026-09-24T23:30:00Z')).toBe('00:30');
  expect(timeLabel('2026-09-24T09:42:00Z')).toBe('10:42');
  expect(timeLabel('nonsense')).toBe(null);
});

test('a day heading says Today and Yesterday before it says a date', () => {
  const today = '2026-09-25';
  expect(dayLabel('2026-09-25T09:00:00Z', today)).toBe('Today');
  expect(dayLabel('2026-09-24T09:00:00Z', today)).toBe('Yesterday');
  expect(dayLabel('2026-09-20T09:00:00Z', today)).toBe('20 Sept 2026');
  expect(lastActivityLabel('2026-09-25T09:42:00Z', today)).toBe('Today · 10:42');
});

test('a transcript is grouped by day, oldest first', () => {
  // A conversation read from the bottom is a conversation misread.
  const days = byDay([
    { id: '1', at: '2026-09-20T09:00:00Z' },
    { id: '2', at: '2026-09-20T10:00:00Z' },
    { id: '3', at: '2026-09-25T08:00:00Z' },
  ], '2026-09-25');

  expect(days.map((d) => d.label)).toEqual(['20 Sept 2026', 'Today']);
  expect(days[0].messages.map((m) => m.id)).toEqual(['1', '2']);
  expect(days[1].messages.map((m) => m.id)).toEqual(['3']);
  expect(byDay([], '2026-09-25')).toEqual([]);
  expect(byDay(null, '2026-09-25')).toEqual([]);
});

// 0063 deliberately gave `topic` no default, so a thread nobody labelled says
// nobody labelled it — the "None" on an allergy card nobody was asked about.
test('an unlabelled conversation says so, and is never called "General"', () => {
  expect(topicLine({ topicLabel: 'Medication review' })).toBe('Medication review');
  expect(topicLine({ topicLabel: null })).toBe('Not labelled');
  expect(topicLine({ topicLabel: null })).not.toBe('General');
  expect(topicLine(null)).toBe(null);
});

test('a thread waiting on a pharmacist says that before anything else about it', () => {
  // It is simultaneously open, in human mode and waiting. Only one of those
  // means somebody has not been answered.
  expect(stateLabel({ status: 'open', mode: 'human', awaitingPharmacist: true }))
    .toEqual({ text: 'Waiting for a pharmacist', tone: 'ui-tone-1' });

  expect(stateLabel({ status: 'open', mode: 'bot', awaitingPharmacist: false }).text)
    .toBe('Assistant is replying');
  expect(stateLabel({ status: 'open', mode: 'human', awaitingPharmacist: false }).text)
    .toBe('A person is replying');
  expect(stateLabel({ status: 'closed', mode: 'bot', awaitingPharmacist: false }).text)
    .toBe('Closed');
});

test('the preview says who spoke last without pretending the assistant is staff', () => {
  expect(previewLine({ lastMessage: { body: 'I will come tomorrow.', author: 'customer', direction: 'inbound' } }))
    .toBe('I will come tomorrow.');
  expect(previewLine({ lastMessage: { body: 'Your refill is ready.', author: 'staff', direction: 'outbound' } }))
    .toBe('Pharmacy: Your refill is ready.');
  // The assistant's last word is labelled as the assistant's, in the list as
  // well as in the transcript.
  expect(previewLine({ lastMessage: { body: 'Let me check that.', author: 'assistant', direction: 'outbound' } }))
    .toBe('Assistant: Let me check that.');
  expect(previewLine({ lastMessage: null })).toBe(null);
  expect(previewLine(null)).toBe(null);
});

// ---- phase 2 -------------------------------------------------------------

test('unread outranks the plain counts, and never outranks somebody waiting', () => {
  // Two different facts: "a person has not been answered" and "you have not
  // looked". The first is about the patient and comes first.
  const both = summaryParts({ all: 5, active: 1, archived: 4, unread: 3, awaitingPharmacist: 1 });
  expect(both.map((p) => p.id)).toEqual(['waiting', 'unread', 'active', 'archived']);

  const justUnread = summaryParts({ all: 5, active: 1, archived: 4, unread: 3, awaitingPharmacist: 0 });
  expect(justUnread.map((p) => p.id)).toEqual(['unread', 'active', 'archived']);
  expect(justUnread[0].text).toBe('3 unread');

  // Nothing unread is not a part at all. A "0 unread" chip is a chip people
  // learn to ignore, which costs the badge its meaning when it matters.
  const read = summaryParts({ all: 5, active: 1, archived: 4, unread: 0, awaitingPharmacist: 0 });
  expect(read.map((p) => p.id)).toEqual(['active', 'archived']);
});

test('an unread badge appears only when there is something to read', () => {
  expect(unreadLabel(2)).toBe('2 unread');
  expect(unreadLabel(0)).toBe(null);
  expect(unreadLabel(null)).toBe(null);
  expect(unreadLabel(undefined)).toBe(null);
});

// §13: the label comes from the section that OWNS the record. Messages stores
// a kind and an id, so it cannot show a stale dose or an old result.
test('a linked record is described by its own section, never by Messages', () => {
  const line = linkLine({
    kind: 'medication',
    kindLabel: 'Medication',
    refId: 'abc',
    record: { label: 'Amlodipine 10 mg', detail: 'active' },
  });
  expect(line).toEqual({ kind: 'Medication', label: 'Amlodipine 10 mg', detail: 'active', gone: false });
});

test('a record deleted from its own section says so rather than vanishing', () => {
  // A row that disappeared would lose that the conversation was ever about
  // it. "No longer on the record" is true and keeps the history.
  const line = linkLine({ kind: 'vitals', kindLabel: 'Vitals reading', refId: 'abc', record: null });
  expect(line.gone).toBe(true);
  expect(line.label).toBe(LINK_GONE);
  expect(line.label).toBe('No longer on the record');
  // It still says WHAT KIND it was, which is the useful part of a dead link.
  expect(line.kind).toBe('Vitals reading');
  expect(linkLine(null)).toBe(null);
});

test('nothing attached says nothing attached, and claims nothing about the patient', () => {
  expect(NO_LINKS).toBe('Nothing attached');
  expect(NO_LINKS).not.toMatch(/healthy|well|fine|no problems|nothing wrong/i);
});

// ---- phase 3: internal threads (§14) --------------------------------------

// The single most important sentence in this module. §14: "Internal messages
// must never become visible to the patient", and "The UI should make this
// distinction obvious."
test('an internal thread says in words that the patient cannot see it', () => {
  expect(INTERNAL_BANNER).toBe('Internal — the patient cannot see this');
  // It names the patient's inability explicitly rather than just labelling
  // the thread "internal" — a word a hurried reader can skim past.
  expect(INTERNAL_BANNER).toMatch(/patient cannot see/i);
  // And it is TEXT, not a colour. A pharmacist reading this printed, or
  // colour-blind, gets the same warning.
  expect(INTERNAL_BANNER.length).toBeGreaterThan(10);

  expect(PATIENT_BANNER).toBe('With the patient');
  expect(PATIENT_BANNER).not.toMatch(/internal/i);
});

test('an internal note names who wrote it, and "You" for your own', () => {
  // A thread where every note shows the same address is a thread nobody can
  // scan; colleagues read these, so who said it is the point.
  expect(noteAuthor({ mine: true, authorEmail: 'pharm.ade@rxnaija.local' })).toBe('You');
  expect(noteAuthor({ mine: false, authorEmail: 'pharm.ade@rxnaija.local' })).toBe('pharm.ade');
  // Written before we recorded authors, or by somebody since removed.
  expect(noteAuthor({ mine: false, authorEmail: null })).toBe('A colleague');
  expect(noteAuthor(null)).toBe(null);
});

test('the empty internal view explains what it is for, and claims nothing clinical', () => {
  expect(NO_INTERNAL_THREADS).toBe('No internal threads');
  expect(NO_INTERNAL_HELP).toMatch(/nothing here reaches the patient/i);
  expect(`${NO_INTERNAL_THREADS} ${NO_INTERNAL_HELP}`)
    .not.toMatch(/healthy|well|fine|no problems|nothing wrong/i);
});

test('an internal thread never borrows the words for a patient conversation', () => {
  // "A person is replying" and "the assistant is replying" are both about who
  // answers the PATIENT. Neither is true of a staff-to-staff thread, and
  // saying one is the blurring §14 exists to prevent.
  expect(stateLabel({ channel: 'internal', status: 'open', mode: 'human', awaitingPharmacist: false })).toBe(null);
  expect(stateLabel({ channel: 'internal', status: 'closed', mode: 'human', awaitingPharmacist: false }))
    .toEqual({ text: 'Closed', tone: null });

  // Even if an internal row somehow carried the patient-facing flags, the
  // channel decides — the words follow the KIND of thread, not the columns.
  expect(stateLabel({ channel: 'internal', status: 'open', mode: 'bot', awaitingPharmacist: true })).toBe(null);

  // And the patient-facing wording is untouched.
  expect(stateLabel({ channel: 'whatsapp', status: 'open', mode: 'bot', awaitingPharmacist: false }).text)
    .toBe('Assistant is replying');
});
