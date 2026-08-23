/**
 * Recognising the pharmacy's own staff alert number on an inbound reply.
 *
 * THE BUG THIS GUARDS AGAINST
 * WhatsApp is migrating this account to LID addressing (senderIdentity.js).
 * A reply addressed by LID without the phone-number alt JID on that
 * particular message leaves wa_phone NULL — a real staff reply that a
 * phone-only comparison can never see, so it silently falls through to the
 * sales assistant instead of confirming or rejecting the order. isStaffNumber
 * must also recognise a LID once notify_lid has learned it.
 *
 * Pure function: no database, no clock, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isStaffNumber } = require('../services/worker');

test('a phone number matching notify_phone exactly is staff', () => {
  assert.equal(isStaffNumber('2348036607553', null, '2348036607553', null), true);
});

test('a local 0-prefixed number matches the same phone written internationally', () => {
  assert.equal(isStaffNumber('2348036607553', null, '08036607553', null), true);
});

test('a LID-only reply (no wa_phone) is missed until notify_lid is learned', () => {
  assert.equal(isStaffNumber(null, '198350347493478', '2348036607553', null), false);
});

test('once notify_lid has learned this LID, the same LID-only reply is recognised', () => {
  assert.equal(isStaffNumber(null, '198350347493478', '2348036607553', '198350347493478'), true);
});

test('a phone match still wins even when the LIDs happen to differ', () => {
  assert.equal(isStaffNumber('2348036607553', 'new-lid', '2348036607553', 'stale-lid'), true);
});

test('an unrelated customer is never mistaken for staff', () => {
  assert.equal(isStaffNumber('2348011112222', 'customer-lid', '2348036607553', 'staff-lid'), false);
});

test('nothing configured at all is never staff', () => {
  assert.equal(isStaffNumber(null, null, null, null), false);
});

test('a customer LID never matches when notify_lid has not learned anything yet', () => {
  assert.equal(isStaffNumber(null, 'customer-lid', '2348036607553', null), false);
});
