# 2D Physics (Rapier2D) — Integration Design

Status: **COMPLETE — Phases 1–4 shipped** (all of Phase 4: CCD, compound colliders,
collision-mesh authoring, dynamic concave decomposition, character controller + sprite animation —
see the phased plan at the bottom). Engine: **`@dimforge/rapier2d-compat`** (Rust→WASM, base64-inlined,
cross-platform deterministic rigid-body solver). This doc is the authoritative plan for wiring
Rapier into the Modoki ECS (koota), rendering (PixiJS/Scene2D), the verification harness, and the
editor. Read `engine-concepts.md` first for the entity/component/system/manager vocabulary.

> **Scope note (broadened).** This doc now covers **both** the 2D (`@dimforge/rapier2d-compat`)
> and the 3D (`@dimforge/rapier3d-compat`) integrations. It keeps its `physics-2d.md` name because
> source comments cite it by path; the 2D integration is described in full first, then
> [3D physics (Rapier3D)](#3d-physics-rapier3d--the-parallel-integration) covers only what differs.
> Several subsystems are shared, dimension-parameterized code and are documented **once** for both:
> the collision/sensor event routing, the contact index, joints, the scene-query + forces API, and
> the WASM world registry.

Feature-complete + behind the full CI gate; every feature has a demo scene in
`demos/2d-physics-demo/` (playground, ccd-tunneling, compound-colliders, collider-mesh,
concave-shapes, platformer). **Deferred (optional, none blocking)** — pick up if/when needed:

- **Character game-feel:** coyote-time, jump-buffering, air-jumps, per-player input routing
  (today a single keyboard axis broadcasts to all `CharacterController2D`s).
- **Perf:** decomposed-concave / many-collider scenes not yet profiled on-device (iPhone/Samsung).
- **Editor:** drag-to-resize handles for box/circle colliders (sized via Inspector today; only
  point-shapes — polygon/polyline/concave — have on-canvas ⬟ Points handles).
- **Known micro-limitations (documented in code):** animating a compound-child offset or a
  `concave` shape's points re-decomposes/rebuilds the body every frame (author static offsets); a
  `concave` collider can emit multiple collision events per logical contact (one per convex piece —
  dedupe by entity id if it matters).
- **Harness:** loading a real scene FILE headlessly in `createTestWorld` (a general
  verification-harness follow-up, not physics-specific).

## Why Rapier2D

The selection criterion is **determinism**, because the engine is built to verify game logic
headlessly and deterministically (injectable clock, seeded RNG, `stepSimulation`, the determinism
guard test). Rapier is deterministic by design (same WASM binary → bit-identical f32 results) and
**never reads a clock internally** — you hand it `dt` on `world.step()`, which is exactly the
injectable-clock contract. Matter.js (not deterministic) fails this bar; Planck.js is the pure-JS
fallback if we ever want to drop the WASM init.

Rapier is a complete rigid-body + joints engine (Bullet/Box2D-class core, modernized): dynamic/
static/kinematic bodies, soft-constraint (TGS-style) solver, CCD, compound shapes, static concave
trimesh, impulse + multibody joints with motors/limits, sensors, collision groups, a full scene-
query API (raycast/shape-cast/point-project), islands+sleeping, and a built-in kinematic character
controller. It does **not** do soft bodies / cloth / fluids / destruction / GPU — none of which 2D
games need.

## The three hard parts (everything else is mechanical)

1. **Retained-mode Rapier vs. immediate-mode ECS.** Rapier owns a `World` of bodies/colliders
   addressed by integer *handles*; the ECS is the source of truth. The physics system is therefore
   a **reconciler**: entity gains `RigidBody2D` → create Rapier body; entity despawns → `free` it;
   every tick copy transforms across the boundary. The `entityId ↔ RigidBodyHandle` map is the core
   of the integration.
2. **Two coordinate mismatches.** (a) Rapier is Y-**up**, meters, SI-tuned (bodies happiest at
   0.1–10 m); Transform is Y-**down** (PixiJS/screen), world units, often hundreds of px. (b) So
   every sync crosses a `pixelsPerMeter` scale **and** a Y-flip (which also flips the rotation
   sign). This lives in one conversion module, unit-tested in isolation — it's where round-trip
   bugs hide.
3. **Async WASM init + play/stop lifecycle.** `await RAPIER.init()` must finish before the first
   step (same async-init gating we already use for the PixiJS `<Application> onInit` pattern). And
   because Play→Stop reverts the authored snapshot, the Rapier world is **built on Play and
   discarded on Stop** — it is simulation-time state, never authored state.

## Determinism verdict

Rapier2D is compatible with the harness and does **not** trip the determinism guard
(`tests/runtime/determinismGuard.test.ts`):

- The guard scans `runtime/**` source for `performance.now()` / `Date.now()` / `Math.random()`.
  Rapier is a `node_modules` dependency — out of scope. Our own code stays clean: step with
  `getSimDelta(world)`, never wall-clock. No new allowlist entry needed.
- Rapier takes `dt` on `world.step()` — no internal clock. We pass `getSimDelta(world)`.
- Fixed-dt stepping is mandatory for determinism. `stepSimulation`/`advanceFixedSteps` already
  guarantee it headlessly; the live game feeds `getSimDelta` (fixed per tick). Never feed a
  variable frame time into the solver.
- Collisions/sensors become **journal events** (`emit('@collision'|'@sensor', …)`) you assert on in
  `createTestWorld` — no screenshots. This is the payoff that justifies Rapier over Matter.js.

## Traits (3 core + 1 singleton)

Defined with koota `trait()` under `runtime/traits/`, registered with editor metadata in
`registerTraits.ts`. Body vs. collider are split (mirroring Rapier/Box2D) so one body can own
multiple colliders (compound) later without reworking traits.

**`Physics2D`** — singleton world config, analogous to `Time` (one entity, `queryFirst`):
```
gravityX: 0, gravityY: 9.81          // m/s² (NOT scaled by pixelsPerMeter); +Y because screen is Y-down
pixelsPerMeter: 100                  // scale that keeps the solver in its happy range
```

**`RigidBody2D`** — the motion half:
```
bodyType: 'dynamic'                  // 'dynamic' | 'static' | 'kinematic' (enum)
vx: 0, vy: 0, angularVel: 0          // runtimeOnly readback of live velocity
linearDamping: 0, angularDamping: 0
gravityScale: 1
fixedRotation: false                 // lock rotation (top-down characters)
ccd: false                           // continuous collision (fast/thin bodies)
canSleep: true
```

**`Collider2D`** — the shape/material half (tagged union: a `shape` enum + params; only the
relevant params are read per shape):
```
shape: 'box'                         // 'circle'|'box'|'capsule'|'polygon'|'polyline'|'concave'
radius: 50                           // circle/capsule
halfW: 50, halfH: 50                 // box
points: '' as string                 // polygon/polyline/concave: inline JSON point list (world units)
density: 1, friction: 0.5, restitution: 0
isSensor: false                      // trigger — events only, no solver response
physicsLayer: 'Default'              // named collision layer (see below); '' = use raw bits
collisionGroups: 0xffff, collisionMask: 0xffff   // advanced escape hatch (used when physicsLayer empty/unknown)
```

**`Joint2D`** (Phase 3) — `type: 'spring'|'revolute'|'prismatic'|'fixed'|'rope'`, `entityA`/
`entityB` as `entityRef` (GUID) fields, plus per-type params (stiffness/damping/rest length/
limits/motor target).

**`OnCollision2D`** (optional, declarative reaction) — pair with a `Collider2D`; `onEnter`/`onExit`
name a UIAction dispatched when another collider begins/ends overlap. See
[Reacting to collisions & sensors](#reacting-to-collisions--sensors-consuming-detection).

Editor metadata: `bodyType`/`shape`/`type` as `type:'enum'` with `options`; `isSensor`/
`fixedRotation`/`ccd`/`canSleep` as `boolean`; velocities/damping/friction as `number` with `step`;
`entityA/B` as `entityRef`. Live-velocity readback fields marked `runtimeOnly` so they don't
serialize into the scene.

## The physics system (one reconciler, new pipeline tier)

Add a priority between animation and transform:
```
TIME: 0 → GAME: 100 → ANIMATION: 150 → PHYSICS: 175 → TRANSFORM: 200 → PROJECTION: 300
```
Why 175: after **game logic** (sets velocities/forces) and after **animation** (so a keyframe-
driven *kinematic* body pushes its animated target into the solver), but before **transform
propagation** (so children follow post-physics positions).

`physics2DSystem(world)` — all steps no-op unless `isSimRunning()`:

1. **Reconcile bodies.** Detect entities that gained/lost `RigidBody2D` (koota add/remove hooks if
   available, else diff against a known-set) → create/`free` Rapier bodies + colliders. Store the
   `entityId ↔ handle` map in a module-level `Map`, keyed per active scene.
2. **ECS → Rapier (push).** Kinematic bodies: set next position from Transform (animated/scripted).
   Apply queued forces/impulses. Convert through `pixelsPerMeter` + Y-flip.
3. **Step.** `world.step(getSimDelta(world))`. `timeScale=0` → dt 0 → frozen (matches pause
   semantics, no EMA coast).
4. **Rapier → ECS (pull).** Dynamic bodies: write body position/angle → `Transform` (`x,y,rz`) and
   live velocity → `RigidBody2D` (inverse conversion).
5. **Events → 3 sinks.** Drain Rapier collision/sensor event queues and fan each enter/exit to:
   (a) the **journal** — `emit('@collision', {a,b})` / `emit('@sensor', {sensor, other, phase})`
   (observability; assertable in tests), (b) the **Physics2DEvents manager** (code subscribers),
   and (c) any **OnCollision2D** trait on either collider (declarative action dispatch). See below.

**Coordinate conversion** lives in one module (`physics2DConvert.ts`): `vecEcsToPhys`/
`vecPhysToEcs` (+ allocation-free `…Into` variants) for vectors, `angEcsToPhys`/`angPhysToEcs`
for angles, `lenToPhys` for extents, and `ptsToPhysFloat32`/`parsePointsToPhys` for point lists —
each applying `/ppm`, Y-negate, angle-negate. Unit-tested standalone.

## Reacting to collisions & sensors (consuming detection)

The physics system is the single **producer** of contact/sensor events; game code is the
**consumer**. Two layered ways to react (both fire only while the sim runs, inside the fixed step,
so reactions stay deterministic):

**C — `Physics2DEvents` manager (imperative, the substrate).** A scene-scoped manager
(`runtime/managers/Physics2DEvents.ts`, registered in `app/ecs/register.ts`) exposing a
subscribe API to code:
```ts
import { physics2DEvents } from '@modoki/engine/runtime';
const off = physics2DEvents.onSensorEnter((sensor, other) => { /* real Entity handles */ });
physics2DEvents.onSensorExit(...); physics2DEvents.onCollisionEnter(...); physics2DEvents.onCollision(cb) // cb gets phase
```
Subscribers are **world-scoped** (WeakMap<World>, like the journal) so dual editor viewports /
parallel test worlds stay isolated; the manager's `dispose` clears the old world's subscribers on
scene swap. Callbacks receive live koota `Entity` handles. Use this when a reaction needs arbitrary
game state, filtering, or cross-entity logic.

**B — `OnCollision2D` trait (declarative, no-code).** Put it on the same entity as a `Collider2D`
(e.g. a Sensor Zone). Fields `onEnter`/`onExit` name a UIAction (Inspector dropdown of registered
actions). On overlap begin/end the physics system dispatches that action, passing the **other**
entity as `ctx.target` and `{ self, other, phase }` in `ctx.params`. Dispatch goes through the new
**pipeline-safe `dispatchGameAction`** (never throws on a missing handler, unlike the
event-handler-only `dispatchUIAction`, whose dev-throw would abort the frame — F10). This is the
declarative sugar on top of C. Demonstrated in `demos/2d-physics-demo` (the Sensor Zone tints
green on enter, reverts on exit, and logs a `zone` journal event).

### The shared producer + the rich `@contact` event

The enter/exit fan-out is dimension-agnostic and lives in ONE module,
`runtime/systems/physicsContactEvents.ts` (`drainContactEvents` / `routePair` /
`synthesizeContactExits` / `makeFireOnCollision`), used by BOTH `physics2DSystem` and
`physics3DSystem` — only the injected event bus + `OnCollision` trait differ, so a fix to the
correctness-critical enter/exit balance can't silently miss a dimension. The bus itself comes from
`runtime/managers/physicsEventBus.ts` (`createPhysicsEventBus` → two instances, `Physics2DEvents`
/ `Physics3DEvents`, because one koota world can carry both 2D and 3D bodies and their subscriber
sets must not conflate).

Beyond `@collision`/`@sensor` (which carry only the pair + `phase`), a **solid contact BEGIN** also
fans a rich **`@contact`** event, `{ a, b, point, normal, speed }` — the world-space contact point
+ normal read off the Rapier manifold, and `speed` = the relative approach speed along the normal
(world units/s). It's the impact detail games need for damage / SFX volume / effect spawning, fired
once per contact begin (sensors carry no manifold, so they're skipped). Code subscribes via
`physics2DEvents.onContact((a, b, detail) => …)`; the journal event is GUID-addressed (Percept).
`emitContactDetail` is per-dimension (manifold reading is Rapier-2D-vs-3D-specific) and is the
optional `onPair` hook `drainContactEvents` invokes.

Two removal subtleties: Rapier emits **no stop event** when a collider is freed/rebuilt, so
`synthesizeContactExits` walks the still-overlapping pairs and fires the missing `exit` **before**
the free — otherwise a despawn-inside-a-trigger (or a geometry rebuild) leaves a subscriber's
overlap state stuck 'entered'. And a `concave`/compound collider can fire **multiple** events per
logical contact (one per convex piece / child collider) — dedupe by entity id if it matters.

### Contact index (Percept — "what is this body touching NOW?")

`@contact`/`@sensor` answer *when* two things touched; once a resting contact's begin-event scrolls
out of the journal ring the event stream can't answer *what is touching now*.
`runtime/systems/physicsContactIndex.ts` is that STATE counterpart — a per-world index of each
**body** entity's current solid `contacts` + sensor `overlaps`, maintained **incrementally** from
the same enter/exit events `routePair` already fires (NOT a per-frame scan, so a settled pile of
crates costs nothing).

- **Refcounted, not a Set.** Contacts fire per COLLIDER pair but roll up to BODIES (a compound
  body's extra colliders are child entities; a table with two legs on the floor is two collider
  pairs for one body pair). Each other-body maps to a *count* of active collider pairs and is
  reported while count > 0 — a Set would drop the whole pair the moment the first collider lifts.
  Self-pairs (two colliders of one body) are excluded.
- **Two cleanup responsibilities, deliberately split.** LIVE separation (two live bodies move
  apart) → the incremental exit from the drain path, where both entities are alive so the
  collider→body roll-up is symmetric with the enter. REMOVAL (a body despawns/rebuilds) →
  `dropEntityFromContactIndex(world, bodyId)` from each system's `removeBody`/`removeSoloCollider`
  + the zero-body early-out, because a dead/reparented compound child re-resolves to a *different*
  body than its enter did (decrementing by that would leak) — force-clearing by body identity is
  exact.
- **Folded into `get_scene_state`.** `getContactState(world, id)` returns sorted `contacts`/
  `overlaps` id arrays; `agentBridge.ts` resolves each to a GUID and attaches them under the
  `contacts` enricher (`?contacts=1`). Cleared on scene swap + Play→Stop (same lifecycle as the
  physics world). See [percept-plan.md](./percept-plan.md).

## Collision layers (named layers + matrix)

Rapier decides "what collides with what" from each collider's 16-bit **membership**/**filter**
bitmasks (A and B collide iff `A.groups & B.mask` **and** `B.groups & A.mask`). Raw bitmasks are
powerful but painful to author by hand, so there's a Unity-style **named-layer** system on top:

- **Project config** (`project.config.json` → `physics`) declares up to **16 layer names** (index =
  bit; index 0 = `Default`) and a symmetric **collision matrix** (`collisionMatrix[i]` = the 16-bit
  mask of layer indices layer i collides with). Pushed into the runtime once at boot via
  `setPhysicsLayers(projectConfig.physics)` in `app/ecs/register.ts`.
- **Runtime registry** (`runtime/systems/physicsLayers.ts`, process-global like the trait registry):
  `resolveColliderBits(layer, rawGroups, rawMask)` maps a collider's `physicsLayer` name →
  `{ groups: 1<<idx, mask: matrix[idx] }`. An **empty or unknown** layer falls back to the raw
  `collisionGroups`/`collisionMask` (the advanced escape hatch). Default (no config) = one `Default`
  layer that collides with everything — identical to pre-layer behavior.
- **Collider authoring**: `Collider2D.physicsLayer` is an Inspector dropdown of the project's layer
  names (dynamic `optionsSource: 'physicsLayers'`); the raw bit fields move to a collapsed
  "Advanced Filter" section. The resolved bits are baked into the collider's structural signature, so
  editing the matrix rebuilds every affected collider on the next tick.
- **Matrix editor**: Project Settings → **Physics Layers** — add/rename/remove layers + a symmetric
  NxN checkbox grid (`PhysicsLayersEditor.tsx`, `'physics-layers'` settings field type). Persisted
  through the same `/api/project-settings` path; takes effect on reload.

`demos/2d-physics-demo` showcases it: `Ground` (floor/walls), `Default` (boxes/balls), `Ghost`
(matrix `[3,7,2]`) — the Ghost ball falls **through** the Default box pile but lands **on** the
Ground floor, while the boxes stack on each other.

## Compound colliders (one body, many shapes)

A single `RigidBody2D` can own several colliders — an L/plus/table shape, or a decomposed
concave hull (Phase 4.4). Authoring is by **hierarchy**, no new trait: give the body child
entities that each carry a `Collider2D` (+ `Transform` for the local offset, + optionally a
`Renderable2D`) but **no `RigidBody2D`** of their own. The reconciler adopts each direct child as
an extra Rapier collider attached to the parent body at the child's local Transform offset
(`vecEcsToPhys` + `angEcsToPhys`). The child's collision events resolve to the **child** entity, so
per-part `OnCollision2D` / journal events work.

- **Single level only.** Only DIRECT children (`parentId === body.id()`) are adopted; a grandchild
  under a body-less collider is not chained in. Enough for plus/table/dumbbell + decomposition.
- **Rebuild on edit.** `bodySig` folds in each child's shape/material/offset/id/generation, so
  adding, removing, reparenting, moving, or editing a child rebuilds the body next tick. Children
  are collected per tick (`collectCompoundChildren`) and sorted by id for a stable signature.
- **Cleanup.** `BodyRec.colliderHandles` tracks own + child handles; `removeBody` drops every
  collider→entity map entry (no stale/leaked entries on rebuild or removal).
- **Behavior note.** A `Collider2D`-only entity parented to a body is now a compound child — before
  this feature it was ignored entirely (the reconciler only ever looked at `RigidBody2D` entities),
  so existing single-body scenes are unaffected.

## Character controller (kinematic, Phase 4.5)

A `CharacterController2D` gives an entity Rapier's `KinematicCharacterController` behavior —
collide-and-slide, autostep, slope climb/slide limits, snap-to-ground — instead of raw dynamics.
Pair it with a **kinematic** `RigidBody2D` + a `Collider2D` (box/capsule).

- **Driven inside `physics2DSystem`.** After bodies/joints reconcile and BEFORE the world step,
  `stepCharacters` integrates gravity + input into a desired delta, calls `computeColliderMovement`,
  and sets the body's next kinematic translation (so the step applies the resolved motion). The
  authored-pose push is skipped for character bodies (the controller owns their motion), and a
  dedicated pull writes the post-step translation back to Transform. `grounded` + `velY` are
  readback fields; `jump` is a consumed one-shot.
- **Input is decoupled for determinism.** The controller reads only trait fields (`moveX`, `jump`),
  so a headless test drives it directly. In the live app *passive* window listeners
  (`runtime/input/keyboardSource.ts`, never `preventDefault`, so they can't steal editor keys) feed
  the canonical `Input` resource via `inputSystem` (INPUT priority), and `characterInputSystem`
  (GAME priority, so sim-gated) bridges that resource's axis/jump onto every `CharacterController2D`
  each frame. Because it reads plain trait data, `characterInputSystem` is deterministic and runs in
  the harness too — a test spawns `Input`, sets its fields, and asserts on `moveX`/`jump`.
- **Controls (demo):** A/D or ←/→ to move, W/↑/Space to jump. See `2d-physics-demo/platformer.json`.

## Character sprite animation (Phase 4.6)

The engine already ships the flipbook stack — `SpriteAnimator` (named clips of `'sprite'`
slice GUIDs) + `spriteAnimationSystem` + grid slicing (`SpriteEditor` / `loaders/spriteSheet.ts`)
+ sub-rect frame resolution (`resolveSprite`). The only missing piece for a *platformer* was a
driver tying motion state to a clip. `CharacterAnimator2D` (`runtime/traits/CharacterAnimator2D.ts`)
+ `characterAnimationSystem` provide it:

- **State → clip.** On an entity carrying `CharacterAnimator2D` + `CharacterController2D` +
  `SpriteAnimator`, each frame it picks the active clip: airborne (`!grounded`) → `jumpClip`,
  grounded & `|moveX| > moveThreshold` → `walkClip`, else `idleClip`. Switching clips restarts the
  new track from frame 0. Clip *names* are configurable trait fields (default `idle`/`walk`/`jump`).
- **Facing via `Renderable2D.flipX`.** With `flip` on, the system sets `Renderable2D.flipX` from the
  move direction (the sheet faces right; moving left mirrors). This is a **render-only** mirror — it
  leaves the Transform untouched, so it never mirrors child entities and stays invisible to the
  physics collider (unscaled world units). Facing is held while (near-)still, so the character keeps
  its last direction. (The `CharacterAnimator2D` trait doc-comment still says `Transform.sx` — a
  stale note; the system is authoritative and uses `flipX`.)
- **Runs at GAME priority** (with `characterInput`, after it so `moveX` is fresh) — before the
  ANIMATION-tier `spriteAnimationSystem` consumes the chosen clip that same frame. Reads only trait
  fields, so it's deterministic and harness-safe (no-ops without the sibling traits).
- **The "add it via a menu" story:** `CharacterAnimator2D` registers in the Inspector's **Add
  Component** menu (category *Animation*) alongside `SpriteAnimator` — so authoring an animated
  character is: add both components, set the clips' frame GUIDs, done.
- **Demo asset:** `2d-physics-demo/…/sprites/player.png` — a **CC0** character sheet
  (bevouliin.com via OpenGameArt), cropped to alpha bounds and packed into a uniform 6×2 grid of
  192×320 cells, sliced via its `.meta.json`; attribution in `2d-physics-demo/ATTRIBUTION.md`.
  The `platformer.json` Player uses it: `idle` 2 frames, `walk` 6, `jump` 2 (`mode:"once"`, so it
  holds the falling frame while airborne).

## Scene queries & runtime forces (both dimensions)

Two families of imperative helpers let game systems interrogate and drive the physics world in
**ECS/world coordinates** (the `pixelsPerMeter`/`unitsPerMeter` + Y-flip conversion is applied
internally). Both are exported from `physics2DSystem.ts` / `physics3DSystem.ts` and resolve an
entity's live Rapier body via the per-world map, so they no-op until the reconciler has created the
body (its first tick).

**Scene queries** — pure reads against the live world, `null` if nothing is hit:
- `raycast{2,3}D(world, ox,oy[,oz], dx,dy[,dz], {maxDistance, solid})` → the nearest hit
  `{ entityId, x,y[,z], nx,ny[,nz], distance }`. Direction need not be normalized; point + distance
  come back in world units.
- `shapeCast{2,3}D(...)` — sweep a circle/ball of `radius` along a direction: the "would this fit if
  I move it here" query, returning the swept shape's CENTER at impact.
- `pointQuery{2,3}D(world, x,y[,z])` → the entity id of the first solid collider covering the point
  (pick / hit-test), else null.

**Runtime forces** — move a DYNAMIC body (Rapier ignores forces on fixed/kinematic); call from GAME
priority (< PHYSICS) so an impulse this frame is integrated by this frame's step. Each returns
`false` if the entity has no dynamic body yet:
- `applyImpulse{2,3}D` (one-shot momentum kick — jumps/knockback), `setLinvel{2,3}D` ("move at this
  speed"), `addForce{2,3}D` (a CONTINUOUS force that PERSISTS across steps until `resetForces{2,3}D`
  — re-add each frame, or prefer an impulse for one-shots), and the angular twins
  `applyTorqueImpulse` / `addTorque` / `setAngvel`, plus `wakeBody{2,3}D`. Linear quantities are
  world units (scaled by `pixelsPerMeter`/`unitsPerMeter`); torque + angular impulse carry length²
  so they scale by that factor squared. Angular velocity is radians/s and is NOT length-scaled.

## Joints & constraints (2D + 3D)

`Joint2D` / `Joint3D` are **link records**, not bodies — attach one to any entity (typically a
third), naming two bodies by GUID in `entityA`/`entityB`. The joint activates once both resolve to
live bodies and is torn down if either disappears (`reconcileJoints`, run AFTER the body pass so
both endpoints exist). Anchors are body-local offsets in world units.

- **Types.** 2D: `spring` · `revolute` (hinge/pin) · `prismatic` (slider) · `fixed` (weld) · `rope`
  (max-distance). 3D adds **`spherical`** (ball joint — anchors coincide, free rotation on all 3
  axes: ragdolls, chains). A `fixed` weld with zero anchors collapses the two body origins together;
  set an anchor equal to the offset to weld already-separated bodies.
- **Motors + limits** apply to `revolute`/`prismatic` only. `limitsEnabled` + `limitMin/Max` — the
  values are ANGLES (radians) for revolute, DISTANCES (world units) for prismatic. `motorEnabled`
  drives it: **position** drive when `motorStiffness > 0` (springs toward `motorTargetPos`), else
  **velocity** drive toward `motorTargetVel`.
- **Rebuild on edit.** A `jointSig` folds every field + both body handles, so any change (including
  a body rebuild that reassigns a handle) recreates the joint. Because `removeRigidBody`
  auto-removes a body's joints, `removeBody` also drops the referencing `JointRec`s map-only (a
  stale handle could resolve to a reused-index sibling) and the reconciler recreates them next pass.
- **3D has no handedness flip** — angles/distances pass straight through; the 2D revolute path
  negates/swaps to undo the Y-flip.

## 3D physics (Rapier3D) — the parallel integration

`physics3DSystem` (`runtime/systems/physics3DSystem.ts`) is a near-exact parallel of the 2D
reconciler on **`@dimforge/rapier3d-compat`**, sharing the PHYSICS tier (175): both systems run
there and each early-outs when its own body query is empty, so a scene runs whichever dimension it
authored — or both. Everything above about retained-mode reconciliation, structural-signature
rebuilds, in-place material edits, the entity-generation guard, `dt` from `getSimDelta`, and
Play=build/Stop=discard applies unchanged. The **traits** mirror their 2D counterparts —
`Physics3D` (singleton world config), `RigidBody3D`, `Collider3D`, `Joint3D`, `OnCollision3D`,
`CharacterController3D` — and the event routing, contact index, joints, scene-query + forces API,
and WASM registry above are the SAME shared code, dimension-parameterized. What genuinely differs:

- **No axis flip.** ECS (Three.js) and Rapier3D are both right-handed, +Y up, so the coordinate map
  (`physics3DConvert.ts`) is a plain uniform scale by `1/unitsPerMeter` (default **1** — world units
  already are meters) with **no Y-negate and no rotation-sign flip**. Gravity is a physical m/s²
  acceleration handed straight to Rapier (NOT scaled by `unitsPerMeter`); default `(0, -9.81, 0)`.
- **Euler ↔ quaternion is the one load-bearing seam.** Transform stores rotation as Euler radians
  `rx/ry/rz`; Rapier stores a unit quaternion `{x,y,z,w}`. `eulerToQuat`/`quatToEuler` hard-code
  THREE's `'XYZ'` order and reproduce `three/systems/transformPropagationSystem.makeMatrix` EXACTLY
  (rather than relying on THREE's ambient default), so physics can't silently desync from what the
  renderer draws. Pure THREE-only functions (no WASM) → unit-testable headlessly.
- **Per-axis locks.** `RigidBody3D` exposes `fixedRotation` (lock all spin — upright characters)
  AND per-axis `lockRotX/Y/Z` (`enabledRotations`, e.g. yaw-only) plus per-axis `lockTransX/Y/Z`
  (`enabledTranslations`, e.g. lock Y for a plane-slider, lock X+Z for a vertical elevator);
  `fixedRotation` takes precedence over the per-axis rotation flags.
- **3D collider shapes.** Analytic + dynamic-safe: `box`, `sphere`, `capsule`, `cylinder`, `cone`
  (capsule/cylinder/cone extend along local +Y; a capsule's `halfHeight` EXCLUDES the caps, so its
  true half-extent is `halfHeight + radius`). Mesh-derived: `convex` (convex hull — the shape a
  solid prop should use) and `trimesh` (exact concave, but **STATIC only** — no interior, so a
  dynamic body gets no solid response; use for level/terrain). A mesh shape reads a separate
  `Collider3D.mesh` GUID if set, else this entity's own `Renderable3D` mesh; the entity's WORLD
  scale is baked into the collider extents/vertices (Rapier bodies carry no scale), and a
  non-uniform scale on an axis-symmetric shape is approximated by a mean radius with a one-time warn.
- **Solo (parentless) static colliders.** A `Collider3D` with **no** `RigidBody3D` of its own AND no
  rigidbody parent becomes a native Rapier **parentless collider** — fixed world geometry that
  collides + fires events at the entity's WORLD pose, so authored static level geometry needs no
  dummy `static` body. (Reconciled after the body pass; a bucket whose parent IS a body was already
  adopted as compound children.)
- **Character controller (3D).** `CharacterController3D` + a kinematic `RigidBody3D` + a `Collider3D`
  (capsule recommended). Same Rapier `KinematicCharacterController` (collide-and-slide, autostep,
  slope climb/slide limits, snap-to-ground), but horizontal input is the **XZ plane** (`moveX`/
  `moveZ`) and +Y is up (gravity down, jump up) — no flip. `stepCharacters` integrates gravity +
  input into a desired delta before the world step and writes back `grounded`/`velY`; a controller
  is SHARED and reconfigured only when a character's (static) params change. Input is decoupled
  (reads only trait fields, harness-drivable); the live app's `characterInput3DSystem` bridges the
  `Input` resource onto `moveX`/`moveZ`/`jump`.
- **Hierarchy bridge (P2).** A PARENTED body seeds/poses at its WORLD transform (from the pre-physics
  `worldTransforms` cache) and, for solver-owned bodies, is read back into LOCAL space
  (`worldToLocal3D`) so a physicsed mesh under a moving parent stays put on its body — see
  [architecture.md](./architecture.md) on world-transform propagation.
- **Percept.** Dynamic bodies read back `isSleeping` each frame; `get_scene_state`'s `full` enricher
  surfaces it.

## Lifecycle (async init + scene + play/stop)

- **Init once at boot:** `await RAPIER.init()` before the pipeline's first run (app boot path; a
  global `beforeAll` in tests). Physics system no-ops until the module reports ready — same gate
  pattern as PixiJS `onInit`.
- **Per-koota-World Rapier world:** the Rapier world is keyed by the **koota World** in a module
  `Map`, created lazily on the first physics tick. `SceneManager` creates a **fresh koota world per
  scene load** and destroys the old one, so the physics world is effectively scene-scoped for free.
  It is `free()`d (WASM memory the GC can't reclaim) at four points: **`onWorldSwap`** (every scene
  load — the old world's Rapier state, before `SceneManager` destroys it), the **zero-body
  early-out** (all `RigidBody2D`s removed mid-scene), **Play→Stop** (`disposeAllPhysics2D`), and
  `disposePhysics2D` (tests). Without the `onWorldSwap` free, a shipped game (which never Stops)
  would leak one Rapier `World` + `EventQueue` per scene swap.
- **Shared WASM registry.** The per-World state map + those four free points are dimension-agnostic,
  so both systems build theirs from `createPhysicsWorldRegistry(freeState)`
  (`runtime/systems/physicsWorldRegistry.ts`): the factory owns the `Map<World, State>`, registers
  the Stop + `onWorldSwap` hooks once, and returns `dispose`/`disposeAll`. 2D's `freeState` frees
  its `world` + `eventQueue`; 3D exposes `disposePhysics3D`/`disposeAllPhysics3D` symmetrically. The
  contact index is cleared on the same swap/Stop lifecycle (`clearContactIndex`).
- **Reconciler robustness:** bodies are keyed by `entity.id()` but also carry the entity's koota
  **generation**; an id recycled onto a new entity forces a fresh body (no silent pose adoption).
  The Rapier→ECS pull is gated on `dt>0`, so a paused sim (`timeScale 0`) never overwrites an
  authored/inspector edit with the body's f32-quantized pose.
- **Play/Stop = build/discard.** On **Play**, build the Rapier world from the current authored
  entities. On **Stop**, discard it; the existing snapshot-revert restores authored Transforms. So
  authored scene state never contains simulated positions. Editor "preview physics while stopped"
  is explicitly **not** v1 ("not playing → no physics," consistent with the skeletal-animation
  rule).

## Editor authoring

- **Collider overlay** (DONE): Scene2D draws circle/box/capsule/polygon/polyline/concave outlines for every
  `Collider2D` entity, using the pure `colliderOutline2D()` geometry + the same
  `getWorldTransform2D` the sprites use (so outlines align with what's rendered). The outline is
  scaled by `scaleColliderOutline2D()` to match how `physics2DSystem`'s `makeColliderDesc` scales
  the live Rapier collider — box/polygon/polyline per-axis; circle/capsule radius by the mean of
  `|sx|,|sy|` (can't represent a non-uniform scale as an ellipse); capsule half-height by `|sy|`
  alone — so a scaled collider's overlay matches its true simulated size. Two independent
  toggles read this same overlay: the **⬡** button in the GameView toolbar
  (`setShowColliders2D()`, `defaultRenderer`) draws it ON TOP of sprites; the editor SceneView's
  **View ▾ → Colliders** checkbox (2D/`ui`-mode, `ViewOptionsMenu.tsx`) instead HIDES every
  sprite and forces the overlay on in purple (`0x9b59b6`) via `Scene2DRenderer.setCollidersOnly()`
  (`editorScene2DRenderer`) — a collider-only debug view, the 2D counterpart of the 3D
  SceneView's own collider-only mode (see [editor.md](./editor.md) "3D collider outline overlay
  + collider-only mode"). Drawn into one overlay `Graphics` per Canvas2D, on top of the sprites
  (or in place of them, in collider-only mode).
- **Collision-mesh vertex editor** (DONE, Phase 4.3): for authoring `polygon`/`polyline`/`concave`
  collider point lists visually instead of hand-editing JSON. Select an entity with such a
  `Collider2D`, click the **⬟ Points** toggle in the SceneView toolbar (only shown for those
  shapes), and the 2D SceneView draws a handle per vertex: **drag** to move, **double-click an
  edge** to insert a vertex (detected manually — `e.detail` is unreliable once pointerdown is
  preventDefaulted), **Alt/Cmd-click** a handle to delete (never below the shape minimum —
  3 for polygon/concave, 2 for polyline). Every edit is one undo entry and writes the `points` field (GUID-safe
  — points are inline coordinates, not an asset ref). The gizmo is hidden while editing. Pure list
  ops live in `runtime/scene/colliderPoints.ts`; the world↔local point math + vertex picking in
  `editor/panels/colliderEdit2D.ts`.
- **`sprite: 'collider'` render mode** (DONE): a polygon/polyline/concave collider has no primitive
  equivalent, so give its entity a `Renderable2D` with `sprite: 'collider'` and it draws the
  entity's **own Collider2D shape** — closed shapes filled, an open `polyline` stroked, in the
  `Renderable2D.color`/`opacity`. Single source of truth: editing the collider (⬟ Points) updates
  the visual live (the render change-detection keys on the outline signature). Rendered via
  `drawColliderFillGfx` (`runtime/rendering/render2DUtils.ts`, derived from `colliderOutline2D`) —
  the SAME function for both the runtime Pixi layer (`Scene2D`'s `defaultRenderer`) and the
  editor's own Pixi instance (`editorScene2DRenderer`); there is no separate Canvas2D fill path
  (only the gizmo/selection overlay is Canvas2D — see `drawColliderOutline`). `width`/`height` on
  such an entity only size its click-pick box + selection outline (the fill comes from the collider).
- **Live tuning** via the `modoki_*_set` pattern: gravity, restitution, friction, joint stiffness/
  damping hot-adjustable while playing (feel iteration can't be judged from a screenshot anyway).
- Shapes placed/sized from the Inspector; drag-to-resize gizmo is a nice-to-have, not v1.

## Mesh shapes (scoped)

- **Static concave** → Rapier `trimesh`/`polyline` from a point list. Phase 2. Covers terrain/walls.
- **Dynamic concave** → the `concave` shape (Phase 4.4, DONE). `poly-decomp-es` decomposes the
  authored point list into convex pieces at collider-build time, and each piece becomes a
  `convexHull` collider on the one body — a compound built inside `attachCollider` (distinct from
  the hierarchy compound of 4.2, which is one collider per child entity). `decomposeConcaveToPhys`
  (`runtime/systems/concaveDecomp.ts`) runs `makeCCW` + `quickDecomp` (deterministic, no RNG →
  determinism-guard-safe) and converts each piece to physics space. If the list is too small or
  self-intersecting it falls back to a single convex hull so the body still gets a collider. The
  outline + ⬟ Points editor treat `concave` like a closed polygon (the decomposition is a
  physics-only detail).
- **v1 dynamic shapes: circle/box/capsule/convex-polygon + decomposed concave** — parity with what
  a 2D engine offers.

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **1 — Core** ✅ | Rapier init, `Physics2D`/`RigidBody2D`/`Collider2D` traits, reconciler system @175, conversion module, circle/box, gravity. | `createTestWorld`: drop a box, `step(60)`, assert it fell + landed; assert `@collision` journal event. |
| **2 — Materials & queries** ✅ | friction/restitution/damping, sensors→events, sleeping, raycast/shape-cast helper, static trimesh, collider overlay in editor. | Sensor overlap emits `@sensor` event; restitution bounce height within tolerance. |
| **3 — Constraints** ✅ | `Joint2D` (spring/revolute/prismatic/fixed/rope) + motors + limits, kinematic-from-animation. | Pendulum period, spring settle — assert on Transform trajectory over N ticks. |
| **4 — Advanced** ✅ | CCD, compound colliders, dynamic convex decomposition, character controller, collision-mesh authoring tool. | Fast body doesn't tunnel through thin wall (CCD on/off diff), + the per-sub-phase tests below. |

### Phase 4 breakdown (sequential sub-phases)

| Sub-phase | Scope | Status | Verification |
|---|---|---|---|
| **4.1 — CCD** | Already wired via `RigidBody2D.ccd` → `setCcdEnabled`; add proof + demo. | ✅ done | `tests/runtime/physics2DCcd.test.ts` — fast ball tunnels a thin wall with `ccd:false`, is stopped with `ccd:true`. Demo scene `2d-physics-demo/…/ccd-tunneling.json` (two gravity-launched balls, CCD on/off). |
| **4.2 — Compound colliders** | One `RigidBody2D` adopts DIRECT child entities that have `Collider2D` but no own `RigidBody2D`, attaching each as a collider at the child's local Transform offset. Single-level only (grandchildren not chained). `physics2DSystem`: `collectCompoundChildren` groups by numeric `parentId`; `BodyRec.colliderHandles` tracks own+child handles; child edits change `bodySig` → rebuild. | ✅ done | `tests/runtime/physics2DCompound.test.ts` — two-footed body straddles a gap a single centered box falls through; a child collider's collision resolves to the child entity. Demo `2d-physics-demo/…/compound-colliders.json` (table, cross, dumbbell). |
| **4.3 — Collision-mesh authoring** | SceneView "collider edit mode" (⬟ Points toolbar toggle): draggable vertex handles for `polygon`/`polyline`/`concave` colliders — drag to move, double-click an edge to insert, Alt/Cmd-click a handle to delete; writes the `points` field (undoable). Pure logic in `runtime/scene/colliderPoints.ts`; world↔local + picking in `editor/panels/colliderEdit2D.ts`. | ✅ done | `tests/runtime/colliderPoints.test.ts` (parse/serialize/move/insert/remove/nearest-edge) + `tests/editor/colliderEdit2D.test.ts` (world↔local round-trip, pickVertex). Demo `2d-physics-demo/…/collider-mesh.json` (editable polygon ramp + polyline terrain). |
| **4.4 — Convex decomposition** | New `concave` shape: `poly-decomp-es` decomposes the point list into convex pieces → multiple `convexHull` colliders on ONE body (so a DYNAMIC concave solid works; a lone hull would fill the concavity). `makeColliderDesc` now returns a desc ARRAY; `attachCollider` returns handle[]. Falls back to a single hull if the list isn't decomposable. Editable via ⬟ Points. | ✅ done | `tests/runtime/physics2DConcave.test.ts` — a U-cup catches a ball inside (y>0) where the same points as a `polygon` hull leave it on top (y<0); decomposition splits a U into >1 piece. Demo `2d-physics-demo/…/concave-shapes.json` (bowl collecting balls + a dynamic boomerang). |
| **4.5 — Character controller** | `CharacterController2D` trait (kinematic body) driven inside `physics2DSystem` via Rapier's `KinematicCharacterController` (collide-and-slide, autostep, slope limits, snap-to-ground, grounded + velY readback). Passive window keys (`keyboardSource`) feed the `Input` resource via `inputSystem`; `characterInputSystem` bridges that resource's moveX/jump onto the trait each frame (sim-gated; harness-safe — reads trait data, not the DOM). | ✅ done | `tests/runtime/physics2DCharacter.test.ts` — walks + grounded, falls unsupported, blocked by a wall, auto-steps a ledge only when enabled (driven by trait fields). Demo `2d-physics-demo/…/platformer.json` (A/D move · Space jump · stairs · platform · wall). |
| **4.6 — Character sprite animation** | `CharacterAnimator2D` trait + `characterAnimationSystem` (GAME priority) map `CharacterController2D` motion state → active `SpriteAnimator` clip (jump/walk/idle) and flip facing via `Renderable2D.flipX`. Reuses the existing flipbook stack (`SpriteAnimator` + grid slicing + `resolveSprite` sub-rects). Registered in the Inspector **Add Component** menu. | ✅ done | `tests/runtime/characterAnimation.test.ts` — clip selection (idle/walk/jump, threshold), facing flip + magnitude preserved, `flip:false` opt-out. Demo `2d-physics-demo/…/platformer.json` Player uses `sprites/player.png` (CC0, 6×2 sheet of 192×320 cells). |

**Note on the CCD demo (4.1):** CCD-*off* tunneling is inherently framerate-dependent (a discrete
step tunnels only when no sub-step sample lands inside the obstacle), so the demo drives the balls
with high horizontal gravity for a large speed margin. The **deterministic proof** is the test, not
the demo; the CCD-*on* ball stops reliably regardless of framerate.

## Open decisions

- **`pixelsPerMeter`** — default **100** (1 m body = 100 units, keeps solver in range); per-project
  overridable via `Physics2D`.
- **Y-flip** — assumes the 2D world is Y-down (PixiJS/screen); sets gravity sign + rotation
  handedness. Confirm before Phase 1.
- **koota add/remove hooks** — if koota exposes `onAdd`/`onRemove` per trait, reconciliation is
  event-driven; otherwise a per-frame diff against a known-set. Both work; events are cheaper.
