/**
 * Sender identity and number normalisation.
 *
 * Both of these were written against REAL captured traffic, not a guess at
 * the shape. WhatsApp addressed us by LID and put the phone number in
 * remoteJidAlt; splitting the JID — the obvious implementation — yields an
 * opaque id no pharmacist can act on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSender, normalizeMsisdn } = require('../services/whatsapp/senderIdentity');

// Captured verbatim from the first real inbound message.
const REAL_LID_KEY = {
  id: 'ACA2455F349A6626C05AEB3F29CD1085',
  fromMe: false,
  remoteJid: '198350347493478@lid',
  participant: '',
  remoteJidAlt: '2349013993683@s.whatsapp.net',
  addressingMode: 'lid',
};

test('extracts the real phone number from a LID-addressed message', () => {
  const s = resolveSender(REAL_LID_KEY, 'John');
  assert.equal(s.phone, '2349013993683', 'the number lives in remoteJidAlt, not remoteJid');
  assert.equal(s.lid, '198350347493478');
  assert.equal(s.displayName, 'John');
});

test('replies go to the JID that addressed us, not the phone number', () => {
  const s = resolveSender(REAL_LID_KEY, 'John');
  assert.equal(
    s.replyJid, '198350347493478@lid',
    'substituting the phone number would be guessing at routing WhatsApp already told us',
  );
});

test('handles a classic phone-addressed message', () => {
  const s = resolveSender({ remoteJid: '2348012345678@s.whatsapp.net' }, 'Ada');
  assert.equal(s.phone, '2348012345678');
  assert.equal(s.lid, null);
  assert.equal(s.replyJid, '2348012345678@s.whatsapp.net');
});

test('handles the mirror case — phone primary, LID in the alt', () => {
  const s = resolveSender({
    remoteJid: '2348012345678@s.whatsapp.net',
    remoteJidAlt: '11111111111@lid',
  });
  assert.equal(s.phone, '2348012345678');
  assert.equal(s.lid, '11111111111');
});

test('a LID with no alt yields no phone rather than an invented one', () => {
  const s = resolveSender({ remoteJid: '198350347493478@lid' });
  assert.equal(s.phone, null, 'better to have no number than a fake one');
  assert.equal(s.lid, '198350347493478');
});

test('strips a device suffix', () => {
  assert.equal(resolveSender({ remoteJid: '2348012345678:12@s.whatsapp.net' }).phone, '2348012345678');
});

test('survives malformed keys without throwing', () => {
  for (const key of [null, undefined, {}, { remoteJid: '' }, { remoteJid: 'garbage' }]) {
    const s = resolveSender(key);
    assert.equal(s.phone, null);
    assert.equal(s.lid, null);
  }
});

// ---- normalisation ----

test('a Nigerian local number matches its international form', () => {
  assert.equal(
    normalizeMsisdn('09013993683'), normalizeMsisdn('2349013993683'),
    'these are the same person — treating them as different makes an allowlist silently not match',
  );
  assert.equal(normalizeMsisdn('09013993683'), '2349013993683');
});

test('accepts the shapes people actually type', () => {
  for (const input of [
    '2349013993683', '+234 901 399 3683', '+2349013993683',
    '234-901-399-3683', '0901 399 3683',
  ]) {
    assert.equal(normalizeMsisdn(input), '2349013993683', `failed on ${input}`);
  }
});

test('honours a different default country code', () => {
  assert.equal(normalizeMsisdn('07700900123', '44'), '447700900123');
});

test('rejects unusable input rather than producing a partial number', () => {
  for (const bad of ['', null, undefined, 'abc', '123', '0', '00']) {
    assert.equal(normalizeMsisdn(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});
