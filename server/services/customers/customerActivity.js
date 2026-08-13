/**
 * Is a customer going quiet? Read-time only — this never writes to
 * `customers.status`.
 *
 * WHY THIS IS NOT A CRON THAT FLIPS status TO 'inactive'
 * `status` is the pharmacy's deliberate relationship decision (see migration
 * 0015). A dormancy label that some background job silently writes into that
 * same column would be indistinguishable, in the data, from a staff member
 * choosing to archive the relationship — and the next feature to read
 * `status` would have no way to tell "nobody decided this" from "someone
 * did". So dormancy is computed fresh from `last_seen_at` wherever it's
 * needed (a dashboard badge, a filter), and stays entirely separate from the
 * stored lifecycle field.
 *
 * If a bulk reclassification job is wanted later — "archive everyone quiet
 * 180+ days" — it should call this function and write `status` explicitly,
 * as one auditable batch action, not thread the decision through every
 * inbound message the way `status` must never be.
 *
 * Pure. No database, no side effects.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Thresholds in days since last_seen_at. Ordered; first match wins. */
const TIERS = [
  { tier: 'active', maxDays: 30 },
  { tier: 'quiet', maxDays: 90 },
  { tier: 'dormant', maxDays: Infinity },
];

/**
 * @param {Date|string|null|undefined} lastSeenAt
 * @param {Date} [now]  injectable for tests
 * @returns {{tier: 'active'|'quiet'|'dormant'|'unknown', daysSinceContact: number|null}}
 */
function classifyActivity(lastSeenAt, now = new Date()) {
  if (!lastSeenAt) return { tier: 'unknown', daysSinceContact: null };

  const then = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(then.getTime())) return { tier: 'unknown', daysSinceContact: null };

  // A timestamp in the future is bad input, not a customer who is
  // impossibly active. Treated as "just seen" rather than propagating a
  // negative day count into whatever reads this.
  const days = Math.max(0, Math.floor((now.getTime() - then.getTime()) / DAY_MS));

  const match = TIERS.find((t) => days <= t.maxDays);
  return { tier: match.tier, daysSinceContact: days };
}

module.exports = { classifyActivity, TIERS };
