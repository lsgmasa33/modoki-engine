# Zone Triggers (`Zone2D` / `Zone3D`)

Engine-level **enter / exit trigger volumes** with no physics required. A zone is a pure geometric
region (a sphere, box, circle, …) whose volume **is the entity's Transform** (position = centre,
scale → size, rotation applied). Any entity tagged **`ZoneOccupant`** is tested for containment each
frame, and crossings are reported three ways — a tick-stamped journal event, a code-subscriber event
bus, and a declarative action. This is the physics-free twin of the sensor colliders in
[physics-2d.md](./physics-2d.md): use a zone when you want "is X inside this region" without paying
for a Rapier body (checkpoints, spawn/kill regions, camera triggers, cutscene starts, swim areas).

## Traits

| Trait | Put it on | Fields |
|---|---|---|
| **`Zone3D`** | the zone entity (3D) | `shape`: `sphere`\|`circle`\|`cylinder`\|`capsule`\|`box`\|`plane`; `color` (editor wireframe) |
| **`Zone2D`** | the zone entity (2D) | `shape`: `circle`\|`box`\|`capsule`; `color` |
| **`ZoneOccupant`** | anything that can trigger a zone | *(tag — no fields)* |
| **`OnZone3D`** / **`OnZone2D`** | the same entity as the zone (optional) | `onEnter`, `onExit` — UIAction names |

`ZoneOccupant` is **opt-in** on purpose: only tagged entities are tested, so a scene with a few actors
(the player, an enemy) doesn't pay to test every positioned prop each frame. The tag is
dimension-agnostic — the same marker opts an entity into both 2D and 3D zone tests (an entity's
Transform is normally 2D **or** 3D, so in practice a 3D zone only ever contains 3D occupants).

## Volume → scale mapping (matches the editor wireframe exactly)

The containment test and the editor wireframe read the **same** scale→volume mapping, so "inside"
always agrees with what you see. The occupant is tested in the zone's **local frame** (the zone's
rotation is undone first), so a rotated box/plane/cylinder contains correctly.

**3D (`Zone3D`)** — `sx/sy/sz` are the world scale:
- `sphere` — 3D ball, radius = `sx`
- `circle` — flat disc in the ground (XZ) plane, radius = `sx` (Y ignored) — top-down areas
- `cylinder` — radius = `sx`, full height = `sy` (`|dy| ≤ sy/2`)
- `capsule` — radius = `sx`, total height = `sy` (cylindrical segment + hemispherical caps)
- `box` — full size = scale (half-extents `sx/2`, `sy/2`, `sz/2`)
- `plane` — flat rectangle in the ground plane, size `sx × sz` (Y ignored)

**2D (`Zone2D`)** — `sx/sy` are the world scale, `rz` the rotation:
- `circle` — radius = `sx`
- `box` — full size = scale (half-extents `sx/2`, `sy/2`)
- `capsule` — vertical pill along local Y, radius = `sx`, total height = `sy`

## The three sinks (per crossing)

For every enter and exit, `zone2DSystem` / `zone3DSystem` fan out to:

1. **Journal** — `emit('@zone', { zone, other, phase })`. `zone`/`other` use `entityRef` (a stable
   GUID when the entity has one, else its numeric id), so a trace survives scene hot-reloads. Read it
   headlessly with `tw.events({ type: '@zone' })`. This is the Percept-verifiable path — assert on
   events, not pixels.
2. **Event bus** (`zone2DEvents` / `zone3DEvents`) — subscribe in code:
   `zone3DEvents.onZoneEnter((zone, other) => …, world)`, plus `onZoneExit` and the phase-agnostic
   `onZone((zone, other, phase) => …)`. Each returns an unsubscribe fn. World-scoped subscribers
   (cleared on scene swap via the scene-scoped `Zone2DEvents`/`Zone3DEvents` managers).
3. **Declarative `OnZone` trait** — put `OnZone3D({ onEnter: 'myAction' })` on the zone; when a
   `ZoneOccupant` enters, the named UIAction is dispatched with the occupant as `ctx.target` and
   `{ self: zone, other, phase }` in `ctx.params`. The no-code path — an unwired name is a warning,
   not a crash. Leave a field empty to react to only the other phase.

## Semantics & lifecycle

- **Sim-gated.** The systems run at pipeline priority `TRANSFORM + 2` (after transform propagation, so
  world poses are this frame's final positions) but only act while **Playing**. On **Stop** the
  occupancy baseline is cleared, so the next Play re-fires `enter` for whatever is already inside (a
  clean start-of-play). On **Pause** membership is frozen — no spurious re-enter on resume.
- **Despawn-safe.** Membership is recomputed and diffed each frame, so removing a zone fires `exit`
  for all its occupants, and removing an occupant fires `exit` from every zone it was in — the same
  discipline `synthesizeContactExits` gives the physics sensors.
- **Self-skip.** A zone that is itself tagged `ZoneOccupant` never triggers on itself.
- **Channel isolation.** 2D and 3D occupancy state is kept per-channel, so a scene running both
  dimensions never has one system's diff clobber the other's membership.

## Worked example (declarative, no code)

1. Add `Zone3D({ shape: 'box' })` to an entity; scale it to cover the region (the editor draws the
   wireframe so you can size it with the gizmo).
2. Add `OnZone3D({ onEnter: 'level.checkpoint' })` to the same entity.
3. Tag the player with `ZoneOccupant`.
4. Register a `level.checkpoint` UIAction. Walking the player in dispatches it with the player as
   `ctx.target`.

## Code map

- Traits: `runtime/traits/{Zone3D,Zone2D,ZoneOccupant,OnZone3D,OnZone2D}.ts`
- Shared core (routing + occupancy diff + despawn synthesis + world-pose read):
  `runtime/systems/zoneTriggerCore.ts`
- Dimension systems: `runtime/systems/{zone3DSystem,zone2DSystem}.ts` (containment math per shape)
- Event buses: `runtime/managers/{zoneEventBus,Zone3DEvents,Zone2DEvents}.ts`
- Wiring: systems in `engine/app/ecs/pipeline.ts`, managers in `engine/app/ecs/register.ts`, editor
  metadata in `engine/app/ecs/registerTraits.ts`
- Editor wireframe: `Zone3D` in `editor/panels/SceneView.tsx` (3D mesh gizmo); `Zone2D` in the same
  file's `drawScene2D` Canvas2D chrome overlay (dashed outline of every zone in the canvas)
- Tests: `tests/runtime/{zone3DEvents,zone2DEvents}.test.ts`

### Known gap

A **bare** `Zone2D` entity (one with no `Renderable2D`) is not yet click-selectable in the 2D
viewport — the 2D picker keys off `Renderable2D` dimensions. Select it from the Hierarchy panel and
the transform gizmo works normally. A pick-extent hook (mirroring `colliderPickHalfExtents`) is the
follow-up to make bare zones clickable in the viewport.
