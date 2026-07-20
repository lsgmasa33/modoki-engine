import { trait } from 'koota';

/** CharacterController3D — a kinematic, gravity-obeying player controller driven by Rapier's
 *  KinematicCharacterController (collide-and-slide + autostep + slope limits + snap-to-ground).
 *  Pair with a **kinematic** `RigidBody3D` + a `Collider3D` (capsule recommended). The physics
 *  system reads the INPUT fields each tick, computes a collision-safe movement, moves the body,
 *  and writes the READBACK fields.
 *
 *  Horizontal movement is on the XZ plane (`moveX`/`moveZ`); +Y is up (gravity pulls down, jump
 *  launches up) — no axis flip, unlike the 2D controller. Determinism: the controller reads only
 *  trait fields (never the DOM), so a headless test drives it by setting `moveX`/`moveZ`/`jump`.
 *  In the live app a 3D input system maps keys onto those fields. */
export const CharacterController3D = trait({
  /** Horizontal move speed, world units/s (scaled by `moveX`/`moveZ`). */
  speed: 5 as number,
  /** Initial upward speed of a jump, world units/s. */
  jumpSpeed: 6 as number,
  /** Multiplier on world gravity for this character's fall. */
  gravityScale: 1 as number,
  /** Steepest slope (degrees from flat) the character can walk up. */
  maxSlopeClimbDeg: 46 as number,
  /** Slopes steeper than this (degrees) make a grounded character slide down. */
  minSlopeSlideDeg: 30 as number,
  /** Max step height auto-climbed (world units; 0 = no autostep). */
  autostepHeight: 0 as number,
  /** Min free width required after a step (world units). */
  autostepMinWidth: 0 as number,
  /** Snap to ground within this distance when walking off a small ledge (world units;
   *  0 = no snap). Keeps the character glued to stairs/ramps instead of launching. */
  snapToGroundDist: 0 as number,
  /** Collision skin gap kept around the character (world units). Small & non-zero. */
  skin: 0.02 as number,

  /** INPUT: X axis, -1 … +1 (world X). Set by input/actions. runtimeOnly. */
  moveX: 0 as number,
  /** INPUT: Z axis, -1 … +1 (world Z). Set by input/actions. runtimeOnly. */
  moveZ: 0 as number,
  /** INPUT: request a jump this frame (consumed when grounded). runtimeOnly. */
  jump: false as boolean,

  /** READBACK: is the character standing on ground this frame? runtimeOnly. */
  grounded: false as boolean,
  /** READBACK: vertical velocity, world units/s (+up, -down). runtimeOnly. */
  velY: 0 as number,
  /** READBACK: has the physics controller written `grounded`/`velY` at least once since
   *  spawn? False until the first physics step (physics runs AFTER game systems), so consumers
   *  can distinguish a real "airborne" readback from the default-`false` `grounded`. runtimeOnly. */
  readbackReady: false as boolean,
});
