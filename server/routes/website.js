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
const { listTemplates, getTemplate, cloneSeed } = require('../services/website/templates');
const { publishableArticles } = require('../services/website/health');
const { buildPages } = require('../services/website/pages');
const pharmacies = require('../services/pharmacies');
const { generatePageCopy } = require('../services/ai/pageCopyGenerator');
const { generateBlockCopy } = require('../services/ai/blockCopyGenerator');
const { LlmUnavailable } = require('../services/ai/llmClient');
const { renderDocument } = require('../services/website/document');
const { renderAllPages } = require('../services/website/siteRender');
const { editorManifest } = require('../services/website/blocks/editorManifest');
const { themeOptions } = require('../services/website/blocks/theme');
const { baseDomain } = require('../services/website/publicSite');
const { renderBlock, getBlock } = require('../services/website/blocks');
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

  // The generated pages this site currently has — About, Services, one per
  // service, Location, Contact, the health index — computed with the exact
  // same buildPages() the renderer and the sitemap use, so the dashboard can
  // offer "edit this page's wording" without keeping a second copy of the
  // rules that decide which pages exist. Pure and cheap: buildPages does no
  // I/O of its own; only reachable once a site does, since a pharmacy with
  // no website yet has no pages to list.
  let pages = [];
  if (site) {
    const [pharmacy, profile] = await Promise.all([
      pharmacies.getPharmacy(req.pharmacyId),
      pharmacies.getProfile(req.pharmacyId),
    ]);
    const health = Array.isArray(site.content?.health) ? site.content.health : [];
    pages = buildPages({ pharmacy, profile, health, healthLibrary: publishableArticles() })
      // 'home' is edited through the guided form or the advanced editor —
      // it has no generated heading/intro of the kind this list is for.
      // 'health' articles are reviewed clinical content (health.js) and must
      // stay out of a generic page-text channel entirely, not just out of
      // this list — see pageContent.js's own guard for the part that matters.
      .filter((page) => page.kind !== 'home' && page.kind !== 'health')
      .map((page) => ({ path: page.path, kind: page.kind, nav: page.nav, label: page.label || page.nav }));
  }

  // The dashboard cannot work this out for itself. It is always served from
  // app.rxnaija.com, so deriving the address from window.location produces the
  // PATH form even when subdomains are live — and this is the screen that tells
  // an owner they will be printing it. Null means subdomains are not
  // configured, in which case the path form genuinely is the real address.
  res.json({ site, publicDomain: baseDomain() || null, pages });
}));

/**
 * GET /api/website/health-articles — what this pharmacy may publish.
 *
 * PUBLISHABLE ONLY. The list is the approved-and-reviewed set, so the
 * builder cannot offer a toggle for an article that would then refuse to
 * render. An owner who could switch on an unreviewed article and see nothing
 * appear would reasonably conclude the feature was broken, and the honest
 * answer is that there is nothing to offer yet.
 *
 * The reviewer travels with each one, because "who checked this?" is the
 * question a pharmacist should be able to answer before putting their own
 * name on the page.
 */
/**
 * POST /api/website/pages/copy/generate — draft a heading, introduction or
 * "about this service" paragraph with AI, for one generated page.
 *
 * A DRAFT, exactly like POST /me/assistant/welcome-note/generate: nothing
 * here is saved. The owner reads it, edits it if they want, and PATCHes
 * /content themselves through the normal pageCopy save path — auto-writing
 * something onto a page nobody approved is not a shortcut this takes.
 *
 * The page's kind and label are looked up server-side from the pharmacy's
 * own buildPages() output rather than trusted from the request — the same
 * function GET / already uses to build the list this button appears next to,
 * so the two can never name a different page for the same path. Requesting
 * copy for '/'(home) or a health-article path is refused for the same
 * reason pageContent.js refuses to apply an override there: 'home' has no
 * generated heading of this kind, and health articles are reviewed clinical
 * content that a generic drafting tool must not touch even at the draft stage.
 */
router.post('/pages/copy/generate', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const path = typeof req.body?.path === 'string' ? req.body.path : null;
  const field = typeof req.body?.field === 'string' ? req.body.field : null;
  if (!path || !['heading', 'intro', 'about', 'mission', 'vision'].includes(field)) {
    throw new HttpError(400, 'A valid path and field is required.', 'INVALID_BODY');
  }

  const [pharmacy, profile, site] = await Promise.all([
    pharmacies.getPharmacy(req.pharmacyId),
    pharmacies.getProfile(req.pharmacyId),
    website.getWebsite(req.pharmacyId),
  ]);
  if (!pharmacy) throw new HttpError(404, 'Pharmacy not found', 'NOT_FOUND');

  const health = Array.isArray(site?.content?.health) ? site.content.health : [];
  const page = buildPages({ pharmacy, profile, health, healthLibrary: publishableArticles() })
    .find((p) => p.path === path);
  if (!page || page.kind === 'home' || page.kind === 'health') {
    throw new HttpError(404, 'No such page to draft copy for', 'NOT_FOUND');
  }

  try {
    const text = await generatePageCopy({
      pharmacyName: pharmacy.name,
      area: [profile?.city, profile?.state].filter(Boolean).join(', ') || null,
      description: profile?.description || null,
      services: Array.isArray(profile?.services) ? profile.services.map((s) => s?.name).filter(Boolean) : [],
      kind: page.kind,
      label: page.label || page.nav,
      field,
    });
    res.json({ text });
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      throw new HttpError(503, 'AI writing is not available right now. Try writing it yourself instead.', 'LLM_UNAVAILABLE');
    }
    throw err;
  }
}));

/**
 * POST /api/website/home/copy/generate — draft the text for one editable
 * field on one section (block) of the pharmacy's own homepage.
 *
 * A DRAFT, exactly like /pages/copy/generate — nothing here is saved. The
 * owner reads it, edits it if they want, and saves it themselves through the
 * normal site_data save path (PUT /site), which HomeContent.jsx already
 * calls for a typed edit.
 *
 * blockIndex NAMES A POSITION IN THE PHARMACY'S OWN site_data, not a block
 * type — so this can only ever draft text for a section that pharmacy
 * actually has, in the actual version it actually has, the same defence
 * /pages/copy/generate applies by looking up the path in the pharmacy's own
 * buildPages() rather than trusting a kind/label the client asserts.
 *
 * THE FIELD MUST BE A REAL, WRITABLE, TEXT PROP ON THAT BLOCK — checked
 * against the block registry rather than assumed from the request. A prop
 * with a `from` binding (the About block's description, inherited from the
 * pharmacy profile) is refused: that text is not this block's to invent, it
 * is edited in Website content, and AI-drafting it here would be a second,
 * divergent way to change the same fact.
 */
router.post('/home/copy/generate', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const blockIndex = Number.isInteger(req.body?.blockIndex) ? req.body.blockIndex : null;
  const field = typeof req.body?.field === 'string' ? req.body.field : null;
  if (blockIndex === null || blockIndex < 0 || !field) {
    throw new HttpError(400, 'A valid blockIndex and field are required.', 'INVALID_BODY');
  }

  const [pharmacy, profile, site] = await Promise.all([
    pharmacies.getPharmacy(req.pharmacyId),
    pharmacies.getProfile(req.pharmacyId),
    website.getWebsite(req.pharmacyId),
  ]);
  if (!pharmacy) throw new HttpError(404, 'Pharmacy not found', 'NOT_FOUND');

  const block = site?.site_data?.blocks?.[blockIndex];
  if (!block) throw new HttpError(404, 'No such section on your homepage', 'NOT_FOUND');

  const definition = getBlock(block.type, block.version);
  const spec = definition?.props?.[field];
  if (!definition || !spec || spec.type !== 'text' || spec.from) {
    throw new HttpError(400, 'This field cannot be written by AI.', 'FIELD_NOT_WRITABLE');
  }

  try {
    const text = await generateBlockCopy({
      pharmacyName: pharmacy.name,
      area: [profile?.city, profile?.state].filter(Boolean).join(', ') || null,
      description: profile?.description || null,
      services: Array.isArray(profile?.services) ? profile.services.map((s) => s?.name).filter(Boolean) : [],
      blockLabel: definition.editor?.label || definition.name,
      blockDescription: definition.description,
      field,
      max: spec.max,
    });
    res.json({ text });
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      throw new HttpError(503, 'AI writing is not available right now. Try writing it yourself instead.', 'LLM_UNAVAILABLE');
    }
    throw err;
  }
}));

router.get('/health-articles', requireAuth, asyncRoute(async (req, res) => {
  res.json({
    articles: publishableArticles().map((a) => ({
      slug: a.slug,
      title: a.title,
      summary: a.summary,
      reviewer: a.reviewer?.name || null,
      reviewerTitle: a.reviewer?.title || null,
      reviewedAt: a.reviewedAt || null,
      updatedAt: a.updatedAt || null,
    })),
  });
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

/**
 * PUT /api/website/template — switch this pharmacy's website to another
 * existing template.
 *
 * Same role as PUT /site: a reversible draft change a pharmacist may make,
 * not an owner-only permanent decision like the address or publishing. See
 * websiteService.switchTemplate for what is and is not touched — theme and
 * content survive, only site_data and template_id/version change, and none
 * of it is visible on the public site until the owner publishes.
 */
router.put('/template', requireAuth, requireRole('owner', 'pharmacist'), asyncRoute(async (req, res) => {
  const result = unwrap(await website.switchTemplate(req.pharmacyId, req.body?.template_id));
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

  // An optional candidate template lets an owner preview a different design
  // before switching to it — see PUT /template and TemplatePicker's "View
  // preview". This never writes to the database: it renders the CANDIDATE'S
  // seed in place of the stored draft, for this one response only. An
  // absent or unrecognised id falls back to the real draft, so a stale or
  // mistyped query string degrades to the normal preview rather than erroring.
  const candidate = typeof req.query?.template === 'string' ? getTemplate(req.query.template) : null;

  // An optional GENERATED page path previews About, Services, one service
  // page, Location, Contact or the health index instead of the home page —
  // the pages a pharmacy composes no blocks for and could not preview at all
  // before this, even though rewriting their heading/intro (pageCopy, see
  // websiteService.js) is exactly the kind of change someone wants to see
  // before it goes live. Not offered together with a candidate template: a
  // template swap only has a new HOME page composition to show, and the
  // client never sends both.
  const pagePath = !candidate && typeof req.query?.page === 'string' ? req.query.page : null;

  const contentForRender = (site.content && typeof site.content === 'object') ? site.content : {};
  let html;
  if (pagePath && pagePath !== '/') {
    const { rendered } = renderAllPages({
      ...ctx,
      site: site.site_data,
      theme: site.theme,
      health: Array.isArray(contentForRender.health) ? contentForRender.health : [],
      pageCopy: (contentForRender.pageCopy && typeof contentForRender.pageCopy === 'object') ? contentForRender.pageCopy : {},
      templateId: site.template_id || null,
      noindex: true,
    });
    const match = rendered.find((r) => r.path === pagePath);
    if (!match) throw new HttpError(404, 'No such page on this website', 'NOT_FOUND');
    html = match.html;
  } else {
    html = renderDocument({
      ...ctx,
      site: candidate ? cloneSeed(candidate.id) : site.site_data,
      // Always the pharmacy's OWN theme, never the candidate template's
      // suggested palette. switchTemplate leaves theme untouched, so this is
      // the only rendering that matches what committing would actually
      // produce — showing the candidate in a colour scheme it will not keep
      // would be a preview that lies about the result.
      theme: site.theme,
      // The asset map and the year come from renderContextFor above. They used
      // to be overridden here with an empty Map, which — spread AFTER ...ctx —
      // would now silently blank every uploaded logo in the preview while the
      // published page showed it correctly. Exactly the kind of difference a
      // preview must not have.
      noindex: true,
    });
  }

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
