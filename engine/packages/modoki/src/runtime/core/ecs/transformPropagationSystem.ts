/** Transform propagation — computes world transforms from local + parent chain.
 *  Entities with parentId=0 have world=local. Children inherit parent's world transform.
 *
 *  L0 CORE (not `src/three/`, where this lived until P5 of the module-boundaries plan).
 *  Despite using THREE.Matrix4/Quaternion/Euler as its math library, nothing here is
 *  Three.js-SPECIFIC: it reads two core traits (`Transform`, `EntityAttributes`) and
 *  composes an ECS parent chain. Its sibling `worldTransform.ts` — already L0 — does the
 *  same composition with the same THREE math, so "it imports three" was never the thing
 *  that made this a renderer concern. Ten runtime subsystems (2D + 3D rendering, physics
 *  2D/3D, zones, UI) consume it, so filing it under the 3D renderer forced all of them to
 *  reach OUT of `runtime/`.
 *
 *  CACHED vs ON-DEMAND — this module and `worldTransform.ts` are two halves of one contract,
 *  deliberately kept separate:
 *   - HERE: a per-frame PUSH pass. One O(n) sweep at `SYSTEM_PRIORITY.TRANSFORM_PREPASS`
 *     (170) and again at `TRANSFORM` (200) fills the `worldTransforms` map and the
 *     `deactivatedEntities` set, so render/sync loops get O(1) lookups for every entity.
 *     The cache is only as fresh as the last pass — at `LATE_UPDATE` (185) it still holds
 *     the pre-physics snapshot, and it is EMPTY in a headless world that never registers
 *     this system.
 *   - `worldTransform.ts`: an on-demand PULL (`getWorldTransform3D` & friends). Correct
 *     whenever called, at the cost of rebuilding its maps per call. That is what simulation
 *     code should use when the cache may be stale or unpopulated.
 *  Moving this file into core does NOT change which of the two is authoritative, and does
 *  not close the world-transform gap documented in `docs/architecture.md` (sim code that
 *  still reads LOCAL `Transform` as world). It only puts both halves in one layer. */

import * as THREE from 'three';
import type { World } from 'koota';
// De-barreled deliberately (P3b lesson): reaching `../../traits` would drag the whole L1
// trait graph into L0 for two traits that now live in core/traits/ anyway.
import { Transform } from '../traits/Transform';
import { EntityAttributes } from '../traits/EntityAttributes';

/** Computed world transforms, updated each frame. Renderers read from here. */
export const worldTransforms = new Map<number, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

/** Entities deactivated via EntityAttributes.isActive (includes children of inactive parents). */
export const deactivatedEntities = new Set<number>();

// Reusable Three.js objects to avoid GC pressure
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

function makeMatrix(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  _pos.set(x, y, z);
  _euler.set(rx, ry, rz);
  _quat.setFromEuler(_euler);
  _scale.set(sx, sy, sz);
  return acquireMatrix().compose(_pos, _quat, _scale);
}

// Reuse containers across frames — clear instead of recreating
const _selfInactive = new Set<number>();
const _parentIdMap = new Map<number, number>();
const _allEntityIds: number[] = [];
// Per-frame negative memo of "known active" ids (mirrors deactivatedEntities for the
// positive case) so a deep chain of active entities isn't re-walked to the root from
// every node — turns the deactivation pass from O(n·depth) into O(n). (ecs-core F5)
const _knownActive = new Set<number>();
// Recursion stack for the deactivation walk — guards against a parentId CYCLE
// (A→B→A). Without it the walk recurses forever and stack-overflows. (getWorldMatrix
// has its own `visited` guard; this is the mirror for the deactivation pass.)
const _deactVisiting = new Set<number>();
const _entities: { id: number; parentId: number; x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }[] = [];
const _byId = new Map<number, typeof _entities[0]>();
const _computed = new Map<number, THREE.Matrix4>();
const _visited = new Set<number>();
// Pool of Matrix4 objects for child world transforms. Trim at end of frame so
// a scene that briefly needed many matrices doesn't keep them around forever.
const _matrixPool: THREE.Matrix4[] = [];
let _matrixPoolIdx = 0;
const _MATRIX_POOL_BASE = 64;
const _MATRIX_POOL_TRIM_SLACK = 32; // keep pool size <= used + slack at frame end

function acquireMatrix(): THREE.Matrix4 {
  if (_matrixPoolIdx < _matrixPool.length) return _matrixPool[_matrixPoolIdx++];
  const m = new THREE.Matrix4();
  _matrixPool.push(m);
  _matrixPoolIdx++;
  return m;
}

function trimMatrixPool() {
  const target = Math.max(_MATRIX_POOL_BASE, _matrixPoolIdx + _MATRIX_POOL_TRIM_SLACK);
  if (_matrixPool.length > target) _matrixPool.length = target;
}

export function transformPropagationSystem(world: World) {
  // ── 1. Compute deactivated entities from EntityAttributes (all entities, not just Transform) ──
  _selfInactive.clear();
  _parentIdMap.clear();
  _allEntityIds.length = 0;
  const selfInactive = _selfInactive;
  const parentIdMap = _parentIdMap;
  const allEntityIds = _allEntityIds;
  world.query(EntityAttributes).updateEach(([ea], entity) => {
    const id = entity.id();
    allEntityIds.push(id);
    if (!ea.isActive) selfInactive.add(id);
    if (ea.parentId) parentIdMap.set(id, ea.parentId);
  });

  deactivatedEntities.clear();
  _knownActive.clear();
  _deactVisiting.clear();
  const knownActive = _knownActive;
  const visiting = _deactVisiting;
  function isDeactivated(id: number): boolean {
    if (deactivatedEntities.has(id)) return true;
    if (knownActive.has(id)) return false; // negative memo — don't re-walk an active chain
    if (visiting.has(id)) return false;    // cycle — break it (this edge can't deactivate)
    if (selfInactive.has(id)) { deactivatedEntities.add(id); return true; }
    const parentId = parentIdMap.get(id);
    if (parentId && parentId > 0) {
      visiting.add(id);
      const parentDeactivated = isDeactivated(parentId);
      visiting.delete(id);
      if (parentDeactivated) {
        deactivatedEntities.add(id);
        return true;
      }
    }
    knownActive.add(id);
    return false;
  }
  for (const id of allEntityIds) isDeactivated(id);

  // ── 2. Collect transforms for world-space propagation ──
  _entities.length = 0;
  const entities = _entities;
  world.query(Transform).updateEach(([tf], entity) => {
    entities.push({
      id: entity.id(),
      parentId: parentIdMap.get(entity.id()) || 0,
      x: tf.x, y: tf.y, z: tf.z,
      rx: tf.rx, ry: tf.ry, rz: tf.rz,
      sx: tf.sx, sy: tf.sy, sz: tf.sz,
    });
  });

  _byId.clear();
  const byId = _byId;
  for (const e of entities) byId.set(e.id, e);

  // Compute world transform for each entity (with memoization)
  _computed.clear();
  _visited.clear();
  _matrixPoolIdx = 0;
  const computed = _computed;
  const visited = _visited;

  function getWorldMatrix(id: number): THREE.Matrix4 {
    if (computed.has(id)) return computed.get(id)!;
    if (visited.has(id)) {
      const identity = acquireMatrix().identity();
      computed.set(id, identity);
      return identity;
    }
    visited.add(id);

    const e = byId.get(id);
    if (!e) {
      const identity = acquireMatrix().identity();
      computed.set(id, identity);
      return identity;
    }

    const local = makeMatrix(e.x, e.y, e.z, e.rx, e.ry, e.rz, e.sx, e.sy, e.sz);

    if (e.parentId === 0 || !byId.has(e.parentId)) {
      // Root entity: world = local
      const m = acquireMatrix().copy(local);
      computed.set(id, m);
      return m;
    }

    // Child: world = parent_world * local
    const parentWorld = getWorldMatrix(e.parentId);
    const worldMatrix = acquireMatrix().multiplyMatrices(parentWorld, local);
    computed.set(id, worldMatrix);
    return worldMatrix;
  }

  // Compute and store decomposed world transforms
  // Fast path: entities without parents just copy local transform (no matrix math)
  worldTransforms.clear();
  for (const e of entities) {
    if (e.parentId === 0 || !byId.has(e.parentId)) {
      // Root entity — world = local (skip matrix allocation)
      worldTransforms.set(e.id, {
        x: e.x, y: e.y, z: e.z,
        rx: e.rx, ry: e.ry, rz: e.rz,
        sx: e.sx, sy: e.sy, sz: e.sz,
      });
    } else {
      // Child entity — need matrix multiplication
      const mat = getWorldMatrix(e.id);
      mat.decompose(_pos, _quat, _scale);
      _euler.setFromQuaternion(_quat);
      worldTransforms.set(e.id, {
        x: _pos.x, y: _pos.y, z: _pos.z,
        rx: _euler.x, ry: _euler.y, rz: _euler.z,
        sx: _scale.x, sy: _scale.y, sz: _scale.z,
      });
    }
  }
  trimMatrixPool();
}
