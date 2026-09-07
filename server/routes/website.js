/**
 * Pharmacy website routes.
 *
 * Every route operates on req.pharmacyId, which requireAuth resolved from a
 * verified session. Like routes/pharmacies.js, no URL here carries a tenant
 * id and no handler reads one from the body — there is deliberately nothing
 * in the request that names a pharmacy, so there is nothing anyone could
 * later be tempted to trust.
 *
 * THE PUBLIC PAGE IS NOT SERVED FROM HERE. Everything in this file is
 * authenticated and tenant-scoped; `GET /p/:slug` lives in routes/publicSite.js
 * with no session at all, and the two are kept apart deliberately so that the
 * unauthenticated surface is one small file somebody can read in full.
 *
 * IMAGE UPLOADS are here too, and are the one place this router accepts a
 * file. What is stored is decided by the file's own bytes, never by its name
 * or its declared type — see services/website/assetService.js.
 */

const express = require('express');
const multer = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const website = require('../services/website/websiteService');
const publish = require('../services/website/publishService');
const assets = require('../services/website/assetService');
const analytics = require('../services/website/analytics');
const { listTemplates } = require('../services/website/templates');
const { renderDocument } = require('../services/website/document');
const { editorManifest } = require('../services/website/blocks/editorManifest');
const { themeOptions } = require('../services/website/blocks/theme');
const { baseDomain } = require('../services/website/publicSite');
const { renderBlock } = require('../services/website/blocks');
const { stylesheet } = require('../services/website/blocks/stylesheet');

const router = express.Router();

/**
 * Service results carry a code; the HTTP layer decides the status.
 *
 * Kept as a map rather than as `err.status` on the service side because the
 * service is also called by the job worker (Phase 4), where an HTTP status
 * is meaningless. The service says what went wrong; only this file cares
 * what that means over HTTP.
 */
const STATUS_BY_CODE = Object.freeze({
  UNKNOWN_TEMPLATE: 400,
  INVALID_SITE_DATA: 400,
  UNKNOWN_BLOCK: 400,
  SITE_DATA_TOO_LARGE: 413,
  INVALID_CONTENT: 400,
  CONTENT_TOO_LARGE: 413,
  NOTHING_TO_UPDATE: 400,
  NO_WEBSITE: 404,
  WEBSITE_EXISTS: 409,
  INVALID_THEME: 400,
  // Publishing (phase 4).
  INVALID_ADDRESS: 400,
  // 409, not 400: the request was well-formed, it lost a race for a name.
  ADDRESS_TAKEN: 409,
  ADDRESS_RESERVED: 409,
  // 409 rather than 400 for the same reason — the site is fine, its state
  // is just not one this action applies to.
  NO_ADDRESS: 409,
  NOT_PUBLISHED: 409,
  NOT_FOUND: 404,
  // Images (phase 6).
  NO_FILE: 400,
  EMPTY_FILE: 400,
  INVALID_KIND: 400,
  UNSUPPORTED_IMAGE: 415,
  // 413 is the honest status for a body that was too big to accept.
  FILE_TOO_LARGE: 413,
});

/** Turn a service failure into the right HttpError, or return the value. */
function unwrap(result) {
  if (result.ok) return result;
  throw new HttpError(STATUS_BY_CODE[result.code] ?? 400, result.error, result.code);
}

/**
 * GET /api/website — this pharmacy's website, or null.
 *
 * `{site: null}` with a 200, NOT a 404. Every pharmacy that has never built
 * a site hits this endpoint every time the Website tab opens, and that is
 * the most common state this feature has. A 404 would make the ordinary
 * path an error path and put a red line in the browser console for a
 * pharmacy that has done nothing wrong.
 */
router.get('/', requireAuth, asyncRoute(async (req, res) => {
  const site = await website.getWebsite(req.pharmacyId);
  // The dashboard cannot work this out for itself. It is always served from
  // app.rxnaija.com, so deriving the address from window.location produces the
  // PATH form even when subdomains are live — and this is the screen that tells
  // an owner they will be printing it. Null means subdomains are not
  // configured, in which case the path form genuinely is the real address.
  res.json({ site, publicDomain: baseDomain() || null });
}));

/**
 * GET /api/website/templates — what an owner may choose from.
 *
 * Manifests only: id, version, name, description, preview path. The seed
 * site_data is deliberately not sent. The client never needs it — creating
 * a site clones the seed server-side — and shipping it would put the whole
 * template library through the pool on every visit to the picker.
 */
router.get('/templates', requireAuth, asyncRoute(async (req, res) => {
  res.json({ templates: listTemplates() });
}));

/**
 * POST /api/website — create this pharmacy's website from a template.
 *
 * pharmacist as well as owner: choosing a template is reversible and is the
 * sort of setup work a senior staff member does. Publishing it to the public
 * internet is not, and that stays owner-only in Phase 4.
 */
router.post('/', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const result = unwrap(
    await website.createWebsite(req.pharmacyId, { templateId: req.body?.template_id })
  );
  res.status(201).json({ site: result.site });
}));

/**
 * PUT /api/website/site — replace the draft structure.
 *
 * PUT, not PATCH: the editor and the guided flow both hold the whole page in
 * memory and send it entire. A partial update would need a merge rule for
 * an ordered list of blocks, and every merge rule for an ordered list is
 * wrong in some reordering case.
 *
 * Touches site_data only. published_data is untouched, so an owner can
 * rearrange their page all afternoon without the public site changing.
 */
router.put('/site', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const result = unwrap(await website.saveSiteData(req.pharmacyId, req.body?.site_data));
  res.json({ site: result.site });
}));

/** PATCH /api/website/content — guided-step answers and theme. */
router.patch('/content', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const result = unwrap(await website.saveContent(req.pharmacyId, req.body || {}));
  res.json({ site: result.site });
}));

/**
 * PUT /api/website/address — claim the address the site publishes at.
 *
 * Named for what it is to a pharmacy owner rather than for the column it
 * writes (`subdomain`). Today it resolves as a path, `/p/<address>`; when
 * wildcard DNS lands it also resolves as a subdomain, and the name will still
 * be right. Owner-only: it is the permanent public identity of the business.
 */
router.put('/address', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  const result = unwrap(await publish.setWebAddress(req.pharmacyId, req.body?.address));
  res.json({ site: result.site });
}));

/**
 * POST /api/website/publish — put the current draft on the internet.
 *
 * TAKES AN EMPTY BODY, and that is the single most important line in this
 * file. The server renders the page from stored structured data; there is no
 * field here a browser could put markup into, so the whole stored-XSS class
 * has no route to a published page. If a future change adds a body parameter
 * to this handler, that property is gone.
 */
router.post('/publish', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  const result = unwrap(await publish.publishWebsite(req.pharmacyId, { userId: req.user?.id }));
  res.json({ site: result.site, bytes: result.bytes });
}));

/** POST /api/website/unpublish — take it down, keeping the snapshot. */
router.post('/unpublish', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  const result = unwrap(await publish.unpublishWebsite(req.pharmacyId));
  res.json({ site: result.site });
}));

/** GET /api/website/revisions — publish history, newest first. */
router.get('/revisions', requireAuth, asyncRoute(async (req, res) => {
  res.json({ revisions: await publish.listRevisions(req.pharmacyId) });
}));

/**
 * POST /api/website/revisions/:id/restore — bring an old version back.
 *
 * Into the DRAFT, never straight to live. An owner restoring something should
 * see it in their preview and decide, not discover they have already replaced
 * the page their customers are looking at.
 */
router.post('/revisions/:id/restore', requireAuth, requireRole('owner'), asyncRoute(async (req, res) => {
  const result = unwrap(await publish.restoreRevision(req.pharmacyId, req.params.id));
  res.json({ site: result.site });
}));

/**
 * Image uploads.
 *
 * memoryStorage, like every other upload in this codebase: the bytes are
 * inspected and forwarded to object storage immediately, so a temp file on
 * disk would be one more thing to clean up and to secure for no gain.
 *
 * The multer limit is the FIRST of two size checks and exists to stop a large
 * body being buffered at all. assetService checks again against the same
 * ceiling, because that is where the rule belongs and because the service is
 * callable from places multer is not.
 *
 * NO fileFilter ON THE EXTENSION. Deliberately different from the catalogue
 * upload above, and worth understanding rather than copying: a spreadsheet is
 * identified by its extension because the parser needs to know which format
 * to try. An image is identified by its CONTENT, because the name is
 * attacker-controlled and `logo.png` full of HTML is the entire attack.
 * Filtering on the extension here would imply a check that had not happened.
 */
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: assets.MAX_BYTES, files: 1 },
});

/** POST /api/website/assets — upload a logo or an image. */
router.post(
  '/assets',
  requireAuth,
  requireRole('owner', 'pharmacist'),
  uploadImage.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No image was uploaded.', 'NO_FILE');
    const result = unwrap(await assets.uploadAsset(req.pharmacyId, {
      buffer: req.file.buffer,
      kind: req.body?.kind,
    }));
    res.status(201).json({ asset: result.asset, baseUrl: assets.publicBaseUrl() });
  }),
);

/** GET /api/website/assets — this pharmacy's images. Always tenant-scoped. */
router.get('/assets', requireAuth, asyncRoute(async (req, res) => {
  res.json({
    assets: await assets.listAssets(req.pharmacyId, { kind: req.query?.kind }),
    baseUrl: assets.publicBaseUrl(),
  });
}));

/**
 * DELETE /api/website/assets/:id — remove an image.
 *
 * Another pharmacy's id returns 404, not 403. Consistent with selectTenant in
 * middleware/auth.js: confirming that an id exists is itself a disclosure.
 */
router.delete('/assets/:id', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  unwrap(await assets.deleteAsset(req.pharmacyId, req.params.id));
  res.status(204).end();
}));

/**
 * GET /api/website/analytics — what this pharmacy's website did.
 *
 * Readable by any member, not just the owner: "did the website bring anyone
 * in" is a question the whole counter cares about, and there is nothing
 * sensitive in a count. Tenant-scoped like everything else here.
 */
router.get('/analytics', requireAuth, asyncRoute(async (req, res) => {
  res.json(await analytics.summary(req.pharmacyId, { days: req.query?.days }));
}));

/**
 * GET /api/website/blocks — the block contract, as data.
 *
 * The server owns the contract and ships it; the client never keeps a second
 * copy. That is decision 10 of WEBSITE_BUILDER_DECISIONS.md, and it is what
 * makes "an unknown block renders nothing" true by construction rather than
 * by two codebases agreeing to stay in step.
 *
 * Also carries the theme options, because the branding step needs the same
 * fixed sets the renderer uses and there is no reason to make it ask twice.
 */
router.get('/blocks', requireAuth, asyncRoute(async (req, res) => {
  res.json({ ...editorManifest(), theme: themeOptions() });
}));

/**
 * POST /api/website/render-blocks — render an UNSAVED arrangement, block by
 * block, for the advanced editor's canvas.
 *
 * WHY THIS TAKES site_data FROM THE CLIENT WHEN NOTHING ELSE DOES.
 * The editor needs to show what a change looks like before it is saved —
 * that is the whole point of a visual editor. So this one endpoint renders an
 * arrangement that is not yet in the database.
 *
 * IT IS NOT A HOLE IN THE PUBLISHING GUARANTEE, and the reason is worth being
 * precise about: what comes back from here goes into an editor canvas and
 * nowhere else. It is never stored, never published, and never seen by a
 * customer. Publishing still renders from `published_data` on the server, and
 * `POST /publish` still takes an empty body. The blast radius of this route
 * is one owner's own browser tab.
 *
 * The input still goes through the full block contract — unknown types,
 * unknown props and unsafe URLs are refused here exactly as they are on save,
 * so the editor cannot preview something it would not be allowed to store.
 *
 * Returns one fragment per block rather than a whole document, because the
 * canvas needs to attach each one to its own component. The stylesheet comes
 * with it so the canvas can look like the real page.
 */
router.post('/render-blocks', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const checked = website.normalizeSiteData(req.body?.site_data);
  if (!checked.ok) throw new HttpError(STATUS_BY_CODE[checked.code] ?? 400, checked.error, checked.code);

  const site = await website.getWebsite(req.pharmacyId);
  if (!site) throw new HttpError(404, 'No website for this pharmacy', 'NO_WEBSITE');

  const ctx = await publish.renderContextFor(req.pharmacyId);

  res.json({
    blocks: checked.value.blocks.map((block, index) => ({
      index,
      type: block.type,
      version: block.version,
      html: renderBlock(block, ctx),
    })),
    css: stylesheet(site.theme),
  });
}));

/**
 * GET /api/website/preview.html — the DRAFT, rendered exactly as it would
 * publish.
 *
 * ITS OWN CSP, AND THAT IS THE WHOLE REASON THIS ROUTE EXISTS AS HTML RATHER
 * THAN JSON. The dashboard sends `frame-ancestors 'none'`, which blocks
 * framing by ANY origin including its own — so a preview iframe pointed at a
 * normal route renders a blank box and a console warning, with nothing to
 * suggest the policy was the cause. This response sets `frame-ancestors
 * 'self'` so the dashboard can frame it, and nobody else can.
 *
 * Otherwise it is the published policy: no scripts, no objects, images only
 * from this origin, fonts only from Google's two hosts. A preview that was
 * more permissive than the real thing would be a preview that lies.
 *
 * noindex is set in the document itself. A crawler that reached a draft would
 * be indexing a half-finished pharmacy website.
 */
router.get('/preview.html', requireAuth, asyncRoute(async (req, res) => {
  const site = await website.getWebsite(req.pharmacyId);
  if (!site) throw new HttpError(404, 'No website for this pharmacy', 'NO_WEBSITE');

  const ctx = await publish.renderContextFor(req.pharmacyId);

  const html = renderDocument({
    ...ctx,
    site: site.site_data,
    theme: site.theme,
    // The asset map and the year come from renderContextFor above. They used
    // to be overridden here with an empty Map, which — spread AFTER ...ctx —
    // would now silently blank every uploaded logo in the preview while the
    // published page showed it correctly. Exactly the kind of difference a
    // preview must not have.
    noindex: true,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      // Uploaded images come from object storage, so the preview must permit
      // that origin or a pharmacy's logo is missing HERE and present on the
      // published page — a preview that lies about what publishing produces.
      `img-src 'self' data:${assets.storageOrigin() ? ` ${assets.storageOrigin()}` : ''}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "script-src 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  // A draft changes on every keystroke of the guided flow. Caching it would
  // show the owner their previous answer.
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}));

module.exports = router;
