/**
 * Where a pharmacy's uploaded images actually live.
 *
 * SUPABASE STORAGE, and the reasons are the ones from the Phase 0 audit:
 *
 *   - Postgres bytea would put multi-megabyte blobs through a connection pool
 *     capped at 15 that every pharmacy's live WhatsApp socket also uses.
 *   - Render has no persistent disk. `render.yaml` says so explicitly, and
 *     adding one would pin the service to a single instance.
 *   - The Supabase project, the service-role key and @supabase/supabase-js
 *     are already here. This adds an API surface, not a dependency.
 *
 * THE BACKEND IS INJECTABLE, and that is not architecture for its own sake.
 * There is no test Supabase project — the test database is a local Postgres —
 * so without a seam, every rule that matters here (tenant path prefixing,
 * magic-byte validation, refusing another pharmacy's asset) would be
 * untestable and would ship on the strength of having been read carefully.
 * `setStore()` lets the suite substitute an in-memory double and exercise all
 * of it.
 */

const { createClient } = require('@supabase/supabase-js');
const { env } = require('../../config/env');

/**
 * One bucket for every pharmacy, with tenancy carried in the object path.
 *
 * A bucket per pharmacy would mean a bucket-creation call in the signup path,
 * a per-tenant resource to clean up on deletion, and a limit nobody has
 * measured. One bucket with `<pharmacy_id>/<asset_id>.<ext>` paths gives the
 * same isolation through a prefix the API always writes and never accepts
 * from a client.
 */
const BUCKET = 'pharmacy-assets';

let client = null;
function supabase() {
  if (!client) {
    client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

/**
 * The public base URL for objects in the bucket.
 *
 * Derived from SUPABASE_URL rather than configured separately, so there is
 * one place a project change has to be made. Also used to build the CSP
 * `img-src` entry — a published page whose images come from an origin the
 * policy does not name renders empty boxes and a console warning, with
 * nothing on the page to suggest why.
 */
function publicBaseUrl() {
  if (!env.supabase.url) return '';
  return `${env.supabase.url.replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}`;
}

/** The origin a Content-Security-Policy needs to permit for uploaded images. */
function storageOrigin() {
  try {
    return new URL(env.supabase.url).origin;
  } catch {
    return null;
  }
}

const supabaseStore = {
  /**
   * Write an object. `path` is always built by the service and always begins
   * with the pharmacy's id — this function never constructs it.
   */
  async put(path, buffer, contentType) {
    const { error } = await supabase().storage.from(BUCKET).upload(path, buffer, {
      contentType,
      // Immutable in practice: every object gets a fresh uuid, so an upsert
      // could only ever overwrite something after a uuid collision. `false`
      // turns that impossible case into an error rather than silent data loss.
      upsert: false,
      // A year. The path contains a uuid that never changes content, so the
      // only way to get a different image is a different URL.
      cacheControl: '31536000',
    });
    if (error) throw new Error(`Could not store the image: ${error.message}`);
    return { path };
  },

  async remove(path) {
    const { error } = await supabase().storage.from(BUCKET).remove([path]);
    // A missing object is the desired end state, not a failure — the database
    // row is what the product cares about, and a delete that already happened
    // must not block removing the row.
    if (error && !/not found/i.test(error.message)) {
      throw new Error(`Could not delete the image: ${error.message}`);
    }
  },
};

let active = supabaseStore;

/** Swap the backend. Tests only — nothing in the app calls this. */
function setStore(store) {
  active = store || supabaseStore;
}

module.exports = {
  BUCKET,
  publicBaseUrl,
  storageOrigin,
  setStore,
  put: (...args) => active.put(...args),
  remove: (...args) => active.remove(...args),
};
