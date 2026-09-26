/**
 * The contract for a patient's medication.
 *
 * The failures these defend against are all the same shape: a clinical fact
 * that did not save, or saved as something it is not. A frequency silently
 * dropped is a patient told to take a medicine at the wrong time; an empty
 * string stored as a dose is a label printed with nothing on it.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FORMS, ROUTES, FREQUENCIES, STATUSES, SOURCES,
  readMedicationInput, readMedicationPatch, medicationOptions, dosesPerDay, isEnded,
} = require('../services/clinical/medicationInput');

const TODAY = '2026-09-21';
const base = { medicineName: 'Amlodipine', startedOn: '2026-09-15' };

function rejects(body, field, read = readMedicationInput) {
  assert.throws(() => read(body, { today: TODAY }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_MEDICATION');
    assert.equal(err.field, field);
    return true;
  });
}

test('a medicine must be named — everything else about it may be unknown', () => {
  // A pharmacist writing up what a patient says they take often knows only
  // the name. Refusing the record until every field is filled is how the
  // record does not get made.
  const m = readMedicationInput(base, { today: TODAY });
  assert.equal(m.medicineName, 'Amlodipine');
  assert.equal(m.strength, null);
  assert.equal(m.dose, null);
  assert.equal(m.frequency, null);
  rejects({ startedOn: '2026-09-15' }, 'medicineName');
  rejects({ medicineName: '   ' }, 'medicineName');
});

test('an untouched field is absent, never an empty string', () => {
  const m = readMedicationInput({ ...base, strength: '', dose: '  ', notes: '' }, { today: TODAY });
  assert.equal(m.strength, null);
  assert.equal(m.dose, null);
  assert.equal(m.notes, null);
});

test('strength and dose are free text, because a closed list loses real prescriptions', () => {
  const m = readMedicationInput({
    ...base, strength: '20 mg/5 mL', dose: '1 tablet', indication: 'Hypertension',
  }, { today: TODAY });
  assert.equal(m.strength, '20 mg/5 mL');
  assert.equal(m.dose, '1 tablet');
  assert.equal(m.indication, 'Hypertension');
});

test('form, route and frequency are closed lists, and an unknown one is refused by name', () => {
  const m = readMedicationInput({
    ...base, form: 'tablet', route: 'oral', frequency: 'twice_daily',
  }, { today: TODAY });
  assert.equal(m.form, 'tablet');
  assert.equal(m.route, 'oral');
  assert.equal(m.frequency, 'twice_daily');
  rejects({ ...base, form: 'pill' }, 'form');
  rejects({ ...base, route: 'mouth' }, 'route');
  rejects({ ...base, frequency: 'bd' }, 'frequency');
});

test('the frequency carries how many doses a day, and a PRN medicine carries none', () => {
  // The refill engine turns doses-a-day into a run-out date. "As needed" has
  // no schedule, and inventing one would put a patient on the call list for
  // a medicine they may not have taken at all.
  assert.equal(dosesPerDay('three_times_daily'), 3);
  assert.equal(dosesPerDay('every_8_hours'), 3);
  assert.equal(dosesPerDay('as_needed'), null);
  assert.equal(dosesPerDay('weekly'), null);
  assert.equal(readMedicationInput({ ...base, frequency: 'twice_daily' }, { today: TODAY }).dosesPerDay, 2);
  assert.equal(readMedicationInput({ ...base, frequency: 'as_needed' }, { today: TODAY }).dosesPerDay, null);
});

test('no duration means ongoing, which is the normal case — not zero and not an error', () => {
  assert.equal(readMedicationInput(base, { today: TODAY }).durationDays, null);
  assert.equal(readMedicationInput({ ...base, durationDays: '' }, { today: TODAY }).durationDays, null);
  assert.equal(readMedicationInput({ ...base, durationDays: '30' }, { today: TODAY }).durationDays, 30);
  rejects({ ...base, durationDays: '0' }, 'durationDays');
  rejects({ ...base, durationDays: '4.5' }, 'durationDays');
});

test('a medicine cannot have started in the future, or ended before it began', () => {
  rejects({ ...base, startedOn: '2027-01-01' }, 'startedOn');
  rejects({ ...base, startedOn: '2026-09-15', endedOn: '2026-09-01' }, 'endedOn');
  rejects({ ...base, startedOn: 'last tuesday' }, 'startedOn');
  // Absent start means today, so writing up what is in front of you takes
  // one less field.
  assert.equal(readMedicationInput({ medicineName: 'Metformin' }, { today: TODAY }).startedOn, TODAY);
});

test('the prescriber is one of two things, never both', () => {
  // A record naming two prescribers cannot say which of them to ring, and
  // ringing the prescriber is the only reason the field exists.
  const uuid = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';
  assert.equal(readMedicationInput({ ...base, prescriberId: uuid }, { today: TODAY }).prescriberId, uuid);
  assert.equal(readMedicationInput({ ...base, prescriberName: 'Dr John' }, { today: TODAY }).prescriberName, 'Dr John');
  rejects({ ...base, prescriberId: uuid, prescriberName: 'Dr John' }, 'prescriberName');
  rejects({ ...base, prescriberId: 'dr-john' }, 'prescriberId');
});

test('stopping needs a reason; the other endings say themselves', () => {
  // "Completed" says the course finished and "cancelled" says it was never
  // real. "Stopped" without a why is the record that makes the next
  // pharmacist guess.
  rejects({ ...base, status: 'stopped' }, 'stopReason');
  assert.equal(
    readMedicationInput({ ...base, status: 'stopped', stopReason: 'Cough' }, { today: TODAY }).stopReason,
    'Cough',
  );
  assert.equal(readMedicationInput({ ...base, status: 'completed' }, { today: TODAY }).status, 'completed');
});

test('the source is recorded and defaults to prescribed, never inferred from silence', () => {
  // The distinction this module exists for: a community pharmacist routinely
  // finds a patient taking something that is in no prescription record.
  assert.equal(readMedicationInput(base, { today: TODAY }).source, 'prescribed');
  assert.equal(
    readMedicationInput({ ...base, source: 'patient_reported' }, { today: TODAY }).source,
    'patient_reported',
  );
  rejects({ ...base, source: 'hearsay' }, 'source');
});

test('an edit changes only what it sends, and cannot blank the rest', () => {
  const patch = readMedicationPatch({ dose: '2 tablets' }, { today: TODAY });
  assert.deepEqual(Object.keys(patch), ['dose']);
  assert.equal(patch.dose, '2 tablets');
  // Explicitly clearing a field is different from not mentioning it.
  assert.equal(readMedicationPatch({ notes: '' }, { today: TODAY }).notes, null);
  rejects({}, 'medication', readMedicationPatch);
});

test('an edit that stops a medicine still needs the reason', () => {
  rejects({ status: 'stopped' }, 'stopReason', readMedicationPatch);
  const patch = readMedicationPatch({ status: 'stopped', stopReason: 'Swollen ankles' }, { today: TODAY });
  assert.equal(patch.status, 'stopped');
  assert.equal(patch.stopReason, 'Swollen ankles');
});

test('every status the vocabulary offers says whether it has ended', () => {
  assert.deepEqual(STATUSES.map((s) => s.value), ['draft', 'active', 'completed', 'stopped', 'cancelled']);
  assert.equal(isEnded('active'), false);
  assert.equal(isEnded('draft'), false);
  for (const s of ['completed', 'stopped', 'cancelled']) assert.equal(isEnded(s), true, s);
});

test('the options a form offers are exactly the values the contract accepts', () => {
  const options = medicationOptions();
  for (const [field, list] of Object.entries(options)) {
    for (const { value } of list) {
      assert.doesNotThrow(
        () => readMedicationInput({ ...base, [field]: value, stopReason: 'x' }, { today: TODAY }),
        `${field}=${value}`,
      );
    }
  }
  // And the lists are the ones the screen shows, in the order it shows them.
  assert.equal(options.form.length, FORMS.length);
  assert.equal(options.route.length, ROUTES.length);
  assert.equal(options.frequency.length, FREQUENCIES.length);
  assert.equal(options.source.length, SOURCES.length);
});
