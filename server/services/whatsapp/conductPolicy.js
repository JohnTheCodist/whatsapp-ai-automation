/**
 * May the assistant send this reply?
 *
 * WHAT THIS IS
 * A set of rules that make the system structurally incapable of behaving like
 * spam. Not a disguise — a constraint. The reported reasons a number gets
 * actioned are behavioural (messaging strangers, bulk sending, low reply
 * ratio, mechanical timing, ignoring people who said stop), and every one of
 * them is something code can be made unable to do.
 *
 * WHAT THIS IS NOT
 * It is not an attempt to look like a human to a classifier, and nothing here
 * gets safer by hiding. A system that only ever answers people who wrote
 * first, at a sane hour, at human speed, a bounded number of times, and never
 * again once asked to stop, has very little for a spam detector to find —
 * because there is very little there.
 *
 * FAILS CLOSED. Every unknown, malformed or unexpected input declines to
 * send. Not sending is always recoverable; the number is not.
 *
 * Pure. No database, no clock of its own — `now` is passed in so the whole
 * thing is testable at 3am without waiting until 3am.
 */

const { normalizeMsisdn } = require('./senderIdentity');

/**
 * Phrases that mean "stop messaging me".
 *
 * Deliberately generous. A false positive costs one customer an automated
 * reply they can undo by messaging again; a false negative means continuing
 * to message someone who asked you not to, which is the clearest signal of a
 * system worth banning and is simply wrong regardless.
 */
const OPT_OUT_PATTERNS = [
  /^\s*(stop|unsubscribe|cancel|end|quit|optout|opt out)\s*$/i,
  /\b(stop|don'?t|do not|no more|never)\b.{0,20}\b(messag|text|contact|disturb|send)/i,
  /\b(unsubscribe|opt me out|remove me|take me off)\b/i,
  /\bleave me alone\b/i,
  /\bno dey disturb me\b/i,
  /\babeg stop\b/i,
];

/** Does this inbound message ask us to stop? */
function isOptOutRequest(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length > 300) return false;
  return OPT_OUT_PATTERNS.some((re) => re.test(t));
}

/**
 * Is `hour` inside the quiet window?
 *
 * Handles a window that wraps midnight (22:00–06:00), which is the normal
 * case and the one a naive `start <= h && h < end` gets silently wrong.
 */
function isQuietHour(hour, start, end) {
  if (start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

/**
 * @param {object} args
 * @param {string}  args.replyMode        'off' | 'allowlist' | 'all'
 * @param {string}  args.phone
 * @param {string[]} [args.allowlist]
 * @param {boolean} [args.optedOut]
 * @param {boolean} [args.sendingPaused]
 * @param {Date}    [args.now]
 * @param {object}  [args.limits]         caps and quiet hours for this pharmacy
 * @param {object}  [args.counts]         { repliesToday, repliesThisConversationHour, identicalRecentReplies }
 * @param {string}  [args.defaultCountryCode]
 * @returns {{send: boolean, reason: string, pause?: boolean}}
 *   `pause` asks the caller to trip the circuit breaker — a breach that
 *   indicates something is wrong rather than merely a limit being reached.
 */
function evaluateOutbound({
  replyMode,
  phone,
  allowlist = [],
  optedOut = false,
  sendingPaused = false,
  now = new Date(),
  limits = {},
  counts = {},
  defaultCountryCode = '234',
}) {
  // 1. The breaker. Checked first so nothing below can talk past it.
  if (sendingPaused) {
    return { send: false, reason: 'sending_paused' };
  }

  // 2. Opt-out. Above the allowlist on purpose: an explicit "stop" outranks
  //    any configuration that says we may message this person.
  if (optedOut) {
    return { send: false, reason: 'opted_out' };
  }

  const normalised = normalizeMsisdn(phone, defaultCountryCode);
  if (!normalised) {
    return { send: false, reason: 'unresolvable_number' };
  }

  // 3. Who we are allowed to talk to at all.
  switch (replyMode) {
    case 'off':
      return { send: false, reason: 'reply_mode_off' };
    case 'all':
      break;
    case 'allowlist': {
      if (!Array.isArray(allowlist) || allowlist.length === 0) {
        return { send: false, reason: 'allowlist_empty' };
      }
      const permitted = new Set(
        allowlist.map((n) => normalizeMsisdn(n, defaultCountryCode)).filter(Boolean)
      );
      if (!permitted.has(normalised)) {
        return { send: false, reason: 'not_allowlisted' };
      }
      break;
    }
    default:
      return { send: false, reason: `unknown_reply_mode:${replyMode}` };
  }

  // 4. Quiet hours. A shop that answers instantly at 03:00 is not a shop, and
  //    round-the-clock instant replies are one of the few things about this
  //    system that genuinely does not look human.
  if (limits.quietHoursEnabled !== false) {
    const start = Number.isInteger(limits.quietHoursStart) ? limits.quietHoursStart : 22;
    const end = Number.isInteger(limits.quietHoursEnd) ? limits.quietHoursEnd : 6;
    if (isQuietHour(now.getHours(), start, end)) {
      return { send: false, reason: 'quiet_hours' };
    }
  }

  // 5. Loop protection, before the volume caps.
  //
  //    Two automated systems talking to each other produce perfectly ordinary
  //    volume for a while and then a great deal of it. The give-away is
  //    repetition, and it is worth catching as a FAULT rather than absorbing
  //    as traffic — so this trips the breaker rather than just declining.
  const identical = counts.identicalRecentReplies ?? 0;
  if (identical >= 3) {
    return { send: false, reason: 'repeating_itself', pause: true };
  }

  const perConversation = counts.repliesThisConversationHour ?? 0;
  const conversationCap = limits.hourlyConversationCap ?? 15;
  if (perConversation >= conversationCap) {
    // Not a pause: one chatty customer is not evidence the system is broken.
    return { send: false, reason: 'conversation_rate_limit' };
  }

  // 6. Daily ceiling. Hitting it PAUSES rather than throttles. On an
  //    unofficial channel, unexplained volume is exactly the moment to stop
  //    and let a person look, not to keep going at a slower rate.
  const today = counts.repliesToday ?? 0;
  const dailyCap = limits.dailyReplyCap ?? 200;
  if (today >= dailyCap) {
    return { send: false, reason: 'daily_cap_reached', pause: true };
  }

  return { send: true, reason: 'ok' };
}

module.exports = { evaluateOutbound, isOptOutRequest, isQuietHour, OPT_OUT_PATTERNS };
