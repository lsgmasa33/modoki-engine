<!-- Generated from CLAUDE.md by `npm run sync:agent-configs` — edit CLAUDE.md, not this file. -->

# 2d-physics-demo — Rapier2D physics showcase (scene-driven)

A near-code-free showcase project for the Modoki engine's **Rapier2D** physics layer: gravity,
restitution, static/dynamic colliders, revolute + spring joints, sensors, CCD, compound/concave
colliders, and a tiny platformer. Almost everything is **authored in scene JSON** (the scene is the
source of truth) — `initWorld`/`sceneSetup` are empty and there are no custom systems or traits.

## This project
- **Mechanics / systems** — the *only* game code is TWO PAIRS of `UIAction`s registered in
  `game.ts`, one per trigger station, each wired declaratively to its entity. Both tint the
  station's `Renderable2D` and `ctx.emit(...)` a journal event, so the reaction is verifiable
  from the event journal (body as a stable GUID via `entityRef`, not `id()`).
  - `sensorZone/enter|exit` — the *Sensor Zone*, via `OnCollision2D`. Rapier sensor; idle
    translucent yellow `0xf1c40f`/0.25 → occupied green `0x2ecc71`/0.5; journals `zone`.
  - `triggerZone/enter|exit` — the *Trigger Zone*, via `OnZone2D`. **No physics body at all**;
    idle purple `0x9b59b6`/0.25 → violet `0xd980fa`/0.5; journals `zoneTrigger`.
  Everything else — falling bodies, bouncing, pendulum, spring, trigger detection, player movement
  — is stock engine traits (`RigidBody2D`, `Collider2D`, joints, `CharacterController2D`).
- **This demo is the engine's ONLY real usage of the 2D declarative zone chain** (#296) —
  `Zone2D` + `ZoneOccupant` + the `@zone` journal event + `OnZone2D` (`demos/3d-physics-demo`
  carries the 3D half). Before it, the chain shipped in nothing, so a regression in it was caught
  by no project we ship. `tests/zone-station.test.ts` is the pinned fixture: it reads the action
  names OUT of the scene and asserts the registered handlers actually tint, so a rename on either
  side goes red.
- **Config knobs** — none. `runtime/config.ts` (`physicsDemoConfig`) just points `scenePath` at
  `physics-playground.scene.json` with empty `sceneSetup`/`initWorld`; there is no config resource trait.
- **Custom traits / UI / services** — none. No `runtime/setup.ts`, `systems.ts`, `traits.ts`, or
  `ui/`. The platformer's Credits dialog is plain ECS UI entities.
- **Scenes** — the starting scene is **`physics-playground.scene.json`** (floor + walls, three boxes,
  ghost/bouncy balls, pendulum anchor+bob+revolute joint, spring anchor+bob+joint, the Sensor Zone,
  and the Trigger Zone + its Zone Probe at `x 830`, right of the spring column).
  The others demonstrate one feature each: `ccd-tunneling` (CCD on vs off), `collider-mesh`
  (editable polygon ramp + polyline terrain), `compound-colliders` (table/cross/dumbbell),
  `concave-shapes` (bowl + dynamic boomerang), `platformer` (A/D move · Space jump). Gravity and
  layers (`Default`/`Ground`/`Ghost`, collision matrix `[3,7,2]`) come from the `Physics2D`
  singleton entity + `project.config.json`.

## Gotchas
- **A `Zone2D` takes its area from the Transform SCALE, and `Renderable2D` is scaled by that
  same Transform.** So the two are only identical if the sprite is authored `1x1`: the Trigger
  Zone is `sx 260, sy 30` with a `1x1` square, which renders 260x30 design px (measured via
  `get_scene_state?bounds=1`) and tests exactly that area. Authoring `width 260` under `sx 260`
  would draw a 67600px bar over a correctly-sized zone — the drawn area and the tested area
  desync silently, and only the drawn one is visible.
- **`ZoneOccupant` is opt-in, and a zone with no tagged occupant is silently inert.** Nothing
  errors — the Inspector shows a healthy `Zone2D` + `OnZone2D` reacting to nothing. Here the
  only tagged entity is the *Zone Probe*.
- **The Trigger Zone must NOT gain a `RigidBody2D`/`Collider2D`.** Its whole point is the
  station beside it doing the same job WITH one. `tests/zone-station.test.ts` fails if one appears.

## The character sprite — constraints worth knowing before you touch it
`runtime/assets/sprites/player.png` is a CC0 sheet (see `ATTRIBUTION.md`) packed into a uniform
6×2 grid of **192×320** cells, driven by `Player.spriteanim.json` (`idle` 2 frames · `walk` 6 ·
`jump` 2). `CharacterAnimator2D` picks the clip from motion state and flips facing via
`Renderable2D.flipX` — there is no clip-switching code in this project.

Three non-obvious constraints, all of which cause silent breakage if violated:

- **The cell aspect (~0.6), not the artwork, sets the character's on-screen size.** The Player's
  `Renderable2D` is 33×55 with `keepAspect: true`, so it fits the whole *cell* into that box.
  Repacking at a different aspect silently resizes the character.
- **Sheet dimensions must stay multiples of 4.** Block-compressed KTX2 requires it; non-multiple-of-4
  with mipmaps renders solid black on Adreno GPUs.
- **All clips must share one scale factor**, or the character visibly changes size when switching
  between idle, walk and jump. The `jump-fall` frame is the widest and therefore binds it.

`jump` uses `mode: "once"` so it holds the falling frame while airborne rather than looping a
two-frame flicker.

## Identity & build
- appId `com.modokiengine.physicsdemo`.
- Web-only as published; the private repo keeps iOS + Android projects that the publish snapshot
  drops.
- Open it with the Modoki editor's **Open Project**, or `MODOKI_PROJECT=demos/2d-physics-demo`.

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

Full tool catalog, conventions, and engine concepts: **https://modoki-engine.com**.
