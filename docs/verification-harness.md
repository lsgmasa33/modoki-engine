# Verification Harness — Design & Plan

> The #1 Claude-friendliness lever: letting Claude **verify game logic it wrote**,
> without a human engineer in the loop.
>
> **Status (build progress):**
> - ✅ **Phase 0** determinism guard · ✅ **Phase 1** time-system redesign (injectable
>   clock, `timeScale`, `getSimDelta`/`getVisualDelta`, skeletal fix; later collapsed
>   to the minimal Unity-style `delta`/`smoothedDelta`/`timeScale` set) · ✅ **Phase 2**
>   seeded RNG · ✅ **Phase 3** event journal · ✅ **Phase 5** `createTestWorld`
>   harness core (spawn + systems/actions + step/dispatch/events/trait/query, with
>   `dispose()` isolation) · ✅ **Phase 6** the live-tier MCP surface —
>   `modoki_play_control` `step` (advance one frame while paused),
>   `modoki_journal` (events), `modoki_dispatch_action` (+ `modoki_list_actions`),
>   `modoki_set_timescale`, `modoki_watch`.
> - ⏳ **Phase 4** — still open, but narrowed: the *intent-dispatch surface* already
>   ships at the MCP layer (Phase 6 `modoki_dispatch_action` + `modoki_list_actions`,
>   routing through the action registry). What remains is (a) generalizing the
>   **engine-level** `dispatchUIAction` into a UI-independent `dispatch(intent, payload)`
>   and (b) **real-scene-FILE loading** in `createTestWorld` (it composes a world from
>   `spawn`/systems today, not by loading a scene `.json` headless). Both pair with the
>   first real game — the actual intents/events + headless-registerable game traits.

## Why

Modoki's logic is (and will stay) **TypeScript systems** — no visual scripting.
That makes verification *more* important, not less: code has subtle bugs that
scene-validation can never catch. Today Claude can verify a **scene** edit
(`get_scene_state` + `capture_viewport` prove a value changed and renders) but
has **no way to verify behavior** — "tap the chest → gold += 10 → win fires."

The harness turns logic verification into a **fast, deterministic, headless loop
Claude drives itself**: write system → write scenario → run → read a structured
trace → fix. The editor/MCP is reserved for the *visual/feel* check a human does
by eye. This matches the existing rule that Claude judges correctness (asserts),
humans judge feel (capture).

### Goals
- Deterministic, reproducible runs (fixed dt + seeded RNG).
- Headless execution (logic systems only, no GPU) — millisecond loop in vitest.
- Semantic observability — an **event journal** of *what happened*, not just end state.
- Semantic input — fire game intents by GUID/name, not fragile pixel taps.
- Scenarios that **double as regression tests** (`npm test`).
- A live tier (modoki MCP) for integration + the one thing headless can't give: pixels.

### Non-goals
- Visual scripting / behavior graphs (explicitly rejected).
- Replacing the editor's interactive Play/Pause (we extend it, not replace it).
- Verifying *feel* (timing, juice) — that stays a human capture-and-watch task.

## What already exists (the seams)

The bones are mostly here — this is "make 3 things injectable + add 1 new thing,"
not "build a harness from scratch."

| Need | Existing seam | File |
|------|---------------|------|
| Centralized time | `Time` trait (`delta`/`elapsed`/`smoothedDelta`/`frame`) | `runtime/traits/Time.ts` |
| Clock source | `timeSystem` — module-global `let lastTime = performance.now()` | `runtime/systems/timeSystem.ts` |
| Single-step | `Paused` trait + `stepOneFrame` (editor step button) | `runtime/rendering/frameDriver.ts`, `timeSystem.ts` |
| Sim on/off gate | `playState` — `getPlayState/setPlayState/isSimRunning` | `runtime/systems/playState.ts` |
| System ordering / registry | `registerSystem(name, fn, priority, {actions})`, `runPipeline(world)` (skips TIME/GAME/ANIMATION when `!isSimRunning()`) | `runtime/systems/pipeline.ts` |
| Named-input dispatch (spine for intents) | `dispatchUIAction(name, {targetGuid,...})`, `actionRegistry` | `runtime/ui/actionRegistry.ts` |
| Headless scene load | `loadSceneFile({ world })` — already takes a target world | `runtime/loaders/loadSceneFile.ts` |
| World management | `getCurrentWorld`, `registerEntity` | `runtime/ecs/world.ts` |
| Logic/render split | logic = koota systems; render = `Renderable*` + `Scene3D`/`Scene2D` | — |

What's **missing**: (1) an injectable clock + a **`timeScale`** concept (today
`performance.now()` is hard-wired in `timeSystem`, and `Time` has no scale field at
all), (2) a seeded RNG service (today `Math.random` is used directly in `ChessAI`,
`ChessManager`, `animationCycle`, `DebugMenu`), (3) an **event journal**, (4) a thin
`createTestWorld` harness + MCP step/events surface.

### Time-source audit (done) — one real offender + two design gaps
A sweep of every per-frame motion source found:

| System | Time source today | Status |
|--------|-------------------|--------|
| Keyframe animation (`animationSystem`) | `Time.smoothedDelta`, in pipeline | ✅ Time-driven |
| Particles (`syncParticles`) | `Time.delta`, **render phase** (not pipeline) | ✅ clock-correct, render-coupled |
| `rotate3DSystem` | `Time.smoothedDelta`, in pipeline | ✅ Time-driven |
| **Skeletal anim** (`scene3DSync.ts` → `mixer.update`) | **its own `performance.now()` delta** | ❌ **offender** |

Consequences that drive the Phase 1 redesign below:
- **Skeletal bypasses `Time` entirely** (`scene3DSync.ts:636-642`) — so it ignores Pause
  (skeletal characters keep animating while the game is paused) *and* can't be stepped
  deterministically. This is a live bug, not just a determinism gap.
- **No `timeScale`** — there is no engine concept of game-time control, so pause / slow-mo /
  bullet-time / a **time-stop superpower** are unimplementable except by ad-hoc game code.
  The `Paused` path zeroes `delta` but `return`s **before** updating `smoothedDelta`, leaving
  it stale — so any system on `smoothedDelta` doesn't actually freeze under the `Paused` trait.
- **Smoothing vs. time-control are conflated.** `smoothedDelta` is an EMA (lags by design).
  Baking time-control into it would make a time-stop *coast to a halt* over ~10-20 frames.
  Smoothing must be separated from scaling (Phase 1).

## The five pillars

1. **Determinism** — injectable clock feeding `Time`; a first-class `timeScale`; seeded RNG service.
2. **Observability** — engine event journal systems `emit()` to.
3. **Semantic input** — generalize `dispatchUIAction` to gameplay intents.
4. **Headless execution** — world + logic systems only, no renderer.
5. **Scenarios = tests** — harness API used from vitest; a passing scenario is the regression test.

## Phased plan

Each phase is independently shippable and testable. **Phase 0 + 1 + 2 are the
"do it before the first real game" conventions** — retrofitting determinism into
50 systems later is the expensive path.

### Phase 0 — Conventions + guards (cheap now, ruinous later)
- Rule: **nothing reads wall-clock time directly** — no `performance.now()`/`Date.now()` for
  motion. All per-frame time comes from the `getVisualDelta`/`getSimDelta` accessors (Phase 1).
- Rule: **all gameplay randomness routes through the seeded RNG service** (Phase 2).
- Rule: **anything worth asserting gets an `emit()`** (Phase 3).
- Add a vitest/lint guard: grep-style test failing on `performance.now()`/`Date.now()`/
  `Math.random()` anywhere under `runtime/**` — **including render/sync code** (this is what
  would have caught the skeletal-mixer bug). Use an *explicit, reviewed* allowlist, not a
  silent pass — every entry is a deliberate exception.
- **Deliverable:** `docs` rule + one guard test. No runtime change.

### Phase 1 — Time-system redesign: injectable clock + `timeScale` + smoothing split
This is the front-loaded redesign that folds together determinism, game-time control
(pause / slow-mo / time-stop), and the skeletal-mixer fix. The current `timeSystem`
conflates raw delta, smoothing, and pause; we separate the three concerns.

**1a. Injectable clock.** Extract the wall-clock from `timeSystem` into a `clock` provider:
`realClock` (wraps `performance.now()`, keeps `MAX_DELTA` clamp) and `manualClock` (test sets
`rawFrameTime` explicitly, fixed-dt). `timeSystem` reads `clock.raw()` instead of computing
from `performance.now()`.

**1b. First-class `timeScale` (separate smoothing from scaling).** Add `timeScale` to the
time system. Compute three distinct values per frame:
```
smoothedCadence = EMA(rawFrameTime)        // jitter smoothing only — tracks hardware, always
simDelta        = rawFrameTime    * timeScale   // gameplay: raw/exact
visualDelta     = smoothedCadence * timeScale   // presentation: smooth
```
- **Pause / time-stop = `timeScale = 0`** → both deltas hit 0 *instantly* (smooth × 0 = 0), so
  a time-stop is crisp, not coasting. Slow-mo = 0.3, bullet-time/fast-fwd = 2, etc.
- The cadence EMA keeps tracking real hardware frame time even while paused, so un-pausing is
  smooth with no catch-up spike.
- **Delete the `Paused` early-return** in `timeSystem` — pause is now just `timeScale = 0`,
  applied uniformly by the multiply. (The editor Pause button sets an *editor* scale factor
  layered on top of game `timeScale`: `effective = gameTimeScale × editorPauseFactor`, so the
  dev tool and an in-game power don't fight over one flag.)

**1c. One accessor seam — `getVisualDelta` / `getSimDelta`.** Every per-frame consumer routes
through these (most already do via `readDelta`/`getTime`):
- **Visual layer** (smoothed): keyframe anim, **skeletal**, particles, `rotate3D`, procedural
  wobble, NPR shader time → `getVisualDelta`.
- **Gameplay layer** (raw/fixed): movement, timers, win conditions, physics → `getSimDelta`.
  Smoothing is presentation-only; gameplay on a lagging EMA would drift and break determinism.
- **Fix skeletal here:** swap `scene3DSync.ts` `mixer.update(dt)` from its own `performance.now()`
  delta to `getVisualDelta(world)`. This fixes Pause-respect (live bug) + determinism in one move.
- Note: today's `Time.smoothedDelta` *field* is replaced by `getVisualDelta`'s `smoothedCadence ×
  timeScale` — call sites switch to the accessor, not the raw field.

**1d. Deterministic step.** Build `step(world, ticks, dt)` on the existing `stepOneFrame`
machinery: set `manualClock` rawFrameTime, run `runPipeline(world)` N times. Under `manualClock`
with fixed dt, `EMA(constant) = constant`, so `visualDelta == simDelta` and runs reproduce exactly.

- **Deferred (don't build speculatively): selective / multi-clock time.** A canonical time-stop
  freezes enemies but the *player still moves* — a single global `timeScale` can't express that.
  When a real time-stop mechanic is designed, add either named clocks (world vs. player) or a
  per-entity `LocalTimeScale` multiplier. The `getVisualDelta`/`getSimDelta` accessor is built to
  take an optional clock-id later **without touching call sites** — that's why everything funnels
  through it now.
- **Deliverable:** `timeScale` (pause/slow-mo/time-stop all work), skeletal respects Pause,
  `step()` advances a world by an exact amount with no wall-clock. Unit tests for each.

### Phase 2 — Seeded RNG service
- Add `rng` service (e.g. mulberry32/xoshiro) with `seed(n)`, `next()`, `int(a,b)`, `pick(arr)`.
- Replace the ~4 existing `Math.random` sites (`ChessAI`, `ChessManager`, `animationCycle`,
  `DebugMenu`) with `rng.*`. (Doing it now = 4 edits; later = dozens.)
- `createTestWorld({ seed })` seeds it per-run.
- **Deliverable:** seeded RNG; existing games reproducible; guard from Phase 0 enforced.

### Phase 3 — Event journal
- Add `journal` service: `emit(type, payload)` appends `{ tick, type, payload }`;
  `drain()`/`events(filter?)` reads; cleared per-run and per-step-window.
- Tick stamp comes from `Time.frame`. Mirror the `actionRegistry` shape (named-output
  events as the counterpart to named-input actions).
- Wire the editor Console to also show the journal (free debugging win for humans).
- Game systems call `emit('match', {...})`, `emit('score', {delta,total})`, `emit('win')`.
- **Deliverable:** ordered, tick-stamped event trace readable headless + in editor.

### Phase 4 — Semantic dispatch (game intents)
- Generalize `dispatchUIAction` beyond UI into `dispatch(intent, payload)` addressable
  by GUID/name (it already targets by `targetGuid`). UI buttons remain one producer of
  intents; tests/MCP become another.
- Keep `modoki_tap`/`modoki_drag` for the *layout + hit-test* path; `dispatch` is the
  *rule* path (layout-independent, deterministic).
- **Deliverable:** `dispatch('swap', {from,to})` fires the same handler a button would.

### Phase 5 — `createTestWorld` headless harness + vitest
- `createTestWorld({ scene, seed, systems? })`:
  - fresh koota world (not `getCurrentWorld`); `loadSceneFile({ world })` (already supported);
  - register the game's logic systems (via its `GameDefinition.registerSystems()`),
    **render systems excluded** (no Three/Pixi);
  - install `manualClock` + seeded `rng` + fresh `journal`; `setPlayState('playing')`.
- API: `game.step(n, dt?)`, `game.dispatch(intent, payload)`, `game.events(filter?)`,
  `game.trait(Trait, entity)`, `game.query(...)`, `game.setTimeScale(scale)`.
- **Risk to solve here:** `registerSystem` uses a **module-global** `systems[]` array — two
  headless worlds in parallel share it. Options: (a) reset/scope the registry per
  `createTestWorld` (serialize), (b) make the registry world-keyed. Pick (a) first
  (vitest `--no-threads` or per-file isolation), revisit if too slow.
- **Deliverable:** Claude writes a `*.playtest.test.ts`, runs `npm test`, reads trace on fail.

### Phase 6 — Live tier (modoki MCP)
- Add MCP tools over the IPC bridge: `modoki_step(n)`, `modoki_events(filter?)`,
  `modoki_dispatch(intent, payload)` (pairs with existing `modoki_tap`/`capture_viewport`).
- Backed by Phase 1/3/4 in the live world; `modoki_step` uses Pause+manualClock so the
  human can freeze, step, inspect the journal, then capture.
- **Deliverable:** integration check in the real composited Electron app + the pixel check.

## API sketch

**Headless (workhorse):**
```ts
// NOTE: `scene` (real scene-FILE loading) is NOT yet supported — a Phase 4 follow-up, and
// silently ignored by CreateTestWorldOptions today. The landed harness composes a world from
// `spawn`/`systems`; the `scene` field below is illustrative of the intended end state only.
const game = createTestWorld({ scene: 'games/match3/scenes/level1.json', seed: 42 })

game.dispatch('swap', { from: tileA, to: tileB })   // semantic intent, layout-independent
game.step(1)                                          // exactly one logic tick, fixed dt

expect(game.events()).toContainEqual({ type: 'match', color: 'red', count: 3 })
expect(game.trait(Score, scoreEntity).value).toBe(30)

game.step(60)                                         // 1s of gravity/refill at fixed 60fps
expect(game.events({ type: 'spawn' })).toHaveLength(3)
expect(game.phase()).toBe('playing')
```
In a system: `emit('match', { color, count: tiles.length })`.

**Live (integration + feel):**
```
modoki_dispatch('swap', {from, to})   // or modoki_tap for the real hit-test path
modoki_step(60)                        // pause + step the live world deterministically
modoki_events({ type: 'win' })         // read the journal over the IPC bridge
modoki_capture_viewport()              // does it LOOK right — the human's call
```

## Risks & open questions
- **Global system registry isolation** (Phase 5) — biggest one; serialize tests first.
- **Determinism discipline** — only works if Phase 0 rules hold; the guard test is load-bearing.
- **Particles are render-phase, not pipeline** — they read `Time` (so `timeScale`/pause work) but
  won't run headless (no `Scene3D`). That's fine: particles are cosmetic. Make the *gameplay-relevant*
  signal ("explosion fired") a journal `emit()` from a pipeline system, and keep particle *motion*
  render-side, human-verified by capture. Don't drag a renderer into headless tests.
- **`smoothedCadence` EMA seeding** — first few frames of a live run differ from steady state; seed
  `smoothedCadence = rawFrameTime` on frame 0 (current code already special-cases frame 0). Under
  `manualClock` fixed-dt this is a non-issue (EMA of a constant = the constant).
- **"What is a semantic event?"** — start minimal (score/match/spawn/win/lose/phase-change);
  let real mechanics pull more. Don't pre-design the taxonomy.
- **Selective / multi-clock time is deferred** — global `timeScale` only; a player-moves-in-frozen-time
  power needs named clocks or per-entity `LocalTimeScale` (Phase 1d). Accessor is built to absorb it later.
- **Float determinism across machines** — fine for same-machine CI; note it if cross-machine
  replay is ever needed.
- **Manager systems** (`managerRegistry`, `TimeManager`) — confirm they route time/RNG through
  the `getVisualDelta`/`getSimDelta` accessors, or they'll desync headless runs and ignore `timeScale`.

## Recommended sequencing
Land **Phase 0–2 before writing the first real mechanic** (cheap now, miserable to
retrofit). Phase 1 in particular is worth doing first on its own merits — it isn't just
test plumbing, it ships **pause / slow-mo / time-stop as real engine features** and fixes
the live skeletal-on-pause bug, while making determinism fall out for free. Then 3 → 5
gives Claude the full headless self-correction loop. Phase 4 and 6 follow once the first
real game exists and surfaces the actual intents/events worth wiring — don't speculate
the taxonomy ahead of a real mechanic.
