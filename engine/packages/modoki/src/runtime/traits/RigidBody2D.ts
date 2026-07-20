import { trait } from 'koota';

/** Body type — mirrors Rapier's RigidBodyType (see physics2DSystem).
 *  - `dynamic`   — moved by the solver (gravity, forces, collisions). Rapier owns its Transform.
 *  - `static`    — never moves under simulation (walls, ground). Its Transform drives Rapier.
 *  - `kinematic` — moved by game/animation code, not forces; pushes dynamic bodies. */
export type BodyType2D = 'dynamic' | 'static' | 'kinematic';

/** The *motion* half of a 2D physics entity (pair with `Collider2D` for a shape).
 *  Velocities are in world units/s and radians/s (screen frame, Y-down); the physics
 *  system converts them to Rapier's meter/Y-up frame via `Physics2D.pixelsPerMeter`.
 *  The velocity fields are read-back each frame for dynamic bodies (runtimeOnly). */
export const RigidBody2D = trait({
  bodyType: 'dynamic' as BodyType2D,
  /** Linear velocity, world units/s (screen frame). Read-back for dynamic bodies. */
  vx: 0 as number,
  vy: 0 as number,
  /** Angular velocity, radians/s. Read-back for dynamic bodies. */
  angularVel: 0 as number,
  linearDamping: 0 as number,
  angularDamping: 0 as number,
  /** Per-body gravity multiplier (0 = float, 1 = full world gravity). */
  gravityScale: 1 as number,
  /** Lock rotation — the body translates but never spins (top-down characters). */
  fixedRotation: false as boolean,
  /** Continuous collision detection — for fast/thin bodies that would tunnel. */
  ccd: false as boolean,
  /** Allow the body to sleep when at rest (cheaper). */
  canSleep: true as boolean,
  /** Runtime read-back (Percept): the solver has put this body to sleep (at rest).
   *  Not authored — mirrored from Rapier each frame; runtimeOnly (not serialized). */
  isSleeping: false as boolean,
});
