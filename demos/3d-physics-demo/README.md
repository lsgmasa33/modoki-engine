# 3D Physics Demo — Modoki

![The physics showcase scene: a walled arena with a ramp, a crate stack, assorted
primitive-collider bodies casting shadows on the floor, and jointed bodies hanging
above it](screenshot.png)

A showcase of the [Modoki](https://modoki-engine.com) engine's **Rapier3D** physics
layer, built almost entirely as scene data. Gravity, restitution, stacking, every
primitive collider shape, three kinds of joint, a character controller, a sensor
trigger, a physics-free `Zone3D` trigger volume, and a trimesh terrain collider — with
**69 lines of game code** in total.

That is the point of the demo: the physics is the *engine's*, not the game's. If you
want to see what Modoki gives you before you write anything, start here.

## Running it

You need the **Modoki Editor** ([download](https://modoki-engine.com)). This project
is not a standalone npm app — the editor supplies the engine, the dev server, and the
build pipeline.

1. Open the editor.
2. **File → Open Project**, and pick this folder.
3. Press **Play** in the toolbar.

To produce a web build, use **Build → Web** in the editor.

> Physics does not step until you press **Play**. On load the editor reports its run
> state as "playing" (that is the frame loop), but the Rapier world is not advancing —
> bodies sit at their authored positions until you actually start the simulation.

## What's in it

Two scenes, switchable from the Assets panel.

### `physics-showcase.json` — the main scene

| Group | What it demonstrates |
|---|---|
| **Level** | A floor and four walls (parented under an empty `Walls` transform group), plus a tilted static ramp |
| **Bodies** | A ball rolling down the ramp, a 3-crate stack, a bouncy ball (restitution), and one of every primitive collider — box, sphere, capsule, cylinder, cone |
| **Joints / Pendulum** | A `revolute` hinge — a bob swinging in a fixed plane |
| **Joints / Chain** | Three `spherical` ball-joints in series, hanging and swaying |
| **Joints / Slider Test** | A `prismatic` slider with travel limits — the body slides along one axis only and stops mid-air at its limit |
| **manual_test** | A second `spherical` pendulum, free to swing in any direction |
| **Interaction** | A kinematic `CharacterController3D` player, a Rapier **sensor** volume that reacts when a probe passes through it, and a **Trigger Zone** — the same reaction with no physics body at all |

### `terrain-demo.json`

49 balls raining onto a **trimesh** terrain collider generated from a separate,
lower-density collision mesh — the pattern you want for irregular static geometry,
where a primitive collider would be a poor fit.

## The only game code

Two pairs of `UIAction`s registered in `game.ts`, wired declaratively to the two
trigger stations. On enter/exit they tint the station and emit a journal event, so the
reaction can be verified as **data** rather than by eye:

```ts
ctx.emit('zone', { phase, body })   // body is a stable GUID, not a runtime id
```

Everything else — falling, bouncing, stacking, joints, character movement, trigger
detection — is stock engine traits driven by the scene file.

### Two ways to detect "something is in here", side by side

The arena carries both, so you can pick by what you actually need:

| | **Sensor Zone** (teal, right) | **Trigger Zone** (violet, left) |
|---|---|---|
| Traits | `RigidBody3D` + `Collider3D{isSensor}` + `OnCollision3D` | `Zone3D` + `OnZone3D` |
| Costs a Rapier body | yes | **no** |
| Detects | anything with a collider | anything tagged `ZoneOccupant` (opt-in) |
| Tests against | the other body's **collider volume** | the occupant's **position** — a point |

A zone is the cheaper answer for the "is X inside this region" questions that don't
need a solver — checkpoints, spawn and kill regions, camera triggers, cutscene starts.
Because it tests a point, an occupant registers as inside slightly later and leaves
slightly earlier than the same object would through a sensor — the difference being
roughly the occupant's own radius at each face. Both probes fall the same distance into
identically sized volumes here, and one measured run has the sensor occupied for 11
ticks against the zone's 7. (Treat that as an illustration, not a constant: the exact
tick counts move a little between runs.)

## Concepts worth stealing

- **The scene is the source of truth.** `initWorld` and `sceneSetup` are empty. Resizing
  the arena or retuning a joint is a scene edit, never a code change.
- **Collider extents are entity-local.** The runtime multiplies them by the entity's
  world scale, exactly like Unity's `BoxCollider.size` vs `lossyScale`. A box primitive
  of `size: 1` under any scale wants half-extents of `0.5` — *not* the final visual
  half-size, or you get a collider that silently doesn't match the mesh.
- **A joint's limits and anchors are measured from where its anchor frames coincide**,
  not from where the bodies happen to start. Two bodies 2 units apart with default zero
  anchors quietly lose 2 units of a joint's travel.
- **Parent groups are for organisation, not physics.** The `Walls` group is a bare
  transform. A child carrying its own `RigidBody3D` stays an independent body, but a
  *collider-only* child under a body is silently absorbed as a compound child.
- **Verify by data.** The `zone` / `zoneTrigger` journal events — and the engine's own
  `@zone` crossings — make the demo assertable in a headless test, no screenshots
  required. `tests/zone-station.test.ts` does exactly that.

## Assets

No third-party assets. The terrain meshes are original work; everything else is an
engine primitive. See [ATTRIBUTION.md](ATTRIBUTION.md).

## Licence

[MIT](LICENSE) — take any of this, including the scenes and the terrain meshes, and
use it however you like. It is sample code; that is the point.

Note the **engine** itself is licensed separately (Apache-2.0); this licence covers
only the contents of this repository.
