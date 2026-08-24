/**
 * Catalogue sync devices — pairing, authentication, and the rule that decides
 * whether a synced file may import without a human.
 *
 * WHY PAIRING LOOKS LIKE THE WHATSAPP FLOW
 * The owner already learned this shape once: the dashboard shows a short code,
 * they type it into the other thing, the two are joined. Inventing a second
 * idiom for the same act — "join this machine to this pharmacy" — would be a
 * second thing to explain over the phone to someone standing at a shop counter.
 *
 * WHY A CODE AND NOT AN API KEY IN A CONFIG FILE
 * The code is short-lived, single-use, and useless once redeemed. A long-lived
 * key pasted into a text file on a shared shop PC is readable by everyone who
 * uses that machine, for as long as the install lasts. What the agent stores
 * afterwards IS long-lived, but it was never displayed, never typed, and never
 * sat in an email — and it can be revoked from the dashboard without touching
 * the PC.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');

/**
 * No 0/O, 1/I/L, 5/S, 8/B. Same alphabet as the trade code and order
 * references, for the same reason: this gets read off one screen and typed
 * into another, sometimes down a phone line in a noisy shop.
 */
const ALPHABET = '234679ACDEFGHJKMNPQRTUVWXYZ';
const CODE_BODY_LENGTH = 4;

/** Long enough that the window is not a support burden, short enough to matter. */
const PAIRING_TTL_MINUTES = 30;

/**
 * How long a device may be silent before the dashboard calls it stale.
 *
 * A DEAD SYNC IS WORSE THAN NO SYNC. If the agent stops — the PC is off, the
 * folder moved, the POS was updated — the catalogue silently ages and the
 * assistant keeps quoting last month's prices with full confidence. Nobody
 * finds out from the absence of an event, so this exists to turn that silence
 * into something the dashboard can say out loud.
 *
 * Two days rather than one: a pharmacy that closes Sunday must not produce an
 * alert every Monday morning, or the alert becomes noise and stops working.
 */
const STALE_AFTER_HOURS = 48;

function generatePairingCode() {
  const bytes = crypto.randomBytes(CODE_BODY_LENGTH);
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) {
    body += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `SY-${body}`;
}

/** The token the agent keeps. Never stored in this form. */
function generateDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Start a pairing. Returns the code to show on screen.
 *
 * Creates the device row up front, in 'pending'. A row that is never paired is
 * an expired code and nothing else — it holds no token and can do nothing.
 */
async function createPairing(pharmacyId, { label = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  // Retry on the unique index rather than trusting 27^4 not to collide. The
  // space is small enough (531,441) that a birthday collision across a busy
  // pairing window is a real event, not a theoretical one.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generatePairingCode();
    try {
      const [row] = await db`
        insert into sync_devices (pharmacy_id, label, pairing_code, pairing_expires_at, status)
        values (${pharmacyId}, ${label}, ${code},
                now() + ${`${PAIRING_TTL_MINUTES} minutes`}::interval, 'pending')
        returning id, pairing_code, pairing_expires_at
      `;
      return { deviceId: row.id, code: row.pairing_code, expiresAt: row.pairing_expires_at };
    } catch (err) {
      if (!/duplicate key|unique constraint/i.test(err.message)) throw err;
    }
  }
  throw new Error('Could not allocate a pairing code. Please try again.');
}

/**
 * Redeem a pairing code for a device token.
 *
 * Unauthenticated by design — the agent has nothing else to present yet, and
 * the code IS the credential for this one call. Hence single-use and expiring:
 * the code is cleared in the same statement that issues the token, so two
 * agents racing the same code cannot both come away paired.
 */
async function redeemPairing(code, { fingerprint = null, confirmedPos = null, label = null, watchPath = null } = {}) {
  const db = getSql();
  const token = generateDeviceToken();

  const [row] = await db`
    update sync_devices
       set token_hash = ${hashToken(token)},
           pairing_code = null,
           pairing_expires_at = null,
           paired_at = now(),
           status = 'active',
           label = coalesce(${label}, label),
           pos_fingerprint = coalesce(${fingerprint ? db.json(fingerprint) : null}, pos_fingerprint),
           pos_confirmed = coalesce(${confirmedPos}, pos_confirmed),
           watch_path = coalesce(${watchPath}, watch_path),
           last_seen_at = now(),
           updated_at = now()
     where pairing_code = ${String(code || '').trim().toUpperCase()}
       and status = 'pending'
       and pairing_expires_at > now()
    returning id, pharmacy_id
  `;

  if (!row) return null;
  // The only time this token exists in readable form. It is not stored, not
  // logged, and cannot be recovered — a lost agent re-pairs rather than being
  // reminded.
  return { deviceId: row.id, pharmacyId: row.pharmacy_id, token };
}

/**
 * Resolve a device token to its device, or null.
 *
 * Also stamps last_seen_at, which is what makes "this agent has gone quiet"
 * answerable at all. Deliberately updated on every authenticated call rather
 * than only on successful uploads: an agent that is running but finding no
 * file is a different problem from one that is not running, and the dashboard
 * should be able to tell them apart.
 */
async function authenticateDevice(token) {
  if (!token) return null;
  const db = getSql();

  const [row] = await db`
    update sync_devices
       set last_seen_at = now()
     where token_hash = ${hashToken(token)}
       and status = 'active'
    returning id, pharmacy_id, label, watch_path, pos_confirmed
  `;
  return row || null;
}

async function revokeDevice(pharmacyId, deviceId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    update sync_devices
       set status = 'revoked', token_hash = null, updated_at = now()
     where id = ${deviceId} and pharmacy_id = ${pharmacyId}
    returning id
  `;
  return Boolean(row);
}

async function listDevices(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const rows = await db`
    select id, label, status, pos_confirmed, watch_path, paired_at,
           last_seen_at, last_sync_at, last_sync_status, last_sync_detail,
           pairing_code,
           case when pairing_expires_at > now() then pairing_expires_at else null end as pairing_expires_at,
           -- Derived here rather than in the browser: "is this stale" is a
           -- fact about the server's clock, and a laptop with a wrong date
           -- must not be able to decide a pharmacy's catalogue is current.
           (last_sync_at is null or last_sync_at < now() - ${`${STALE_AFTER_HOURS} hours`}::interval) as is_stale
    from sync_devices
    where pharmacy_id = ${pharmacyId} and status <> 'revoked'
    order by created_at
  `;
  return rows;
}

async function recordSyncResult(deviceId, { status, detail = null, succeeded }) {
  const db = getSql();
  await db`
    update sync_devices
       set last_sync_status = ${status},
           last_sync_detail = ${detail},
           last_sync_at = case when ${Boolean(succeeded)} then now() else last_sync_at end,
           updated_at = now()
     where id = ${deviceId}
  `;
}

/**
 * The saved mapping, and whether an incoming file still matches it.
 *
 * THE WHOLE SAFETY RULE LIVES HERE.
 *
 * Columns identical to what the owner confirmed -> import unattended.
 * Anything else -> stop, and ask. A renamed or reordered column is precisely
 * how a price gets read out of a stock-count field, and the cost of asking
 * unnecessarily is one notification while the cost of not asking is wrong
 * prices quoted to real customers as fact.
 *
 * Compared as a SET, not a sequence: column order changing is not a semantic
 * change, and treating it as one would send a pharmacist to the review screen
 * every time their POS reordered an export.
 */
function mappingMatches(savedColumns, incomingColumns) {
  if (!Array.isArray(savedColumns) || savedColumns.length === 0) return false;
  if (!Array.isArray(incomingColumns)) return false;

  const norm = (c) => String(c || '').trim().toLowerCase();
  const saved = new Set(savedColumns.map(norm));
  const incoming = new Set(incomingColumns.map(norm));

  if (saved.size !== incoming.size) return false;
  for (const c of saved) if (!incoming.has(c)) return false;
  return true;
}

async function getSavedMapping(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select catalogue_sync_mapping as mapping, catalogue_sync_columns as columns
    from pharmacies where id = ${pharmacyId}
  `;
  return { mapping: row?.mapping || null, columns: row?.columns || null };
}

/**
 * Remember what the owner agreed, so the next sync need not ask.
 *
 * Called when a human confirms an import — whether that import arrived from an
 * agent or was uploaded by hand. A pharmacy that has ever confirmed a mapping
 * for a given file shape has told you how to read that shape.
 */
async function saveMapping(pharmacyId, { mapping, columns }) {
  assertPharmacyId(pharmacyId);
  if (!mapping || !Array.isArray(columns) || columns.length === 0) return;
  const db = getSql();
  await db`
    update pharmacies
       set catalogue_sync_mapping = ${db.json(mapping)},
           catalogue_sync_columns = ${db.json(columns)},
           updated_at = now()
     where id = ${pharmacyId}
  `;
}

module.exports = {
  createPairing,
  redeemPairing,
  authenticateDevice,
  revokeDevice,
  listDevices,
  recordSyncResult,
  getSavedMapping,
  saveMapping,
  mappingMatches,
  generatePairingCode,
  hashToken,
  STALE_AFTER_HOURS,
  PAIRING_TTL_MINUTES,
};
