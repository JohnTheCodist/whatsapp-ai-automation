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
 * Pure. Two timestamps and a status in, a decision out.
 */

/** Idle time after which the next message starts a new conversation. */
const IDLE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {object} args
 * @param {object|null} args.latest  the most recent conversation for this
 *   patient: { id, status, last_message_at }, or null if they have none
 * @param {Date} [args.now]
 * @param {number} [args.idleHours]
 * @returns {{action: 'reuse'|'new', conversationId: string|null, reason: string}}
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

  const last = latest.last_message_at ? new Date(latest.last_message_at) : null;
  if (!last || Number.isNaN(last.getTime())) {
    // No usable timestamp: reuse rather than fragment. A conversation with a
    // missing last_message_at is a data problem, and splitting the thread
    // would turn it into a visible one for the pharmacist.
    return { action: 'reuse', conversationId: latest.id, reason: 'no_timestamp_reuse' };
  }

  const idleMs = now.getTime() - last.getTime();

  // A clock skew that puts the last message in the future must not be read as
  // "idle for negative hours" and certainly not as a reason to split.
  if (idleMs < 0) {
    return { action: 'reuse', conversationId: latest.id, reason: 'active' };
  }

  if (idleMs >= idleHours * HOUR_MS) {
    return { action: 'new', conversationId: null, reason: 'idle_expired' };
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
