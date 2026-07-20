import { trait } from 'koota';

/** 2D joint type (Rapier impulse joints).
 *  - `spring`    — soft distance spring between two anchor points (rest length + stiffness/damping).
 *  - `revolute`  — hinge/pin: the two anchors coincide, bodies free to rotate about it.
 *  - `prismatic` — slider: relative motion locked to an axis, rotation locked.
 *  - `fixed`     — weld: relative position + orientation locked.
 *  - `rope`      — max-distance: bodies may approach but not exceed `length`. */
export type JointType2D = 'spring' | 'revolute' | 'prismatic' | 'fixed' | 'rope';

/** A constraint between two `RigidBody2D` entities. Attach `Joint2D` to a THIRD
 *  entity (or either body) — it is not a body itself, just a link record. `entityA`/
 *  `entityB` are GUIDs (like `BoneAttachment.target`); the joint activates once both
 *  resolve to bodies. Anchors are local offsets (world units) on each body.
 *
 *  Unit notes (converted to Rapier's frame by physics2DJoints):
 *  - anchors/axis: world units, Y-down (flipped like Transform).
 *  - `length`: world units (spring rest / rope max).
 *  - revolute motor/limit values are ANGLES (radians); prismatic ones are DISTANCES
 *    (world units) along the axis. */
export const Joint2D = trait({
  type: 'spring' as JointType2D,
  entityA: '' as string, // GUID of body A
  entityB: '' as string, // GUID of body B
  // Local anchor on each body (world units). The joint constrains A's anchor point to
  // B's anchor point. For a `fixed` weld this means zero anchors COLLAPSE the two body
  // origins together — to weld two already-offset bodies, set an anchor equal to the
  // offset (e.g. B is 50 right of A → anchorBX = -50 so B's anchor meets A's origin).
  anchorAX: 0 as number,
  anchorAY: 0 as number,
  anchorBX: 0 as number,
  anchorBY: 0 as number,
  /** spring rest length / rope max length, world units. */
  length: 100 as number,
  /** spring stiffness + default motor position stiffness. */
  stiffness: 50 as number,
  /** spring damping + default motor damping. */
  damping: 5 as number,
  /** prismatic slide axis (direction, world units; normalized internally). */
  axisX: 1 as number,
  axisY: 0 as number,
  /** revolute (angle, radians) / prismatic (distance, world units) travel limits. */
  limitsEnabled: false as boolean,
  limitMin: 0 as number,
  limitMax: 0 as number,
  /** Drive the revolute/prismatic joint. Position drive when motorStiffness>0 (springs
   *  toward motorTargetPos), else velocity drive toward motorTargetVel. */
  motorEnabled: false as boolean,
  motorTargetVel: 0 as number,
  motorTargetPos: 0 as number,
  motorStiffness: 0 as number,
  motorDamping: 1 as number,
});
