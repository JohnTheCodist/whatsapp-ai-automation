/**
 * Envelope encryption for WhatsApp session credentials.
 *
 * WHY THIS EXISTS
 * A Baileys auth state is not a scoped, revocable API token. Possession of
 * it is full account takeover of the pharmacy's WhatsApp: read every past
 * conversation, send as them, to anyone. The blast radius of a leak extends
 * past our own data to every customer who ever messaged that pharmacy.
 *
 * So it does not sit in the database as readable bytes. A dump, a backup on
 * someone's laptop, or a read-only credential leak should yield ciphertext.
 *
 * AES-256-GCM, not CBC: GCM is authenticated, so tampering is detected at
 * decrypt rather than silently producing garbage that gets fed to the
 * protocol library.
 *
 * Layout: [ iv (12) | authTag (16) | ciphertext (n) ] as one Buffer, stored
 * in a bytea column. Self-contained — no separate columns to keep in sync,
 * and no ambiguity about which IV belongs to which value.
 */

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM standard; 96 bits is what the mode is built for
const TAG_BYTES = 16;
const KEY_BYTES = 32;  // AES-256

let cachedKey = null;

/**
 * Resolves the master key from the environment.
 *
 * Accepts 64 hex chars or 44 base64 chars — both are common ways to write
 * 32 bytes, and guessing wrong at 3am is a worse failure than accepting both.
 * Anything else throws, loudly, naming the fix. A short key here would
 * silently weaken every credential in the system.
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'SESSION_ENCRYPTION_KEY is not set. WhatsApp session credentials cannot ' +
      'be stored without it. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  let key;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SESSION_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
      'Expected 64 hex characters or base64 encoding 32 bytes.'
    );
  }

  cachedKey = key;
  return key;
}

/**
 * @param {Buffer|string} plaintext
 * @returns {Buffer} iv || tag || ciphertext
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) {
    throw new Error('encrypt() received null/undefined. Refusing to store an empty credential.');
  }
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * @param {Buffer} envelope
 * @returns {Buffer}
 * @throws if the payload was truncated or tampered with. Both are real
 *   conditions worth failing on rather than papering over — a corrupted
 *   session is recoverable by re-pairing, a silently wrong one is not.
 */
function decrypt(envelope) {
  if (!Buffer.isBuffer(envelope)) {
    throw new Error(`decrypt() expects a Buffer, got ${typeof envelope}`);
  }
  if (envelope.length < IV_BYTES + TAG_BYTES) {
    throw new Error(
      `Encrypted payload is too short (${envelope.length} bytes) to contain an IV and auth tag. ` +
      'The stored value is truncated or was never produced by encrypt().'
    );
  }

  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // GCM's auth check failing means wrong key or modified data. Say which
    // possibilities they are, since "unable to authenticate" alone sends
    // people looking in the wrong place.
    throw new Error(
      'Failed to decrypt session credential: authentication check failed. ' +
      'Either SESSION_ENCRYPTION_KEY has changed since this row was written, ' +
      'or the stored value was modified. ' +
      `(underlying: ${err.message})`
    );
  }
}

/** JSON convenience wrappers — everything stored here is JSON in practice. */
function encryptJson(value) {
  return encrypt(JSON.stringify(value));
}
function decryptJson(envelope) {
  return JSON.parse(decrypt(envelope).toString('utf8'));
}

/** Test-only: drop the memoised key after changing the env var. */
function resetKeyCache() {
  cachedKey = null;
}

function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

module.exports = { encrypt, decrypt, encryptJson, decryptJson, isConfigured, resetKeyCache };
