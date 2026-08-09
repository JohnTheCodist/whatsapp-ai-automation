/**
 * JID policy — which chats the assistant may answer in.
 *
 * A false positive here is a privacy incident, not a bug: the assistant
 * replying in a group chat repeats one customer's medicine enquiry to
 * everyone in it. So the interesting tests are the ones asserting that
 * unfamiliar things are ignored.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDirectUserChat } = require('../services/whatsapp/jidPolicy');

test('accepts a normal Nigerian customer number', () => {
  assert.equal(isDirectUserChat('2348012345678@s.whatsapp.net'), true);
});

test('accepts a LID-addressed user — a real customer, addressed the new way', () => {
  assert.equal(
    isDirectUserChat('2348012345678@lid'), true,
    'rejecting LIDs would silently ignore a growing share of genuine messages',
  );
});

test('accepts a device-suffixed user jid', () => {
  assert.equal(isDirectUserChat('2348012345678:12@s.whatsapp.net'), true);
});

test('REJECTS group chats', () => {
  assert.equal(
    isDirectUserChat('120363000000000000@g.us'), false,
    'answering in a group broadcasts a health enquiry to everyone in it',
  );
});

test('REJECTS status and broadcast', () => {
  assert.equal(isDirectUserChat('status@broadcast'), false);
  assert.equal(isDirectUserChat('1234567890@broadcast'), false);
});

test('REJECTS newsletters', () => {
  assert.equal(isDirectUserChat('123456789@newsletter'), false);
});

test('REJECTS an unknown future domain rather than assuming it is a person', () => {
  assert.equal(
    isDirectUserChat('123456@somethingnew'), false,
    'the allowlist exists so a new WhatsApp jid type fails closed',
  );
});

test('rejects malformed and empty input without throwing', () => {
  for (const bad of ['', null, undefined, 'no-at-sign', '@s.whatsapp.net', 123, {}, []]) {
    assert.equal(isDirectUserChat(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('rejects a non-numeric user part on a valid domain', () => {
  assert.equal(isDirectUserChat('notanumber@s.whatsapp.net'), false);
  assert.equal(isDirectUserChat('status@s.whatsapp.net'), false);
});

test('is not fooled by a valid domain appearing earlier in the string', () => {
  assert.equal(
    isDirectUserChat('2348012345678@s.whatsapp.net@g.us'), false,
    'the domain is what follows the LAST @',
  );
});
