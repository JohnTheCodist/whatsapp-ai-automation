/**
 * The editor adapter boundary.
 *
 * WHAT THIS IS FOR
 * GrapesJS needs blocks, component types and traits. This file derives all
 * three FROM THE REGISTRY and emits them as plain data. The client adapter in
 * a later phase turns that data into `editor.BlockManager.add(...)` and
 * `editor.DomComponents.addType(...)` calls — and that adapter is the only
 * code in the system that will know GrapesJS exists.
 *
 * WHAT THIS IS NOT
 * It is not a second definition of a block. Every field below is computed
 * from a registry entry; there are no editor-only blocks, no editor-only
 * props, and no editor-only defaults. If the editor could describe a block
 * differently from the renderer, an owner's preview would stop matching what
 * their customers get, and the divergence would be baked into stored data
 * before anyone noticed.
 *
 * NOTHING HERE IMPORTS GRAPESJS, and nothing under server/ ever may —
 * websiteService.test.js asserts it. This file emits a neutral description
 * that would serve any editor; GrapesJS is one possible consumer, which is
 * what keeps it replaceable.
 *
 * WHY IT LIVES ON THE SERVER
 * Decision 10 of WEBSITE_BUILDER_DECISIONS.md: the server is CommonJS, the
 * client is ESM, and there is no code-sharing path between them. Shipping the
 * manifest over the API is what stops the editor and the renderer keeping two
 * copies of the same contract.
 */

const { DEFINITIONS, blockKey } = require('./registry');

/**
 * Map a contract prop type onto an editor input kind.
 *
 * A NARROW MAP ON PURPOSE. There is no entry producing a rich-text or HTML
 * input, because no such prop type exists — see types.js. An editor built
 * from this manifest therefore cannot offer a field that accepts markup,
 * which is the same guarantee the renderer relies on, enforced one layer
 * earlier where the owner can actually see it.
 */
const INPUT_KIND = Object.freeze({
  text: 'text',
  url: 'url',
  phone: 'tel',
  email: 'email',
  enum: 'select',
  boolean: 'checkbox',
  integer: 'number',
  asset: 'asset-picker',
  list: 'repeater',
});

function traitsFor(definition) {
  return Object.entries(definition.props).map(([name, spec]) => ({
    name,
    kind: INPUT_KIND[spec.type] || 'text',
    required: Boolean(spec.required),
    // The editor shows an inherited field as "from your pharmacy profile"
    // with the live value, and only stores something when the owner
    // deliberately overrides it. That UI affordance is what makes
    // inheritance visible rather than mysterious.
    inherited: Boolean(spec.from),
    inheritedFrom: spec.from || null,
    // Set on blocks whose value belongs in Settings — opening hours. The
    // guided builder sends the owner there instead of offering an inline
    // edit that would create a divergent copy.
    editsProfileField: definition.editor?.editsProfileField || null,
    ...(spec.values ? { options: spec.values } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    // Each sub-field of a list item, with the two things an editor has to
    // know to render a row for it: whether a value is required (so a blank
    // one can be dropped rather than sent to be rejected) and how long it
    // may be. Names alone were not enough once anything wanted to edit a
    // list in a plain form rather than a generic repeater.
    ...(spec.of
      ? {
        itemFields: Object.entries(spec.of).map(([itemName, itemSpec]) => ({
          name: itemName,
          // The same INPUT_KIND every top-level prop is described with. A
          // list is only safe to edit as plain boxes when every field in it
          // IS one — the header's navigation carries an `href`, and a form
          // that took a URL as free text would let an owner quietly point
          // their own menu at nothing.
          kind: INPUT_KIND[itemSpec.type] || 'text',
          required: Boolean(itemSpec.required),
          ...(itemSpec.max !== undefined ? { max: itemSpec.max } : {}),
        })),
      }
      : {}),
  }));
}

/**
 * The full manifest.
 *
 * `content` is the seed a drag-and-drop inserts: type and version, and NO
 * props. An empty props object means every bound field inherits from the
 * pharmacy profile the moment the block lands, and every unbound one falls to
 * the definition's default at render. Seeding actual values here would copy
 * the pharmacy's data into the block and reintroduce exactly the divergence
 * the binding model exists to prevent.
 */
function editorManifest() {
  return {
    // Bumped when the SHAPE of this manifest changes, not when a block does.
    // A client adapter can refuse a manifest it does not understand instead
    // of half-rendering one.
    manifestVersion: 1,
    categories: [...new Set(DEFINITIONS.map((d) => d.category))],
    blocks: DEFINITIONS.map((d) => ({
      key: blockKey(d.id, d.version),
      id: d.id,
      version: d.version,
      label: d.editor?.label || d.name,
      category: d.category,
      icon: d.editor?.icon || 'block',
      description: d.description,
      singleton: Boolean(d.editor?.singleton),
      removable: d.editor?.removable !== false,
      draggable: d.editor?.draggable !== false,
      responsive: d.responsive || null,
      a11y: d.a11y || null,
      content: { type: d.id, version: d.version, props: {} },
      traits: traitsFor(d),
    })),
  };
}

module.exports = { editorManifest, INPUT_KIND };
