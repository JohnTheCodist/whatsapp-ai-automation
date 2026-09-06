/**
 * Translation between `site_data` and the editor's component tree.
 *
 * THIS FILE DELIBERATELY DOES NOT IMPORT GRAPESJS. It is plain data in, plain
 * data out — which is what lets the round trip be tested without a DOM, a
 * canvas or a browser, and what keeps the editor swappable. `Editor.jsx` is
 * the only module allowed to know GrapesJS exists; this one only knows the
 * *shape* it expects.
 *
 * THE PROPERTY EVERYTHING RESTS ON: the round trip is LOSSLESS.
 *
 *   site_data → components → site_data   must be the identity
 *
 * If it is not, opening the advanced editor silently damages a page that was
 * fine — the worst failure this feature could have, because it happens to
 * someone who did nothing wrong and looks like the builder eating their work.
 * `grapesAdapter.test.js` asserts it against every registered block.
 *
 * HOW THAT IS ACHIEVED: props are carried on the component MODEL, never in
 * the DOM. The rendered HTML in the canvas is a picture — the model beside it
 * is the truth. Reading props back out of markup would mean parsing our own
 * output, which is lossy the moment a renderer changes anything.
 */

/**
 * The editor's component-type name for a block id.
 *
 * `pharmacy.hero` → `rx-pharmacy-hero`. Dots are stripped because a component
 * type name ends up in selectors and in serialized JSON, and a dot in either
 * is a needless thing to have to think about later. The `rx-` prefix keeps
 * our types distinguishable from anything GrapesJS registers itself.
 */
export function gjsTypeFor(rxType) {
  return `rx-${String(rxType).replace(/\./g, '-')}`;
}

/**
 * Contract prop kinds the trait panel can edit inline.
 *
 * `repeater` and `asset-picker` are deliberately absent. A list of services
 * and an uploaded logo both need a real editing surface — a table with add
 * and remove, a file picker with a preview — and a GrapesJS trait is a single
 * input. Rather than offer a broken version, those fields are marked as
 * belonging to the guided form, which already edits them properly. See
 * `unsupportedTraits`.
 */
const TRAIT_TYPE = {
  text: 'text',
  url: 'text',
  tel: 'text',
  email: 'text',
  number: 'number',
  checkbox: 'checkbox',
  select: 'select',
};

/**
 * Prop names are NAMESPACED on the component model.
 *
 * NOT decoration — a collision here corrupts a page. The WhatsApp block has a
 * prop called `style`, and GrapesJS models already use `style` for inline
 * CSS. Writing a trait straight onto the model would have the owner's choice
 * of button style overwrite the component's styling object, or the reverse,
 * depending on load order. `content`, `type`, `components`, `attributes`
 * and `classes` are the same hazard.
 *
 * A prefix removes the whole class of problem rather than maintaining a list
 * of names to avoid, which is a list that goes stale the first time a block
 * gains a prop.
 */
const PROP_PREFIX = 'rxp_';

export const traitName = (prop) => `${PROP_PREFIX}${prop}`;
export const propFromTrait = (name) =>
  (name.startsWith(PROP_PREFIX) ? name.slice(PROP_PREFIX.length) : null);

/** Props the trait panel cannot edit, with where the owner should go instead. */
export function unsupportedTraits(entry) {
  return (entry.traits || [])
    .filter((t) => !TRAIT_TYPE[t.kind])
    .map((t) => ({ name: t.name, kind: t.kind }));
}

/**
 * GrapesJS traits for one block, derived from the server's manifest.
 *
 * An INHERITED field gets a placeholder rather than a value, and its label
 * says where the value comes from. That is the whole inheritance model made
 * visible: leaving it empty means "use my pharmacy profile", and typing
 * something means "override it here, deliberately". An editor that pre-filled
 * the inherited value would turn every block an owner merely clicked on into
 * a hardcoded copy of their profile — the exact divergence the architecture
 * exists to prevent.
 */
export function traitsFor(entry) {
  return (entry.traits || [])
    .filter((t) => TRAIT_TYPE[t.kind])
    .map((t) => {
      const trait = {
        name: traitName(t.name),
        type: TRAIT_TYPE[t.kind],
        label: humanLabel(t.name),
        // Writes to a model property rather than a DOM attribute: props are
        // data the server renders from, not markup.
        changeProp: true,
      };
      if (t.kind === 'select') {
        trait.options = (t.options || []).map((value) => ({ id: value, name: humanLabel(value) }));
      }
      if (t.inherited) {
        trait.placeholder = 'From your pharmacy details';
        trait.label = `${trait.label} (optional)`;
      }
      return trait;
    });
}

/** `primaryCtaLabel` → `Primary cta label`. Good enough, and never shown a raw id. */
export function humanLabel(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Blocks for the editor's "add a section" panel.
 *
 * Only registered pharmacy blocks. There is no text block, no image block, no
 * column layout and no raw HTML block — the panel offers exactly what the
 * renderer knows how to publish, so an owner cannot build something that
 * would vanish on save. That constraint is the product decision from
 * WEBSITE_BUILDER_DECISIONS.md §5, enforced here by simply never registering
 * anything else.
 */
export function blockDefsFromManifest(manifest) {
  return (manifest.blocks || [])
    // A singleton already on the page should not be addable twice. The editor
    // filters by what is present; this marks which ones to filter.
    .map((entry) => ({
      id: entry.key,
      label: entry.label,
      category: entry.category === 'chrome' ? 'Page chrome' : 'Pharmacy sections',
      singleton: Boolean(entry.singleton),
      media: null,
      content: {
        type: gjsTypeFor(entry.id),
        rxType: entry.id,
        rxVersion: entry.version,
        // EMPTY, always. A dropped block inherits every bound field from the
        // pharmacy profile immediately; seeding values here would copy them.
        rxProps: {},
      },
    }));
}

/**
 * site_data → component definitions for the canvas.
 *
 * `fragments` is the server's rendering of the same blocks, in the same
 * order, from POST /render-blocks. Each component gets its own HTML as inner
 * content purely so the canvas looks like the page; the model carries the
 * truth.
 */
export function toComponentDefs(siteData, fragments = []) {
  const blocks = siteData?.blocks || [];
  return blocks.map((block, i) => ({
    type: gjsTypeFor(block.type),
    rxType: block.type,
    rxVersion: block.version,
    rxProps: { ...(block.props || {}) },
    // A block that rendered to nothing — no WhatsApp number, no services yet —
    // still needs to be visible and selectable, or an owner cannot fix the
    // reason it is empty.
    content: fragments[i]?.html || emptyPlaceholder(block.type),
  }));
}

function emptyPlaceholder(type) {
  return `<div class="rx-editor-empty">This section has nothing to show yet — `
    + `fill in the details it needs and it will appear. (${type})</div>`;
}

/**
 * Component models → site_data.
 *
 * `models` is a plain array of `{rxType, rxVersion, rxProps}` that Editor.jsx
 * extracts from GrapesJS, so this stays testable without GrapesJS.
 *
 * A component with no rxType is SKIPPED rather than guessed at. That can only
 * happen if something outside the block system got into the tree — a paste, a
 * future plugin — and the honest handling is to drop it: it has no renderer,
 * so it could never be published anyway, and silently inventing a type for it
 * would store something the server would then reject on save.
 */
export function fromComponentModels(models) {
  const blocks = [];
  for (const model of models || []) {
    if (!model || typeof model.rxType !== 'string') continue;
    blocks.push({
      type: model.rxType,
      version: model.rxVersion,
      // Rebuilt, and empty strings dropped: a trait that the owner cleared
      // must mean "go back to inheriting", not "override with nothing". This
      // is the one place the editor could quietly blank a pharmacy's phone
      // number on their live page.
      props: stripEmpty(model.rxProps || {}),
    });
  }
  return { blocks };
}

function stripEmpty(props) {
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Has the arrangement actually changed?
 *
 * GrapesJS fires change events for selection, hover and canvas scroll as well
 * as for edits. Saving on every one of them would put a write and a re-render
 * through the connection pool each time an owner moved their mouse.
 */
export function siteDataEqual(a, b) {
  return JSON.stringify(a?.blocks || []) === JSON.stringify(b?.blocks || []);
}
