/**
 * Medication journeys and refills: the write side, the profile counts, and
 * the pharmacist's refill call list.
 *
 * A JOURNEY EXISTS BECAUSE A PERSON SAID SO
 * Every write here is a staff action from the dashboard. Nothing is enrolled
 * from purchase history or from a conversation: the dose decides the date,
 * and only the pharmacist knows the dose. See 0052 for the full argument.
 *
 * EVERY WRITE IS ONE TRANSACTION WITH ITS TIMELINE EVENT
 * Same contract as orderService: the refill row and its REFILL_COMPLETED
 * event commit together or not at all, so the timeline can never show a
 * refill the tables do not have, or miss one they do.
 *
 * DATES ARE LAGOS CALENDAR DAYS
 * Every `date` column is selected as ::text. postgres.js would otherwise
 * hand back a Date at UTC midnight, and the first caller to format it in
 * local time would move the refill a day. refillSchedule.js owns the rules;
 * this file only stores and reads what they produce.
 *
 * Every function takes pharmacyId first and scopes on it, like the rest of
 * the services in this repository.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const {
  REMIND_DAYS_BEFORE, lagosDate, isIsoDate, addDays, daysBetween,
  daysSupplyFor, runOutDate, refillStatus, refillCountsFrom,
} = require('./refillSchedule');

const MAX_NAME = 200;
const MAX_REASON = 500;

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const SUPPLY_MESSAGES = {
  DAYS_SUPPLY_NOT_A_POSITIVE_WHOLE_NUMBER: 'Days of supply must be a whole number of days, 1 or more.',
  DAYS_SUPPLY_TOO_LONG: 'That supply is longer than 180 days. Check the units: days, not tablets or milligrams.',
  DAYS_SUPPLY_OR_QUANTITY_AND_DOSE_REQUIRED: 'Enter the days of supply, or the quantity and the daily dose.',
  QUANTITY_NOT_POSITIVE: 'Quantity must be more than 0.',
  DOSE_NOT_POSITIVE: 'Daily dose must be more than 0.',
  SUPPLY_LESS_THAN_ONE_DAY: 'That is less than one day of medicine, so there is no refill date to schedule.',
};

/**
 * The validated supply for one dispense, or a 400 naming what to fix.
 * `unitsPerDay` falls back to the journey's own dose so a refill can be
 * recorded as "60 tablets" without re-entering "2 a day".
 */
function resolveSupply({ dispensedOn, daysSupply, quantity, unitsPerDay, today }) {
  if (!isIsoDate(dispensedOn)) {
    throw httpError(400, 'INVALID_DISPENSED_ON', 'Dispensed date must be a real date in YYYY-MM-DD form.');
  }
  // A dispense recorded for tomorrow is a typo, and scheduling from it would
  // push the reminder past the day the patient actually runs out.
  if (daysBetween(today, dispensedOn) > 0) {
    throw httpError(400, 'DISPENSED_IN_FUTURE', 'Dispensed date cannot be in the future.');
  }
  const supply = daysSupplyFor({ daysSupply, quantity, unitsPerDay });
  if (!supply.ok) throw httpError(400, supply.reason, SUPPLY_MESSAGES[supply.reason] || 'Check the supply details.');
  return { days: supply.days, runOutOn: runOutDate(dispensedOn, supply.days) };
}

function optionalPositiveNumber(value, code, message) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw httpError(400, code, message);
  return n;
}

async function assertOwnedCustomer(sql, pharmacyId, customerId) {
  const [row] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Customer not found.');
  return row;
}

/** A unique-violation from Postgres, identified by constraint rather than message text. */
function isUniqueViolation(err, constraint) {
  return err && err.code === '23505' && (!constraint || err.constraint_name === constraint);
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/**
 * Enrol a patient on a medicine, recording the dispense that starts it.
 *
 * @param {string} pharmacyId
 * @param {string} customerId
 * @param {object} input
 * @param {string} [input.productId]     catalogue link; its name is the default
 * @param {string} [input.medicineName]  required when there is no productId
 * @param {number} [input.unitsPerDay]
 * @param {string} input.dispensedOn     'YYYY-MM-DD'
 * @param {number} [input.daysSupply]
 * @param {number} [input.quantity]
 * @param {string} [input.actorId]       the staff user, when there is one
 * @param {string} [input.today]         Lagos date; injectable for tests
 */
async function startJourney(pharmacyId, customerId, {
  productId = null, medicineName = null, unitsPerDay = null,
  dispensedOn, daysSupply = null, quantity = null,
  actorId = null, today = lagosDate(),
} = {}) {
  assertPharmacyId(pharmacyId);
  const dose = optionalPositiveNumber(unitsPerDay, 'DOSE_NOT_POSITIVE', SUPPLY_MESSAGES.DOSE_NOT_POSITIVE);
  const qty = optionalPositiveNumber(quantity, 'QUANTITY_NOT_POSITIVE', SUPPLY_MESSAGES.QUANTITY_NOT_POSITIVE);
  const supply = resolveSupply({ dispensedOn, daysSupply, quantity: qty, unitsPerDay: dose, today });

  const db = getSql();
  try {
    return await db.begin(async (tx) => {
      await assertOwnedCustomer(tx, pharmacyId, customerId);

      let name = String(medicineName || '').trim();
      if (productId) {
        // pharmacy_id in the WHERE: knowing another pharmacy's product id must
        // not be enough to link it, or to learn its name.
        const [product] = await tx`
          select name from products where id = ${productId} and pharmacy_id = ${pharmacyId}
        `;
        if (!product) throw httpError(404, 'PRODUCT_NOT_FOUND', 'That product is not in this pharmacy\'s catalogue.');
        if (!name) name = product.name;
      }
      if (!name) throw httpError(400, 'MEDICINE_NAME_REQUIRED', 'Choose a product or type the medicine name.');
      if (name.length > MAX_NAME) throw httpError(400, 'MEDICINE_NAME_TOO_LONG', `Medicine name cannot be longer than ${MAX_NAME} characters.`);

      const [journey] = await tx`
        insert into medication_journeys
          (pharmacy_id, customer_id, product_id, medicine_name, units_per_day, started_on, created_by)
        values
          (${pharmacyId}, ${customerId}, ${productId}, ${name}, ${dose}, ${dispensedOn}, ${actorId})
        returning id
      `;

      const [refill] = await tx`
        insert into refills
          (pharmacy_id, journey_id, customer_id, cycle, dispensed_on, days_supply, quantity, run_out_on, created_by)
        values
          (${pharmacyId}, ${journey.id}, ${customerId}, 1, ${dispensedOn}, ${supply.days}, ${qty},
           ${supply.runOutOn}, ${actorId})
        returning id
      `;

      await recordEvent(tx, {
        pharmacyId, customerId,
        eventType: PATIENT_EVENTS.MEDICATION_STARTED,
        actorType: 'staff', actorId,
        entityType: 'medication_journey', entityId: journey.id,
        idempotencyKey: `medication_started:${journey.id}`,
        metadata: { medicineName: name, daysSupply: supply.days, runOutOn: supply.runOutOn, refillId: refill.id },
      });

      return loadJourney(tx, pharmacyId, journey.id, today);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'idx_medication_journeys_one_active_per_medicine')) {
      throw httpError(409, 'JOURNEY_ALREADY_ACTIVE', 'This patient is already enrolled on that medicine. Record a refill on the existing one instead.');
    }
    throw err;
  }
}

/**
 * The patient came back: close the current supply and open the next.
 *
 * The event is REFILL_COMPLETED on the NEW refill row, keyed by that row's
 * id, so next month's refill is a distinct event rather than a duplicate the
 * idempotency index would swallow (see customerEvents.defaultIdempotencyKey).
 */
async function recordDispense(pharmacyId, journeyId, {
  dispensedOn, daysSupply = null, quantity = null, unitsPerDay = null,
  actorId = null, today = lagosDate(),
} = {}) {
  assertPharmacyId(pharmacyId);
  const qty = optionalPositiveNumber(quantity, 'QUANTITY_NOT_POSITIVE', SUPPLY_MESSAGES.QUANTITY_NOT_POSITIVE);
  const doseOverride = optionalPositiveNumber(unitsPerDay, 'DOSE_NOT_POSITIVE', SUPPLY_MESSAGES.DOSE_NOT_POSITIVE);

  const db = getSql();
  return db.begin(async (tx) => {
    // FOR UPDATE: two staff recording the same refill at once must not both
    // find the same open row and open two successors.
    const [journey] = await tx`
      select id, customer_id, medicine_name, status, units_per_day
      from medication_journeys
      where id = ${journeyId} and pharmacy_id = ${pharmacyId}
      for update
    `;
    if (!journey) throw httpError(404, 'NOT_FOUND', 'Medication journey not found.');
    if (journey.status !== 'active') {
      throw httpError(409, 'JOURNEY_STOPPED', 'This medicine was stopped. Start it again as a new medication to record a supply.');
    }

    const dose = doseOverride ?? (journey.units_per_day === null ? null : Number(journey.units_per_day));
    const supply = resolveSupply({ dispensedOn, daysSupply, quantity: qty, unitsPerDay: dose, today });

    const [current] = await tx`
      select id, cycle, dispensed_on::text as dispensed_on, run_out_on::text as run_out_on
      from refills
      where journey_id = ${journey.id} and pharmacy_id = ${pharmacyId} and status = 'open'
      for update
    `;
    // An active journey always has exactly one open supply (startJourney
    // opens it, this function replaces it, stopJourney closes it last). Its
    // absence is corrupted state, and inventing a cycle number would hide it.
    if (!current) throw httpError(409, 'NO_CURRENT_SUPPLY', 'This medicine has no current supply on record.');

    const sinceCurrent = daysBetween(current.dispensed_on, dispensedOn);
    if (sinceCurrent < 0) {
      throw httpError(400, 'DISPENSED_BEFORE_PREVIOUS', `The last supply was dispensed on ${current.dispensed_on}. A refill cannot be dated earlier.`);
    }
    // Two supplies of one medicine on one day is a double-clicked button or
    // two staff recording the same sale, not a patient who came back. Taken
    // at face value it would open a cycle the patient never had and push
    // their run-out date a month into the future.
    if (sinceCurrent === 0) {
      throw httpError(409, 'ALREADY_DISPENSED_THAT_DAY', `A supply of this medicine was already recorded on ${current.dispensed_on}.`);
    }

    await tx`
      update refills set status = 'completed', closed_at = now()
      where id = ${current.id} and pharmacy_id = ${pharmacyId}
    `;

    const [next] = await tx`
      insert into refills
        (pharmacy_id, journey_id, customer_id, cycle, dispensed_on, days_supply, quantity, run_out_on, created_by)
      values
        (${pharmacyId}, ${journey.id}, ${journey.customer_id}, ${current.cycle + 1}, ${dispensedOn},
         ${supply.days}, ${qty}, ${supply.runOutOn}, ${actorId})
      returning id
    `;

    await tx`update medication_journeys set updated_at = now() where id = ${journey.id}`;

    await recordEvent(tx, {
      pharmacyId, customerId: journey.customer_id,
      eventType: PATIENT_EVENTS.REFILL_COMPLETED,
      actorType: 'staff', actorId,
      entityType: 'refill', entityId: next.id,
      idempotencyKey: `refill_completed:${next.id}`,
      metadata: {
        journeyId: journey.id,
        medicineName: journey.medicine_name,
        cycle: current.cycle + 1,
        daysSupply: supply.days,
        runOutOn: supply.runOutOn,
        // Positive = came back after running out; negative = came back early.
        // The adherence signal, recorded as a number rather than a verdict.
        daysAfterRunOut: daysBetween(current.run_out_on, dispensedOn),
      },
    });

    return loadJourney(tx, pharmacyId, journey.id, today);
  });
}

/**
 * The patient is no longer followed on this medicine. The current supply is
 * cancelled so they leave the call list today, not when it would have run out.
 * The reason stays on the journey row and is NOT copied into the event, for
 * the same reason customerCrm keeps note text out of NOTE_ADDED.
 */
async function stopJourney(pharmacyId, journeyId, { reason = null, actorId = null, today = lagosDate() } = {}) {
  assertPharmacyId(pharmacyId);
  const text = reason === null || reason === undefined ? null : String(reason).trim() || null;
  if (text && text.length > MAX_REASON) {
    throw httpError(400, 'STOP_REASON_TOO_LONG', `Reason cannot be longer than ${MAX_REASON} characters.`);
  }

  const db = getSql();
  return db.begin(async (tx) => {
    const [journey] = await tx`
      update medication_journeys
      set status = 'stopped', stopped_at = now(), stop_reason = ${text}, updated_at = now()
      where id = ${journeyId} and pharmacy_id = ${pharmacyId} and status = 'active'
      returning id, customer_id, medicine_name
    `;
    if (!journey) {
      const [exists] = await tx`
        select status from medication_journeys where id = ${journeyId} and pharmacy_id = ${pharmacyId}
      `;
      if (!exists) throw httpError(404, 'NOT_FOUND', 'Medication journey not found.');
      throw httpError(409, 'ALREADY_STOPPED', 'This medicine was already stopped.');
    }

    await tx`
      update refills set status = 'cancelled', closed_at = now()
      where journey_id = ${journey.id} and pharmacy_id = ${pharmacyId} and status = 'open'
    `;

    // MEDICATION_COMPLETED is the vocabulary's "this journey ended". It does
    // not claim the course was finished as prescribed; the reason on the row
    // says why it ended.
    await recordEvent(tx, {
      pharmacyId, customerId: journey.customer_id,
      eventType: PATIENT_EVENTS.MEDICATION_COMPLETED,
      actorType: 'staff', actorId,
      entityType: 'medication_journey', entityId: journey.id,
      idempotencyKey: `medication_stopped:${journey.id}`,
      metadata: { medicineName: journey.medicine_name, reasonGiven: Boolean(text) },
    });

    return loadJourney(tx, pharmacyId, journey.id, today);
  });
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

function toJourneyView(row, today) {
  const current = row.current_refill_id
    ? {
      id: row.current_refill_id,
      cycle: row.current_cycle,
      dispensedOn: row.current_dispensed_on,
      daysSupply: row.current_days_supply,
      runOutOn: row.current_run_out_on,
      ...refillStatus({ runOutOn: row.current_run_out_on, today }),
    }
    : null;
  return {
    id: row.id,
    // `name` is what CustomerProfile.jsx already renders for each journey.
    name: row.medicine_name,
    productId: row.product_id,
    unitsPerDay: row.units_per_day === null ? null : Number(row.units_per_day),
    status: row.status,
    stopReason: row.stop_reason,
    startedOn: row.started_on,
    stoppedAt: row.stopped_at,
    completedRefills: row.completed_refills,
    currentRefill: current,
  };
}

async function selectJourneys(sql, pharmacyId, { journeyId = null, customerId = null }) {
  return sql`
    select j.id, j.medicine_name, j.product_id, j.units_per_day, j.status, j.stop_reason,
           j.started_on::text as started_on, j.stopped_at,
           r.id as current_refill_id, r.cycle as current_cycle,
           r.dispensed_on::text as current_dispensed_on, r.days_supply as current_days_supply,
           r.run_out_on::text as current_run_out_on,
           (select count(*)::int from refills c
             where c.journey_id = j.id and c.pharmacy_id = ${pharmacyId} and c.status = 'completed') as completed_refills
    from medication_journeys j
    left join refills r
      on r.journey_id = j.id and r.pharmacy_id = ${pharmacyId} and r.status = 'open'
    where j.pharmacy_id = ${pharmacyId}
      ${journeyId ? sql`and j.id = ${journeyId}` : sql``}
      ${customerId ? sql`and j.customer_id = ${customerId}` : sql``}
    order by (j.status = 'active') desc, r.run_out_on asc nulls last, j.created_at desc
  `;
}

async function loadJourney(sql, pharmacyId, journeyId, today) {
  const [row] = await selectJourneys(sql, pharmacyId, { journeyId });
  return row ? toJourneyView(row, today) : null;
}

/** Every journey for one patient, active first, soonest run-out first. */
async function listJourneysForCustomer(pharmacyId, customerId, { today = lagosDate(), sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  await assertOwnedCustomer(db, pharmacyId, customerId);
  const rows = await selectJourneys(db, pharmacyId, { customerId });
  return rows.map((r) => toJourneyView(r, today));
}

/**
 * The pharmacist's call list: every current supply of an active journey that
 * is due, overdue or lapsed today, soonest run-out first.
 *
 * The SQL bound (run_out_on <= today + REMIND_DAYS_BEFORE) is exactly the
 * complement of UPCOMING in refillStatus, so the index does the filtering and
 * refillStatus still decides the label. A test pins that the two agree.
 *
 * Communication fields travel with each row so the screen can say "cannot be
 * messaged — opted out" before anyone tries.
 */
async function listRefillQueue(pharmacyId, { today = lagosDate(), limit = 200 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const horizon = addDays(today, REMIND_DAYS_BEFORE);
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);

  const rows = await db`
    select r.id as refill_id, r.cycle, r.dispensed_on::text as dispensed_on, r.days_supply,
           r.run_out_on::text as run_out_on,
           j.id as journey_id, j.medicine_name,
           c.id as customer_id, c.full_name, c.display_name, c.wa_phone,
           c.communication_status, c.comm_medication
    from refills r
    join medication_journeys j on j.id = r.journey_id and j.pharmacy_id = ${pharmacyId} and j.status = 'active'
    join customers c on c.id = r.customer_id and c.pharmacy_id = ${pharmacyId}
    where r.pharmacy_id = ${pharmacyId}
      and r.status = 'open'
      and r.run_out_on <= ${horizon}
    order by r.run_out_on asc, r.id
    limit ${cap}
  `;

  const items = rows.map((r) => ({
    refillId: r.refill_id,
    journeyId: r.journey_id,
    medicineName: r.medicine_name,
    cycle: r.cycle,
    dispensedOn: r.dispensed_on,
    daysSupply: r.days_supply,
    runOutOn: r.run_out_on,
    ...refillStatus({ runOutOn: r.run_out_on, today }),
    customer: {
      id: r.customer_id,
      name: r.full_name || r.display_name || null,
      phone: r.wa_phone,
      optedOut: r.communication_status === 'opted_out',
      medicationMessages: r.comm_medication === true,
    },
  }));

  const counts = { due: 0, overdue: 0, lapsed: 0 };
  for (const item of items) counts[item.status] += 1;

  return { today, counts, items };
}

module.exports = {
  startJourney, recordDispense, stopJourney,
  listJourneysForCustomer, refillCountsFrom, listRefillQueue,
};
