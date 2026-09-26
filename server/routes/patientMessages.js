/**
 * The patient's Messages section — `/api/customers/:id/messages`.
 *
 * See MESSAGES_PLAN.md. Mounted on `/api/customers` beside the other record
 * sections, and BEFORE `routes/customers.js`, which owns `/:id` and would
 * otherwise swallow these paths.
 *
 * READ-ONLY, PLUS A LABEL. There is no POST that sends anything here, on
 * purpose:
 *
 *   replying   → POST /api/conversations/:id/reply    (the one send path)
 *   archiving  → POST /api/conversations/:id/archive
 *
 * Both already exist, already check the WhatsApp connection, already declare
 * a message category to `communicationPolicy`, and already reset the handoff
 * clock so a pharmacist mid-conversation is not handed back to the assistant
 * underneath them. Re-implementing any of that behind a patient-scoped URL
 * would give this product two send paths, which is §36's whole warning.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  listPatientConversations, getPatientConversation, setConversationTopic,
  addConversationLink, removeConversationLink, markConversationRead,
  createInternalThread, addInternalNote, getInternalThread,
} = require('../services/messaging/patientMessages');
const {
  readListQuery, readTopicInput, readLinkInput,
  readInternalThreadInput, readInternalNoteInput, messageOptions,
} = require('../services/messaging/messageInput');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is a bad request, not a database error. */
function customerId(req) {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) {
    const err = new Error('That is not a patient id.');
    err.status = 400;
    err.code = 'INVALID_ID';
    throw err;
  }
  return id;
}

/**
 * Who is doing this.
 *
 * The same shape `routes/followups.js` uses, and for the same reason:
 * `topic_set_by` is a foreign key to auth.users, and the all-zeros id that
 * DEV_AUTH_BYPASS supplies is not a row there — so passing it straight
 * through made the whole write fail with a 500 rather than saving a label
 * attributed to nobody. Found by setting a topic in the browser.
 */
function actor(req) {
  const user = req.user?.id;
  return {
    actorId: user && user !== '00000000-0000-0000-0000-000000000000' ? user : null,
  };
}

/**
 * Whose unread this is (§17).
 *
 * The same normalisation as `actor`, because unread is per USER and a
 * sentinel id is not a user — a read mark keyed on it would be one shared
 * "read" for everybody, which is the per-pharmacy behaviour this explicitly
 * is not. With no real user, unread counts come back as 0 rather than wrong.
 */
const readerId = (req) => actor(req).actorId;

// The topics, the filters, and what this phase cannot do — so the screen
// draws the controls that work and not the ones that do not.
router.get('/:id/messages/options', requireAuth, (req, res) => {
  res.json(messageOptions());
});

router.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const query = readListQuery(req.query);
    res.json(await listPatientConversations(
      req.pharmacyId, customerId(req), { ...query, userId: readerId(req) },
    ));
  } catch (err) { next(err); }
});

router.get('/:id/messages/:conversationId', requireAuth, async (req, res, next) => {
  try {
    const found = await getPatientConversation(
      req.pharmacyId, customerId(req), req.params.conversationId,
      { userId: readerId(req) },
    );
    // Not this patient's, not this pharmacy's, or not a conversation at all —
    // all one answer. A conversation id is not a capability.
    if (!found) return res.status(404).json({ error: 'Conversation not found.', code: 'NOT_FOUND' });
    res.json(found);
  } catch (err) { next(err); }
});

router.put('/:id/messages/:conversationId/topic', requireAuth, async (req, res, next) => {
  try {
    const input = readTopicInput(req.body);
    const updated = await setConversationTopic(
      req.pharmacyId, customerId(req), req.params.conversationId, input,
      actor(req),
    );
    res.json(updated);
  } catch (err) { next(err); }
});

/**
 * Attach a record to a conversation (§13).
 *
 * The id is checked against THIS patient's own records before anything is
 * written — `clinicalRefs.assertRecord`, which is the guarantee, because the
 * target is one of eight tables and cannot be a foreign key.
 */
router.post('/:id/messages/:conversationId/links', requireAuth, async (req, res, next) => {
  try {
    const input = readLinkInput(req.body);
    const links = await addConversationLink(
      req.pharmacyId, customerId(req), req.params.conversationId, input, actor(req),
    );
    res.status(201).json({ links });
  } catch (err) { next(err); }
});

// Detaching removes the LINK, never the record it pointed at.
router.delete('/:id/messages/:conversationId/links/:linkId', requireAuth, async (req, res, next) => {
  try {
    const links = await removeConversationLink(
      req.pharmacyId, customerId(req), req.params.conversationId, req.params.linkId, actor(req),
    );
    res.json({ links });
  } catch (err) { next(err); }
});

/**
 * This reader has now read this conversation (§17).
 *
 * A POST, not a side effect of the GET. "Do not automatically mark messages as
 * read before they are viewed" means the mark belongs to a screen that has
 * actually rendered the transcript — and a GET that wrote here would mark a
 * thread read for anything that merely loaded a summary.
 */
router.post('/:id/messages/:conversationId/read', requireAuth, async (req, res, next) => {
  try {
    res.json(await markConversationRead(
      req.pharmacyId, customerId(req), req.params.conversationId, readerId(req),
    ));
  } catch (err) { next(err); }
});

/**
 * Internal threads (§14, 0066) — staff-to-staff, about a patient.
 *
 * These are mounted under the patient because that is what they are about,
 * but nothing here can reach the patient: an internal conversation is refused
 * by `sendAndRecordOutbound` before it touches the transport, and 0066's
 * CHECKs leave nowhere to record one as sent. GOLDEN-007 asserts both.
 *
 * WHO MAY SEE THEM: everyone in the pharmacy — owner, pharmacist and staff
 * (the owner's decision, MESSAGES_PLAN.md §11.3). That is a deliberate
 * departure from the brief's §30, recorded there rather than left looking
 * like an oversight. It governs who can READ one; it changes nothing about
 * the guarantee that one cannot be sent.
 */
router.get('/:id/messages/internal/:conversationId', requireAuth, async (req, res, next) => {
  try {
    const found = await getInternalThread(
      req.pharmacyId, customerId(req), req.params.conversationId,
      { userId: readerId(req) },
    );
    if (!found) return res.status(404).json({ error: 'Internal thread not found.', code: 'NOT_FOUND' });
    res.json(found);
  } catch (err) { next(err); }
});

// Starting one is allowed where starting a PATIENT conversation is not: an
// internal thread never leaves the pharmacy, so it is not outreach.
router.post('/:id/messages/internal', requireAuth, async (req, res, next) => {
  try {
    const input = readInternalThreadInput(req.body);
    const created = await createInternalThread(
      req.pharmacyId, customerId(req), input, actor(req),
    );
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.post('/:id/messages/internal/:conversationId/notes', requireAuth, async (req, res, next) => {
  try {
    const input = readInternalNoteInput(req.body);
    res.status(201).json(await addInternalNote(
      req.pharmacyId, customerId(req), req.params.conversationId, input, actor(req),
    ));
  } catch (err) { next(err); }
});

module.exports = router;
