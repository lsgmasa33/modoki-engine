# 2D Physics Demo — Modoki

![The physics playground scene: a walled arena holding a stack of coloured boxes and a
resting ball, falling balls above, a translucent yellow sensor zone spanning the middle,
and a shorter violet Zone2D trigger bar to its lower right with its probe resting on the
floor beneath it](screenshot.png)

A showcase of the [Modoki](https://modoki-engine.com) engine's **Rapier2D** physics
layer, built almost entirely as scene data. Gravity, restitution, revolute and spring
joints, sensor triggers, continuous collision detection, compound and concave colliders,
and a small platformer — with **two `UIAction`s** of game code in total.

That is the point of the demo: the physics is the *engine's*, not the game's. If you
want to see what Modoki gives you in 2D before writing anything, start here.

## Running it

You need the **Modoki Editor** ([download](https://modoki-engine.com)). This project is
not a standalone npm app — the editor supplies the engine, the dev server, and the build
pipeline.

1. Open the editor.
2. **File → Open Project**, and pick this folder.
3. Press **Play** in the toolbar.

To produce a web build, use **Build → Web** in the editor.

> Physics does not step until you press **Play**. On load the editor reports its run
> state as "playing" (that is the frame loop), but the Rapier world is not advancing —
> bodies sit at their authored positions until you actually start the simulation.

## What's in it

Six scenes, switchable from the Assets panel. Each isolates one idea.

| Scene | What it demonstrates |
|---|---|
| **`physics-playground.json`** *(default)* | The overview: floor and walls, falling boxes, a bouncy ball (restitution) and a "ghost" ball on a non-colliding layer, a **revolute** pendulum, a **spring** joint, and two trigger stations that change colour while occupied — a Rapier **sensor** and a physics-free **`Zone2D`** |
| **`ccd-tunneling.json`** | Two fast bodies fired at a thin wall — one with continuous collision detection, one without. The one without passes straight through |
| **`collider-mesh.json`** | Hand-authored collider geometry: a **polygon** ramp and a **polyline** terrain, both editable vertex-by-vertex in the editor viewport |
| **`compound-colliders.json`** | One rigid body owning several child colliders — a table, a cross, a dumbbell. A two-footed body straddles a gap that a single centred box falls through |
| **`concave-shapes.json`** | Automatic convex decomposition: a bowl that actually holds balls, and a dynamic boomerang |
| **`platformer.json`** | A `CharacterController2D` player — **A/D** to move, **Space** to jump — with sprite animation and a Credits dialog built from ECS UI entities |

![The platformer scene: a cartoon character standing on a ground strip, with a
three-tier staircase, a floating blue platform and a red wall to the right](screenshot-platformer.png)

## Collision layers

The playground uses three named layers with a collision matrix, set on the `Physics2D`
singleton entity rather than in code:

- `Ground` — the floor and walls
- `Default` — the boxes and the bouncy ball
- `Ghost` — passes through `Default` bodies but still lands on `Ground`

Named layers mean a designer changes what collides with what by editing a matrix, not by
computing bitmasks.

## The only game code

Two pairs of `UIAction`s registered in `game.ts`, wired declaratively to the two trigger
stations. On enter/exit they tint the station and emit a journal event, so the reaction
can be verified as **data** rather than by eye:

```ts
ctx.emit('zone', { phase, body })   // body is a stable GUID, not a runtime id
```

Everything else — falling, bouncing, the pendulum, the spring, trigger detection, player
movement and animation — is stock engine traits driven by the scene files.

### Two ways to detect "something is in here", side by side

The playground carries both, so you can pick by what you actually need:

| | **Sensor Zone** (yellow bar) | **Trigger Zone** (violet bar) |
|---|---|---|
| Traits | `RigidBody2D` + `Collider2D{isSensor}` + `OnCollision2D` | `Zone2D` + `OnZone2D` |
| Costs a Rapier body | yes | **no** |
| Detects | anything with a collider | anything tagged `ZoneOccupant` (opt-in) |
| Tests against | the other body's **collider volume** | the occupant's **position** — a point |

A zone is the cheaper answer for the "is X inside this region" questions that don't need
a solver — checkpoints, spawn and kill regions, camera triggers, cutscene starts.

## Concepts worth stealing

- **The scene is the source of truth.** `initWorld` and `sceneSetup` are empty. Moving a
  wall or retuning a joint is a scene edit, never a code change.
- **Character animation is declarative.** `CharacterAnimator2D` maps controller motion
  state onto `idle`/`walk`/`jump` clips and flips facing via `Renderable2D.flipX`. There
  is no clip-switching code in this project.
- **A sprite sheet's *cell* aspect sets on-screen size**, not the artwork inside it.
  `Renderable2D` with `keepAspect: true` fits the whole cell into its box, so repacking a
  sheet at a different aspect silently resizes the character.
- **Sensors are events, not collisions.** A sensor collider produces enter/exit events
  with no solver response — which is why the zone can react without disturbing the bodies
  passing through it.
- **A `Zone2D` needs no physics at all.** It is a pure geometric area whose extent *is* the
  entity's Transform scale, so the Trigger Zone carries no `RigidBody2D` and no `Collider2D`.
- **`Renderable2D` sizes are HALF-extents, and the Transform scale multiplies them** — a
  sprite draws `width * 2 * sx` wide. A `Zone2D` tests the scale itself, so the drawn bar
  matches the tested area only at `0.5`. Get it wrong and the visual silently advertises an
  area the logic does not test, which is the half you cannot see.
- **A reaction restores what was AUTHORED, not a constant.** Both stations remember the
  tint the scene holds when the first occupant arrives and put it back when the last one
  leaves, so re-colouring a station in the editor survives play. Writing a hardcoded idle
  colour back instead is the quiet way to overwrite someone's edit. (It is refcounted for
  the same reason: a volume can hold more than one occupant.)
- **Verify by data.** The `zone` / `zoneTrigger` journal events — and the engine's own
  `@zone` crossings — make the demo assertable in a headless test, no screenshots
  required. `tests/zone-station.test.ts` does exactly that.

## Assets

One third-party asset: the character sprite sheet, which is **CC0** (public domain). See
[ATTRIBUTION.md](ATTRIBUTION.md). Everything else — scenes, colliders, joints, UI — is
original work.

## Licence

[MIT](LICENSE) — take any of this, including the scenes, and use it however you like. It
is sample code; that is the point.

Note the **engine** itself is licensed separately (Apache-2.0); this licence covers only
the contents of this repository.
