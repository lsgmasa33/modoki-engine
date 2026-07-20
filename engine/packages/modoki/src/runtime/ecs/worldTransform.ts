/** worldTransform — the canonical, headless-safe world-transform API.
 *
 *  The one place that composes an entity's LOCAL `Transform` + `parentId` chain into a
 *  WORLD pose ON DEMAND, and inverts a world pose back to local. Query-based (builds its
 *  parentId/transform maps from `world.query(...)`, exactly like `transformPropagationSystem`)
 *  so it's correct HEADLESSLY — it does NOT depend on the entity index, which test worlds
 *  that spawn directly never populate.
 *
 *  This is deliberately a light module (THREE + koota + two traits only) so the SIMULATION
 *  half (physics, audio, game systems) can consume the world contract WITHOUT pulling in the
 *  renderer's texture/material deps. `renderUtils` re-exports the 3D getters for existing
 *  callers; `@modoki/engine/runtime` re-exports the whole API.
 *
 *  Cached vs on-demand: `transformPropagationSystem` maintains the per-frame `worldTransforms`
 *  MAP for the render path (O(1) lookups). This module is the ON-DEMAND complement — correct
 *  whenever called (bootstrap, mid-tick, headless), at the cost of rebuilding its maps per
 *  call. Prefer the cached map in hot per-entity render loops; use these when you need a world
 *  pose at a moment the cache may be stale/unpopulated (e.g. a game system at scene bootstrap,
 *  or physics readback of a parented body). */

import * as THREE from 'three';
import type { World } from 'koota';
import { Transform, EntityAttributes } from '../traits';
import { getCurrentWorld } from './worldRegistry';

export interface WorldTransform3D { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }

const _wt3: WorldTransform3D = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
const _wt3Mat = new THREE.Matrix4();
const _wt3Local = new THREE.Matrix4();
const _wt3Pos = new THREE.Vector3();
const _wt3Quat = new THREE.Quaternion();
const _wt3Scale = new THREE.Vector3();
const _wt3Euler = new THREE.Euler();

type TfSnap = { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number };
const _wt3Chain: TfSnap[] = [];

// Per-call scratch maps for the query-based parent walk (rebuilt each call). Keyed by
// entity id: value in `_tfById` = its local Transform snapshot, in `_parentById` = its
// parentId (absent = root).
const _tfById = new Map<number, TfSnap>();
const _parentById = new Map<number, number>();

/** Rebuild the id→transform and id→parentId maps from world QUERIES (not the entity
 *  index). Query-based so it's correct headlessly — the entity index is only populated by
 *  registerEntity, which test worlds that spawn directly skip; queries see every entity
 *  regardless. Shared by all on-demand accessors below. */
function buildTransformMaps(world: World): void {
  _tfById.clear();
  _parentById.clear();
  world.query(Transform).updateEach(([tf], entity) => {
    _tfById.set(entity.id(), { x: tf.x, y: tf.y, z: tf.z, rx: tf.rx, ry: tf.ry, rz: tf.rz, sx: tf.sx, sy: tf.sy, sz: tf.sz });
  });
  world.query(EntityAttributes).updateEach(([ea], entity) => {
    const p = (ea as { parentId?: number }).parentId || 0;
    if (p) _parentById.set(entity.id(), p);
  });
}

/** Compose an entity's WORLD matrix INTO `out` by walking `parentId` → root over the
 *  pre-built maps (`buildTransformMaps` must have run for `world`). world = M_root · … ·
 *  M_leaf (euler XYZ, matching transformPropagationSystem). Depth-capped (64) against
 *  parentId cycles. Unknown/rootless ids yield identity·local. */
function composeWorldMatrixInto(out: THREE.Matrix4, entityId: number): THREE.Matrix4 {
  _wt3Chain.length = 0;
  let id = entityId, depth = 0;
  while (id && depth < 64) {
    const t = _tfById.get(id);
    if (!t) break;
    _wt3Chain.push(t);
    id = _parentById.get(id) || 0;
    depth++;
  }
  // Compose parent → child: chain is leaf-first, so multiply from root (last) down to leaf (0).
  out.identity();
  for (let i = _wt3Chain.length - 1; i >= 0; i--) {
    const t = _wt3Chain[i];
    _wt3Pos.set(t.x, t.y, t.z);
    _wt3Quat.setFromEuler(_wt3Euler.set(t.rx, t.ry, t.rz));
    _wt3Scale.set(t.sx, t.sy, t.sz);
    out.multiply(_wt3Local.compose(_wt3Pos, _wt3Quat, _wt3Scale));
  }
  return out;
}

/** True if `entityId` has a non-zero parentId in `world` (i.e. its world ≠ local). Cheap:
 *  reads the entity's EntityAttributes directly, no map rebuild. Physics uses this to keep
 *  the root-body fast path (no matrix inverse) for the overwhelmingly common unparented case. */
export function hasParent(entityId: number, world: World = getCurrentWorld()): boolean {
  let has = false;
  world.query(EntityAttributes).updateEach(([ea], entity) => {
    if (entity.id() === entityId && ((ea as { parentId?: number }).parentId || 0)) has = true;
  });
  return has;
}

/** Compute an entity's WORLD 3D transform ON DEMAND by walking `parentId` → root and
 *  composing (world = M_root · … · M_leaf; euler XYZ, matching transformPropagationSystem).
 *  Correct whenever it's called — a game system at bootstrap can read the world pose of a
 *  marker parented under a moved group before the render-path cache exists. Query-based
 *  (headless-safe). Depth-capped (64) against parentId cycles. Returns a SHARED singleton:
 *  read/destructure its fields IMMEDIATELY, don't retain (two live results alias). Root
 *  entities equal the local Transform. */
export function getWorldTransform3D(entityId: number, world: World = getCurrentWorld()): WorldTransform3D {
  buildTransformMaps(world);
  composeWorldMatrixInto(_wt3Mat, entityId);
  _wt3Mat.decompose(_wt3Pos, _wt3Quat, _wt3Scale);
  _wt3Euler.setFromQuaternion(_wt3Quat); // default XYZ
  _wt3.x = _wt3Pos.x; _wt3.y = _wt3Pos.y; _wt3.z = _wt3Pos.z;
  _wt3.rx = _wt3Euler.x; _wt3.ry = _wt3Euler.y; _wt3.rz = _wt3Euler.z;
  _wt3.sx = _wt3Scale.x; _wt3.sy = _wt3Scale.y; _wt3.sz = _wt3Scale.z;
  return _wt3;
}

const _wmMat = new THREE.Matrix4();
/** Compute an entity's raw WORLD matrix ON DEMAND (no decompose) INTO `out` (default a
 *  shared singleton — clone/copy if you must retain it past the next call). Query-based
 *  and headless-safe. Use for physics body seeding, where you want the composed matrix
 *  directly without a lossy TRS round-trip. */
export function getWorldMatrix3D(entityId: number, world: World = getCurrentWorld(), out: THREE.Matrix4 = _wmMat): THREE.Matrix4 {
  buildTransformMaps(world);
  return composeWorldMatrixInto(out, entityId);
}

/** Compute an entity's PARENT world matrix ON DEMAND INTO `out` (default a shared
 *  singleton). Identity if the entity is at the root. This is the matrix you invert to
 *  convert a world-space pose back into the entity's LOCAL frame — see {@link worldToLocal3D}. */
export function getParentWorldMatrix3D(entityId: number, world: World = getCurrentWorld(), out: THREE.Matrix4 = _wmMat): THREE.Matrix4 {
  buildTransformMaps(world);
  const parent = _parentById.get(entityId) || 0;
  if (!parent) return out.identity();
  return composeWorldMatrixInto(out, parent);
}

const _w2lParent = new THREE.Matrix4();
const _w2lWorld = new THREE.Matrix4();
const _w2lLocal = new THREE.Matrix4();
const _w2lPos = new THREE.Vector3();
const _w2lQuat = new THREE.Quaternion();
const _w2lScale = new THREE.Vector3();
const _w2lEuler = new THREE.Euler();
const _w2lOut: WorldTransform3D = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };

/** Convert a WORLD-space pose (position + quaternion + optional scale) back into an
 *  entity's LOCAL Transform by inverting its parent's world matrix: local = parentWorld⁻¹ ·
 *  world. The readback half of the world-transform contract — physics (which poses bodies in
 *  world space) writes the stepped world pose back through here so the LOCAL Transform stays
 *  correct for a PARENTED body. Root entities: local == world. Returns a SHARED singleton
 *  (read immediately). Scale defaults to (1,1,1) — pass the body's world scale if it carries one. */
export function worldToLocal3D(
  entityId: number,
  worldPos: { x: number; y: number; z: number },
  worldQuat: { x: number; y: number; z: number; w: number },
  world: World = getCurrentWorld(),
  worldScale?: { x: number; y: number; z: number },
): WorldTransform3D {
  getParentWorldMatrix3D(entityId, world, _w2lParent);
  _w2lPos.set(worldPos.x, worldPos.y, worldPos.z);
  _w2lQuat.set(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w);
  _w2lScale.set(worldScale?.x ?? 1, worldScale?.y ?? 1, worldScale?.z ?? 1);
  _w2lWorld.compose(_w2lPos, _w2lQuat, _w2lScale);
  // local = parentWorld⁻¹ · world
  _w2lLocal.copy(_w2lParent).invert().multiply(_w2lWorld);
  _w2lLocal.decompose(_w2lPos, _w2lQuat, _w2lScale);
  _w2lEuler.setFromQuaternion(_w2lQuat); // default XYZ
  _w2lOut.x = _w2lPos.x; _w2lOut.y = _w2lPos.y; _w2lOut.z = _w2lPos.z;
  _w2lOut.rx = _w2lEuler.x; _w2lOut.ry = _w2lEuler.y; _w2lOut.rz = _w2lEuler.z;
  _w2lOut.sx = _w2lScale.x; _w2lOut.sy = _w2lScale.y; _w2lOut.sz = _w2lScale.z;
  return _w2lOut;
}
