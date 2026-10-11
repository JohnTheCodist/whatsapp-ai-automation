/**
 * The contract for creating a patient by hand.
 *
 * Until this existed a patient could only come into being by messaging the
 * pharmacy on WhatsApp — `customerIdentity.resolveCustomer`, called from the
 * inbound ingest, was the only thing in the product that had ever inserted a
 * customer. A pharmacist consulting with somebody at the counter had nowhere
 * to put them.
 *
 * Needs no database: this is the layer that decides what a form may send, and
 * the bug class it exists for is the one `refillInput` was written after — a
 * browser sends strings, and a service tested only against well-shaped
 * objects passes every test while every real submission fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readNewPatientInput, SEXES, MAX_NAME } = require('../services/customers/newPatientInput');
const { normalizePhone, identityKeyFor } = require('../services/customers/customerIdentity');

const OK = { fullName: 'Ngozi Okafor', phone: '08031234567' };

// THE MOST IMPORTANT TEST IN THIS FILE.
test('a patient typed at the counter gets the SAME identity as their WhatsApp messages', () => {
  // The whole reason this contract reuses `normalizePhone` instead of doing
  // its own tidying. `identity_key` is unique per pharmacy, so a second idea
  // of what "08031234567" means is a SECOND RECORD for one person — and the
  // pharmacist would never see the first one again.
  const typed = readNewPatientInput({ ...OK, phone: '0803 123 4567' });

  // WhatsApp hands the ingest bare international digits for the same person.
  const fromWhatsApp = identityKeyFor({ phone: '2348031234567' });

  assert.equal(typed.phone, fromWhatsApp,
    'a patient created at the counter would not merge with their own messages');
  assert.equal(typed.phone, normalizePhone('08031234567'));

  // Every local spelling a Nigerian pharmacist might type lands on one key.
  for (const spelling of ['08031234567', '0803 123 4567', '+2348031234567', '234 803 123 4567', '2348031234567']) {
    assert.equal(readNewPatientInput({ ...OK, phone: spelling }).phone, fromWhatsApp,
      `"${spelling}" produced a different identity`);
  }
});

test('the jid is the address a reply would really go to', () => {
  // `customers.wa_jid` is NOT NULL (0016) and is documented as the address
  // replies are sent to, so it cannot be invented freely. For a real number
  // the WhatsApp address is deterministic, and `resolveCustomer` overwrites
  // it with the genuine one the moment this person messages.
  const r = readNewPatientInput(OK);
  assert.equal(r.jid, `${r.phone}@s.whatsapp.net`);
  // Derived from the NORMALISED number, never from what was typed — a jid
  // built from "0803…" would address nobody.
  assert.ok(r.jid.startsWith('234'));
});

test('a patient needs a name and a number, and the refusal names the box', () => {
  // Both are required for different reasons: the number is the identity, and
  // a nameless patient is one nobody can find again in the list.
  // The MESSAGE is asserted, not only the field, and that is deliberate.
  // Found by mutation: deleting the required-phone check still refuses an
  // empty box — it falls through to the parser and says "that does not look
  // like a phone number". Safe, and wrong for the person: an empty field is
  // not a malformed one, and telling somebody their blank box is badly
  // formatted sends them looking for a typo that is not there.
  for (const [body, field, says] of [
    [{ phone: '08031234567' }, 'fullName', /needs a name/i],
    [{ fullName: '   ', phone: '08031234567' }, 'fullName', /needs a name/i],
    [{ fullName: 'Ngozi Okafor' }, 'phone', /needs a phone number/i],
    [{ fullName: 'Ngozi Okafor', phone: '  ' }, 'phone', /needs a phone number/i],
  ]) {
    assert.throws(
      () => readNewPatientInput(body),
      (err) => {
        assert.equal(err.status, 400);
        // Every form here reads `body.field` to highlight the box that is
        // wrong; without it the message says "needs a phone number" while
        // the phone box looks like the other three.
        assert.equal(err.field, field);
        assert.match(err.message, says,
          `an empty ${field} was refused as malformed rather than as missing`);
        return true;
      },
      `${JSON.stringify(body)} was accepted`,
    );
  }

  // Called with nothing at all, rather than throwing something unreadable.
  assert.throws(() => readNewPatientInput(), /needs a name/i);
  assert.throws(() => readNewPatientInput(null), /needs a name/i);
});

test('a number that is not a number is refused with help, not just rejected', () => {
  // A pharmacist at a counter mistypes. The sentence says what a Nigerian
  // number looks like rather than only that this one is wrong.
  for (const junk of ['12345', 'not a phone', '0000', '080312345678901234', '+1']) {
    assert.throws(
      () => readNewPatientInput({ ...OK, phone: junk }),
      (err) => {
        assert.equal(err.field, 'phone');
        assert.match(err.message, /0803|234803/,
          `the refusal for "${junk}" does not show what a number looks like`);
        return true;
      },
      `"${junk}" was accepted as a phone number`,
    );
  }
});

test('sex and date of birth are optional, and an unknown one stays unknown', () => {
  // A pharmacist writing somebody up at a counter often knows neither, and a
  // required field would be filled with a guess. The date of birth drives the
  // AGE on the consultation banner, which is one of the three facts that
  // change what is safe to do — a guess there is worse than a blank.
  const bare = readNewPatientInput(OK);
  assert.equal(bare.sex, null);
  assert.equal(bare.dateOfBirth, null);

  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(readNewPatientInput({ ...OK, sex: empty }).sex, null);
    assert.equal(readNewPatientInput({ ...OK, dateOfBirth: empty }).dateOfBirth, null);
  }

  const given = readNewPatientInput({ ...OK, sex: 'Female', dateOfBirth: '1991-06-14' });
  assert.equal(given.sex, 'female', 'a select sends what the option said');
  assert.equal(given.dateOfBirth, '1991-06-14');

  // Only what patient_profiles.sex accepts.
  assert.throws(() => readNewPatientInput({ ...OK, sex: 'yes' }), /choose a sex/i);
  for (const s of SEXES) {
    assert.equal(readNewPatientInput({ ...OK, sex: s }).sex, s);
  }
});

test('a date of birth that cannot be true is refused before it reaches a banner', () => {
  // A future date and a mistyped year both render as a confident age beside a
  // patient's name. "1 year old" on an adult, or "143", is the kind of thing
  // staff learn to ignore — and then ignore the real one.
  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  const future = nextYear.toISOString().slice(0, 10);

  assert.throws(() => readNewPatientInput({ ...OK, dateOfBirth: future }), /future/i);
  assert.throws(() => readNewPatientInput({ ...OK, dateOfBirth: '1850-01-01' }), /year of birth/i);

  for (const notADate of ['14/06/1991', '1991', 'yesterday', '1991-13-45']) {
    assert.throws(
      () => readNewPatientInput({ ...OK, dateOfBirth: notADate }),
      (err) => { assert.equal(err.field, 'dateOfBirth'); return true; },
      `"${notADate}" was accepted as a date`,
    );
  }
});

test('a name is trimmed and bounded', () => {
  assert.equal(readNewPatientInput({ ...OK, fullName: '  Ngozi Okafor  ' }).fullName, 'Ngozi Okafor');
  assert.ok(MAX_NAME > 0);
  assert.throws(
    () => readNewPatientInput({ ...OK, fullName: 'a'.repeat(MAX_NAME + 1) }),
    /too long/i,
  );
});
