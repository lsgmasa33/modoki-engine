/** physics2DSystem — the ECS ↔ Rapier2D reconciler (Phase 1).
 *
 *  Runs at SYSTEM_PRIORITY.PHYSICS (175): after game logic + animation (which set
 *  velocities / drive kinematic bodies) and before transform propagation (200), so
 *  children follow post-physics positions. The pipeline already skips it when the
 *  sim isn't running (priority < TRANSFORM), so there is no physics while Stopped/
 *  Paused — consistent with the skeletal-animation rule.
 *
 *  Rapier is retained-mode (a World of bodies addressed by integer handles); the ECS
 *  is the source of truth. So each tick this system RECONCILES: entities that gained
 *  RigidBody2D get a Rapier body; despawned/changed ones are freed; kinematic/static
 *  bodies are pushed ECS→Rapier; dynamic bodies are pulled Rapier→ECS; and collision/
 *  sensor events are drained into the journal (`emit`).
 *
 *  Determinism: dt comes from `getSimDelta` (fixed under the harness); Rapier takes
 *  it via `world.timestep` and never reads a clock itself. Play→Stop discards the
 *  Rapier world (see the onPlayStateChange hook) so the next Play rebuilds fresh from
 *  the reverted authored transforms. */

import type { World, Entity } from 'koota';
import { Transform } from '../traits/Transform';
import { RigidBody2D, type BodyType2D } from '../traits/RigidBody2D';
import { Collider2D } from '../traits/Collider2D';
import { EntityAttributes } from '../traits/EntityAttributes';
import { CharacterController2D } from '../traits/CharacterController2D';
import { Physics2D } from '../traits/Physics2D';
import { Joint2D, type JointType2D } from '../traits/Joint2D';
import { OnCollision2D } from '../traits/OnCollision2D';
import { getSimDelta } from './getTime';
import { findEntityByGuid, getCurrentWorld } from '../ecs/world';
import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { getWorldTransform3D } from '../ecs/worldTransform';
import { createPhysicsWorldRegistry } from './physicsWorldRegistry';
import { physics2DEvents } from '../managers/Physics2DEvents';
import { makeFireOnCollision, drainContactEvents, synthesizeContactExits, refOf, type ColliderInfo } from './physicsContactEvents';
import { dropEntityFromContactIndex } from './physicsContactIndex';
import { emit, isVerboseCaptureActive } from './journal';
import { initRapier2D, isRapierReady, getRapier, type Rapier } from './rapierLoader';
import {
  vecEcsToPhys, vecPhysToEcs, vecEcsToPhysInto, vecPhysToEcsInto,
  angEcsToPhys, angPhysToEcs, lenToPhys, packCollisionGroups, parsePointsToPhys,
  type Vec2,
} from './physics2DConvert';
import { resolveColliderBits } from './physicsLayers';
import { decomposeConcaveToPhys } from './concaveDecomp';
import { colliderGeomSig as geomSigOf, type ColliderShapeParams } from '../rendering/colliderOutline2D';

interface PhysicsConfig { gravityX: number; gravityY: number; ppm: number }

interface BodyRec {
  entityId: number;
  /** koota generation for this id — a change means the id was recycled onto a NEW
   *  entity, so the body must be rebuilt (not silently adopted by the newcomer). */
  entityGen: number;
  bodyHandle: number;
  /** Every collider handle attached to this body — the body's OWN Collider2D (if any)
   *  plus each adopted child (compound). Used to drop the collider→entity map entries on
   *  rebuild/removal. Empty for a body with no colliders at all. */
  colliderHandles: number[];
  bodyType: BodyType2D;
  /** Structural (GEOMETRY) signature — a change (bodyType, own/child collider shape or
   *  child offset) rebuilds the body. Material/filters are tracked by `matSig` instead. */
  sig: string;
  /** Material/filter signature (own + children). A change re-applies material in place
   *  (applyBodyMaterial) — no rebuild, so the collision-event stream stays exit/enter balanced. */
  matSig: string;
  /** Last pushed static/kinematic pose, to avoid redundant Rapier writes. */
  lastX: number; lastY: number; lastAng: number;
}

/** A SOLO (parentless) static collider: a Collider2D on an entity with NO RigidBody2D of its
 *  own AND no body parent. Rapier supports a collider without a parent rigid-body — it behaves
 *  as fixed world geometry (collides + fires events), so authored static geometry needs no dummy
 *  body. Placed at the entity's WORLD pose; rebuilt when its geometry/pose/scale changes. */
interface SoloColliderRec {
  entityId: number;
  entityGen: number;
  colliderHandles: number[];
  sig: string;               // geometry + WORLD pose + WORLD scale — change ⇒ rebuild
  matSig: string;            // material/filter — change ⇒ apply-in-place
}

interface PhysicsWorldState {
  R: Rapier;
  world: import('@dimforge/rapier2d-compat').World;
  eventQueue: import('@dimforge/rapier2d-compat').EventQueue;
  bodies: Map<number, BodyRec>;
  /** entityId → parentless fixed-collider record (a Collider2D with no body of its own/parent). */
  soloColliders: Map<number, SoloColliderRec>;
  /** colliderHandle → { entityId, entity, isSensor } for mapping Rapier events back
   *  to entities. `entity` is the full koota handle (the drain runs in the same tick,
   *  so it's live) — needed to notify the Physics2DEvents manager + read OnCollision2D. */
  colliders: Map<number, { entityId: number; entity: Entity; isSensor: boolean; bodyEntityId: number }>;
  /** joint-entity id → joint record. Reconciled after bodies each tick. */
  joints: Map<number, JointRec>;
  /** Shared kinematic character controller (lazily created, reconfigured per character). */
  charCtrl?: import('@dimforge/rapier2d-compat').KinematicCharacterController;
  /** Last config applied to `charCtrl` — skip the ~8 WASM setters when a character's
   *  (static) params match what's already on the shared controller (P3). */
  charCfg?: { skin: number; climb: number; slide: number; autoH: number; autoW: number; snap: number };
  /** Unsupported collider shapes already warned about — per world (dropped on dispose),
   *  and per distinct shape, so a real authoring mistake isn't hidden by a one-shot flag. */
  warnedShapes: Set<string>;
  /** Physics2D.pixelsPerMeter, refreshed each tick — cached for the query/forces helpers. */
  ppm: number;
}

interface JointRec {
  entityId: number;
  entityGen: number;
  jointHandle: number;
  /** The two body handles this joint connects — so `removeBody` can drop the recs of a
   *  rebuilt body's joints WITHOUT a generation-blind getImpulseJoint(staleHandle) lookup
   *  (which can resolve a reused index onto a live sibling joint and destroy it). */
  bhA: number;
  bhB: number;
  /** type + all params + both body handles — a change (incl. a rebuilt body) rebuilds the joint. */
  sig: string;
}

/** Subset of UnitImpulseJoint (revolute/prismatic) used for motor + limit config —
 *  cast target so we don't need to import Rapier's class into a type position. */
interface MotorJoint {
  setLimits(min: number, max: number): void;
  configureMotorPosition(target: number, stiffness: number, damping: number): void;
  configureMotorVelocity(targetVel: number, factor: number): void;
}

// Per-World state + WASM lifecycle (the `worlds` Map, dispose/disposeAll, and the Stop /
// world-swap hooks) live in the shared registry — freeState releases this system's WASM handles.
const registry = createPhysicsWorldRegistry<PhysicsWorldState>((st) => { st.eventQueue.free(); st.world.free(); });
const worlds = registry.worlds;
/** Free the Rapier world for a koota world (test afterEach / scene teardown / zero-body early-out). */
export const disposePhysics2D = registry.dispose;
/** Free ALL Rapier worlds (called on Play→Stop so the next Play rebuilds fresh). */
export const disposeAllPhysics2D = registry.disposeAll;

function readConfig(world: World): PhysicsConfig {
  const e = world.queryFirst(Physics2D);
  if (e) {
    const p = e.get(Physics2D) as { gravityX: number; gravityY: number; pixelsPerMeter: number };
    return { gravityX: p.gravityX, gravityY: p.gravityY, ppm: p.pixelsPerMeter || 100 };
  }
  return { gravityX: 0, gravityY: 9.81, ppm: 100 };
}

function getOrCreateWorldState(world: World, cfg: PhysicsConfig): PhysicsWorldState {
  let st = worlds.get(world);
  if (!st) {
    const R = getRapier();
    // Rapier is Y-up, gravity in m/s²; ECS +Y is down → flip Y. Not scaled by ppm.
    const rapierWorld = new R.World({ x: cfg.gravityX, y: -cfg.gravityY });
    st = {
      R,
      world: rapierWorld,
      eventQueue: new R.EventQueue(true),
      bodies: new Map(),
      soloColliders: new Map(),
      colliders: new Map(),
      joints: new Map(),
      warnedShapes: new Set(),
      ppm: cfg.ppm,
    };
    worlds.set(world, st);
  }
  return st;
}

/** GEOMETRY signature — shape + dimensions/points only. A change REBUILDS the collider
 *  (Rapier can't reshape a live collider). Material/filters are deliberately NOT here:
 *  they're mutated in place (colliderMatSig + applyBodyMaterial), so a hot material/layer
 *  edit no longer rebuilds. That is load-bearing for correctness — a rebuild while two
 *  colliders overlap silently drops the pair's `exit` and re-fires `enter` next step
 *  (H1), corrupting subscribers' overlap state. */
function colliderGeomSig(entity: Entity): string {
  if (!entity.has(Collider2D)) return 'none';
  return geomSigOf(entity.get(Collider2D) as ColliderShapeParams); // shared pure geometry sig
}

/** MATERIAL/FILTER signature — density/friction/restitution/sensor + RESOLVED layer bits
 *  (so a collision-matrix edit re-applies to every affected collider). Applied to the live
 *  collider(s) in place when it changes (never a rebuild). '' when there's no Collider2D. */
function colliderMatSig(entity: Entity): string {
  if (!entity.has(Collider2D)) return '';
  const c = entity.get(Collider2D) as {
    density: number; friction: number; restitution: number; isSensor: boolean;
    physicsLayer: string; collisionGroups: number; collisionMask: number;
  };
  const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
  return `${c.density}:${c.friction}:${c.restitution}:${c.isSensor}:${bits.groups}:${bits.mask}`;
}

/** A compound child's signature: its collider (shape/material) + its LOCAL offset (the
 *  child Transform, which is body-local) + id/generation. Any change rebuilds the parent
 *  body so the attached collider's offset/shape tracks the edit.
 *
 *  LIMITATION (acceptable for now): because the child's local x/y/rz is in the signature,
 *  *animating* a child collider's offset would rebuild the whole parent body every frame,
 *  losing solver state (contacts/sleep) — a stability hit. Compound children are authored
 *  with static offsets (plus/table/dumbbell, convex decomposition), which never thrash: the
 *  Rapier→ECS pull only writes body entities (children have no RigidBody2D), so their local
 *  Transform is stable. If an animated-compound-child use case appears, split this into a
 *  structural vs pose signature and reposition the child collider in place
 *  (setTranslationWrtParent/setRotationWrtParent) instead of rebuilding. */
function childSig(child: Entity): string {
  const tf = child.get(Transform) as TfData | undefined;
  const ox = tf ? tf.x : 0, oy = tf ? tf.y : 0, or = tf ? tf.rz : 0;
  return `${child.id()}:${child.generation()}:${ox}:${oy}:${or}:${colliderGeomSig(child)}`;
}

/** Body-level structural + material signature — a change rebuilds the body (seamless for
 *  dynamic bodies: current velocity/pose were pulled into the traits last tick). Includes
 *  every adopted compound child, so adding/removing/moving/editing a child rebuilds the
 *  body. Caveat: a material edit on a KINEMATIC body that is mid-move loses one frame of its
 *  imparted velocity (it re-acquires its target next tick from the driver) — a 1-frame hitch. */
function bodySig(rb: RbData, entity: Entity, children: readonly Entity[]): string {
  let s = `${rb.bodyType}|${rb.linearDamping}|${rb.angularDamping}|${rb.gravityScale}` +
    `|${rb.fixedRotation}|${rb.ccd}|${rb.canSleep}|${colliderGeomSig(entity)}`;
  for (const ch of children) s += `#${childSig(ch)}`;
  return s;
}

/** Material/filter signature for the whole body (own collider + each compound child). When
 *  it changes we re-apply material to the live colliders in place — no rebuild (H1). */
function bodyMatSig(entity: Entity, children: readonly Entity[]): string {
  let s = colliderMatSig(entity);
  for (const ch of children) s += `#${colliderMatSig(ch)}`;
  return s;
}

/** Re-apply material/filters from each collider entity's Collider2D onto its live Rapier
 *  collider(s), in place. Keeps the event-drain `isSensor` flag in sync too. Works for a body
 *  record or a solo-collider record (both expose `colliderHandles`). */
function applyBodyMaterial(st: PhysicsWorldState, rec: { colliderHandles: number[] }): void {
  for (const h of rec.colliderHandles) {
    const info = st.colliders.get(h);
    if (!info || !info.entity.isAlive() || !info.entity.has(Collider2D)) continue;
    const col = st.world.getCollider(h);
    if (!col) continue;
    const c = info.entity.get(Collider2D) as {
      density: number; friction: number; restitution: number; isSensor: boolean;
      physicsLayer: string; collisionGroups: number; collisionMask: number;
    };
    const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
    col.setDensity(c.density);
    col.setFriction(c.friction);
    col.setRestitution(c.restitution);
    col.setSensor(!!c.isSensor);
    col.setCollisionGroups(packCollisionGroups(bits.groups, bits.mask));
    info.isSensor = !!c.isSensor;
  }
}

function warnShapeOnce(st: PhysicsWorldState, key: string, msg: string): void {
  if (!st.warnedShapes.has(key)) { console.warn(msg); st.warnedShapes.add(key); }
}

/** Build the Rapier ColliderDesc(s) for a shape. Returns an ARRAY because `concave` yields
 *  one desc per convex piece (a compound); every other shape yields a single desc. Null if
 *  the shape is unresolvable (bad point list, degenerate hull). */
/** Scale a flat [x0,y0,x1,y1,…] phys-point buffer per-axis IN PLACE (P2 scale threading).
 *  Points scale cleanly per-axis under a non-uniform parent (unlike radius shapes). */
function scalePointsInPlace(pts: Float32Array | number[], sx: number, sy: number): void {
  if (sx === 1 && sy === 1) return;
  for (let i = 0; i + 1 < pts.length; i += 2) { pts[i] *= sx; pts[i + 1] *= sy; }
}

/** Build the collider shape descriptor(s), scaled by the collider entity's WORLD scale
 *  (`sx`,`sy`) so a collider under a SCALED parent gets the right physical EXTENTS (P2 scale
 *  threading — hierarchy-and-world-transform-plan §4). Box + point shapes scale cleanly
 *  per-axis; radius shapes (circle/capsule) can't represent an ellipse, so a NON-UNIFORM
 *  scale is approximated (uniform mean) with a one-time warning. */
function makeColliderDesc(st: PhysicsWorldState, c: {
  shape: string; radius: number; halfW: number; halfH: number; points: string;
}, ppm: number, bodyType: BodyType2D, sx = 1, sy = 1): import('@dimforge/rapier2d-compat').ColliderDesc[] | null {
  const R = st.R;
  const ax = Math.abs(sx), ay = Math.abs(sy);
  // Radius shapes want ONE factor; warn once if the parent scale is non-uniform (→ ellipse, unsupported).
  const radialScale = (ax + ay) / 2;
  const nonUniform = Math.abs(ax - ay) > 1e-3 * Math.max(ax, ay, 1);
  switch (c.shape) {
    case 'circle':
      if (nonUniform) warnShapeOnce(st, 'circle:nonuniform', `[physics2D] a circle collider under a NON-UNIFORM scale (${ax.toFixed(2)},${ay.toFixed(2)}) can't be an ellipse — approximating with the mean radius. Use a box/polygon for a non-uniform shape.`);
      return [R.ColliderDesc.ball(lenToPhys(c.radius, ppm) * radialScale)];
    case 'box':
      return [R.ColliderDesc.cuboid(lenToPhys(c.halfW, ppm) * ax, lenToPhys(c.halfH, ppm) * ay)];
    // Rapier's capsule halfHeight is the SEGMENT half-height (cap centers), excluding
    // the hemispherical caps — matches the Collider2D.halfH/radius documentation.
    case 'capsule':
      if (nonUniform) warnShapeOnce(st, 'capsule:nonuniform', `[physics2D] a capsule collider under a NON-UNIFORM scale approximates its caps (radius uses the mean). Use a box/polygon for a non-uniform shape.`);
      return [R.ColliderDesc.capsule(lenToPhys(c.halfH, ppm) * ay, lenToPhys(c.radius, ppm) * radialScale)];
    case 'polygon': {
      // Convex hull of the inline point list (world units). Rapier computes the hull,
      // so winding/concave input is tolerated (concavity is dropped to the hull).
      const pts = parsePointsToPhys(c.points, ppm, 3);
      if (!pts) { warnShapeOnce(st, 'polygon:bad', `[physics2D] polygon collider needs an inline point list of >=3 [x,y] pairs (got ${JSON.stringify(c.points).slice(0, 40)}) — body created without a collider.`); return null; }
      scalePointsInPlace(pts, sx, sy);
      const d = R.ColliderDesc.convexHull(pts);
      if (!d) { warnShapeOnce(st, 'polygon:degenerate', '[physics2D] polygon points are degenerate (collinear/duplicate) — convex hull failed, body created without a collider.'); return null; }
      return [d];
    }
    case 'concave': {
      // Decompose the concave point list into convex pieces → a compound of convex hulls,
      // so a DYNAMIC body gets a real concave solid (a single hull would fill the concavity).
      const pieces = decomposeConcaveToPhys(c.points, ppm);
      if (!pieces) {
        // Fall back to a single convex hull (still a valid, if convex, collider).
        warnShapeOnce(st, 'concave:fallback', '[physics2D] concave collider could not be decomposed (needs a simple, non-self-intersecting list of >=4 [x,y] pairs) — falling back to a single convex hull.');
        const pts = parsePointsToPhys(c.points, ppm, 3);
        if (!pts) return null;
        scalePointsInPlace(pts, sx, sy);
        const d = R.ColliderDesc.convexHull(pts);
        return d ? [d] : null;
      }
      const descs: import('@dimforge/rapier2d-compat').ColliderDesc[] = [];
      for (const piece of pieces) {
        scalePointsInPlace(piece, sx, sy);
        const d = R.ColliderDesc.convexHull(piece);
        if (d) descs.push(d);
      }
      return descs.length > 0 ? descs : null;
    }
    case 'polyline': {
      // Static open edge chain (terrain/walls). Concave allowed. Non-convex colliders
      // have no interior mass, so they only make sense on static bodies.
      const pts = parsePointsToPhys(c.points, ppm, 2);
      if (!pts) { warnShapeOnce(st, 'polyline:bad', `[physics2D] polyline collider needs an inline point list of >=2 [x,y] pairs — body created without a collider.`); return null; }
      if (bodyType !== 'static') warnShapeOnce(st, 'polyline:dynamic', '[physics2D] polyline (open edge chain) colliders are intended for STATIC bodies — a dynamic/kinematic body gets no interior mass.');
      scalePointsInPlace(pts, sx, sy);
      return [R.ColliderDesc.polyline(pts)];
    }
    default:
      warnShapeOnce(st, c.shape, `[physics2D] unknown collider shape '${c.shape}' — body created without a collider.`);
      return null;
  }
}

type RbData = {
  bodyType: BodyType2D; vx: number; vy: number; angularVel: number;
  linearDamping: number; angularDamping: number; gravityScale: number;
  fixedRotation: boolean; ccd: boolean; canSleep: boolean; isSleeping: boolean;
};
type TfData = { x: number; y: number; rz: number };

/** Build + attach the collider(s) from `colliderEntity`'s Collider2D onto `body`, optionally
 *  at a body-LOCAL offset (compound children). One shape usually makes one collider; a
 *  `concave` shape makes several (its convex pieces). Every resulting collider maps back to
 *  the SAME entity, so events resolve to the collider's owner (a child's collision fires on
 *  the child, and its OnCollision2D runs). Returns all created handles (empty if invalid). */
function attachCollider(
  st: PhysicsWorldState,
  body: import('@dimforge/rapier2d-compat').RigidBody, bodyEntityId: number,   // OWNING body's entity id
  colliderEntity: Entity, bodyType: BodyType2D, cfg: PhysicsConfig,
  offset: { x: number; y: number; ang: number } | null,
  sx = 1, sy = 1,   // collider entity's WORLD scale → collider EXTENTS (P2 scale threading)
): number[] {
  const R = st.R;
  const c = colliderEntity.get(Collider2D) as Parameters<typeof makeColliderDesc>[1] & {
    density: number; friction: number; restitution: number; isSensor: boolean;
    physicsLayer: string; collisionGroups: number; collisionMask: number;
  };
  const descs = makeColliderDesc(st, c, cfg.ppm, bodyType, sx, sy);
  if (!descs) return [];
  const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
  const groups = packCollisionGroups(bits.groups, bits.mask);
  const handles: number[] = [];
  for (const cd of descs) {
    cd.setDensity(c.density).setFriction(c.friction).setRestitution(c.restitution)
      .setSensor(c.isSensor)
      .setCollisionGroups(groups)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    if (offset) cd.setTranslation(offset.x, offset.y).setRotation(offset.ang);
    const col = st.world.createCollider(cd, body);
    st.colliders.set(col.handle, { entityId: colliderEntity.id(), entity: colliderEntity, isSensor: !!c.isSensor, bodyEntityId });
    handles.push(col.handle);
  }
  return handles;
}

function createBody(
  st: PhysicsWorldState, entityId: number, entityGen: number,
  tf: TfData, rb: RbData,
  entity: Entity, children: readonly Entity[],
  cfg: PhysicsConfig, sig: string,
): BodyRec {
  const R = st.R;
  // Seed the body at its WORLD pose (P2) — a parented body's world ≠ its local Transform.
  const wp = worldPoseOf2D(entity, tf);
  const pos = vecEcsToPhys(wp.x, wp.y, cfg.ppm);
  const ang = angEcsToPhys(wp.rz);
  const vel = vecEcsToPhys(rb.vx, rb.vy, cfg.ppm);

  let desc;
  if (rb.bodyType === 'static') desc = R.RigidBodyDesc.fixed();
  else if (rb.bodyType === 'kinematic') desc = R.RigidBodyDesc.kinematicPositionBased();
  else desc = R.RigidBodyDesc.dynamic();

  desc.setTranslation(pos.x, pos.y).setRotation(ang)
    .setLinvel(vel.x, vel.y).setAngvel(angEcsToPhys(rb.angularVel))
    .setLinearDamping(rb.linearDamping).setAngularDamping(rb.angularDamping)
    .setGravityScale(rb.gravityScale).setCcdEnabled(rb.ccd).setCanSleep(rb.canSleep);
  if (rb.fixedRotation) desc.lockRotations();

  const body = st.world.createRigidBody(desc);

  const colliderHandles: number[] = [];
  // The body's WORLD scale drives collider extents (own collider) + compound-child offsets, so
  // a body/collider under a SCALED parent is the right physical size (P2 scale threading). World
  // scale is authored-time (colliders rebuild on structural change, not on a runtime scale tween).
  const bw = worldScaleOf(entity);
  const bodySx = bw.sx, bodySy = bw.sy;   // capture — worldScaleOf returns a shared singleton

  // The body's OWN collider(s) (attached at its origin), sized by the body's world scale.
  if (entity.has(Collider2D)) {
    colliderHandles.push(...attachCollider(st, body, entityId, entity, rb.bodyType, cfg, null, bodySx, bodySy));
  }
  // Compound: each child collider, attached at the child's body-LOCAL offset (its Transform,
  // which is already parent-local). The offset is scaled by the BODY's world scale (the child's
  // local offset lives in the parent's scaled frame); the child EXTENTS use the CHILD's world
  // scale (parent × its own local). Rotation crosses the same angle flip as poses.
  for (const child of children) {
    const ctf = child.get(Transform) as TfData | undefined;
    const off = ctf ? vecEcsToPhys(ctf.x * bodySx, ctf.y * bodySy, cfg.ppm) : { x: 0, y: 0 };
    const ang2 = ctf ? angEcsToPhys(ctf.rz) : 0;
    const cw = worldScaleOf(child);
    colliderHandles.push(...attachCollider(st, body, entityId, child, rb.bodyType, cfg, { x: off.x, y: off.y, ang: ang2 }, cw.sx, cw.sy));
  }

  const rec: BodyRec = {
    entityId, entityGen, bodyHandle: body.handle, colliderHandles, bodyType: rb.bodyType, sig,
    matSig: bodyMatSig(entity, children),
    lastX: pos.x, lastY: pos.y, lastAng: ang,
  };
  st.bodies.set(entityId, rec);
  return rec;
}

/** Synthesize `exit` events for any pair still overlapping THIS body's colliders, BEFORE they
 *  are freed. Rapier emits no stop event when a collider is removed or rebuilt, so without
 *  this a despawn-inside-a-trigger (or a geometry rebuild) leaves subscribers' overlap state
 *  stuck 'entered' (H1). Double-exit safe when both bodies go the same frame: the other
 *  collider must still be registered (removeBody deletes its own entries before freeing, so
 *  the second removal finds no partner). */
// The declarative OnCollision2D dispatcher, bound to this dimension's trait (shared core).
const fireOnCollision = makeFireOnCollision(OnCollision2D);

function removeBody(st: PhysicsWorldState, world: World, rec: BodyRec): void {
  // Emit synthetic exits for still-overlapping pairs before the colliders vanish (H1).
  synthesizeContactExits(rec.colliderHandles, world, st.colliders, st.world.narrowPhase, physics2DEvents, fireOnCollision);
  // Rapier's removeRigidBody auto-removes this body's joints, invalidating their handles.
  // Drop the referencing JointRecs from our map here (map-only, NO getImpulseJoint — a
  // stale handle could resolve to a reused-index sibling and wrongly remove it). The joint
  // reconciler recreates them next pass once both endpoints exist again.
  if (st.joints.size > 0) {
    for (const [jid, jrec] of st.joints) {
      if (jrec.bhA === rec.bodyHandle || jrec.bhB === rec.bodyHandle) st.joints.delete(jid);
    }
  }
  // Drop every collider→entity entry (own + compound children).
  for (const h of rec.colliderHandles) st.colliders.delete(h);
  const body = st.world.getRigidBody(rec.bodyHandle);
  if (body) st.world.removeRigidBody(body); // also removes its colliders
  st.bodies.delete(rec.entityId);
  // Percept: force-clear this body's contact index by BODY identity (the synthesized
  // exits above can roll a dead/reparented compound child up to the wrong body).
  dropEntityFromContactIndex(world, rec.entityId);
}

// ── Solo (parentless) static colliders ──
// A Collider2D with no RigidBody2D of its own and no body parent is created as a PARENTLESS
// Rapier collider — fixed world geometry that collides + fires events without a dummy body.

/** Build + insert `colliderEntity`'s Collider2D as a parentless (fixed) collider at its WORLD
 *  pose. Maps every handle back to the entity so events resolve to its owner. Empty ⇒ bad shape. */
function attachSoloCollider(st: PhysicsWorldState, colliderEntity: Entity, cfg: PhysicsConfig): number[] {
  const R = st.R;
  const c = colliderEntity.get(Collider2D) as Parameters<typeof makeColliderDesc>[1] & {
    density: number; friction: number; restitution: number; isSensor: boolean;
    physicsLayer: string; collisionGroups: number; collisionMask: number;
  };
  const ws = worldScaleOf(colliderEntity);
  const sx = ws.sx, sy = ws.sy;   // capture — worldScaleOf returns a shared singleton
  const descs = makeColliderDesc(st, c, cfg.ppm, 'static', sx, sy);   // parentless ⇒ static
  if (!descs) return [];
  const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
  const groups = packCollisionGroups(bits.groups, bits.mask);
  const tf = colliderEntity.get(Transform) as TfData;
  const wp = worldPoseOf2D(colliderEntity, tf);   // fixed collider sits at the entity's WORLD pose
  const pos = vecEcsToPhys(wp.x, wp.y, cfg.ppm);
  const ang = angEcsToPhys(wp.rz);
  const handles: number[] = [];
  for (const cd of descs) {
    cd.setDensity(c.density).setFriction(c.friction).setRestitution(c.restitution)
      .setSensor(c.isSensor)
      .setCollisionGroups(groups)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
      .setTranslation(pos.x, pos.y).setRotation(ang);
    const col = st.world.createCollider(cd);   // no parent body ⇒ Rapier treats it as fixed
    st.colliders.set(col.handle, { entityId: colliderEntity.id(), entity: colliderEntity, isSensor: !!c.isSensor, bodyEntityId: colliderEntity.id() });
    handles.push(col.handle);
  }
  return handles;
}

/** STRUCTURAL signature for a solo collider — geometry + WORLD pose + WORLD scale + id/gen. A
 *  change rebuilds it (a fixed collider is repositioned by rebuild here, matching the compound-
 *  child static-offset model). Material/filter is applied in place. */
function soloColliderSig(entity: Entity, tf: TfData): string {
  const wp = worldPoseOf2D(entity, tf);
  const px = wp.x, py = wp.y, pr = wp.rz;   // capture before worldScaleOf
  const ws = worldScaleOf(entity);
  return `${entity.id()}:${entity.generation()}:${px}:${py}:${pr}:${ws.sx}:${ws.sy}:${colliderGeomSig(entity)}`;
}

function removeSoloCollider(st: PhysicsWorldState, world: World, rec: SoloColliderRec): void {
  synthesizeContactExits(rec.colliderHandles, world, st.colliders, st.world.narrowPhase, physics2DEvents, fireOnCollision);
  for (const h of rec.colliderHandles) {
    const col = st.world.getCollider(h);
    if (col) st.world.removeCollider(col, true);   // wakeUp any body it was touching
    st.colliders.delete(h);
  }
  st.soloColliders.delete(rec.entityId);
  dropEntityFromContactIndex(world, rec.entityId);
}

// ── Joints ──

type JointData = {
  type: JointType2D; entityA: string; entityB: string;
  anchorAX: number; anchorAY: number; anchorBX: number; anchorBY: number;
  length: number; stiffness: number; damping: number;
  axisX: number; axisY: number;
  limitsEnabled: boolean; limitMin: number; limitMax: number;
  motorEnabled: boolean; motorTargetVel: number; motorTargetPos: number;
  motorStiffness: number; motorDamping: number;
};

function jointSig(j: JointData, bhA: number, bhB: number): string {
  return [
    j.type, j.entityA, j.entityB, j.anchorAX, j.anchorAY, j.anchorBX, j.anchorBY,
    j.length, j.stiffness, j.damping, j.axisX, j.axisY,
    j.limitsEnabled, j.limitMin, j.limitMax,
    j.motorEnabled, j.motorTargetVel, j.motorTargetPos, j.motorStiffness, j.motorDamping,
    bhA, bhB,
  ].join('|');
}

function removeJoint(st: PhysicsWorldState, rec: JointRec): void {
  const j = st.world.getImpulseJoint(rec.jointHandle);
  if (j) st.world.removeImpulseJoint(j, true);
  st.joints.delete(rec.entityId);
}

function createJoint(
  st: PhysicsWorldState, entityId: number, entityGen: number,
  j: JointData, bodyAHandle: number, bodyBHandle: number, cfg: PhysicsConfig, sig: string,
): void {
  const R = st.R;
  const bodyA = st.world.getRigidBody(bodyAHandle);
  const bodyB = st.world.getRigidBody(bodyBHandle);
  if (!bodyA || !bodyB) return;

  const a1 = vecEcsToPhys(j.anchorAX, j.anchorAY, cfg.ppm);
  const a2 = vecEcsToPhys(j.anchorBX, j.anchorBY, cfg.ppm);

  let jd;
  switch (j.type) {
    case 'spring': jd = R.JointData.spring(lenToPhys(j.length, cfg.ppm), j.stiffness, j.damping, a1, a2); break;
    case 'rope': jd = R.JointData.rope(lenToPhys(j.length, cfg.ppm), a1, a2); break;
    case 'revolute': jd = R.JointData.revolute(a1, a2); break;
    case 'prismatic': {
      const ax = vecEcsToPhys(j.axisX, j.axisY, cfg.ppm);
      const al = Math.hypot(ax.x, ax.y) || 1;
      jd = R.JointData.prismatic(a1, a2, { x: ax.x / al, y: ax.y / al });
      break;
    }
    // Frame angles 0/0 lock a ZERO relative rotation — a weld aligns the two bodies'
    // orientations (not "preserve current relative angle"). Matches the doc's "orientation locked".
    case 'fixed': jd = R.JointData.fixed(a1, 0, a2, 0); break;
    default: return;
  }

  const joint = st.world.createImpulseJoint(jd, bodyA, bodyB, true);

  // Motor + limits only apply to the axis joints (revolute/prismatic).
  if (j.type === 'revolute' || j.type === 'prismatic') {
    const mj = joint as unknown as MotorJoint;
    const isRev = j.type === 'revolute';
    if (j.limitsEnabled) {
      // revolute limits are angles (negate → swaps min/max); prismatic are distances.
      if (isRev) mj.setLimits(angEcsToPhys(j.limitMax), angEcsToPhys(j.limitMin));
      else mj.setLimits(lenToPhys(j.limitMin, cfg.ppm), lenToPhys(j.limitMax, cfg.ppm));
    }
    if (j.motorEnabled) {
      const pos = isRev ? angEcsToPhys(j.motorTargetPos) : lenToPhys(j.motorTargetPos, cfg.ppm);
      const vel = isRev ? angEcsToPhys(j.motorTargetVel) : lenToPhys(j.motorTargetVel, cfg.ppm);
      if (j.motorStiffness > 0) mj.configureMotorPosition(pos, j.motorStiffness, j.motorDamping);
      else mj.configureMotorVelocity(vel, j.motorDamping);
    }
  }

  st.joints.set(entityId, { entityId, entityGen, jointHandle: joint.handle, bhA: bodyAHandle, bhB: bodyBHandle, sig });
}

/** Reconcile Joint2D entities → Rapier impulse joints. Runs AFTER bodies exist so both
 *  endpoints resolve. A joint activates once both `entityA`/`entityB` GUIDs map to bodies;
 *  it is torn down if either endpoint disappears. */
function reconcileJoints(st: PhysicsWorldState, world: World, cfg: PhysicsConfig): void {
  const seen = _seenJoints; seen.clear();
  world.query(Joint2D).updateEach(([j]: [JointData], entity) => {
    const id = entity.id();
    const gen = entity.generation();
    const ea = j.entityA ? findEntityByGuid(j.entityA, world) : undefined;
    const eb = j.entityB ? findEntityByGuid(j.entityB, world) : undefined;
    const recA = ea ? st.bodies.get(ea.id()) : undefined;
    const recB = eb ? st.bodies.get(eb.id()) : undefined;

    if (!recA || !recB || recA === recB) {
      // Endpoints not both present (or a degenerate self-joint) — drop any existing joint
      // and wait. A body joined to itself is a no-op constraint; skip it.
      const existing = st.joints.get(id);
      if (existing) removeJoint(st, existing);
      if (recA && recA === recB && !st.warnedShapes.has('selfjoint')) {
        console.warn('[physics2D] Joint2D entityA and entityB resolve to the same entity — skipped.');
        st.warnedShapes.add('selfjoint');
      }
      return;
    }

    seen.add(id);
    const sig = jointSig(j, recA.bodyHandle, recB.bodyHandle);
    let rec = st.joints.get(id);
    if (rec && (rec.sig !== sig || rec.entityGen !== gen)) { removeJoint(st, rec); rec = undefined; }
    if (!rec) createJoint(st, id, gen, j, recA.bodyHandle, recB.bodyHandle, cfg, sig);
  });

  for (const [id, rec] of st.joints) {
    if (!seen.has(id)) removeJoint(st, rec);
  }
}

/** Reused across ticks to avoid a per-frame Map/Set/Vec2 allocation on the physics hot path
 *  (physics runs one world at a time, synchronously, so shared scratch is safe). */
const _childScratch = new Map<number, Entity[]>();
const _seenBodies = new Set<number>();   // reused per tick (reconcile + cleanup)
const _seenSolo = new Set<number>();     // reused per tick (solo-collider reconcile + cleanup)
const _seenJoints = new Set<number>();   // reused per tick (joint reconcile)
const _v: Vec2 = { x: 0, y: 0 };         // scratch for pull/push conversions (consumed immediately)
const _desired: Vec2 = { x: 0, y: 0 };   // scratch for the character move delta
/** Shared read-only empty children list — avoids a throwaway `[]` per non-compound body/tick. */
const EMPTY_CHILDREN: readonly Entity[] = Object.freeze([]);

/** O(1) parentId read off the entity handle (no world scan). 0 = root / unparented. */
function parentIdOf(entity: Entity): number {
  return entity.has(EntityAttributes) ? ((entity.get(EntityAttributes) as { parentId?: number }).parentId || 0) : 0;
}

// WORLD-transform bridge (P2 — hierarchy-and-world-transform-plan). A PARENTED 2D body seeds/
// poses at its WORLD transform and reads the solved world pose back into LOCAL. The world pose
// comes from the fresh `worldTransforms` cache (the pre-physics propagation pass at
// SYSTEM_PRIORITY.TRANSFORM_PREPASS), an O(1) lookup. On a cache MISS the fallback is SYMMETRIC
// between seed + readback (so they agree): a ROOT body uses local (world === local, fast); a
// PARENTED body composes its TRUE world on-demand (getWorldTransform3D — headless-safe; 2D reads
// x/y/rz/sx/sy from it). In-app the cache always hits (pre-pass every frame) → on-demand is
// test-only. `worldToLocal2D` inverts the parent's world 2D (translation·rotation·scale) in ECS
// Transform space (the readback converts Rapier→ECS first, so the axis flip is already unwound).
// NOTE: collider EXTENTS + compound-child offsets are NOT yet scaled by a scaled parent — a
// scaled 2D parent gets correct child POSITION but unscaled child SIZE (follow-up; see plan §4 P2).
const _wp2: TfData = { x: 0, y: 0, rz: 0 };
function worldPoseOf2D(entity: Entity, tf: TfData): TfData {
  const id = entity.id();
  const w = worldTransforms.get(id);
  if (w) { _wp2.x = w.x; _wp2.y = w.y; _wp2.rz = w.rz; return _wp2; }
  if (!parentIdOf(entity)) { _wp2.x = tf.x; _wp2.y = tf.y; _wp2.rz = tf.rz; return _wp2; }
  const wt = getWorldTransform3D(id, getCurrentWorld());   // parented + no cache → true world
  _wp2.x = wt.x; _wp2.y = wt.y; _wp2.rz = wt.rz;
  return _wp2;
}
const _ws2: { sx: number; sy: number } = { sx: 1, sy: 1 };
/** The collider entity's WORLD scale (sx,sy) for collider-extent threading (P2). Cache-first
 *  (O(1) via the pre-pass); on a miss a ROOT entity uses its local scale (world === local), a
 *  PARENTED one composes true world on-demand — symmetric with `worldPoseOf2D`. Returns a shared
 *  singleton; read its fields immediately. */
function worldScaleOf(entity: Entity): { sx: number; sy: number } {
  const w = worldTransforms.get(entity.id());
  if (w) { _ws2.sx = w.sx; _ws2.sy = w.sy; return _ws2; }
  const tf = entity.get(Transform) as { sx?: number; sy?: number } | undefined;
  if (!parentIdOf(entity)) { _ws2.sx = tf?.sx ?? 1; _ws2.sy = tf?.sy ?? 1; return _ws2; }
  const wt = getWorldTransform3D(entity.id(), getCurrentWorld());
  _ws2.sx = wt.sx; _ws2.sy = wt.sy;
  return _ws2;
}
const _lc2: TfData = { x: 0, y: 0, rz: 0 };
/** Convert an ECS-space WORLD 2D pose → LOCAL by inverting the PARENT's world 2D transform:
 *  local = S⁻¹ · R(−RZ) · (world − P). Uses the cached parent world (O(1)), composing it
 *  on-demand only on a cache miss (headless without the pre-pass) so it stays symmetric with
 *  the seed. Callers guard `parentId !== 0`, so the parent is always a real entity here. */
function worldToLocal2D(parentId: number, wx: number, wy: number, wrz: number): TfData {
  const p = worldTransforms.get(parentId) ?? getWorldTransform3D(parentId, getCurrentWorld());
  const dx = wx - p.x, dy = wy - p.y;
  const c = Math.cos(-p.rz), s = Math.sin(-p.rz);
  const sx = p.sx || 1, sy = p.sy || 1;
  _lc2.x = (dx * c - dy * s) / sx;
  _lc2.y = (dx * s + dy * c) / sy;
  _lc2.rz = wrz - p.rz;
  return _lc2;
}

type CharData = {
  speed: number; jumpSpeed: number; gravityScale: number;
  maxSlopeClimbDeg: number; minSlopeSlideDeg: number;
  autostepHeight: number; autostepMinWidth: number; snapToGroundDist: number; skin: number;
  moveX: number; jump: boolean; grounded: boolean; velY: number; readbackReady: boolean;
};

/** Character-controller pass — runs after bodies/joints reconcile, BEFORE the world step.
 *  For each kinematic character it integrates gravity + input into a desired delta, asks
 *  Rapier's KinematicCharacterController for the collision-safe movement (slide/autostep/
 *  slope/snap), and sets the body's next kinematic translation so the step applies it.
 *  Writes back grounded + velY; consumes the one-shot jump. No-op when dt<=0 (paused). */
function stepCharacters(st: PhysicsWorldState, world: World, cfg: PhysicsConfig, dt: number): void {
  if (dt <= 0) return;
  world.query(Transform, RigidBody2D, Collider2D, CharacterController2D)
    .updateEach(([tf, rb, , cc]: [TfData, RbData, unknown, CharData], entity) => {
      if (rb.bodyType !== 'kinematic') return; // a character must be a kinematic body
      const rec = st.bodies.get(entity.id());
      if (!rec || rec.colliderHandles.length === 0) return;
      const body = st.world.getRigidBody(rec.bodyHandle);
      const collider = st.world.getCollider(rec.colliderHandles[0]);
      if (!body || !collider) return;

      // Honor an external Transform write (respawn/teleport/checkpoint): if the authored
      // pose diverged from what we last pulled back, hard-set the body there and stop the
      // fall — otherwise the controller ignores it (it drives the body itself). lastX/lastY
      // hold the last pulled pose (createBody seeds them; the character pull updates them).
      // Compare in WORLD space (the body's frame) so a parented character's local Transform
      // maps correctly against lastX/lastY (which are world/phys units). (P2)
      const wp = worldPoseOf2D(entity, tf);
      const apos = vecEcsToPhysInto(wp.x, wp.y, cfg.ppm, _v);   // scratch — no per-char alloc
      if (Math.abs(apos.x - rec.lastX) > 1e-4 || Math.abs(apos.y - rec.lastY) > 1e-4) {
        body.setTranslation({ x: apos.x, y: apos.y }, true);
        rec.lastX = apos.x; rec.lastY = apos.y;
        cc.velY = 0;
      }

      const skin = Math.max(0.001, cc.skin / cfg.ppm);
      if (!st.charCtrl) st.charCtrl = st.world.createCharacterController(skin);
      const ctrl = st.charCtrl;
      // Reconfigure the SHARED controller only when this character's (static) params differ
      // from what's already applied — the setters are WASM-boundary calls (P3).
      const climb = (cc.maxSlopeClimbDeg * Math.PI) / 180, slide = (cc.minSlopeSlideDeg * Math.PI) / 180;
      const autoH = cc.autostepHeight > 0 ? cc.autostepHeight / cfg.ppm : 0;
      const autoW = Math.max(0, cc.autostepMinWidth) / cfg.ppm;
      const snap = cc.snapToGroundDist > 0 ? cc.snapToGroundDist / cfg.ppm : 0;
      const pc = st.charCfg;
      if (!pc || pc.skin !== skin || pc.climb !== climb || pc.slide !== slide || pc.autoH !== autoH || pc.autoW !== autoW || pc.snap !== snap) {
        ctrl.setUp({ x: 0, y: 1 });                       // physics up = +Y (ECS is Y-down)
        ctrl.setOffset(skin);
        ctrl.setMaxSlopeClimbAngle(climb);
        ctrl.setMinSlopeSlideAngle(slide);
        if (autoH > 0) ctrl.enableAutostep(autoH, autoW, true); else ctrl.disableAutostep();
        if (snap > 0) ctrl.enableSnapToGround(snap); else ctrl.disableSnapToGround();
        ctrl.setApplyImpulsesToDynamicBodies(true);
        st.charCfg = { skin, climb, slide, autoH, autoW, snap };
      }

      // Integrate gravity into velY (ECS units/s, screen-down positive). Gravity accel is
      // cfg.gravityY (m/s²) × ppm (→ units/s²), scaled per character.
      let velY = cc.velY + cfg.gravityY * cfg.ppm * cc.gravityScale * dt;
      // Jump only when grounded. Deliberately no coyote-time / input-buffer / air-jump
      // (game-feel polish, deferred); a jump pressed while airborne is dropped this frame.
      if (cc.jump && cc.grounded) velY = -Math.abs(cc.jumpSpeed); // launch up (screen up = -Y)

      // Desired delta in physics meters: X keeps sign, Y flips (ECS→phys). Scratch — no alloc.
      _desired.x = (cc.moveX * cc.speed / cfg.ppm) * dt;
      _desired.y = (-velY / cfg.ppm) * dt;
      ctrl.computeColliderMovement(collider, _desired);
      const mv = ctrl.computedMovement();
      const grounded = ctrl.computedGrounded();

      const t = body.translation();
      body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y });

      if (grounded && velY > 0) velY = 0; // landed — stop the fall
      cc.velY = velY;
      cc.grounded = grounded;
      cc.readbackReady = true;            // grounded/velY now reflect real physics
      cc.jump = false;                    // one-shot
    });
}

/** Collect COMPOUND CHILD colliders: entities with a Collider2D + Transform but NO
 *  RigidBody2D of their own, grouped by their (numeric, runtime) parentId. Such an entity
 *  is adopted as an extra collider on its parent body at the child's local Transform offset.
 *  Groups are sorted by entity id so the parent's signature is stable frame-to-frame.
 *
 *  Only DIRECT children are adopted (parentId === the body's entity id): a grandchild whose
 *  parent is itself a body-less collider is not chained in (single-level compounds — enough
 *  for plus/table/dumbbell shapes and the convex-decomposition case). A collider entity with
 *  no RigidBody2D ancestor is simply ignored, exactly as before this feature. */
function collectCompoundChildren(world: World): Map<number, Entity[]> {
  _childScratch.clear();
  world.query(Transform, Collider2D, EntityAttributes).updateEach(([, , attr]: [TfData, unknown, { parentId: number }], entity) => {
    if (entity.has(RigidBody2D)) return;          // it's its own body, not a compound child
    // parentId 0 (no parent) buckets under key 0 — never adopted (no body has id 0), but the
    // orphan-collider warn pass reads it so a bodyless collider isn't a silent no-op (M1).
    const pid = attr.parentId || 0;
    let bucket = _childScratch.get(pid);
    if (!bucket) { bucket = []; _childScratch.set(pid, bucket); }
    bucket.push(entity);
  });
  for (const bucket of _childScratch.values()) bucket.sort((a, b) => a.id() - b.id());
  return _childScratch;
}

/** The physics tick. Registered at SYSTEM_PRIORITY.PHYSICS in the app pipeline. */
export function physics2DSystem(world: World): void {
  // Cheap early-out: nothing to simulate. If a prior physics population left state
  // behind (e.g. every RigidBody2D was destroyed for the rest of the scene), free the
  // world so its Rapier/WASM bodies don't linger — the despawn-cleanup pass below is
  // skipped by this early return, so drop everything here instead of stranding it.
  if (world.queryFirst(RigidBody2D) === undefined) {
    const st = worlds.get(world);
    if (st) {
      // Percept: this path SKIPS the removeBody cleanup pass, so force-clear each lingering
      // 2D body's contact index entry here (targeted — leaves any 3D bodies sharing this
      // world's index untouched) before freeing the Rapier world.
      for (const id of st.bodies.keys()) dropEntityFromContactIndex(world, id);
      for (const id of st.soloColliders.keys()) dropEntityFromContactIndex(world, id);
      disposePhysics2D(world);
    }
    return;
  }
  // Lazy WASM init — a game with no physics never instantiates Rapier.
  if (!isRapierReady()) { void initRapier2D(); return; }

  const cfg = readConfig(world);
  const st = getOrCreateWorldState(world, cfg);
  // Live gravity edits — cheap to set every tick.
  st.world.gravity = { x: cfg.gravityX, y: -cfg.gravityY };
  st.ppm = cfg.ppm;   // cache for the query/forces helpers (live pixelsPerMeter edits)

  const dt = getSimDelta(world);
  const seen = _seenBodies; seen.clear();
  // Compound children (Collider2D + Transform, no own RigidBody2D) grouped by parent id.
  const childrenByParent = collectCompoundChildren(world);

  // ── Reconcile + push (ECS → Rapier) ──
  world.query(Transform, RigidBody2D).updateEach(([tf, rb]: [TfData, RbData], entity) => {
    const id = entity.id();
    const gen = entity.generation();
    seen.add(id);
    const children = childrenByParent.get(id) ?? EMPTY_CHILDREN;
    const sig = bodySig(rb, entity, children);
    let rec = st.bodies.get(id);
    // Rebuild on a structural change OR an id recycled onto a new entity (stale gen) —
    // otherwise the newcomer would silently adopt the old body's simulated pose.
    if (rec && (rec.sig !== sig || rec.entityGen !== gen)) { removeBody(st, world, rec); rec = undefined; }
    if (!rec) { createBody(st, id, gen, tf, rb, entity, children, cfg, sig); return; }

    // Material / filter / layer edits apply to the live collider(s) IN PLACE — no rebuild,
    // so a hot edit while overlapping keeps the collision events exit/enter balanced (H1).
    const matSig = bodyMatSig(entity, children);
    if (rec.matSig !== matSig) { applyBodyMaterial(st, rec); rec.matSig = matSig; }

    // Push authored pose for bodies the solver does NOT own — EXCEPT a character,
    // whose kinematic target is driven by stepCharacters (below), not its Transform.
    if ((rec.bodyType === 'kinematic' && !entity.has(CharacterController2D)) || rec.bodyType === 'static') {
      const wp = worldPoseOf2D(entity, tf);   // WORLD pose (P2) — parented bodies pose at world, not local
      const pos = vecEcsToPhysInto(wp.x, wp.y, cfg.ppm, _v);  // scratch — no per-body alloc
      const ang = angEcsToPhys(wp.rz);
      if (pos.x !== rec.lastX || pos.y !== rec.lastY || ang !== rec.lastAng) {
        const body = st.world.getRigidBody(rec.bodyHandle);
        if (body) {
          if (rec.bodyType === 'kinematic') {
            body.setNextKinematicTranslation({ x: pos.x, y: pos.y });
            body.setNextKinematicRotation(ang);
          } else {
            body.setTranslation({ x: pos.x, y: pos.y }, true);
            body.setRotation(ang, true);
          }
        }
        rec.lastX = pos.x; rec.lastY = pos.y; rec.lastAng = ang;
      }
    }
  });

  // ── Cleanup despawned/detached bodies ──
  for (const [id, rec] of st.bodies) {
    if (!seen.has(id)) removeBody(st, world, rec);
  }

  // ── Solo (parentless) static colliders: a Collider2D with no RigidBody2D and no body parent
  //    becomes a FIXED world collider (Rapier's native parentless collider) — it collides + fires
  //    events without a dummy body. Reconciled AFTER the body pass so `st.bodies` reflects this
  //    frame (a bucket whose parent IS a body was already adopted as compound children above). ──
  const seenSolo = _seenSolo; seenSolo.clear();
  for (const [pid, bucket] of childrenByParent) {
    if (st.bodies.has(pid)) continue;              // adopted as compound children of a body — not solo
    for (const child of bucket) {
      const cid = child.id();
      const gen = child.generation();
      const tf = child.get(Transform) as TfData;
      const sig = soloColliderSig(child, tf);
      let rec = st.soloColliders.get(cid);
      if (rec && (rec.sig !== sig || rec.entityGen !== gen)) { removeSoloCollider(st, world, rec); rec = undefined; }
      if (!rec) {
        const handles = attachSoloCollider(st, child, cfg);
        // No handles ⇒ shape invalid (makeColliderDesc warned once) — leave untracked so it retries.
        if (handles.length) {
          st.soloColliders.set(cid, { entityId: cid, entityGen: gen, colliderHandles: handles, sig, matSig: colliderMatSig(child) });
          seenSolo.add(cid);
        }
        continue;
      }
      const matSig = colliderMatSig(child);
      if (rec.matSig !== matSig) { applyBodyMaterial(st, rec); rec.matSig = matSig; }
      seenSolo.add(cid);
    }
  }
  // Drop solo colliders that are no longer solo (despawned, gained their own body, or their parent
  // became one — in which case the body pass already re-adopted them as compound children).
  for (const [, rec] of st.soloColliders) {
    if (!seenSolo.has(rec.entityId)) removeSoloCollider(st, world, rec);
  }

  // ── Reconcile joints (after bodies exist, before stepping) ──
  reconcileJoints(st, world, cfg);

  // ── Character controllers (set kinematic targets before the step) ──
  stepCharacters(st, world, cfg, dt);

  // ── Step ──
  if (dt > 0) {
    st.world.timestep = dt;
    st.world.step(st.eventQueue);
  }

  // ── Pull dynamic bodies (Rapier → ECS) — only when a step actually ran (dt>0), so a
  //    paused sim (timeScale 0) doesn't overwrite authored/inspector edits with the
  //    body's f32-quantized pose every frame. ──
  if (dt > 0) world.query(Transform, RigidBody2D).updateEach(([tf, rb]: [TfData, RbData], entity) => {
    const rec = st.bodies.get(entity.id());
    if (!rec || rec.bodyType !== 'dynamic') return;
    const body = st.world.getRigidBody(rec.bodyHandle);
    if (!body) return;
    const t = body.translation();
    vecPhysToEcsInto(t.x, t.y, cfg.ppm, _v);       // scratch → ECS world pos (no per-body alloc)
    const wrz = angPhysToEcs(body.rotation());     // ECS world angle
    // The solver poses the body in WORLD space; invert the parent's world for a PARENTED body so
    // the LOCAL Transform stays correct. Root bodies keep the fast path (world === local). (P2)
    const parentId = parentIdOf(entity);
    if (parentId) {
      const local = worldToLocal2D(parentId, _v.x, _v.y, wrz);
      tf.x = local.x; tf.y = local.y; tf.rz = local.rz;
    } else {
      tf.x = _v.x; tf.y = _v.y; tf.rz = wrz;
    }
    const lv = body.linvel();
    vecPhysToEcsInto(lv.x, lv.y, cfg.ppm, _v);
    rb.vx = _v.x; rb.vy = _v.y; rb.angularVel = angPhysToEcs(body.angvel());
    rb.isSleeping = body.isSleeping(); // Percept read-back (S5)
  });

  // ── Pull character bodies (kinematic + CharacterController2D): the step moved them to
  //    their next kinematic translation, so write it back into Transform. ──
  if (dt > 0) world.query(Transform, RigidBody2D, CharacterController2D).updateEach(([tf]: [TfData, RbData, CharData], entity) => {
    const rec = st.bodies.get(entity.id());
    if (!rec || rec.bodyType !== 'kinematic') return;
    const body = st.world.getRigidBody(rec.bodyHandle);
    if (!body) return;
    const t = body.translation();
    vecPhysToEcsInto(t.x, t.y, cfg.ppm, _v);
    // Character body is posed in WORLD space; write back into LOCAL for a parented character. (P2)
    const parentId = parentIdOf(entity);
    if (parentId) {
      const local = worldToLocal2D(parentId, _v.x, _v.y, tf.rz);
      tf.x = local.x; tf.y = local.y;
    } else {
      tf.x = _v.x; tf.y = _v.y;
    }
    // Record the pulled pose so next tick's teleport-detection compares against it (a
    // real external Transform write will differ; our own write-back won't). World/phys units.
    rec.lastX = t.x; rec.lastY = t.y;
  });

  // ── Drain contact + sensor events → journal, Physics2DEvents manager, OnCollision2D. On a
  //    solid contact BEGIN, also read the manifold for a rich `contact` event (point/normal/
  //    impact speed) — the impact detail games need for damage / SFX / effect spawning. ──
  if (dt > 0) drainContactEvents(world, st.colliders, st.eventQueue, physics2DEvents, fireOnCollision,
    (h1, h2, a, b, phase) => emitContactDetail2D(st, world, cfg.ppm, h1, h2, a, b, phase));
}

/** A 2D raycast against the physics world, in ECS/screen coordinates.
 *  Returns the first hit (nearest along the ray) or null. `dx`/`dy` need not be
 *  normalized. `maxDistance` is in world units. Pure query — no stepping/side effects. */
export function raycast2D(
  world: World, ox: number, oy: number, dx: number, dy: number,
  opts: { maxDistance?: number; solid?: boolean } = {},
): { entityId: number; x: number; y: number; nx: number; ny: number; distance: number } | null {
  const st = worlds.get(world);
  if (!st) return null;
  const cfg = readConfig(world);
  const R = st.R;

  const origin = vecEcsToPhys(ox, oy, cfg.ppm);
  // Direction is a pure direction — convert via the vector map, then normalize so
  // timeOfImpact comes back in meters.
  const d = vecEcsToPhys(dx, dy, cfg.ppm);
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return null;
  const dir = { x: d.x / len, y: d.y / len };
  const maxToi = (opts.maxDistance ?? Infinity) / cfg.ppm;

  const ray = new R.Ray(origin, dir);
  const hit = st.world.castRayAndGetNormal(ray, maxToi, opts.solid ?? true);
  if (!hit) return null;

  const info = st.colliders.get(hit.collider.handle);
  const point = ray.pointAt(hit.timeOfImpact);
  const p = vecPhysToEcs(point.x, point.y, cfg.ppm);
  const n = vecPhysToEcs(hit.normal.x, hit.normal.y, cfg.ppm); // reflect normal back to screen frame
  const nlen = Math.hypot(n.x, n.y) || 1;
  return {
    entityId: info?.entityId ?? -1,
    x: p.x, y: p.y,
    nx: n.x / nlen, ny: n.y / nlen,
    distance: hit.timeOfImpact * cfg.ppm,
  };
}

/** Sweep a circle of `radius` (world units) from (ox,oy) along (dx,dy) and return the
 *  first collider it would hit — the "would this fit if I move it here" query. Like
 *  raycast2D but with thickness. `maxDistance` in world units.
 *  NOTE: `x,y` is the swept circle's CENTER at impact (not the surface contact point, as
 *  raycast2D returns) — pair it with `radius` + `nx,ny` if you need the contact. */
export function shapeCast2D(
  world: World, ox: number, oy: number, dx: number, dy: number, radius: number,
  opts: { maxDistance?: number } = {},
): { entityId: number; x: number; y: number; nx: number; ny: number; distance: number } | null {
  const st = worlds.get(world);
  if (!st) return null;
  const cfg = readConfig(world);
  const R = st.R;

  const origin = vecEcsToPhys(ox, oy, cfg.ppm);
  const d = vecEcsToPhys(dx, dy, cfg.ppm);
  const len = Math.hypot(d.x, d.y);
  if (len === 0) return null;
  const vel = { x: d.x / len, y: d.y / len };
  const maxToi = (opts.maxDistance ?? Infinity) / cfg.ppm;

  const shape = new R.Ball(lenToPhys(radius, cfg.ppm));
  // castShape(shapePos, shapeRot, shapeVel, shape, targetDistance, maxToi, stopAtPenetration)
  const hit = st.world.castShape(origin, 0, vel, shape, 0, maxToi, true);
  if (!hit) return null;

  const info = st.colliders.get(hit.collider.handle);
  // Contact point: sweep origin + vel*toi, then convert back to screen space.
  const cx = origin.x + vel.x * hit.time_of_impact;
  const cy = origin.y + vel.y * hit.time_of_impact;
  const p = vecPhysToEcs(cx, cy, cfg.ppm);
  const n = vecPhysToEcs(hit.normal1.x, hit.normal1.y, cfg.ppm);
  const nlen = Math.hypot(n.x, n.y) || 1;
  return {
    entityId: info?.entityId ?? -1,
    x: p.x, y: p.y,
    nx: n.x / nlen, ny: n.y / nlen,
    distance: hit.time_of_impact * cfg.ppm,
  };
}

/** Which physics entity (if any) contains the point (x,y) in ECS/screen coords —
 *  the pick/hit-test query. Returns the first solid collider covering the point. */
export function pointQuery2D(world: World, x: number, y: number): number | null {
  const st = worlds.get(world);
  if (!st) return null;
  const cfg = readConfig(world);
  const p = vecEcsToPhys(x, y, cfg.ppm);
  const proj = st.world.projectPoint(p, true);
  if (!proj || !proj.isInside) return null;
  return st.colliders.get(proj.collider.handle)?.entityId ?? null;
}

// ── Imperative forces / impulses (2D) — the code-facing counterpart to writing RigidBody2D.vx/vy.
// Only affect DYNAMIC bodies (Rapier ignores forces on fixed/kinematic). Call from game systems at
// GAME priority (< PHYSICS) so an impulse this frame is integrated by this frame's step. Linear
// quantities are WORLD-space 2D vectors (converted via vecEcsToPhys → scaled by 1/ppm AND Y-flipped
// like positions/velocities); torque/angular-impulse are scalars about Z (sign-flipped like
// angular velocity, and carry length² → scaled by 1/ppm²).
type RRigidBody2D = import('@dimforge/rapier2d-compat').RigidBody;

/** Resolve the live Rapier body for an entity, or null if it has none yet / isn't in this world. */
function bodyFor2D(world: World, entity: Entity): RRigidBody2D | null {
  const st = worlds.get(world);
  if (!st) return null;
  const rec = st.bodies.get(entity.id());
  if (!rec) return null;
  return st.world.getRigidBody(rec.bodyHandle) ?? null;
}

/** Body + cached ppm — the shared prologue for the scaled control ops. Null if the body isn't live. */
function bodyAndPpm2D(world: World, entity: Entity): { body: RRigidBody2D; ppm: number } | null {
  const st = worlds.get(world);
  if (!st) return null;
  const rec = st.bodies.get(entity.id());
  if (!rec) return null;
  const body = st.world.getRigidBody(rec.bodyHandle);
  return body ? { body, ppm: st.ppm } : null;
}

/** Rapier-body vector methods that take a WORLD 2D vector (scaled + Y-flipped via vecEcsToPhys). */
type LinMethod2D = 'applyImpulse' | 'addForce' | 'setLinvel';
function linApply2D(world: World, entity: Entity, x: number, y: number, wakeUp: boolean, m: LinMethod2D): boolean {
  const r = bodyAndPpm2D(world, entity); if (!r) return false;
  const v = vecEcsToPhys(x, y, r.ppm);   // px → meters, +Y-down → +Y-up
  (r.body[m] as (v: Vec2, w: boolean) => void)(v, wakeUp);
  return true;
}
/** Torque scalar methods — sign-flipped (mirrored frame) + length²-scaled (1/ppm²). */
type AngMethod2D = 'applyTorqueImpulse' | 'addTorque';
function angApply2D(world: World, entity: Entity, torque: number, wakeUp: boolean, m: AngMethod2D): boolean {
  const r = bodyAndPpm2D(world, entity); if (!r) return false;
  (r.body[m] as (t: number, w: boolean) => void)(-torque / (r.ppm * r.ppm), wakeUp);
  return true;
}

/** Apply an instantaneous linear impulse (world-unit momentum) — the one-shot velocity kick for
 *  jumps, knockback, launches. Returns false if the entity has no dynamic body yet. */
export function applyImpulse2D(world: World, entity: Entity, x: number, y: number, wakeUp = true): boolean {
  return linApply2D(world, entity, x, y, wakeUp, 'applyImpulse');
}

/** Apply an instantaneous angular impulse (torque·time) about Z. */
export function applyTorqueImpulse2D(world: World, entity: Entity, torque: number, wakeUp = true): boolean {
  return angApply2D(world, entity, torque, wakeUp, 'applyTorqueImpulse');
}

/** Add a CONTINUOUS linear force (world units). NOTE Rapier semantics: the force persists across
 *  steps until `resetForces2D` — re-add per frame (and reset), or prefer `applyImpulse2D` for one-shots. */
export function addForce2D(world: World, entity: Entity, x: number, y: number, wakeUp = true): boolean {
  return linApply2D(world, entity, x, y, wakeUp, 'addForce');
}

/** Add a CONTINUOUS torque about Z (persists until `resetForces2D`). */
export function addTorque2D(world: World, entity: Entity, torque: number, wakeUp = true): boolean {
  return angApply2D(world, entity, torque, wakeUp, 'addTorque');
}

/** Set linear velocity directly (world units/s) — the intuitive "move at this speed" control. */
export function setLinvel2D(world: World, entity: Entity, x: number, y: number, wakeUp = true): boolean {
  return linApply2D(world, entity, x, y, wakeUp, 'setLinvel');
}

/** Set angular velocity directly (radians/s about Z; sign-flipped for the screen frame). */
export function setAngvel2D(world: World, entity: Entity, angvel: number, wakeUp = true): boolean {
  const body = bodyFor2D(world, entity); if (!body) return false;
  body.setAngvel(angEcsToPhys(angvel), wakeUp);   // rad/s — sign flip only, no length scale
  return true;
}

/** Clear any accumulated continuous forces + torques (from `addForce2D`/`addTorque2D`). */
export function resetForces2D(world: World, entity: Entity, wakeUp = true): boolean {
  const body = bodyFor2D(world, entity); if (!body) return false;
  body.resetForces(wakeUp); body.resetTorques(wakeUp);
  return true;
}

/** Wake a sleeping body so the next step integrates it. */
export function wakeBody2D(world: World, entity: Entity): boolean {
  const body = bodyFor2D(world, entity); if (!body) return false;
  body.wakeUp();
  return true;
}

/** On a solid contact BEGIN, read the Rapier manifold (screen-space point + normal) + compute the
 *  relative approach speed along the normal, then fan a `contact` event to the journal + bus.
 *  Sensors carry no solver contact, so they're skipped. Fires once per contact begin. */
function emitContactDetail2D(st: PhysicsWorldState, world: World, ppm: number, h1: number, h2: number, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit'): void {
  if (phase !== 'enter' || a.isSensor || b.isSensor) return;
  const c1 = st.world.getCollider(h1), c2 = st.world.getCollider(h2);
  if (!c1 || !c2) return;
  let px = 0, py = 0, nx = 0, ny = 0, has = false;
  st.world.contactPair(c1, c2, (manifold) => {
    const nrm = manifold.normal(); nx = nrm.x; ny = nrm.y;
    if (manifold.numSolverContacts() > 0) { const p = manifold.solverContactPoint(0); px = p.x; py = p.y; }
    else { const p = c1.translation(); px = p.x; py = p.y; }  // fallback: collider center
    has = true;
  });
  if (!has) return;
  const point = vecPhysToEcs(px, py, ppm);        // physics meters → screen units (scale + Y-flip)
  const normal = [nx, -ny];                        // direction: Y-flip only (unit stays unit)
  const va = a.entity.has(RigidBody2D) ? (a.entity.get(RigidBody2D) as RbData) : null;
  const vb = b.entity.has(RigidBody2D) ? (b.entity.get(RigidBody2D) as RbData) : null;
  // relative approach velocity along the (unit) normal — world units/s (all in ECS/screen frame)
  const rvx = (vb ? vb.vx : 0) - (va ? va.vx : 0);
  const rvy = (vb ? vb.vy : 0) - (va ? va.vy : 0);
  const speed = Math.abs(rvx * normal[0] + rvy * normal[1]);
  const detail = { point: [point.x, point.y], normal, speed };
  // @contact is Tier-2 (watch-gated): skip the ref resolution + payload build entirely unless a
  // capture is open (the default is OFF). The always-on @collision path records these same entities'
  // names in the side-table, so resolvability isn't lost. GUID-addressed (Percept V4) so contacts
  // correlate across hot-reloads; id fallback for an un-guidable entity. The event bus fires
  // regardless — code subscribers don't depend on the journal watch.
  if (isVerboseCaptureActive('@contact')) {
    emit('@contact', { a: refOf(a), b: refOf(b), point: detail.point, normal, speed }, world);
  }
  physics2DEvents.__emitContact(world, a.entity, b.entity, detail);
}

// (disposePhysics2D / disposeAllPhysics2D + the Stop/world-swap hooks are provided by the
// shared `registry` created near the top of this module — see createPhysicsWorldRegistry.)
