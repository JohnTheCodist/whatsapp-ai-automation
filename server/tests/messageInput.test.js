/**
 * The patient Messages contract — no database, so it always runs.
 *
 * What these defend: the Messages section is a VIEW of the oldest and most
 * load-bearing tables in this product. The things that can go wrong here are
 * not arithmetic, they are claims — a delivery state the provider never
 * reported, a topic invented for a thread nobody labelled, a button offering
 * to do something this phase cannot do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TOPICS, TOPIC_IDS, FILTERS, AUTHORS, DELIVERY_STATES,
  LINK_KINDS, LINK_KIND_IDS, CHANNELS, CHANNEL_IDS,
  readListQuery, readTopicInput, readLinkInput,
  readInternalThreadInput, readInternalNoteInput,
  topicLabel, linkKindLabel, messageOptions,
} = require('../services/messaging/messageInput');

// §12 of the brief lists the topics. They are a fixed vocabulary because a
// free-text topic is a second name for every thread and nothing can filter
// by it.
test('the topics are a fixed list, and every one of them has a label to show', () => {
  assert.ok(TOPICS.length >= 9);
  for (const t of TOPICS) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.label, 'string');
    assert.ok(t.label.length > 0, `${t.id} has no label`);
    // Machine values are snake_case ids; the label is what a person reads.
    assert.match(t.id, /^[a-z_]+$/);
  }
  assert.equal(new Set(TOPIC_IDS).size, TOPIC_IDS.length, 'a topic id appears twice');
  assert.equal(topicLabel('medication_review'), 'Medication review');
  // A topic this product does not use has no label, rather than a made-up one.
  assert.equal(topicLabel('astrology'), null);
  assert.equal(topicLabel(null), null);
});

// MESSAGES_PLAN.md §6: there is no appointments table, so a topic may LABEL a
// conversation about an appointment but nothing may claim to open one.
// Keeping the label is the owner-facing half; the test exists so that a later
// change adding a "View appointment" button has to come past this comment.
test('a topic is a label and never a promise that a record exists', () => {
  assert.ok(TOPIC_IDS.includes('appointment'), 'patients discuss appointments either way');
  for (const t of TOPICS) {
    assert.ok(!('href' in t) && !('link' in t) && !('recordType' in t),
      `${t.id} carries a link target — a topic organises, it does not resolve`);
  }
});

test('the only two states a thread has are the two the database has', () => {
  // 0023 gave conversations `status` open|closed. "Active" and "Archived" in
  // the brief are those two under the names a pharmacist uses, and inventing
  // a third here would be a state nothing writes — the exact bug 0023 fixed
  // when `mode` carried a 'closed' value nobody ever set.
  assert.deepEqual([...FILTERS], ['active', 'archived', 'all']);
});

test('who said it is the four authors the messages table has carried since 0001', () => {
  // §11: the patient is talking to the assistant or to a person, and the
  // screen must never render one as the other. This is the vocabulary that
  // makes that possible, and it is not this module's to widen.
  assert.deepEqual([...AUTHORS], ['customer', 'assistant', 'staff', 'system']);
});

// §8: "Do not display delivery states that the underlying provider cannot
// actually verify." A state this list invents is a claim about whether a
// patient received something.
test('the delivery states are the provider\'s own, and none is invented', () => {
  assert.deepEqual([...DELIVERY_STATES],
    ['queued', 'sent', 'delivered', 'read', 'failed', 'undelivered']);
  for (const bad of ['seen', 'pending', 'probably_delivered', 'ok']) {
    assert.ok(!DELIVERY_STATES.includes(bad), `${bad} is not something the provider reports`);
  }
});

test('the list query defaults to what is active, and refuses a filter it cannot honour', () => {
  assert.deepEqual(readListQuery({}), {
    filter: 'active', topic: null, q: null, channel: 'whatsapp',
  });
  assert.equal(readListQuery({ filter: 'ARCHIVED' }).filter, 'archived');
  assert.equal(readListQuery({ filter: 'all' }).filter, 'all');

  // A bad filter must not quietly widen the list to everything — a pharmacist
  // who asked for one patient's active threads and got every thread would not
  // know they were reading the wrong thing.
  assert.throws(() => readListQuery({ filter: 'everything' }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.field, 'filter');
    return true;
  });
  assert.throws(() => readListQuery({ topic: 'astrology' }), (e) => {
    assert.equal(e.field, 'topic');
    return true;
  });
});

test('a blank search is no search, and a very long one cannot become the query', () => {
  // An empty box matching every message is how a search feels broken.
  assert.equal(readListQuery({ q: '   ' }).q, null);
  assert.equal(readListQuery({ q: '  dizziness ' }).q, 'dizziness');
  assert.equal(readListQuery({ q: 'x'.repeat(500) }).q.length, 200);
});

test('a topic can be cleared, because a wrong label must be removable', () => {
  assert.deepEqual(readTopicInput({ topic: 'medication' }), { topic: 'medication' });
  assert.deepEqual(readTopicInput({ topic: null }), { topic: null });
  assert.deepEqual(readTopicInput({ topic: '' }), { topic: null });

  // Saying nothing at all is not the same as saying "no topic" — one is a
  // malformed request, the other is a decision.
  assert.throws(() => readTopicInput({}), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.field, 'topic');
    return true;
  });
  assert.throws(() => readTopicInput({ topic: 'astrology' }), (e) => {
    assert.equal(e.field, 'topic');
    return true;
  });
});

// MESSAGES_PLAN.md §11: phase 1 has no way to start a conversation, no
// attachments and no internal threads. The screen is told so rather than
// deciding for itself, because a button that cannot work is worse than no
// button — and because when phase 3 builds them, this is the line that has to
// change and the screen follows.
test('the screen is told what this phase cannot do, rather than guessing', () => {
  const { capabilities } = messageOptions();
  // STILL FALSE, and the most important value in this file: this product is
  // strictly reactive and does not message a patient first. Phase 3 built
  // internal threads (0066) and changed nothing about that, because an
  // internal thread never leaves the pharmacy and so is not outreach.
  assert.equal(capabilities.canStartConversation, false);
  assert.equal(capabilities.canSendAttachment, false);
  // Changed with the product in phase 3. Was false through phases 1 and 2.
  assert.equal(capabilities.internalThreads, true);
  assert.equal(capabilities.canStartInternalThread, true);
});

test('the options carry everything the controls need, and no way to send', () => {
  const opts = messageOptions();
  assert.equal(opts.topics.length, TOPICS.length);
  assert.deepEqual(opts.filters, FILTERS);
  // Nothing in this contract describes sending. The one send path is
  // routes/conversations.js, and a second one is what §36 forbids.
  assert.ok(!JSON.stringify(opts).match(/send_url|composer|sendPath/i));
});

// ---- phase 2: the clinical context (§13) ----------------------------------

test('a conversation can only point at kinds something can actually open', () => {
  // A kind this list invents is a link the screen draws and nothing resolves.
  // Every one of these must be resolvable by clinicalRefs for a patient.
  const { RESOLVABLE } = require('../services/clinical/clinicalRefs');
  for (const k of LINK_KIND_IDS) {
    assert.ok(RESOLVABLE.includes(k), `${k} is offered as a link but names no record`);
  }
  assert.equal(new Set(LINK_KIND_IDS).size, LINK_KIND_IDS.length);
  for (const k of LINK_KINDS) assert.ok(k.label && k.label.length > 0);
  assert.equal(linkKindLabel('vitals'), 'Vitals reading');
  assert.equal(linkKindLabel('astrology'), null);
});

// MESSAGES_PLAN.md §6, and the brief's §24/§39. There is no appointments
// table, so an "appointment" link would draw a button that opens nothing.
// The TOPIC may say appointment — a label organises — but a LINK claims a
// record exists, and that is a different promise.
test('there is no appointment link, because there is no appointment record', () => {
  assert.ok(!LINK_KIND_IDS.includes('appointment'));
  assert.ok(TOPIC_IDS.includes('appointment'), 'the label is still allowed');
});

test('a link carries a pointer and NEVER a copy of what the record says', () => {
  // §13: "Do NOT duplicate those clinical records inside Messages. Store
  // references to them." A name or a value copied in here would still be
  // showing the old one after the record changed.
  const link = readLinkInput({
    kind: 'medication',
    refId: '11111111-2222-3333-4444-555555555555',
    note: 'She asked whether the dose had changed',
    // Everything below is the caller trying to tell us what the record says.
    name: 'Amlodipine 10 mg',
    dose: '10 mg',
    result: '7.8%',
    status: 'active',
  });
  assert.deepEqual(Object.keys(link).sort(), ['kind', 'note', 'refId']);
  assert.equal(link.kind, 'medication');
  assert.equal(link.refId, '11111111-2222-3333-4444-555555555555');
});

test('attaching needs a kind this product knows and an id shaped like a record', () => {
  assert.throws(() => readLinkInput({ kind: 'astrology', refId: '11111111-2222-3333-4444-555555555555' }),
    (e) => { assert.equal(e.status, 400); assert.equal(e.field, 'kind'); return true; });
  // An id that is not an id would reach the database as a cast error rather
  // than a sentence a pharmacist can act on.
  assert.throws(() => readLinkInput({ kind: 'vitals', refId: 'the second one' }),
    (e) => { assert.equal(e.field, 'refId'); return true; });
  assert.throws(() => readLinkInput({ kind: 'vitals' }),
    (e) => { assert.equal(e.field, 'refId'); return true; });
  // A note is optional, and an empty one is absent rather than ''.
  assert.equal(readLinkInput({ kind: 'vitals', refId: '11111111-2222-3333-4444-555555555555' }).note, null);
  assert.throws(() => readLinkInput({ kind: 'vitals', refId: '11111111-2222-3333-4444-555555555555', note: 'x'.repeat(301) }),
    (e) => { assert.equal(e.field, 'note'); return true; });
});

// The brief's §23: a message can RESULT in a follow-up, and the follow-up
// should record where it came from. 0065 widened the task source vocabulary
// for exactly this, and nothing here creates one automatically.
test('a follow-up can say a conversation raised it', () => {
  const { SOURCE_TYPES, SOURCE_WITH_RECORD, readFollowupInput } = require('../services/clinical/followupInput');
  assert.ok(SOURCE_TYPES.some((s) => s.value === 'conversation'));
  assert.ok(SOURCE_WITH_RECORD.includes('conversation'),
    'a conversation names a specific thread, so it must be checked like one');

  const f = readFollowupInput({
    title: 'Repeat blood pressure',
    dueOn: '2026-10-02',
    sourceType: 'conversation',
    sourceId: '11111111-2222-3333-4444-555555555555',
  });
  assert.equal(f.sourceType, 'conversation');
  assert.equal(f.sourceId, '11111111-2222-3333-4444-555555555555');
});

// ---- phase 3: internal threads (§14) --------------------------------------

test('a thread is one of two KINDS, and the patient\'s is the default', () => {
  assert.deepEqual([...CHANNEL_IDS], ['whatsapp', 'internal']);
  for (const c of CHANNELS) assert.ok(c.label && c.label.length > 0);

  // "Messages" on a patient record means communication WITH the patient. An
  // internal thread appearing there by default is the failure §14 is about.
  assert.equal(readListQuery({}).channel, 'whatsapp');
  assert.equal(readListQuery({ channel: 'internal' }).channel, 'internal');
  assert.equal(readListQuery({ channel: 'all' }).channel, 'all');

  assert.throws(() => readListQuery({ channel: 'sms' }), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.field, 'channel');
    return true;
  });
});

test('an internal thread needs a subject somebody can find it by, and a first note', () => {
  const t = readInternalThreadInput({ subject: 'Dose query before dispensing', note: 'Prescriber wrote 10mg; pack is 5mg.' });
  assert.equal(t.subject, 'Dose query before dispensing');
  assert.equal(t.note, 'Prescriber wrote 10mg; pack is 5mg.');
  assert.equal(t.topic, null);

  // A thread called nothing is a thread nobody finds again.
  assert.throws(() => readInternalThreadInput({ note: 'something' }),
    (e) => { assert.equal(e.field, 'subject'); return true; });
  assert.throws(() => readInternalThreadInput({ subject: '   ', note: 'x' }),
    (e) => { assert.equal(e.field, 'subject'); return true; });
  // And an empty thread says nothing to the colleague it was started for.
  assert.throws(() => readInternalThreadInput({ subject: 'Dose query' }),
    (e) => { assert.equal(e.field, 'note'); return true; });

  assert.throws(() => readInternalThreadInput({ subject: 'x'.repeat(121), note: 'y' }),
    (e) => { assert.equal(e.field, 'subject'); return true; });
});

test('a note cannot be empty, and carries no route to a patient', () => {
  assert.deepEqual(readInternalNoteInput({ note: '  Rang the prescriber  ' }), { note: 'Rang the prescriber' });
  // The screen's textarea may send `text`; both names mean the same note.
  assert.deepEqual(readInternalNoteInput({ text: 'Rang the prescriber' }), { note: 'Rang the prescriber' });
  assert.throws(() => readInternalNoteInput({ note: '   ' }),
    (e) => { assert.equal(e.field, 'note'); return true; });

  // Nothing in the contract lets a caller say where a note goes. An internal
  // note has no recipient outside this pharmacy, and no shape here implies one.
  const parsed = readInternalNoteInput({ note: 'hello', to: '2348000000001', channel: 'whatsapp', send: true });
  assert.deepEqual(Object.keys(parsed), ['note']);
});
