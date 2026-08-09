/**
 * Catalogue-independent input validation for the tenant and its profile.
 *
 * Opening hours matter more than they look: the assistant reads them back
 * to customers. A malformed row here becomes a false statement over
 * WhatsApp, which is the failure mode this whole product is designed to
 * avoid. So they are validated, not trusted.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slugify, normalizeName, normalizeOpeningHours } = require('../services/pharmacies');

// ---- slugify ----

test('slugify produces url-safe slugs from ordinary names', () => {
  assert.equal(slugify('Bright Care Pharmacy'), 'bright-care-pharmacy');
  assert.equal(slugify('  Extra   Spaces  '), 'extra-spaces');
  assert.equal(slugify("St. Mary's Chemist & Co."), 'st-mary-s-chemist-co');
});

test('slugify strips accents rather than dropping the word', () => {
  assert.equal(slugify('Médico Pharmacy'), 'medico-pharmacy');
});

test('slugify never returns an empty slug', () => {
  // A name in a non-Latin script or made only of symbols must still yield
  // a usable slug — the slug is a convenience, never a reason to reject a
  // legitimate business name.
  for (const name of ['ЖЖЖ', '💊', '!!!', '', '   ', null, undefined]) {
    const slug = slugify(name);
    assert.ok(slug.length > 0, `empty slug for ${JSON.stringify(name)}`);
    assert.match(slug, /^[a-z0-9-]+$/);
  }
});

test('slugify has no leading or trailing hyphen and is bounded in length', () => {
  const slug = slugify(`${'-'.repeat(5)}${'Very Long Pharmacy Name '.repeat(10)}`);
  assert.ok(slug.length <= 48);
  assert.doesNotMatch(slug, /^-|-$/);
});

// ---- normalizeName ----

test('normalizeName collapses whitespace and trims', () => {
  const r = normalizeName('  Bright   Care  ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Bright Care');
});

test('normalizeName rejects missing, short, and oversized names', () => {
  assert.equal(normalizeName(undefined).ok, false);
  assert.equal(normalizeName(null).ok, false);
  assert.equal(normalizeName(123).ok, false);
  assert.equal(normalizeName('A').ok, false);
  assert.equal(normalizeName('   ').ok, false);
  assert.equal(normalizeName('x'.repeat(121)).ok, false);
});

// ---- normalizeOpeningHours ----

test('absent hours normalise to an empty list, not an error', () => {
  assert.deepEqual(normalizeOpeningHours(undefined), { ok: true, value: [] });
  assert.deepEqual(normalizeOpeningHours(null), { ok: true, value: [] });
});

test('valid hours are normalised and sorted into week order', () => {
  const r = normalizeOpeningHours([
    { day: 'Wed', open: '09:00', close: '18:00' },
    { day: 'mon', open: '08:00', close: '20:00' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((d) => d.day), ['mon', 'wed']);
});

test('a closed day drops its times instead of carrying contradictory data', () => {
  const r = normalizeOpeningHours([{ day: 'sun', closed: true, open: '09:00', close: '18:00' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ day: 'sun', closed: true }]);
});

test('overnight and reversed spans are refused, not silently wrapped', () => {
  const r = normalizeOpeningHours([{ day: 'mon', open: '20:00', close: '08:00' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Overnight hours are not supported/);
});

test('equal open and close is refused — a zero-length day is not "open"', () => {
  assert.equal(normalizeOpeningHours([{ day: 'mon', open: '09:00', close: '09:00' }]).ok, false);
});

test('malformed times are refused', () => {
  for (const [open, close] of [['25:00', '26:00'], ['9:00', '18:00'], ['09:60', '18:00'], ['', '18:00'], ['0900', '1800']]) {
    const r = normalizeOpeningHours([{ day: 'mon', open, close }]);
    assert.equal(r.ok, false, `expected refusal for ${open}-${close}`);
  }
});

test('unknown and duplicate days are refused', () => {
  assert.equal(normalizeOpeningHours([{ day: 'funday', open: '09:00', close: '18:00' }]).ok, false);
  assert.equal(normalizeOpeningHours([
    { day: 'mon', open: '09:00', close: '18:00' },
    { day: 'mon', open: '10:00', close: '19:00' },
  ]).ok, false);
});

test('non-array and oversized input is refused', () => {
  assert.equal(normalizeOpeningHours('mon 9-5').ok, false);
  assert.equal(normalizeOpeningHours({ mon: '9-5' }).ok, false);
  assert.equal(normalizeOpeningHours([null]).ok, false);
  assert.equal(normalizeOpeningHours(new Array(8).fill({ day: 'mon', open: '09:00', close: '18:00' })).ok, false);
});
