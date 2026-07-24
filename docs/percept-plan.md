# Percept — Modoki's AI Perception Layer (Plan)

> **Status:** ✅ **v1 complete — all 7 phases shipped, tested, adversarially reviewed,
> committed** (`7856013b`→`5ff3cef0` on `work-ai`). This file is now the rollout tracker +
> v2 backlog. The per-phase sections below are kept as the as-built record (each phase is
> marked ✅ with its deferrals). Remaining work lives in **§ v2 backlog** immediately below.
> Follow-up: fold the stable surface into a `docs/percept.md` *reference* (user-facing "what
> the tools are"), leaving this as the *tracker*.

## v2 backlog (what's left)

Consolidated from the per-phase "deferred" notes. Ordered by value.

| # | Item | Why it matters | Where | Size |
|---|---|---|---|---|
| ~~**V1**~~ ✅ | ~~**Structured `!edit` payloads**~~ **DONE** — `detail: {trait, field, entities[guid], old[], new[]}` (index-aligned arrays) on `UndoAction`, populated in the `entityActions.ts` write chokepoint, forwarded by the `!edit` tap (snapshot-frozen at emit); `!undo`/`!redo` echo it. `detail.new` = value at first commit (exact for discrete edits; a drag reports its first frame → final is live in scene-state). Compound multi-field edits (SpriteAnimator clip/track) are label-only. Adversarially reviewed (7 agents): killed two coalesce bugs — the since-cursor miss + per-entity misalignment — by dropping the shared-object aliasing for a frozen snapshot. | The headline collaboration USP ("I see you zeroed gravity on 3 of 8 crates") — now machine-readable, not just a label. | `undoManager.ts`, `entityActions.ts`, `editorJournal.ts` tap, MCP desc | M |
| ~~**V2**~~ ✅ | **More editor taps** — DONE: first-class `!create`/`!duplicate`/`!delete`/`!reparent` (via `UndoAction.kind` + `journalPayload`, GUID-addressed), `!scene-load`/`!save` (serialize.ts), `!gizmo` (editor store, change-guarded), **and `!transform`** (V2b — gizmo-drag commit carries `{entity, before, after}` TRS via `buildTransformUndoAction(entityGuid)`, both 2D + 3D gizmos). Adversarially reviewed (5 agents): fixed a source-guid mint leak + un-guidable-repr inconsistency. Live-verified all sigils incl. a real gizmo drag → `!transform {entity, before:{y:0}, after:{y:0.30}}` source:human. | Completes the human-activity vocabulary; gizmo transforms are the primary spatial-authoring action. | entityActions/undoManager/serialize/editorStore/gizmoUndo/SceneView | M |
| ~~**V3**~~ ✅ | **True single-axis merged timeline** — DONE: a shared process-global `cap` capture counter stamped by BOTH `journal.ts` emit (game) and `editorJournal.ts` editorEmit (editor); the `editor-journal` merged read returns a `timeline` interleaving both streams by `cap`, each `stream`-tagged, windowed by its own `sinceCap` cursor. Reset on `createTestWorld.dispose`. Adversarially reviewed (9 agents): determinism concerns REFUTED (cap never feeds game state / no test asserts absolute cap); fixed the confirmed finding (timeline spliced the ENTIRE unfiltered game journal on a `since` poll → added the `sinceCap` single-axis cursor windowing both streams). | The "pressed Play → set timeScale 0.3 → `@match` on tick 84 → paused" correlated story. | `journal.ts`+`editorJournal.ts`+`createTestWorld.ts`+`agentEditorOps.ts`+backend+MCP | S–M |
| ~~**V4**~~ ✅ | **Physics event GUIDs** — DONE: `@contact` (2D + 3D) payloads now use `entityRef(a.entity)`/`entityRef(b.entity)` → stable GUIDs (numeric-id fallback for un-guidable entities). `@collision`/`@sensor` turned out not to be journal-emitted (only `@contact` is), so nothing else to convert. | Cross-hot-reload-stable correlation of physics events (the last Percept ref that leaked numeric ids). | `physics2DSystem.ts`/`physics3DSystem.ts` emit sites | S |
| ~~**V5**~~ ✅ | **Snapshot world-AABB size** (S6 leftover) — DONE: the Scene3D bounds provider now surfaces the world-space AABB it already computes as `worldAABB {size, center}` (previously discarded); folded into `get_scene_state?bounds=1` alongside the screen rect. Unit-verified (collectScreenBounds passthrough). NOTE: rides the SAME runtime Scene3D bounds provider as the S6 3D screen rect, which is only active where runtime Scene3D renders the queried world (shipped game / configured GameView) — NOT the editor-SceneView authoring context, where 3D bounds have never surfaced (pre-existing, orthogonal to V5). A follow-up could register an editor-SceneView bounds provider to fix 3D bounds in the authoring view. | Claude gets true world size, not just screen rect or authored intent. | `screenBounds.ts`/`Scene3D.tsx`/`layoutDump.ts`/`agentBridge.ts` | S |
| **V6** | **`debug\|profile\|release` mode enum** (Decision D) — replace the `enableJournal` boolean (since consolidated into `build.debugBuild`, shared with the debug menu/bridge) once a profiler gives "profile" a second consumer. | Not worth building the taxonomy until there's a real second consumer. **Keep deferred** — leave the TODO. | `project.config.json`, `main.tsx` define | — (blocked) |

**Status:** V1–V5 ✅ **all done** (V2 incl. V2b `!transform`). **Only V6 remains — deferred by
design** (the `debug|profile|release` mode enum, blocked until a profiler gives "profile" a
second real consumer; the `build.debugBuild` boolean + TODO ship in its place). The Percept
system is feature-complete for v2. Follow-ups:
- ✅ **editor-SceneView bounds provider DONE** — 3D `screen`/`worldAABB` now surface in the
  authoring view (regular AND skinned meshes; live-verified: the alien reports size
  `[0.91, 1.02, 2.0]` + a real screen rect).
- ✅ **queryable current-contacts readback DONE** — `get_scene_state?contacts=1` reports each
  body's live `contacts` (solid) + `overlaps` (sensor) as GUIDs, rolled up to bodies,
  refcounted, from a per-world incremental index maintained off the shared enter/exit path.
  Adversarially reviewed (9 agents) — caught 4 real bugs (compound-despawn / reparent roll-up
  asymmetry, zero-body early-out leak, isSensor-toggle mis-bucket); fixed the majors via
  `dropBodyFromIndex` (force-clear by body identity on removal) + live-update on the drain path
  only; #4 documented as a bounded known limitation. Live-verified on 2d-physics-demo: a settled
  stack reports symmetric contacts; Table/Cross/Dumbbell compound bodies each report exactly one
  floor contact (roll-up + refcount).
- Remaining small ones: the runtime Scene3D bounds provider covers only `ecsObjects` (skinned-mesh
  parity so shipped games report skinned bounds too); a lighter `bounds=1` path (skip the O(n²)
  overlap work it discards).

## What Percept is

**Percept is how an AI agent (Claude) perceives a running Modoki game the way an SRE
perceives a live service — through numbers and events, not screenshots.** Claude is weak
at judging visual feel from a static image; it is strong at reasoning over structured
data. Percept is the engine's commitment to *always give it the data*.

It is a **key USP**: most engines are built to be seen by a human through a viewport.
Modoki is additionally built to be *read by an agent* through a stable, queryable surface.

Percept has three primitives, deliberately separated because they answer different
questions and have different shapes:

| Primitive | Question | Producer | Cadence | Tool(s) |
|---|---|---|---|---|
| **Snapshot** | "what is true *right now*?" | pull | on-demand | `modoki_get_scene_state`, `get_layout_bounds`, `diagnose`, `get_editor_state` |
| **Journal** | "what *happened*, in order?" | push (game/engine `emit`) | sparse, discrete | `modoki_journal` |
| **Watch** | "how did this *number* move over time?" | pull (Claude configures) | dense but focused | `modoki_watch` *(new)* |

This maps onto the classic "three pillars of observability" — Snapshot≈state/inventory,
Journal≈logs, Watch≈metrics/traces — but built for an AI consumer instead of a human
dashboard.

### Two subjects: the game world *and* the editor session

The three primitives apply to **two subjects**:

- **Game world** (runtime) — the sections above. What the *simulation* is doing.
- **Editor session** (authoring) — what the *human collaborator* is doing. `get_editor_state`
  already *is* the editor's Snapshot; Phase 7 adds the editor's **Journal** (a human-activity
  stream), and Watch falls out for free (point it at editor state).

This second subject is what makes Percept about the **collaboration**, not just the game —
Claude perceives its human partner's actions, not only the world. See §4 (Editor Percept).

### Percept vs the Verification Harness

Keep these distinct (they share the journal but serve different masters):

- **Verification Harness** (`docs/verification-harness.md`) — *headless + deterministic*.
  `createTestWorld`, `stepSimulation`, seeded RNG, the journal-as-assertion-substrate.
  Runs in CI with no renderer.
- **Percept** (this doc) — *live + interactive*. Perceiving a **running** editor/game over
  the agent bridge. Snapshot + Watch are live-world observers; Journal is the shared piece.

---

## Architecture (shared plumbing)

Every Percept read/write already flows through one 4-hop chain (confirmed in audit):

```
MCP tool (engine/tools/modoki-mcp/src/index.ts)
  → HTTP getJson/postJson to MODOKI_BACKEND
    → editorBackendRouter handler (engine/plugins/backend/editorBackendRouter.ts)
      → ctx.requestBrowser(op, params)   [Vite HMR socket in dev / Electron IPC in DMG]
        → agentBridge op registry (registerAgentOp, engine/app/debug/agentBridge.ts)
          → op handler reads live ECS/editor state → JSON-serializable result
```

- Runtime-only ops register in `agentBridge.ts`; editor-only ops inject at editor startup
  from `agentEditorOps.ts` (`registerEditorAgentOps`).
- Dev = Vite HMR socket; packaged DMG = Electron IPC. **Same op registry → dev/DMG parity.**
- Result must be structure-clone-safe; whatever the op returns is forwarded verbatim.

**Percept adds no new transport.** Snapshot improvements extend existing ops; Watch adds a
new editor-only op (`watch-*`) + MCP tool. This is why Watch is low-risk: it is a pure
observer riding plumbing that already works in both dev and the DMG.

---

## Cross-cutting decisions (apply across all three)

1. **GUID, never runtime `id`.** Runtime numeric entity ids are reassigned on every scene
   hot-reload (CLAUDE.md "Addressing entities across hot-reloads"). Any Percept payload that
   *references* an entity for later correlation must use its GUID. This affects journal
   payloads (convert via the exported `entityRef(entity)` helper), Watch targets
   (GUID-addressed), and a fix to `capture_gesture` (currently takes numeric `sampleEntityId`,
   `index.ts:750`). *Snapshot may keep `id` for in-call convenience but should also always
   carry `guid`.*
   **Gotcha (learned in Phase 1 review):** conversion must be EXPLICIT at the call site, not
   auto-applied inside `emit`. koota entities are primitive numbers with methods on
   `Number.prototype`, so a bare entity handle is indistinguishable from an ordinary scalar
   (a `score`, a coordinate). Auto-probing every payload number with `has(EntityAttributes)`
   silently rewrites scalars that collide with a live entity index into that entity's GUID —
   corrupting the trace. Hence `entityRef()` is called where the caller knows the value is an
   entity.

2. **`@`-sigil marks engine-authored events.** Engine-emitted journal events get an `@`
   prefix (`@spawn`, `@anim-start`); bare names are game-authored. Self-documents provenance
   to Claude and makes collisions impossible. Existing physics events
   (`contact`/`collision`/`sensor`) rename to `@contact`/`@collision`/`@sensor` — one
   contained sweep, we own all consumers (tests + docs).

3. **The `Time` trait is the template for surfacing runtime state.** `Time` recomputes
   runtime values every frame and writes them straight onto a resource trait, so
   `scene-state` reports them for free (audit §6, "no gap — the model to emulate"). Prefer
   this pattern (write-back onto a trait) over bolting new fields onto the scene-state dump,
   wherever a value is cheap to mirror.

4. **Production gating is a Percept-wide concern, but only Journal needs runtime code.**
   Snapshot + Watch are editor-only observers (gated by `__MODOKI_EDITOR__`, already stripped
   from shipped game builds). Only the Journal lives in engine runtime (game code `emit`s into
   it), so only the Journal needs an explicit enable gate — see Journal Phase 1.

---

## 1. Snapshot

### Current state (audited)

`modoki_get_scene_state` → `/api/scene-state` → `dumpSceneState` (`agentBridge.ts:258`).
Per entity a BARE call now returns `{ id, guid, name, parentId, layer, traits:[NAMES] }` — an
index, no field values, default `limit` 200 (`DEFAULT_INDEX_LIMIT`, `agentBridge.ts:256`). Any
target (`trait`/`id`/`name`/`where`) or enricher (`full`/`world`/`bounds`/`contacts`) returns
VALUES, serialized via `readTraitData(id, meta)` (`entityUtils.ts:107`). Adjacent snapshot tools:
`get_layout_bounds` (counts by default; rects only with `ids=`/`layer=` — `layoutDump.ts:48`),
`diagnose` (structured causes, `diagnose.ts:23`), `get_editor_state` (selection/play/gizmo/camera,
`agentEditorOps.ts:53`), `get_console_logs` (500-entry ring, `CONSOLE_BUFFER_MAX`
`agentBridge.ts:153`; last-50 + `byLevel` by default), `list_traits`, `list_assets` (both
summary-first). See `docs/mcp-response-budget.md` for the response budget behind these defaults.

### Gaps (the important part — this is where "thorough" pays off)

**G1 — Trait VALUE fidelity (highest priority).** `scene-state` reads via `readTraitData`,
which enumerates **only `meta.fields`** (the curated Inspector subset). AoS/object/array
fields not declared there are **silently dropped**: `AnimationLibrary.animSets/boneMaps`,
`SkinnedMeshRenderer.materials`, `UIAction.onClickSet` (`entityUtils.ts:98-106`). A
`readTraitDataFull` already exists (`entityUtils.ts:107`) but scene-state doesn't use it —
so scene-state and `list_traits`/validation **disagree** about what a component contains.

**G2 — Resolved WORLD transform not surfaced.** Computed every frame into a module-level
`worldTransforms` Map (`three/systems/transformPropagationSystem.ts:9`) — plain numbers,
consumed by every renderer — but it's not a trait, so scene-state shows only *local* TRS.
Claude must compose the parent chain by hand. Cleanest "computable, trivial to surface, not
surfaced" gap. (Same file: `deactivatedEntities` = resolved cascade-inactive state, also
not surfaced; scene-state shows only self `isActive`.)

**G3 — Skeletal animation live state is invisible.** `SkeletalAnimator` is pure *desired*
state; the live mixer state is locked in `SkinnedEntry`/`THREE.AnimationMixer`
(`scene3DSync.ts:301`): resolved active clip (`entry.current`, esp. when authored `clip=''`
falls back to `firstClip`), playhead/normalized time (`action.time`/`clip.duration`), blend
& crossfade weights, effective paused. (2D `Animator`/`SpriteAnimator` *do* carry a `time`
field — inconsistent; skeletal should match.)

**G4 — Rendered SIZE not in scene-state.** True on-screen/world size lives only in the
separate `layout-bounds` op (`layoutDump.ts`); world-space AABB is computed then discarded
(only the screen projection survives). `Renderable2D.width/height` are *authored intent*,
not resolved size. Claude needs a second tool call to learn how big anything actually is.

**G5 — Physics `isSleeping` not mirrored.** Velocity + CharacterController readback ARE on
traits (good), but Rapier's `body.isSleeping()` is never written back — Claude can't tell a
settled body from a stuck one. Current contact set is only available as transient
`journal-events`, not as queryable state.

**G6 — `where` fails silently.** Unknown trait or unparseable expression → predicate is
`null` and the filter is **dropped**, returning a full unfiltered dump with no error
(`agentBridge.ts:63-71, 206-207`). Numeric compares on non-numeric fields coerce to `NaN`
(always false), no diagnostic. Only `meta.fields` are queryable.

**G7 — No size guard / pagination.** ✅ **Addressed** (`docs/mcp-response-budget.md`, Phases 1+3).
Was: scene-state dumped ALL entities incl. resource entities (`entityUtils.ts:309`), no cap, no
truncation flag. Now: the bare call is a names-only index under a default `limit` of 200 (setting
`truncated`/`totalCount` past it), and every MCP result passes a 60,000-char choke point that
degrades to a valid `{elided, bytes, hint, preview}` envelope rather than a severed payload.

### Design

- **G1 fix — full-fidelity trait dump.** Switch `dumpSceneState` to `readTraitDataFull`, OR
  (safer) add an opt-in `?full=1` that includes the AoS/object fields, with a compact default.
  Decision below (open question A). Align `where` to query the full field set too.
- **G2 fix — surface world transform.** Add resolved world TRS to each entity under a
  `world` key (`{ position, rotation, scale }`) read from `worldTransforms`. Also expose
  effective-active (`activeInHierarchy`) from `deactivatedEntities`. Follow the `Time`
  template only if we decide to mirror onto a trait; otherwise compute at dump time (it's
  already a plain-number Map, so dump-time read is trivial and avoids a trait).
- **G3 fix — skeletal readback trait.** Mirror live mixer state onto `SkeletalAnimator` (or a
  sibling readback trait) each frame: `activeClip`, `time`, `normalizedTime`, `weight`,
  `effectivePaused`. Follows the `Time` pattern exactly. This is the single biggest win for
  animation observability and also feeds Watch.
- **G4 fix — fold size into snapshot (opt-in).** Add `?bounds=1` to scene-state that merges
  the `layout-bounds` screen rect (and world AABB size) per entity, so Claude gets geometry
  without a second call. Keep it opt-in (it needs the renderer + is heavier).
- **G5 fix — mirror `isSleeping`** onto the RigidBody trait readback (same site as the
  velocity read-back, `physics2DSystem.ts:741` / `physics3DSystem.ts:707`). Consider a
  queryable `contacts` readback later (lower priority; journal covers the event angle).
- **G6 fix — `where` reports errors.** Return a `warnings[]`/`ignoredFilter` field when a
  predicate fails to parse or names an unknown trait/field, instead of silently returning
  everything. Cheap, removes a silent-wrong-answer trap.
- **G7 fix — truncation flag.** Add an optional `limit` + a `truncated:true` marker and
  exclude resource entities by default (opt-in `?resources=1`).

### Phased tasks (Snapshot)

- **S1.** `where` error reporting (G6) + exclude resource entities by default + `truncated`
  flag (G7). *Small, pure win, no new data.*
- **S2.** Full-fidelity trait values (G1) — the scene-state/validation disagreement fix.
- **S3.** World transform + `activeInHierarchy` in the dump (G2).
- **S4.** Skeletal readback trait (G3) — animation live state. *(Feeds Watch + Journal
  `@anim-*`.)*
- **S5.** `isSleeping` readback (G5).
- **S6.** Opt-in `?bounds=1` folding size/screen-rect into scene-state (G4).

---

## 2. Journal

### Current state

`emit(type, payload, world?)` → per-world ring buffer (`runtime/systems/journal.ts`), read
via `modoki_journal` / `journalEvents`. O(1) push. The J1 gate landed: `main.tsx` boots
`setJournalEnabled(__MODOKI_EDITOR__ || build.debugBuild)` — editor on, shipped game off.
On device, the debug bridge (`app/debug/bridge.ts`) re-enables recording when a debug client
attaches (`connectionChanged`, plus a `getStatus().clientConnected` check at init for the
page-reload-over-a-live-lease case where no reconnect event fires); `journal-events` also
force-enables on read as a belt-and-suspenders. Emitters: engine physics
`@contact`/`@collision`/`@sensor` + lifecycle/animation `@`-events; games emit their own
(e.g. `zone`). `emit` is public via `@modoki/engine/runtime` and used by demo games.

### Design (decided across prior discussion)

1. **Gate (perf).** `setJournalEnabled(__MODOKI_EDITOR__ || build.debugBuild)` at
   `main.tsx` bootstrap. Editor (dev + DMG) → on; shipped game → **off** (kills always-on
   allocation on the physics hot path); QA override via `build.debugBuild?: boolean` in
   `project.config.json`, baked as a Vite define like `appId`. The full
   `debug|profile|release` mode enum is **deferred** until a profiler gives "profile" a
   second real consumer — leave a TODO note, don't build the taxonomy speculatively.

2. **Coverage — engine auto-emits lifecycle events** (all `@`-prefixed):
   - animation: `@anim-start`, `@anim-finish`, `@anim-loop` (from mixer sync in
     `scene3DSync.ts`, keyed off `getPlayState()`); payload carries clip name + normalized
     time.
   - entity: `@spawn`, `@despawn`.
   - scene: `@scene-loaded`, `@scene-swapped` (from `SceneManager`).
   - physics: rename existing `contact`/`collision`/`sensor` → `@contact`/`@collision`/
     `@sensor` (consistency sweep; update `physics*Events.test.ts` + docs).
   Game-specific semantics (`match`/`score`/`win`) stay the game's job — the engine can't
   know them.

3. **Ergonomics + identity.**
   - `ctx.emit(type, payload)` on the UIAction dispatch context, **world pre-bound**
     (removes the wrong-world-in-async-callback trap; the free `emit(type,payload,world)`
     stays for systems).
   - **Exported `entityRef(entity)` helper** → the entity's GUID (or `.id()` fallback for an
     un-guidable entity). Call it at the site where the value is known to be an entity:
     `ctx.emit('zone', { body: entityRef(other) })`. Fixes the `body: other.id()` churn bug in
     the demo games. `emit` stores payloads **verbatim** — it does NOT auto-probe values
     (see the cross-cutting GUID gotcha: koota entities are numbers, so auto-probing corrupts
     scalars). This is the sound realization of the original "auto-convert" intent.

### Phased tasks (Journal)

- **J1.** Gate: bootstrap `setJournalEnabled(...)` + `build.debugBuild` define + TODO for
  the mode enum. *Smallest, immediate perf win, no API change.*
- **J2.** Ergonomics + identity: `ctx.emit`, Entity→GUID auto-convert, fix demo games.
- **J3.** Coverage: `@`-prefixed `@anim-*` / `@spawn`/`@despawn` / `@scene-*`; physics rename
  sweep. *(Depends on J2 for the payload helper; `@anim-*` benefits from S4's readback.)*

---

## 3. Watch (new)

### Concept

A **standing, focused, change-detected numeric time-series** over the live world — the third
primitive, distinct from Journal (sparse semantic events) and Snapshot (point-in-time
state). Answers "how did this number move over time?" (jump overshoot, spring settle, bone
trajectory, velocity decay) — exactly the animation/physics tuning questions Claude can't
judge from a screenshot.

### Why it's separate + low-risk

- Mixing dense per-frame samples into the sparse Journal would destroy the Journal's
  signal-to-noise. Different shape (fixed numeric columns vs heterogeneous payloads),
  different producer (Claude-configured pull vs game-authored push).
- It's a **pure observer** → can live **100% editor-side** as a `registerFrameCallback`
  hook (`frameDriver.ts:36`) reading the live world each frame. **Zero shipped-game cost,
  never touches the determinism-guarded runtime, no game instrumentation.** Works in dev +
  DMG via the same bridge.

### Design

- **Model: standing watch.** `watch-start` opens a focus set; it records-on-change until
  `watch-clear` or auto-expire. A windowed capture is just start→stop. Must have a hard ring
  cap + auto-expire (K frames) so a forgotten watch can't leak.
- **Focus (the anti-flood knobs):**
  1. *Scope* — target by **GUIDs** and/or a **component type** (e.g. all `RigidBody2D`),
     optionally restricted to a **field subset** (`Transform.position` only).
  2. *Change-detection* — record a value only when it changes beyond an `epsilon`
     (a settled object emits nothing; an animating one emits a tight series). This is the
     core flood defense.
  3. *Bounds* — per-watch ring cap + optional decimation (every N frames) + auto-expire.
- **GUID-addressed** (cross-hot-reload stable). Component-type watches must handle entities
  spawning/despawning mid-watch (see open question B).
- **Read: summary stats, series on request.** `watch-read` returns per-field
  `first/last/min/max/delta/settled?` so Claude answers "overshoot/settle?" without eyeballing
  rows. The raw change-filtered series is opt-in via `samples=true` (~40 chars/sample, and the
  caps allow 512 series × up to 5,000 samples). The PRODUCER `readWatch()` always carries
  samples — `WatchTab.tsx` renders them into a Sparkline; only the agent op strips them.
- Fold in a fix to `capture_gesture` to accept a GUID (currently numeric `sampleEntityId`),
  since it's the existing one-off sampler and shares this concern.

### Plumbing

- New editor-only ops in `agentBridge.ts`: `watch-start`, `watch-read`, `watch-list`,
  `watch-clear`. Backed by a frame-hook sampler module (`watch.ts`, editor-side).
- New MCP tool `modoki_watch` (subcommands start/read/list/clear) + backend routes.
- Depends on S4 (skeletal readback) to watch animation numerically; works immediately for
  Transform/physics velocity (already trait-readable).

### Phased tasks (Watch)

- **W1.** Sampler core: editor-side frame hook, GUID + component-type focus, change-detection,
  ring cap + auto-expire. In-memory only.
- **W2.** `watch-*` bridge ops + `modoki_watch` MCP tool + backend routes.
- **W3.** Summary stats (`first/last/min/max/delta/settled`) at read time.
- **W4.** Fix `capture_gesture` to accept GUID; document its relationship to Watch.

---

## 4. Editor Percept (authoring-session observability)

### Concept

Percept turned inward: perceive what the **human** is doing in the editor, not just what the
game world is doing. The headline capability is a **human-activity stream** — an ordered log
of authoring actions (selection, trait edits with old→new values, gizmo transforms, entity
create/delete/reparent, play/stop, scene load/save, undo/redo) — so Claude can pair, assist,
correlate human actions with game events, and reproduce hand-demonstrated bugs.

### Why it's useful + low-risk

- **The collaboration USP.** "I see you zeroed gravity on 3 of 8 crates — want the rest?" is
  only possible if Claude perceives human actions. This is the piece that makes the
  "Claude-friendly editor" real.
- **Unified timeline.** Interleave human actions with game events ("pressed Play → set
  timeScale 0.3 → `@match` on tick 84 → paused") — a correlated stream neither party can
  currently reconstruct.
- **Editor-only observer**, like Watch: taps existing chokepoints, never ships, no runtime
  cost. Most of the log already exists — the undo stack is a labelled human-action history
  (`pushSelectionChange`, `editorStore.ts:279`; `undoManager`).

### What's already there vs new

- **Snapshot (editor):** `get_editor_state` (`agentEditorOps.ts:53`) already reports
  selection, play/gizmo state, camera, undo/redo labels. **Done.**
- **Journal (editor):** **new** — the human-activity stream (this section).
- **Watch (editor):** falls out of Phase 6 — point a Watch at editor state / a UIElement
  trait. No new mechanism; ensure Watch can target UI traits (it's component-type-generic).

*Note:* "value changes of a game UIElement over time" is **game-world Watch** (Phase 6), not
this. This section is specifically the *human authoring* stream.

### Design

- **Separate buffer, merged read (Decision E).** Keep an editor-side activity buffer,
  wall-clock stamped (allowed — it's editor code, not determinism-guarded runtime), exposed
  via `modoki_editor_journal`. Its lifecycle differs from the game journal (editor-only,
  session-scoped, not world-scoped, not production-gated), so it is a *separate* store — but
  a **merged read** interleaves human actions and game events by capture order for the
  unified-timeline view.
- **Provenance sigil `!`.** Extends the journal convention: `@` = engine, bare = game,
  **`!` = human/editor** (`!select`, `!edit`, `!transform`, `!create`, `!delete`,
  `!reparent`, `!play`, `!stop`, `!scene-load`, `!save`, `!undo`, `!redo`). Provenance stays
  legible even in the merged view.
- **Capture commits, not drags (anti-flood).** A gizmo drag = one `!transform` on mouse-up
  with old→new, not 60 frames. Inspector edits commit on blur/enter (the `BufferedTextInput`
  already does this) — tap the commit, not the keystroke. Naturally sparse.
- **GUID-addressed** payloads (like every Percept ref), old→new values on edits.
- **Chokepoints to tap:** `undoManager` push (all undoable edits, already labelled), editor
  Zustand store subscriptions (selection/gizmo/play/camera), Inspector field commit (old→new
  trait value), gizmo drag commit in SceneView, menu/scene/asset commands.

### Phased tasks — see Phase 7.

## Execution phases

All three primitives are in scope. Execution is ordered into **7 shippable phases** (all ✅ done), each a
self-contained, reviewable, independently-verifiable increment. The ordering respects the
dependency spine (payload helper before coverage; skeletal readback before animation
watching) and front-loads correctness/perf wins.

**Ground rule per phase:** land the code + tests, then *verify against the live editor via
the modoki MCP* (not just unit tests) before starting the next. Each phase ends green on
`npm run verify`.

### Phase 1 — Journal hardening *(self-contained; perf + identity correctness)*
- **J1** — Gate: `setJournalEnabled(__MODOKI_EDITOR__ || build.debugBuild)` at `main.tsx`
  bootstrap; `build.debugBuild: boolean` in `project.config.json` baked as the
  `__MODOKI_DEBUG_BUILD__` Vite define. ✅ *Done.* (Mode enum still deferred — Decision D.)
- **J2** — Ergonomics + identity: `ctx.emit(type, payload)` (world pre-bound) + exported
  `entityRef(entity)` helper for stable GUID refs (explicit, call-site — NOT auto-probed;
  koota entities are numbers so auto-probing corrupts scalars). Fix the `body: other.id()`
  bug in the demo games. ✅ *Done — review-hardened (regression test locks the no-auto-probe
  invariant).*
- **Ships:** journal is production-safe (off in shipped games) and identity-correct across
  hot-reloads. **Verify:** `modoki_journal` after a physics collision shows GUID bodies; a
  production build no longer records.

### Phase 2 — Snapshot truth & safety *(stop silent-wrong answers; feeds everything)*
- **S1** — `where` reports parse/unknown-field errors instead of silently returning
  everything (G6); exclude resource entities by default (`?resources=1` to include); `limit`
  + `truncated` flag (G7).
- **S2** — Full-fidelity trait values (G1): scene-state uses `readTraitDataFull` via opt-in
  `?full=1`; `where` and `diagnose` use the full field set **internally regardless**
  (Decision A).
- **Ships:** scene-state no longer disagrees with `list_traits`/validation; bad queries fail
  loudly. **Verify:** `get_scene_state?full=1` shows `AnimationLibrary.animSets`; a bad
  `where` returns a warning.

### Phase 3 — Runtime-state surfacing *(apply the `Time` write-back template)*
- **S3** — Resolved world transform (`worldTransforms`) + `activeInHierarchy`
  (`deactivatedEntities`) per entity (G2).
- **S4** — Skeletal readback trait: mirror `activeClip`, `time`, `normalizedTime`, `weight`,
  `effectivePaused` from the mixer each frame (G3). *Unblocks Phase 4 `@anim-*` and Phase 6
  animation watching.*
- **S5** — Mirror `isSleeping` onto the RigidBody readback (G5).
- **Ships:** world transforms, live animation state, and sleep state all readable in
  scene-state. **Verify:** play an animated rig → `get_scene_state` shows advancing
  `normalizedTime`; a settled body shows `isSleeping:true`.

### Phase 4 — Journal coverage *(engine auto-emits the timeline)*
- **J3** — `@`-prefixed lifecycle events: `@anim-start`/`@anim-finish`/`@anim-loop` (payload:
  clip name + normalized time; `@anim-loop` fires per loop, `@anim-finish` only for
  non-looping clips — Decision C), `@spawn`/`@despawn`, `@scene-loaded`/`@scene-swapped`.
  Rename existing physics events → `@contact`/`@collision`/`@sensor` and update
  `physics*Events.test.ts` + docs.
- **Depends on:** J2 (payload helper), S4 (for meaningful `@anim-*` payloads).
- **Ships:** a semantic timeline with zero game instrumentation. **Verify:** `modoki_journal`
  during playback shows an ordered `@spawn`/`@anim-start`/`@contact` trace.

### Phase 5 — Snapshot geometry *(size in one call)* ✅ *Done*
- **S6** — Opt-in `?bounds=1` folds the `layout-bounds` screen rect (`screen {x,y,w,h}` CSS
  px) + `onScreen` into each scene-state entity (G4). Reuses `computeLayoutBounds`; `null`
  when no provider (non-renderable / not-yet-rendered). Plumbed MCP → backend → dump.
  *Deferred:* the raw **world-AABB size** — the 3D bounds provider computes-then-discards it,
  so there's no plumbed source to fold without a separate change. Note (perf): the reused
  `computeLayoutBounds` also does O(n²) overlap/off-screen work that `bounds=1` discards —
  acceptable since it's opt-in + `limit`-bounded, but a lighter path is possible later.
- **Ships:** Claude gets geometry without a second tool call. Verified live: UI entities get
  real DOM rects, non-renderables return `screen:null`.

### Phase 6 — Watch *(the new third primitive; fully additive, editor-side)*
- **W1** — Sampler core: editor-side `registerFrameCallback` hook; focus by GUIDs and/or
  component type (+ field subset); change-detection (epsilon); ring cap + decimation +
  auto-expire. Component-type watches freeze despawned entities with a `despawned@tick`
  marker and auto-join newly-spawned matches (Decision B). In-memory only.
- **W2** — `watch-start`/`watch-read`/`watch-list`/`watch-clear` bridge ops in
  `agentBridge.ts` (sampler in `watch.ts`) + `modoki_watch` MCP tool + backend routes.
- **W3** — Summary stats at read time (`first/last/min/max/delta/settled` per field).
- **W4** — Fix `capture_gesture` to accept a GUID (`sampleEntityId` → guid); document its
  relationship to Watch.
- **Ships:** numeric time-series tuning for animation/physics feel. **Verify:** watch a
  falling body's `Transform.position`, read back the `settled`/`delta` stats (returned by
  default); pass `samples=true` for the bounded raw series.

### Phase 7 — Editor Percept *(the second subject: the human authoring session)* ✅ *Done (v1)*
**Shipped:** an editor-activity buffer (`editorJournal.ts`, editor-side so it's determinism-
exempt; wall-clock + monotonic `seq`, ring-capped) tapped at commit points — undoManager
`pushAction` → `!edit`/`!select`, `undo`/`redo` → `!undo`/`!redo`, playMode → `!play`/`!pause`/
`!stop`. Bridge op `editor-journal` → `/api/editor-journal` → `modoki_editor_journal`, with a
`merged` read that also returns the game journal for correlation. **Verified live:** play/stop
produced `!play`/`!stop` interleaved with the game's `@scene-swapped`/`@anim-start`.
**Review-hardened:** every event carries a **`source: 'human' | 'agent'`** tag (agentEditorOps
shadows `registerAgentOp` to attribute its ops to `'agent'`) so Claude never mistakes its own
edits for the human's — the review's headline framing fix.
**Explicit v1 deferrals** (from the review — the plan promised more than v1 ships):
- ~~`!edit` payloads are label-based~~ **RESOLVED in V2 work (V1 backlog item)**: `!edit` now
  also carries `detail: {trait, field, entities[guid], old[], new[]}` — see § v2 backlog V1 ✅.
- ~~create/delete/reparent are `!edit` by label; `!transform`/`!gizmo`/`!scene-load`/`!save`
  not wired~~ **RESOLVED in V2 + V2b**: first-class `!create`/`!duplicate`/`!delete`/`!reparent`
  + `!transform`/`!gizmo`/`!scene-load`/`!save` all shipped — see § v2 backlog V2 ✅.
- ~~The `merged` read returns two separate streams; true single-axis interleave needs a shared
  capture counter~~ **RESOLVED in V3**: shared `cap` counter + interleaved `timeline` with a
  `sinceCap` cursor — see § v2 backlog V3 ✅.
- **E1** — Editor activity buffer: an editor-side, wall-clock-stamped, capped ring recording
  human actions; a small emit helper (`editorEmit(type, payload)`) with GUID-addressed,
  old→new payloads.
- **E2** — Tap the chokepoints (commits, not drags): `undoManager` push (`!edit`/`!create`/
  `!delete`/`!reparent`/`!transform`, already labelled), editor store subscriptions
  (`!select`/`!play`/`!stop`/`!gizmo`), Inspector field commit (old→new), scene/asset commands
  (`!scene-load`/`!save`), `!undo`/`!redo`.
- **E3** — `editor-journal` bridge op in `agentEditorOps.ts` + `modoki_editor_journal` MCP
  tool + backend route; supports a **merged read** that interleaves the human stream with the
  game journal by capture order (Decision E). `!` provenance sigil.
- **E4** — Confirm Watch (Phase 6) can target editor/UI state; document the "editor is the
  second subject" model. (No new mechanism — a wiring/docs pass.)
- **Depends on:** Phase 6 for the merged-read alignment helper and editor-Watch; otherwise
  independent (editor-only, different subject).
- **Ships:** Claude perceives its human collaborator — pairing, intent capture, a unified
  human+game timeline. **Verify:** rename an entity + drag its gizmo in the editor →
  `modoki_editor_journal` shows `!edit`/`!transform` with GUIDs and old→new values; a merged
  read interleaves them with `@`/game events during a Play session.

### Dependency summary

```
Phase 1 (J1, J2) ──────────────┐
                               ├──► Phase 4 (J3)
Phase 3 (S3, S4, S5) ──► S4 ───┘
Phase 2 (S1, S2) ── independent
Phase 5 (S6) ── independent (needs renderer)
Phase 6 (W1→W2→W3, W4) ── W-anim benefits from S4; Transform/physics watch works after Phase 1
Phase 7 (E1→E2→E3, E4) ── editor-only, different subject; merged read + editor-Watch want Phase 6
```

Phases 1, 2, and 6-core (Transform/physics) can proceed without the others; Phase 4 is the
one true join (needs J2 + S4). Phase 7 is independent of the game-world work (it could even
run in parallel) but its merged-timeline read wants Phase 6's alignment helper, so it sits
last. Recommended linear order is 1 → 2 → 3 → 4 → 5 → 6 → 7.

---

## Resolved decisions

- **A (Snapshot G1):** ~~scene-state stays compact by default with opt-in `?full=1`~~ —
  **superseded** by `docs/mcp-response-budget.md` Phase 3. scene-state now defaults to a names-only
  INDEX (no field values, default `limit` 200); any target (`trait`/`id`/`name`/`where`) or
  enricher (`full`/`world`/`bounds`/`contacts`) returns VALUES. `where` and `diagnose` still use
  the full field set **internally regardless** (so queries are never blind to a field the dump
  omits). Note an untargeted `full=1` now exceeds the 60k-char cap and returns the elision
  envelope — narrow with `trait=`/`id=`/`limit=`. *(Phase 2 / S2; amended.)*
- **B (Watch component-type focus):** a despawned entity's series is **frozen** with a
  `despawned@tick` marker (not dropped); newly-spawned matching entities **auto-join** the
  watch. *(Phase 6 / W1.)*
- **C (Journal `@anim-*`):** `@anim-loop` fires **per loop**; `@anim-finish` fires **only
  when a non-looping clip ends**. *(Phase 4 / J3.)*
- **D (mode enum):** the `debug|profile|release` enum is **deferred** until a profiler gives
  "profile" a second real consumer. Phase 1 ships only the `build.debugBuild` boolean +
  a TODO note. *(Phase 1 / J1.)*
- **E (editor journal store):** a **separate** editor-side activity buffer (not the
  world-scoped game journal — different lifecycle: editor-only, session-scoped, wall-clock
  stamped, not production-gated), exposed via `modoki_editor_journal`, with a **merged read**
  that interleaves it with the game journal by capture order. Provenance sigil `!` = human/
  editor. *(Phase 7 / E1–E3.)*
