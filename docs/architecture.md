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

The ECS core lives under `packages/modoki/src/runtime/ecs/`:

- **`worldRegistry.ts`** — owns the active koota `World`. There is **no singleton
  `world` export**. Consumers call `getCurrentWorld()` *inside* callbacks/functions
  (never captured at module load), so world swaps take effect immediately. Scene
  loading builds a transient "next" world in isolation, then calls
  `setCurrentWorld(next)` to atomically promote it; `onWorldSwap(fn)` subscribers are
  notified. Each world has its own number→Entity index stored in a `WeakMap`
  (`getEntityIndex(world)`), so disposing a world GCs its index.
- **`world.ts`** — re-exports the registry functions and adds entity-index helpers:
  `findEntityById()`, `findEntityByGuid()`, `registerEntity()`, `unregisterEntity()`,
  `indexEntityGuid()`, `rebuildGuidIndexSync()`. In dev it exposes `window.__ecsWorld`
  as a live getter.
- **`entityUtils.ts`** — editor/runtime entity helpers: `getAllEntities()`,
  `buildEntityTree()`, `findEntity()`, `readTraitData()`, `writeTraitField()`,
  `deleteEntity()`, plus dirty-tracking (`fireDirtyListeners()`, `markStructureDirty()`).
- **`traitRegistry.ts`** — name→trait lookup (`getTraitByName()`), used so code and
  tests can resolve traits by string without importing them directly.

### Entity indexes (number → Entity, guid → Entity)

Each world carries **two** per-world indexes, both `WeakMap<World, Map<…>>` in
`worldRegistry.ts` so disposing a world GCs its indexes:

- **`getEntityIndex(world)`** — `number → Entity`, keyed by koota's numeric id.
  `registerEntity()`/`unregisterEntity()` (called around `world.spawn()`/`.destroy()`)
  maintain it; `findEntityById()` reads it O(1). `findEntity()` (entityUtils) adds an
  O(n) fallback scan of `world.entities` for entities that never went through
  `registerEntity()` (mostly test fixtures) — it `console.warn`s in dev so the missing
  registration gets fixed.
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
(`runtime/traits/EntityAttributes.ts`) for metadata: `name`, `isActive`, `sortOrder`,
`parentId` (0 = root), `layer`, and `guid`. `parentId` builds the scene hierarchy;
`guid` is the entity's stable UUID that survives scene swaps and cross-prefab
references.

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
`SYSTEM_PRIORITY` tiers (`runtime/systems/pipeline.ts`):
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

`runtime/ecs/worldTransform.ts` is the canonical, **headless-safe** API that composes an
entity's LOCAL `Transform` + its `parentId` chain into a WORLD pose on demand, and inverts
a world pose back to local. It is the ON-DEMAND complement to `transformPropagationSystem`,
which maintains the per-frame `worldTransforms` cache map for the render path (O(1)
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
  registerEditorBindings?: () => void | Promise<void>; // editor-only UI binding glue
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

For how scenes are loaded into a world and how prefabs instantiate, see
[Scene Loading](./scene-loading.md) and [Prefabs](./prefabs.md).

## Editor Backend (Vite / Electron parity)

The editor's `/api/*` command endpoints are served by a **transport-agnostic router**
(`engine/plugins/backend/editorBackendRouter.ts`) — ~59 pure `(ctx, params) =>
BackendResult` handlers (over ~57 `/api` paths) over a small filesystem/exec
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
