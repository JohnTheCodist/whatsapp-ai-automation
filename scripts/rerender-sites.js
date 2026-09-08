#!/usr/bin/env node
/**
 * Re-render every published pharmacy website through the current renderer.
 *
 * WHY THIS EXISTS. A published page is stored HTML, not a live render — one
 * indexed read per visitor is what keeps a busy pharmacy website off the
 * connection pool the WhatsApp sockets are using. The cost of that decision is
 * that improving the renderer changes nothing anybody can see: every published
 * site keeps serving the bytes produced by whatever code was running the last
 * time its owner pressed Publish.
 *
 * That is not a hypothetical. A redesign was deployed, the owner republished,
 * and the live page came back byte-identical — because the publish had run
 * against the old code a few minutes before the restart. From the outside it
 * looks exactly like a deploy that did nothing, and the only way out is to ask
 * every pharmacy to press a button again.
 *
 * So the deploy does it instead. `deploy/update.sh` runs this after the
 * restart, and a renderer improvement reaches every live site the same way a
 * migration reaches every row.
 *
 * WHAT IT DOES NOT DO. It renders `published_data` — the snapshot the owner
 * deliberately published — never `site_data`. A pharmacy with a half-finished
 * draft open does not get it published by a deploy. That distinction is the
 * whole point of having two columns, and this script is the one place a
 * mistake would quietly undo it, so it delegates to
 * publishService.rerenderPublished rather than writing its own SQL.
 *
 * SAFE TO RUN AT ANY TIME, and safe to run twice: re-rendering is a pure
 * function of stored data plus the live profile, so a second run produces the
 * same bytes. A site whose render fails is reported and skipped rather than
 * taking the rest of them down with it — one pharmacy with an odd profile must
 * not block the other forty.
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env'), quiet: true });

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Nothing to re-render.');
    process.exit(1);
  }

  // Required AFTER dotenv, for the reason spelled out in the website test
  // suite: config/env.js reads process.env once, at require time, and
  // services/db.js connects with whatever it captured.
  const { getSql } = require('../server/services/db');
  const publish = require('../server/services/website/publishService');

  const db = getSql();
  const sites = await db`
    select pharmacy_id, subdomain
      from pharmacy_websites
     where status = 'published'
       and published_data is not null
     order by subdomain
  `;

  if (sites.length === 0) {
    console.log('No published websites. Nothing to do.');
    await db.end({ timeout: 5 });
    return;
  }

  console.log(`Re-rendering ${sites.length} published website${sites.length === 1 ? '' : 's'}…`);

  let ok = 0;
  const failed = [];
  for (const site of sites) {
    const label = site.subdomain || site.pharmacy_id;
    try {
      const result = await publish.rerenderPublished(site.pharmacy_id);
      if (result.skipped) {
        // Raced with an unpublish between the SELECT and here. Not a failure.
        console.log(`  – ${label}: no longer published, skipped`);
        continue;
      }
      ok += 1;
      console.log(`  ✓ ${label}: ${result.pages} page${result.pages === 1 ? '' : 's'}, ${result.bytes} bytes`);
    } catch (err) {
      failed.push({ label, message: err.message });
      console.error(`  ✗ ${label}: ${err.message}`);
    }
  }

  console.log(`\n${ok} re-rendered, ${failed.length} failed.`);
  await db.end({ timeout: 5 });

  // Non-zero on failure so a deploy script can decide what to do, but only
  // AFTER trying every site — a broken one must not hide the healthy ones.
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
