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



/* ==========================================================================
 * Phase 4 — starting a conversation, inside the window the patient opened
 * ======================================================================== */

/**
 * How long a customer-initiated reply window stays open. WhatsApp's, not
 * ours — `inboundIngest.js` sets it from the same number, and this is the
 * only other place that needs to know it.
 */
const REPLY_WINDOW_HOURS = 24;

/** Why outreach is unavailable, in words a pharmacist can act on. */
const OUTREACH_BLOCKED = Object.freeze({
  never_messaged: 'This patient has never messaged the pharmacy, so there is no conversation to continue. WhatsApp only allows a business to write first using an approved template, which this product does not have.',
  thread_open: 'There is already an open conversation with this patient. Reply in it rather than starting a second one.',
  window_closed: 'The 24-hour window closed. WhatsApp only allows a reply within 24 hours of the patient\u2019s last message, so this patient has to write again first.',
});

/**
 * MAY WE START A CONVERSATION WITH THIS PATIENT, RIGHT NOW?
 *
 * THE RULE, AND WHY IT IS THIS AND NOT §15 AS WRITTEN. The brief asks for a
 * "+ New Message" that writes to a patient. This product sends over Baileys —
 * WhatsApp Web automation — and NOT the Meta Cloud API, so there is no
 * approved-template path and no compliant way to write to somebody who has
 * not written to us. Doing it anyway is the single most reliable way to get a
 * pharmacy’s number flagged, and five real pharmacies are on this system.
 *
 * So outreach is allowed in exactly ONE case: the patient messaged within the
 * last 24 hours, and the thread they opened has since been closed or
 * archived. That is not a business-initiated message at all — it is
 * continuing a conversation the PATIENT started, inside the window they
 * opened, and carries exactly the risk a reply already carries.
 *
 * PURE, like `communicationPolicy`: takes the state as data and returns a
 * decision. No database and no clock beyond what the caller passes, so every
 * branch is testable without fixtures.
 *
 * The window is NOT recomputed or extended here. It belongs to the patient’s
 * last inbound message, and a window we minted ourselves would be this
 * product inventing a permission the provider never granted — the same rule
 * as never showing a delivery state the provider cannot verify (§8).
 */
function outreachState({ latest = null, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);

  if (!latest) {
    return { allowed: false, reason: 'never_messaged', message: OUTREACH_BLOCKED.never_messaged, windowExpiresAt: null };
  }
  if (latest.status === 'open') {
    return { allowed: false, reason: 'thread_open', message: OUTREACH_BLOCKED.thread_open, windowExpiresAt: latest.windowExpiresAt || null, conversationId: latest.id || null };
  }

  const expires = latest.windowExpiresAt ? new Date(latest.windowExpiresAt) : null;
  // An unparseable or absent window fails CLOSED. A send we cannot reason
  // about costs a message that can be sent again once the patient writes;
  // the other way costs one that cannot be unsent.
  if (!expires || Number.isNaN(expires.getTime()) || expires.getTime() <= at.getTime()) {
    return { allowed: false, reason: 'window_closed', message: OUTREACH_BLOCKED.window_closed, windowExpiresAt: latest.windowExpiresAt || null };
  }

  return { allowed: true, reason: null, message: null, windowExpiresAt: latest.windowExpiresAt };
}

/**
 * §15 — the body of a new conversation.
 *
 * The channel is NOT a choice. §15 says to offer only channels actually
 * available for that patient, and WhatsApp is the only one this product
 * sends patient-facing messages on — a select with one option that the
 * server would refuse anything else from is a control pretending to be a
 * decision.
 */
function readNewConversationInput(body = {}) {
  const text = String(body.body == null ? '' : body.body).trim();
  if (!text) throw badRequest('A message cannot be empty.', 'body');
  if (text.length > 4000) throw badRequest('A message must be 4000 characters or fewer.', 'body');

  // Optional, and absent rather than defaulted to `general` — 0063 refused a
  // default for the same reason: a topic nobody chose is this product
  // inventing what a conversation was about.
  let topic = null;
  if (body.topic !== undefined && body.topic !== null && body.topic !== '') {
    topic = String(body.topic).trim();
    if (!TOPIC_IDS.includes(topic)) throw badRequest('That is not a topic this product records.', 'topic');
  }

  if (body.channel !== undefined && body.channel !== null && body.channel !== 'whatsapp') {
    throw badRequest('WhatsApp is the only channel this product sends patient messages on.', 'channel');
  }

  return { body: text, topic, channel: 'whatsapp' };
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
    // AMENDED with phase 4. This product can now start a conversation, but
    // ONLY inside the 24-hour window the patient themselves opened — see
    // `outreachState`, which argues it at length. It is still NOT true that
    // this product writes to patients first: unprompted outreach would need
    // an approved template, and Baileys has no such thing.
    //
    // This flag says what the PRODUCT can do. Whether it can be done for a
    // particular patient right now is a different question with a different
    // answer every day, and it rides on that patient's own read.
    canStartConversation: true,
    canStartConversationUnprompted: false,
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
  readNewConversationInput, outreachState, OUTREACH_BLOCKED, REPLY_WINDOW_HOURS,
  topicLabel, linkKindLabel, messageOptions,
};
