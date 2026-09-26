# The 3D body on the patient record

The figure shown beside a patient's summary is adapted from open anatomical
data. It is a **reference body**, not this patient: nothing about it is
measured from, or says anything about, the person whose record it appears on.
Markers on it show only where the pharmacy has something recorded, and each
one names its source.

It is an educational and navigational aid. **It is not a diagnostic tool.**

## Source

**Human Reference Atlas (HRA), HuBMAP** — 3D Reference Organ Sets, v1.10,
licensed **CC BY 4.0**.

- Male: `ref-organ/united-male/v1.10/assets/3d-vh-m-united.glb`
- Female: `ref-organ/united-female/v1.10/assets/3d-vh-f-united.glb`
- Reference library: https://humanatlas.io/3d-reference-library
- Licence: https://creativecommons.org/licenses/by/4.0/

Credited to Kristen Browne and Heidi Schlehlein, Human Reference Atlas /
HuBMAP, and built on the **Visible Human Project** of the U.S. National
Library of Medicine (Spitzer, Victor M., and David G. Whitlock, "The Visible
Human Dataset: The Anatomical Platform for Human Simulation", *The Anatomical
Record* 253, no. 2 (2002): 49–57).

## What was changed

Produced by `scripts/build-body-model.mjs` in this repository:

- Node transforms baked; the body stood with its feet at y = 0 and centred,
  with the up axis measured from the geometry rather than assumed.
- Only three layers kept — the body surface, the skeleton, and the organs
  this product can refer to. The eyes, teeth, lymph nodes, vasculature,
  nerves and both reproductive systems are **not included**.
- Coincident vertices welded and their normals averaged, because the source
  duplicates vertices at triangle boundaries.
- Structures merged per layer and body region, then simplified with
  meshoptimizer quadric simplification under an 8% relative error bound.
- Normals quantised to signed 16-bit; indices narrowed to 16-bit where a
  mesh fits.

The result is ~156,000 triangles and about 2.2MB per body, from sources of
230MB and 358MB. **This is a heavily simplified body**: it is meant to be
recognised and pointed at on a phone over a mobile connection, not studied.

## Method credit

The approach — anatomical systems as toggleable layers, quadric
simplification under a relative error bound, welding before simplifying —
follows **Human Atlas** by slorksmo (MIT licence,
https://github.com/slorksmo/Human-Atlas), which solved this problem first and
documents it well. No code from it is copied into this repository.

## The female body's limits

The HRA female reference models no arm or leg bones. Where the male body has
a skeleton in its limbs, the female body has none, and the viewer shows what
exists rather than borrowing the other body's bones to fill the gap — a
borrowed skeleton carries the build of the person it came from, and this is a
patient's record.
