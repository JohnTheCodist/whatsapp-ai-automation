/**
 * The editor adapter.
 *
 * TESTED AGAINST THE SERVER'S REAL MANIFEST, not a fixture. The adapter's
 * whole job is to translate between the client's editor and the server's
 * block contract, so a fixture would test that the adapter agrees with a copy
 * of the contract rather than with the contract — and drift between those two
 * is precisely the failure this file exists to catch.
 *
 * Importing across the CommonJS/ESM boundary is fine here and nowhere else:
 * this is a test running in Node, not shipped code. The application still
 * gets the manifest over the API, per decision 10.
 */

import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as adapter from './grapesAdapter.js';

const require = createRequire(import.meta.url);
const { editorManifest } = require('../../../server/services/website/blocks/editorManifest.js');

const MANIFEST = editorManifest();

/** Round-trip a site_data through the adapter the way the editor does. */
function roundTrip(siteData) {
  const defs = adapter.toComponentDefs(siteData, []);
  const models = defs.map((d) => ({
    rxType: d.rxType,
    rxVersion: d.rxVersion,
    rxProps: d.rxProps,
  }));
  return adapter.fromComponentModels(models);
}

// =====================================================================
// THE ROUND TRIP
// =====================================================================

/**
 * THE PROPERTY THE WHOLE EDITOR RESTS ON.
 *
 * If site_data → components → site_data is not the identity, then merely
 * OPENING the advanced editor damages a page that was fine. That failure
 * happens to someone who did nothing wrong, is invisible until they look at
 * their live site, and reads as the builder eating their work.
 */
test('site_data survives a round trip through the editor unchanged', () => {
  const siteData = {
    blocks: [
      { type: 'pharmacy.header', version: 1, props: {} },
      { type: 'pharmacy.hero', version: 1, props: { heading: 'Open six days', subheading: 'Since 2014' } },
      { type: 'pharmacy.whatsappCta', version: 1, props: { label: 'Message us', style: 'band' } },
      { type: 'pharmacy.footer', version: 1, props: {} },
    ],
  };
  expect(roundTrip(siteData)).toEqual(siteData);
});

test('every registered block survives a round trip', () => {
  // Built from the server's manifest, so a block added later is covered
  // without anyone remembering to extend this test.
  const siteData = {
    blocks: MANIFEST.blocks.map((entry) => ({
      type: entry.id,
      version: entry.version,
      props: {},
    })),
  };
  expect(roundTrip(siteData)).toEqual(siteData);
});

test('block order is preserved exactly', () => {
  // Reordering sections is the editor's main job. Getting the order wrong on
  // the way back out would rearrange a page nobody rearranged.
  const siteData = {
    blocks: ['pharmacy.footer', 'pharmacy.hero', 'pharmacy.header', 'pharmacy.about']
      .map((type) => ({ type, version: 1, props: {} })),
  };
  expect(roundTrip(siteData).blocks.map((b) => b.type)).toEqual(
    ['pharmacy.footer', 'pharmacy.hero', 'pharmacy.header', 'pharmacy.about'],
  );
});

/**
 * Clearing a field means "go back to inheriting", not "override with blank".
 *
 * This is the one place the editor could silently blank a pharmacy's phone
 * number on their live page: an owner clicks into a bound field, deletes what
 * the placeholder showed them, and clicks away. Storing '' would override the
 * profile with nothing; dropping it restores inheritance, which is what they
 * meant.
 */
test('a cleared field goes back to inheriting rather than overriding with blank', () => {
  const out = adapter.fromComponentModels([
    { rxType: 'pharmacy.contact', rxVersion: 1, rxProps: { phone: '', email: '   ', heading: 'Contact' } },
  ]);
  expect(out.blocks[0].props).toEqual({ heading: 'Contact' });
});

test('null and undefined props are dropped, not stored', () => {
  const out = adapter.fromComponentModels([
    { rxType: 'pharmacy.hero', rxVersion: 1, rxProps: { heading: null, subheading: undefined, image: 0 } },
  ]);
  // 0 is a real value and must survive; null and undefined are absence.
  expect(out.blocks[0].props).toEqual({ image: 0 });
});

test('a component with no block type is skipped rather than guessed at', () => {
  // Can only arise from something outside the block system — a paste, a
  // future plugin. It has no renderer, so inventing a type for it would store
  // something the server would reject on the very next save.
  const out = adapter.fromComponentModels([
    { rxType: 'pharmacy.hero', rxVersion: 1, rxProps: {} },
    { rxProps: { heading: 'orphan' } },
    null,
    { rxType: 42 },
  ]);
  expect(out.blocks).toHaveLength(1);
  expect(out.blocks[0].type).toBe('pharmacy.hero');
});

test('the version a block was authored against is carried through', () => {
  // Losing it would silently re-point an old site at whatever version is
  // current — exactly what versioning exists to prevent.
  const out = roundTrip({ blocks: [{ type: 'pharmacy.hero', version: 1, props: {} }] });
  expect(out.blocks[0].version).toBe(1);
});

// =====================================================================
// TRAIT NAMESPACING
// =====================================================================

test('trait names and prop names convert both ways', () => {
  for (const prop of ['heading', 'style', 'content', 'primaryCtaLabel']) {
    expect(adapter.propFromTrait(adapter.traitName(prop))).toBe(prop);
  }
  expect(adapter.propFromTrait('somethingElse')).toBeNull();
});

/**
 * The collision this namespacing exists to prevent.
 *
 * `pharmacy.whatsappCta` has a prop called `style`, and a GrapesJS component
 * model already uses `style` for inline CSS. Writing traits straight onto the
 * model would have the owner's button-style choice and the component's
 * styling object overwrite each other depending on load order — a corruption
 * that would look like a rendering bug, not a naming one.
 */
test('no trait name can collide with a GrapesJS model key', () => {
  const reserved = new Set([
    'type', 'tagName', 'content', 'components', 'attributes', 'classes', 'style',
    'traits', 'name', 'removable', 'draggable', 'droppable', 'editable', 'selectable',
    'copyable', 'highlightable', 'status', 'open', 'layerable', 'script',
  ]);
  for (const entry of MANIFEST.blocks) {
    for (const trait of entry.traits) {
      expect(reserved.has(adapter.traitName(trait.name))).toBe(false);
    }
  }
});

test('a bound field is offered as optional, with the profile named as its source', () => {
  const contact = MANIFEST.blocks.find((b) => b.id === 'pharmacy.contact');
  const traits = adapter.traitsFor(contact);
  const phone = traits.find((t) => t.name === adapter.traitName('phone'));
  expect(phone.placeholder).toMatch(/pharmacy details/i);
  expect(phone.label).toMatch(/optional/i);
});

test('every editable trait writes to a model property, never to a DOM attribute', () => {
  // Props are data the server renders from. A trait that wrote into markup
  // would make the canvas the source of truth, which is the one thing this
  // architecture does not allow.
  for (const entry of MANIFEST.blocks) {
    for (const trait of adapter.traitsFor(entry)) {
      expect(trait.changeProp).toBe(true);
    }
  }
});

test('fields the trait panel cannot edit are reported rather than half-supported', () => {
  const services = MANIFEST.blocks.find((b) => b.id === 'pharmacy.services');
  const unsupported = adapter.unsupportedTraits(services);
  expect(unsupported.map((u) => u.name)).toContain('services');
  // And they are absent from the trait list rather than rendered as a broken
  // single-line input.
  expect(adapter.traitsFor(services).map((t) => t.name))
    .not.toContain(adapter.traitName('services'));
});

// =====================================================================
// THE SECTION PICKER
// =====================================================================

test('the picker offers registered pharmacy blocks and nothing else', () => {
  // No text block, no image block, no columns, no raw HTML. An owner cannot
  // build something the renderer would refuse to publish.
  const defs = adapter.blockDefsFromManifest(MANIFEST);
  expect(defs).toHaveLength(MANIFEST.blocks.length);
  for (const def of defs) {
    expect(MANIFEST.blocks.some((b) => b.id === def.content.rxType)).toBe(true);
  }
});

test('a dropped block starts with no props, so it inherits immediately', () => {
  for (const def of adapter.blockDefsFromManifest(MANIFEST)) {
    expect(def.content.rxProps).toEqual({});
  }
});

test('component type names carry no dots', () => {
  expect(adapter.gjsTypeFor('pharmacy.hero')).toBe('rx-pharmacy-hero');
  for (const entry of MANIFEST.blocks) {
    expect(adapter.gjsTypeFor(entry.id)).not.toContain('.');
  }
});

// =====================================================================
// SAVE THROTTLING
// =====================================================================

test('an unchanged arrangement is recognised as unchanged', () => {
  // GrapesJS fires change events for selection and hover too. Without this
  // the editor writes to the database every time the mouse moves.
  const a = { blocks: [{ type: 'pharmacy.hero', version: 1, props: { heading: 'x' } }] };
  const b = { blocks: [{ type: 'pharmacy.hero', version: 1, props: { heading: 'x' } }] };
  expect(adapter.siteDataEqual(a, b)).toBe(true);
  expect(adapter.siteDataEqual(a, { blocks: [] })).toBe(false);
  expect(adapter.siteDataEqual(null, undefined)).toBe(true);
});
