<!-- Generated from CLAUDE.md by `npm run sync:agent-configs` — edit CLAUDE.md, not this file. -->

# 3d-physics-demo — Rapier3D physics showcase (scene-driven)

**A curated, publishable Modoki demo.** It ships as its own public repo, so it stays
self-contained and free of third-party assets. The public-facing doc is
[README.md](README.md); this file is the agent-facing one and travels with the demo.

A near-content-only project exercising the engine's Rapier3D layer: gravity,
restitution, rolling, a stacked tower, every primitive collider, three joint types, a
character controller, a sensor trigger, a physics-free `Zone3D` trigger, and a trimesh
terrain collider. Almost everything is authored in the scenes — **the scene is the
source of truth** (`config.ts` does no `initWorld` spawning).

## This project
- **Mechanics / systems** — the ONLY game code is TWO PAIRS of `UIAction`s registered
  in `game.ts`, one per trigger station, each wired declaratively to its entity. Both
  tint the station's `Renderable3DPrimitive` and `ctx.emit(...)` a journal event (body
  as a hot-reload-stable GUID via `entityRef()`) so the reaction is verifiable by data
  (`modoki_journal`), not by eye. `unregisterSystems` tears all four down. No custom
  traits, no config knobs, no custom UI.
  - `sensorZone3D/enter|exit` — the *Sensor Zone*, via `OnCollision3D`. Rapier sensor;
    authored teal → green `0x2ecc71` while occupied; journals `zone`.
  - `triggerZone3D/enter|exit` — the *Trigger Zone*, via `OnZone3D`. **No physics body
    at all**; authored purple → violet `0xd980fa` while occupied; journals `zoneTrigger`.
  - ⚠️ **The IDLE colour is authored in the scene and is NOT a code constant.** `tintOnEnter`
    remembers what the station actually holds and `restoreOnExit` puts that back, so
    re-colouring a station in the Inspector survives — a hardcoded idle would silently
    overwrite the owner's edit on the very next exit. The `*_FALLBACK` constants are
    no-scene fallbacks only.
  - ⚠️ **That stash is PER-SESSION state, and both of its hazards are subtle enough to have
    shipped once already.** (a) It tracks WHO is inside, not HOW MANY: pressing Stop clears
    the engine's occupancy *without* firing exits (`clearZoneState`), so a station occupied
    at Stop gets a second `enter` with no matching `exit` — a counter climbs to 2, never
    returns to 0, and the station stays lit forever. A set of occupant ids is idempotent
    under that duplicate and self-heals. (b) It is cleared on `onWorldSwap`, because Stop
    rebuilds the world and `entity.id()` is a per-world SLOT INDEX that restarts at 0 — the
    next session hands the same ids to the same entities, so an uncleared stash would skip
    re-reading the authored colour and later restore the PREVIOUS session's value. Both are
    pinned by tests in `tests/zone-station.test.ts`.
- **This demo is the engine's ONLY real usage of the declarative zone chain** (#296) —
  `Zone3D` + `ZoneOccupant` + the `@zone` journal event + `OnZone3D`. Before it, the
  chain shipped in nothing, so a regression in it was caught by no project we ship and a
  QA pass had to rig a scene by hand to test it at all. `tests/zone-station.test.ts` is
  the pinned fixture that replaced that: it reads the action names OUT of the scene and
  asserts the registered handlers actually tint, so a rename on either side goes red.
- **Config** — `physics3DDemoConfig` (`runtime/config.ts`) is a bare `GameConfig`:
  `sceneSetup`/`initWorld` are no-ops; it just points `scenePath` at
  `physics-showcase.scene.json`. World gravity (`-9.81` Y) lives on the scene's `Physics3D`
  resource entity, live-editable in the Inspector.
- **Scenes** (`runtime/assets/scenes/`) — two:
  - **physics-showcase.scene.json** (default, 41 entities) — organised with `editorFolder`
    tags: `Setup` · `Level` · `Bodies` · `Joints/{Pendulum,Chain,Slider Test}` ·
    `Interaction` · `manual_test`. The 4 static walls are parented under an empty
    `Walls` transform group. Joints cover **revolute** (Pendulum), **spherical**
    (3-link Chain + the `manual_test` pendulum) and **prismatic** with travel limits
    (Slider Test). `Interaction` holds BOTH trigger stations: the *Sensor Zone* + its
    *Probe* at `x 8, z 0`, and the *Trigger Zone* + its *Zone Probe* at `x -9, z -8`.
  - **terrain-demo.scene.json** (55 entities) — a Terrain GLB with a trimesh
    (`.colmesh.glb`) collider and 49 balls raining onto it. No joints, no folders.
- **Assets** — the terrain model under `runtime/assets/models/terrain/` and nothing
  else; every other visible object is an engine primitive. No textures/HDR/audio/fonts.
  Provenance: [ATTRIBUTION.md](ATTRIBUTION.md).

## Gotchas (all cost real debugging time here)
- **Collider extents are ENTITY-LOCAL.** The runtime multiplies them by the entity's
  world scale (`makeColliderDesc`, `physics3DSystem.ts`) — the Unity
  `BoxCollider.size` vs `lossyScale` convention. A box primitive of `size: 1` under any
  scale wants half-extents of **0.5**, NOT the final visual half-size. Authoring the
  visual size double-scales it: this scene's Ramp once had an effective 49×25 collider
  covering the whole arena, and bodies rested 0.125 *inside* the visible floor.
- **A joint's limits/anchors are measured from where the anchor frames coincide**, not
  from the bodies' start pose. Two bodies 2 apart with default zero anchors silently
  lose 2 units of a joint's travel.
- **`playState` is NOT the physics state.** The editor reports `"playing"` with
  `advancing:true` at 60fps the moment a scene loads, but the Rapier world does not
  step until a transport **Play**. Verify physics by contacts/velocity after
  `play_control play` — and confirm `Time.frame` is advancing, because two identical
  samples can mean the clock is stopped, not that the body settled.
- **A directional light aims by `Transform` ROTATION, not by `Light.targetX/Y/Z`** —
  those trait fields are not read when aiming. A light with zero rotation points along
  −Z (horizontal) wherever you put it, so the floor renders black (its +Y normal is
  edge-on, N·L ≈ 0) while walls stay lit, and `castShadow` looks broken because the
  shadow map is cast edge-on. Both scenes here now carry an explicit rotation aiming
  the sun at the origin. Full detail: `docs/rendering.md` → Lights & Shadows.
- **A zone tests the occupant's POSITION — a point — not its volume.** `zoneTriggerCore`
  calls `contains(o.x, o.y, o.z)` on the occupant's world pose, so an occupant's own
  radius buys it nothing: it reads as inside strictly later, and outside strictly
  earlier, than the same object crossing an identically sized Rapier sensor. Measured in
  one run here: sensor occupied for ticks 63→74, zone for 64→71. Don't size a zone by
  eye against a sensor and expect the same window.
- **`ZoneOccupant` is opt-in, and a zone with no tagged occupant is silently inert.**
  Nothing errors — the Inspector shows a perfectly healthy `Zone3D` + `OnZone3D` that
  reacts to nothing. In this scene the tagged ones are the *Zone Probe* and the *Player*.
- **The Trigger Zone must NOT gain a `RigidBody3D`/`Collider3D`.** Its whole point is the
  station next to it doing the same job WITH one; adding a body makes the pair
  meaningless. `tests/zone-station.test.ts` fails if one appears.
- **`x -8` is the RAMP, not free floor.** The obvious mirror of the Sensor Zone's `x 8`
  drops a probe onto the tilted ramp, which rolls it to the far side of the arena — that
  is why the Trigger Zone sits at `x -9, z -8` instead of the symmetric spot.
- **`canSleep`** will freeze an undamped pendulum mid-swing. Set it false for a
  perpetual swing (the `manual_test` bob does).
- Parenting: a child with its own `RigidBody3D` stays independent, but a
  **collider-only** child under a body is silently adopted as a compound child.

## Identity & build
- appId `com.modokiengine.physics3ddemo`, appName "3D Physics Demo".
- **Native iOS + Android are committed here** (same arrangement as `demos/2d-physics-demo`):
  the folders live in the private repo, and `scripts/publish-demo.sh` **drops them from the
  public snapshot**, so the published demo is still web-only. (This entry used to say
  "web-only, no `ios/`/`android/` folders, and none should be added" — that is no longer the
  rule for this demo.)
- **iOS signing is a per-machine setting, not a repo one.** `build.appleTeamId` is a private
  build field: the committed `project.config.json` always holds `""`, and a real Team ID
  lives only in the gitignored `project.user.json`. So a fresh clone has none and iOS
  signing fails until you set one in **Project Settings → iOS → Signing**. Reading the
  committed file tells you nothing about whether anyone has signed this demo.
- Build/run: open in the Modoki Editor (**File → Open Project**), then **Build → Web**.

## Driving this project

This is a **Modoki** project — a Claude-friendly game engine where you, Claude, author
scene data, game logic, and asset wiring, while a human directs and reviews in the visual
editor. Open this folder in the Modoki Editor, then **AI → Connect Claude Code** wires an
`.mcp.json` for it — once connected, the editor exposes MCP tools that read and mutate the
*live* running project. Prefer them over screenshots: they prove an edit actually took
effect, not just that the file changed.

**Observe the running game — don't infer it from source.** `game.ts`/the scene JSON tell you
what this project is *designed* to do, not what it's doing right now — whether the sensor
fired, whether physics is actually stepping. If you're answering "did it work / why does it
look wrong" from a file read, that's a guess; call `modoki_get_scene_state` /
`modoki_journal` and cite what it returned.

**The verification loop:** read live state (`modoki_get_scene_state`) → mutate
(`modoki_mutate_scene` / `modoki_set_transform`) → verify the DATA again (cheap,
deterministic, tolerance not `===`) → verify PIXELS (`modoki_capture_viewport` / CDP) only
when you need to see the render itself. Never hand-write scene JSON; every asset ref is a
GUID from `modoki_list_assets`, not a literal path.

Modoki names its two tool families:
- **Percept** — verify by data, not vibes: `modoki_get_scene_state`, `modoki_journal`
  (tick-stamped events — here `zone` / `zoneTrigger` for the two stations' reactions, and
  the engine's own `@sensor` / `@zone` crossings), `modoki_diagnose` (NaN
  transforms, broken refs, orphaned entities in one call), `modoki_watch` (a live
  time-series on chosen entities/traits — e.g. contacts/velocities to confirm physics is
  actually stepping, not just `playState`).
- **Enact** — trusted input, like a human tester: `modoki_play_control` (play/stop/pause/
  step — physics does NOT step until an explicit transport **Play**), `modoki_tap`/`drag`/
  `hover`/`scroll`/`press_key` aimed by CSS `selector` or `x,y`.

The gotchas section above records this project's specific traps (collider scaling, joint
anchors, light aiming) — check there before re-deriving a fix from scratch. Full tool
catalog, conventions, and engine concepts: **https://modoki-engine.com**.
