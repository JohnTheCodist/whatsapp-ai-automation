/**
 * Who is this, and have we met them before?
 *
 * ONE WHATSAPP IDENTITY -> ONE CUSTOMER PER PHARMACY. Everything else —
 * conversations, orders, timeline events, future medication journeys — hangs
 * off the id this module returns, so a duplicate here silently splits a
 * person's history in two and no later feature can put it back together.
 *
 * WHY THE PHONE NUMBER IS THE IDENTITY AND THE JID IS NOT
 * 0016 made (pharmacy_id, wa_jid) the unique key, because wa_phone could
 * degrade into a LID string and a column called "phone" holding an opaque id
 * is worse than useless. That fixed the display problem and introduced a
 * subtler one, which the live data makes obvious: every customer on this
 * account is addressed by LID, e.g.
 *
 *     phone 2349013993683   lid 198350347493478   jid 198350347493478@lid
 *
 * The LID is an identifier WhatsApp assigns and can change; it is not a
 * property of the person. Key identity on it and the same human returning
 * under a new LID — or after WhatsApp flips their addressing mode — becomes
 * a second customer with an empty history. That is exactly the "returning
 * after six months must be the same patient" requirement, failing quietly.
 *
 * The phone number is the thing that is actually stable about a person. So:
 * identity is the normalised phone WHEN WE HAVE ONE, and falls back to the
 * LID only for a sender WhatsApp gave us no number for. Both live in one
 * `identity_key` column so there is a single unambiguous unique constraint
 * rather than two partial ones that can disagree.
 *
 * wa_phone / wa_lid / wa_jid keep their existing jobs: what a human reads,
 * and what we route replies to. Identity is now its own concern, which is
 * what 0003 was already arguing for.
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * A phone number in canonical international digits, or null.
 *
 * Replaces a hand-rolled version that treated ANY leading zero as Nigerian:
 * a UK mobile typed as 07911123456 became 2347911123456, a real Nigerian
 * number belonging to somebody else. That is an identity collision between
 * two different people, which is the worst failure this file can have.
 *
 * Digits are returned without the leading '+' to match how WhatsApp gives
 * them to us and how every existing row is already stored.
 */
function normalizePhone(input, defaultCountry = 'NG') {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // WhatsApp hands us bare international digits ("2349013993683"), which the
  // parser rejects without either a '+' or a country hint — it cannot tell
  // them from a local number. Anything already long enough to carry a country
  // code is tried as international first.
  const candidates = raw.startsWith('+')
    ? [raw]
    : [`+${raw.replace(/[^0-9]/g, '')}`, raw];

  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
    if (parsed && parsed.isValid()) return parsed.number.replace(/^\+/, '');
  }
  return null;
}

/**
 * The stable key a customer is identified by within one pharmacy.
 *
 * Prefixed when it is NOT a phone number, so the two can never be confused
 * and a future reader can see at a glance which senders we lack a number
 * for. A bare value is always a real, validated phone number.
 *
 * @returns {string|null} null only when there is nothing identifying at all,
 *   which the caller must treat as unroutable rather than inventing a key.
 */
function identityKeyFor({ phone, lid, jid }, defaultCountry = 'NG') {
  const normalised = normalizePhone(phone, defaultCountry);
  if (normalised) return normalised;
  if (lid) return `lid:${lid}`;
  if (jid) return `jid:${jid}`;
  return null;
}

/**
 * Find this person, or create them. Never both, never twice.
 *
 * ATOMIC BY CONSTRAINT, NOT BY CHECKING FIRST. A single INSERT ... ON
 * CONFLICT guarded by the unique index on (pharmacy_id, identity_key).
 * Two first messages arriving on overlapping connections cannot produce two
 * rows: the second insert blocks on the index, sees the first committed, and
 * updates instead. A `select then insert if missing` would race exactly in
 * the window this product hits most — a new customer sending two messages in
 * quick succession.
 *
 * WHAT IS AND IS NOT REFRESHED
 * identity_key is the conflict target, so it is never in the SET clause — by
 * definition it already matches. wa_jid, wa_lid and display_name ARE
 * refreshed: a returning customer may be addressed by a new JID, and that is
 * the routing we must reply to. This is the merge that makes a six-month
 * return resolve to the original record rather than a new one.
 *
 * display_name uses coalesce so a message arriving without a pushName does
 * not erase a name we already had. The name is a profile attribute and never
 * part of identity — "John" becoming "John Doe" must not create a customer.
 *
 * @param {object} sql  a postgres.js instance or an open transaction
 * @returns {Promise<{customerId: string, created: boolean, identityKey: string}>}
 */
async function resolveCustomer(sql, {
  pharmacyId, phone, lid, jid, displayName = null, defaultCountry = 'NG',
}) {
  if (!pharmacyId) throw new Error('resolveCustomer requires pharmacyId — it is server-controlled, never optional.');

  const identityKey = identityKeyFor({ phone, lid, jid }, defaultCountry);
  if (!identityKey) {
    throw new Error('Cannot resolve a customer with no phone number, LID or JID — there is nothing to identify them by.');
  }

  // Store the human-readable number only when it really is one. Writing a
  // LID into wa_phone is the bug 0003 was written to fix.
  const readablePhone = normalizePhone(phone, defaultCountry);

  const [row] = await sql`
    insert into customers
      (pharmacy_id, identity_key, wa_phone, wa_lid, wa_jid, display_name, last_seen_at)
    values
      (${pharmacyId}, ${identityKey}, ${readablePhone}, ${lid || null}, ${jid || null},
       ${displayName || null}, now())
    on conflict (pharmacy_id, identity_key) do update
      set last_seen_at = now(),
          wa_jid       = coalesce(excluded.wa_jid, customers.wa_jid),
          wa_lid       = coalesce(excluded.wa_lid, customers.wa_lid),
          wa_phone     = coalesce(excluded.wa_phone, customers.wa_phone),
          display_name = coalesce(excluded.display_name, customers.display_name)
    returning id, (xmax = 0) as created
  `;

  // xmax = 0 distinguishes a genuine INSERT from the UPDATE branch of an
  // upsert. Needed because PATIENT_CREATED must fire exactly once in a
  // customer's lifetime, and `returning` alone cannot tell the two apart.
  return { customerId: row.id, created: row.created, identityKey };
}

module.exports = { resolveCustomer, normalizePhone, identityKeyFor };
