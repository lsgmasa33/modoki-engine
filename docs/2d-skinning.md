# 2D Sprite Skinning

Rig a sprite with a 2D bone hierarchy + a weighted deformable mesh so it bends
organically (flesh/cloth/limbs) instead of moving as a rigid cut-out. This is the 2D
analogue of the 3D `SkinnedModel`/`syncBones` path — but with one key difference: in
3D the ECS `Bone` entities merely *bridge into* a GLB's imported skeleton, whereas in
2D **the `Bone2D` child entities ARE the skeleton**. There is no imported rig; the
mesh is CPU-skinned on the main thread from the live bone transforms.

The animation half is free: a 2D bone is just an ECS entity with a `Transform`, so the
existing keyframe stack (`.anim.json` → `Animator` → `sampleClip`) animates bones by
name-path with no new timeline machinery.

## Vocabulary

- **`SkinnedSprite2D`** (trait) — the renderable root. References a `.rig2d.json` asset
  by GUID (`rig`) + `color`/`opacity`/`flipX`/`flipY`/`isVisible`. It is its OWN
  renderable — it does NOT carry `Renderable2D`. Fully scalar (satisfies the
  `traitScalarFields` guard); all structured rig data lives in the asset.
- **`Bone2D`** (trait) — marks an entity as a bone; carries only `name` (must match a
  bone in the rig). The bone's real state is the entity's `Transform`. Authored as
  child entities under the `SkinnedSprite2D` root (via `EntityAttributes.parentId`),
  mirroring the rig's bone hierarchy. Distinct from the 3D `Bone` so `syncBones` never
  touches it.
- **`.rig2d.json`** (asset) — the deformable mesh (verts/uvs/tris in texture space) +
  bind-pose bone hierarchy + per-vertex bone weights. See the schema below.

## `.rig2d.json` schema

Authored in **texture space** (origin = sprite pivot, units = sprite pixels, +y down),
instance-independent. Whole-image sprites only today (atlas/sliced-sprite UV remap is a
follow-up).

```jsonc
{
  "id": "<guid>",                      // top-level GUID (like .mesh.json)
  "version": 1,
  "sprite": "<sprite-guid>",           // source texture/sprite, resolved via resolveSprite()
  "bones": [                           // bind-pose hierarchy, local TRS (radians)
    { "name": "root",  "parent": -1, "x": 0, "y": 96, "rot": 0 },
    { "name": "mid",   "parent": 0,  "x": 0, "y": -96, "rot": 0 }
  ],
  "mesh": {
    "verts": [[x,y], ...],             // texture-space bind positions
    "uvs":   [[u,v], ...],             // 0..1 into the sprite
    "tris":  [i0,i1,i2, ...]           // triangle index buffer
  },
  "skinIndices": [b0,b1,b2,b3, ...],   // 4 bone indices per vertex (<=4 influences)
  "skinWeights": [w0,w1,w2,w3, ...]    // 4 weights per vertex, normalized to 1 (unused slots 0)
}
```

Inverse-bind matrices are **derived once at rig load** (`deriveBindMatrices`) from the
bind-pose hierarchy — each bone's root-local 2×3 matrix at bind time, inverted — and
cached on the parsed rig. `rot` is radians, matching `Transform.rz`.

## Runtime pipeline

```
Bone2D Transforms ──► skin2DSystem ──► skin2DBuffers ──► Scene2D mesh pass ──► PixiJS Mesh
   (ECS, priority 201)    (LBS math)     (per-entity      (GameView)            (GPU)
                                          buffer registry)
                                              └─────────► SceneView (editor) ──► PixiJS Mesh
                                                          (same buffer)          + Canvas2D overlays
```

- **`skin2DSystem`** (`runtime/systems/skin2DSystem.ts`) — registered at
  `SYSTEM_PRIORITY.TRANSFORM + 1` (201), so it runs even when the sim is Stopped/Paused
  (hand-posing a bone deforms the mesh live in the editor), matching 3D `syncBones`.
  Per `SkinnedSprite2D`: resolve the rig, collect its descendant `Bone2D` entities,
  compose each bone's **root-local** matrix from the chain of LOCAL `Transform`s
  (self-contained — does not depend on world-transform propagation), compute
  `skinMatrix[b] = rootLocalNow[b] · invBind[b]` (identity at bind), and linear-blend-
  skin each vertex into the buffer. Deterministic (no wall-clock/RNG). A cheap per-bone
  skinning-matrix comparison gates the per-vertex work, so an idle rig re-skins nothing.
- **`skin2DBuffers`** (`runtime/systems/skin2DBuffers.ts`) — a module-level registry
  keyed by entity id: `{ parts, version, bindMinY, bindMaxY }`, where each part is a
  `Skin2DPartBuffer` `{ positions, uvs, indices, url, sprite?, uvRect?, order, name,
  visible }`. A single-part (v1) rig has exactly one part; a multi-part (v2) rig has
  several sharing the one skeleton, drawn back-to-front by `order`. The clean seam
  between the ECS deform system and the renderers — `version` bumps only when ANY
  part's deformed positions change, so idle rigs cost the renderer nothing;
  `bindMinY`/`bindMaxY` are the bind-pose vertical extent (measured once, stable across
  animation) the 2.5D billboard uses to anchor feet. Both the runtime GameView and the
  editor SceneView read this same buffer.
- **`rig2dMath`** (`runtime/skinning/rig2dMath.ts`) — pure 2×3 affine core
  (compose/mul/invert/apply), `deriveBindMatrices` (inverse-bind), `skinVertex2D`
  (LBS). No imports, unit-tested in isolation.
- **`rig2dCache`** (`runtime/loaders/rig2dCache.ts`) — the `.rig2d.json` loader,
  mirroring `spriteAnimCache` (cache/loading/failed/generation maps, lazy fetch,
  self-registering GUID). `normalizeRig2D` coerces + renormalizes weights and derives
  inverse-bind.

## Rendering

Two renderers read the same `skin2DBuffers` entry:

- **GameView** (`runtime/rendering/Scene2D.tsx`) — a `'mesh'` DisplayKind + a parallel
  `SkinnedSprite2D` pass building a PixiJS `Mesh` (`MeshGeometry`), re-uploading
  positions only on a deform-version bump (`getBuffer('aPosition').update()`), with its
  own snapshot + F1 idle gate, texture refcounting, and geometry disposal.
- **Editor SceneView** (`editor/panels/SceneView.tsx`) — the **textured** deformed mesh
  is drawn by the SAME PixiJS `Scene2DRenderer` (Mesh) as GameView, sitting UNDER the
  editor's Canvas2D chrome overlay. That Canvas2D pass draws only editor-authoring
  overlays via `render2DUtils`: `drawSkinnedMeshWireframe2D` (tessellation wireframe),
  `drawWeightHeatmap2D` (selected-bone influence, grayscale) / `drawDominantBoneMap2D`
  (whole-rig dominant-bone segmentation) for the weight view, and `drawSkinnedMeshFlat2D`
  (flat-tint fallback while the texture loads). Plus a `Bone2D`
  overlay (child→parent joint lines + screen-constant handle dots). Bones are
  click-selectable (dots hit-tested first; skinned bodies by mesh AABB) and gizmo-
  poseable (the 2D gizmo gate was generalized off the Renderable2D-only check to any
  Transform target, with extents from the mesh AABB / a bone point).

## 2.5D billboards (`Billboard3D`)

Add a `Billboard3D` trait ALONGSIDE `SkinnedSprite2D` and the rig is promoted out of the
flat PixiJS 2D canvas and INTO the Three.js scene as a camera-facing (billboarded) mesh —
a 2D-skinned character standing in a 3D world (Octopath / Don't Starve / Paper Mario).
Nothing about the rig changes: the SAME `skin2DBuffers` deform, the SAME `Bone2D`
skeleton, the SAME `.anim.json` clips drive it. `Scene2D` SKIPS any entity that has
`Billboard3D` (it renders in 3D instead); a THIRD renderer path picks it up.

- **The renderer** is a pass in `runtime/rendering/scene3DSync.ts` (a `BillboardEntry`
  per entity in `RenderState`), NOT a separate component:
  - `syncBillboardSprites(world, scene, state)` — camera-INDEPENDENT build/upload
    (geometry + material + placement), so it runs inside the shared render core, the
    editor `SceneView`, AND the offscreen capture alike.
  - `orientBillboards(state, camera)` — the per-frame facing, called by each host with
    ITS own camera: `'cylindrical'` (Y-locked yaw = `atan2(dx,dz)`, stays upright — the
    grounded-character look) or `'spherical'` (copies the camera quaternion — pickups/orbs).
  - Object graph per entity: outer `group` (scene child — `applyTransform` sets its
    position+scale from the entity Transform, `orientBillboards` overrides its rotation)
    → inner `flip` group (flipX/flipY mirror + the `1/pixelsPerUnit` scale + the anchor
    offset) → one `THREE.Mesh` per rig part.
- **Load the atlas PAGE, not the part sprite.** `skin2DBuffers` stores each part's UVs
  remapped into its atlas sub-rect (`part.uvRect`) and `part.url` = the shared texture
  PAGE. The billboard MUST load `part.url` and map UVs with `frameSkin2DUVs(part.uvs,
  part.uvRect)` — exactly like `Scene2D`. (Loading the individual `part.sprite`, which is
  trimmed differently, scrambles the mapping.)
- **No V-flip.** Pages are forced BOTTOM-origin (KTX2 is inherently; `flipY=false` on
  plain textures), so the page + the buffer's page-space UVs share one convention.
- **Layering by painter's order.** The ~coplanar parts draw back-to-front by rig order
  (`renderOrder = 10000 + part.order`) with `depthWrite:false` (no self z-fight) but
  `depthTest:true` (the 3D world still occludes the sprite → real 2.5D depth), alpha-
  tested (`alphaTest`) and composited after opaque geometry. No z-offset / polygonOffset.
- **Vertical anchor (`anchor`).** The rig's pixel origin `(0,0)` is NOT the feet, so a
  naive placement sinks a grounded character into the floor. `anchor:'bottom'` (default)
  offsets the `flip` group so the sprite's LOWEST bind-pose vertex sits at the entity
  origin — feet on the ground at `y=0`, and the billboard yaws about its feet.
  `anchor:'center'` pivots about the vertical mid-point (floating pickups). The extent is
  measured ONCE from the bind pose at build time (`minPy`/`maxPy` on the entry), so an
  animated foot-lift still leaves the ground instead of the anchor chasing the pose.
- **`pixelsPerUnit`** converts rig pixels → world units (lives on the `flip` scale, so a
  change never rebuilds geometry). Demo scene:
  `games/skin-test/runtime/assets/scenes/billboard-2_5d.json` — dark-assassin (cylindrical
  + spherical) and a zombie between two occluder boxes proving depth both ways. Tests:
  `packages/modoki/tests/runtime/billboard3DSync.test.ts`.

### Flat ground-plane sprites (`FlatSprite3D`)

`FlatSprite3D` (`runtime/traits/FlatSprite3D.ts`) is `Billboard3D`'s sibling — same
CPU-skinned deform (`skin2DSystem` → `skin2DBuffers`), same rig / `Bone2D` skeleton /
`.anim.json` clips, same shared 3D sprite pass in `scene3DSync.ts`. The ONE difference is
orientation: instead of rotating toward the camera every frame, a flat sprite lies in the
world XZ (ground) plane and KEEPS the entity's OWN Transform rotation — so `ry` becomes a
swim/heading yaw within the plane. This is the top-down look (fish on water, a shadow blob,
a decal/splat, a card on a table). Add it ALONGSIDE `SkinnedSprite2D` (not combined with
`Billboard3D`); `Scene2D` skips the entity and the same pass picks it up. Mechanically it
rides the same `BillboardEntry` as billboards with `mode: 'flat'` (alongside `'cylindrical'`
/ `'spherical'`, `scene3DSync.ts`) — `orientBillboards` leaves a flat entry's rotation
alone. Pure scalar trait (`alphaTest`, `pixelsPerUnit`); author the rig with a CENTRED
pivot so it rotates about its middle.

## Auto-rig generation (authoring core)

Pure, deterministic utilities that fill in the mesh + weights so authoring is "place
bones, click auto-weight" (or fully one-click). The editor supplies sprite dimensions +
an optional alpha coverage predicate; these return a ready `.rig2d.json` payload.

- **`generateGridMesh`** (`runtime/skinning/rig2dTessellate.ts`) — a triangulated grid
  over the sprite rect with 0..1 UVs + pivot-centered verts. An optional UV `isInside`
  predicate culls fully-transparent cells and compactly re-indexes, so the mesh hugs
  the opaque region. (Grid is the robust default; alpha-outline trace + earcut is a
  planned upgrade — grid+cull already gives an artifact-free mesh.)
- **`computeAutoWeights`** (`runtime/skinning/rig2dAutoWeights.ts`) — nearest-**JOINT**
  inverse-distance weights (top-4, normalized). Joint distance, not bone-segment: a
  segment is ambiguous for a colinear chain (a straight limb's upper bone segment spans
  the whole limb and would dominate the lower verts); joint distance splits a limb
  cleanly at the midpoint between joints.
- **`suggestBones`** (`runtime/skinning/rig2dAutoBones.ts`) — drops an evenly-spaced
  parent bone chain along the sprite's principal axis (taller → vertical, wider →
  horizontal), confined to the covered extent when an alpha predicate is given.
- **`buildRig2D`** / **`autoRig2D`** (`runtime/skinning/rig2dBuild.ts`) — compose the
  above. `buildRig2D({ sprite, bones, width, height })` tessellates + auto-weights a
  hand-placed chain; `autoRig2D({ sprite, width, height })` also auto-places the bones
  (one-click). Both take a single options object and return
  a `Rig2DFile` ready for `JSON.stringify` / `setRig2D`.

## Authoring today vs. planned

- **Today:** rigs are hand-authored JSON (or generated via the `autoRig2D` core). Open a
  scene with a `SkinnedSprite2D` + `Bone2D` children; select a bone in the Hierarchy or
  by clicking its joint in SceneView; pose it with the gizmo (works while stopped) and
  the mesh deforms live in both viewports.
- **Planned (Phase 2 UI):** a dockable Sprite editor `Skin` module — draw/auto-place
  bones, auto-tessellate from the sprite outline, paint weights (heatmap) — wired to the
  `autoRig2D` core above. Follow-ups: scene-scoped rig+texture refcounting, tree-shaker
  rig→texture dep-follow, atlas/sliced-sprite UV remap, alpha-outline tessellation.

## Fixture + tests

- **Fixture:** `games/skin-test/` — a generated 64×256 striped `bar.png`, a 3-bone
  `bar.rig2d.json` (base→mid→tip, a grid mesh generated by the Skin panel's
  Re-tessellate), and a scene wiring `Canvas2D → SkinnedSprite2D → base→mid→tip Bone2D`.
  Isolated guinea-pig project.
- **Tests:** `tests/runtime/skin2D.test.ts` (deform gate: bind-pose identity, hand-
  computed 90° arm-bend LBS, idle-no-version-bump, buffer-drop-on-removal, math units)
  and `tests/runtime/rig2dGen.test.ts` (grid counts/UVs/culling, weight normalization +
  nearest-joint dominance, auto-bones chains, and build→skin end-to-end). All headless,
  no renderer — the whole feature is verifiable deterministically.

## Gotchas

- **Trait fields must stay scalar** — the `traitScalarFields` guard fails the build on
  any new array/object trait field. All rig structure lives in the `.rig2d.json` asset
  and the bone hierarchy is child entities, never an array on a trait.
- **Editor render changes need a FRESH launch to verify** — the Electron editor runs
  Vite HMR, but editing `SceneView.tsx` while `Scene2D.tsx` has a Fast-Refresh-
  incompatible non-component export (`isShowColliders2D`) leaves the draw callback
  stale. Verify editor-render changes in a fresh editor build, not via HMR.
- **`resolveRef` rejects literal asset paths** — the `rig` field (and `sprite` inside
  the rig) must be GUIDs, guarded by `assetRefIntegrity`.
