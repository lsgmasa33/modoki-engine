# Asset Attribution

**This project contains no third-party assets.** Everything it renders is either an
engine primitive or original work created for this repository. The list below is
exhaustive — if a file is not named here, it is not a binary asset.

## Models

### `runtime/assets/models/terrain/terrain.glb` (241 KB)
### `runtime/assets/models/terrain/terrain_col.colmesh.glb` (56 KB)

Original work, generated for this project by Claude at the repository author's
direction. Not derived from, and not downloaded from, any third-party source.

These are committed artifacts — there is no generator script in the repo, so they
cannot be reproduced from source. `terrain.glb` is the visible mesh; the separate
`terrain_col.colmesh.glb` is its lower-density collision mesh, referenced by the
`Collider3D` trimesh shape in `terrain-demo.json`.

## Everything else

Every other visible object in both scenes is an **engine primitive**
(`Renderable3DPrimitive`: box / sphere / capsule / cylinder / cone) drawn in a flat
colour. There are no textures, no HDR environments, no audio, no fonts, and no
external meshes anywhere in this project.

## Licence

The two `.glb` files above are covered by this repository's licence, the same as the
project's source. No separate permission, credit, or attribution is required by any
upstream party — there is no upstream party.

Third-party licences for the **engine's own dependencies** (three.js, Rapier, PixiJS,
koota, React) are documented by the Modoki engine, not here.
