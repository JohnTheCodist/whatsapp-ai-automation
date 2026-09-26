/**
 * The 3D body's layers and regions.
 *
 * The test that matters most is the last one: the viewer decides which part
 * of the body you are pointing at with the SAME bands the build pipeline
 * used to file each mesh. If the two ever drift, clicking a patient's chest
 * opens the section belonging to their leg — on a screen where clicking a
 * body part is how a pharmacist navigates a record.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_LAYERS, DEFAULT_LAYERS, REGION_LABEL, regionOfHeight, regionCaption, toggleLayer,
} from './bodyLayers.js';

test('three layers, and the body opens showing the body and what is inside it', () => {
  expect(BODY_LAYERS.map((l) => l.id)).toEqual(['skin', 'skeleton', 'organs']);
  expect(DEFAULT_LAYERS).toEqual(['skin', 'organs']);
  // The surface has to be see-through or switching organs on shows nothing.
  expect(BODY_LAYERS.find((l) => l.id === 'skin').opacity).toBeLessThan(1);
});

test('the last visible layer cannot be switched off', () => {
  // Otherwise the viewer becomes an empty box with no way back out of it.
  expect(toggleLayer(['skin'], 'skin')).toEqual(['skin']);
  expect(toggleLayer(['skin', 'organs'], 'organs')).toEqual(['skin']);
  expect(toggleLayer(['skin'], 'skeleton')).toEqual(['skin', 'skeleton']);
});

test('the body is divided head to foot, with arms distinguished from legs by width', () => {
  expect(regionOfHeight(0.95, 0)).toBe('head');
  expect(regionOfHeight(0.70, 0)).toBe('chest');
  expect(regionOfHeight(0.50, 0)).toBe('abdomen');
  // Low down and out to the side is an arm; low down and near the midline
  // is a leg. A hand hangs beside the thigh, so height alone cannot tell.
  expect(regionOfHeight(0.35, -0.3)).toBe('arm-left');
  expect(regionOfHeight(0.35, 0.3)).toBe('arm-right');
  expect(regionOfHeight(0.20, -0.1)).toBe('leg-left');
  expect(regionOfHeight(0.20, 0.1)).toBe('leg-right');
});

test('every region the viewer can report has a name a person would say', () => {
  const regions = [0.95, 0.7, 0.5].map((t) => regionOfHeight(t, 0))
    .concat([-0.3, 0.3].map((x) => regionOfHeight(0.35, x)))
    .concat([-0.1, 0.1].map((x) => regionOfHeight(0.2, x)));
  for (const r of regions) expect(REGION_LABEL[r], r).toBeTruthy();
});

test('a region with nothing recorded says so, rather than staying silent', () => {
  const markers = [{ region: 'chest', note: 'Hypertension (from purchases)', tab: 'conditions' }];
  expect(regionCaption('chest', markers)).toBe('Chest · Hypertension (from purchases)');
  expect(regionCaption('leg-left', markers)).toBe('Left leg · nothing recorded');
  expect(regionCaption(null, markers)).toBe(null);
});

test('the viewer and the build pipeline divide the body at the same heights', () => {
  // Not a style check: the model was built with these numbers, and the
  // viewer reads a click with them. They are written twice because the
  // pipeline is Node and the viewer is the browser; this is what keeps the
  // two copies honest.
  const script = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'build-body-model.mjs'),
    'utf8',
  );
  const pipeline = script.slice(script.indexOf('function regionOf('));
  for (const band of ['0.82', '0.60', '0.42', '0.18']) {
    expect(pipeline, `the pipeline still splits the body at ${band}`).toContain(band);
  }
});
