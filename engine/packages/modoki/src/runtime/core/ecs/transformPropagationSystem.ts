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

/** Computed world transforms, updated each frame. Renderers read from here.
 *  PERF (ecs-core F6): values are MUTATED IN PLACE across passes rather than replaced —
 *  an unchanged-pass short-circuit relies on the object identity for a given id staying
 *  stable so it can skip rewriting it. Every consumer does `.get(id)` and reads the fields
 *  immediately, so nothing may retain a value object across frames — read it fresh each
 *  time you need it. */
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

// ── PERF (ecs-core F6) — pooled per-entity records + change detection ──────────────────
// This system runs up to 3x/frame (TRANSFORM_PREPASS, TRANSFORM, and an inline call from
// scene3DSync.ts), and a frozen scene (nothing moved) was still paying full O(n) rebuild +
// per-entity allocation on every pass. Two records pools below are kept alive across calls
// and MUTATED rather than replaced (FIX 1); the SAME loop that mutates them compares the
// new values against what was already sitting in the cell from the previous pass, which
// gives "did anything change" for free without a caller-supplied dirty flag (FIX 2) — a
// forgotten dirty-flag write is exactly the stale-world-transform bug class this repo keeps
// hitting, so change detection is by comparison, never by trust.
type EaRecord = { id: number; isActive: boolean; parentId: number };
// Pool of EntityAttributes snapshots (ALL entities with the trait, not just ones with a
// Transform) — this is what the isActive cascade depends on, so it must be compared in
// full or a change on a Transform-less parent (e.g. a UI-only node) would go undetected.
const _eaPool: EaRecord[] = [];
let _eaCount = 0;
let _prevEaCount = -1; // -1 = no previous pass for the current world yet

type EntityRecord = { id: number; parentId: number; x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number; isActive: boolean };
// Pool of Transform-query snapshots. Index 0.._entityCount-1 is this pass's live data;
// anything beyond _entityCount is a stale tail from a larger previous pass and must not
// be read (byId/composition below always iterate by count, never by `.length`).
const _entities: EntityRecord[] = [];
let _entityCount = 0;
let _prevEntityCount = -1;
// ids written into worldTransforms this pass — used to delete stale entries (despawned
// entities) without a blanket `.clear()`.
const _seenWorldIds = new Set<number>();
// Forces a full recompute the first time a given world is seen, and again whenever the
// CALLER passes a different world — otherwise two-world scene swaps (or, in tests, a
// fresh `createWorld()` per test reusing small sequential entity ids) could compare
// against a stale pass recorded for an entirely different world.
let _prevWorld: World | null = null;

const _byId = new Map<number, EntityRecord>();
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
  const worldChanged = world !== _prevWorld;
  _prevWorld = world;

  // ── 1. Snapshot EntityAttributes (all entities, not just Transform) — feeds the isActive
  //      cascade AND the parentId lookup used below. Pooled + compared in the SAME pass
  //      (FIX 1 + FIX 2): each cell is mutated with this pass's values, but only after its
  //      PREVIOUS contents are compared against them, so "did anything change" falls out of
  //      work we have to do anyway instead of costing an extra sweep. ──
  _selfInactive.clear();
  _parentIdMap.clear();
  _allEntityIds.length = 0;
  const selfInactive = _selfInactive;
  const parentIdMap = _parentIdMap;
  const allEntityIds = _allEntityIds;
  let eaChanged = worldChanged;
  let eaIndex = 0;
  // readEach, NOT updateEach: this system only READS. koota's updateEach defaults to
  // `changeDetection: 'auto'`, which per entity snapshots each trait, re-checks `world.has`,
  // diffs every tracked trait against the snapshot and writes it back — all of it wasted when
  // the callback never mutates. This pass runs over EVERY entity, twice per frame
  // (TRANSFORM_PREPASS and TRANSFORM), so the waste is paid 4x per frame per entity.
  world.query(EntityAttributes).readEach(([ea], entity) => {
    const id = entity.id();
    allEntityIds.push(id);
    if (!ea.isActive) selfInactive.add(id);
    if (ea.parentId) parentIdMap.set(id, ea.parentId);

    if (eaIndex < _eaPool.length) {
      const rec = _eaPool[eaIndex];
      if (rec.id !== id || rec.isActive !== ea.isActive || rec.parentId !== ea.parentId) eaChanged = true;
      rec.id = id;
      rec.isActive = ea.isActive;
      rec.parentId = ea.parentId;
    } else {
      _eaPool.push({ id, isActive: ea.isActive, parentId: ea.parentId });
      eaChanged = true; // pool grew — a new entity this frame
    }
    eaIndex++;
  });
  _eaCount = eaIndex;
  if (_eaCount !== _prevEaCount) eaChanged = true;
  _prevEaCount = _eaCount;

  // ── 2. Snapshot Transform-query entities the same way (pooled + compare-before-write). ──
  const entities = _entities;
  let transformChanged = worldChanged;
  let entityIndex = 0;
  world.query(Transform).readEach(([tf], entity) => {
    const id = entity.id();
    const parentId = parentIdMap.get(id) || 0;
    const isActiveSelf = !selfInactive.has(id);
    if (entityIndex < entities.length) {
      const rec = entities[entityIndex];
      if (
        rec.id !== id || rec.parentId !== parentId ||
        rec.x !== tf.x || rec.y !== tf.y || rec.z !== tf.z ||
        rec.rx !== tf.rx || rec.ry !== tf.ry || rec.rz !== tf.rz ||
        rec.sx !== tf.sx || rec.sy !== tf.sy || rec.sz !== tf.sz ||
        rec.isActive !== isActiveSelf
      ) transformChanged = true;
      rec.id = id; rec.parentId = parentId;
      rec.x = tf.x; rec.y = tf.y; rec.z = tf.z;
      rec.rx = tf.rx; rec.ry = tf.ry; rec.rz = tf.rz;
      rec.sx = tf.sx; rec.sy = tf.sy; rec.sz = tf.sz;
      rec.isActive = isActiveSelf;
    } else {
      entities.push({
        id, parentId,
        x: tf.x, y: tf.y, z: tf.z,
        rx: tf.rx, ry: tf.ry, rz: tf.rz,
        sx: tf.sx, sy: tf.sy, sz: tf.sz,
        isActive: isActiveSelf,
      });
      transformChanged = true; // pool grew — a new entity this frame
    }
    entityIndex++;
  });
  _entityCount = entityIndex;
  if (_entityCount !== _prevEntityCount) transformChanged = true;
  _prevEntityCount = _entityCount;

  // ── 3. Provably unchanged since the last pass → worldTransforms and deactivatedEntities
  //      already hold exactly the right values (both are mutated in place, never rebuilt
  //      from scratch), so skip the cascade walk AND the composition/decompose work below
  //      entirely. Exact `!==` comparison only — an epsilon would silently drop small real
  //      motion, and "provably unchanged" is the whole point of this short-circuit. ──
  if (!eaChanged && !transformChanged) return;

  // ── 4. Compute deactivated entities from the EntityAttributes snapshot above ──
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

  // ── 5. Build the id→record lookup for composition, bounded to THIS pass's live count —
  //      the pool may hold a stale tail from a larger previous pass. ──
  _byId.clear();
  const byId = _byId;
  for (let i = 0; i < _entityCount; i++) { const e = entities[i]; byId.set(e.id, e); }

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
  // PERF (ecs-core F6): no blanket `.clear()` — reuse the existing value object for an id
  // when one is already there (mutate its nine fields in place), insert a new one only for
  // ids not seen before, then delete whatever wasn't touched this pass (a despawned entity)
  // so the map can't leak. `worldTransforms` values are mutated in place; see the comment at
  // its declaration for why nothing may retain one across frames.
  _seenWorldIds.clear();
  const seenWorldIds = _seenWorldIds;
  for (let i = 0; i < _entityCount; i++) {
    const e = entities[i];
    let x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number;
    if (e.parentId === 0 || !byId.has(e.parentId)) {
      // Root entity — world = local (skip matrix allocation)
      x = e.x; y = e.y; z = e.z;
      rx = e.rx; ry = e.ry; rz = e.rz;
      sx = e.sx; sy = e.sy; sz = e.sz;
    } else {
      // Child entity — need matrix multiplication
      const mat = getWorldMatrix(e.id);
      mat.decompose(_pos, _quat, _scale);
      _euler.setFromQuaternion(_quat);
      x = _pos.x; y = _pos.y; z = _pos.z;
      rx = _euler.x; ry = _euler.y; rz = _euler.z;
      sx = _scale.x; sy = _scale.y; sz = _scale.z;
    }
    const existing = worldTransforms.get(e.id);
    if (existing) {
      existing.x = x; existing.y = y; existing.z = z;
      existing.rx = rx; existing.ry = ry; existing.rz = rz;
      existing.sx = sx; existing.sy = sy; existing.sz = sz;
    } else {
      worldTransforms.set(e.id, { x, y, z, rx, ry, rz, sx, sy, sz });
    }
    seenWorldIds.add(e.id);
  }
  for (const id of worldTransforms.keys()) {
    if (!seenWorldIds.has(id)) worldTransforms.delete(id);
  }
  trimMatrixPool();
}
