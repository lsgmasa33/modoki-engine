import { trait } from 'koota';

/** 3D joint type (Rapier impulse joints).
 *  - `spring`    — soft distance spring between two anchor points (rest length + stiffness/damping).
 *  - `spherical` — ball joint: the two anchors coincide, bodies free to rotate in ALL 3 axes (ragdolls, chains).
 *  - `revolute`  — hinge: anchors coincide, rotation free about ONE axis only (doors, wheels).
 *  - `prismatic` — slider: relative motion locked to an axis, rotation locked (elevators, pistons).
 *  - `fixed`     — weld: relative position + orientation locked.
 *  - `rope`      — max-distance: bodies may approach but not exceed `length`. */
export type JointType3D = 'spring' | 'spherical' | 'revolute' | 'prismatic' | 'fixed' | 'rope';

/** A constraint between two `RigidBody3D` entities. Attach `Joint3D` to a THIRD entity
 *  (or either body) — it is not a body itself, just a link record. `entityA`/`entityB` are
 *  GUIDs (like `BoneAttachment.target`); the joint activates once both resolve to bodies.
 *  Anchors are local offsets (world units) on each body.
 *
 *  Unit notes (converted to Rapier's frame by physics3DSystem; NO axis flip — 3D is
 *  right-handed Y-up like Rapier):
 *  - anchors/axis: world units, scaled by `Physics3D.unitsPerMeter`.
 *  - `length`: world units (spring rest / rope max).
 *  - revolute motor/limit values are ANGLES (radians about `axis`); prismatic ones are
 *    DISTANCES (world units) along `axis`. Motors/limits apply to revolute + prismatic only. */
export const Joint3D = trait({
  type: 'spherical' as JointType3D,
  entityA: '' as string, // GUID of body A
  entityB: '' as string, // GUID of body B
  // Local anchor on each body (world units). The joint constrains A's anchor point to B's
  // anchor point. For a `fixed` weld, zero anchors COLLAPSE the two body origins together —
  // to weld two already-offset bodies, set an anchor equal to the offset.
  anchorAX: 0 as number,
  anchorAY: 0 as number,
  anchorAZ: 0 as number,
  anchorBX: 0 as number,
  anchorBY: 0 as number,
  anchorBZ: 0 as number,
  /** spring rest length / rope max length, world units. */
  length: 1 as number,
  /** spring stiffness + default motor position stiffness. */
  stiffness: 50 as number,
  /** spring damping + default motor damping. */
  damping: 5 as number,
  /** revolute hinge / prismatic slide axis (direction, world units; normalized internally). */
  axisX: 0 as number,
  axisY: 1 as number,
  axisZ: 0 as number,
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
