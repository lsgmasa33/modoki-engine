/** physics3DSystem — the ECS ↔ Rapier3D reconciler. A parallel of `physics2DSystem`
 *  for 3D: ECS is the source of truth, Rapier is retained-mode (integer handles). Each
 *  tick it creates bodies for new `RigidBody3D`, frees despawned/changed ones, pushes
 *  static/kinematic poses ECS→Rapier, pulls dynamic poses Rapier→ECS, and drains
 *  collision/sensor events to the journal + `Physics3DEvents` bus + `OnCollision3D` actions.
 *
 *  Registered at `SYSTEM_PRIORITY.PHYSICS (175)` — after game/animation, before transform
 *  propagation (200) — sharing the tier with `physics2DSystem`; each early-outs when its
 *  own body query is empty, so a scene runs whichever dimension it authored (or both). The
 *  pipeline skips this system entirely when the sim isn't running (priority < TRANSFORM).
 *
 *  DETERMINISM: `dt` comes from `getSimDelta` (0 when not running, a fixed dt under the test
 *  harness) → `world.timestep`; Rapier never reads a clock. Play→Stop discards the world so
 *  the next Play rebuilds fresh from the reverted authored transforms.
 *
 *  COORDINATES: unlike 2D there is NO axis flip — ECS (Three.js) and Rapier3D are both
 *  right-handed, +Y up. The only conversion is a length scale by `Physics3D.unitsPerMeter`
 *  and Transform's Euler `rx/ry/rz` ↔ Rapier's quaternion (see `physics3DConvert`). Phase 1:
 *  primitives only (box/sphere/capsule/cylinder/cone), compound children supported, no joints
 *  and no character controller (later phases). */

import type { World, Entity } from 'koota';
import { Transform } from '../traits/Transform';
import { RigidBody3D, type BodyType3D } from '../traits/RigidBody3D';
import { Collider3D } from '../traits/Collider3D';
import { Renderable3D } from '../traits/Renderable3D';
import { Physics3D } from '../traits/Physics3D';
import { OnCollision3D } from '../traits/OnCollision3D';
import { Joint3D, type JointType3D } from '../traits/Joint3D';
import { CharacterController3D } from '../traits/CharacterController3D';
import { EntityAttributes } from '../traits/EntityAttributes';
import { getSimDelta } from './getTime';
import { findEntityByGuid, getCurrentWorld } from '../ecs/world';
import { worldToLocal3D, getWorldTransform3D } from '../ecs/worldTransform';
import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { createPhysicsWorldRegistry } from './physicsWorldRegistry';
import { resolveMeshTemplate } from '../loaders/meshTemplateCache';
import { buildMeshColliderDescs } from './meshColliderGeometry';
import { physics3DEvents } from '../managers/Physics3DEvents';
import { makeFireOnCollision, drainContactEvents, synthesizeContactExits, refOf, type ColliderInfo } from './physicsContactEvents';
import { dropEntityFromContactIndex } from './physicsContactIndex';
import { emit, isVerboseCaptureActive } from './journal';
import { initRapier3D, isRapier3DReady, getRapier3D, type Rapier3D } from './rapier3DLoader';
import {
  vecEcsToPhys, vecEcsToPhysInto, vecPhysToEcs, vecPhysToEcsInto, lenToPhys, packCollisionGroups,
  eulerToQuat, eulerToQuatInto, quatToEulerInto, type Vec3, type Quat, type Euler3,
} from './physics3DConvert';
import { resolveColliderBits } from './physicsLayers';

type RWorld = import('@dimforge/rapier3d-compat').World;
type REventQueue = import('@dimforge/rapier3d-compat').EventQueue;
type RRigidBody = import('@dimforge/rapier3d-compat').RigidBody;
type RCharCtrl = import('@dimforge/rapier3d-compat').KinematicCharacterController;

interface PhysicsConfig3D { gravityX: number; gravityY: number; gravityZ: number; upm: number }

interface BodyRec3D {
  entityId: number;
  entityGen: number;         // koota generation — mismatch ⇒ id recycled ⇒ rebuild
  bodyHandle: number;
  colliderHandles: number[]; // own + adopted compound children
  bodyType: BodyType3D;
  sig: string;               // STRUCTURAL/geometry sig — change ⇒ rebuild
  matSig: string;            // MATERIAL/filter sig — change ⇒ apply-in-place
  // Last pushed static/kinematic pose (position + orientation quaternion), to dedupe writes.
  lastX: number; lastY: number; lastZ: number;
  lastQx: number; lastQy: number; lastQz: number; lastQw: number;
}

interface JointRec3D {
  entityId: number;
  entityGen: number;
  jointHandle: number;
  bhA: number; bhB: number;   // the two body handles — lets removeBody drop recs without a stale getImpulseJoint
  sig: string;
}

/** A SOLO (parentless) static collider: a Collider3D on an entity with NO RigidBody3D of its
 *  own AND no body parent. Rapier supports a collider without a parent rigid-body — it behaves
 *  as fixed world geometry (collides + fires events), so authored static level geometry needs no
 *  dummy body. Placed at the entity's WORLD pose; rebuilt when its geometry/pose/scale changes. */
interface SoloColliderRec {
  entityId: number;
  entityGen: number;
  colliderHandles: number[];
  sig: string;               // geometry + WORLD pose + WORLD scale — change ⇒ rebuild
  matSig: string;            // material/filter — change ⇒ apply-in-place
}

/** The subset of a Rapier revolute/prismatic joint we configure (motor + limits). */
interface MotorJoint {
  setLimits(min: number, max: number): void;
  configureMotorPosition(target: number, stiffness: number, damping: number): void;
  configureMotorVelocity(targetVel: number, factor: number): void;
}

interface PhysicsWorldState3D {
  R: Rapier3D;
  world: RWorld;
  eventQueue: REventQueue;
  bodies: Map<number, BodyRec3D>;   // keyed by ENTITY id
  soloColliders: Map<number, SoloColliderRec>; // keyed by ENTITY id — parentless fixed colliders
  colliders: Map<number, { entityId: number; entity: Entity; isSensor: boolean; bodyEntityId: number }>; // keyed by collider handle
  joints: Map<number, JointRec3D>;  // keyed by joint-entity id
  charCtrl?: RCharCtrl;             // shared kinematic character controller, lazily created
  charCfg?: { skin: number; climb: number; slide: number; autoH: number; autoW: number; snap: number };
  upm: number;                      // Physics3D.unitsPerMeter, refreshed each tick (cache for the query/forces helpers)
  warnedShapes: Set<string>;
}

// Per-World state + WASM lifecycle (the `worlds` Map, dispose/disposeAll, and the Stop /
// world-swap hooks) live in the shared registry — freeState releases this system's WASM handles.
const registry = createPhysicsWorldRegistry<PhysicsWorldState3D>((st) => { st.eventQueue.free(); st.world.free(); });
const worlds = registry.worlds;
/** Free the Rapier3D world for a koota world (test afterEach / scene teardown / zero-body early-out). */
export const disposePhysics3D = registry.dispose;
/** Free ALL Rapier3D worlds (called on Play→Stop so the next Play rebuilds fresh). */
export const disposeAllPhysics3D = registry.disposeAll;

// Scratch reused across the synchronous tick — one world runs at a time.
const _seenBodies = new Set<number>();
const _seenSolo = new Set<number>();
const _seenJoints = new Set<number>();
const _v: Vec3 = { x: 0, y: 0, z: 0 };
const _q: Quat = { x: 0, y: 0, z: 0, w: 1 };
const _e: Euler3 = { rx: 0, ry: 0, rz: 0 };
const _desired: Vec3 = { x: 0, y: 0, z: 0 };   // character move delta (physics meters)
const _childScratch = new Map<number, Entity[]>();
const EMPTY_CHILDREN: readonly Entity[] = Object.freeze([]);

/** O(1) parentId read off the entity handle (no world scan). 0 = root / unparented. */
function parentIdOf(entity: Entity): number {
  return entity.has(EntityAttributes) ? ((entity.get(EntityAttributes) as { parentId?: number }).parentId || 0) : 0;
}

// WORLD-transform bridge (P2 — hierarchy-and-world-transform-plan). A PARENTED body must
// seed/pose at its WORLD transform (not its raw local Transform) and, for solver-owned bodies,
// be read back into LOCAL space. The world pose comes from the fresh `worldTransforms` cache
// (the pre-physics propagation pass at SYSTEM_PRIORITY.TRANSFORM_PREPASS) — an O(1) lookup.
// On a cache MISS the fallback is SYMMETRIC with the readback inverse so seed and readback
// always agree: a ROOT body uses its local tf (world === local, fast, no query); a PARENTED
// body composes its TRUE world on-demand (getWorldTransform3D — headless-safe). In-app the
// cache always hits (the pre-pass runs every frame), so the on-demand path is test-only.
const _wp: TfData3 = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
function worldPoseOf(entity: Entity, tf: TfData3): TfData3 {
  const id = entity.id();
  const w = worldTransforms.get(id);
  if (w) { _wp.x = w.x; _wp.y = w.y; _wp.z = w.z; _wp.rx = w.rx; _wp.ry = w.ry; _wp.rz = w.rz; return _wp; }
  if (!parentIdOf(entity)) { _wp.x = tf.x; _wp.y = tf.y; _wp.z = tf.z; _wp.rx = tf.rx; _wp.ry = tf.ry; _wp.rz = tf.rz; return _wp; }
  const wt = getWorldTransform3D(id, getCurrentWorld());   // parented + no cache → true world
  _wp.x = wt.x; _wp.y = wt.y; _wp.z = wt.z; _wp.rx = wt.rx; _wp.ry = wt.ry; _wp.rz = wt.rz;
  return _wp;
}
const _IDENT_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };

const _ws3: { sx: number; sy: number; sz: number } = { sx: 1, sy: 1, sz: 1 };
/** The collider entity's WORLD scale (sx,sy,sz) for collider-extent threading (P2). Cache-first
 *  (O(1) via the pre-pass); on a miss a ROOT entity uses its local scale (world === local), a
 *  PARENTED one composes true world on-demand — symmetric with `worldPoseOf`. Returns a shared
 *  singleton; read its fields immediately. */
function worldScaleOf(entity: Entity): { sx: number; sy: number; sz: number } {
  const w = worldTransforms.get(entity.id());
  if (w) { _ws3.sx = w.sx; _ws3.sy = w.sy; _ws3.sz = w.sz; return _ws3; }
  const tf = entity.get(Transform) as { sx?: number; sy?: number; sz?: number } | undefined;
  if (!parentIdOf(entity)) { _ws3.sx = tf?.sx ?? 1; _ws3.sy = tf?.sy ?? 1; _ws3.sz = tf?.sz ?? 1; return _ws3; }
  const wt = getWorldTransform3D(entity.id(), getCurrentWorld());
  _ws3.sx = wt.sx; _ws3.sy = wt.sy; _ws3.sz = wt.sz;
  return _ws3;
}

type RbData3 = {
  bodyType: BodyType3D; vx: number; vy: number; vz: number; avx: number; avy: number; avz: number;
  linearDamping: number; angularDamping: number; gravityScale: number;
  fixedRotation: boolean;
  lockRotX: boolean; lockRotY: boolean; lockRotZ: boolean;
  lockTransX: boolean; lockTransY: boolean; lockTransZ: boolean;
  ccd: boolean; canSleep: boolean; isSleeping: boolean;
};
type TfData3 = { x: number; y: number; z: number; rx: number; ry: number; rz: number };
type ColData3 = {
  shape: string; mesh: string; radius: number; halfW: number; halfH: number; halfD: number; halfHeight: number;
  density: number; friction: number; restitution: number; isSensor: boolean;
  physicsLayer: string; collisionGroups: number; collisionMask: number;
};

function readConfig(world: World): PhysicsConfig3D {
  const e = world.queryFirst(Physics3D);
  if (e) {
    const p = e.get(Physics3D) as { gravityX: number; gravityY: number; gravityZ: number; unitsPerMeter: number };
    return { gravityX: p.gravityX, gravityY: p.gravityY, gravityZ: p.gravityZ, upm: p.unitsPerMeter || 1 };
  }
  return { gravityX: 0, gravityY: -9.81, gravityZ: 0, upm: 1 };
}

function getOrCreateWorldState(world: World, cfg: PhysicsConfig3D): PhysicsWorldState3D {
  let st = worlds.get(world);
  if (!st) {
    const R = getRapier3D();
    // Right-handed Y-up both sides → gravity handed straight through, no flip, not scaled by upm.
    const rapierWorld = new R.World({ x: cfg.gravityX, y: cfg.gravityY, z: cfg.gravityZ });
    st = {
      R,
      world: rapierWorld,
      eventQueue: new R.EventQueue(true),
      bodies: new Map(),
      soloColliders: new Map(),
      colliders: new Map(),
      joints: new Map(),
      upm: cfg.upm,
      warnedShapes: new Set(),
    };
    worlds.set(world, st);
  }
  return st;
}

/** GEOMETRY signature — shape + dimensions only. A change REBUILDS the collider (Rapier
 *  can't reshape a live collider). Material/filters are deliberately NOT here; they mutate
 *  in place, so a hot material/layer edit doesn't rebuild (keeps enter/exit balanced). */
/** Resolve the THREE.BufferGeometry a mesh-derived collider reads (mesh-local, resident in the
 *  scene's resource cache). Prefers an explicit `Collider3D.mesh` (a separate collision mesh);
 *  else falls back to this entity's own `Renderable3D` mesh. undefined if neither is set / loaded
 *  (resolveMeshTemplate kicks off a background fetch). */
function resolveColliderGeometry(entity: Entity): import('three').BufferGeometry | undefined {
  let guid = '';
  if (entity.has(Collider3D)) guid = (entity.get(Collider3D) as { mesh?: string }).mesh ?? '';
  if (!guid && entity.has(Renderable3D)) guid = (entity.get(Renderable3D) as { mesh: string }).mesh ?? '';
  if (!guid) return undefined;
  return resolveMeshTemplate(guid)?.geometry;
}

function colliderGeomSig(entity: Entity): string {
  if (!entity.has(Collider3D)) return 'none';
  const c = entity.get(Collider3D) as ColData3;
  let s = `${c.shape}:${c.radius}:${c.halfW}:${c.halfH}:${c.halfD}:${c.halfHeight}`;
  if (c.shape === 'convex' || c.shape === 'trimesh') {
    // Mesh identity (uuid bumps on re-import) + entity scale (baked into the collider) drive rebuild.
    const geo = resolveColliderGeometry(entity);
    const tf = entity.get(Transform) as { sx: number; sy: number; sz: number } | undefined;
    s += `:${geo?.uuid ?? 'nomesh'}:${tf?.sx ?? 1},${tf?.sy ?? 1},${tf?.sz ?? 1}`;
  }
  return s;
}

/** MATERIAL/FILTER signature — density/friction/restitution/sensor + RESOLVED layer bits.
 *  Applied to the live collider(s) in place when it changes (never a rebuild). '' when no collider. */
function colliderMatSig(entity: Entity): string {
  if (!entity.has(Collider3D)) return '';
  const c = entity.get(Collider3D) as ColData3;
  const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
  return `${c.density}:${c.friction}:${c.restitution}:${c.isSensor}:${bits.groups}:${bits.mask}`;
}

/** A compound child's signature: its collider geometry + its LOCAL offset (child Transform,
 *  body-local) + id/generation. Any change rebuilds the parent body. (Same static-offset
 *  limitation as 2D — animating a child offset would rebuild every frame; compound children
 *  are authored with static offsets.) */
function childSig(child: Entity): string {
  const tf = child.get(Transform) as TfData3 | undefined;
  const x = tf ? tf.x : 0, y = tf ? tf.y : 0, z = tf ? tf.z : 0;
  const rx = tf ? tf.rx : 0, ry = tf ? tf.ry : 0, rz = tf ? tf.rz : 0;
  return `${child.id()}:${child.generation()}:${x}:${y}:${z}:${rx}:${ry}:${rz}:${colliderGeomSig(child)}`;
}

/** Body-level structural signature — a change rebuilds the body (seamless for dynamic bodies:
 *  velocity/pose were pulled into the traits last tick). Includes every adopted compound child. */
function bodySig(rb: RbData3, entity: Entity, children: readonly Entity[]): string {
  let s = `${rb.bodyType}|${rb.linearDamping}|${rb.angularDamping}|${rb.gravityScale}` +
    `|${rb.fixedRotation}|${rb.lockRotX}${rb.lockRotY}${rb.lockRotZ}` +
    `|${rb.lockTransX}${rb.lockTransY}${rb.lockTransZ}` +
    `|${rb.ccd}|${rb.canSleep}|${colliderGeomSig(entity)}`;
  for (const ch of children) s += `#${childSig(ch)}`;
  return s;
}

/** Material/filter signature for the whole body (own collider + each compound child). */
function bodyMatSig(entity: Entity, children: readonly Entity[]): string {
  let s = colliderMatSig(entity);
  for (const ch of children) s += `#${colliderMatSig(ch)}`;
  return s;
}

/** Re-apply material/filters from each collider entity's Collider3D onto its live Rapier
 *  collider(s), in place. Keeps the event-drain `isSensor` flag in sync too. Works for a body
 *  record or a solo-collider record (both expose `colliderHandles`). */
function applyBodyMaterial(st: PhysicsWorldState3D, rec: { colliderHandles: number[] }): void {
  for (const h of rec.colliderHandles) {
    const info = st.colliders.get(h);
    if (!info || !info.entity.isAlive() || !info.entity.has(Collider3D)) continue;
    const col = st.world.getCollider(h);
    if (!col) continue;
    const c = info.entity.get(Collider3D) as ColData3;
    const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
    col.setDensity(c.density);
    col.setFriction(c.friction);
    col.setRestitution(c.restitution);
    col.setSensor(!!c.isSensor);
    col.setCollisionGroups(packCollisionGroups(bits.groups, bits.mask));
    info.isSensor = !!c.isSensor;
  }
}

function warnShapeOnce(st: PhysicsWorldState3D, key: string, msg: string): void {
  if (!st.warnedShapes.has(key)) { console.warn(msg); st.warnedShapes.add(key); }
}

type RColliderDesc = import('@dimforge/rapier3d-compat').ColliderDesc;

/** Build the Rapier ColliderDesc(s) for a collider. Returns an ARRAY — a primitive yields one
 *  desc; a mesh-derived shape (`convex`/`trimesh`) may in principle yield several (single for now).
 *  Null (with a one-shot warn) if the shape is unknown or a mesh isn't available/degenerate.
 *  `entity` is the collider-bearing entity (needed to resolve its Renderable3D mesh + scale). */
function makeColliderDesc(st: PhysicsWorldState3D, c: ColData3, upm: number, entity: Entity, sx = 1, sy = 1, sz = 1): RColliderDesc[] | null {
  const R = st.R;
  // Extents scale by the collider entity's WORLD scale (P2 scale threading) so a collider under a
  // SCALED parent is the right physical size. Axis-symmetric shapes (sphere/capsule/cylinder/cone,
  // Y-axis) can't represent an ellipsoid, so a non-uniform scale is approximated by the mean of the
  // relevant axes with a one-time warning.
  const ax = Math.abs(sx), ay = Math.abs(sy), az = Math.abs(sz);
  const sphereScale = (ax + ay + az) / 3;
  const radialScale = (ax + az) / 2;   // capsule/cylinder/cone radius lives in the XZ plane
  const nonUniform3 = Math.abs(ax - ay) > 1e-3 * Math.max(ax, ay, az, 1) || Math.abs(ay - az) > 1e-3 * Math.max(ax, ay, az, 1) || Math.abs(ax - az) > 1e-3 * Math.max(ax, ay, az, 1);
  const nonUniformXZ = Math.abs(ax - az) > 1e-3 * Math.max(ax, az, 1);
  switch (c.shape) {
    case 'box':
      return [R.ColliderDesc.cuboid(lenToPhys(c.halfW, upm) * ax, lenToPhys(c.halfH, upm) * ay, lenToPhys(c.halfD, upm) * az)];
    case 'sphere':
      if (nonUniform3) warnShapeOnce(st, 'sphere:nonuniform', `[physics3D] a sphere collider under a NON-UNIFORM scale (${ax.toFixed(2)},${ay.toFixed(2)},${az.toFixed(2)}) can't be an ellipsoid — approximating with the mean radius. Use a box/convex mesh for a non-uniform shape.`);
      return [R.ColliderDesc.ball(lenToPhys(c.radius, upm) * sphereScale)];
    // Rapier's capsule halfHeight is the SEGMENT half-height (cap centers), excluding the caps.
    case 'capsule':
      if (nonUniformXZ) warnShapeOnce(st, 'capsule:nonuniform', `[physics3D] a capsule collider under a non-uniform XZ scale approximates its radius (mean of X,Z).`);
      return [R.ColliderDesc.capsule(lenToPhys(c.halfHeight, upm) * ay, lenToPhys(c.radius, upm) * radialScale)];
    case 'cylinder':
      if (nonUniformXZ) warnShapeOnce(st, 'cylinder:nonuniform', `[physics3D] a cylinder collider under a non-uniform XZ scale approximates its radius (mean of X,Z).`);
      return [R.ColliderDesc.cylinder(lenToPhys(c.halfHeight, upm) * ay, lenToPhys(c.radius, upm) * radialScale)];
    case 'cone':
      if (nonUniformXZ) warnShapeOnce(st, 'cone:nonuniform', `[physics3D] a cone collider under a non-uniform XZ scale approximates its radius (mean of X,Z).`);
      return [R.ColliderDesc.cone(lenToPhys(c.halfHeight, upm) * ay, lenToPhys(c.radius, upm) * radialScale)];
    case 'convex':
    case 'trimesh': {
      const geo = resolveColliderGeometry(entity);
      if (!geo) {
        warnShapeOnce(st, `mesh:${entity.id()}`, `[physics3D] '${c.shape}' collider on entity ${entity.id()} needs a mesh (Collider3D.mesh, or a Renderable3D mesh on the same entity) that is loaded — body created without a collider.`);
        return null;
      }
      // Mesh geometry is in mesh-local space (matches the body-local collider frame); bake the
      // entity's WORLD scale into the vertices since Rapier bodies have no scale (P2 — was local
      // scale, so a mesh collider under a scaled parent was wrong). Convert to physics meters via
      // upm. NOTE trimesh is STATIC-only — a dynamic body gets no solid response.
      const descs = buildMeshColliderDescs(R, geo, c.shape, sx / upm, sy / upm, sz / upm) as RColliderDesc[] | null;
      if (!descs) {
        warnShapeOnce(st, `mesh:hull:${entity.id()}`, `[physics3D] convex hull failed for entity ${entity.id()} (degenerate/empty geometry) — body created without a collider.`);
        return null;
      }
      return descs;
    }
    default:
      warnShapeOnce(st, c.shape, `[physics3D] unknown collider shape '${c.shape}' — body created without a collider.`);
      return null;
  }
}

/** Build + attach the collider from `colliderEntity`'s Collider3D onto `body`, optionally at
 *  a body-LOCAL offset (compound children). Maps the resulting collider back to the SAME
 *  entity so events resolve to the collider's owner. Returns the created handle(s) (empty if
 *  the shape was invalid). */
function attachCollider(
  st: PhysicsWorldState3D,
  body: RRigidBody, bodyEntityId: number,   // the OWNING body's entity id (for Percept roll-up)
  colliderEntity: Entity, cfg: PhysicsConfig3D,
  offset: { x: number; y: number; z: number; rx: number; ry: number; rz: number } | null,
  sx = 1, sy = 1, sz = 1,   // collider entity's WORLD scale → collider EXTENTS (P2 scale threading)
): number[] {
  const R = st.R;
  const c = colliderEntity.get(Collider3D) as ColData3;
  const descs = makeColliderDesc(st, c, cfg.upm, colliderEntity, sx, sy, sz);
  if (!descs) return [];
  const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
  const groups = packCollisionGroups(bits.groups, bits.mask);
  const offQuat = offset ? eulerToQuat(offset.rx, offset.ry, offset.rz) : null;
  const handles: number[] = [];
  for (const cd of descs) {
    cd.setDensity(c.density).setFriction(c.friction).setRestitution(c.restitution)
      .setSensor(c.isSensor)
      .setCollisionGroups(groups)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    if (offset && offQuat) cd.setTranslation(offset.x, offset.y, offset.z).setRotation(offQuat);
    const col = st.world.createCollider(cd, body);
    st.colliders.set(col.handle, { entityId: colliderEntity.id(), entity: colliderEntity, isSensor: !!c.isSensor, bodyEntityId });
    handles.push(col.handle);
  }
  return handles;
}

function createBody(
  st: PhysicsWorldState3D, entityId: number, entityGen: number,
  tf: TfData3, rb: RbData3,
  entity: Entity, children: readonly Entity[],
  cfg: PhysicsConfig3D, sig: string,
): BodyRec3D {
  const R = st.R;
  // Seed the body at its WORLD pose (P2) — a parented body's world ≠ its local Transform.
  const wp = worldPoseOf(entity, tf);
  const pos = vecEcsToPhys(wp.x, wp.y, wp.z, cfg.upm);
  const quat = eulerToQuat(wp.rx, wp.ry, wp.rz);
  const vel = vecEcsToPhys(rb.vx, rb.vy, rb.vz, cfg.upm);

  let desc;
  if (rb.bodyType === 'static') desc = R.RigidBodyDesc.fixed();
  else if (rb.bodyType === 'kinematic') desc = R.RigidBodyDesc.kinematicPositionBased();
  else desc = R.RigidBodyDesc.dynamic();

  desc.setTranslation(pos.x, pos.y, pos.z).setRotation(quat)
    .setLinvel(vel.x, vel.y, vel.z).setAngvel({ x: rb.avx, y: rb.avy, z: rb.avz })
    .setLinearDamping(rb.linearDamping).setAngularDamping(rb.angularDamping)
    .setGravityScale(rb.gravityScale).setCcdEnabled(rb.ccd).setCanSleep(rb.canSleep);
  // Rotation locks: fixedRotation locks all three; otherwise honor the per-axis flags.
  const rlock = rb.fixedRotation;
  desc.enabledRotations(!(rlock || rb.lockRotX), !(rlock || rb.lockRotY), !(rlock || rb.lockRotZ));
  // Translation locks (only touch the default when at least one axis is frozen).
  if (rb.lockTransX || rb.lockTransY || rb.lockTransZ) {
    desc.enabledTranslations(!rb.lockTransX, !rb.lockTransY, !rb.lockTransZ);
  }

  const body = st.world.createRigidBody(desc);

  const colliderHandles: number[] = [];
  // Body's WORLD scale → own collider extents + compound-child offsets, so a collider under a
  // SCALED parent is the right size (P2 scale threading). Authored-time (rebuild on structural
  // change, not a runtime scale tween).
  const bw = worldScaleOf(entity);
  const bodySx = bw.sx, bodySy = bw.sy, bodySz = bw.sz;   // capture — worldScaleOf returns a shared singleton
  if (entity.has(Collider3D)) {
    colliderHandles.push(...attachCollider(st, body, entityId, entity, cfg, null, bodySx, bodySy, bodySz));
  }
  // Compound: each child collider at its body-LOCAL Transform offset (scaled by the BODY's world
  // scale — the child's local offset lives in the parent's scaled frame); child EXTENTS use the
  // CHILD's world scale (parent × its own local).
  for (const child of children) {
    const ctf = child.get(Transform) as TfData3 | undefined;
    const off = ctf ? vecEcsToPhys(ctf.x * bodySx, ctf.y * bodySy, ctf.z * bodySz, cfg.upm) : { x: 0, y: 0, z: 0 };
    const cw = worldScaleOf(child);
    colliderHandles.push(...attachCollider(st, body, entityId, child, cfg, {
      x: off.x, y: off.y, z: off.z,
      rx: ctf ? ctf.rx : 0, ry: ctf ? ctf.ry : 0, rz: ctf ? ctf.rz : 0,
    }, cw.sx, cw.sy, cw.sz));
  }

  const rec: BodyRec3D = {
    entityId, entityGen, bodyHandle: body.handle, colliderHandles, bodyType: rb.bodyType, sig,
    matSig: bodyMatSig(entity, children),
    lastX: pos.x, lastY: pos.y, lastZ: pos.z,
    lastQx: quat.x, lastQy: quat.y, lastQz: quat.z, lastQw: quat.w,
  };
  st.bodies.set(entityId, rec);
  return rec;
}

// The declarative OnCollision3D dispatcher, bound to this dimension's trait (shared core).
const fireOnCollision = makeFireOnCollision(OnCollision3D);

function removeBody(st: PhysicsWorldState3D, world: World, rec: BodyRec3D): void {
  synthesizeContactExits(rec.colliderHandles, world, st.colliders, st.world.narrowPhase, physics3DEvents, fireOnCollision);
  // Rapier's removeRigidBody auto-removes this body's joints, invalidating their handles.
  // Drop the referencing JointRecs from our map here (map-only, NO getImpulseJoint — a stale
  // handle could resolve to a reused-index sibling). The reconciler recreates them next pass.
  if (st.joints.size > 0) {
    for (const [jid, jrec] of st.joints) {
      if (jrec.bhA === rec.bodyHandle || jrec.bhB === rec.bodyHandle) st.joints.delete(jid);
    }
  }
  for (const h of rec.colliderHandles) st.colliders.delete(h);
  const body = st.world.getRigidBody(rec.bodyHandle);
  if (body) st.world.removeRigidBody(body); // also removes its colliders
  st.bodies.delete(rec.entityId);
  // Percept: force-clear this body's contact index by BODY identity (the synthesized
  // exits above can roll a dead/reparented compound child up to the wrong body).
  dropEntityFromContactIndex(world, rec.entityId);
}

// ── Solo (parentless) static colliders ──
// A Collider3D with no RigidBody3D of its own and no body parent is created as a PARENTLESS
// Rapier collider — fixed world geometry that collides + fires events without a dummy body.

/** Build + insert `colliderEntity`'s Collider3D as a parentless (fixed) collider at its WORLD
 *  pose. Maps every handle back to the entity so events resolve to its owner. Empty ⇒ bad shape. */
function attachSoloCollider(st: PhysicsWorldState3D, colliderEntity: Entity, cfg: PhysicsConfig3D): number[] {
  const R = st.R;
  const c = colliderEntity.get(Collider3D) as ColData3;
  const ws = worldScaleOf(colliderEntity);
  const sx = ws.sx, sy = ws.sy, sz = ws.sz;   // capture — worldScaleOf returns a shared singleton
  const descs = makeColliderDesc(st, c, cfg.upm, colliderEntity, sx, sy, sz);
  if (!descs) return [];
  const bits = resolveColliderBits(c.physicsLayer, c.collisionGroups, c.collisionMask);
  const groups = packCollisionGroups(bits.groups, bits.mask);
  const tf = colliderEntity.get(Transform) as TfData3;
  const wp = worldPoseOf(colliderEntity, tf);   // fixed collider sits at the entity's WORLD pose
  const pos = vecEcsToPhys(wp.x, wp.y, wp.z, cfg.upm);
  const quat = eulerToQuat(wp.rx, wp.ry, wp.rz);
  const handles: number[] = [];
  for (const cd of descs) {
    cd.setDensity(c.density).setFriction(c.friction).setRestitution(c.restitution)
      .setSensor(c.isSensor)
      .setCollisionGroups(groups)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
      .setTranslation(pos.x, pos.y, pos.z).setRotation(quat);
    const col = st.world.createCollider(cd);   // no parent body ⇒ Rapier treats it as fixed
    st.colliders.set(col.handle, { entityId: colliderEntity.id(), entity: colliderEntity, isSensor: !!c.isSensor, bodyEntityId: colliderEntity.id() });
    handles.push(col.handle);
  }
  return handles;
}

/** STRUCTURAL signature for a solo collider — geometry + WORLD pose + WORLD scale + id/gen. A
 *  change rebuilds it (Rapier can't reshape a live collider; a fixed collider is repositioned by
 *  rebuild here, matching the compound-child static-offset model). Material/filter is bodyMatSig-
 *  style and applied in place. */
function soloColliderSig(entity: Entity, tf: TfData3): string {
  const wp = worldPoseOf(entity, tf);
  const px = wp.x, py = wp.y, pz = wp.z, prx = wp.rx, pry = wp.ry, prz = wp.rz;   // capture before worldScaleOf
  const ws = worldScaleOf(entity);
  return `${entity.id()}:${entity.generation()}:${px}:${py}:${pz}:${prx}:${pry}:${prz}:${ws.sx}:${ws.sy}:${ws.sz}:${colliderGeomSig(entity)}`;
}

function removeSoloCollider(st: PhysicsWorldState3D, world: World, rec: SoloColliderRec): void {
  synthesizeContactExits(rec.colliderHandles, world, st.colliders, st.world.narrowPhase, physics3DEvents, fireOnCollision);
  for (const h of rec.colliderHandles) {
    const col = st.world.getCollider(h);
    if (col) st.world.removeCollider(col, true);   // wakeUp any body it was touching
    st.colliders.delete(h);
  }
  st.soloColliders.delete(rec.entityId);
  dropEntityFromContactIndex(world, rec.entityId);
}

// ── Joints (constraints) ──

type JointData3 = {
  type: JointType3D; entityA: string; entityB: string;
  anchorAX: number; anchorAY: number; anchorAZ: number;
  anchorBX: number; anchorBY: number; anchorBZ: number;
  length: number; stiffness: number; damping: number;
  axisX: number; axisY: number; axisZ: number;
  limitsEnabled: boolean; limitMin: number; limitMax: number;
  motorEnabled: boolean; motorTargetVel: number; motorTargetPos: number;
  motorStiffness: number; motorDamping: number;
};

function jointSig(j: JointData3, bhA: number, bhB: number): string {
  return [
    j.type, j.entityA, j.entityB,
    j.anchorAX, j.anchorAY, j.anchorAZ, j.anchorBX, j.anchorBY, j.anchorBZ,
    j.length, j.stiffness, j.damping, j.axisX, j.axisY, j.axisZ,
    j.limitsEnabled, j.limitMin, j.limitMax,
    j.motorEnabled, j.motorTargetVel, j.motorTargetPos, j.motorStiffness, j.motorDamping,
    bhA, bhB,
  ].join('|');
}

function removeJoint(st: PhysicsWorldState3D, rec: JointRec3D): void {
  const j = st.world.getImpulseJoint(rec.jointHandle);
  if (j) st.world.removeImpulseJoint(j, true);
  st.joints.delete(rec.entityId);
}

function createJoint(
  st: PhysicsWorldState3D, entityId: number, entityGen: number,
  j: JointData3, bodyAHandle: number, bodyBHandle: number, cfg: PhysicsConfig3D, sig: string,
): void {
  const R = st.R;
  const bodyA = st.world.getRigidBody(bodyAHandle);
  const bodyB = st.world.getRigidBody(bodyBHandle);
  if (!bodyA || !bodyB) return;

  const a1 = vecEcsToPhys(j.anchorAX, j.anchorAY, j.anchorAZ, cfg.upm);
  const a2 = vecEcsToPhys(j.anchorBX, j.anchorBY, j.anchorBZ, cfg.upm);
  const normAxis = () => {
    const l = Math.hypot(j.axisX, j.axisY, j.axisZ) || 1;
    return { x: j.axisX / l, y: j.axisY / l, z: j.axisZ / l };
  };

  let jd;
  switch (j.type) {
    case 'spring': jd = R.JointData.spring(lenToPhys(j.length, cfg.upm), j.stiffness, j.damping, a1, a2); break;
    case 'rope': jd = R.JointData.rope(lenToPhys(j.length, cfg.upm), a1, a2); break;
    case 'spherical': jd = R.JointData.spherical(a1, a2); break;
    case 'revolute': jd = R.JointData.revolute(a1, a2, normAxis()); break;
    case 'prismatic': jd = R.JointData.prismatic(a1, a2, normAxis()); break;
    // Identity frames lock a ZERO relative rotation — the weld aligns both bodies' orientations.
    case 'fixed': jd = R.JointData.fixed(a1, { x: 0, y: 0, z: 0, w: 1 }, a2, { x: 0, y: 0, z: 0, w: 1 }); break;
    default: return;
  }

  const joint = st.world.createImpulseJoint(jd, bodyA, bodyB, true);

  // Motor + limits apply to the axis joints (revolute/prismatic). No handedness flip in 3D,
  // so angles/distances pass straight through (unlike the 2D revolute negate/swap).
  if (j.type === 'revolute' || j.type === 'prismatic') {
    const mj = joint as unknown as MotorJoint;
    const isRev = j.type === 'revolute';
    if (j.limitsEnabled) {
      if (isRev) mj.setLimits(j.limitMin, j.limitMax);                                   // radians
      else mj.setLimits(lenToPhys(j.limitMin, cfg.upm), lenToPhys(j.limitMax, cfg.upm));  // world units
    }
    if (j.motorEnabled) {
      const pos = isRev ? j.motorTargetPos : lenToPhys(j.motorTargetPos, cfg.upm);
      const vel = isRev ? j.motorTargetVel : lenToPhys(j.motorTargetVel, cfg.upm);
      if (j.motorStiffness > 0) mj.configureMotorPosition(pos, j.motorStiffness, j.motorDamping);
      else mj.configureMotorVelocity(vel, j.motorDamping);
    }
  }

  st.joints.set(entityId, { entityId, entityGen, jointHandle: joint.handle, bhA: bodyAHandle, bhB: bodyBHandle, sig });
}

/** Reconcile Joint3D entities → Rapier impulse joints. Runs AFTER bodies exist so both
 *  endpoints resolve. A joint activates once both `entityA`/`entityB` GUIDs map to bodies;
 *  it is torn down if either endpoint disappears. */
function reconcileJoints(st: PhysicsWorldState3D, world: World, cfg: PhysicsConfig3D): void {
  const seen = _seenJoints; seen.clear();
  world.query(Joint3D).updateEach(([j]: [JointData3], entity) => {
    const id = entity.id();
    const gen = entity.generation();
    const ea = j.entityA ? findEntityByGuid(j.entityA, world) : undefined;
    const eb = j.entityB ? findEntityByGuid(j.entityB, world) : undefined;
    const recA = ea ? st.bodies.get(ea.id()) : undefined;
    const recB = eb ? st.bodies.get(eb.id()) : undefined;

    if (!recA || !recB || recA === recB) {
      const existing = st.joints.get(id);
      if (existing) removeJoint(st, existing);
      if (recA && recA === recB && !st.warnedShapes.has('selfjoint')) {
        console.warn('[physics3D] Joint3D entityA and entityB resolve to the same entity — skipped.');
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

// ── Character controller ──

type CharData3 = {
  speed: number; jumpSpeed: number; gravityScale: number;
  maxSlopeClimbDeg: number; minSlopeSlideDeg: number;
  autostepHeight: number; autostepMinWidth: number; snapToGroundDist: number; skin: number;
  moveX: number; moveZ: number; jump: boolean; grounded: boolean; velY: number; readbackReady: boolean;
};

/** Character-controller pass — runs after bodies/joints reconcile, BEFORE the world step. For
 *  each kinematic character it integrates gravity + XZ input into a desired delta, asks Rapier's
 *  KinematicCharacterController for the collision-safe movement (slide/autostep/slope/snap), and
 *  sets the body's next kinematic translation. Writes back grounded + velY; consumes the one-shot
 *  jump. No-op when dt<=0. No axis flip — gravity is -Y, jump is +Y. */
function stepCharacters(st: PhysicsWorldState3D, world: World, cfg: PhysicsConfig3D, dt: number): void {
  if (dt <= 0) return;
  world.query(Transform, RigidBody3D, Collider3D, CharacterController3D)
    .updateEach(([tf, rb, , cc]: [TfData3, RbData3, unknown, CharData3], entity) => {
      if (rb.bodyType !== 'kinematic') return; // a character must be a kinematic body
      const rec = st.bodies.get(entity.id());
      if (!rec || rec.colliderHandles.length === 0) return;
      const body = st.world.getRigidBody(rec.bodyHandle);
      const collider = st.world.getCollider(rec.colliderHandles[0]);
      if (!body || !collider) return;

      // Honor an external Transform write (respawn/teleport): if the authored pose diverged from
      // what we last pulled back, hard-set the body there and stop the fall. Compare in WORLD
      // space (the body's frame) so a parented character's local Transform maps correctly. (P2)
      const wp = worldPoseOf(entity, tf);
      const apos = vecEcsToPhysInto(wp.x, wp.y, wp.z, cfg.upm, _v);   // scratch — no per-char alloc
      if (Math.abs(apos.x - rec.lastX) > 1e-4 || Math.abs(apos.y - rec.lastY) > 1e-4 || Math.abs(apos.z - rec.lastZ) > 1e-4) {
        body.setTranslation(apos, true);                             // apos === _v, consumed synchronously
        rec.lastX = apos.x; rec.lastY = apos.y; rec.lastZ = apos.z;
        cc.velY = 0;
      }

      const skin = Math.max(0.001, cc.skin / cfg.upm);
      if (!st.charCtrl) st.charCtrl = st.world.createCharacterController(skin);
      const ctrl = st.charCtrl;
      // Reconfigure the SHARED controller only when this character's (static) params differ.
      const climb = (cc.maxSlopeClimbDeg * Math.PI) / 180, slide = (cc.minSlopeSlideDeg * Math.PI) / 180;
      const autoH = cc.autostepHeight > 0 ? cc.autostepHeight / cfg.upm : 0;
      const autoW = Math.max(0, cc.autostepMinWidth) / cfg.upm;
      const snap = cc.snapToGroundDist > 0 ? cc.snapToGroundDist / cfg.upm : 0;
      const pc = st.charCfg;
      if (!pc || pc.skin !== skin || pc.climb !== climb || pc.slide !== slide || pc.autoH !== autoH || pc.autoW !== autoW || pc.snap !== snap) {
        ctrl.setUp({ x: 0, y: 1, z: 0 });                 // physics up = +Y (right-handed Y-up)
        ctrl.setOffset(skin);                             // collision skin gap — must re-apply on skin change (was missing)
        ctrl.setApplyImpulsesToDynamicBodies(true);
        ctrl.setMaxSlopeClimbAngle(climb);
        ctrl.setMinSlopeSlideAngle(slide);
        if (autoH > 0) ctrl.enableAutostep(autoH, autoW, true); else ctrl.disableAutostep();
        if (snap > 0) ctrl.enableSnapToGround(snap); else ctrl.disableSnapToGround();
        st.charCfg = { skin, climb, slide, autoH, autoW, snap };
      }

      // Integrate gravity into velY (world units/s, +up). cfg.gravityY is m/s² and negative
      // (down); × upm → units/s². No flip.
      let velY = cc.velY + cfg.gravityY * cfg.upm * cc.gravityScale * dt;
      // Jump only when grounded (no coyote-time / air-jump — game-feel polish, deferred).
      if (cc.jump && cc.grounded) velY = Math.abs(cc.jumpSpeed); // launch up (+Y)

      // Desired delta in physics meters (world units / upm). No flip.
      _desired.x = (cc.moveX * cc.speed / cfg.upm) * dt;
      _desired.z = (cc.moveZ * cc.speed / cfg.upm) * dt;
      _desired.y = (velY / cfg.upm) * dt;
      ctrl.computeColliderMovement(collider, _desired);
      const mv = ctrl.computedMovement();
      const grounded = ctrl.computedGrounded();

      const t = body.translation();
      _v.x = t.x + mv.x; _v.y = t.y + mv.y; _v.z = t.z + mv.z;   // reuse scratch (apos no longer needed)
      body.setNextKinematicTranslation(_v);

      if (grounded && velY < 0) velY = 0; // landed — stop the fall
      cc.velY = velY;
      cc.grounded = grounded;
      cc.readbackReady = true;            // grounded/velY now reflect real physics
      cc.jump = false;                    // one-shot
    });
}

/** Collect COMPOUND CHILD colliders: entities with a Collider3D + Transform but NO
 *  RigidBody3D of their own, grouped by their (numeric, runtime) parentId. Sorted by id so
 *  the parent signature is stable. Single-level only (a direct child of a body). */
function collectCompoundChildren(world: World): Map<number, Entity[]> {
  _childScratch.clear();
  world.query(Transform, Collider3D, EntityAttributes).updateEach(([, , attr]: [TfData3, unknown, { parentId: number }], entity) => {
    if (entity.has(RigidBody3D)) return;          // it's its own body, not a compound child
    const pid = attr.parentId || 0;
    let bucket = _childScratch.get(pid);
    if (!bucket) { bucket = []; _childScratch.set(pid, bucket); }
    bucket.push(entity);
  });
  for (const bucket of _childScratch.values()) bucket.sort((a, b) => a.id() - b.id());
  return _childScratch;
}

/** The 3D physics tick. Registered at SYSTEM_PRIORITY.PHYSICS in the app pipeline. */
export function physics3DSystem(world: World): void {
  // Cheap early-out: nothing to simulate. Free any leftover state so its WASM bodies don't
  // linger (the despawn-cleanup pass below is skipped by this return).
  if (world.queryFirst(RigidBody3D) === undefined) {
    const st = worlds.get(world);
    if (st) {
      // Percept: this path SKIPS the removeBody cleanup pass — force-clear each lingering
      // 3D body's contact index entry here (targeted; leaves any 2D bodies in this world's
      // shared index untouched) before freeing the Rapier world.
      for (const id of st.bodies.keys()) dropEntityFromContactIndex(world, id);
      for (const id of st.soloColliders.keys()) dropEntityFromContactIndex(world, id);
      disposePhysics3D(world);
    }
    return;
  }
  // Lazy WASM init — a game with no 3D physics never instantiates Rapier3D.
  if (!isRapier3DReady()) { void initRapier3D(); return; }

  const cfg = readConfig(world);
  const st = getOrCreateWorldState(world, cfg);
  // Live gravity edits — cheap to set every tick. No flip (right-handed Y-up both sides).
  st.world.gravity = { x: cfg.gravityX, y: cfg.gravityY, z: cfg.gravityZ };
  st.upm = cfg.upm;   // refresh the cached scale for the query/forces helpers (avoids re-querying)

  const dt = getSimDelta(world);
  const seen = _seenBodies; seen.clear();
  const childrenByParent = collectCompoundChildren(world);

  // ── Reconcile + push (ECS → Rapier) ──
  world.query(Transform, RigidBody3D).updateEach(([tf, rb]: [TfData3, RbData3], entity) => {
    const id = entity.id();
    const gen = entity.generation();
    seen.add(id);
    const children = childrenByParent.get(id) ?? EMPTY_CHILDREN;
    const sig = bodySig(rb, entity, children);
    let rec = st.bodies.get(id);
    if (rec && (rec.sig !== sig || rec.entityGen !== gen)) { removeBody(st, world, rec); rec = undefined; }
    if (!rec) { createBody(st, id, gen, tf, rb, entity, children, cfg, sig); return; }

    // Material / filter / layer edits apply to the live collider(s) IN PLACE — no rebuild.
    const matSig = bodyMatSig(entity, children);
    if (rec.matSig !== matSig) { applyBodyMaterial(st, rec); rec.matSig = matSig; }

    // Push authored pose for bodies the solver does NOT own — EXCEPT a character, whose
    // kinematic target is driven by stepCharacters (below), not its authored Transform.
    if ((rec.bodyType === 'kinematic' && !entity.has(CharacterController3D)) || rec.bodyType === 'static') {
      const wp = worldPoseOf(entity, tf);   // WORLD pose (P2) — parented bodies pose at world, not local
      const pos = vecEcsToPhysInto(wp.x, wp.y, wp.z, cfg.upm, _v);   // scratch — no per-body alloc
      const quat = eulerToQuatInto(wp.rx, wp.ry, wp.rz, _q);
      if (pos.x !== rec.lastX || pos.y !== rec.lastY || pos.z !== rec.lastZ ||
          quat.x !== rec.lastQx || quat.y !== rec.lastQy || quat.z !== rec.lastQz || quat.w !== rec.lastQw) {
        const body = st.world.getRigidBody(rec.bodyHandle);
        if (body) {
          // pos === _v, quat === _q (right-shaped, consumed synchronously) — pass scratch directly.
          if (rec.bodyType === 'kinematic') {
            body.setNextKinematicTranslation(pos);
            body.setNextKinematicRotation(quat);
          } else {
            body.setTranslation(pos, true);
            body.setRotation(quat, true);
          }
        }
        rec.lastX = pos.x; rec.lastY = pos.y; rec.lastZ = pos.z;
        rec.lastQx = quat.x; rec.lastQy = quat.y; rec.lastQz = quat.z; rec.lastQw = quat.w;
      }
    }
  });

  // ── Cleanup despawned/detached bodies ──
  for (const [id, rec] of st.bodies) {
    if (!seen.has(id)) removeBody(st, world, rec);
  }

  // ── Solo (parentless) static colliders: a Collider3D with no RigidBody3D and no body parent
  //    becomes a FIXED world collider (Rapier's native parentless collider) — it collides + fires
  //    events without a dummy body. Reconciled AFTER the body pass so `st.bodies` reflects this
  //    frame (a bucket whose parent IS a body was already adopted as compound children above). ──
  const seenSolo = _seenSolo; seenSolo.clear();
  for (const [pid, bucket] of childrenByParent) {
    if (st.bodies.has(pid)) continue;   // adopted as compound children of a body — not solo
    for (const child of bucket) {
      const cid = child.id();
      const gen = child.generation();
      const tf = child.get(Transform) as TfData3;
      const sig = soloColliderSig(child, tf);
      let rec = st.soloColliders.get(cid);
      if (rec && (rec.sig !== sig || rec.entityGen !== gen)) { removeSoloCollider(st, world, rec); rec = undefined; }
      if (!rec) {
        const handles = attachSoloCollider(st, child, cfg);
        // No handles ⇒ shape invalid / mesh not yet loaded (makeColliderDesc warned once) — leave
        // it untracked so it retries next tick (e.g. once the collision mesh resolves).
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

  // ── Pull dynamic bodies (Rapier → ECS) — only when a step ran (dt>0), so a paused sim
  //    doesn't overwrite authored/inspector edits with the body's f32-quantized pose. ──
  if (dt > 0) world.query(Transform, RigidBody3D).updateEach(([tf, rb]: [TfData3, RbData3], entity) => {
    const rec = st.bodies.get(entity.id());
    if (!rec || rec.bodyType !== 'dynamic') return;
    const body = st.world.getRigidBody(rec.bodyHandle);
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    // The solver poses the body in WORLD space. For a PARENTED body, invert the parent's
    // world matrix so the LOCAL Transform stays correct (else the mesh flies off its body).
    // Root bodies keep the fast path (world === local, no inverse). (P2)
    const parentId = parentIdOf(entity);
    if (parentId) {
      vecPhysToEcsInto(t.x, t.y, t.z, cfg.upm, _v);      // world pos in ECS units
      const local = worldToLocal3D(entity.id(), _v, r, world); // r: Rapier quat === ECS quat (no 3D flip)
      tf.x = local.x; tf.y = local.y; tf.z = local.z;
      tf.rx = local.rx; tf.ry = local.ry; tf.rz = local.rz;
    } else {
      vecPhysToEcsInto(t.x, t.y, t.z, cfg.upm, _v);
      tf.x = _v.x; tf.y = _v.y; tf.z = _v.z;
      quatToEulerInto(r.x, r.y, r.z, r.w, _e);
      tf.rx = _e.rx; tf.ry = _e.ry; tf.rz = _e.rz;
    }
    const lv = body.linvel();
    vecPhysToEcsInto(lv.x, lv.y, lv.z, cfg.upm, _v);
    rb.vx = _v.x; rb.vy = _v.y; rb.vz = _v.z;
    const av = body.angvel();     // rad/s — angular velocity is not length-scaled
    rb.avx = av.x; rb.avy = av.y; rb.avz = av.z;
    rb.isSleeping = body.isSleeping(); // Percept read-back (S5)
  });

  // ── Pull character bodies (kinematic + CharacterController3D): the step moved them to their
  //    next kinematic translation, so write it back into Transform + record the teleport baseline. ──
  if (dt > 0) world.query(Transform, RigidBody3D, CharacterController3D).updateEach(([tf]: [TfData3, RbData3, CharData3], entity) => {
    const rec = st.bodies.get(entity.id());
    if (!rec || rec.bodyType !== 'kinematic') return;
    const body = st.world.getRigidBody(rec.bodyHandle);
    if (!body) return;
    const t = body.translation();
    // Character body is posed in WORLD space; write back into LOCAL for a parented character
    // (kinematic char has no spin → identity world rotation). Root: fast path. (P2)
    const parentId = parentIdOf(entity);
    if (parentId) {
      vecPhysToEcsInto(t.x, t.y, t.z, cfg.upm, _v);
      const local = worldToLocal3D(entity.id(), _v, _IDENT_Q, world);
      tf.x = local.x; tf.y = local.y; tf.z = local.z;
    } else {
      vecPhysToEcsInto(t.x, t.y, t.z, cfg.upm, _v);
      tf.x = _v.x; tf.y = _v.y; tf.z = _v.z;
    }
    rec.lastX = t.x; rec.lastY = t.y; rec.lastZ = t.z;   // teleport-detection baseline (world/phys units)
  });

  // ── Drain contact + sensor events → journal, Physics3DEvents manager, OnCollision3D. On a
  //    solid contact BEGIN, also read the manifold for a rich `contact` event (point/normal/
  //    impact speed) — the impact detail games need for damage / SFX / effect spawning. ──
  if (dt > 0) drainContactEvents(world, st.colliders, st.eventQueue, physics3DEvents, fireOnCollision,
    (h1, h2, a, b, phase) => emitContactDetail(st, world, cfg.upm, h1, h2, a, b, phase));
}

/** On a solid contact BEGIN, read the Rapier manifold (world-space point + normal) + compute the
 *  relative approach speed along the normal, then fan a `contact` event to the journal + bus.
 *  Sensors carry no solver contact, so they're skipped. Fires once per contact begin. */
function emitContactDetail(st: PhysicsWorldState3D, world: World, upm: number, h1: number, h2: number, a: ColliderInfo, b: ColliderInfo, phase: 'enter' | 'exit'): void {
  if (phase !== 'enter' || a.isSensor || b.isSensor) return;
  const c1 = st.world.getCollider(h1), c2 = st.world.getCollider(h2);
  if (!c1 || !c2) return;
  let px = 0, py = 0, pz = 0, nx = 0, ny = 1, nz = 0, has = false;
  st.world.contactPair(c1, c2, (manifold) => {
    const nrm = manifold.normal(); nx = nrm.x; ny = nrm.y; nz = nrm.z;
    if (manifold.numSolverContacts() > 0) { const p = manifold.solverContactPoint(0); px = p.x; py = p.y; pz = p.z; }
    else { const p = c1.translation(); px = p.x; py = p.y; pz = p.z; }  // fallback: collider center
    has = true;
  });
  if (!has) return;
  const point = vecPhysToEcs(px, py, pz, upm);   // physics meters → world units
  const va = a.entity.has(RigidBody3D) ? (a.entity.get(RigidBody3D) as RbData3) : null;
  const vb = b.entity.has(RigidBody3D) ? (b.entity.get(RigidBody3D) as RbData3) : null;
  // relative approach velocity along the (unit) normal — world units/s
  const rvx = (vb ? vb.vx : 0) - (va ? va.vx : 0);
  const rvy = (vb ? vb.vy : 0) - (va ? va.vy : 0);
  const rvz = (vb ? vb.vz : 0) - (va ? va.vz : 0);
  const speed = Math.abs(rvx * nx + rvy * ny + rvz * nz);
  const detail = { point: [point.x, point.y, point.z], normal: [nx, ny, nz], speed };
  // @contact is Tier-2 (watch-gated): skip the ref resolution + payload build entirely unless a
  // capture is open (the default is OFF). The always-on @collision path records these same entities'
  // names in the side-table, so resolvability isn't lost. GUID-addressed (Percept V4) so contacts
  // correlate across hot-reloads; id fallback for an un-guidable entity. The event bus fires
  // regardless — code subscribers don't depend on the journal watch.
  if (isVerboseCaptureActive('@contact')) {
    emit('@contact', { a: refOf(a), b: refOf(b), point: detail.point, normal: detail.normal, speed }, world);
  }
  physics3DEvents.__emitContact(world, a.entity, b.entity, detail);
}

/** A 3D raycast against the physics world, in ECS/world coordinates. Returns the first (nearest)
 *  hit or null. `dx/dy/dz` need not be normalized. `maxDistance` is in world units. Pure query. */
export function raycast3D(
  world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  opts: { maxDistance?: number; solid?: boolean } = {},
): { entityId: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; distance: number } | null {
  const st = worlds.get(world);
  if (!st) return null;
  const upm = st.upm;
  const R = st.R;

  const origin = vecEcsToPhys(ox, oy, oz, upm);
  // Normalize direction so toi comes back in meters (a plain direction is scale-invariant,
  // but we normalize in meter-space for a consistent distance readback).
  const d = vecEcsToPhys(dx, dy, dz, upm);
  const len = Math.hypot(d.x, d.y, d.z);
  if (len === 0) return null;
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  const maxToi = (opts.maxDistance ?? Infinity) / upm;

  const ray = new R.Ray(origin, dir);
  const hit = st.world.castRayAndGetNormal(ray, maxToi, opts.solid ?? true);
  if (!hit) return null;

  const info = st.colliders.get(hit.collider.handle);
  const point = ray.pointAt(hit.timeOfImpact);
  const p = vecPhysToEcs(point.x, point.y, point.z, upm);
  // Normal is a unit direction — right-handed Y-up both sides, so it carries over unscaled.
  const nlen = Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z) || 1;
  return {
    entityId: info?.entityId ?? -1,
    x: p.x, y: p.y, z: p.z,
    nx: hit.normal.x / nlen, ny: hit.normal.y / nlen, nz: hit.normal.z / nlen,
    distance: hit.timeOfImpact * upm,
  };
}

/** Sweep a sphere of `radius` (world units) from the origin along the direction and return the
 *  first collider it would hit — the "would this fit if I move it here" query. `x,y,z` is the
 *  swept sphere's CENTER at impact. `maxDistance` in world units. */
export function shapeCast3D(
  world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, radius: number,
  opts: { maxDistance?: number } = {},
): { entityId: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; distance: number } | null {
  const st = worlds.get(world);
  if (!st) return null;
  const upm = st.upm;
  const R = st.R;

  const origin = vecEcsToPhys(ox, oy, oz, upm);
  const d = vecEcsToPhys(dx, dy, dz, upm);
  const len = Math.hypot(d.x, d.y, d.z);
  if (len === 0) return null;
  const vel = { x: d.x / len, y: d.y / len, z: d.z / len };
  const maxToi = (opts.maxDistance ?? Infinity) / upm;

  const shape = new R.Ball(lenToPhys(radius, upm));
  // castShape(shapePos, shapeRot: Rotation, shapeVel, shape, targetDistance, maxToi, stopAtPenetration)
  const hit = st.world.castShape(origin, { x: 0, y: 0, z: 0, w: 1 }, vel, shape, 0, maxToi, true);
  if (!hit) return null;

  const info = st.colliders.get(hit.collider.handle);
  const cx = origin.x + vel.x * hit.time_of_impact;
  const cy = origin.y + vel.y * hit.time_of_impact;
  const cz = origin.z + vel.z * hit.time_of_impact;
  const p = vecPhysToEcs(cx, cy, cz, upm);
  const nlen = Math.hypot(hit.normal1.x, hit.normal1.y, hit.normal1.z) || 1;
  return {
    entityId: info?.entityId ?? -1,
    x: p.x, y: p.y, z: p.z,
    nx: hit.normal1.x / nlen, ny: hit.normal1.y / nlen, nz: hit.normal1.z / nlen,
    distance: hit.time_of_impact * upm,
  };
}

/** Which physics entity (if any) contains the point (x,y,z) in ECS/world coords — the
 *  pick/hit-test query. Returns the first solid collider covering the point. */
export function pointQuery3D(world: World, x: number, y: number, z: number): number | null {
  const st = worlds.get(world);
  if (!st) return null;
  const p = vecEcsToPhys(x, y, z, st.upm);
  const proj = st.world.projectPoint(p, true);
  if (!proj || !proj.isInside) return null;
  return st.colliders.get(proj.collider.handle)?.entityId ?? null;
}

// ── Runtime control: forces / impulses / velocity (game code moves a dynamic body) ──
//
// All take a live `Entity` and resolve its Rapier body via the per-world body map, so they
// no-op (return false) until the physics system has created the body (its first tick) and
// only affect DYNAMIC bodies (Rapier ignores forces on fixed/kinematic). Called from game
// systems at GAME priority (< PHYSICS), so an impulse this frame is integrated by this
// frame's step. Linear quantities are in WORLD units (scaled by unitsPerMeter like
// positions/velocities); torque/angular-impulse carry length² so they scale by upm².

/** Resolve the live Rapier body for an entity, or null if it has none yet / isn't in this world. */
function bodyFor(world: World, entity: Entity): RRigidBody | null {
  const st = worlds.get(world);
  if (!st) return null;
  const rec = st.bodies.get(entity.id());
  if (!rec) return null;
  return st.world.getRigidBody(rec.bodyHandle) ?? null;
}

/** Body-map lookup that also returns the cached unitsPerMeter — the shared prologue for the
 *  scaled control ops (avoids re-querying Physics3D per call). Null if the body isn't live. */
function bodyAndUpm(world: World, entity: Entity): { body: RRigidBody; upm: number } | null {
  const st = worlds.get(world);
  if (!st) return null;
  const rec = st.bodies.get(entity.id());
  if (!rec) return null;
  const body = st.world.getRigidBody(rec.bodyHandle);
  return body ? { body, upm: st.upm } : null;
}

/** Vector method names on a Rapier body that take a WORLD-units vector (scaled by 1/upm). */
type LinMethod = 'applyImpulse' | 'addForce' | 'setLinvel';
function linApply(world: World, entity: Entity, x: number, y: number, z: number, wakeUp: boolean, m: LinMethod): boolean {
  const r = bodyAndUpm(world, entity); if (!r) return false;
  const u = r.upm;
  (r.body[m] as (v: Vec3, w: boolean) => void)({ x: x / u, y: y / u, z: z / u }, wakeUp);
  return true;
}
/** Torque method names that take a world-units torque (carries length² → scaled by 1/upm²). */
type AngMethod = 'applyTorqueImpulse' | 'addTorque';
function angApply(world: World, entity: Entity, x: number, y: number, z: number, wakeUp: boolean, m: AngMethod): boolean {
  const r = bodyAndUpm(world, entity); if (!r) return false;
  const k = r.upm ** 2;
  (r.body[m] as (v: Vec3, w: boolean) => void)({ x: x / k, y: y / k, z: z / k }, wakeUp);
  return true;
}

/** Apply an instantaneous linear impulse (world-unit momentum) — the one-shot velocity kick
 *  for jumps, knockback, launches. Returns false if the entity has no dynamic body yet. */
export function applyImpulse3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  return linApply(world, entity, x, y, z, wakeUp, 'applyImpulse');
}

/** Apply an instantaneous angular impulse (torque·time) about the world axes. */
export function applyTorqueImpulse3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  return angApply(world, entity, x, y, z, wakeUp, 'applyTorqueImpulse');
}

/** Add a CONTINUOUS linear force (world units). NOTE Rapier semantics: the force persists
 *  across steps until `resetForces3D` — for a per-frame force, re-add it each frame (and
 *  reset), or prefer `applyImpulse3D` for one-shots. */
export function addForce3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  return linApply(world, entity, x, y, z, wakeUp, 'addForce');
}

/** Add a CONTINUOUS torque about the world axes (persists until `resetForces3D`). */
export function addTorque3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  return angApply(world, entity, x, y, z, wakeUp, 'addTorque');
}

/** Set linear velocity directly (world units/s) — the intuitive "move at this speed" control. */
export function setLinvel3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  return linApply(world, entity, x, y, z, wakeUp, 'setLinvel');
}

/** Teleport a body to a WORLD position (world units) — the direct pose control for LATE_UPDATE
 *  correction (e.g. the sling puck's post-physics surface snap). Sets the body's WORLD pose,
 *  preserving velocity; the post-step writeback converts it back to LOCAL for a PARENTED body,
 *  so callers pass WORLD coords (for a root body world == local). Mirrors `setLinvel3D`'s unit
 *  handling. Also set the entity's `Transform` trait if this frame's render must reflect the move
 *  (propagation reads the trait, not the body). */
export function setBodyTranslation3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  const r = bodyAndUpm(world, entity); if (!r) return false;
  const u = r.upm;
  r.body.setTranslation({ x: x / u, y: y / u, z: z / u }, wakeUp);
  return true;
}

/** Set angular velocity directly (radians/s about the world axes). */
export function setAngvel3D(world: World, entity: Entity, x: number, y: number, z: number, wakeUp = true): boolean {
  const body = bodyFor(world, entity); if (!body) return false;
  body.setAngvel({ x, y, z }, wakeUp);   // rad/s — not length-scaled
  return true;
}

/** Clear any accumulated continuous forces + torques (from `addForce3D`/`addTorque3D`). */
export function resetForces3D(world: World, entity: Entity, wakeUp = true): boolean {
  const body = bodyFor(world, entity); if (!body) return false;
  body.resetForces(wakeUp); body.resetTorques(wakeUp);
  return true;
}

/** Wake a sleeping body so the next step integrates it. */
export function wakeBody3D(world: World, entity: Entity): boolean {
  const body = bodyFor(world, entity); if (!body) return false;
  body.wakeUp();
  return true;
}

// (disposePhysics3D / disposeAllPhysics3D + the Stop/world-swap hooks are provided by the
// shared `registry` created near the top of this module — see createPhysicsWorldRegistry.)
