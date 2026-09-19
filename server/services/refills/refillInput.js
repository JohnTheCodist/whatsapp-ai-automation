/**
 * The HTTP contract for the refill routes: request bodies in, service
 * arguments out.
 *
 * WHY THIS IS ITS OWN TESTED MODULE
 * A form field arrives as the string "30". refillSchedule.daysSupplyFor
 * rightly refuses a string — so without this layer, every enrolment typed
 * into the dashboard would fail with "days must be a whole number" while
 * every test calling the service with real numbers passed. That is the same
 * shape as the WhatsApp-number field recorded in AGENTS.md (2026-09-09): the
 * two halves of a contract disagreeing silently, with nothing to catch it.
 * The field names and the coercion rules live here, once, under test.
 *
 * PURE. The caller passes `today`, so the default dispense date is testable.
 *
 * WHAT IS NOT COERCED
 * "abc" becomes NaN, not null. NaN reaches the schedule rules and is refused
 * with the message for that field; null would mean "not given" and could
 * make the service fall back to a different input the pharmacist did not
 * intend.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** '' / null / undefined mean "not given". Anything else is a number, or NaN. */
function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text) return null;
  return Number(text);
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * A path or body id. A malformed id names nothing, so it gets the same 404
 * as an id that belongs to another pharmacy — never a different error that
 * would tell a caller which ids are well-formed guesses. It also keeps a
 * garbage string from reaching Postgres as a uuid and surfacing as a 500.
 */
function requireId(value, what = 'Record') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw httpError(404, 'NOT_FOUND', `${what} not found.`);
  }
  return value;
}

/** The dispense date: as given, or today in Lagos when left blank. */
function dispensedOnFrom(value, today) {
  return textOrNull(value) || today;
}

/** POST /api/customers/:id/medications */
function readJourneyStart(body = {}, { today }) {
  const productId = textOrNull(body.productId);
  if (productId && !UUID_RE.test(productId)) {
    throw httpError(404, 'PRODUCT_NOT_FOUND', 'That product is not in this pharmacy\'s catalogue.');
  }
  return {
    productId,
    medicineName: textOrNull(body.medicineName),
    unitsPerDay: numberOrNull(body.unitsPerDay),
    dispensedOn: dispensedOnFrom(body.dispensedOn, today),
    daysSupply: numberOrNull(body.daysSupply),
    quantity: numberOrNull(body.quantity),
  };
}

/** POST /api/refills/journeys/:journeyId/dispense */
function readDispense(body = {}, { today }) {
  return {
    dispensedOn: dispensedOnFrom(body.dispensedOn, today),
    daysSupply: numberOrNull(body.daysSupply),
    quantity: numberOrNull(body.quantity),
    unitsPerDay: numberOrNull(body.unitsPerDay),
  };
}

/** POST /api/refills/journeys/:journeyId/stop */
function readStop(body = {}) {
  return { reason: textOrNull(body.reason) };
}

module.exports = {
  numberOrNull, textOrNull, requireId, readJourneyStart, readDispense, readStop,
};
