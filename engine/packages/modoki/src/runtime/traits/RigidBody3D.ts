import { trait } from 'koota';

/** Body type — mirrors Rapier's RigidBodyType (see physics3DSystem).
 *  - `dynamic`   — moved by the solver (gravity, forces, collisions). Rapier owns its Transform.
 *  - `static`    — never moves under simulation (walls, ground, terrain). Its Transform drives Rapier.
 *  - `kinematic` — moved by game/animation code, not forces; pushes dynamic bodies. */
export type BodyType3D = 'dynamic' | 'static' | 'kinematic';

/** The *motion* half of a 3D physics entity (pair with `Collider3D` for a shape).
 *  Linear velocity is in world units/s, angular velocity in radians/s — both in the
 *  Three.js frame (right-handed, +Y up), the SAME space as Transform. Unlike the 2D
 *  side there is NO axis flip: ECS and Rapier3D are both right-handed Y-up, so the
 *  physics system only scales lengths by `Physics3D.unitsPerMeter` (default 1) and
 *  converts Transform's Euler `rx/ry/rz` ↔ Rapier's quaternion.
 *  The velocity fields are read-back each frame for dynamic bodies (runtimeOnly). */
export const RigidBody3D = trait({
  bodyType: 'dynamic' as BodyType3D,
  /** Linear velocity, world units/s. Read-back for dynamic bodies. */
  vx: 0 as number,
  vy: 0 as number,
  vz: 0 as number,
  /** Angular velocity, radians/s (per world axis). Read-back for dynamic bodies. */
  avx: 0 as number,
  avy: 0 as number,
  avz: 0 as number,
  linearDamping: 0 as number,
  angularDamping: 0 as number,
  /** Per-body gravity multiplier (0 = float, 1 = full world gravity). */
  gravityScale: 1 as number,
  /** Lock ALL rotation axes — the body translates but never spins (upright characters,
   *  roll-free crates). Equivalent to setting lockRotX/Y/Z all true; takes precedence. */
  fixedRotation: false as boolean,
  /** Per-axis rotation locks — freeze spin about a specific WORLD axis (e.g. lock X+Z so a
   *  body can only yaw about Y). Ignored per-axis if `fixedRotation` locks everything. */
  lockRotX: false as boolean,
  lockRotY: false as boolean,
  lockRotZ: false as boolean,
  /** Per-axis translation locks — freeze motion along a WORLD axis (e.g. lock Y so a body
   *  slides on a plane but never falls; lock X+Z for a pure vertical elevator). */
  lockTransX: false as boolean,
  lockTransY: false as boolean,
  lockTransZ: false as boolean,
  /** Continuous collision detection — for fast/thin bodies that would tunnel. */
  ccd: false as boolean,
  /** Allow the body to sleep when at rest (cheaper). */
  canSleep: true as boolean,
  /** Runtime read-back (Percept): the solver has put this body to sleep (at rest).
   *  Not authored — mirrored from Rapier each frame; runtimeOnly (not serialized). */
  isSleeping: false as boolean,
});
