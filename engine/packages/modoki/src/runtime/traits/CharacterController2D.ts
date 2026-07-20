import { trait } from 'koota';

/** CharacterController2D — a kinematic, gravity-obeying player controller driven by Rapier's
 *  KinematicCharacterController (collide-and-slide + autostep + slope limits + snap-to-ground).
 *  Pair with a **kinematic** `RigidBody2D` + a `Collider2D` (box/capsule). The physics system
 *  reads the INPUT fields each tick, computes a collision-safe movement, moves the body, and
 *  writes the READBACK fields.
 *
 *  Determinism: the controller reads only trait fields (never the DOM), so a headless test
 *  drives it by setting `moveX`/`jump` (e.g. via a dispatched action). In the live app the
 *  engine's `characterInputSystem` maps the InputManager's keys onto those fields. */
export const CharacterController2D = trait({
  /** Horizontal move speed, world units/s (scaled by `moveX`). */
  speed: 300 as number,
  /** Initial upward speed of a jump, world units/s. */
  jumpSpeed: 650 as number,
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
  skin: 2 as number,

  /** INPUT: horizontal axis, -1 (left) … +1 (right). Set by input/actions. runtimeOnly. */
  moveX: 0 as number,
  /** INPUT: request a jump this frame (consumed when grounded). runtimeOnly. */
  jump: false as boolean,

  /** READBACK: is the character standing on ground this frame? runtimeOnly. */
  grounded: false as boolean,
  /** READBACK: vertical velocity, world units/s, screen-down positive. runtimeOnly. */
  velY: 0 as number,
  /** READBACK: has the physics controller written `grounded`/`velY` at least once
   *  since spawn? False until the first physics step, so consumers can tell a real
   *  "airborne" readback from the default-`false` `grounded` that leaks through on
   *  the first frame (physics runs AFTER game systems). runtimeOnly. */
  readbackReady: false as boolean,
});
