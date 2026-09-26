/**
 * Wording and dates for refills, shared by the patient profile and the
 * refill call list so the two can never describe one supply differently.
 *
 * The server decides the status (services/refills/refillSchedule.js); this
 * file only says it in words. It never recomputes a date or a status.
 */

/**
 * A 'YYYY-MM-DD' calendar day as "01 Oct 2026".
 *
 * Formatted in UTC ON PURPOSE. `new Date('2026-10-01')` is UTC midnight, and
 * formatting it in the browser's own zone shows 30 Sep anywhere west of
 * Greenwich. A refill is due on a day, not at an instant, so the day must
 * come out exactly as the server sent it.
 */
export function fmtDay(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/** What a supply's status means for this patient, in one line. */
export function supplyLabel({ status, daysLeft }) {
  switch (status) {
    case 'upcoming':
    case 'due':
      return daysLeft === 1 ? 'Runs out tomorrow' : `Runs out in ${days(daysLeft)}`;
    case 'overdue':
      if (daysLeft === 0) return 'Ran out today';
      if (daysLeft === -1) return 'Ran out yesterday';
      return `Out for ${days(-daysLeft)}`;
    case 'lapsed':
      return `Lapsed: out for ${days(-daysLeft)}`;
    default:
      return '';
  }
}

/** Short status word for a pill. */
export const REFILL_STATUS_LABEL = {
  upcoming: 'On track',
  due: 'Due',
  overdue: 'Overdue',
  lapsed: 'Lapsed',
};

/**
 * Amber throughout, deepening with urgency. design.md: amber is queued work;
 * red is reserved for "a person is waiting on a human" (Consultations), and
 * a lapsed refill is a phone call to make, not a patient waiting in a chat.
 */
export const REFILL_STATUS_TONE = {
  upcoming: 'ui-tone-quiet',
  due: 'ui-tone-1',
  overdue: 'ui-tone-2',
  lapsed: 'ui-tone-3',
};

/**
 * Why this patient cannot be sent a medication message, or null if they can.
 * Shown before anyone tries, so a pharmacist rings instead of waiting on a
 * message that the policy would refuse.
 */
export function messagingBlock(customer) {
  if (!customer) return null;
  if (customer.optedOut) return 'Opted out of messages';
  if (!customer.medicationMessages) return 'Medication messages off';
  return null;
}

/** POST JSON, resolving to the body or throwing the server's own message. */
export async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'That did not save. Try again.');
  return j;
}
