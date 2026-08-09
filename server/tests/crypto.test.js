/**
 * Crypto tests — no database needed.
 *
 * These exist because the failure mode is silent. Encryption that "works"
 * but round-trips Buffers incorrectly, or accepts a short key, produces
 * ciphertext that looks fine until a real session cannot decrypt weeks later.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const KEY_HEX = crypto.randomBytes(32).toString('hex');
process.env.SESSION_ENCRYPTION_KEY = KEY_HEX;

const enc = require('../services/crypto');

test('round-trips a string', () => {
  const out = enc.decrypt(enc.encrypt('hello pharmacy')).toString('utf8');
  assert.equal(out, 'hello pharmacy');
});

test('round-trips binary that is not valid utf8', () => {
  const raw = crypto.randomBytes(256);
  assert.deepEqual(enc.decrypt(enc.encrypt(raw)), raw);
});

test('round-trips JSON containing Buffers via the json helpers', () => {
  const value = { a: 1, nested: { list: [1, 2, 3] }, s: 'ẹ̀kọ́' };
  assert.deepEqual(enc.decryptJson(enc.encryptJson(value)), value);
});

test('same plaintext encrypts differently each time — IV is not reused', () => {
  const a = enc.encrypt('same');
  const b = enc.encrypt('same');
  assert.notDeepEqual(a, b, 'identical ciphertext means a fixed IV, which leaks equality');
  assert.equal(enc.decrypt(a).toString(), enc.decrypt(b).toString());
});

test('ciphertext does not contain the plaintext', () => {
  const secret = 'SUPER-SECRET-SESSION-TOKEN';
  const blob = enc.encrypt(secret);
  assert.ok(!blob.toString('utf8').includes(secret));
  assert.ok(!blob.toString('latin1').includes(secret));
});

test('tampering with the ciphertext is detected, not silently decoded', () => {
  const blob = enc.encrypt('important credential');
  blob[blob.length - 1] ^= 0xff;
  assert.throws(() => enc.decrypt(blob), /authentication check failed/);
});

test('tampering with the auth tag is detected', () => {
  const blob = enc.encrypt('important credential');
  blob[13] ^= 0x01; // inside the tag region
  assert.throws(() => enc.decrypt(blob), /authentication check failed/);
});

test('a truncated payload fails with a message that says so', () => {
  assert.throws(() => enc.decrypt(Buffer.alloc(8)), /too short/);
});

test('decrypting with a different key fails rather than returning garbage', () => {
  const blob = enc.encrypt('secret');
  process.env.SESSION_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  enc.resetKeyCache();
  assert.throws(() => enc.decrypt(blob), /SESSION_ENCRYPTION_KEY has changed/);
  process.env.SESSION_ENCRYPTION_KEY = KEY_HEX;
  enc.resetKeyCache();
});

test('accepts base64 keys as well as hex', () => {
  const raw = crypto.randomBytes(32);
  process.env.SESSION_ENCRYPTION_KEY = raw.toString('base64');
  enc.resetKeyCache();
  assert.equal(enc.decrypt(enc.encrypt('ok')).toString(), 'ok');
  process.env.SESSION_ENCRYPTION_KEY = KEY_HEX;
  enc.resetKeyCache();
});

test('rejects a key of the wrong length instead of padding it', () => {
  process.env.SESSION_ENCRYPTION_KEY = 'abcd1234';
  enc.resetKeyCache();
  assert.throws(() => enc.encrypt('x'), /must decode to 32 bytes/);
  process.env.SESSION_ENCRYPTION_KEY = KEY_HEX;
  enc.resetKeyCache();
});

test('a missing key names the command that generates one', () => {
  delete process.env.SESSION_ENCRYPTION_KEY;
  enc.resetKeyCache();
  assert.throws(() => enc.encrypt('x'), /randomBytes\(32\)/);
  process.env.SESSION_ENCRYPTION_KEY = KEY_HEX;
  enc.resetKeyCache();
});

test('refuses to encrypt null rather than storing an empty credential', () => {
  assert.throws(() => enc.encrypt(null), /Refusing to store/);
  assert.throws(() => enc.encrypt(undefined), /Refusing to store/);
});

test('decrypt rejects non-Buffer input', () => {
  assert.throws(() => enc.decrypt('not a buffer'), /expects a Buffer/);
});
