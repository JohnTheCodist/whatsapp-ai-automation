/**
 * Tenant selection — the single most security-critical decision here.
 *
 * If selectTenant ever returns a membership the caller does not hold, one
 * pharmacy reads another's customers and the company is finished. So this
 * suite is deliberately paranoid, including cases that "cannot happen":
 * header values that are not strings, memberships that are not arrays,
 * ids differing only in case.
 *
 * No database, no network, no mocks — selectTenant is pure, which is the
 * entire reason it was extracted from requireAuth.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectTenant } = require('../middleware/auth');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const memberOfA = [{ pharmacy_id: A, role: 'owner', name: 'A Pharmacy', status: 'active' }];
const memberOfBoth = [
  { pharmacy_id: A, role: 'owner', name: 'A Pharmacy', status: 'active' },
  { pharmacy_id: B, role: 'staff', name: 'B Pharmacy', status: 'active' },
];

// ---- the happy paths ----

test('no header selects the first membership', () => {
  const r = selectTenant(memberOfA, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.membership.pharmacy_id, A);
});

test('null header selects the first membership', () => {
  const r = selectTenant(memberOfA, null);
  assert.equal(r.ok, true);
  assert.equal(r.membership.pharmacy_id, A);
});

test('header selects a held membership that is not the first', () => {
  const r = selectTenant(memberOfBoth, B);
  assert.equal(r.ok, true);
  assert.equal(r.membership.pharmacy_id, B);
  assert.equal(r.membership.role, 'staff');
});

test('uuid case does not affect matching — same id, different case, is the same id', () => {
  const r = selectTenant(memberOfBoth, B.toUpperCase());
  assert.equal(r.ok, true);
  assert.equal(r.membership.pharmacy_id, B);
});

test('surrounding whitespace in the header is tolerated', () => {
  const r = selectTenant(memberOfBoth, `  ${B}  `);
  assert.equal(r.ok, true);
  assert.equal(r.membership.pharmacy_id, B);
});

test('empty and whitespace-only headers fall back to the first membership', () => {
  for (const value of ['', '   ', '\t']) {
    const r = selectTenant(memberOfA, value);
    assert.equal(r.ok, true, `expected fallback for ${JSON.stringify(value)}`);
    assert.equal(r.membership.pharmacy_id, A);
  }
});

// ---- the refusals ----

test('a header naming a pharmacy the caller does not hold is refused', () => {
  const r = selectTenant(memberOfA, B);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'FORBIDDEN_TENANT');
});

test('refusal is 403, never 404 — existence of a tenant id is not disclosed', () => {
  const unknown = selectTenant(memberOfA, '99999999-9999-4999-8999-999999999999');
  const real = selectTenant(memberOfA, B);
  assert.equal(unknown.status, 403);
  assert.equal(real.status, 403);
  assert.equal(unknown.code, real.code);
  assert.equal(unknown.error, real.error);
});

test('no memberships is refused even with no header', () => {
  const r = selectTenant([], undefined);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'NO_MEMBERSHIP');
});

test('non-array memberships is refused rather than crashing', () => {
  for (const value of [undefined, null, {}, 'A', 0]) {
    const r = selectTenant(value, undefined);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(value)}`);
    assert.equal(r.code, 'NO_MEMBERSHIP');
  }
});

// ---- the "cannot happen" cases that decide whether this is safe ----

test('a non-string header is refused, never coerced', () => {
  // Node joins duplicate headers; some paths yield arrays. A value we
  // cannot read is not a value we can authorise against.
  for (const value of [[A], [A, B], 42, {}, true, () => A]) {
    const r = selectTenant(memberOfBoth, value);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(value)}`);
    assert.equal(r.code, 'FORBIDDEN_TENANT');
  }
});

test('a duplicated header joined into "a, b" matches nothing', () => {
  const r = selectTenant(memberOfBoth, `${A}, ${B}`);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN_TENANT');
});

test('a substring of a held id does not match', () => {
  const r = selectTenant(memberOfBoth, A.slice(0, 8));
  assert.equal(r.ok, false);
});

test('SQL-ish and wildcard headers match nothing', () => {
  for (const value of ["' or '1'='1", '%', '*', `${A}'--`]) {
    const r = selectTenant(memberOfBoth, value);
    assert.equal(r.ok, false, `expected refusal for ${value}`);
  }
});

test('memberships with a malformed pharmacy_id never match', () => {
  const broken = [{ pharmacy_id: null, role: 'owner' }, { pharmacy_id: 7, role: 'owner' }];
  const r = selectTenant(broken, A);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FORBIDDEN_TENANT');
});

test('selectTenant does not mutate the memberships it is given', () => {
  const input = JSON.parse(JSON.stringify(memberOfBoth));
  const snapshot = JSON.stringify(input);
  selectTenant(input, B);
  selectTenant(input, 'nope');
  assert.equal(JSON.stringify(input), snapshot);
});
