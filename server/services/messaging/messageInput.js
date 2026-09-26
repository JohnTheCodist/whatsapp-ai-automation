/**
 * What a request to the patient Messages screen may say — the whole contract,
 * with no database in it.
 *
 * See MESSAGES_PLAN.md. This module exists for the reason `followupInput` and
 * `problemInput` exist: the screen sends strings, the service needs values it
 * can trust, and the place that converts one to the other should be testable
 * without fixtures.
 *
 * IT DESCRIBES A VIEW, NOT A SEND. Messages adds no way to send a message and
 * no way to start a conversation — replying and archiving go through the
 * staff inbox endpoints that already exist, because this product must have
 * exactly one send path (§36 of the brief).
 *
 * What it DOES let a pharmacist change is what a conversation is about: its
 * topic label (0063), and the records it points at (0064). Neither is a word
 * of what was said, and neither copies anything out of the record it names.
 */

/**
 * What a conversation was about (0063).
 *
 * `appointment` is in the list although this product has no appointments
 * module: patients discuss appointments regardless, and the alternative is a
 * pharmacist labelling that thread `other`, which tells the next reader
 * nothing. A label is not a link — nothing behind it claims a record exists.
 */
const TOPICS = Object.freeze([
  { id: 'general', label: 'General' },
  { id: 'medication', label: 'Medication' },
  { id: 'medication_review', label: 'Medication review' },
  { id: 'follow_up', label: 'Follow-up' },
  { id: 'appointment', label: 'Appointment' },
  { id: 'test_result', label: 'Test result' },
  { id: 'care_program', label: 'Care programme' },
  { id: 'condition', label: 'Condition' },
  { id: 'billing', label: 'Billing / administrative' },
  { id: 'other', label: 'Other' },
]);

const TOPIC_IDS = Object.freeze(TOPICS.map((t) => t.id));

/**
 * Which threads to show.
 *
 * Only two, and they are the two the database already has: a conversation is
 * open or it is closed (0023). "Active" and "Archived" in the brief are those
 * two under the names a pharmacist uses.
 */
const FILTERS = Object.freeze(['active', 'archived', 'all']);

/** Who said it. The four values `messages.author` has carried since 0001. */
const AUTHORS = Object.freeze(['customer', 'assistant', 'staff', 'system']);

/**
 * The delivery states this product may DISPLAY.
 *
 * §8 of the brief: do not display delivery states the provider cannot
 * actually verify. These are the six the provider reports and the database
 * stores; nothing is inferred, and a message with no status shows none rather
 * than a guess — an outbound message whose status never came back is not
 * "sent", it is unknown, and saying "sent" is the failure §34 names.
 */
const DELIVERY_STATES = Object.freeze([
  'queued', 'sent', 'delivered', 'read', 'failed', 'undelivered',
]);

function badRequest(message, field, code = 'INVALID') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  err.field = field;
  return err;
}

/** The list query: which threads, and an optional text search. */
function readListQuery(query = {}) {
  const filter = String(query.filter || 'active').trim().toLowerCase();
  if (!FILTERS.includes(filter)) {
    throw badRequest(`Show must be one of: ${FILTERS.join(', ')}.`, 'filter');
  }

  const topic = query.topic == null || query.topic === '' ? null : String(query.topic).trim();
  if (topic !== null && !TOPIC_IDS.includes(topic)) {
    throw badRequest('That is not a topic this product uses.', 'topic');
  }

  // §18: search what a patient and the pharmacy actually said to each other.
  // Trimmed, capped, and a blank search is no search rather than a query that
  // matches every message.
  const raw = String(query.q || '').trim();
  const q = raw.length === 0 ? null : raw.slice(0, 200);

  // WHICH KIND of thread. Defaults to the patient's own, because that is what
  // "Messages" means on a patient record; internal threads are their own view
  // and are never mixed into it by accident.
  const channel = String(query.channel || 'whatsapp').trim().toLowerCase();
  if (!CHANNEL_IDS.includes(channel) && channel !== 'all') {
    throw badRequest('That is not a kind of conversation this product has.', 'channel');
  }

  return { filter, topic, q, channel };
}

/**
 * Setting the topic.
 *
 * Clearing it is allowed and means "nobody has said", which is what every
 * conversation older than 0063 already says. That is deliberate: a pharmacist
 * who mislabelled a thread must be able to take the label off rather than
 * being forced to leave a wrong one or pick `other`.
 */
function readTopicInput(body = {}) {
  const has = body.topic !== undefined;
  if (!has) throw badRequest('Say which topic, or clear it.', 'topic');

  const value = body.topic;
  if (value === null || value === '') return { topic: null };

  const topic = String(value).trim();
  if (!TOPIC_IDS.includes(topic)) {
    throw badRequest('That is not a topic this product uses.', 'topic');
  }
  return { topic };
}

/**
 * What a conversation can be linked to (§13, 0064).
 *
 * The kinds `clinicalRefs` can resolve for a patient, and no others — a kind
 * this list invents is a link the screen would draw and nothing could open.
 * An appointment is NOT here: this product has no appointments table, and a
 * "View appointment" button behind a topic labelled Appointment would be a
 * promise nothing can keep (MESSAGES_PLAN.md §6).
 */
const LINK_KINDS = Object.freeze([
  { id: 'condition', label: 'Condition' },
  { id: 'medication', label: 'Medication' },
  { id: 'medication_review', label: 'Medication review' },
  { id: 'test', label: 'Test' },
  { id: 'vitals', label: 'Vitals reading' },
  { id: 'consultation', label: 'Consultation' },
  { id: 'care_program', label: 'Care programme' },
  { id: 'followup', label: 'Follow-up' },
]);

const LINK_KIND_IDS = Object.freeze(LINK_KINDS.map((k) => k.id));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Attaching a record to a conversation.
 *
 * Carries a KIND and an ID and — at most — a short note about why it was
 * attached. It deliberately carries NO copy of what the record says: §13 says
 * store references, and a name or a value copied here would still be showing
 * the old one after the record changed.
 */
function readLinkInput(body = {}) {
  const kind = String(body.kind || '').trim();
  if (!LINK_KIND_IDS.includes(kind)) {
    throw badRequest('That is not a kind of record this conversation can point at.', 'kind');
  }

  const refId = String(body.refId || body.id || '').trim();
  if (!UUID_RE.test(refId)) {
    throw badRequest('Choose the record to attach.', 'refId');
  }

  const raw = String(body.note || '').trim();
  if (raw.length > 300) {
    throw badRequest('A note about why this is attached must be 300 characters or fewer.', 'note');
  }

  return { kind, refId, note: raw || null };
}

/** The label for a link kind, for a screen. Never invents one. */
const linkKindLabel = (id) => (LINK_KINDS.find((k) => k.id === id) || {}).label || null;


/**
 * Which KIND of thread (§14, 0066).
 *
 * Not a filter over one list — two different kinds of row. A patient-facing
 * thread went to and from a person outside this pharmacy; an internal thread
 * never left it, and cannot, because `sendAndRecordOutbound` refuses one
 * before it reaches the transport (GOLDEN-007).
 */
const CHANNELS = Object.freeze([
  { id: 'whatsapp', label: 'With the patient' },
  { id: 'internal', label: 'Internal' },
]);

const CHANNEL_IDS = Object.freeze(CHANNELS.map((c) => c.id));

/**
 * Starting an internal thread.
 *
 * A subject and a first note. The subject is what colleagues will scan, so it
 * is required — an internal thread called nothing is one nobody finds again.
 */
function readInternalThreadInput(body = {}) {
  const subject = String(body.subject || '').trim();
  if (!subject) throw badRequest('Say what this internal thread is about.', 'subject');
  if (subject.length > 120) {
    throw badRequest('A subject must be 120 characters or fewer.', 'subject');
  }

  const note = String(body.note || '').trim();
  if (!note) throw badRequest('Write the first note.', 'note');
  if (note.length > 4000) throw badRequest('A note must be 4000 characters or fewer.', 'note');

  const topic = body.topic == null || body.topic === '' ? null : String(body.topic).trim();
  if (topic !== null && !TOPIC_IDS.includes(topic)) {
    throw badRequest('That is not a topic this product uses.', 'topic');
  }

  return { subject, note, topic };
}

/** Adding a note to an internal thread. */
function readInternalNoteInput(body = {}) {
  const note = String(body.note || body.text || '').trim();
  if (!note) throw badRequest('A note cannot be empty.', 'note');
  if (note.length > 4000) throw badRequest('A note must be 4000 characters or fewer.', 'note');
  return { note };
}


/** The label for a topic id, for a screen. Never invents one. */
const topicLabel = (id) => (TOPICS.find((t) => t.id === id) || {}).label || null;

/** Everything the screen needs to render its controls, in one call. */
const messageOptions = () => ({
  topics: TOPICS,
  filters: FILTERS,
  linkKinds: LINK_KINDS,
  channels: CHANNELS,
  // What this phase deliberately cannot do, said out loud so the screen does
  // not have to guess whether to draw the buttons (MESSAGES_PLAN.md §11).
  capabilities: {
    // Still false, and deliberately: this product is strictly reactive and
    // does not start conversations WITH PATIENTS. Phase 3 changed nothing
    // about that (MESSAGES_PLAN.md §11, decision 2).
    canStartConversation: false,
    canSendAttachment: false,
    // Built in phase 3 (0066). An internal thread never leaves the pharmacy,
    // so starting one is not outreach.
    internalThreads: true,
    canStartInternalThread: true,
  },
});

module.exports = {
  TOPICS, TOPIC_IDS, FILTERS, AUTHORS, DELIVERY_STATES,
  LINK_KINDS, LINK_KIND_IDS, CHANNELS, CHANNEL_IDS,
  readListQuery, readTopicInput, readLinkInput,
  readInternalThreadInput, readInternalNoteInput,
  topicLabel, linkKindLabel, messageOptions,
};
