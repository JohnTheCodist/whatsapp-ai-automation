/**
 * Publishing — turning a draft into a page on the open internet.
 *
 * WHAT PUBLISH ACTUALLY DOES, and the order matters:
 *
 *   1. snapshot   site_data  →  published_data
 *   2. render     published_data + the live profile  →  published_html
 *   3. record     a revision, so this publish can be undone
 *   4. flip       status = 'published'
 *
 * `published_data` is the source of truth for what is live. `published_html`
 * is a CACHE of rendering it — regenerable at any time, which is what lets a
 * profile change refresh every live page without anyone opening an editor,
 * and what lets a renderer improvement reach existing sites by re-rendering
 * rather than by asking owners to publish again.
 *
 * THE DRAFT IS NEVER READ BY THE PUBLIC ROUTE. That separation is the whole
 * point of having two columns: an owner can rearrange their page all
 * afternoon and their customers keep seeing the last thing they deliberately
 * published.
 *
 * NO HTML EVER ARRIVES FROM A BROWSER. The route that calls publishWebsite
 * takes an empty body. Everything below is rendered here, from stored
 * structured data, by the same code that renders the preview.
 */

const { getSql, assertPharmacyId } = require('../db');
const { renderDocument } = require('./document');
const { renderAllPages } = require('./siteRender');
const { normalizeWebAddress } = require('./webAddress');
const { getPharmacy, getProfile } = require('../pharmacies');
const { assetMapFor } = require('./assetService');
const { publicBaseUrl } = require('./assetStore');

/**
 * How many publishes to keep per pharmacy.
 *
 * A revision is a few kilobytes of JSON, so twenty is generous and bounded.
 * The number exists at all because "undo" has to have a floor: unbounded
 * history is a table that grows forever for a feature almost nobody uses
 * twice.
 */
const KEEP_REVISIONS = 20;

const SITE_COLUMNS = `
  pharmacy_id, template_id, template_version, site_data, content, theme,
  status, subdomain, custom_domain, published_at, created_at, updated_at
`;

/**
 * Build the render context for a pharmacy.
 *
 * Reads the pharmacy, its profile and its assets FRESH every time, which is
 * what makes inheritance work: a published page reflects whatever the profile
 * says at the moment it was rendered, not what it said when the blocks were
 * arranged.
 *
 * ONE FUNCTION, USED BY EVERY RENDER PATH — publish, re-render, preview and
 * the editor canvas. Four hand-built context objects is four chances for one
 * of them to forget the asset map and quietly render a page with no logo,
 * which is the shape of bug that reaches production because the page still
 * looks fine to whoever wrote it.
 *
 * `assets` is the tenant boundary for images: it holds only this pharmacy's
 * rows, so a block referencing another pharmacy's asset id resolves to ''
 * rather than to their file.
 */
async function renderContextFor(pharmacyId) {
  const [pharmacy, profile, assets] = await Promise.all([
    getPharmacy(pharmacyId),
    getProfile(pharmacyId),
    assetMapFor(pharmacyId),
  ]);
  return {
    pharmacy,
    profile,
    assets,
    assetBaseUrl: publicBaseUrl(),
    year: new Date().getUTCFullYear(),
  };
}

/**
 * Claim a web address.
 *
 * Uniqueness is enforced by the unique constraint on the column, not by a
 * pre-check: SELECT-then-UPDATE races with any concurrent claim, and the
 * loser would take an address that already belongs to somebody. Catching the
 * constraint violation is the only version that cannot be raced.
 *
 * @returns {{ok:true, site:object} | {ok:false, code:string, error:string}}
 */
async function setWebAddress(pharmacyId, input) {
  assertPharmacyId(pharmacyId);

  const checked = normalizeWebAddress(input);
  if (!checked.ok) return checked;

  const db = getSql();
  try {
    const [row] = await db`
      update pharmacy_websites
         set subdomain = ${checked.value}, updated_at = now()
       where pharmacy_id = ${pharmacyId}
      returning ${db.unsafe(SITE_COLUMNS)}
    `;
    if (!row) return { ok: false, code: 'NO_WEBSITE', error: 'No website for this pharmacy' };
    return { ok: true, site: row };
  } catch (err) {
    // 23505 = unique_violation. Reported as "taken" rather than as a database
    // error, and deliberately without saying which pharmacy holds it.
    if (err.code === '23505') {
      return { ok: false, code: 'ADDRESS_TAKEN', error: `"${checked.value}" is already taken. Try another.` };
    }
    throw err;
  }
}

/**
 * Replace this pharmacy's stored pages with exactly the set just rendered.
 *
 * UPSERT THEN DELETE-WHAT-IS-MISSING, in that order and in one transaction.
 * Deleting first would leave the site with no pages for the duration of the
 * write, and a crawler that arrived in that window would see a site of 404s.
 *
 * The delete is what makes removing a service safe. A pharmacy that unticks
 * "BP checks" does not need anybody to remember /services/blood-pressure-check/
 * — it is simply not in the new set, so it goes. A publish path that only
 * ever inserted would accumulate pages for services the pharmacy no longer
 * offers, still linked from the sitemap, indefinitely.
 */
async function replacePages(tx, pharmacyId, rendered) {
  for (const page of rendered) {
    await tx`
      insert into pharmacy_website_pages (pharmacy_id, path, kind, html, title, updated_at)
      values (${pharmacyId}, ${page.path}, ${page.kind}, ${page.html}, ${page.title || null}, now())
      on conflict (pharmacy_id, path) do update
        set kind = excluded.kind,
            html = excluded.html,
            title = excluded.title,
            updated_at = now()
    `;
  }

  const keep = rendered.map((p) => p.path);
  await tx`
    delete from pharmacy_website_pages
     where pharmacy_id = ${pharmacyId}
       and not (path = any(${keep}))
  `;
}

/**
 * The absolute origin this site's canonical URLs are built from.
 *
 * Empty when subdomains are not configured, and renderDocument then omits the
 * canonical entirely. That is deliberate: a guessed canonical tells Google to
 * index a URL that may not exist, it does so silently, and the damage is
 * invisible from the site itself. No canonical is a missing optimisation; a
 * wrong one is a broken site.
 */
function canonicalBaseFor(subdomain) {
  const domain = (process.env.PUBLIC_SITE_DOMAIN || '').trim().toLowerCase();
  if (!domain || !subdomain) return '';
  return `https://${subdomain}.${domain}`;
}

/**
 * Publish the current draft.
 *
 * Refuses without a web address, because a published site with no address is
 * unreachable — a success message for a page nobody can open.
 */
async function publishWebsite(pharmacyId, { userId } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [site] = await db`
    select ${db.unsafe(SITE_COLUMNS)} from pharmacy_websites where pharmacy_id = ${pharmacyId}
  `;
  if (!site) return { ok: false, code: 'NO_WEBSITE', error: 'No website for this pharmacy' };
  if (!site.subdomain) {
    return {
      ok: false,
      code: 'NO_ADDRESS',
      error: 'Choose your web address before publishing.',
    };
  }

  const ctx = await renderContextFor(pharmacyId);
  // Published pages route their WhatsApp, phone and directions links through
  // /p/<address>/go/... so the taps can be counted. The PREVIEW deliberately
  // passes no trackingBase: a preview is the owner looking at their own page,
  // and counting that as customer engagement would make the one number this
  // feature produces a lie.
  // Every page, not just the home page. The sitemap is generated from the
  // same array in the same call, so it cannot list a URL the render skipped.
  //
  // trackingBase stays the /p/ form even though most visitors will arrive on
  // the subdomain: ONE rendering has to work on both shapes, and the host
  // router accepts the /p/ tracking path for exactly that reason. Rendering
  // twice to make redirect URLs prettier would double the storage and create
  // two versions of a page that must never disagree.
  const canonicalBase = canonicalBaseFor(site.subdomain);
  const { pages, rendered } = renderAllPages({
    ...ctx, site: site.site_data, theme: site.theme,
    trackingBase: `/p/${site.subdomain}`, canonicalBase,
    // Which health articles this owner chose to publish. Stored with the
    // other guided-flow answers, because that is what it is: a choice the
    // owner made in the builder, not a property of the site structure.
    health: Array.isArray(site.content?.health) ? site.content.health : [],
    // The owner's own wording for a generated page's heading/intro/about —
    // see websiteService.js's validatePageCopy. Read the same way health is:
    // a guided-flow answer, not part of the site structure, so it travels
    // with whichever snapshot (draft or published) is being rendered.
    pageCopy: (site.content?.pageCopy && typeof site.content.pageCopy === 'object') ? site.content.pageCopy : {},
    templateId: site.template_id || null,
  });

  // published_html remains the home page, so every existing reader of that
  // column keeps working unchanged.
  const home = rendered.find((r) => r.path === '/');
  const html = home ? home.html : renderDocument({
    ...ctx, site: site.site_data, theme: site.theme, trackingBase: `/p/${site.subdomain}`,
  });

  // One transaction: a revision written without the publish landing would
  // offer an "undo" to a state that was never live, and a publish without a
  // revision is one that cannot be undone.
  const [row] = await db.begin(async (tx) => {
    await tx`
      insert into website_revisions (pharmacy_id, site_data, template_id, template_version, published_by)
      values (${pharmacyId}, ${tx.json(site.site_data)}, ${site.template_id}, ${site.template_version}, ${userId || null})
    `;

    // Prune inside the same transaction, so history can never exceed the cap
    // even under two concurrent publishes.
    await tx`
      delete from website_revisions
       where pharmacy_id = ${pharmacyId}
         and id not in (
           select id from website_revisions
            where pharmacy_id = ${pharmacyId}
            order by created_at desc, id desc
            limit ${KEEP_REVISIONS}
         )
    `;

    await replacePages(tx, pharmacyId, rendered);

    return tx`
      update pharmacy_websites
         set published_data = ${tx.json(site.site_data)},
             published_html = ${html},
             published_at = now(),
             status = 'published',
             updated_at = now()
       where pharmacy_id = ${pharmacyId}
      returning ${tx.unsafe(SITE_COLUMNS)}
    `;
  });

  return { ok: true, site: row, bytes: html.length, pages: pages.length };
}

/**
 * Take the public page down.
 *
 * published_html and published_data are KEPT. Unpublishing is usually
 * temporary — a pharmacy closing for a month, or an owner who wants to fix
 * something before customers see it — and keeping the snapshot makes
 * republishing instant and lossless. The status column alone decides what the
 * public route will serve.
 */
async function unpublishWebsite(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    update pharmacy_websites
       set status = 'unpublished', updated_at = now()
     where pharmacy_id = ${pharmacyId} and status = 'published'
    returning ${db.unsafe(SITE_COLUMNS)}
  `;
  if (!row) return { ok: false, code: 'NOT_PUBLISHED', error: 'This website is not published' };
  return { ok: true, site: row };
}

/**
 * Re-render the live page from its published snapshot and the CURRENT profile.
 *
 * This is what a profile change triggers. It deliberately renders
 * published_data, not site_data: a pharmacy that changed its phone number
 * should get the new number on the page they published, NOT whatever
 * half-finished draft they happen to have open. Facts refresh; layout does
 * not.
 *
 * A site that is not published is a no-op rather than an error — the job runs
 * for every profile change, and most pharmacies have no published site.
 */
async function rerenderPublished(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [site] = await db`
    select published_data, theme, status, subdomain, content
      from pharmacy_websites
     where pharmacy_id = ${pharmacyId} and status = 'published'
  `;
  if (!site || !site.published_data) return { ok: true, skipped: true };

  const ctx = await renderContextFor(pharmacyId);

  // EVERY page, not just the home page. This runs when the PROFILE changes,
  // and the profile is what decides which pages exist: adding a service here
  // has to create its page, and removing one has to take the page away. A
  // rerender that only refreshed published_html would leave a pharmacy with a
  // live /services/blood-pressure-check/ it had already stopped offering, and
  // a sitemap still advertising it.
  const canonicalBase = canonicalBaseFor(site.subdomain);
  const { rendered } = renderAllPages({
    ...ctx, site: site.published_data, theme: site.theme,
    trackingBase: `/p/${site.subdomain}`, canonicalBase,
    // Which health articles this owner chose to publish. Stored with the
    // other guided-flow answers, because that is what it is: a choice the
    // owner made in the builder, not a property of the site structure.
    health: Array.isArray(site.content?.health) ? site.content.health : [],
    // The owner's own wording for a generated page's heading/intro/about —
    // see websiteService.js's validatePageCopy. Read the same way health is:
    // a guided-flow answer, not part of the site structure, so it travels
    // with whichever snapshot (draft or published) is being rendered.
    pageCopy: (site.content?.pageCopy && typeof site.content.pageCopy === 'object') ? site.content.pageCopy : {},
    templateId: site.template_id || null,
  });
  const home = rendered.find((r) => r.path === '/');
  const html = home ? home.html : renderDocument({
    ...ctx, site: site.published_data, theme: site.theme, trackingBase: `/p/${site.subdomain}`,
  });

  // One transaction: the home page cache and the page rows describe the same
  // site, and a reader that caught them disagreeing would see a navigation
  // menu listing pages that 404.
  await db.begin(async (tx) => {
    await replacePages(tx, pharmacyId, rendered);
    await tx`
      update pharmacy_websites
         set published_html = ${html}, updated_at = now()
       where pharmacy_id = ${pharmacyId} and status = 'published'
    `;
  });
  return { ok: true, skipped: false, bytes: html.length, pages: rendered.length };
}

/** Publish history, newest first. Never includes HTML — see the header. */
async function listRevisions(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select id, template_id, template_version, published_by, created_at
      from website_revisions
     where pharmacy_id = ${pharmacyId}
     order by created_at desc, id desc
     limit ${KEEP_REVISIONS}
  `;
}

/**
 * Restore a revision into the DRAFT.
 *
 * Never straight to live. Restoring is an editing action, and an owner who
 * clicks it should see the old version in their preview and decide, rather
 * than discovering they have already replaced their public page. Publishing
 * it is a second, deliberate click.
 *
 * The revision is looked up scoped to the pharmacy, so another tenant's id
 * finds nothing — 404, not 403, consistent with the rest of the codebase.
 */
async function restoreRevision(pharmacyId, revisionId) {
  assertPharmacyId(pharmacyId);
  const id = Number(revisionId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, code: 'NOT_FOUND', error: 'No such revision' };
  }

  const db = getSql();
  const [revision] = await db`
    select site_data, template_id, template_version
      from website_revisions
     where id = ${id} and pharmacy_id = ${pharmacyId}
  `;
  if (!revision) return { ok: false, code: 'NOT_FOUND', error: 'No such revision' };

  const [row] = await db`
    update pharmacy_websites
       set site_data = ${db.json(revision.site_data)},
           template_id = ${revision.template_id},
           template_version = ${revision.template_version},
           updated_at = now()
     where pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SITE_COLUMNS)}
  `;
  if (!row) return { ok: false, code: 'NO_WEBSITE', error: 'No website for this pharmacy' };
  return { ok: true, site: row };
}

module.exports = {
  renderContextFor,
  setWebAddress,
  publishWebsite,
  unpublishWebsite,
  rerenderPublished,
  listRevisions,
  restoreRevision,
  KEEP_REVISIONS,
};
