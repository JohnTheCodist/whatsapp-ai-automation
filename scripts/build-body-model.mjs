/**
 * Build the patient record's 3D body from open anatomical data.
 *
 * RUN ONCE, BY HAND, AND COMMIT THE RESULT. This is not part of `npm run
 * build`: it reads a ~230MB source model, takes minutes, and its output is a
 * fixed asset (client/public/models/body-male.glb, body-female.glb) that
 * changes only when we want a different set of structures. Nobody building
 * the dashboard should pay for either of those.
 *
 *   node scripts/build-body-model.mjs <source.glb> <male|female>
 *
 * It needs `meshoptimizer` on disk, and is deliberately NOT a devDependency
 * of this repo — a 3D toolchain in every install, for a script that runs
 * once a year, is a cost paid by everyone for nobody:
 *
 *   mkdir -p /tmp/anatomy && cd /tmp/anatomy && npm i meshoptimizer
 *   NODE_PATH=/tmp/anatomy/node_modules node --max-old-space-size=4096 \
 *     scripts/build-body-model.mjs /tmp/anatomy/hra-male.glb male
 *
 * SOURCE AND LICENCE — Human Reference Atlas (HuBMAP), CC BY 4.0.
 *   male:   .../ref-organ/united-male/v1.10/assets/3d-vh-m-united.glb
 *   female: .../ref-organ/united-female/v1.10/assets/3d-vh-f-united.glb
 * Built on the Visible Human Project of the U.S. National Library of
 * Medicine. Attribution ships with the app in client/public/models/ and is
 * shown in the viewer: CC BY requires it, and a pharmacy showing a body to a
 * patient should be able to say where the body came from.
 *
 * The method — quadric simplification under a relative error bound, systems
 * as layers — follows Human Atlas (MIT, github.com/slorksmo/Human-Atlas),
 * which solved this problem first. What differs is the budget. That viewer
 * ships 2,234 structures at ~32MB a body because it is an anatomy explorer.
 * This ships three layers at ~2-4MB because it is one panel on one screen of
 * a CRM, opened over Nigerian mobile data. WHY THE BUDGET IS THE DESIGN: a
 * body that takes thirty seconds to arrive is a body nobody waits for, and
 * the screen it sits on has a pharmacist and a patient standing in front of
 * it.
 *
 * WHAT IS KEPT, AND WHAT IS NOT. Three layers — the body surface, the
 * skeleton, and the organs the summary can say something about. Everything
 * else in the source (eyes, teeth, lymph nodes, the vasculature, the
 * reproductive systems) is dropped. They are not hidden: they were never
 * downloaded, which is the only way to keep a promise about weight.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Source system groups to our three layers. Matched on the system node's
 * name, which in HRA is `VH_M_<system>` / `VH_F_<system>`.
 *
 * The reproductive systems are deliberately absent. They are in the source,
 * they are legitimate anatomy, and they have no business appearing on a
 * pharmacy screen that a patient can see over the counter.
 */
const LAYERS = [
  { layer: 'skin', systems: ['integumentary_system'], budget: 26000 },
  { layer: 'skeleton', systems: ['skeletal_system'], budget: 60000 },
  {
    layer: 'organs',
    systems: ['digestive_system', 'urinary_system', 'respiratory_system', 'circulatory_system', 'nervous_system'],
    budget: 70000,
  },
];

/**
 * Inside the organ systems, only these. The circulatory system alone is
 * 300+ vessel meshes; the nervous system is mostly eyes. Both would spend
 * the whole budget on things this product never refers to.
 */
const ORGAN_KEEP = /heart|cardiac|liver|hepatic|lung|bronch|trachea|kidney|renal|ureter|bladder|stomach|gastric|colon|intestin|duoden|jejun|ileum|caecum|cecum|rectum|pancrea|spleen|thyroid|gallbladder|oesophag|esophag|brain|cerebell|forebrain|hindbrain|diaphragm/i;
const ORGAN_DROP = /eye|iris|lens|cornea|retina|ciliary|vitreous|sclera|tooth|teeth|tongue|gingiva|palate|mucosa|lymph|tonsil|appendage|omentum|mesenter|peritone|ligament|vessel|artery|arterial|vein|venous|capillar|nerve|ganglio|prostat|uter|ovar|vagin|testis|penis|scrot/i;

/**
 * The error bound is generous — 8% of a group's extent — because this is a
 * body to point at, not to measure. A tighter bound (Human Atlas uses 0.2%)
 * refuses to reach the triangle target at all: the first run of this script
 * asked for 156,000 triangles, was held to 527,000 by a 1% bound, and
 * produced a 19MB file. Where even 8% will not reach the target, the sloppy
 * simplifier finishes the job; it ignores topology, which is visible on a
 * blood vessel and invisible on a kidney at 300 pixels tall.
 */
const MAX_ERROR = 0.08;
const MIN_TRIANGLES = 400;         // never simplify a whole region into a blob

const [source, sex] = process.argv.slice(2);
if (!source || !['male', 'female'].includes(sex)) {
  console.error('Usage: node scripts/build-body-model.mjs <source.glb> <male|female>');
  process.exit(1);
}

let MeshoptSimplifier;
try {
  ({ MeshoptSimplifier } = require('meshoptimizer'));
} catch {
  console.error('meshoptimizer is not installed. See the header of this file.');
  process.exit(1);
}
await MeshoptSimplifier.ready;

// ---- reading the source glTF ----------------------------------------------

function openGlb(path) {
  const file = fs.readFileSync(path);
  if (file.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path} is not a GLB file`);
  let cursor = 12;
  let json = null;
  let bin = null;
  while (cursor + 8 <= file.length) {
    const length = file.readUInt32LE(cursor);
    const type = file.readUInt32LE(cursor + 4);
    const body = file.subarray(cursor + 8, cursor + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    cursor += 8 + length;
  }
  if (!json || !bin) throw new Error('GLB is missing its JSON or BIN chunk');
  return { json, bin };
}

const STORE = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const COMPONENTS = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16,
};

function readAccessor({ json, bin }, index) {
  const a = json.accessors[index];
  const view = json.bufferViews[a.bufferView];
  const Store = STORE[a.componentType];
  const components = COMPONENTS[a.type];
  const offset = (view.byteOffset || 0) + (a.byteOffset || 0);
  // byteStride only matters for interleaved data; HRA exports are tightly
  // packed, and an interleaved source would silently read nonsense, so it is
  // refused rather than guessed at.
  if (view.byteStride && view.byteStride !== components * Store.BYTES_PER_ELEMENT) {
    throw new Error('interleaved accessor — this reader does not handle that');
  }
  return new Store(bin.buffer, bin.byteOffset + offset, a.count * components);
}

/** Node transform as a 4x4 matrix, from TRS or an explicit matrix. */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ---- writing our own glTF --------------------------------------------------

const bin = [];
let binLength = 0;
const bufferViews = [];
const accessors = [];
const meshes = [];
const nodes = [];

function pushView(typed, target) {
  const padding = (4 - (binLength % 4)) % 4;
  if (padding) { bin.push(Buffer.alloc(padding)); binLength += padding; }
  const offset = binLength;
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  bin.push(buf);
  binLength += buf.length;
  bufferViews.push({
    buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}),
  });
  return bufferViews.length - 1;
}

function addStructure(name, layer, region, mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], mesh.positions[i + a]);
      max[a] = Math.max(max[a], mesh.positions[i + a]);
    }
  }

  accessors.push({
    bufferView: pushView(mesh.positions, 34962), componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min, max,
  });
  const position = accessors.length - 1;
  accessors.push({
    bufferView: pushView(mesh.normals, 34962), componentType: 5122, normalized: true, count: mesh.normals.length / 3, type: 'VEC3',
  });
  const normal = accessors.length - 1;
  // 16-bit indices wherever the mesh fits in them — half the bytes, and at
  // these budgets nearly every structure does.
  const small = mesh.positions.length / 3 <= 65535;
  const indices = small ? Uint16Array.from(mesh.indices) : mesh.indices;
  accessors.push({
    bufferView: pushView(indices, 34963), componentType: small ? 5123 : 5125, count: indices.length, type: 'SCALAR',
  });
  const index = accessors.length - 1;

  meshes.push({ name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index }] });
  // Layer and region ride on the node as `extras`, so the viewer reads them
  // off the model rather than keeping a second list in the app that drifts
  // out of step with the geometry.
  nodes.push({ name, mesh: meshes.length - 1, extras: { layer, region } });
}

// ---- select ----------------------------------------------------------------

const src = openGlb(source);
const { json } = src;

const chosen = [];
const walk = (index, matrix, system) => {
  const node = json.nodes[index];
  const world = multiply(matrix, nodeMatrix(node));
  const name = (node.name || `node${index}`);
  const bare = name.replace(/^VH_[MF]_/, '').replace(/^(Allen|Yao)_/, '');
  const thisSystem = system || LAYERS.flatMap((l) => l.systems).find((s) => name.endsWith(s)) || null;

  if (node.mesh != null && thisSystem) {
    const layer = LAYERS.find((l) => l.systems.includes(thisSystem)).layer;
    const keep = layer !== 'organs' || (ORGAN_KEEP.test(bare) && !ORGAN_DROP.test(bare));
    if (keep) chosen.push({ index, name: bare, layer, world });
  }
  for (const child of node.children || []) walk(child, world, thisSystem);
};
for (const root of json.scenes[json.scene || 0].nodes) walk(root, IDENTITY, null);

process.stderr.write(`Selected ${chosen.length} structures from ${json.nodes.length} nodes.\n`);

// Per-layer budget, shared out by how big each structure is in the source:
// a rib and the whole skin cannot have the same allowance.
const sourceTriangles = new Map();
for (const c of chosen) {
  const mesh = json.meshes[json.nodes[c.index].mesh];
  sourceTriangles.set(c.index, mesh.primitives.reduce((n, p) => n + (p.indices != null ? json.accessors[p.indices].count / 3 : 0), 0));
}
const layerTotals = {};
for (const c of chosen) layerTotals[c.layer] = (layerTotals[c.layer] || 0) + sourceTriangles.get(c.index);

// ---- convert ---------------------------------------------------------------

/**
 * Where on the body a structure sits, from its own bounds in metres: the
 * figure stands with Y up. Used for the markers, so a region is decided by
 * the geometry rather than by a hand-written list of organ names that would
 * have to be rewritten for the second body.
 */
function regionOf(min, max, height) {
  const midY = (min[1] + max[1]) / 2;
  const midX = (min[0] + max[0]) / 2;
  const t = midY / height;                    // 0 at the feet, 1 at the head
  if (t > 0.82) return 'head';
  if (t > 0.60) return 'chest';
  if (t > 0.42) return 'abdomen';
  if (Math.abs(midX) > 0.18) return midX < 0 ? 'arm-left' : 'arm-right';
  return midX < 0 ? 'leg-left' : 'leg-right';
}

let bodyHeight = 2;
let triangles = 0;
const pending = [];

for (const c of chosen) {
  const node = json.nodes[c.index];
  const mesh = json.meshes[node.mesh];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const prim of mesh.primitives) {
    if (prim.indices == null || prim.attributes.POSITION == null) continue;
    const p = readAccessor(src, prim.attributes.POSITION);
    const n = prim.attributes.NORMAL != null ? readAccessor(src, prim.attributes.NORMAL) : null;
    const base = positions.length / 3;
    const m = c.world;
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
      positions.push(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      );
      if (n) {
        normals.push(
          m[0] * n[i] + m[4] * n[i + 1] + m[8] * n[i + 2],
          m[1] * n[i] + m[5] * n[i + 1] + m[9] * n[i + 2],
          m[2] * n[i] + m[6] * n[i + 1] + m[10] * n[i + 2],
        );
      } else {
        normals.push(0, 1, 0);
      }
    }
    const idx = readAccessor(src, prim.indices);
    for (let i = 0; i < idx.length; i += 1) indices.push(idx[i] + base);
  }
  if (!indices.length) continue;
  pending.push({
    ...c,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: Uint32Array.from(indices),
  });
}

/**
 * PUT THE BODY IN A KNOWN FRAME BEFORE ANYTHING READS IT.
 *
 * The source is not guaranteed to stand upright around the origin — the
 * first run of this script assumed it did, every structure's midpoint came
 * out below zero, and the whole skeleton was filed as "left leg". So the
 * frame is measured, not assumed: the longest axis of the whole body is up,
 * and the body is then stood with its feet at y = 0 and centred on x and z.
 * The viewer can frame it without knowing anything about the source.
 */
const whole = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const p of pending) {
  for (let i = 0; i < p.positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      whole.min[a] = Math.min(whole.min[a], p.positions[i + a]);
      whole.max[a] = Math.max(whole.max[a], p.positions[i + a]);
    }
  }
}
const extents = whole.max.map((v, i) => v - whole.min[i]);
const up = extents.indexOf(Math.max(...extents));
const across = [0, 1, 2].filter((a) => a !== up);
process.stderr.write(`Source bounds ${JSON.stringify(whole.min.map((v) => +v.toFixed(2)))}…${JSON.stringify(whole.max.map((v) => +v.toFixed(2)))}, up axis ${'xyz'[up]}\n`);

// The horizontal axis with the wider spread is left-to-right; the other is
// front-to-back. On a standing human that is arms versus belly, reliably.
const [wide, deep] = across[0] !== undefined && extents[across[0]] >= extents[across[1]] ? across : [across[1], across[0]];
const centre = [(whole.min[wide] + whole.max[wide]) / 2, (whole.min[deep] + whole.max[deep]) / 2];
bodyHeight = extents[up];

for (const p of pending) {
  const out = new Float32Array(p.positions.length);
  const outN = new Float32Array(p.normals.length);
  for (let i = 0; i < p.positions.length; i += 3) {
    out[i] = p.positions[i + wide] - centre[0];
    out[i + 1] = p.positions[i + up] - whole.min[up];
    out[i + 2] = p.positions[i + deep] - centre[1];
    outN[i] = p.normals[i + wide];
    outN[i + 1] = p.normals[i + up];
    outN[i + 2] = p.normals[i + deep];
  }
  p.positions = out;
  p.normals = outN;
}

/**
 * MERGE BEFORE SIMPLIFYING, by layer and region.
 *
 * The source has 320 structures once filtered — 134 of them individual
 * vertebrae and ribs. Kept apart they are 320 draw calls and 320 sets of
 * glTF bookkeeping for a panel the size of a postcard, and the viewer has no
 * use for "eleventh thoracic vertebra" as a thing to click: it picks
 * REGIONS. So each (layer, region) becomes one mesh, named for the pair.
 *
 * Merging first also simplifies better. A rib on its own has 5,000
 * triangles and a floor of its own; the rib cage as one mesh can spend its
 * budget where the silhouette actually needs it.
 */
const groups = new Map();
for (const p of pending) {
  // Bounds by a plain loop, not Math.min(...array): these arrays run to
  // hundreds of thousands of values and spreading one blows the stack.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], p.positions[i + a]);
      max[a] = Math.max(max[a], p.positions[i + a]);
    }
  }
  const region = p.layer === 'skin' ? 'body' : regionOf(min, max, bodyHeight);
  const key = `${p.layer}:${region}`;
  if (!groups.has(key)) groups.set(key, { layer: p.layer, region, positions: [], normals: [], indices: [], source: 0 });
  const g = groups.get(key);
  const base = g.positions.length / 3;
  for (let i = 0; i < p.positions.length; i += 1) g.positions.push(p.positions[i]);
  for (let i = 0; i < p.normals.length; i += 1) g.normals.push(p.normals[i]);
  for (let i = 0; i < p.indices.length; i += 1) g.indices.push(p.indices[i] + base);
  g.source += p.indices.length / 3;
}

const groupTotals = {};
for (const g of groups.values()) groupTotals[g.layer] = (groupTotals[g.layer] || 0) + g.source;

for (const g of groups.values()) {
  const p = {
    ...g,
    positions: new Float32Array(g.positions),
    normals: new Float32Array(g.normals),
    indices: Uint32Array.from(g.indices),
    name: `${g.layer}-${g.region}`,
  };
  const budget = LAYERS.find((l) => l.layer === p.layer).budget;
  const share = g.source / groupTotals[p.layer];
  const target = Math.max(MIN_TRIANGLES, Math.round(budget * share)) * 3;

  /**
   * THE ERROR BOUND WINS OVER THE TARGET, always — meshoptimizer stops the
   * moment collapsing another edge would move the surface further than it
   * was told it may. So the bound is RAISED until the budget is met, rather
   * than asked for once and hoped for: at 8% the chest skeleton came back
   * six times over budget, which is how the first runs of this script
   * produced a 19MB file. The bound each region actually needed is printed,
   * so the cost of a region is visible rather than implied.
   */
  /**
   * WELD FIRST, OR NOTHING SIMPLIFIES.
   *
   * The HRA exports duplicate vertices at triangle boundaries: every
   * triangle carries its own three, so no two triangles share an edge, and
   * an edge-collapse simplifier has nothing to collapse. It shows up as a
   * floor it will not go below at any error bound — the chest skeleton sat
   * at 173,000 triangles against a 27,000 budget even at 90% error. Welding
   * coincident positions (and averaging the normals that met there) turns
   * the soup back into a surface. Human Atlas does the same thing for the
   * same reason.
   */
  const weld = new Map();
  const wPos = [];
  const wNorm = [];
  const remapIn = new Uint32Array(p.positions.length / 3);
  for (let i = 0; i < p.positions.length / 3; i += 1) {
    const key = `${p.positions[i * 3]},${p.positions[i * 3 + 1]},${p.positions[i * 3 + 2]}`;
    let at = weld.get(key);
    if (at === undefined) {
      at = wPos.length / 3;
      weld.set(key, at);
      wPos.push(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]);
      wNorm.push(0, 0, 0);
    }
    remapIn[i] = at;
    for (let a = 0; a < 3; a += 1) wNorm[at * 3 + a] += p.normals[i * 3 + a];
  }
  p.positions = new Float32Array(wPos);
  p.normals = new Float32Array(wNorm);
  p.indices = Uint32Array.from(p.indices, (i) => remapIn[i]);

  const want = Math.min(p.indices.length, target);
  let error = MAX_ERROR;
  let [simplified] = MeshoptSimplifier.simplify(p.indices, p.positions, 3, want, error);
  while (simplified.length > want * 1.2 && error < 0.9) {
    error = Math.min(0.9, error * 2);
    [simplified] = MeshoptSimplifier.simplify(p.indices, p.positions, 3, want, error);
  }
  process.stderr.write(`  ${p.name.padEnd(20)} ${String(Math.round(g.source)).padStart(7)} -> ${String(simplified.length / 3).padStart(6)} triangles (error ${(error * 100).toFixed(0)}%)\n`);
  const [remap, count] = MeshoptSimplifier.compactMesh(simplified);
  const positions = new Float32Array(count * 3);
  const normals = new Int16Array(count * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let old = 0; old < remap.length; old += 1) {
    const n = remap[old];
    if (n === 0xffffffff) continue;
    for (let a = 0; a < 3; a += 1) {
      const v = p.positions[old * 3 + a];
      positions[n * 3 + a] = v;
      min[a] = Math.min(min[a], v);
      max[a] = Math.max(max[a], v);
    }
    const length = Math.hypot(p.normals[old * 3], p.normals[old * 3 + 1], p.normals[old * 3 + 2]) || 1;
    for (let a = 0; a < 3; a += 1) {
      normals[n * 3 + a] = Math.max(-32767, Math.min(32767, Math.round((p.normals[old * 3 + a] / length) * 32767)));
    }
  }
  if (!simplified.length) continue;
  triangles += simplified.length / 3;
  addStructure(p.name, p.layer, p.region, { positions, normals, indices: simplified });
}

// ---- write -----------------------------------------------------------------

const binary = Buffer.concat(bin);
const gltf = {
  asset: {
    version: '2.0',
    generator: 'rxnaija scripts/build-body-model.mjs',
    copyright: 'Human Reference Atlas (HuBMAP), CC BY 4.0, built on the Visible Human Project (U.S. National Library of Medicine). Simplified for the RxNaija patient record.',
  },
  extras: { sex, layers: LAYERS.map((l) => l.layer), height: bodyHeight },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  meshes,
  accessors,
  bufferViews,
  buffers: [{ byteLength: binary.length }],
};

const json2 = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = Buffer.alloc((4 - (json2.length % 4)) % 4, 0x20);
const binPad = Buffer.alloc((4 - (binary.length % 4)) % 4);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json2.length + jsonPad.length + 8 + binary.length + binPad.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json2.length + jsonPad.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binary.length + binPad.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

const outDir = new URL('../client/public/models/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
const out = new URL(`body-${sex}.glb`, outDir);
fs.writeFileSync(out, Buffer.concat([header, jsonHeader, json2, jsonPad, binHeader, binary, binPad]));

const byLayer = {};
for (const n of nodes) byLayer[n.extras.layer] = (byLayer[n.extras.layer] || 0) + 1;
console.log(JSON.stringify({
  file: `client/public/models/body-${sex}.glb`,
  structures: nodes.length,
  byLayer,
  triangles: Math.round(triangles),
  bytes: fs.statSync(out).size,
  megabytes: +(fs.statSync(out).size / 1048576).toFixed(2),
  bodyHeight: +bodyHeight.toFixed(3),
}, null, 2));
