/**
 * The patient search's filter contract.
 *
 * The failure worth defending against is a filter that is quietly ignored:
 * it returns MORE patients than asked for, and a pharmacist working through
 * "lapsed" would ring people who are fine, believing they had found the ones
 * who are not. So every unknown value is a 400 that names its field.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AGE_BANDS, CHRONIC_CONDITIONS, readPatientFilters, ageBand, fixedOptions, DEFAULT_LIMIT, MAX_LIMIT,
} = require('../services/customers/patientFilters');

const UUID = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';

function rejects(query, field) {
  assert.throws(() => readPatientFilters(query), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_FILTER');
    assert.equal(err.field, field);
    return true;
  });
}

test('no filters at all means no filtering, and the default page size', () => {
  assert.deepEqual(readPatientFilters({}), {
    q: null, age: null, gender: null, condition: null, chronic: false, medication: null,
    lastVisit: null, followUp: null, pharmacist: null, risk: null, limit: DEFAULT_LIMIT,
  });
});

test('empty and whitespace-only values mean "not filtering", not "match nothing"', () => {
  const f = readPatientFilters({ q: '  ', age: '', medication: ' ', pharmacist: '' });
  assert.equal(f.q, null);
  assert.equal(f.age, null);
  assert.equal(f.medication, null);
  assert.equal(f.pharmacist, null);
});

test('every filter reads its value through', () => {
  const f = readPatientFilters({
    q: ' Bello ', age: '60plus', gender: 'female', condition: 'HYPERTENSION', chronic: 'on', medication: 'amlodipine',
    lastVisit: '30d', followUp: 'overdue', pharmacist: UUID, risk: 'lapsed', limit: '25',
  });
  assert.deepEqual(f, {
    q: 'Bello', age: '60plus', gender: 'female', condition: 'HYPERTENSION', chronic: true, medication: 'amlodipine',
    lastVisit: '30d', followUp: 'overdue', pharmacist: UUID, risk: 'lapsed', limit: 25,
  });
});

test('an unknown value is refused and names its filter, never silently dropped', () => {
  rejects({ age: '30s' }, 'age');
  rejects({ gender: 'f' }, 'gender');
  rejects({ lastVisit: 'yesterday' }, 'lastVisit');
  rejects({ followUp: 'soon' }, 'followUp');
  rejects({ risk: 'lapse' }, 'risk');
});

test('a condition must look like an engine code, so free text cannot reach the query as one', () => {
  assert.equal(readPatientFilters({ condition: 'DIABETES' }).condition, 'DIABETES');
  rejects({ condition: 'diabetes' }, 'condition');
  rejects({ condition: "HYPERTENSION' OR 1=1" }, 'condition');
});

test('a pharmacist is a user id or "unassigned", nothing else', () => {
  assert.equal(readPatientFilters({ pharmacist: 'unassigned' }).pharmacist, 'unassigned');
  rejects({ pharmacist: 'Ade' }, 'pharmacist');
});

test('over-long search text is refused rather than truncated into a different search', () => {
  rejects({ q: 'x'.repeat(101) }, 'q');
  rejects({ medication: 'x'.repeat(101) }, 'medication');
});

test('the page size is capped, and nonsense is refused', () => {
  assert.equal(readPatientFilters({ limit: '9999' }).limit, MAX_LIMIT);
  rejects({ limit: '0' }, 'limit');
  rejects({ limit: 'all' }, 'limit');
});

test('age bands are contiguous with no gaps or overlaps between them', () => {
  // A patient aged exactly 18, 40 or 60 must land in exactly one band.
  const banded = AGE_BANDS.filter((b) => b.min !== null);
  for (let age = 0; age <= 120; age += 1) {
    const hits = banded.filter((b) => age >= b.min && (b.max === null || age <= b.max));
    assert.equal(hits.length, 1, `age ${age} is in ${hits.length} bands`);
  }
  assert.equal(ageBand('unknown').min, null);
  assert.equal(ageBand('nope'), null);
});

test('the options sent to the dashboard are exactly the values the server accepts', () => {
  const options = fixedOptions();
  for (const [field, list] of Object.entries(options)) {
    for (const { value } of list) {
      assert.doesNotThrow(() => readPatientFilters({ [field]: value }), `${field}=${value}`);
    }
  }
});

/**
 * The chronic switch. A switch has exactly two states, so the query string
 * has exactly one spelling: present and "on", or absent. "chronic=off",
 * "chronic=false" and "chronic=1" are all refused rather than read as off —
 * a switch shown as ON while the server filtered nothing would put every
 * patient in front of a pharmacist who asked for the ones they follow.
 */
test('the chronic switch is on, or absent — nothing else is accepted', () => {
  assert.equal(readPatientFilters({}).chronic, false);
  assert.equal(readPatientFilters({ chronic: '' }).chronic, false);
  assert.equal(readPatientFilters({ chronic: 'on' }).chronic, true);
  rejects({ chronic: 'off' }, 'chronic');
  rejects({ chronic: 'false' }, 'chronic');
  rejects({ chronic: '1' }, 'chronic');
});

test('the chronic conditions are the engine\'s own codes, and would pass as a condition filter', () => {
  // The switch and the Condition filter read the same column, so anything in
  // this list has to be a code the condition filter itself would accept.
  assert.deepEqual([...CHRONIC_CONDITIONS], ['DIABETES', 'HYPERTENSION']);
  for (const code of CHRONIC_CONDITIONS) {
    assert.equal(readPatientFilters({ condition: code }).condition, code);
  }
});
