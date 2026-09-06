/**
 * Does this message continue the last conversation, or start a new one?
 *
 * THE PROBLEM THIS FIXES, MEASURED
 * The rule used to be inline in inboundIngest: "the newest conversation whose
 * mode is not closed". Nothing in the codebase ever set mode to 'closed', so
 * that clause always matched and every patient accumulated exactly one
 * conversation forever. In live data one patient had ONE conversation holding
 * 143 messages across five days — an order enquiry, a clinical escalation, a
 * vitamin question and a complaint, all in a single thread.
 *
 * That is not a cosmetic problem. It means:
 *   - the pharmacist's inbox shows "1 conversation" for a week of activity
 *   - "which conversation produced this order" has one useless answer
 *   - the assistant's history window can surface a product discussed four
 *     days ago as though it were the current topic
 *
 * WHY A SEPARATE MODULE
 * Segmentation is the kind of rule that gets adjusted — after real traffic,
 * after a pharmacy complains threads are too long or too fragmented. Inline
 * in an ingest function it can only be changed by editing the write path and
 * can only be tested by inserting messages. Here it is a pure function over
 * two timestamps, so every boundary case is a unit test.
 *
 * THE BOUNDARY, AND WHY 24 HOURS
 * Aligned with REPLY_WINDOW_HOURS, which already means something real in this
 * system: the window in which a customer-initiated exchange is still live.
 * Shorter (say 4h) splits one afternoon of back-and-forth into several
 * threads while someone is deciding what to buy. Much longer and a customer
 * returning next week lands in last week's thread, which is the state this
 * module exists to end.
 *
 * WHO ACTUALLY SPLITS A THREAD — AND WHY IT IS NOT THIS FUNCTION
 * The database holds a partial unique index:
 *
 *     idx_conversations_one_open ON conversations (customer_id)
 *                                WHERE status = 'open'
 *
 * One open thread per patient, enforced. So "start a new conversation" is a
 * legal answer only when the previous one is CLOSED, and the only writer that
 * closes anything is sweepIdleConversations in worker.js. The sweep is the
 * segmenter; this function only reports where a message lands.
 *
 * That division was not respected until 2026-09-06, and the failure was
 * total. This function returned 'new' whenever the last message was over 24
 * hours old — a branch reachable ONLY while the thread was still open, since
 * a closed one returns 'previous_closed' several lines earlier. So every time
 * it fired, inboundIngest inserted a second open conversation, Postgres
 * rejected it, the entire ingest transaction rolled back, and the customer's
 * message was filed as a failed inbound event and never answered.
 *
 * Measured in production: 16 consecutive dropped messages from one patient
 * across three days, every one the same unique violation, while the dashboard
 * reported WhatsApp connected and healthy. Nothing surfaced it.
 *
 * The patient it silences is the worst possible one. The sweep deliberately
 * refuses to close a thread awaiting a pharmacist — you must not file away
 * somebody with an unanswered clinical question. That refusal is right, and
 * it is exactly what pins the thread open, which is what makes every later
 * message from that patient unanswerable. The pharmacy's most urgent
 * conversation was the one guaranteed to break, and it broke silently.
 *
 * Hence the invariant below: with a previous conversation present, the only
 * route to 'new' is that it is closed.
 *
 * Pure. Two timestamps and a status in, a decision out.
 */

/** Idle time after which a quiet thread is considered stale. */
const IDLE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {object} args
 * @param {object|null} args.latest  the most recent conversation for this
 *   patient: { id, status, last_message_at }, or null if they have none
 * @param {Date} [args.now]
 * @param {number} [args.idleHours]
 * @returns {{action: 'reuse'|'new', conversationId: string|null, reason: string}}
 *
 * INVARIANT: never returns 'new' for a `latest` that is not closed. The
 * database permits exactly one open thread per patient, so proposing a second
 * is not a policy choice — it is a failed transaction and a lost message.
 */
function resolveConversation({ latest, now = new Date(), idleHours = IDLE_HOURS }) {
  if (!latest) {
    return { action: 'new', conversationId: null, reason: 'first_contact' };
  }

  // A closed conversation is history. Reopening it would resurrect whatever
  // context it carried — "I want two" referring to a product from a finished
  // order — so a closed thread always starts a fresh one rather than being
  // revived.
  if (latest.status === 'closed') {
    return { action: 'new', conversationId: null, reason: 'previous_closed' };
  }

  // ---- Everything below here is an OPEN thread, and is therefore reused. ----
  // The rest of this function decides only WHY, because the reason is worth
  // having in the logs: 'idle_but_open' means the sweep has not retired this
  // thread, which is either a worker that has fallen behind or a handoff
  // nobody has answered. Both are real conditions worth being able to see.
  // Neither is a reason to drop the customer's message.

  const last = latest.last_message_at ? new Date(latest.last_message_at) : null;
  if (!last || Number.isNaN(last.getTime())) {
    // No usable timestamp: reuse rather than fragment. A conversation with a
    // missing last_message_at is a data problem, and splitting the thread
    // would turn it into a visible one for the pharmacist.
    return { action: 'reuse', conversationId: latest.id, reason: 'no_timestamp_reuse' };
  }

  const idleMs = now.getTime() - last.getTime();

  // A clock skew that puts the last message in the future must not be read as
  // "idle for negative hours".
  if (idleMs < 0) {
    return { action: 'reuse', conversationId: latest.id, reason: 'active' };
  }

  if (idleMs >= idleHours * HOUR_MS) {
    // Stale, but still open, so it is still this patient's thread. Their next
    // message genuinely does start a new conversation — one sweep tick later,
    // once this one is closed and 'previous_closed' applies.
    return { action: 'reuse', conversationId: latest.id, reason: 'idle_but_open' };
  }

  return { action: 'reuse', conversationId: latest.id, reason: 'active' };
}

/**
 * Should this conversation be closed now?
 *
 * Separate from resolveConversation because closing happens on a sweep, not
 * on an inbound message — the whole point is that nobody has sent one. Kept
 * pure for the same reason: the threshold will be tuned, and tuning it should
 * not require a database.
 *
 * A conversation waiting on a pharmacist is NEVER auto-closed. Someone with
 * an unanswered clinical question is exactly who must not be quietly filed
 * away, and a closed thread drops out of the inbox.
 */
function shouldClose({ status, mode, lastMessageAt, hasOpenHandoff, now = new Date(), idleHours = IDLE_HOURS }) {
  if (status === 'closed') return { close: false, reason: 'already_closed' };
  if (hasOpenHandoff) return { close: false, reason: 'awaiting_pharmacist' };
  // 'human' means staff are actively handling it. Closing under someone
  // mid-reply would remove the thread they are typing into.
  if (mode === 'human') return { close: false, reason: 'staff_handling' };

  const last = lastMessageAt ? new Date(lastMessageAt) : null;
  if (!last || Number.isNaN(last.getTime())) return { close: false, reason: 'no_timestamp' };

  const idleMs = now.getTime() - last.getTime();
  if (idleMs >= idleHours * HOUR_MS) {
    return { close: true, reason: 'idle_expired' };
  }
  return { close: false, reason: 'active' };
}

module.exports = { resolveConversation, shouldClose, IDLE_HOURS };
