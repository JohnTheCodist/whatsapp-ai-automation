/**
 * When does a patient's medicine run out, and what does that make today?
 *
 * PURE. Calendar dates in, calendar dates and a status out. No database and
 * no clock the caller did not pass, so every rule here is testable without
 * fixtures and a pharmacist's "why is this patient on the call list?" has
 * one answer that can be re-derived from two dates.
 *
 * DATES ARE LAGOS CALENDAR DAYS, AS 'YYYY-MM-DD' STRINGS
 * A refill is due on a day, not at an instant. Carrying Date objects would
 * make "today" depend on the server's timezone: a box running in UTC sees
 * 23:30 WAT as the previous day, and a patient whose medicine runs out
 * tomorrow would be shown as running out today for the last half hour of
 * every evening. Nigeria observes no daylight saving, so Africa/Lagos is a
 * fixed UTC+1 and lagosDate() is the one place an instant becomes a day.
 *
 * STATUS IS DERIVED, NEVER STORED
 * Same reasoning as customerActivity.js: a status that a background job
 * writes into a row is a status that is wrong from the moment the job stops
 * running. Due / overdue / lapsed are recomputed from run_out_on every time
 * they are read.
 */

/**
 * The first reminder window opens this many days before the medicine runs
 * out. Five days is enough for a patient to get to the pharmacy on a
 * weekday and for the pharmacy to reorder a line it is short of, without
 * reminding so early that the patient still has a full strip and ignores it.
 */
const REMIND_DAYS_BEFORE = 5;

/**
 * A patient who has been out of their medicine this long has lapsed: they
 * have either stopped, or are buying it somewhere else. Either way the right
 * next step is a pharmacist's phone call, not another automated message.
 */
const LAPSE_DAYS_AFTER = 7;

/**
 * Longest supply one dispense may cover. Six months is already generous for
 * a community pharmacy; anything longer is almost certainly a units mistake
 * (tablets typed where days were meant), and a journey that silently goes
 * quiet for a year is a patient nobody follows up.
 */
const MAX_DAYS_SUPPLY = 180;

const STATUSES = Object.freeze({
  UPCOMING: 'upcoming',
  DUE: 'due',
  OVERDUE: 'overdue',
  LAPSED: 'lapsed',
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const lagosFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The Lagos calendar date of an instant, as 'YYYY-MM-DD'. */
function lagosDate(instant = new Date()) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error(`lagosDate: not a valid instant: ${instant}`);
  // en-CA formats as YYYY-MM-DD, which is the whole reason it is used.
  return lagosFormatter.format(d);
}

/**
 * True for a real calendar date. The shape check alone accepts 2026-02-31,
 * which Date.UTC silently rolls into March, so the round trip is the check.
 */
function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function toUtcMs(isoDate) {
  if (!isIsoDate(isoDate)) throw new Error(`Expected a YYYY-MM-DD date, got ${JSON.stringify(isoDate)}`);
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Calendar arithmetic on date-only values. Done in UTC so no offset can shift the day. */
function addDays(isoDate, days) {
  return new Date(toUtcMs(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
function daysBetween(from, to) {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

function isPositiveNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * How many days one dispense lasts.
 *
 * Either the pharmacist states the days directly (a "30-day pack" is how
 * most chronic medicine is thought about at the counter), or it is worked
 * out from quantity and daily dose. An explicit number of days wins,
 * because it is the pharmacist's judgement and the arithmetic is a guess
 * about how the patient takes it.
 *
 * FLOORED, NOT ROUNDED. 45 tablets at 2 a day is 22.5 days: on day 23 the
 * patient has half a dose. Rounding up to 23 schedules the reminder a day
 * after they needed it; flooring to 22 schedules it a day early, which
 * costs nothing.
 *
 * @returns {{ok: true, days: number} | {ok: false, reason: string}}
 */
function daysSupplyFor({ daysSupply = null, quantity = null, unitsPerDay = null } = {}) {
  if (daysSupply !== null && daysSupply !== undefined) {
    if (!Number.isInteger(daysSupply) || daysSupply < 1) {
      return { ok: false, reason: 'DAYS_SUPPLY_NOT_A_POSITIVE_WHOLE_NUMBER' };
    }
    if (daysSupply > MAX_DAYS_SUPPLY) return { ok: false, reason: 'DAYS_SUPPLY_TOO_LONG' };
    return { ok: true, days: daysSupply };
  }

  if (quantity === null || quantity === undefined || unitsPerDay === null || unitsPerDay === undefined) {
    return { ok: false, reason: 'DAYS_SUPPLY_OR_QUANTITY_AND_DOSE_REQUIRED' };
  }
  if (!isPositiveNumber(quantity)) return { ok: false, reason: 'QUANTITY_NOT_POSITIVE' };
  if (!isPositiveNumber(unitsPerDay)) return { ok: false, reason: 'DOSE_NOT_POSITIVE' };

  const days = Math.floor(quantity / unitsPerDay);
  // 1 tablet at 2 a day is half a day of medicine. That is not a supply a
  // refill can be scheduled from; saying so beats scheduling one for today.
  if (days < 1) return { ok: false, reason: 'SUPPLY_LESS_THAN_ONE_DAY' };
  if (days > MAX_DAYS_SUPPLY) return { ok: false, reason: 'DAYS_SUPPLY_TOO_LONG' };
  return { ok: true, days };
}

/**
 * The first day the patient has none left.
 *
 * Dispensed on the 1st with 30 days' supply covers the 1st to the 30th, so
 * the run-out date is the 31st. Using the 30th would put every patient on
 * the overdue list on the last day they still have medicine.
 */
function runOutDate(dispensedOn, days) {
  if (!Number.isInteger(days) || days < 1) throw new Error(`runOutDate: days must be a positive whole number, got ${days}`);
  return addDays(dispensedOn, days);
}

/** The day the reminder window opens for a supply that runs out on `runOutOn`. */
function remindOn(runOutOn) {
  return addDays(runOutOn, -REMIND_DAYS_BEFORE);
}

/**
 * Where a supply stands today.
 *
 *   upcoming  more than REMIND_DAYS_BEFORE days left: nothing to do yet
 *   due       inside the reminder window, still has medicine
 *   overdue   has run out, within LAPSE_DAYS_AFTER days
 *   lapsed    out for LAPSE_DAYS_AFTER days or more: call them
 *
 * `daysLeft` is 0 on the run-out day and negative after it, so the screen
 * can say "runs out in 3 days" or "out for 2 days" from the same number.
 *
 * @returns {{status: string, daysLeft: number}}
 */
function refillStatus({ runOutOn, today }) {
  const daysLeft = daysBetween(today, runOutOn);
  if (daysLeft > REMIND_DAYS_BEFORE) return { status: STATUSES.UPCOMING, daysLeft };
  if (daysLeft > 0) return { status: STATUSES.DUE, daysLeft };
  if (-daysLeft < LAPSE_DAYS_AFTER) return { status: STATUSES.OVERDUE, daysLeft };
  return { status: STATUSES.LAPSED, daysLeft };
}

/** The statuses that put a patient on the call list. */
const NEEDS_ACTION = new Set([STATUSES.DUE, STATUSES.OVERDUE, STATUSES.LAPSED]);

/**
 * The profile's refill numbers, from journeys already labelled by
 * refillStatus (medicationJourneys.listJourneysForCustomer's shape).
 *
 *   due        needs a refill now: due, overdue and lapsed together. This is
 *              the number CustomerProfile.jsx shows in amber, so it must
 *              count every patient-medicine pair a pharmacist should act on.
 *   overdue    of those, already out of medicine
 *   lapsed     of those, out for LAPSE_DAYS_AFTER days or more
 *   completed  refills actually dispensed after the first supply
 *
 * A stopped journey still contributes its completed refills (they happened)
 * but never a due one (nobody should be chasing it).
 */
function refillCountsFrom(journeys) {
  const counts = { due: 0, overdue: 0, lapsed: 0, completed: 0 };
  for (const j of journeys) {
    counts.completed += j.completedRefills;
    if (j.status !== 'active' || !j.currentRefill) continue;
    const { status } = j.currentRefill;
    if (NEEDS_ACTION.has(status)) counts.due += 1;
    if (status === STATUSES.OVERDUE) counts.overdue += 1;
    if (status === STATUSES.LAPSED) counts.lapsed += 1;
  }
  return counts;
}

module.exports = {
  REMIND_DAYS_BEFORE, LAPSE_DAYS_AFTER, MAX_DAYS_SUPPLY, STATUSES,
  lagosDate, isIsoDate, addDays, daysBetween,
  daysSupplyFor, runOutDate, remindOn, refillStatus, refillCountsFrom,
};
