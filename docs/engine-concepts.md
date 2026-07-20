# Engine concepts — the modoki vocabulary

modoki is an **ECS engine** (built on [koota](https://github.com/pmndrs/koota))
wrapped in rendering, UI, lifecycle, and editor layers. This doc defines every
building block and — crucially — **when to reach for which**. It's the conceptual
entry point; deeper mechanics live in the per-feature docs linked at the bottom.

For the design rationale and lifecycle details behind Managers & Systems
specifically, see [managers-and-systems.md](./managers-and-systems.md).

## At a glance

| Concept | What it is | Ticks every frame? | Holds | Example |
|---|---|---|---|---|
| **Entity** | an id — a thing in the world | — | nothing (just identity) | a chess piece, a UI button |
| **Component** (Trait) | pure data on an entity | — | typed fields | `Transform`, `UIElement` |
| **World** | the container of entities | — | all entities + their traits | the active scene's world |
| **System** | per-frame `update(world)` | **yes** | nothing (transforms ECS) | `animationSystem`, `shipShakeSystem` |
| **Projection** | mirrors a store into ECS | on change (or a tick) | nothing | `chessChatProjection` |
| **Manager** | event-driven logic owner | **no** | long-lived state + methods | `SceneManager`, `ChessManager` |
| **Store** | reactive state container | — | the data the UI renders | `useChessStore` |
| **Service** | SDK / platform wrapper | — | a connection/handle | `ads`, `audio` |
| **Utility** | pure function | — | nothing | `anchorLayout`, `render2DUtils` |

The **one question** that separates the two active roles: *does it produce a
different result on frame N+1 with no input change?* (easing, oscillation, time)
→ **System**. Only reacts to events? → **Manager**.

---

## The data layer

### Entity
An entity is just an **id** — koota packs `worldId/generation/localId` into a
number. It has no data of its own; everything about it lives in the components
attached to it. Parent/child relationships are expressed by
`EntityAttributes.parentId`, not a scene-graph object.

### Component (Trait)
A **component** is a bag of typed data attached to an entity. In koota's
vocabulary (and ours) it's called a **trait**. Two kinds:

- **Data traits** carry fields: `Transform` (position/rotation/scale),
  `Renderable3D` (mesh + material GUIDs), `UIElement` (~50 layout/style fields),
  `Camera`, `Light`, `ParticleEmitter`, `Animator`, …
- **Tag traits** carry no fields and mark an entity: `Persistent`, `Paused`,
  `RenderableUI`.

Traits are **pure data** — they contain no behavior. Behavior that reads/writes
a trait lives in a System (per frame) or a Manager (on events). Each trait is
declared to the **trait registry** with editor metadata (field types, tooltips)
that drives the Inspector and auto-serialization.

> A few traits have a System that "owns" them: `Rotate3D` → `rotate3DSystem`,
> `Animator` → `animationSystem`. The trait is still just data; the system is
> what makes it move.

### Asset reference (GUID)

When a trait field points at an asset — a mesh, material, texture/sprite, particle
effect, HDR environment, GLB — the field holds a **stable GUID**, never a file path.
The asset manifest (`runtime/loaders/assetManifest.ts`) resolves the GUID to a served
URL at load time, so a file can be renamed or moved without touching a single scene.
`resolveRef` **rejects a literal internal path** (e.g. `/games/x/assets/foo.mesh.json`)
with a loud `console.error` and resolves it to `undefined` — so a hand-written path
fails visibly rather than silently working in dev and 404ing in a production build.
Mint a GUID with `newGuid()`; look one up with `getGuidForPath()`. The only values that
pass through unchanged are genuinely external resources (`http(s)://`, `data:`, `blob:`),
the primitive sprite keywords (`circle`/`square`/`triangle`), and `UIElement.fontFamily`
(a CSS family name). The invariant is guarded by `tests/assets/assetRefIntegrity.test.ts`.
See [textures.md](./textures.md) and [scene-loading.md](./scene-loading.md).

### World
A **world** holds all entities and their traits. modoki uses **two-world
isolation** for scene swaps: the next scene is built in a staging world, then
swapped in atomically (`setCurrentWorld`), which fires `onWorldSwap`. See
[scene-loading.md](./scene-loading.md).

---

## The logic layer — five roles

Logic never lives in a trait. It lives in one of five roles. Naming all five is
what keeps logic from sprawling into `init.ts`/`setup.ts` junk drawers.

### System
A **System** is a function `(world) => void` registered in the **pipeline** at a
priority and run **every frame**. Use it for anything that must react to time
passing: animation, physics, easing, oscillation, time accumulation, and the
per-frame render sync (`Scene3D`/`Scene2D`).

```ts
registerSystem('space-console/shipShake', shipShakeSystem, SYSTEM_PRIORITY.GAME + 3);
```

Priorities run in tiers: `TIME (0)` → `INPUT (50)` → `GAME (100)` →
`ANIMATION (150)` → `TRANSFORM_PREPASS (170)` → `PHYSICS (175)` →
`LATE_UPDATE (185)` → `TRANSFORM (200)` → `AUDIO (250)` → `MATERIAL (260)` →
`PROJECTION (300)` (the full `SYSTEM_PRIORITY` set in `runtime/systems/pipeline.ts`;
see `managers-and-systems.md` for what each tier is for). When the sim isn't running
(editor Stopped/Paused), tiers below `TRANSFORM` are skipped so game time freezes.
A System may **own UIActions** via `{ actions }` — registered/dropped with it.

### Manager
A **Manager** is an event-driven logic owner with **no tick**. It holds
long-lived state + a method surface, and may own UIActions (same shape Systems
use). It's the home for everything that isn't per-frame: scene navigation, an AI
controller, a model-download lifecycle, app commands.

Scope decides lifecycle, three tiers: **scene** (default — active while a matching
scene is loaded, state can't leak across scenes), **game** (opt-in — keyed on the
active game, survives scene swaps *within* that game), or **app** (opt-in — engine
infrastructure that lives the whole session, e.g. Time/Navigation). Registered via
`registerManager`, symmetric to `registerSystem`.

```ts
class ChessManager implements ManagerDef {
  // Scene-scoped: the LLM download in init() is expensive, so it waits for the
  // chess scene to load rather than firing the moment the manager is registered
  // (the editor registers every game's managers up front).
  name = 'chess.controller'; scope = 'scene' as const; scenes = ['chess'];
  actions = { 'chess.newGame': () => this.newGame() };
  init() { /* start a new game + LLM download */ }
}
```

Full design — scope rules, the SceneManager-owned lifecycle, why a Manager is a
singleton not a service-locator — in [managers-and-systems.md](./managers-and-systems.md).

### Projection
A **Projection** mirrors a **store into ECS** (so a React/Zustand value shows up
on entities the renderer draws). Two forms:

- **Event-driven** (`registerProjection`) — subscribes to the store and runs at
  `PROJECTION` priority only on the first frame after the store changes or the
  scene swaps. Use for **pure store→ECS mirrors** (`chessStateProjection`,
  `llmStateProjection`).
- **System** (`registerSystem`) — sync that *can't* be a pure mirror because it
  does genuine per-frame work the dirty flag would starve. Such code is a System
  and is **named `*System`, not `*Projection`** — the two reasons it shows up:
  - it must poll for something no store change signals — `chessBoardSystem`
    re-attaches a click handler whenever the PixiJS canvas remounts; or
  - it runs the *reverse* direction (**ECS → store readback**), so there's no
    source store to subscribe to — 3d-test's `gameStatsSystem` reads GamePhase /
    entity count / FPS off ECS and writes the HUD store.

The litmus test is the same: needs a tick (or has no source store) → System; pure
store→ECS mirror → projection. A file that ends in `Projection` should be a
`registerProjection` mirror and nothing else.

### Store
A **Store** is a [Zustand](https://github.com/pmndrs/zustand) **reactive state
container** — pure data + setters, no logic, no tick. Its job is to be the
**subscribable surface React re-renders from**. A Manager owns the logic and
*writes* the store; React components and Projections *read* it.

The split inside a feature is sharp: **internal plumbing → Manager fields;
reactive, displayed state → Store.** In `LLMManager` the `llmService` handle is a
private field (never shown), while `messages`/`status`/`loadProgress` live in
`useLLMStore` (rendered by the chat UI + projected to ECS).

### Service & Utility
- **Service** — a stateful wrapper around a platform/SDK: `ads` (AppLovin MAX),
  `audio` (Web Audio), `analytics`/`crashlytics` (Firebase), `attribution`
  (Adjust). Event-driven, async, no tick. See [native-and-sdks.md](./native-and-sdks.md).
- **Utility** — a pure function with no state: `anchorLayout.resolveAnchorRect`,
  `render2DUtils.drawPrimitiveShape`, color/coordinate helpers.

---

## The wiring layer — registries

Registries are how the loose pieces find each other at runtime. Each is a small
module with `register*`/`unregister*` + a lookup.

| Registry | Holds | Used by |
|---|---|---|
| **Trait registry** | trait metadata (fields, categories) | Inspector, serialization, validation |
| **System pipeline** | ordered per-frame systems (+ owned actions) | the frame loop (`runPipeline`) |
| **Manager registry** | manager lifecycle (+ owned actions), scoped | SceneManager (scene scope), core/game (game scope) |
| **Action registry** (write side) | named UIActions handlers | `UIAction` `call` bindings → `dispatchUIAction` |
| **Read-source registry** (read side) | named live getters | UI text bindings resolve `{name}` against them |
| **Resource caches** | refcounted GPU resources (mesh/material/texture/env/prefab) | SceneManager (acquire on load, release on swap) |

The **write side / read side** pair is the symmetry that lets Managers/Systems
expose a surface to declarative UI without coupling:

- **Write:** a button's `UIAction` binding `{kind:'call', action:'chess.newGame'}`
  dispatches a named action a Manager/System registered.
- **Read:** a label's text `Time: {timeSinceGameStart}` resolves through the
  read-source registry to a Manager getter — no per-frame projection needed.

**Scene & resource management** is itself a set of Managers: `SceneManager`
(async two-world loading, the swap, scene callbacks, Manager lifecycle hooks) and
the refcounted caches in `meshTemplateCache` (the scene is the unit of memory
management). See [scene-loading.md](./scene-loading.md).

---

## How a frame flows

```
requestAnimationFrame                          (frameDriver, one rAF loop)
  └─ runPipeline(world)                         systems in priority order:
       TIME        → timeSystem                 advance Time.elapsed/delta
       GAME        → game systems               shake, flame, camera-distance…
       ANIMATION   → animationSystem            advance clips
       TRANSFORM   → transformPropagation       local → world matrices
       PROJECTION  → uiTreeProjection + …       rebuild dirty projections
  └─ render callbacks (priority-ordered)        Scene3D → Scene2D sync ECS → GPU
```

`useUIEntities` is *not* per-frame — it's a Zustand selector backed by
`uiTreeProjection`, which rebuilds the DOM tree only when `markUIDirty()` flips a
flag (checked once per frame at PROJECTION priority).

## How a UI interaction flows

```
user clicks a button
  → UINode onClick → applyBindings(bindings,'click')        (gated by isSimRunning)
      ├─ kind:'set'  → write a trait field directly          e.g. UIElement.isVisible
      └─ kind:'call' → dispatchUIAction(name,…)
           → a Manager/System handler runs                   e.g. ChessManager.newGame()
               → writes a Store                               useChessStore.newGame()
                   → Projection re-runs (store changed)       chessStateProjection
                       → writes ECS entities                  status text, highlights
                           → render sync paints it            Scene2D
```

The reverse (a value flowing *to* a label) is the read side: the binding resolver
reads store state, then read-source getters, when resolving `{placeholders}`.

---

## Choosing where logic goes

1. **Is it data?** → a **Component/Trait**. (No behavior in traits.)
2. **Does it react to time passing** (different next frame with no input)? →
   a **System**.
3. **Does it mirror a store into ECS?** → a **Projection** (event-driven via
   `registerProjection`, unless it needs a per-frame tick → System).
4. **Is it reactive state the UI renders?** → a **Store**.
5. **Does it wrap a platform/SDK?** → a **Service**.
6. **Is it a pure function?** → a **Utility**.
7. **Otherwise** (event-driven logic, lifecycle, commands, controllers) → a
   **Manager**. Scene-scoped by default; game-scoped if it must survive swaps.

If you're about to add a handler to `setup.ts` or a free function to `init.ts`,
stop — that's a Manager method or a System, and `setup.ts` should stay a pure
manifest (`registerSystems` + `registerManagers` + trait metadata).

---

## Where to read more

- [managers-and-systems.md](./managers-and-systems.md) — Manager/System design,
  scope rules, the read/write registries, TimeManager & NavigationManager, the
  decision log.
- [architecture.md](./architecture.md) — ECS core, traits, layers, frame driver,
  game decoupling
- [rendering.md](./rendering.md) — the three render layers, WebGPU, NPR post-process
- [scene-loading.md](./scene-loading.md) — two-world swap, refcounting, persistence
- [ui-system.md](./ui-system.md) — ECS UI traits, UIRenderer, custom React UI
- [prefabs.md](./prefabs.md) · [model-pipeline.md](./model-pipeline.md) ·
  [textures.md](./textures.md) · [editor.md](./editor.md) ·
  [native-and-sdks.md](./native-and-sdks.md)
