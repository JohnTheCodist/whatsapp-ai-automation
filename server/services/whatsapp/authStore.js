/**
 * Postgres-backed Baileys auth state — encrypted, tenant-scoped, and LAZY.
 *
 * WHY LAZY IS THE WHOLE POINT
 * Baileys splits its auth state in two:
 *
 *   creds — one small blob per session. Always loaded. Fine.
 *   keys  — Signal protocol material: one entry per contact you have ever
 *           exchanged messages with, plus pre-keys, sender keys, app-state
 *           sync keys. Unbounded in the number of customers a pharmacy has.
 *
 * The reference `useMultiFileAuthState` reads keys from disk per id, which is
 * the correct shape. The tempting shortcut — load every key for a session
 * into memory on connect — is what makes Baileys deployments fall over: memory
 * then scales with CONTACT count instead of SOCKET count.
 *
 * Measured in ARCHITECTURE.md §6.8: a socket costs ~1-2 MB, so a 1 GB box
 * holds 50-100 pharmacies. That number is only true if this file stays lazy.
 * `keys.get(type, ids)` here is one indexed lookup returning exactly the rows
 * asked for, and nothing is cached across calls.
 *
 * If you ever "optimise" this by preloading, you have not made it faster —
 * you have converted a bounded system into an unbounded one.
 *
 * EVERY VALUE IS A CREDENTIAL. Encrypted at rest (crypto.js). Never logged,
 * never returned from an API, never put in an error message.
 */

const { initAuthCreds, BufferJSON, proto } = require('baileys');
const { getSql, assertPharmacyId } = require('../db');
const { encrypt, decrypt } = require('../crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertAccountId(id) {
  if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`authStore: invalid whatsappAccountId (${JSON.stringify(id)}).`);
  }
}

// Baileys' own serialisation. Creds and keys contain Buffers and Uint8Arrays
// that plain JSON.stringify would flatten into unusable objects — silently,
// and only visible later as a protocol failure on a live socket.
const serialise = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialise = (text) => JSON.parse(text, BufferJSON.reviver);

/**
 * Builds the `{ state, saveCreds }` pair Baileys expects.
 *
 * @param {string} pharmacyId    tenant, guarded
 * @param {string} accountId     whatsapp_accounts.id
 * @returns {Promise<{state: object, saveCreds: () => Promise<void>, clear: () => Promise<void>}>}
 */
async function createAuthStore(pharmacyId, accountId) {
  assertPharmacyId(pharmacyId);
  assertAccountId(accountId);

  const db = getSql();

  // Verify the account belongs to this tenant ONCE, here, rather than adding
  // pharmacy_id to every key query below. The keys table is scoped by
  // account id, and this is the only place an account id enters the system —
  // so this single check is what makes the rest of the file safe.
  const [account] = await db`
    select id, creds_encrypted
    from whatsapp_accounts
    where id = ${accountId} and pharmacy_id = ${pharmacyId}
  `;
  if (!account) {
    throw new Error(
      `authStore: whatsapp_account ${accountId} does not belong to pharmacy ${pharmacyId}. ` +
      'Refusing to open a session across tenants.'
    );
  }

  // Restore, or mint a fresh identity. A decrypt failure is deliberately NOT
  // swallowed into "start fresh": silently re-pairing on a bad key would look
  // like a flaky session to the pharmacy and destroy a recoverable one.
  const creds = account.creds_encrypted
    ? deserialise(decrypt(account.creds_encrypted).toString('utf8'))
    : initAuthCreds();

  async function saveCreds() {
    await db`
      update whatsapp_accounts
      set creds_encrypted = ${encrypt(serialise(creds))}, updated_at = now()
      where id = ${accountId}
    `;
  }

  const keys = {
    /**
     * Batched read by id. One query, only the requested rows.
     * Returns { [id]: value } with missing ids absent, which is what Baileys
     * expects — it treats a missing key as "not known yet", not an error.
     */
    async get(type, ids) {
      if (!ids || ids.length === 0) return {};

      const rows = await db`
        select key_id, value_encrypted
        from whatsapp_auth_keys
        where whatsapp_account_id = ${accountId}
          and key_type = ${type}
          and key_id = any(${ids})
      `;

      const out = {};
      for (const row of rows) {
        let value = deserialise(decrypt(row.value_encrypted).toString('utf8'));
        // App-state sync keys must be rehydrated into their protobuf class or
        // Baileys' app-state decoding fails further downstream, far from here.
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        out[row.key_id] = value;
      }
      return out;
    },

    /**
     * @param {object} data  { [type]: { [id]: value | null } } — null deletes.
     *
     * Written in one transaction. Baileys calls this with batches (30 pre-keys
     * at a time is normal); a partial write would leave a session that looks
     * connected and cannot decrypt.
     */
    async set(data) {
      const upserts = [];
      const deletesByType = new Map();

      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type] || {})) {
          const value = data[type][id];
          if (value === null || value === undefined) {
            if (!deletesByType.has(type)) deletesByType.set(type, []);
            deletesByType.get(type).push(id);
          } else {
            upserts.push({
              whatsapp_account_id: accountId,
              key_type: type,
              key_id: id,
              value_encrypted: encrypt(serialise(value)),
            });
          }
        }
      }

      if (upserts.length === 0 && deletesByType.size === 0) return;

      // ONE statement for all the upserts, not one per key.
      //
      // Baileys writes pre-keys in batches of ~30 during initialisation, and
      // a loop of single-row inserts is ~30 sequential round trips. Against a
      // transatlantic pooler at a few hundred milliseconds each that runs to
      // tens of seconds, which blows straight past Baileys' own pre-key
      // upload timeout. The session then sits in `connecting` forever with
      // "Pre-key upload timeout" as the only clue, having genuinely paired.
      //
      // Measured: this is what stopped the first successful link from ever
      // reaching `open`.
      await db.begin(async (tx) => {
        if (upserts.length > 0) {
          await tx`
            insert into whatsapp_auth_keys ${tx(
              upserts, 'whatsapp_account_id', 'key_type', 'key_id', 'value_encrypted'
            )}
            on conflict (whatsapp_account_id, key_type, key_id) do update
              set value_encrypted = excluded.value_encrypted, updated_at = now()
          `;
        }
        // One statement per key TYPE rather than per key. Baileys rarely
        // deletes more than a handful of types at once.
        for (const [type, ids] of deletesByType) {
          await tx`
            delete from whatsapp_auth_keys
            where whatsapp_account_id = ${accountId}
              and key_type = ${type}
              and key_id = any(${ids})
          `;
        }
      });
    },
  };

  /**
   * Wipe everything for this session. Used on logout — a logged-out
   * credential is not merely stale, it is dead, and keeping it invites a
   * reconnect loop against an account WhatsApp has already rejected.
   */
  async function clear() {
    await db.begin(async (tx) => {
      await tx`delete from whatsapp_auth_keys where whatsapp_account_id = ${accountId}`;
      await tx`
        update whatsapp_accounts
        set creds_encrypted = null, updated_at = now()
        where id = ${accountId}
      `;
    });
  }

  return { state: { creds, keys }, saveCreds, clear };
}

module.exports = { createAuthStore };
