# Volume Mode Roadmap

This document is the working north star for the next major geometry direction in this repo.

## Current Status

As of April 13, 2026:

- Phase 1 is in place: the engine and editor support an explicit `extrude | volume` mode switch.
- `extrude` remains the default logo/text path.
- `volume` now has a stabilized interim builder with:
  - capped bevel sizing so holes/gaps are not swallowed by oversized bevels
  - shared-mass bulge weighting in global XY space
  - local Z normalization so raised details still dome cleanly
  - a first region-aware filled-artwork pass that classifies large top-level regions as body and contained regions as shallow raised relief
  - a `volumeDetailStrength` control in the editor/export path
- The current `volume` implementation is still an extrude-based relief builder. It is better than the original per-path bulge approach, but it is not yet the final raster/SDF-based composed-volume pipeline described below.
- The next priority is replacing the current extrude-based relief composition with a field-based body/feature volume builder and validating it against a fixed benchmark SVG set.

## Core Product Direction

Keep the current extrusion pipeline as the default path for:

- logos
- letters
- emblems
- simple icons
- flat graphic marks

Do not degrade that path while building new geometry features.

Add a second geometry path beside it:

- `extrude`: current pipeline, unchanged in intent
- `volume`: new stylized volumetric pipeline for illustration-like SVGs

The goal is not "true 3D reconstruction from one SVG." The goal is "believable volumetric form from more angles."

## Main Motivation

Some SVGs look strong today because extrusion works well for bold, flat silhouettes.

Other SVGs break down from side and back views because the current mesh is still a thickened 2D cutout:

- straight side walls
- flat front/back duplication
- no internal depth hierarchy
- no volumetric shaping

The new work should solve that without weakening the current logo/text experience.

## Non-Negotiable Rules

1. `extrude` remains the safe default for logo/text workflows.
2. `volume` is a separate mode, not a silent mutation of existing output.
3. Do not market `volume` as "real 3D from one SVG."
4. Shared systems like materials, controls, export, capture, and editor UX should be reused where possible.
5. Geometry generation can diverge by mode; rendering and export plumbing should stay unified.

## What Volume Mode Means

`volume` should generate a stylized closed solid, not a literal reconstruction.

V1 target shape language:

- rounded front
- rounded back
- softer edge transition
- closed silhouette-preserving side walls
- better light response from 3/4 angles

This should feel closer to a toy, clay object, sticker badge, or sculpted icon than a raw extrusion.

## Scope Boundaries

### Good V1 candidates

- filled icons
- mascots
- sticker-like art
- simple illustrations
- bold silhouettes
- blobs and character marks

### Poor V1 candidates

- open stroke drawings
- thin line art
- highly detailed scenes
- perspective-dependent art
- objects that need a true side profile

These should either stay in `extrude` mode or wait for later guided workflows.

## Planned Technical Path

### Phase 0: Preserve and strengthen extrude mode

This is already the baseline path.

Keep improving shared quality features that help both modes:

- quality presets
- anti-flicker handling
- export mesh cleanup
- stable camera clipping
- lighting presets

Do not rewrite the existing extrusion builder just to prepare for `volume`.

### Phase 1: Add a geometry mode switch

Add a top-level engine prop:

- `mode?: "extrude" | "volume"`

Editor requirements:

- surface the mode clearly
- default to `extrude`
- only show volume-only controls when `mode="volume"`

Engine architecture:

- keep `buildExtrudedGeometryResult(...)`
- add a separate `buildVolumeGeometryResult(...)`
- route by mode at the scene/geometry boundary

### Phase 2: Volume V1 - inflated mask solid

Current state:

- implemented as an interim deterministic builder on top of `THREE.ExtrudeGeometry`
- supports:
  - `inflate`
  - `frontRoundness`
  - `backRoundness`
  - `edgeSoftness`
  - `detailStrength`
- uses:
  - post-merge bulge shaping
  - capped bevel sizing
  - simple region classification for filled shapes

This is a stepping stone, not the intended end state.

Planned replacement:

1. Rasterize the chosen body silhouette to a high-resolution binary mask.
2. Generate a signed distance field or equivalent edge-distance representation.
3. Convert distance-to-edge into a thickness profile for the base body.
4. Build front and back surfaces from that profile.
5. Layer local feature relief fields on top of the body field.
6. Stitch side walls into a closed mesh.
7. Weld, smooth, and simplify before rendering/export.

Target visual result:

- less slab-like side view
- believable rounded volume
- preserved front silhouette

### Phase 3: Volume controls

V1 controls should stay small and purposeful:

- `volumeThickness`
- `inflate`
- `frontRoundness`
- `backRoundness`
- `edgeSoftness`
- `detailStrength`
- `qualityProfile`

Material defaults for `volume` should favor readable form:

- clay
- plastic
- matte metal

Avoid reflective defaults that hide shape quality.

### Phase 4: Volume V2 - layered depth

After V1 works, add internal hierarchy:

- per-group or per-region depth bands
- foreground vs background shaping
- selective protrusion and recession
- optional shallow detail suppression for tiny decorative fragments

This is the phase that will help faces, mascots, petals, wheels, and multi-part illustrations read better.

Likely inputs:

- SVG groups
- color islands
- optional manual depth overrides
- region graph / containment tree built from filled artwork

### Phase 5: Guided advanced modes

Only after V1 and V2 are solid:

- symmetry assumptions
- radial/revolve mode for silhouette-friendly art
- optional user-guided side profile
- smarter auto-mode recommendation

Do not start here.

## Main Implementation Principles

### Prefer parallel pipelines over overloaded heuristics

If a rule only makes sense for `volume`, keep it inside `volume`.

Do not make `extrude` unpredictable by adding too many art-type guesses.

### Reuse downstream systems

Both modes should eventually share:

- material application
- controls/animation
- lighting
- capture
- export

Only mesh generation should differ materially.

### Optimize for 3/4 view quality, not perfect all-angle realism

Single-SVG input will never define a full real-world object.

Success means:

- front view still matches the source well
- 3/4 view looks intentional
- side view feels volumetric enough for stylized use

Not:

- exact real-world back geometry

## Success Criteria

Volume mode is successful when:

- mascot-style and filled illustration SVGs look better than `extrude` from angled views
- side walls no longer read as simple straight slabs
- exports remain practical in size
- render performance stays acceptable on the web editor
- existing logo/text users see no regression in default behavior

## Avoid These Mistakes

- do not replace `extrude` with `volume`
- do not auto-switch modes without a visible user choice
- do not promise "full 3D object generation" from one SVG
- do not start with AI inference before the deterministic volume path exists
- do not overbuild the UI before the geometry quality is proven

## Immediate Next Steps

1. Benchmark the current interim builder against a fixed set of mascot, icon, badge, and narrow-gap SVGs.
2. Refine the region classifier so body/feature assignment is more stable on multi-island filled artwork.
3. Replace the current extrude-based relief composition with a raster/SDF body + feature field pipeline.
4. Add optional manual region overrides only after the auto classification is good enough to be worth correcting.
5. Keep `extrude` visually unchanged while iterating on `volume`.

## Benchmark SVG Set

Always evaluate changes against at least one example from each bucket:

- logo
- lettermark
- badge/emblem
- filled icon
- mascot/character
- simple illustration

This prevents tuning the new mode against only one art style.
