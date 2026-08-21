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
  - `sensorZone/enter|exit` — the *Sensor Zone*, via `OnCollision2D`. Rapier sensor; authored
    translucent yellow → green `0x2ecc71`/0.5 while occupied; journals `zone`.
  - `triggerZone/enter|exit` — the *Trigger Zone*, via `OnZone2D`. **No physics body at all**;
    authored translucent purple → violet `0xd980fa`/0.5 while occupied; journals `zoneTrigger`.
  - ⚠️ **The IDLE tint is authored in the scene and is NOT a code constant.** `tintOnEnter`
    remembers what the station actually holds and `restoreOnExit` puts that back, so
    re-colouring a station in the Inspector survives — a hardcoded idle would silently
    overwrite the owner's edit on the very next exit. The `*_FALLBACK` pairs are no-scene
    fallbacks only.
  - ⚠️ **That stash is PER-SESSION state, and both of its hazards are subtle enough to have
    shipped once already.** (a) It tracks WHO is inside, not HOW MANY: pressing Stop clears
    the engine's occupancy *without* firing exits (`clearZoneState`), so a station occupied
    at Stop gets a second `enter` with no matching `exit` — a counter climbs to 2, never
    returns to 0, and the station stays lit forever. A set of occupant ids is idempotent
    under that duplicate and self-heals. (b) It is cleared on `onWorldSwap`, because Stop
    rebuilds the world and `entity.id()` is a per-world SLOT INDEX that restarts at 0 — the
    next session hands the same ids to the same entities, so an uncleared stash would skip
    re-reading the authored tint and later restore the PREVIOUS session's value. Both are
    pinned by tests in `tests/zone-station.test.ts`.
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
- **`Renderable2D.width`/`height` are HALF-extents, and the Transform scale multiplies them.**
  Drawn size is `width * 2 * sx` by `height * 2 * sy`. A `Zone2D` box's TESTED area, by
  contrast, is the scale itself (full size), so the two agree only when the sprite is `0.5`:
  the Trigger Zone is `sx 260, sy 30` with a `0.5 x 0.5` square, measured at 171.9 screen px =
  260 design px via `get_scene_state?bounds=1`. `width: 1` there draws **520** over a zone that
  tests 260, and the bar overhangs the arena wall — caught only by regenerating the screenshot,
  because the drawn half is the only half you can see.
- **The same half-extent rule is why a circle's `width` equals its collider RADIUS, not its
  diameter.** The Bouncy Ball is `width 45` / `radius 45`; the Zone Probe is `width 15` /
  `radius 15`. Authoring `width 30` over `radius 15` draws a ball at twice its physical size.
- ⚠️ **Pre-existing, NOT introduced by the zone work: the Sensor Zone's bar is wider than its
  sensor.** `width 400` draws 800 design px while `Collider2D.halfW 170` only detects 340 — so
  the yellow bar advertises more than twice the area that actually triggers. Left alone because
  changing it changes a published demo's look; worth a decision rather than a silent fix.
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
