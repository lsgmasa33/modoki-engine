# 3d-physics-demo — Rapier3D physics showcase (scene-driven)

**A curated, publishable Modoki demo.** It ships as its own public repo, so it stays
self-contained and free of third-party assets. The public-facing doc is
[README.md](README.md); this file is the agent-facing one and travels with the demo.

A near-content-only project exercising the engine's Rapier3D layer: gravity,
restitution, rolling, a stacked tower, every primitive collider, three joint types, a
character controller, a sensor trigger, and a trimesh terrain collider. Almost
everything is authored in the scenes — **the scene is the source of truth**
(`config.ts` does no `initWorld` spawning).

## This project
- **Mechanics / systems** — the ONLY game code is two `UIAction`s registered in
  `game.ts` (`sensorZone3D/enter` / `sensorZone3D/exit`), wired declaratively to the
  *Sensor Zone* entity via its `OnCollision3D` trait. On enter/exit they tint the
  zone's `Renderable3DPrimitive` (teal `0x1abc9c` → green `0x2ecc71`) and
  `ctx.emit('zone', {phase, body})` a journal event (body as a hot-reload-stable GUID
  via `entityRef()`) so the reaction is verifiable by data (`modoki_journal`), not by
  eye. `unregisterSystems` tears both down. No custom traits, no config knobs, no
  custom UI.
- **Config** — `physics3DDemoConfig` (`runtime/config.ts`) is a bare `GameConfig`:
  `sceneSetup`/`initWorld` are no-ops; it just points `scenePath` at
  `physics-showcase.json`. World gravity (`-9.81` Y) lives on the scene's `Physics3D`
  resource entity, live-editable in the Inspector.
- **Scenes** (`runtime/assets/scenes/`) — two:
  - **physics-showcase.json** (default, 39 entities) — organised with `editorFolder`
    tags: `Setup` · `Level` · `Bodies` · `Joints/{Pendulum,Chain,Slider Test}` ·
    `Interaction` · `manual_test`. The 4 static walls are parented under an empty
    `Walls` transform group. Joints cover **revolute** (Pendulum), **spherical**
    (3-link Chain + the `manual_test` pendulum) and **prismatic** with travel limits
    (Slider Test).
  - **terrain-demo.json** (55 entities) — a Terrain GLB with a trimesh
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
- **`canSleep`** will freeze an undamped pendulum mid-swing. Set it false for a
  perpetual swing (the `manual_test` bob does).
- Parenting: a child with its own `RigidBody3D` stays independent, but a
  **collider-only** child under a body is silently adopted as a compound child.

## Identity & build
- appId `com.modokiengine.physics3ddemo`, appName "3D Physics Demo".
- **Web-only.** No `ios/`/`android/` folders, and none should be added — demos ship
  web-only so no signing identity, Firebase config, or ad ids can travel with them.
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
  (tick-stamped events — here the `zone` enter/exit reaction), `modoki_diagnose` (NaN
  transforms, broken refs, orphaned entities in one call), `modoki_watch` (a live
  time-series on chosen entities/traits — e.g. contacts/velocities to confirm physics is
  actually stepping, not just `playState`).
- **Enact** — trusted input, like a human tester: `modoki_play_control` (play/stop/pause/
  step — physics does NOT step until an explicit transport **Play**), `modoki_tap`/`drag`/
  `hover`/`scroll`/`press_key` aimed by CSS `selector` or `x,y`.

The gotchas section above records this project's specific traps (collider scaling, joint
anchors, light aiming) — check there before re-deriving a fix from scratch. Full tool
catalog, conventions, and engine concepts: **https://modoki-engine.com**.
