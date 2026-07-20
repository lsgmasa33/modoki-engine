# Managers & Systems — the engine's logic roles

> **Status:** implemented. (The original phased rollout has fully landed; see git history
> for the retired `managers-rollout-plan.md` tracker.)
>
> **Historical note:** the `scene-selector` game used below as an example was the
> pre-#29 multi-game hub; it was removed in the one-project-per-game teardown. Its
> `navigateBack`/card-spawning are kept here only to illustrate the Manager roles —
> the Manager/System primitives themselves are unchanged.

## Why this exists

Game logic was leaking into per-game `setup.ts` (inline `registerUIAction`
closures) and `init.ts` (free functions like chess's `handleAITurn`,
scene-selector's `navigateBack`). The root cause is an **asymmetry**, not a
discipline problem:

- A **System** is first-class. `registerSystem(name, fn, priority, { actions })`
  gives per-frame logic a named home with an ordered tick, owned UIActions, and
  automatic cleanup. Nobody scatters per-frame logic, because it has an obvious
  place to go.
- A **Manager** had no equivalent. There was no `registerManager`. So
  event-driven logic (AI turns, navigation, "new game", card spawning) had
  nowhere to live and leaked into `init.ts`/`setup.ts` as loose functions.

The fix is to make **Manager a first-class registerable unit, symmetric to
System**. Then there is exactly one home per role, and `setup.ts` becomes a pure
manifest while `init.ts` disappears.

## The five roles

Don't force everything into two buckets. The codebase genuinely has five, and
naming them is what keeps logic from sprawling.

| Role | Ticks? | Driven by | Holds | Examples |
|------|--------|-----------|-------|----------|
| **System** | yes | the frame clock | per-frame transform of ECS state | `timeSystem`, `animationSystem`, `shipShakeSystem`, `transformPropagationSystem`, render sync, `chessBoardSystem` (canvas-remount poll), `gameStatsSystem` (ECS→store readback) |
| **Manager** | no | events (clicks, scene swaps, SDK callbacks) | long-lived state + a method surface | `SceneManager`, `actionRegistry`, `audio`, (new) `NavigationManager`, `TimeManager` |
| **Projection** | on change | store subscription (dirty flag) | mirrors state store→ECS, no logic | `uiTreeProjection`, `chessStateProjection` / `chessChatProjection`, `llmStateProjection` / `chatMessageProjection` |
| **Store** | no | mutations | Zustand state container | `gameStore`, `engineStore`, `debugStore`, `chessStore`, `llmStore` |
| **Trait / Service / Utility** | no | n/a | pure data / SDK wrapper / pure fn | `UIElement`, `ads`, `anchorLayout`, `render2DUtils` |

### The litmus test

> **Does the logic produce a different result on frame N+1 than frame N with no
> input change?** (easing, oscillation, physics, time accumulation)
> **Yes → System. No → Manager.**

A `navigationSystem` fails this test — navigation never reacts to time passing —
so navigation is a **Manager**, not a System. Time *passes* the test for clock
advance (System) but *fails* it for `timeSinceGameStart` (a derived read →
Manager). Many features are **both** — see [Time](#time-system--manager).

### Projections are a System sub-role, not game logic

Seven of the registered "systems" are projections: they tick only to *poll for
change* and mirror a store into ECS (or back). They're correctly Systems (they
tick), but six of them hand-roll per-frame change detection. `uiTreeProjection`
already solved this with a **dirty flag** (`markUIDirty`). A future
`registerProjection(name, store, syncFn)` helper that subscribes to the store and
runs `syncFn` only on change would turn those six pollers into event-driven syncs
(see the rollout plan, Phase 6 — out of scope for the core work).

## The Manager primitive

```ts
interface ManagerDef {
  name: string;
  scope?: 'app' | 'scene' | 'game';   // default 'scene'
  scenes?: string[];             // scene-scope only: path substrings; omit = every scene
  games?: string[];              // game-scope only: active-game ids; omit = every game
  actions?: Record<string, UIActionHandler | UIActionDef>;  // SAME shape systems use
  init?(ctx: ManagerContext): void | Promise<void>;
  dispose?(ctx?: ManagerContext): void;
}
interface ManagerContext { world: World; scenePath: string; }

registerManager(def)      // mirrors registerSystem
unregisterManager(name)   // drops owned actions, calls dispose()
```

### Scope: three tiers — scene by default, game and app opt-in

Scene-default makes the safe choice the default — a Manager's state can't leak
across scenes unless you explicitly ask it to. Two coarser tiers opt in to longer
lifetimes, each keyed on a different thing:

| | **scene (default)** | **game (opt-in)** | **app (opt-in)** |
|---|---|---|---|
| Keyed on | active **scene path** (`scenes` filter) | active **game id** (`games` filter) | nothing — the whole session |
| `init()` fires | when a matching scene loads | when its game becomes active | once, at `registerManager` |
| `dispose()` fires | on every swap away, **before** the old world dies | when the **active game changes**, not on in-game swaps | only at `unregisterManager` |
| State | reset per scene — **cannot leak** | persists across a game's scenes | persists the whole session |
| Use for | per-screen controllers, card spawning, **single-scene controllers with an expensive init** (e.g. the chess / llm-test LLM download) | a controller genuinely spanning a game's scenes (e.g. the space-console camera across Station↔Warp) | engine infrastructure (Time, Navigation) and global cross-game actions (return-to-hub) |

**Why `game` is keyed on the active game, not on register.** The editor registers
*every* game's systems up front, so "activate on register" would light up all
games' game-scoped managers at once — which is how an LLM download once fired just
from opening an unrelated scene. Keying on `activeGameId` (set on a real game
switch, derived from the scene path otherwise) means only the *active* game's
managers run, in both the editor and production. A single-scene controller with an
expensive init therefore belongs in `scene`, never `game`.

### Who owns the lifecycle: SceneManager

Because scene and game scope are both keyed on what's loaded, **`SceneManager`
owns Manager lifecycle** — which is also why navigation belongs there (same
owner). The hooks slot into the existing swap sequence in
`SceneManager.loadScene`, with no new machinery:

```
setCurrentWorld(new)
  → if the game changed: dispose old game-scoped managers   (their world is about to die)
  → dispose old scene-scoped managers                       (their world is about to die)
  → releaseAllForScene(old)
  → oldWorld.destroy()
  → if the game changed: init new game-scoped managers that match the game filter
  → init new scene-scoped managers that match the scene filter   (via fireSceneCallbacks)
```

App-scoped managers are untouched by swaps — they init/dispose only at
`registerManager`/`unregisterManager`.

### Method access: singleton, not service-locator

A Manager is a plain singleton; `registerManager` only wires its *lifecycle +
actions*. Other code calls its methods by importing it directly — no
`getManager(name)` lookup.

```ts
// chess/managers/ChessManager.ts — logic lives HERE
class ChessManager {
  name = 'chess';
  // Scene-scoped (single-scene game): the LLM download in init() is expensive,
  // so it must wait for the chess scene to actually load — NOT fire just because
  // the editor registered every game's systems up front.
  scope = 'scene' as const; scenes = ['chess'];
  actions = {
    'chess.newGame':    () => this.newGame(),
    'chess.boardClick': ({ payload }) => this.boardClick(payload),
  };
  init()   { this.startLLMDownload(); }
  dispose(){ this.cancelLLM(); }
  handleAITurn() { /* … */ }   // called from the move callback
  newGame()      { /* … */ }
}
export const chessManager = new ChessManager();
```

## Write side & read side: the two registries

Managers and Systems expose their surface to UI through two symmetric registries.

- **Write side — `actionRegistry`** (exists today). Named *actions* UI can call.
  `UIAction` bindings `kind:'call'` dispatch them. Owned by the
  Manager/System that registers them; gated by `isSimRunning()`.
- **Read side — `readSourceRegistry`** (new). Named *values* UI can bind.
  `registerReadSource(name, getter)` / `unregisterReadSource(name)`. The binding
  resolver (`bindingResolver.ts`) resolves `{name}` against **store state first,
  then registered getters**. No per-frame projection — values are read live at
  resolve time.

```ts
// any Manager, in init()
registerReadSource('timeSinceGameStart', () => timeManager.timeSinceGameStart);
registerReadSource('canGoBack',          () => navigationManager.canGoBack);
```

This is why we avoid copying Manager-derived values into a store via a per-frame
projection (option A) — it would re-introduce the exact poller smell we're
removing. The read-source registry keeps "values reach UI without a tick" and
generalizes: a Back button binds `disabled={!canGoBack}`; a HUD binds
`Time: {timeSinceGameStart}`; a score manager registers `{score}`.

## Engine-global Managers

Engine built-ins are the one thing outside the per-game manifest — registered
once at core startup (alongside `registerEngineActions`, in `app/ecs/register.ts`).
Every game inherits them.

### NavigationManager

The actual gap that started this design: navigation logic was scattered across
`engine.loadScene` (engine action), `scene-selector/init.ts` (its *own*
`navigateBack`/`selectGame`), and `App.tsx` hash routing — with **no back-stack
anywhere**.

`NavigationManager` owns the history stack (the missing piece — `back()` needs
it) and exposes `loadScene` / `back` / `canGoBack` / `replace`. It backs onto
`SceneManager` (which owns transitions). Built-ins become thin wrappers:

- actions: `engine.loadScene`, `engine.navigateBack`
- read source: `canGoBack`

`scene-selector` stops re-implementing `navigateBack` — it uses the engine
built-in.

### Time (System + Manager)

Time is the canonical case of a feature that is **both** roles, and they compose
rather than compete:

- **`timeSystem` (System, unchanged)** — advances one monotonic, pause-aware
  `Time.elapsed` every frame. The single source of "now"; every other system
  depends on it, so it is **never reset**.
- **`TimeManager` (Manager, new)** — captures event **anchors** (offsets into
  `elapsed`) and exposes derived reads. No tick.

```ts
class TimeManager {
  private anchors = new Map<string, number>();
  private now() { return getTime().elapsed; }              // pause-aware clock (System)

  init() {
    onPlayStateChange(s => { if (s === 'playing') this.mark('gameStart'); });
    onWorldSwap(() => this.mark('sceneLoad'));              // re-anchors every scene swap
  }

  // ── generic layer (open-ended; games invent their own) ──
  mark(name: string)      { this.anchors.set(name, this.now()); }
  timeSince(name: string) { return this.now() - (this.anchors.get(name) ?? this.now()); }

  // ── fixed accessors (sugar over the generic layer; never duplicate state) ──
  get deltaTime()          { return getTime().delta; }
  get timeSinceGameStart() { return this.timeSince('gameStart'); }
  get timeSinceSceneLoad() { return this.timeSince('sceneLoad'); }
}
```

Properties that fall out for free:

- **Anchors are offsets, never resets** — `timeSinceX = elapsed − anchorX`, so
  adding game-start time can't perturb rotate3D/animation.
- **Pause / editor Play-Stop work without special-casing** — derived from the
  already-pause-aware `Time.elapsed`; the `'playing'` transition re-stamps
  `gameStart`.
- **Generic + fixed both ship** — `mark('levelStart')`/`timeSince('levelStart')`
  gives games arbitrary stopwatches with zero new systems or traits; the fixed
  accessors let UI bind `{timeSinceGameStart}` without knowing a magic string.

The general lesson: **a System maintains a base quantity each frame; a Manager
captures event anchors and exposes the derived API on top of it.** Same shape
recurs — physics System integrates / Manager `raycast()`; animation System
advances / Manager `play(clip)`.

## The manifest model

`setup.ts` becomes a pure manifest — it declares *what* a game has, never *how it
behaves*. `init.ts` is deleted; its logic moves into named Manager singletons.

```ts
// space-console/setup.ts — wiring only, zero logic bodies
registerSystems([cameraDistanceSystem, stripeTimeSystem, shipShakeSystem, engineFlameSystem]);
registerManagers([cameraManager]);     // owns setCameraDistance action + debugStore writes
registerShaders([stripes, matcap, planet]);
```

| Today (scattered) | After (owned) |
|---|---|
| `chess/init.ts`: `handleAITurn`/`newGame`/`handlePlayerChat` + ad-hoc `registerUIAction` | `ChessManager` (scene scope) — methods + `actions` map |
| `scene-selector/init.ts`: private `navigateBack`/`selectGame` + `spawnGameCards` | nav → engine `NavigationManager`; cards → `SceneSelectorManager` (scene scope) |
| `space-console/setup.ts`: inline `setCameraDistance` closure | `CameraManager` owns it |

The final shape: three tiers, each with one obvious home.

- **System** (ticks) → `registerSystems`
- **Manager** (events; scene/game scope) → `registerManagers`
- **Engine Manager** (global) → registered by core once

## Decision log

1. Five roles are fine — don't force two.
2. Manager is first-class and **symmetric to System** (`registerManager`, owned
   actions, `init`/`dispose`).
3. Manager scope **defaults to scene**, **game-scoped is opt-in**.
4. **SceneManager owns** Manager lifecycle (rides the existing swap sequence).
5. Manager = plain **singleton**; method access by direct import, not a locator.
6. Engine built-in Managers (`NavigationManager`, `TimeManager`) registered
   **once at core startup**.
7. `setup.ts` = manifest; `init.ts` deleted; logic lives in named Managers.
8. Navigation is a **Manager**, backed by SceneManager, owning the **history
   stack**; `scene-selector` drops its private `navigateBack`.
9. Time = **`timeSystem` (System) + `TimeManager` (Manager)**; anchors are
   offsets into a never-reset `elapsed`.
10. TimeManager ships **generic anchors (`mark`/`timeSince`) with fixed accessors
    on top**.
11. UI reads Manager values via a **read-source registry** (option B) — the
    read-side mirror of `actionRegistry` — not a per-frame store projection.
