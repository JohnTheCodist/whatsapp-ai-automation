/**
 * Queueing a re-render of a published website.
 *
 * WHY THIS IS ITS OWN MODULE, and a very small one: it is called from
 * services/pharmacies.js, and publishService — which does the actual render —
 * calls back into pharmacies.js for the profile. Importing publishService
 * from pharmacies.js would close that loop into a require cycle. This file
 * touches nothing but the `jobs` table, so it can be imported from anywhere.
 *
 * WHAT IT IS FOR
 * A pharmacy that changes its phone number in Settings must not have to open
 * the website builder for its live page to catch up. The profile is the
 * single source of truth; this is the mechanism that makes that true for a
 * page that has already been rendered to HTML.
 */

const JOB_KIND = 'website_render';

/**
 * Enqueue a re-render, unless one is already waiting.
 *
 * DEDUPED, because an owner correcting four fields in Settings produces four
 * writes in ten seconds, and four identical renders of the same page is three
 * wasted trips through a connection pool that the WhatsApp sockets are also
 * using. `where not exists` collapses a burst into one job — whichever runs
 * will read the profile as it stands then, so the last edit is included
 * regardless of which insert won.
 *
 * NEVER THROWS. It is called from inside a profile save, and a queueing
 * failure must not fail that save: the pharmacy's data is the important part,
 * and a stale published page is a much smaller problem than an owner being
 * told their address could not be updated. The error is logged and swallowed.
 *
 * @param {object} db  an active postgres.js connection or transaction
 */
async function enqueueRerender(db, pharmacyId) {
  try {
    await db`
      insert into jobs (pharmacy_id, kind, payload)
      select ${pharmacyId}, ${JOB_KIND}, '{}'::jsonb
       where not exists (
         select 1 from jobs
          where pharmacy_id = ${pharmacyId}
            and kind = ${JOB_KIND}
            and status = 'queued'
       )
    `;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'could not queue a website re-render — the published page may be stale',
      pharmacyId,
      error: err.message,
    }));
  }
}

module.exports = { enqueueRerender, JOB_KIND };
