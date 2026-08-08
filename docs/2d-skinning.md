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

- **`skin2DSystem`** (`runtime/skinning/skin2DSystem.ts`) — registered at
  `SYSTEM_PRIORITY.TRANSFORM + 1` (201), so it runs even when the sim is Stopped/Paused
  (hand-posing a bone deforms the mesh live in the editor), matching 3D `syncBones`.
  Per `SkinnedSprite2D`: resolve the rig, collect its descendant `Bone2D` entities,
  compose each bone's **root-local** matrix from the chain of LOCAL `Transform`s
  (self-contained — does not depend on world-transform propagation), compute
  `skinMatrix[b] = rootLocalNow[b] · invBind[b]` (identity at bind), and linear-blend-
  skin each vertex into the buffer. Deterministic (no wall-clock/RNG). A cheap per-bone
  skinning-matrix comparison gates the per-vertex work, so an idle rig re-skins nothing.
- **`skin2DBuffers`** (`runtime/skinning/skin2DBuffers.ts`) — a module-level registry
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
  (flat-tint fallback while the texture loads). Those weight overlays are **read-only and
  per-part**: `overlayPartIndices` (`editor/panels/skinWeightOverlay.ts`) pairs each
  visible part's deformed positions with **that part's own** weights, skipping hidden
  parts and any part whose buffer/rig vertex counts disagree (see the Gotcha below for
  why both the per-part pairing and the fail-closed check are load-bearing). Plus a `Bone2D`
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
  `games/skin-test/runtime/assets/scenes/billboard-2_5d.scene.json` — dark-assassin (cylindrical
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

- **Today:** a dockable Sprite editor `Skin` module (`editor/panels/SkinEditor.tsx` +
  `SkinCanvas.tsx`, registered as the `skin-editor` panel in `EditorApp.tsx`) — place/
  auto-place bones (Rig mode), Re-tessellate the mesh at a chosen grid density,
  Auto-weight, paint weights with a heatmap overlay, and a one-click Auto-rig that runs
  the whole `autoRig2D` pipeline on the active part. Rigs can also be hand-authored JSON.
  **Weight painting lives ONLY in the Skin panel** — SceneView shows the heatmap but has
  no brush (see the Gotcha below).
  Once a rig exists, open a scene with a `SkinnedSprite2D` + `Bone2D` children; select a
  bone in the Hierarchy or by clicking its joint in SceneView; pose it with the gizmo
  (works while stopped) and the mesh deforms live in both viewports.
- **Planned:** scene-scoped rig+texture refcounting, tree-shaker rig→texture dep-follow,
  atlas/sliced-sprite UV remap, alpha-outline tessellation (grid+cull already gives an
  artifact-free mesh in the meantime).

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
- **Anything that renumbers bones must renumber EVERY part's `skinIndices` — a v2 rig
  has one weight set per part, not one per rig** (#179). `removeBone` shifts every bone
  index down to close the gap, and it used to rewrite only the *top-level*
  `skinIndices`/`skinWeights`. Those are the **v1** fields, and `ensurePartsArray`
  strips them the moment a rig becomes multi-part — so on a v2 rig the remap loop read an
  absent `def.mesh`, saw zero vertices, did nothing, and left every part pointing at the
  old numbering. The result is silent: `normalizePart` **clamps** an index past the end of
  the skeleton to bone 0, so a stale part either deforms with whatever bone shifted into
  its slot, or snaps to the root — and `commit()` writes it to disk either way.
  A third rule, from reviewing that fix: **a structural edit's output must NORMALIZE TO
  ITSELF.** The editor deforms from the RAW def (`SkinCanvas.deformMesh` reads
  `activePartOf`, with no `normalizeRig2D` in between), so any repair that only the load
  path performs makes the live preview and the reloaded rig disagree about the same file.
  A vertex bound *entirely* to the deleted bone used to end up with all four weights at
  zero; `normalizePart`'s degenerate branch quietly rebound it to bone 0 on load, while
  `deformMesh` — which skips every zero-weight term — collapsed it to the local origin for
  the rest of the session. `removeBone` now applies the same fallback the loader would.
  Two more rules follow. Structural edits iterate `def.parts` and use **each part's own**
  `mesh.verts.length` (parts do not share a vertex count), and they leave the v1
  top-level fields alone on a v2 rig rather than overwriting them with an empty array —
  `normalizeRig2D` ignores those whenever `parts` is present, so writing them is
  inventing data, and it is what made the bug invisible. `addBone` (appends) and
  `reparentBone` (rewrites a parent field only) shift no indices and need none of this.
- **A weight that outruns the skeleton now warns at load, once per part** — the clamp
  above still happens (the rig has to render), but `normalizePart` counts the bad indices
  and reports them with the part name and bone count. Nothing legitimately authors a rig
  whose weights reference a missing bone, so treat the warning as data corruption and
  find the edit that renumbered them. Deliberately once per PART, and once per SESSION per
  `name|boneCount|badCount`: a corrupted rig has thousands of bad indices, so a per-vertex
  warning buries its own message — and `normalizeRig2D` is **not load-only** (the editor's
  `applySkinDef` re-normalizes on every edit, "safe to call per paint move"), so an
  un-deduped one fires tens of times a second while you drag the brush across the very rig
  it is complaining about. The count is in the key so a rig that gets WORSE reports again
  instead of being silenced by the first report. Same shape as `_warnedMissingClip` in
  `scene3DSync`.
  **The 3D skeletal path is immune to this class by construction, and it is worth knowing
  why rather than re-deriving it** (swept after #179): Modoki owns no indexed bone table
  there at all. Bones, bone attachments, skinned-mesh nodes and clip tracks all resolve by
  NAME and fail CLOSED — `entry.bones.get(name)` then `if (!bone) return`, skipping that
  one entity instead of clamping to bone 0. The GLB's own `JOINTS_0` indices live inside
  `THREE.Skeleton`/geometry that nothing here renumbers: the rigged converter only
  `joinPrimitives`-merges same-material submeshes, and the weld/simplify pipeline that
  could damage weights is reachable only by a static model — the split is decided at
  import by `inspectGLBRig().hasSkinned` (a skinned MESH, not the presence of clips), so a
  skinned-but-unanimated GLB still takes the rigged path. That is the defence the 2D side
  lacked: an index table is only safe if every consumer is updated together, and a name is
  safe on its own.
- **Weight painting is a SKIN-PANEL-only gesture, deliberately — SceneView shows weights
  and never edits them** (#180). SceneView used to carry a second weight brush: with the
  Skin panel open in Weights mode and a `Bone2D` selected, dragging in the scene painted
  that bone's influence on the posed character. It read the **v1 top-level** `def.mesh` /
  `skinIndices` in all three of its halves (the guard, the paint, and the undo entry), and
  `ensurePartsArray` strips those the moment a rig gains a second part — so it had been a
  complete no-op on every multi-part rig since parts landed, with no message and no log,
  and nobody noticed. It was **removed rather than made parts-aware**, for reasons that
  outlive the bug:
  - It contradicted the editor-surface convention in CLAUDE.md — *asset editors are
    panels; the viewport is for instance/spatial editing.* A weight stroke edits the
    `.rig2d.json` **asset**, so it belongs to the Skin panel.
  - It was a **hidden shared-asset edit**. In SceneView you appear to be editing the
    entity under the cursor; you were in fact mutating a file shared by every entity using
    that rig, in every scene, with nothing on screen saying so.
  - It duplicated no capability. `SkinCanvas.paintAt` already paints against a test pose,
    so "paint on the bent limb" was never unique to the viewport.
  - Fixing it would have required inventing a targeting rule the panel already owns
    (it paints every non-hidden part; SceneView has no parts list to scope a stroke with),
    plus a per-part buffer lookup its hardcoded `parts[0]` never had.
  What SURVIVES is the read-only heatmap, which is safe by the same reasoning — looking is
  not editing. It was fixed in the same change to shade **every visible part with its own
  weights** (`overlayPartIndices`): it too had read the `parts[0]` back-compat aliases, so
  it showed part 0's influence over the whole rig while the magenta wireframe beside it
  outlined every part. The pairing `buffer.parts[i] ↔ rig.parts[i]` is sound because
  `skin2DSystem` builds the buffer as `parsed.parts.map(...)` and rebuilds on any
  part-count/vertex-count change — but **it does not extend to the authoring def**, since
  `normalizeRig2D` SORTS parts by `order`; anything pairing against `Rig2DFile.parts` must
  map by NAME. The overlay still verifies the vertex counts agree and skips the part for a
  frame when they don't: a frame can land between a rig edit and the reskin, and drawing
  through it would index one part's weights into another part's positions — #179's exact
  failure mode, in a read path.
