# Engine Architecture

**modoki** is an ECS game engine plus a visual editor for building 2D/3D games that
ship to web and native (iOS/Android via Capacitor). This page covers the core engine
architecture. For deeper dives, see the sibling docs:
[Rendering](./rendering.md) · [Scene Loading](./scene-loading.md) ·
[UI System](./ui-system.md) · [Prefabs](./prefabs.md) · [Visual Editor](./editor.md).

## Overview

The engine is composed of a small set of layers:

- **ECS** — [koota](https://github.com/pmndrs/koota) provides the entity/trait/world model.
- **3D** — Three.js (`>=0.180`, app pins `^0.184`) renders the `'3d'` layer.
- **2D** — PixiJS v8 (`^8.17`) + `@pixi/react` (`^8`) render the `'2d'` layer.
- **UI/DOM** — React 19 renders the `'ui'` layer as plain DOM with CSS flexbox.
- **State bridge** — Zustand (`^5`) carries state between ECS systems and React views.
- **Native shell** — Capacitor 8 wraps the web build for iOS/Android.

The package is split into two halves under `packages/modoki/src/`:

- **`runtime/`** — ships in production. ECS core, traits, loaders, rendering, UI.
- **`editor/`** — dev-only (Hierarchy, Inspector, SceneView, Console, Assets). Never
  bundled into the shipped game.

The engine is consumed through two entry points: `@modoki/engine/runtime` and
`@modoki/engine/three` (Three.js integration: `Light`, `Environment`,
`transformPropagationSystem`).

## ECS Core (koota)

The ECS core lives under `packages/modoki/src/runtime/core/ecs/`:

- **`worldRegistry.ts`** — owns the active koota `World`. There is **no singleton
  `world` export**. Consumers call `getCurrentWorld()` *inside* callbacks/functions
  (never captured at module load), so world swaps take effect immediately. Scene
  loading builds a transient "next" world in isolation, then calls
  `setCurrentWorld(next)` to atomically promote it; `onWorldSwap(fn)` subscribers are
  notified. Each world has its own number→Entity index stored in a `WeakMap`
  (`getEntityIndex(world)`), so disposing a world GCs its index.
- **`world.ts`** — re-exports the registry functions and adds entity-index helpers:
  `spawnEntity()`, `destroyEntity()`, `findEntityById()`, `findEntityByGuid()`,
  `registerEntity()`, `unregisterEntity()`, `indexEntityGuid()`, `rebuildGuidIndexSync()`.
  In dev it exposes `window.__ecsWorld` as a live getter.
- **`entityUtils.ts`** — editor/runtime entity helpers: `getAllEntities()`,
  `buildEntityTree()`, `findEntity()`, `readTraitData()`, `writeTraitField()`,
  `deleteEntity()`, plus dirty-tracking (`fireDirtyListeners()`, `markStructureDirty()`).
- **`traitRegistry.ts`** — name→trait lookup (`getTraitByName()`), used so code and
  tests can resolve traits by string without importing them directly.

### Entity indexes (number → Entity, guid → Entity)

Each world carries **two** per-world indexes, both `WeakMap<World, Map<…>>` in
`worldRegistry.ts` so disposing a world GCs its indexes:

- **`getEntityIndex(world)`** — `number → Entity`, keyed by koota's numeric id.
  `registerEntity()`/`unregisterEntity()` maintain it; `findEntityById()` reads it O(1).
  `findEntity()` (entityUtils) adds an O(n) fallback scan of `world.entities` for entities
  that never went through `registerEntity()` — it `console.warn`s in dev (capped at 3 per
  process, with a stack, so one unregistered entity can't flood a CI log) so the missing
  registration gets fixed.

  **Always create and remove entities with `spawnEntity(world, ...traits)` and
  `destroyEntity(entity, world)`** — never a bare `world.spawn()` / `entity.destroy()`.
  koota owns `spawn()`, so index maintenance could never be automatic; it was a second call
  you had to remember, and the destroy half was forgotten in three game systems. An ESLint
  rule now bans the bare calls in production source (see below for its deliberate scope).

  The two halves fail differently, which is why the destroy half matters more:

  | Forgotten | Symptom | Loud? |
  |---|---|---|
  | `registerEntity` after spawn | lookups degrade to the O(n) fallback | yes — dev warning |
  | `unregisterEntity` before destroy | index keeps a live entry pointing at a **destroyed** entity, so `findEntityById()` returns a corpse and the caller reads traits off it | **no** — an index hit looks like success |

  The lint rule is scoped, not blanket. Bare `.spawn(` is banned across production source
  (`engine/app`, `engine/packages/*/src`, `games/**`, `demos/**`) but **not** in test files,
  where `.spawn(` is overwhelmingly the `createTestWorld` handle — which registers already —
  and no selector can distinguish `tw.spawn()` from `world.spawn()` by shape. Bare
  `.destroy()` is narrower still: only `games/*/runtime`, `demos/*/runtime`, and the ECS
  core, because elsewhere it is legitimately a PixiJS/three object (`Scene2D` alone has 16).
  Coverage lives in `tests/runtime/world.test.ts` (the pairing) and
  `tests/runtime/entityIndexIntegrity.test.ts` (the same thing driven through
  `deleteEntities`, against the real index rather than a mock).
- **`getGuidIndex(world)`** — `guid → Entity`, symmetric to the asset manifest's
  `guidToEntry` map. This makes an entity's stable `guid` a **first-class O(1)
  identity** (not an O(n) world scan), which matters because numeric ids are reassigned
  on every scene hot-reload while guids survive. `indexEntityGuid()` re-indexes after a
  `'' → guid` mint. **`findEntityByGuid()` self-heals**: on a miss (or a stale hit) it
  runs `rebuildGuidIndexSync()` once — a full `EntityAttributes` walk that repopulates
  the whole map (first guid wins) — then retries, so lookups stay correct even if a mint
  site forgot to call `indexEntityGuid` (the explicit wiring is only for speed). Numeric
  ids reassigned per reload are why scene-mutate / editor-action ops address entities by
  `{guid}`/`{name}`, never `{id}`.

### Dirty tracking (Inspector / Hierarchy refresh)

`entityUtils.ts` owns two pluggable listener sets that drive editor re-renders off ECS
writes:

- **Value-dirty** — `addDirtyListener(fn)` registers a callback fired by
  `fireDirtyListeners()` on any trait-value write. `writeTraitField()` / `setTrait()`
  call it internally; call it yourself after a *bulk* `entity.set` that bypasses them
  (e.g. a gizmo drag) so the Inspector and `uiTreeStore.markUIDirty` subscribers
  refresh. (This function was renamed from a former `markUIDirty` to end the collision
  with the UI-flag setter of the same name in `uiTreeStore`.)
- **Structure-dirty** — `markStructureDirty()` bumps a monotonic `getStructureVersion()`
  and notifies `onStructureDirty(fn)` subscribers (Hierarchy, Console) on
  create/delete/reparent. It's wired to `registerEntity` via `setStructureCallback`, and
  `writeTraitField`/`setTrait` also fire it for the `EntityAttributes` fields that reshape
  the tree (`name`, `layer`, `parentId`, `sortOrder`, `editorFolder`).
  **`onStructureDirtyCoalesced(fn)`** collapses a burst to at most once per animation
  frame — essential for React subscribers, since firing per-entity during a synchronous
  scene load (one `markStructureDirty` per instantiated entity) blows React's
  update-depth limit; the rAF defer collapses it to a single post-load render.

Every entity carries the **`EntityAttributes`** trait
(`runtime/core/traits/EntityAttributes.ts`) for metadata: `name`, `isActive`, `sortOrder`,
`parentId` (0 = root), `layer`, and `guid`. `parentId` builds the scene hierarchy;
`guid` is the entity's stable UUID that survives scene swaps and cross-prefab
references.

### `isActive` — who honours it, and what "off" means to them

`isActive: false` switches an entity **and every descendant** off. There are two readings of
the CASCADE and two readings of what a subsystem should DO, so both are pinned here rather
than rediscovered per subsystem:

- **The cascade** is computed two ways, deliberately. RENDERERS read `deactivatedEntities`, the
  set built by `transformPropagationSystem` (`runtime/core/ecs/`, priority 200). SIM systems use
  `isEntityActiveInHierarchy` (`runtime/core/ecs/entityIndex.ts`), which walks `parentId` over the
  per-frame entity index — because the renderer set is built by a module whose matrix math is THREE
  (importing it drags three into a 2D-only bundle), is one frame stale for anything running before priority 200, and is always
  empty headless (the harness registers no propagation system), which would make any guard built
  on it silently inert *and* untestable.
- **What "off" means is per-subsystem, and that is not an inconsistency.** A [Director](./timeline.md)
  FREEZES — the playhead holds and resumes where it stopped, because a playhead has no ledger to
  keep balanced. A [Zone trigger](./zones.md) fires `exit` and behaves as if DESPAWNED, because it
  does have one: anything that received an `enter` must receive its `exit`, or a listener counting
  occupants is left holding a phantom.

| Subsystem | Honours `isActive`? | "Off" means |
|---|---|---|
| Rendering (3D/2D/UI, lights, particles) | yes | not drawn |
| `Director` / timeline | yes | frozen; resumes where it stopped |
| Zone triggers (2D + 3D) | yes | `exit` fires; re-activating fires a fresh `enter` |
| Physics (Rapier 2D/3D) | **no** | body keeps simulating and colliding |

Physics is the remaining gap. It needs a decision first — whether a deactivated body leaves the
Rapier world entirely or stays as an inert ghost — so it was left out rather than guessed at.

## Traits

Components are koota traits, defined under `packages/modoki/src/runtime/traits/`
(Three.js traits live in `packages/modoki/src/three/traits/`). Each is created with
koota's `trait({...})`. The main ones:

| Trait | File | Purpose |
|-------|------|---------|
| `Transform` | `traits/Transform.ts` | Position (`x/y/z`), rotation (`rx/ry/rz`, radians), scale (`sx/sy/sz`). |
| `Renderable3D` | `traits/Renderable3D.ts` | `mesh` (`.mesh.json`) + `material` (`.mat.json`) refs for Three.js. |
| `Renderable3DPrimitive` | `traits/Renderable3DPrimitive.ts` | Built-in shapes (cube, sphere, plane, …). |
| `Renderable2D` | `traits/Renderable2D.ts` | Sprite/primitive for the PixiJS layer. |
| `RenderableUI` | `traits/RenderableUI.ts` | Tag marking an entity as a UI node. |
| `Camera` | `traits/Camera.ts` | FOV, clip planes, clear color, overlay distance. |
| `Light` | `three/traits/Light.ts` | `lightType` (ambient/directional/point/spot), color, intensity, shadows. |
| `Tint` | `traits/Tint.ts` | Per-entity color wash blended over the NPR fill (team colors, highlights). |
| `Persistent` | `traits/Persistent.ts` | Tag: survive scene swaps. Apply via `markPersistent()` (root-only, assigns guid). |
| `PrefabInstance` | `traits/PrefabInstance.ts` | Links an entity back to its source prefab + local id. |
| `NPRPostFX` | `traits/NPRPostFX.ts` | Resource: non-photoreal edge-detection / fill post-processing for the 3D layer. |
| `BloomPostFX` | `traits/BloomPostFX.ts` | Resource: WebGPU/TSL whole-scene HDR bloom post-process for the 3D layer. |
| `UIElement` | `traits/UIElement.ts` | Consolidated UI layout + style + text + image (~50 fields). |
| `UIBinding` | `traits/UIBinding.ts` | Store bindings (text templates, visibility, two-way input). |
| `UIAction` | `traits/UIAction.ts` | Button/input events (`onClick`, `onChange`, `onSubmit`). |
| `UIAnchor` | `traits/UIAnchor.ts` | Screen positioning (stretch / edges / corners / center) + safe area. |

Other runtime traits include `ModelSource`, `Time`, `Paused`, `Canvas2D`, and
`Rotate3D`. All traits are re-exported from `runtime/traits/index.ts`.

### The `layer` system

`EntityAttributes.layer` (`'' | '3d' | '2d' | 'ui'`) decides **which renderer owns an
entity**. It is derived from which `Renderable*` trait is present (e.g.
`Renderable3D` → `'3d'`, `Renderable2D` → `'2d'`, `RenderableUI` → `'ui'`). Each
rendering layer queries only the entities tagged for it, so the three renderers stay
fully decoupled.

**Stored and exposed are two different types, and the read path reconciles them.** The
stored field is `'' | '3d' | '2d' | 'ui'`; what consumers see (`EntityInfo['layer']`) is
`'3d' | '2d' | 'ui' | undefined`. `getAllEntities` closes the gap on every read
(`deriveLayer`, `runtime/core/ecs/entityUtils.ts`):

- **A present primary renderable trait WINS** over the stored value, so the two cannot
  drift — a `Renderable2D` entity left at `layer:'3d'` still reads as `'2d'`. The
  authoritative map is `PRIMARY_RENDERABLE_LAYER`.
- **Otherwise the stored value stands.** Lights, HDR environments, `ModelSource`, and
  group nodes have no unambiguous primary renderer and legitimately store `''` or `'3d'`.
- **The caller narrows before deriving, and that is deliberate.** `getAllEntities`
  accepts only the three real layers and maps everything else to `undefined` — both the
  legitimate `''` and any junk string, since the trait is read as `unknown`-typed data
  out of hot-reloadable scene JSON where a hand-edited `"layer": "3D"` is reachable.
  `deriveLayer` therefore takes the already-narrowed type; **don't widen it to accept
  `''`** — folding the narrowing inward would drop the junk rejection that keeps a typo
  out of the Hierarchy filters and `get_scene_state` (#36).

## Three Rendering Layers

Each layer is driven by an entity's `layer` value:

- **`'3d'`** — Three.js, via `runtime/rendering/Scene3D.tsx`. Meshes, cameras, lights,
  environment, optional NPR post-processing.
- **`'2d'`** — PixiJS v8, via `runtime/rendering/Scene2D.tsx` (and `Game.tsx`).
  Sprites, primitives, particles.
- **`'ui'`** — React DOM, via `runtime/ui/UIRenderer.tsx`. UI entities become a
  parent/child DOM tree laid out with CSS flexbox.

See [Rendering](./rendering.md) and [UI System](./ui-system.md) for the full pipeline.

## Frame Driver

`packages/modoki/src/runtime/rendering/frameDriver.ts` is a **single
`requestAnimationFrame` loop** with priority-ordered callbacks, replacing multiple
independent rAF loops to guarantee deterministic order:

```
PRIORITY_ECS (0) → PRIORITY_RENDER_3D (10) → PRIORITY_RENDER_2D (20)
                 → PRIORITY_EDITOR_3D (30) → PRIORITY_EDITOR_2D (40)
```

Callbacks register/unregister by key (`registerFrameCallback`,
`unregisterFrameCallback`); the driver is ref-counted (`startFrameDriver` /
`stopFrameDriver`) so multiple subsystems can start it without conflict. It caps to
`targetFPS` (default 60, 0 = uncapped), tracks `getCurrentFPS()`, and auto-unregisters
any callback that throws 10 times in a row. `stepOneFrame()` runs all callbacks once
for the editor's step button.

The ECS pipeline itself runs at `PRIORITY_ECS`. Its systems are ordered by
`SYSTEM_PRIORITY` tiers (`runtime/core/pipeline.ts`):
`TIME (0) → INPUT (50) → GAME (100) → ANIMATION (150) → TRANSFORM_PREPASS (170) →
PHYSICS (175) → LATE_UPDATE (185) → TRANSFORM (200) → AUDIO/MATERIAL (250/260) →
PROJECTION (300)`. Systems below `TRANSFORM` are gated with the sim (skipped when
paused); `TRANSFORM` and up keep running (presentation).

**`LATE_UPDATE` (185) is the Unity-style post-physics correction tier.** It runs after
animation *and* the physics writeback, before the final `TRANSFORM` propagation — so a
system there reads the **actual post-step** transform and its edits still compose into
this frame's render. Contract: read fresh state via the `Transform` trait (local; for a
root entity local == world) or `getWorldTransform3D(id)` (composes a parented world
on-demand from the fresh local chain) — **not** the `worldTransforms` cache, which at 185
still holds the pre-physics (`TRANSFORM_PREPASS`) snapshot. To move a dynamic body, use
`setBodyTranslation3D` (next frame's physics continues from it) *and* set the `Transform`
trait (this frame's propagation reflects it). Home for surface-snapping (the sling puck's
grounded Y), IK/bone fixups after animation, camera follow, and constraint solvers.

**UI does not poll per frame.** `useUIEntities()` (`runtime/ui/useUIEntities.ts`) is a
Zustand selector over `uiTreeStore`. The tree is rebuilt by `uiTreeProjection()`
(registered in the pipeline at `SYSTEM_PRIORITY.PROJECTION`) **only when a dirty flag
is set** — `markUIDirty()` flips it on any ECS UI write, and the projection checks it
once per frame. No per-frame diffing, no extra rAF.

## World Transforms

`runtime/core/ecs/worldTransform.ts` is the canonical, **headless-safe** API that composes an
entity's LOCAL `Transform` + its `parentId` chain into a WORLD pose on demand, and inverts
a world pose back to local. It is the ON-DEMAND complement to `transformPropagationSystem`
(`runtime/core/ecs/transformPropagationSystem.ts` — its L0 sibling since the P5 relocation out
of `src/three/`), which maintains the per-frame `worldTransforms` cache map for the render path (O(1)
lookups): use the cached map in hot per-entity render loops, and these getters when you
need a world pose at a moment the cache may be stale or unpopulated — a game system reading
a parented marker at scene bootstrap, or physics reading back a parented body mid-tick.

- **Query-based, not index-based.** It rebuilds its `id → Transform` / `id → parentId` maps
  from `world.query(...)` on every call (exactly like `transformPropagationSystem`), so it's
  correct **headlessly** — test worlds that spawn directly never populate the entity index,
  but queries see every entity regardless. Composition is euler-XYZ `world = M_root · … ·
  M_leaf`, depth-capped at 64 against `parentId` cycles.
- **Deliberately light** (THREE + koota + two traits) so the simulation half (physics,
  audio, game systems) can consume the world contract WITHOUT pulling in the renderer's
  texture/material deps. `renderUtils` re-exports the 3D getters; `@modoki/engine/runtime`
  re-exports the whole API.
- **Getters:** `getWorldTransform3D()` (decomposed `{x,y,z,rx,ry,rz,sx,sy,sz}`),
  `getWorldMatrix3D()` (raw matrix, no lossy TRS round-trip — for physics body seeding),
  `getParentWorldMatrix3D()` (the matrix you invert for the readback), and `hasParent()`
  (a cheap direct `EntityAttributes` read, no map rebuild — physics uses it to keep the
  unparented root-body fast path).
- **Readback:** `worldToLocal3D(entityId, worldPos, worldQuat[, worldScale])` inverts the
  parent world matrix — `local = parentWorld⁻¹ · world` — so a system that poses a body in
  world space (physics) writes the stepped pose back into a PARENTED entity's LOCAL
  `Transform` correctly. Root entities: `local == world`.

**Gotcha:** the decomposed getters return a **shared singleton** — read/destructure its
fields immediately, never retain it (two live results alias the same object).

### Authoring in world space (`set_transform {space}`)

An agent READS world coordinates (`get_scene_state {world:1}` is what answers "where is this?")
and then naturally writes them back — so authoring needs the same conversion the simulation half
has. `modoki_set_transform` therefore takes a **required** `space: 'local' | 'world'`.

**Required, with no default, deliberately.** The parameter was previously documented as *"World
position"* while writing the LOCAL fields, so asking for a parented entity's own current world
position displaced it by exactly the parent offset and reported success (measured 2026-07-30:
local `(623, 679)` / world `(823, 926)` → written as `(823, 926)` → now at world `(1023, 1173)`).
A default would not remove that mistake, only relocate it into the caller's head; for a ROOT
entity both values are correct anyway, so stating it costs nothing where it cannot matter.

Two implementations, because `set_transform` has two backends and a capability that works in only
one of them is the mode-dependent inconsistency this contract exists to prevent:

- **Live path** — `getWorldTransform3D` + `getParentWorldMatrix3D` for the parent chain (a koota
  query), then `matrixToTrs` → `worldToLocalTrs`.
- **File path** — `runtime/scene/transformSpace.ts`, which walks `EntityAttributes.parentId`
  through the scene JSON's entity array and composes the same euler-XYZ product.

**Both DECOMPOSE the parent, and that is the contract** (owner decision, 2026-07-31). The parent's
world transform is a **TRS**, so both paths compose the ancestor chain exactly and then decompose
**once** — which is also what the SceneView gizmo does (it is handed the render cache's decomposed
parent TRS). All three authoring surfaces therefore write the same local value for the same request.

The live path used to invert the RAW composed matrix instead (`worldToLocal3D`, which is exact even
under shear), making it the odd one out: the same `{space:'world'}` op landed the entity in a
different place depending only on whether an editor happened to be open, and the live answer matched
neither the file path nor a gizmo drag. Measured on a 2-level chain (grandparent scale `(2,1,1)` →
parent rotated 45° → child), requesting world `(10,0,0)` produced local x `3.5355` live vs `4.6589`
headless. `engine/tests/editor/applySceneOpsLive.test.ts` now runs the identical op through both
paths and compares.

**`worldToLocal3D` is unchanged and still exact** — the split is *authoring vs simulation*, not an
accident. Physics writes a stepped body's world pose back through it every frame, as do
`games/sling` (fish steering) and `demos/forest-camp` (arrow attach); simulation wants the exact
inverse, and a per-frame decompose would be cost with no authoring benefit.

Both convert the **whole pose**, never field-by-field: under a rotated parent a world X depends on
the child's world Y and Z too, so converting one field against a base of zeros would silently move
the other axes. The current pose is lifted to world, the caller's fields are overlaid on that, and
the result is converted back.

The write-back is **group-wise** (`persistedTrsKeys`): naming any of `x`/`y`/`z` persists all three,
same for the rotation and scale triples, and the groups are independent. Persisting only the keys
the caller literally named threw away part of the conversion's own answer — `{space:'world', x:10}`
kept `x`, dropped the `y`/`z` that made it correct, and left the entity where it was while reporting
`changed:1`. Writing all nine instead would land decompose noise on axes nobody mentioned.

A **collapsed** (zero-scale) ancestor is **refused**, naming the axes: it maps every descendant onto
its own origin, so the request has no solution. There were two independent reasons the old code
answered anyway, and only one of them has since been fixed — the refusal is **not** obsolete:
`worldToLocalTrs` inverts the parent's matrix, and a singular matrix inverts to the **zero matrix**.
No decomposition rescues that; the information is gone from the matrix. (The other reason — that
`Matrix4.decompose` LIED about the parent — is fixed; see below.)

A **prefab-instance** ancestor contributes its `overrides[localId].Transform`, not `traits.Transform`
— a captured instance root has no top-level Transform at all. (Narrower remaining gap: an instance
with no override Transform inherits its placement from the prefab FILE, which the file-path
conversion cannot read; such an ancestor is still treated as identity.)

The low-level `mutate_scene` `setTrait` op takes the same `space` as an **optional** field
defaulting to literal (local) writes — writing trait fields verbatim is exactly what that op is
for; `space` on any trait other than `Transform` is refused rather than ignored.

**Known limit, and it is a DESIGN DECISION rather than a defect**: a non-uniformly-scaled parent
applied to a rotated child produces a sheared world matrix, and `Matrix4.decompose` cannot reduce
shear back to clean TRS — that combination does not round-trip exactly. This follows directly from
the engine storing a **TRS `Transform` rather than a 4×4 matrix**, chosen deliberately (an
inspectable, authorable, diffable nine-field trait beats sixteen opaque numbers for a scene format
humans and agents both edit). Shear is the price. It applies identically to the human SceneView
gizmo (`editor/scene/gizmoTransform.ts`) — so it is a property of the format, not of any one
writer, and nothing downstream should try to "fix" it locally.

The corollary, confirmed as the convention on 2026-07-31: **a sheared parent is not a legal state**,
the way it is not in Unity's `Transform`. An authoring path that is *more* exact than the format is
not more correct — it just disagrees with the format, the gizmo, and the other path. That is why the
live path was changed to decompose rather than the file path being changed to invert.

### A zero scale axis: `decomposeTrs`, not `Matrix4.decompose` (#258)

Shear above is a limit the TRS format genuinely has. A **zero scale axis is not** — it is an
ordinary authored value ("hidden", "not yet grown", and what a keyframe clip keys when something
grows from nothing) — and three.js answered it with a lie rather than an error:

```js
// three r184, Matrix4.decompose
const det = this.determinant();
if ( det === 0 ) { scale.set( 1, 1, 1 ); quaternion.identity(); return this; }
```

So an entity scaled to zero anywhere in its parent chain composed to a **singular** world matrix and
came back at **identity scale and identity rotation** — drawn at FULL size, with the parent chain's
scale dropped from the other axes and any rotation silently discarded. Measured on `games/court`'s
guard flag: a child at `sx = 0` under a `0.53` root drew 10.8 CSS px wide against 5.2 px for the same
child at `sx = 0.907`. The ECS data was perfectly correct throughout (the local trait reads back `0`
exactly), so only the pixels were wrong.

**Every decomposition of a matrix that can be singular therefore goes through
`runtime/core/ecs/decomposeTrs.ts`** instead of calling `Matrix4.decompose` directly. It delegates
to three whenever the matrix is invertible (identical output, no epsilon anywhere — `0.001` must
keep composing exactly as it does today) and, only on `det === 0`, takes the scale from the basis
column lengths and rebuilds the rotation from the surviving columns. What a TRS triple still cannot
carry at a zero — the scale's SIGN, and the roll about a lone surviving axis — is listed in that
file's header.

The call sites, because "which ones" is the part that rots: both halves of the world-transform
contract (`transformPropagationSystem`, `worldTransform`), the authoring conversion above
(`transformSpace`), the editor's gizmo / group-drag / reparent paths (`gizmoTransform`,
`multiTransform`, `entityActions`, `SceneView`), **GLB import** (`meshTemplateCache`
— a node authored with a zero scale axis, a common way to hide one, would otherwise import at full
size), and the **skeletal** paths (`scene3DSync` ×3, `rigBones`). The skeletal write-back is the
user-reachable one: `Bone` entities are hand-posable, so typing `0` into a bone's scale in the
Inspector composes a singular matrix, and through three that wrote scale 1 and an identity rotation
straight onto the `THREE.Bone`.

The invariant that makes this safe to apply broadly: **`decomposeTrs` is byte-identical to
`Matrix4.decompose` for every invertible matrix**, so converting a site can only change behaviour
where the old answer was already wrong.

`grep -rn '\.decompose(' engine/packages/modoki/src engine/app games/*/runtime demos/*/runtime`
should return exactly one live call — `games/sling`'s aim visual, whose two callers both floor the
length (`1.0 + …` and `|| 0.001`) so its matrix is never singular. A new hit is either a new site
that needs converting or a deliberate exception that should say why.

**Telling the truth about a zero exposed a trap that had been hiding behind the lie.** The SceneView
scale gizmo clamps an axis to 0 when its sign FLIPS mid-drag (`clampScaleCrossingPivot`, so dragging
past the pivot stops instead of mirroring), and it captures the start sign with `Math.sign` off the
object's *world* scale. `Math.sign(0) === 0`, so an axis that starts collapsed differs from every
non-zero drag value and gets clamped back to 0 on every tick — the entity appears to grow during the
drag and snaps back to invisible on mouse-up. That always affected ROOT entities (their world scale
is their local scale, no decompose involved); fixing the composition made it reachable for CHILDREN
too, because a collapsed child used to read back as scale 1. An axis whose start sign is 0 is now
exempt in both `clampScaleCrossingPivot` and `scaleCrossedPivot` — 0 has no side, so there is no
pivot to cross. Being able to drag back out of "hidden" is the workflow the zero idiom exists for.

**The same class, one API over**: `Matrix4.invert()` and `Matrix3.invert()` return the **zero
matrix** on `det === 0`, equally silently. That one is not fixable by better math — a singular
matrix has no inverse — which is why the authoring path *refuses* (`collapsedParentAxes`) rather
than answering. Treat a new `.invert()` on a parent-chain matrix as needing a refusal, not a
fallback.

A knock-on worth knowing: guards written `wt.sx ? … : 0` (e.g. `editor/panels/colliderEdit2D.ts`)
never fired before, because `wt.sx` read back as `1` rather than `0`. They work now.

## Zustand Bridge

`engine/packages/modoki/src/runtime/store/gameStore.ts` (`useGameStore`, consumed via
`@modoki/engine/runtime`) is the bridge between the ECS world and
React views. ECS projection systems **write** game state into the store
(`setScreen`, `setEntityCount`, `setGamePhase`, `setFps`, `setRendererInfo`,
`setFontStatus`); React HUD/menus/screens **read** it via selectors. The store also
exposes the `UIBindableState` shape that `UIRenderer` binding resolution reads from
(via `UIBinding.textBinding` / `visibleBinding`). Game state flows one way (ECS →
store → React); user input flows back through dispatched `UIAction`s.

## Game Decoupling

App core registers only **engine** systems and traits:

- `app/ecs/pipeline.ts` registers the engine system pipeline (~18 systems incl.
  input/physics/animation/audio/transform-propagation/ui-projection/…).
- `app/ecs/registerTraits.ts` registers every engine trait with the editor's
  trait registry (field hints, groups, inspector sections).

**One project = one game (#29).** Each flat project under `games/<id>` is a
self-contained Capacitor app that exports a **single** `game: GameDefinition` from its
`game.ts`. There is no `games/registry.ts` and no `scene-selector` hub anymore — you
**open a project** (the editor auto-reopens your last) or set `MODOKI_PROJECT=games/<id>`.
The `GameDefinition` shape (`@modoki/engine/runtime`, abridged):

```ts
interface GameDefinition {
  id: string;
  name: string;
  loadConfig: () => Promise<GameConfig>;            // scene/config to load
  registerSystems?: () => Promise<void> | void;     // game systems + trait metadata
  unregisterSystems?: () => Promise<void> | void;   // cleanup on teardown
  registerPostprocessors?: () => Promise<void> | void;
  registerEditorBindings?: () => void | Promise<void>; // editor-only glue (UI bindings, creatable-asset registrations, …)
  registerAppServices?: () => Promise<void> | void;    // native analytics/ads/etc.
  resetPhase?: (world: World) => void;              // error-recovery reset
  UIComponent?: React.ComponentType;                // optional custom React UI layer
}
```

`registerSystems()` is where a game adds its own systems (via `registerSystem`) and
trait editor metadata; `unregisterSystems()` tears them down without touching engine
systems. When `UIComponent` is set, it replaces the default ECS `UIRenderer` for that
game (e.g. the chat-driven games).

Games are discovered through `virtual:modoki-games` at build time; the **editor** takes
a runtime path (`app/projectGames.ts` → `loadProjectGames()`) that imports the *open*
project's `game.ts` from the backend, so switching projects needs no editor rebuild.
**Adding/authoring a game requires zero edits to app core** — the app
(`app/ecs/pipeline.ts`, `app/ecs/registerTraits.ts`) only registers engine systems and
traits; the game's own `runtime/setup.ts` registers its systems, projections, and trait
metadata. Current projects: `3d-test` (Tropical Island — Three.js/NPR/model import,
iOS+Android native), `alien-animal` (skeletal-animation showcase), `space-console`,
`chess`, `llm-test`, and others; the template scaffold lives at `engine/templates/starter`.

### The boot effect runs EXACTLY ONCE per `gameId` (#267)

Every hook above is driven from one effect in `engine/app/App.tsx` (`GameShell`), in this
order: `unregisterSystems` (previous game) → `registerPostprocessors` → `registerSystems` →
`registerAppServices` → `attribution.init()`/`ads.init()` → `PlayerPrefs.init` → `resetPhase`
registration → `loadConfig` → `initWorldSync` (first load) → quality-tier resolution →
renderers mount → `loadScene` → `onSceneReady`. **A hook may assume it is called once per
game load** — so a hook is allowed to have side effects that must not repeat (starting a native
SDK, showing a consent prompt, spending a network call).

That guarantee is younger than the code. The effect's dependency array used to be
`[gameId, initialized, configReady]` while the effect itself calls `setConfigReady(true)`
and `setInitialized(true)` mid-body, so it re-ran for the same game and drove the whole
sequence twice. It was invisible for a long time because `loadScene` is cancel-and-replace
and therefore idempotent — the screen was right and only the side effects doubled. What
finally showed it was a native SDK: `games/court`'s AppsFlyer integration put **two App
Tracking Transparency prompts** in front of the player on one launch (iPhone 8,
2026-08-19 — `requestTrackingAuthorization` at 21:49:33.175 and again at 21:49:35.364).

⚠️ **"Once" means once in a SHIPPED build.** `engine/app/main.tsx` wraps the app in React
`<StrictMode>`, which deliberately double-invokes every effect in dev (mount → cleanup →
mount), and that is unchanged by the fix — the boot sequence really does run twice in the
editor and in `npm run dev`. The device measurement above was a production build, where
StrictMode is inert. So a game hook whose side effect must not repeat still wants its own
latch for the dev path (`games/court`'s AppsFlyer wrapper is the worked example); what the
fix removes is the double-drive that reached PLAYERS.

**The game-SWITCH path has failure modes that outlive the switch**, all worth knowing before
you touch the early-return guard. Switching A→B and back to A while B is still loading cancels
B's run before it reaches either `setTransitioning(false)`, so the guard must clear
`transitioning` itself or the opaque loading overlay covers a game that is running perfectly
well underneath, for the rest of the session. And `error` gates the whole render tree, so it is
cleared at the start of every new load: it had no path back to `null` at all, which meant one
unknown gameId left the error screen up even after a later game loaded successfully behind it.

⚠️ **A cancelled swap must not leave a game half-torn-down, and telling "loaded" apart from
"owns registered state" is what makes that work (#516).** The same A→B→A path unregisters A's
systems at the top of the effect, before its first await. `activeGameIdRef` was written only on
the success path, so it still said "A" while A was in pieces, the swap-back took the
early-return guard, and **A stayed on screen with its systems, projections and managers gone
for the rest of the session** — with the loading overlay dismissed over the top, so nothing
looked wrong. Three refs now carry three different facts, and collapsing any two of them
reintroduces one of these bugs:

| Ref | Answers | Written |
|---|---|---|
| `activeGameIdRef` | which game is loaded AND intact — the early-return guard | on success; **nulled when a teardown starts** |
| `registeredGameIdRef` | which game owns registered engine state | **before the first registration** (`registerPostprocessors`), so a boot cancelled part-way is still known to own what it registered |
| `teardownRef` | a teardown that started but whose destructive half is unfinished, plus its promise | before the teardown's first await; cleared when `clearAppServices()` has run |

**The same rule holds one layer down, in the manager registry (#539).** `managerRegistry`'s own
`activeGameId` had this exact defect — written only by `initGameManagersFor`, i.e. only on success,
while `disposeActiveGameManagers` began the teardown several awaits earlier — and is now cleared at
that teardown's head for the same reason this ref is. Mechanism and the one case it does not close:
[managers-and-systems.md](managers-and-systems.md) § "Scope: three tiers".

`teardownRef` holds the unregister **promise** rather than a boolean so a swap-back JOINS the
teardown instead of repeating it — and is **cleared if that promise rejects**, because a
memoized rejection would be re-joined by every later swap and no game would ever boot again
(the hooks are dynamic `import()`s, so a chunk 404 after a deploy reaches this) — `unregisterSystems` is a hook, and calling it twice is
exactly what the once-per-load contract above forbids. The teardown block therefore runs even
when the incoming game IS the previous one: A is owed the rest of its teardown before it can be
booted again. Booting it again — rather than resuming it in place — is the deliberate choice:
the path is a mis-tap, and a full re-boot is the only option that cannot leave a second kind of
half-done swap behind. Pinned by `engine/tests/app/gameShellSwapCancel.test.tsx`.

The rule that follows, for anyone editing that effect: **its dependency array is `[gameId]`
and nothing else.** State the effect writes is mirrored into refs (`configReadyRef`,
`initializedRef`) precisely so it cannot appear there. Re-entrancy for a *different* game is
still supported and still cancels the in-flight load — that is what the `cancelled` flag and
`activeGameIdRef` are for. Pinned by `engine/tests/app/gameShellLoadOnce.test.tsx`, whose
third case is the one that matters: it proves a second game still loads, i.e. that the fix
tightened the guard rather than freezing the effect.

For how scenes are loaded into a world and how prefabs instantiate, see
[Scene Loading](./scene-loading.md) and [Prefabs](./prefabs.md).

### A memoized promise must be cleared when it rejects (#541)

**The general rule, swept repo-wide in #541: a memoized promise must be cleared when it
rejects.** `x ??= somethingAsync()` with no clearing `catch` means "load once" on success and
"fail forever" on failure, and every instance in this repo memoizes a dynamic `import()` or a
network fetch — exactly what fails transiently on a chunk 404 after a deploy, an OTA bundle
swap, or a flaky network. Impact scales with how the caller retries: the physics systems call
`initRapier2D()`/`initRapier3D()` on every tick that sees a body, so one transient failure
re-fires the same dead rejection every frame and physics never starts; `dynamicFontProvider`
fails silently, and on a CJK game a glyph miss is the normal path, not the exception.

Clear it behind an **identity guard**, the model at `runtime/loaders/assetManifest.ts`'s
`ensureManifestLoaded`:

```ts
const promise = load(); memo = promise;
promise.catch(() => { if (memo === promise) memo = null; });
```

The `=== promise` check is the part that is easy to miss — clearing unconditionally lets a
stale rejection evict a NEWER in-flight load. `teardownRef` above nulls unconditionally and is
safe only because its `await` resumption and catch body are one microtask; do not copy that
shape blindly. Two deliberate non-instances: `msdfGenerate.ts`'s `getGenerator` caches its
rejection on purpose (so N fonts do not each pay its 10 s timeout), and `textureResolver.ts`'s
`probePromise` cannot reject at all — its IIFE swallows every error and always marks the gate
ready.

**Measured limit — a cleared memo does NOT make a failed `import()` retry.** A failed module
fetch is recorded in the browser's module map per specifier, and re-calling `import()` with the
same specifier resolves against that recorded failure without issuing another request.
Verified 2026-09-01 across Chromium, WebKit and Firefox with a local server logging every hit:
three `import('/mod.js')` calls against a 404 produced exactly ONE server-side request; the
third still rejected even after the server was fixed to return 200; a control import of a
different URL resolved, and the same module with a cache-busted `?v=2` both resolved and
reached the server. So for the failure the sites above actually face — a chunk 404 after a
deploy or an OTA bundle swap — **clearing the memo buys nothing, and the warning is the entire
value**; a real retry would need a cache-busted URL. What a cleared memo DOES rescue is a
failure *after* a successful import (e.g. `mod.init()` in the rapier loaders instantiating
WASM), because the module is already resolved and the next attempt re-runs that step for real.
This is why those loaders retry a bounded number of times and then fail loudly rather than
retrying forever: the caller (`physics2DSystem.ts`'s `physics2DSystem`) has no backoff and
would otherwise re-import at frame rate. ⚠️ **Do not read that budget as a meaningful retry
window.** It is counted in ATTEMPTS against a caller that retries every tick, so all three
are spent within roughly three frames of the failure — it rescues a condition that clears
in ~50 ms, not a device stall lasting a second. Combined with the measured fact that the
`import()` half is not retryable at all, the WARNINGS are most of the value here. A
time-based budget (retry while
`now - firstFailureAt < N`, capped at K attempts) would actually cover a transient
WASM-instantiate failure; a count-only budget against a frame-rate caller does not.

## Single source of truth — where a value lives is decided by what KIND of value it is

A core Modoki philosophy: never hardcode game data in TS that duplicates the scene/prefab/config;
a resize/recolor/reposition should be a **one-place** edit. Decision rule for any structural or
tunable value:

- **Spatial / geometry** (an entity's position, extent, size, colour) → **Scene or prefab**
  (authored entity data). Game code READS it at bind/spawn time and derives from it — e.g. read
  wall x / red-line z from the scene, collider radius + primitive colour from the prefab —
  rather than keeping a parallel constant.
- **Designer-tunable balance/feel knob** (speeds, damage, HP, timings) → the game's **config
  resource** — a singleton resource-trait read at bootstrap with code defaults (e.g.
  `SlingConfig`; registered `category:'resource'`, live-editable in the Inspector, hot-reloads).
- **Asset reference** (a texture/prefab/mesh/material/particle/audio/font GUID) → a field on a
  **resource trait authored in the scene**, NOT a code constant. **This AMENDS the rule (#53):
  "asset GUID" used to sit under *code constant* below, and that was wrong for a reason the rule
  never considered — a GUID in code is a ref THE BUILD CANNOT SEE**, so the asset is dropped from
  the production build and it fails only once you ship (dev serves everything off disk). Guarded
  by `engine/tests/assets/codeAssetRefs.test.ts`. Why, the three passes it broke, and what the
  guard does/doesn't reach: [build.md](./build.md) § "Assets the build cannot see". Still a code
  constant: a GUID used *only* as a no-scene fallback for something the scene also authors.
- **Structural invariant / implementation detail** (fixed dt, a value used ONLY as the
  no-scene/no-prefab fallback, a sentinel, an epsilon) → a **code constant** — this is mechanism,
  not config; don't force it into the scene/config.

The failure mode to avoid: a code constant that SHADOWS a scene/prefab/config value and has to be
kept in sync by hand — it will go stale (e.g. a `WALL_X` const drifting from the authored walls
after a resize). Read from the one source instead. Worked example: `games/sling/runtime/systems.ts`
reads field bounds from the scene walls in `bindStaticField` and entity size/colour from the
prefab via `prefabSphereR`/`prefabColor`; only genuine fallbacks/invariants remain as consts.

## Editor Backend (Vite / Electron parity)

The editor's `/api/*` command endpoints are served by a **transport-agnostic router**
(`engine/plugins/backend/editorBackendRouter.ts`) — pure `(ctx, params) =>
BackendResult` handlers over `/api` paths, over a small filesystem/exec
`BackendContext` interface. The
same router is mounted by **both** hosts, so daily Electron use exercises the exact
production backend path the DMG ships, not a Vite-only surrogate:

- **Dev** — the Vite dev middleware (`vite-asset-scanner.ts`) mounts it.
- **Electron** — `engine/electron/backendServer.ts` is a tiny loopback `http` server
  wrapping the same router. The renderer's backend client is pointed at it via
  `window.__modokiBackendBase`. It takes a fixed port (`MODOKI_BACKEND_PORT`, a stable
  MCP target) or an ephemeral one, and restricts CORS `Access-Control-Allow-Origin` to
  the exact Vite origin (the loopback backend is privileged — fs writes / builds — so
  `'*'` would invite CSRF / DNS-rebind from any page the user visits).

Two host-specific concerns stay out of the shared router:

- **`/api/build` + `/api/add-native-target` (SSE)** — the build/deploy pipeline (`vite
  build` + gcloud/gradle, `cap add` scaffolding) lives in the Vite middleware, so the
  Electron backend **proxies** those event streams straight to its main-owned Vite
  server rather than duplicating the pipeline; the renderer's `EventSource` still targets
  one base. With no `viteOrigin` they return 503.
- **Asset bytes + the watcher** — `engine/electron/assetBackend.ts` is a standalone
  chokidar asset backend giving the router the same asset-root resolution + manifest
  cache + file watcher the Vite plugin owns, so it runs in main **with no Vite server**.
  It reuses the scanner's pure machinery (`findAssetRoots` / `scanAllAssets` /
  `buildManifest` / `resolveAssetPath` / `detectType`) and re-implements only the
  editor-own-write suppression (a 1.5 s TTL + content-hash guard so an editor Cmd+S
  doesn't bounce the live scene) and the debounced scene/prefab classification inline —
  identical logic to the Vite plugin, kept separate to avoid importing a Vite-plugin
  module into the Electron main process.

The MCP tools that drive this backend (`modoki_*`) are documented in
[Debug Tools (MCP)](./debug-tools-mcp.md).
