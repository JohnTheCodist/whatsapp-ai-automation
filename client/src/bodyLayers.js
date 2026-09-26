/**
 * The 3D body's layers and regions, as data.
 *
 * PURE — no three.js, no DOM. The viewer renders this; the tests pin it.
 * Kept out of BodyViewer3D.jsx so that the parts worth testing (which region
 * a point on the body belongs to, what a layer is called, what a marker
 * says) can be tested without a GPU.
 *
 * THE THRESHOLDS ARE THE PIPELINE'S. `regionOfHeight` repeats the bands in
 * scripts/build-body-model.mjs, which decided each mesh's region at build
 * time. They must agree: the model says "this mesh is the chest", the viewer
 * says "you are pointing at the chest", and if the two drift then clicking a
 * body part opens the wrong section of someone's record.
 */

export const BODY_LAYERS = Object.freeze([
  {
    id: 'skin',
    label: 'Body',
    // The surface is translucent so the layers under it stay visible. A
    // solid body with organs switched on is a solid body.
    opacity: 0.22,
    colour: '#d9b08c',
  },
  { id: 'skeleton', label: 'Skeleton', opacity: 1, colour: '#e8e4dc' },
  { id: 'organs', label: 'Organs', opacity: 1, colour: '#c2766d' },
]);

/** What is shown when a record opens: the body, and what is inside it. */
export const DEFAULT_LAYERS = Object.freeze(['skin', 'organs']);

export const REGION_LABEL = Object.freeze({
  head: 'Head and neck',
  chest: 'Chest',
  abdomen: 'Abdomen',
  'arm-left': 'Left arm',
  'arm-right': 'Right arm',
  'leg-left': 'Left leg',
  'leg-right': 'Right leg',
  body: 'Body',
});

/**
 * Which region a point on the body belongs to, from its height up the body
 * (0 at the feet, 1 at the top of the head) and its sideways offset in
 * metres from the midline.
 *
 * The same bands the model was built with — see the header.
 */
export function regionOfHeight(t, x) {
  if (t > 0.82) return 'head';
  if (t > 0.60) return 'chest';
  if (t > 0.42) return 'abdomen';
  if (Math.abs(x) > 0.18) return x < 0 ? 'arm-left' : 'arm-right';
  return x < 0 ? 'leg-left' : 'leg-right';
}

/** The caption under the body: what is recorded where you are pointing. */
export function regionCaption(region, markers) {
  if (!region) return null;
  const label = REGION_LABEL[region] || region;
  const mark = (markers || []).find((m) => m.region === region);
  return mark ? `${label} · ${mark.note}` : `${label} · nothing recorded`;
}

/** Turning a layer on or off, kept pure so the rule is testable. */
export function toggleLayer(active, id) {
  const on = active.includes(id);
  // Never leave the viewer showing nothing: turning off the last visible
  // layer would be an empty box the user has to guess their way out of.
  if (on && active.length === 1) return active;
  return on ? active.filter((l) => l !== id) : [...active, id];
}
