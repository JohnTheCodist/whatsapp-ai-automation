/**
 * New-number warm-up.
 *
 * A number with no history that starts sending at full volume on day one is
 * a signal in itself, whatever the messages say. Door A means the pharmacy
 * connects a clean number, so this is the exact profile that gets the most
 * scrutiny — and it is the one protection the existing conduct rules did not
 * already cover.
 *
 * WHAT THIS IS
 * A ceiling on outbound sends that starts low and grows over the first week.
 * It is a real constraint on real behaviour: the account genuinely sends
 * less at the start, the way a business that just set up WhatsApp would.
 *
 * WHAT THIS IS NOT
 * It does not fabricate anything. There is no fake typo injection, no
 * invented read-gap, no device fingerprint spoofing — those defeat a
 * classifier by asserting things that did not happen, which is a different
 * activity from being low-risk traffic. Ramping volume is a fact about the
 * account. Inventing human error is a claim about it that is false.
 *
 * INTERACTION WITH conductPolicy
 * Both cap outbound volume, and they are not redundant. conductPolicy's
 * daily cap is a steady-state ceiling that trips a breaker when exceeded —
 * "this is unusual, stop and let a person look". Warm-up is a temporary,
 * expected, shrinking-to-nothing limit where hitting it is normal and must
 * NOT pause the pharmacy. Merging them would mean a new pharmacy trips its
 * circuit breaker on day one for behaving exactly as intended.
 *
 * Pure. `now` and `startedAt` are passed in, so day 6 is testable today.
 */

/** Growth per day. 20 → 34 → 58 → 98 → 167 → 284 → 483 over a 7-day ramp. */
const GROWTH_FACTOR = 1.7;

/**
 * Where a number is in its ramp.
 *
 * @param {object} args
 * @param {Date|string|null} args.startedAt   first outbound send; null = not started
 * @param {Date}   [args.now]
 * @param {boolean}[args.enabled]
 * @param {number} [args.day1Limit]
 * @param {number} [args.warmupDays]
 * @returns {{active: boolean, day: number|null, limit: number|null, reason: string}}
 *   `limit` is null when no ceiling applies — an unlimited state, not a zero one.
 */
function warmupStatus({
  startedAt,
  now = new Date(),
  enabled = true,
  day1Limit = 20,
  warmupDays = 7,
}) {
  if (!enabled) {
    return { active: false, day: null, limit: null, reason: 'warmup_disabled' };
  }

  // Never sent anything. The ramp has not begun, so the day-one ceiling is
  // what applies to the very first message.
  if (!startedAt) {
    return { active: true, day: 1, limit: day1Limit, reason: 'not_started' };
  }

  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(start.getTime())) {
    // Fail SAFE rather than open: an unparseable timestamp means we do not
    // know how old this number is, and assuming "fully warm" is the
    // assumption that costs the pharmacy its number.
    return { active: true, day: 1, limit: day1Limit, reason: 'unreadable_start_date' };
  }

  const elapsedMs = now.getTime() - start.getTime();
  // A clock that has gone backwards (NTP correction, restored backup) must
  // not read as "negative days elapsed" and skip the ramp.
  const day = Math.max(1, Math.floor(elapsedMs / 86_400_000) + 1);

  if (day > warmupDays) {
    return { active: false, day, limit: null, reason: 'warmed_up' };
  }

  const limit = Math.round(day1Limit * GROWTH_FACTOR ** (day - 1));
  return { active: true, day, limit, reason: 'warming' };
}

/**
 * May this number send another message right now?
 *
 * @param {number} sentToday  outbound messages in the trailing 24h
 * @returns {{send: boolean, reason: string, day?: number, limit?: number, sentToday?: number}}
 *
 * Deliberately returns no `pause` field. Unlike conductPolicy's daily cap,
 * reaching a warm-up ceiling is expected and temporary — pausing the pharmacy
 * for doing exactly what the ramp intends would be the bug, not the feature.
 */
function evaluateWarmup({ sentToday = 0, ...statusArgs }) {
  const status = warmupStatus(statusArgs);

  if (!status.active) {
    return { send: true, reason: status.reason };
  }
  if (sentToday >= status.limit) {
    return {
      send: false,
      reason: 'warmup_limit_reached',
      day: status.day,
      limit: status.limit,
      sentToday,
    };
  }
  return { send: true, reason: 'within_warmup', day: status.day, limit: status.limit };
}

module.exports = { warmupStatus, evaluateWarmup, GROWTH_FACTOR };
