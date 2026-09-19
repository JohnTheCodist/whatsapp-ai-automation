/**
 * Medication journeys and refills, against real Postgres.
 *
 * What these defend:
 *
 *   - a patient on the refill call list is a real current supply, due today,
 *     for a medicine a pharmacist actually enrolled — never a guess;
 *   - one pharmacy can never enrol, refill, stop, list or even name another
 *     pharmacy's patient, journey or product;
 *   - a double-clicked button, or two staff recording one sale, cannot give
 *     a patient a refill cycle they never had;
 *   - the SQL that picks the call list and the rules that label it
 *     (refillSchedule.js) cannot drift apart at the boundary day.
 *
 * `today` is injected as a fixed Lagos date so every assertion about due /
 * overdue / lapsed is about the rule, not about the day the suite runs.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — medication journeys and refills NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const TAG = 'medjourneytest';
const TODAY = '2026-09-19';

let db;
let svc;
let getCustomerProfile;
let ctx = null;
let phoneSeq = 0;

async function newCustomer(pharmacyId, overrides = {}) {
  phoneSeq += 1;
  const phone = `23490710${String(phoneSeq).padStart(5, '0')}`;
  const [row] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name,
                           communication_status, comm_medication)
    values (${pharmacyId}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, 'Journey Tester',
            ${overrides.fullName || 'Journey Tester'},
            ${overrides.communicationStatus || 'subscribed'}, ${overrides.commMedication ?? true})
    returning id
  `;
  return row.id;
}

async function eventsFor(customerId, eventType) {
  return db`
    select entity_type, entity_id, metadata, actor_type
    from customer_events
    where customer_id = ${customerId} and event_type = ${eventType}
    order by id
  `;
}

async function openRefills(journeyId) {
  // Plain objects in a plain array: postgres.js returns a Result subclass,
  // which strict deepEqual would reject on prototype alone.
  const rows = await db`select id, cycle from refills where journey_id = ${journeyId} and status = 'open'`;
  return rows.map((r) => ({ id: r.id, cycle: r.cycle }));
}

before(async () => {
  if (SKIP) return;
  db = require('../services/db').getSql();
  svc = require('../services/refills/medicationJourneys');
  ({ getCustomerProfile } = require('../services/customers/customerProfile'));

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  const [prodA] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, status)
    values (${a.id}, 'Amlodipine 5mg Tablets x28', ${`${TAG}-amlo-${crypto.randomUUID()}`}, 250000, 'active')
    returning id`;
  const [prodB] = await db`
    insert into products (pharmacy_id, name, natural_key, price_kobo, status)
    values (${b.id}, 'Beta Secret Product', ${`${TAG}-beta-${crypto.randomUUID()}`}, 100000, 'active')
    returning id`;

  ctx = { userA, userB, a, b, prodA, prodB, custB: await newCustomer(b.id) };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- starting a journey --------------------------------------------------

test('enrolling a patient opens their first supply with the run-out date the rules give', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, {
    medicineName: 'Metformin 500mg', unitsPerDay: 2, quantity: 60,
    dispensedOn: '2026-09-01', actorId: ctx.userA, today: TODAY,
  });

  assert.equal(journey.name, 'Metformin 500mg');
  assert.equal(journey.status, 'active');
  assert.equal(journey.unitsPerDay, 2);
  assert.equal(journey.completedRefills, 0);
  assert.equal(journey.currentRefill.cycle, 1);
  assert.equal(journey.currentRefill.daysSupply, 30);
  assert.equal(journey.currentRefill.runOutOn, '2026-10-01');
  assert.equal(journey.currentRefill.status, 'upcoming');
  assert.deepEqual(await openRefills(journey.id), [{ id: journey.currentRefill.id, cycle: 1 }]);

  const events = await eventsFor(customerId, 'MEDICATION_STARTED');
  assert.equal(events.length, 1);
  assert.equal(events[0].entity_type, 'medication_journey');
  assert.equal(events[0].entity_id, journey.id);
  assert.equal(events[0].actor_type, 'staff');
  assert.equal(events[0].metadata.runOutOn, '2026-10-01');
});

test('a catalogue product supplies the medicine name when none is typed', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, {
    productId: ctx.prodA.id, daysSupply: 28, dispensedOn: '2026-09-10', today: TODAY,
  });
  assert.equal(journey.name, 'Amlodipine 5mg Tablets x28');
  assert.equal(journey.productId, ctx.prodA.id);
});

test('another pharmacy\'s product can neither be linked nor have its name revealed', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, customerId, { productId: ctx.prodB.id, daysSupply: 30, dispensedOn: '2026-09-10', today: TODAY }),
    (err) => err.status === 404 && err.code === 'PRODUCT_NOT_FOUND' && !err.message.includes('Beta Secret'),
  );
  const [{ n }] = await db`select count(*)::int as n from medication_journeys where customer_id = ${customerId}`;
  assert.equal(n, 0, 'a refused enrolment must leave nothing behind');
});

test('another pharmacy\'s patient cannot be enrolled', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, ctx.custB, { medicineName: 'Anything', daysSupply: 30, dispensedOn: '2026-09-10', today: TODAY }),
    (err) => err.status === 404 && err.code === 'NOT_FOUND',
  );
});

test('a journey with no name and no product is refused, not saved as blank', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, customerId, { medicineName: '   ', daysSupply: 30, dispensedOn: '2026-09-10', today: TODAY }),
    (err) => err.status === 400 && err.code === 'MEDICINE_NAME_REQUIRED',
  );
});

test('a dispense dated in the future is refused', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, customerId, { medicineName: 'Lisinopril', daysSupply: 30, dispensedOn: '2026-09-20', today: TODAY }),
    (err) => err.status === 400 && err.code === 'DISPENSED_IN_FUTURE',
  );
});

test('supply mistakes come back as a 400 naming what to fix', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, customerId, { medicineName: 'Lisinopril', daysSupply: 500, dispensedOn: '2026-09-10', today: TODAY }),
    (err) => err.status === 400 && err.code === 'DAYS_SUPPLY_TOO_LONG',
  );
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, customerId, { medicineName: 'Lisinopril', dispensedOn: '2026-09-10', today: TODAY }),
    (err) => err.status === 400 && err.code === 'DAYS_SUPPLY_OR_QUANTITY_AND_DOSE_REQUIRED',
  );
});

test('the same medicine cannot be enrolled twice for one patient, whatever its case or spacing', { skip: SKIP && skipReason }, async () => {
  // Two journeys would mean two reminders for one strip and the patient on
  // the call list twice with two run-out dates.
  const customerId = await newCustomer(ctx.a.id);
  await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Amlodipine 10mg', daysSupply: 30, dispensedOn: '2026-09-10', today: TODAY });
  await assert.rejects(
    () => svc.startJourney(ctx.a.id, customerId, { medicineName: '  amlodipine 10MG ', daysSupply: 30, dispensedOn: '2026-09-11', today: TODAY }),
    (err) => err.status === 409 && err.code === 'JOURNEY_ALREADY_ACTIVE',
  );
});

test('a stopped medicine can be started again', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const first = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Nifedipine', daysSupply: 30, dispensedOn: '2026-08-01', today: TODAY });
  await svc.stopJourney(ctx.a.id, first.id, { reason: 'Switched by doctor', today: TODAY });
  const again = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Nifedipine', daysSupply: 30, dispensedOn: '2026-09-15', today: TODAY });
  assert.notEqual(again.id, first.id);
  assert.equal(again.status, 'active');
});

// ---- recording a refill --------------------------------------------------

test('a refill closes the current supply, opens the next cycle, and records how late it was', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, {
    medicineName: 'Losartan 50mg', daysSupply: 30, dispensedOn: '2026-08-01', today: TODAY,
  });
  // Ran out on 2026-08-31, came back on 2026-09-03: three days late.
  const after = await svc.recordDispense(ctx.a.id, journey.id, { daysSupply: 30, dispensedOn: '2026-09-03', actorId: ctx.userA, today: TODAY });

  assert.equal(after.completedRefills, 1);
  assert.equal(after.currentRefill.cycle, 2);
  assert.equal(after.currentRefill.runOutOn, '2026-10-03');
  assert.equal((await openRefills(journey.id)).length, 1);

  const [event] = await eventsFor(customerId, 'REFILL_COMPLETED');
  assert.equal(event.entity_type, 'refill');
  assert.equal(event.entity_id, after.currentRefill.id);
  assert.equal(event.metadata.cycle, 2);
  assert.equal(event.metadata.daysAfterRunOut, 3);
});

test('next month\'s refill is a second event, not swallowed as a duplicate of this month\'s', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Glibenclamide', daysSupply: 30, dispensedOn: '2026-06-01', today: TODAY });
  await svc.recordDispense(ctx.a.id, journey.id, { daysSupply: 30, dispensedOn: '2026-07-01', today: TODAY });
  const third = await svc.recordDispense(ctx.a.id, journey.id, { daysSupply: 30, dispensedOn: '2026-07-31', today: TODAY });
  assert.equal(third.completedRefills, 2);
  assert.equal((await eventsFor(customerId, 'REFILL_COMPLETED')).length, 2);
});

test('a refill given as a quantity uses the dose stored on the journey', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, {
    medicineName: 'Metformin 850mg', unitsPerDay: 2, quantity: 56, dispensedOn: '2026-08-20', today: TODAY,
  });
  const after = await svc.recordDispense(ctx.a.id, journey.id, { quantity: 60, dispensedOn: '2026-09-15', today: TODAY });
  assert.equal(after.currentRefill.daysSupply, 30);
});

test('a refill dated before the current supply is refused', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Atenolol', daysSupply: 30, dispensedOn: '2026-09-10', today: TODAY });
  await assert.rejects(
    () => svc.recordDispense(ctx.a.id, journey.id, { daysSupply: 30, dispensedOn: '2026-09-09', today: TODAY }),
    (err) => err.status === 400 && err.code === 'DISPENSED_BEFORE_PREVIOUS',
  );
});

test('two supplies of one medicine on the same day are refused as a duplicate', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Hydrochlorothiazide', daysSupply: 30, dispensedOn: '2026-09-19', today: TODAY });
  await assert.rejects(
    () => svc.recordDispense(ctx.a.id, journey.id, { daysSupply: 30, dispensedOn: '2026-09-19', today: TODAY }),
    (err) => err.status === 409 && err.code === 'ALREADY_DISPENSED_THAT_DAY',
  );
  assert.equal((await svc.listJourneysForCustomer(ctx.a.id, customerId, { today: TODAY }))[0].currentRefill.cycle, 1);
});

test('the same refill recorded twice at once produces exactly one new cycle', { skip: SKIP && skipReason }, async () => {
  // Two staff at two tills, or one double-click that sends two requests.
  // FOR UPDATE makes the second wait; the same-day rule then refuses it.
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Carvedilol', daysSupply: 30, dispensedOn: '2026-08-15', today: TODAY });
  const input = { daysSupply: 30, dispensedOn: '2026-09-14', today: TODAY };
  const results = await Promise.allSettled([
    svc.recordDispense(ctx.a.id, journey.id, input),
    svc.recordDispense(ctx.a.id, journey.id, input),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.code, 'ALREADY_DISPENSED_THAT_DAY');
  assert.deepEqual((await openRefills(journey.id)).map((r) => r.cycle), [2]);
});

test('another pharmacy cannot record a refill on this pharmacy\'s journey', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Bisoprolol', daysSupply: 30, dispensedOn: '2026-08-15', today: TODAY });
  await assert.rejects(
    () => svc.recordDispense(ctx.b.id, journey.id, { daysSupply: 30, dispensedOn: '2026-09-14', today: TODAY }),
    (err) => err.status === 404,
  );
  assert.equal((await openRefills(journey.id))[0].cycle, 1);
});

// ---- stopping ------------------------------------------------------------

test('stopping a medicine cancels its current supply and keeps the reason off the timeline', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Enalapril', daysSupply: 30, dispensedOn: '2026-08-01', today: TODAY });
  const stopped = await svc.stopJourney(ctx.a.id, journey.id, { reason: 'Cough — changed to losartan', today: TODAY });

  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopReason, 'Cough — changed to losartan');
  assert.equal(stopped.currentRefill, null);
  assert.equal((await openRefills(journey.id)).length, 0);

  const [event] = await eventsFor(customerId, 'MEDICATION_COMPLETED');
  assert.deepEqual(event.metadata, { medicineName: 'Enalapril', reasonGiven: true });
});

test('a stopped medicine refuses a refill and refuses to be stopped again', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Propranolol', daysSupply: 30, dispensedOn: '2026-08-01', today: TODAY });
  await svc.stopJourney(ctx.a.id, journey.id, { today: TODAY });
  await assert.rejects(
    () => svc.recordDispense(ctx.a.id, journey.id, { daysSupply: 30, dispensedOn: '2026-09-01', today: TODAY }),
    (err) => err.status === 409 && err.code === 'JOURNEY_STOPPED',
  );
  await assert.rejects(
    () => svc.stopJourney(ctx.a.id, journey.id, { today: TODAY }),
    (err) => err.status === 409 && err.code === 'ALREADY_STOPPED',
  );
});

test('another pharmacy cannot stop this pharmacy\'s journey', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const journey = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Spironolactone', daysSupply: 30, dispensedOn: '2026-08-15', today: TODAY });
  await assert.rejects(() => svc.stopJourney(ctx.b.id, journey.id, { today: TODAY }), (err) => err.status === 404);
  const [row] = await db`select status from medication_journeys where id = ${journey.id}`;
  assert.equal(row.status, 'active');
});

// ---- the call list -------------------------------------------------------

test('the call list holds due, overdue and lapsed supplies, soonest first, and nothing upcoming or stopped', { skip: SKIP && skipReason }, async () => {
  // A dedicated pharmacy so other tests' journeys cannot appear in the list.
  const userC = crypto.randomUUID();
  await db`insert into auth.users (id, email) values (${userC}, ${`${TAG}-c-${userC}@example.test`})`;
  const c = await require('../services/pharmacies').createPharmacy(userC, { name: `${TAG} Gamma` });
  try {
    const enrol = async (name, dispensedOn) => svc.startJourney(c.id, await newCustomer(c.id, { fullName: name }), {
      medicineName: `${name} med`, daysSupply: 30, dispensedOn, today: TODAY,
    });
    // run-out = dispensedOn + 30
    await enrol('Upcoming', '2026-08-26');     // runs out 09-25: 6 days left → upcoming, excluded
    await enrol('DueEdge', '2026-08-25');      // 09-24: 5 days left → due (window opens today)
    await enrol('Overdue', '2026-08-18');      // 09-17: out 2 days → overdue
    await enrol('Lapsed', '2026-08-01');       // 08-31: out 19 days → lapsed
    const stopped = await enrol('Stopped', '2026-08-01');
    await svc.stopJourney(c.id, stopped.id, { today: TODAY });

    const queue = await svc.listRefillQueue(c.id, { today: TODAY });
    assert.deepEqual(queue.items.map((i) => [i.customer.name, i.status, i.daysLeft]), [
      ['Lapsed', 'lapsed', -19],
      ['Overdue', 'overdue', -2],
      ['DueEdge', 'due', 5],
    ]);
    assert.deepEqual(queue.counts, { due: 1, overdue: 1, lapsed: 1 });
    assert.equal(queue.today, TODAY);
  } finally {
    await db`delete from pharmacies where id = ${c.id}`;
    await db`delete from auth.users where id = ${userC}`;
  }
});

test('the call list never shows another pharmacy\'s patients', { skip: SKIP && skipReason }, async () => {
  await svc.startJourney(ctx.b.id, ctx.custB, { medicineName: 'Beta Only Med', daysSupply: 30, dispensedOn: '2026-08-01', today: TODAY });
  const queue = await svc.listRefillQueue(ctx.a.id, { today: TODAY });
  assert.ok(queue.items.every((i) => i.medicineName !== 'Beta Only Med'));
  assert.ok(queue.items.every((i) => i.customer.id !== ctx.custB));
});

test('an opted-out patient is still listed, and marked as not messageable', { skip: SKIP && skipReason }, async () => {
  // They opted out of messages, not out of being a patient. A pharmacist can
  // still see they are overdue and speak to them at the counter.
  const customerId = await newCustomer(ctx.a.id, { communicationStatus: 'opted_out', commMedication: false });
  await svc.startJourney(ctx.a.id, customerId, { medicineName: 'OptOut Med', daysSupply: 30, dispensedOn: '2026-08-10', today: TODAY });
  const item = (await svc.listRefillQueue(ctx.a.id, { today: TODAY })).items.find((i) => i.customer.id === customerId);
  assert.ok(item);
  assert.equal(item.customer.optedOut, true);
  assert.equal(item.customer.medicationMessages, false);
});

// ---- the profile ---------------------------------------------------------

test('the profile shows real journeys and counts every refill that needs action as due', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const overdue = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Profile Overdue', daysSupply: 30, dispensedOn: '2026-08-18', today: TODAY });
  await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Profile Upcoming', daysSupply: 30, dispensedOn: '2026-09-15', today: TODAY });
  const lapsed = await svc.startJourney(ctx.a.id, customerId, { medicineName: 'Profile Lapsed', daysSupply: 30, dispensedOn: '2026-06-01', today: TODAY });
  await svc.recordDispense(ctx.a.id, lapsed.id, { daysSupply: 30, dispensedOn: '2026-07-10', today: TODAY });

  const profile = await getCustomerProfile(ctx.a.id, customerId);
  assert.equal(profile.medicationJourneys.length, 3);
  assert.ok(profile.medicationJourneys.some((j) => j.id === overdue.id && j.name === 'Profile Overdue'));
  // Counts are computed against the real Lagos today, so only the facts that
  // cannot depend on the run date are pinned: one refill was dispensed, and
  // "due" is the sum of the three statuses that need action.
  assert.equal(profile.refills.completed, 1);
  assert.ok(profile.refills.due >= profile.refills.overdue + profile.refills.lapsed);
});

test('a patient with no journeys still gets an empty list and zero refills, never a placeholder', { skip: SKIP && skipReason }, async () => {
  const customerId = await newCustomer(ctx.a.id);
  const profile = await getCustomerProfile(ctx.a.id, customerId);
  assert.deepEqual(profile.medicationJourneys, []);
  assert.deepEqual(profile.refills, { due: 0, overdue: 0, lapsed: 0, completed: 0 });
});
