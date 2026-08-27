/**
 * Not answering like a machine.
 *
 * THE BEHAVIOUR THIS FIXES
 * A customer types four messages in a row — "hi", "do you have amoxicillin",
 * "500mg", "how much" — because that is how people use WhatsApp. Each one
 * became its own job and its own reply, so they got four separate answers
 * seconds apart, each responding to a fragment of one question.
 *
 * It is worse when the assistant was held for any reason. Everything queues,
 * the hold lifts, and the pharmacy's number emits a burst of messages in one
 * second. That is not what a shop does, and volume arriving in a spike is
 * exactly the shape automated abuse detection looks for. A number that behaves
 * like that once may survive it; one that does it every morning will not.
 *
 * THREE RULES, AND THEY ARE DIFFERENT QUESTIONS
 *
 *   1. SUPERSEDED — is a newer message from this customer already waiting?
 *      Then this one is a fragment of a question that is still being asked.
 *      Say nothing; the last message in the burst answers all of it, because
 *      the assistant reads the whole conversation as context.
 *
 *   2. SETTLE — did this arrive a moment ago?
 *      Somebody mid-sentence is about to send more. Waiting a few seconds
 *      turns four replies into one, and it is also how a person behaves:
 *      nobody reads and answers within 300ms.
 *
 *   3. PACE — how long since this pharmacy last sent anything, to anyone?
 *      Even with the first two, ten different customers waiting produce ten
 *      replies at once. A minimum gap between sends spreads them.
 *
 * PURE. No database, no clock of its own — times are passed in, so "four
 * seconds later" is testable without waiting four seconds.
 */

/**
 * How long after the last message before the assistant answers.
 *
 * Long enough to catch someone typing the next line of a thought; short
 * enough that a customer who asked one clear question is not left staring at
 * an unanswered chat. Four seconds is roughly the gap between messages in a
 * burst — people type the next one immediately or take much longer.
 */
const SETTLE_MS = 4000;

/**
 * Minimum gap between two outbound messages from the same pharmacy.
 *
 * Not a rate limit — the daily cap and warm-up are the limits. This is about
 * SHAPE: the same twenty messages spread over a minute look like a shop
 * working through its morning, and in one second look like a script.
 */
const MIN_SEND_GAP_MS = 2500;

/**
 * Random extra delay added to the gap.
 *
 * Sends spaced at exactly 2500ms are their own signature — no human process
 * is that regular, and a fixed interval is trivially distinguishable from
 * one. This is NOT an attempt to imitate a person: the messages are genuinely
 * automated and nothing here pretends otherwise. It is avoiding a machine
 * rhythm that carries no information and costs nothing to remove.
 */
const JITTER_MS = 1500;

/**
 * What to do with an inbound message right now.
 *
 * @param {object} args
 * @param {boolean} args.hasNewerMessage   another inbound from this customer arrived after it
 * @param {number}  args.messageAgeMs      how long ago this message arrived
 * @param {number|null} args.msSinceLastSend  since this pharmacy last sent anything, null if never
 * @param {number}  [args.random]          0..1, injected so tests are deterministic
 * @returns {{action: 'skip'|'defer'|'send', reason: string, delayMs?: number}}
 *
 *   skip  — do not reply at all; a later message covers this one
 *   defer — reply later; re-queue this same job after delayMs
 *   send  — reply now
 */
function decideBurst({
  hasNewerMessage,
  messageAgeMs,
  msSinceLastSend,
  random = Math.random(),
}) {
  // 1. Superseded. Checked FIRST and unconditionally: no amount of waiting or
  //    pacing changes the fact that this message is not the whole question.
  //    Answering it would mean replying to "500mg" on its own.
  if (hasNewerMessage) {
    return { action: 'skip', reason: 'superseded_by_newer_message' };
  }

  // 2. Still settling. Wait for the rest of the thought.
  if (messageAgeMs < SETTLE_MS) {
    return {
      action: 'defer',
      reason: 'waiting_for_customer_to_finish',
      // Wait out the remainder, not a fresh full interval — a message already
      // three seconds old needs one more, not four.
      delayMs: SETTLE_MS - messageAgeMs,
    };
  }

  // 3. Pacing. null means this pharmacy has never sent anything, so there is
  //    nothing to space this one from.
  if (msSinceLastSend !== null && msSinceLastSend < MIN_SEND_GAP_MS) {
    const jitter = Math.round(random * JITTER_MS);
    return {
      action: 'defer',
      reason: 'pacing_outbound',
      delayMs: (MIN_SEND_GAP_MS - msSinceLastSend) + jitter,
    };
  }

  return { action: 'send', reason: 'ok' };
}

module.exports = { decideBurst, SETTLE_MS, MIN_SEND_GAP_MS, JITTER_MS };
