/**
 * Create a patient from the counter.
 *
 * WHAT THIS DOES NOT DO: insert into `customers`. It calls
 * `customerIdentity.resolveCustomer`, which is the only thing in this product
 * that has ever created a customer and is atomic by constraint rather than by
 * checking first.
 *
 * That matters for one specific reason. A patient created here carries the
 * SAME `identity_key` their WhatsApp messages will resolve to, so the first
 * time they message the pharmacy, the inbound ingest UPDATES this record
 * rather than creating a second one. A walk-in and their WhatsApp thread
 * become one patient. A hand-written INSERT would have worked today and
 * produced a duplicate the first time somebody texted.
 *
 * AN EXISTING PATIENT IS RETURNED, NOT REFUSED. `resolveCustomer` tells us
 * which branch of the upsert ran, so the screen can say "this patient is
 * already here, opening them" instead of a 409 the pharmacist cannot act on.
 * Somebody typing a number that turns out to be a known patient has found
 * them, not made a mistake.
 */

const { getSql, assertPharmacyId } = require('../db');
const { resolveCustomer } = require('./customerIdentity');
const { recordEvent } = require('./customerEvents');
const { PATIENT_EVENTS } = require('./patientEventTypes');

/**
 * @param {object} input  from `readNewPatientInput`
 * @returns {Promise<{customerId: string, created: boolean, identityKey: string}>}
 */
async function createPatient(pharmacyId, input, actor = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  return db.begin(async (tx) => {
    const { customerId, created, identityKey } = await resolveCustomer(tx, {
      pharmacyId,
      phone: input.phone,
      jid: input.jid,
      displayName: input.fullName,
    });

    // `display_name` is what WhatsApp calls them and `full_name` is what they
    // told this pharmacy when asked (0020). A pharmacist typing a name at a
    // counter is the second kind, so it is written as the authoritative one —
    // and NOT with coalesce, because correcting a name is a thing somebody
    // does on purpose.
    await tx`
      update customers set full_name = ${input.fullName}
      where id = ${customerId} and pharmacy_id = ${pharmacyId}
    `;

    // Sex and date of birth live on the profile, which is also where the
    // consultation banner reads the age from. Only written when given: an
    // absent value must stay absent rather than becoming a guess, which is
    // why the banner shows no age instead of 0.
    if (input.sex || input.dateOfBirth) {
      await tx`
        insert into patient_profiles (pharmacy_id, customer_id, sex, date_of_birth)
        values (${pharmacyId}, ${customerId}, ${input.sex}, ${input.dateOfBirth})
        on conflict (pharmacy_id, customer_id) do update
          set sex           = coalesce(excluded.sex, patient_profiles.sex),
              date_of_birth = coalesce(excluded.date_of_birth, patient_profiles.date_of_birth),
              updated_at    = now()
      `;
    }

    // Exactly once in a patient's lifetime, which is what `created` is for —
    // the ingest fires the same event on the same condition, so a patient who
    // walks in and later messages has ONE creation on their timeline.
    if (created) {
      await recordEvent(tx, {
        pharmacyId,
        customerId,
        eventType: PATIENT_EVENTS.PATIENT_CREATED,
        actorType: actor.actorRole ? 'staff' : 'system',
        actorId: actor.actorId || null,
        entityType: 'customer',
        entityId: customerId,
        metadata: { source: 'counter' },
        visibility: 'internal',
      });
    }

    return { customerId, created, identityKey };
  });
}

module.exports = { createPatient };
