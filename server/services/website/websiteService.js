/**
 * Pharmacy website service.
 *
 * Every function here takes pharmacyId first and calls assertPharmacyId
 * before touching the database, for the reason stated in services/db.js: the
 * API connects as service_role and bypasses RLS, so a query that forgets its
 * tenant filter is the most dangerous bug this codebase can contain. There
 * is no exception in this file — unlike services/pharmacies.js, nothing here
 * ever runs before a tenant exists.
 *
 * WHAT THIS SERVICE DOES NOT DO
 * It does not render, publish, or serve anything. `site_data` is structure
 * and copy; turning it into HTML is the renderer's job (Phase 2) and putting
 * that HTML in front of the public is the publish path's (Phase 4). Keeping
 * those apart is what lets the public route be a single indexed read of a
 * column this file writes but never formats.
 *
 * VALIDATION IS PURE AND EXPORTED
 * normalizeSiteData and the rest are exported so they can be tested without
 * a database, following the pattern in services/pharmacies.js. They are the
 * only thing standing between a browser and a jsonb column, so they are
 * worth testing exhaustively and cheaply.
 */

const { getSql, assertPharmacyId } = require('../db');
const { getTemplate, cloneSeed } = require('./templates');
const { validateBlock } = require('./blocks');
const { validateTheme } = require('./blocks/theme');

// ---------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------

/**
 * Ceiling on stored site_data, measured on the serialised JSON.
 *
 * NOT a guess at what a page needs. The express json parser accepts 2 MB
 * (index.js), and every byte accepted here is a byte read back out of
 * Postgres on every editor load and every render, over a pool capped at 15
 * connections that the WhatsApp sockets are also using. A structured page —
 * a list of blocks and their text — is a few kilobytes; 256 KB is two orders
 * of magnitude of headroom and still small enough that a pathological
 * payload cannot become a database problem.
 *
 * Rejected loudly rather than truncated: half a website silently stored is
 * worse than a save that says it failed.
 */
const MAX_SITE_DATA_BYTES = 256 * 1024;

/** Same reasoning, smaller object: guided-step answers and theme. */
const MAX_CONTENT_BYTES = 64 * 1024;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the structure a site is composed of.
 *
 * Shape: { blocks: [{ type, props }, ...] }
 *
 * Each rule exists because breaking it would either fail at render time —
 * when there is no user present to see the error — or store something the
 * renderer would have to defend against forever:
 *
 *   - an unknown block type is REJECTED here rather than skipped at render.
 *     A site that silently loses a section between saving and publishing is
 *     the kind of bug an owner reports as "it deleted my page".
 *   - props must be an object. The renderer reads named properties off it;
 *     an array or a string would read as undefined for every one of them and
 *     publish an empty section.
 *   - the whole thing is size-capped. See MAX_SITE_DATA_BYTES.
 *
 * @returns {{ok:true, value:object} | {ok:false, error:string, code:string}}
 */
function normalizeSiteData(input) {
  if (!isPlainObject(input)) {
    return { ok: false, code: 'INVALID_SITE_DATA', error: 'site_data must be an object' };
  }
  if (!Array.isArray(input.blocks)) {
    return { ok: false, code: 'INVALID_SITE_DATA', error: 'site_data.blocks must be an array' };
  }
  if (input.blocks.length > 60) {
    return { ok: false, code: 'INVALID_SITE_DATA', error: 'A page cannot have more than 60 blocks' };
  }

  // DELEGATED TO THE BLOCK REGISTRY, not re-implemented here.
  //
  // Phase 1 checked a block type against a flat list of names and accepted
  // any props at all. That was enough to store a shape, and nowhere near
  // enough to publish one: the props are what the server renderer turns into
  // public HTML, so an unchecked prop is an unchecked value on a pharmacy's
  // website. validateBlock applies the full contract — known type, registered
  // version, known props only, per-type validation, safe URLs, real phone
  // numbers — and returns the block with its version made explicit.
  //
  // This service therefore owns the SHAPE of site_data (an object with a
  // bounded array of blocks) and the registry owns what a block may contain.
  // One rule, in one place, used by the editor and the renderer alike.
  const blocks = [];
  for (const [i, block] of input.blocks.entries()) {
    const checked = validateBlock(block, `blocks[${i}]`);
    if (!checked.ok) return checked;
    blocks.push(checked.value);
  }

  const value = { blocks };
  if (byteLength(value) > MAX_SITE_DATA_BYTES) {
    return {
      ok: false,
      code: 'SITE_DATA_TOO_LARGE',
      error: `site_data exceeds ${Math.floor(MAX_SITE_DATA_BYTES / 1024)}KB`,
    };
  }
  return { ok: true, value };
}

/**
 * Guided-step answers and theme.
 *
 * `theme` goes through the theme contract, not a shape check. It is six
 * palettes, four type pairings, three radii and one validated hex — the
 * constraint that keeps a pharmacy from being able to publish something that
 * looks broken. An unknown palette name is rejected by name rather than
 * silently falling back, because a colour that does not change when you
 * change it is a support conversation.
 *
 * `content` stays a free-form object: it holds the guided flow's own working
 * answers, is never rendered directly, and its shape is still moving.
 */
function normalizeContentPatch(input) {
  const patch = {};

  if (input?.content !== undefined) {
    if (!isPlainObject(input.content)) {
      return { ok: false, code: 'INVALID_CONTENT', error: 'content must be an object' };
    }
    if (byteLength(input.content) > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        code: 'CONTENT_TOO_LARGE',
        error: `content exceeds ${Math.floor(MAX_CONTENT_BYTES / 1024)}KB`,
      };
    }
    patch.content = input.content;
  }

  if (input?.theme !== undefined) {
    const checked = validateTheme(input.theme);
    if (!checked.ok) return checked;
    patch.theme = checked.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, code: 'NOTHING_TO_UPDATE', error: 'Provide content or theme' };
  }
  return { ok: true, value: patch };
}

// ---------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------

/**
 * The columns a signed-in owner may see.
 *
 * published_html is deliberately absent. It is a render cache that can run
 * to hundreds of kilobytes, the dashboard has no use for it, and sending it
 * on every poll of the Website tab would put that payload through the pool
 * for nothing.
 */
const SITE_COLUMNS = `
  pharmacy_id, template_id, template_version, site_data, content, theme,
  status, subdomain, custom_domain, published_at, created_at, updated_at
`;

/**
 * The pharmacy's website, or null.
 *
 * NULL IS A NORMAL ANSWER, not a 404. Most pharmacies have no website yet,
 * and the Website tab's empty state is the single most-visited state this
 * feature has. Treating "not created" as an error would make the common path
 * the error path.
 */
async function getWebsite(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select ${db.unsafe(SITE_COLUMNS)}
    from pharmacy_websites
    where pharmacy_id = ${pharmacyId}
  `;
  return row || null;
}

/**
 * Create this pharmacy's website from a template.
 *
 * The seed is CLONED (see templates.js), so the new site is independent of
 * the template from the moment it exists. A later edit to the template
 * cannot reach it.
 *
 * on conflict do nothing, then read back: two clicks on "Use this template"
 * race, and the alternative — check-then-insert — has a window between the
 * two statements where the second click wins and silently discards whatever
 * the first one created.
 *
 * @returns {{ok:true, site:object} | {ok:false, code:string, error:string}}
 */
async function createWebsite(pharmacyId, { templateId } = {}) {
  assertPharmacyId(pharmacyId);

  const template = getTemplate(templateId);
  if (!template) {
    return {
      ok: false,
      code: 'UNKNOWN_TEMPLATE',
      error: `No such template: ${JSON.stringify(templateId)}`,
    };
  }

  const db = getSql();
  const seed = cloneSeed(template.id);

  // The template's theme comes across with its composition. Choosing "Modern"
  // and getting the default palette would make the three templates feel like
  // one template with the sections reordered — the look is most of what
  // distinguishes them. Validated on the way in like any other theme, so a
  // typo in a template cannot write a palette that does not exist.
  const themeCheck = validateTheme(template.theme);
  const theme = themeCheck.ok ? themeCheck.value : {};

  const [inserted] = await db`
    insert into pharmacy_websites (pharmacy_id, template_id, template_version, site_data, theme)
    values (${pharmacyId}, ${template.id}, ${template.version}, ${db.json(seed)}, ${db.json(theme)})
    on conflict (pharmacy_id) do nothing
    returning ${db.unsafe(SITE_COLUMNS)}
  `;

  if (!inserted) {
    return {
      ok: false,
      code: 'WEBSITE_EXISTS',
      error: 'This pharmacy already has a website',
    };
  }
  return { ok: true, site: inserted };
}

/**
 * Replace the draft structure.
 *
 * Writes site_data ONLY. published_data is untouched, which is the whole
 * draft/published distinction: an owner can rearrange their page all
 * afternoon and the public site does not change until they publish.
 */
async function saveSiteData(pharmacyId, siteData) {
  assertPharmacyId(pharmacyId);

  const checked = normalizeSiteData(siteData);
  if (!checked.ok) return checked;

  const db = getSql();
  const [row] = await db`
    update pharmacy_websites
       set site_data = ${db.json(checked.value)},
           updated_at = now()
     where pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SITE_COLUMNS)}
  `;
  if (!row) return { ok: false, code: 'NO_WEBSITE', error: 'No website for this pharmacy' };
  return { ok: true, site: row };
}

/**
 * Switch this pharmacy's website to a different template.
 *
 * REPLACES site_data WITH THE NEW TEMPLATE'S SEED, and nothing else. That is
 * deliberately the same clone-and-store step createWebsite performs — a
 * template seed carries no pharmacy data (see templates.js's header), only
 * structure and editorial defaults, so replacing site_data cannot lose a
 * fact about the pharmacy. `theme` and `content` are separate columns and are
 * left completely untouched: they are the owner's own settings (colour/font/
 * corners, health-guide choices), not part of what a template supplies, and
 * switching designs must not silently change them.
 *
 * Also leaves published_data / published_html / status / subdomain alone —
 * the same draft-only guarantee saveSiteData has. A design change is not
 * live until the owner publishes it.
 *
 * @returns {{ok:true, site:object} | {ok:false, code:string, error:string}}
 */
async function switchTemplate(pharmacyId, templateId) {
  assertPharmacyId(pharmacyId);

  const template = getTemplate(templateId);
  if (!template) {
    return {
      ok: false,
      code: 'UNKNOWN_TEMPLATE',
      error: `No such template: ${JSON.stringify(templateId)}`,
    };
  }

  const seed = cloneSeed(template.id);
  const db = getSql();
  const [row] = await db`
    update pharmacy_websites
       set template_id = ${template.id},
           template_version = ${template.version},
           site_data = ${db.json(seed)},
           updated_at = now()
     where pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SITE_COLUMNS)}
  `;
  if (!row) return { ok: false, code: 'NO_WEBSITE', error: 'No website for this pharmacy' };
  return { ok: true, site: row };
}

/**
 * Merge guided-step answers and theme. Same draft-only guarantee as above.
 *
 * Builds a patch object and lets the driver write the SET clause, following
 * updateProfile in services/pharmacies.js. The alternative — naming both
 * columns and passing the existing value through for whichever was not sent
 * — reads the old value and writes it back, so two guided steps saving at
 * once would have the second silently undo the first.
 *
 * db.json on each value because these are jsonb columns: without it the
 * driver infers a Postgres type from the JS value, and an array-shaped
 * theme would go in as a Postgres array rather than as JSON.
 */
async function saveContent(pharmacyId, fields) {
  assertPharmacyId(pharmacyId);

  const checked = normalizeContentPatch(fields);
  if (!checked.ok) return checked;

  const db = getSql();
  const patch = {};
  for (const [key, value] of Object.entries(checked.value)) {
    patch[key] = db.json(value);
  }

  const [row] = await db`
    update pharmacy_websites
       set ${db(patch)}, updated_at = now()
     where pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(SITE_COLUMNS)}
  `;
  if (!row) return { ok: false, code: 'NO_WEBSITE', error: 'No website for this pharmacy' };
  return { ok: true, site: row };
}

module.exports = {
  getWebsite,
  createWebsite,
  saveSiteData,
  switchTemplate,
  saveContent,
  // pure, exported for tests
  normalizeSiteData,
  normalizeContentPatch,
  MAX_SITE_DATA_BYTES,
  MAX_CONTENT_BYTES,
};
