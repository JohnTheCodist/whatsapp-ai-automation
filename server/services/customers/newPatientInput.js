/**
 * The contract for creating a patient by hand.
 *
 * Until now a patient could only come into existence by messaging the
 * pharmacy on WhatsApp — `customerIdentity.resolveCustomer`, called from the
 * inbound ingest, is the only thing in this product that has ever inserted a
 * customer. That is correct for the assistant and wrong for a counter: a
 * pharmacist consulting with somebody standing in front of them had nowhere
 * to put them.
 *
 * PURE, like every other input contract here, because a browser sends
 * strings and a service tested only against well-shaped objects passes every
 * test while every real submission fails (`refillInput`, 2026-09-19).
 *
 * WHY A PHONE NUMBER IS REQUIRED, which is the one real constraint.
 *
 * `customers.wa_jid` is NOT NULL (0016) and `identity_key` is NOT NULL and
 * unique per pharmacy (0019). A patient with neither a number nor a WhatsApp
 * identity has nothing to be identified BY, and `resolveCustomer` says so in
 * as many words: "there is nothing to identify them by".
 *
 * That is not merely a schema limit — it is what makes this feature safe.
 * A patient created here carries the SAME `identity_key` their WhatsApp
 * messages will resolve to, so the first time they message, the ingest
 * UPDATES this record instead of creating a second one. The walk-in record
 * and the WhatsApp thread become one patient, which is the whole reason to
 * reuse `resolveCustomer` rather than write an INSERT here.
 */

const { normalizePhone } = require('./customerIdentity');

/** Long enough to be a name, short enough not to be a paragraph. */
const MAX_NAME = 120;

/** What `patient_profiles.sex` accepts. Optional at creation. */
const SEXES = Object.freeze(['female', 'male', 'other']);

function bad(message, field) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_INPUT';
  // Every form here reads `body.field` to highlight the box that is wrong;
  // omitting it is the bug errorHandler.test.js was written for.
  err.field = field;
  return err;
}

/**
 * A date of birth that is a real past date.
 *
 * Optional — a pharmacist writing somebody up at a counter often does not
 * know it, and a required field would be filled with a guess. A guessed date
 * of birth drives the age on the consultation banner, which is one of the
 * three facts that change what is safe to do.
 */
function readDateOfBirth(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw bad('Date of birth must be a date.', 'dateOfBirth');
  }
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw bad('Date of birth must be a date.', 'dateOfBirth');

  // A date in the future is a typo, and an implausible age is almost always
  // a mistyped year. Both are refused HERE rather than showing a pharmacist
  // a banner that says 1 year old or 143.
  const now = new Date();
  if (date.getTime() > now.getTime()) {
    throw bad('Date of birth cannot be in the future.', 'dateOfBirth');
  }
  const years = (now.getTime() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years > 130) throw bad('Check the year of birth.', 'dateOfBirth');

  return text;
}

/**
 * Read a new patient from a form.
 *
 * Returns the shape `resolveCustomer` wants plus the profile fields, so the
 * route composes rather than reaching into the request body itself.
 */
function readNewPatientInput(body = {}) {
  const b = body && typeof body === 'object' ? body : {};

  const fullName = String(b.fullName == null ? '' : b.fullName).trim();
  if (!fullName) throw bad('A patient needs a name.', 'fullName');
  if (fullName.length > MAX_NAME) throw bad('That name is too long.', 'fullName');

  const typed = String(b.phone == null ? '' : b.phone).trim();
  if (!typed) throw bad('A patient needs a phone number.', 'phone');

  // THE SAME NORMALISER THE INGEST USES. A second idea of what "08031234567"
  // means is a second record for one person — the exact failure
  // `identity_key` exists to prevent.
  const phone = normalizePhone(typed);
  if (!phone) {
    throw bad('That does not look like a phone number. A Nigerian number may be written 0803… or 234803….', 'phone');
  }

  let sex = null;
  if (b.sex !== null && b.sex !== undefined && String(b.sex).trim() !== '') {
    sex = String(b.sex).trim().toLowerCase();
    if (!SEXES.includes(sex)) throw bad('Choose a sex from the list.', 'sex');
  }

  return {
    fullName,
    phone,
    // Deterministic for a real number, and the address a reply would go to.
    // `resolveCustomer` overwrites it with the REAL jid the moment this
    // person messages, so a synthesised one can never outlive its usefulness
    // — and nothing sends to a patient who has not written first anyway
    // (messageInput's outreach gate).
    jid: `${phone}@s.whatsapp.net`,
    sex,
    dateOfBirth: readDateOfBirth(b.dateOfBirth),
  };
}

module.exports = { readNewPatientInput, SEXES, MAX_NAME };
