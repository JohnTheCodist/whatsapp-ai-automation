/**
 * The block registry — the source of truth for what a pharmacy website can
 * contain, what its parts accept, and what HTML they become.
 *
 * ONE REGISTRY, THREE CONSUMERS. The guided builder, the GrapesJS adapter and
 * the server renderer all read from here. None of them may define block
 * behaviour of its own: if the editor and the renderer disagree about what a
 * block is, the page an owner previews is not the page their customers get,
 * and that divergence is unfixable once it exists in stored data.
 *
 * VERSIONS ARE PART OF THE KEY. A block is addressed as `pharmacy.hero@1`,
 * never as `pharmacy.hero`. Publishing `pharmacy.hero@2` alongside v1 leaves
 * every site built on v1 rendering exactly as it did, because v1's definition
 * is still registered and still the thing their stored data points at. This
 * is the mechanism the whole "existing saved website data must remain
 * renderable" requirement rests on — so a version is never edited in place
 * once sites exist on it. You add the next one.
 */

const { validateShape } = require('./types');
const { resolveProps } = require('./render');
const DEFINITIONS = require('./definitions');

const key = (id, version) => `${id}@${version}`;

/** id@version -> definition */
const BY_KEY = new Map();
/** id -> highest registered version */
const LATEST = new Map();

for (const def of DEFINITIONS) {
  const k = key(def.id, def.version);
  if (BY_KEY.has(k)) {
    // Thrown at require time on purpose. Two definitions claiming one
    // id@version means whichever loaded last silently wins, and the losing
    // block's sites render as the other one. That must not be discoverable
    // only in production.
    throw new Error(`Duplicate block registration: ${k}`);
  }
  BY_KEY.set(k, def);
  if (!LATEST.has(def.id) || def.version > LATEST.get(def.id)) {
    LATEST.set(def.id, def.version);
  }
}

function getBlock(id, version) {
  const v = version ?? LATEST.get(id);
  if (v === undefined) return null;
  return BY_KEY.get(key(id, v)) || null;
}

function latestVersion(id) {
  return LATEST.get(id);
}

/**
 * Everything the client needs to render a block picker — and nothing else.
 *
 * No `render`, because a function cannot cross the wire and the client must
 * never be the thing that decides what HTML a block produces. No `defaults`
 * either: those are applied server-side at render, and shipping them would
 * invite the editor to bake a copy of them into stored data, which is exactly
 * how a template's default text becomes 400 pharmacies' duplicated content.
 */
function listBlocks() {
  return DEFINITIONS.map((d) => ({
    id: d.id,
    version: d.version,
    key: key(d.id, d.version),
    name: d.name,
    description: d.description,
    category: d.category,
    responsive: d.responsive,
    editor: d.editor,
    // The prop SHAPE, without the validators — enough for an editor to build
    // a form, not enough to re-implement validation on the client.
    props: Object.fromEntries(Object.entries(d.props).map(([n, s]) => [n, {
      type: s.type,
      required: Boolean(s.required),
      inherited: Boolean(s.from),
      ...(s.values ? { values: s.values } : {}),
      ...(s.max !== undefined ? { max: s.max } : {}),
    }])),
  }));
}

/**
 * Validate one stored block.
 *
 * Accepts `{type, version?, props?}`. An absent version is filled in with the
 * current one and RETURNED, so what gets written to the database always
 * carries an explicit version. A stored block with no version would be a
 * block whose meaning changes the next time someone registers a v2 — which is
 * the precise failure versioning exists to prevent.
 *
 * @returns {{ok:true, value:object} | {ok:false, code:string, error:string}}
 */
function validateBlock(input, path = 'block') {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_SITE_DATA', error: `${path} must be an object` };
  }

  const { type, version, props } = input;

  if (typeof type !== 'string' || !LATEST.has(type)) {
    return {
      ok: false,
      code: 'UNKNOWN_BLOCK',
      error: `${path} has unknown type ${JSON.stringify(type)}`,
    };
  }

  const resolvedVersion = version ?? LATEST.get(type);
  if (!Number.isInteger(resolvedVersion)) {
    return { ok: false, code: 'INVALID_SITE_DATA', error: `${path}.version must be a whole number` };
  }

  const definition = BY_KEY.get(key(type, resolvedVersion));
  if (!definition) {
    return {
      ok: false,
      code: 'UNKNOWN_BLOCK_VERSION',
      error: `${path} names ${key(type, resolvedVersion)}, which is not registered`,
    };
  }

  const checked = validateShape(definition.props, props ?? {}, `${path}.props`);
  if (!checked.ok) {
    return { ok: false, code: 'INVALID_BLOCK_PROPS', error: checked.error };
  }

  // Rebuilt, never passed through: anything the caller attached beyond
  // {type, version, props} is dropped rather than stored forever.
  return { ok: true, value: { type, version: resolvedVersion, props: checked.value } };
}

/**
 * Render one validated block to HTML.
 *
 * Returns '' for a block that has nothing to say — no WhatsApp number, no
 * services, no reviews. An empty string is a section that does not appear,
 * which is the right outcome for a pharmacy that has not filled that part in.
 * A renderer that threw instead would take the whole public page down over
 * one blank field.
 */
function renderBlock(block, ctx = {}) {
  const definition = getBlock(block.type, block.version);
  if (!definition) return '';
  const props = resolveProps(definition, block.props, ctx);
  return definition.render(props, ctx) || '';
}

/**
 * Render a whole site's blocks in order.
 *
 * The join is deliberately unseparated: whitespace between sections is a
 * styling concern, and inserting newlines here would make the published HTML
 * differ from the preview for no reason a reader could see.
 */
function renderSite(siteData, ctx = {}) {
  const blocks = siteData?.blocks || [];
  return blocks.map((b) => renderBlock(b, ctx)).join('');
}

module.exports = {
  DEFINITIONS,
  getBlock,
  latestVersion,
  listBlocks,
  validateBlock,
  renderBlock,
  renderSite,
  blockKey: key,
  /** Every registered id, for callers that need to check membership. */
  blockIds: () => [...LATEST.keys()],
};
