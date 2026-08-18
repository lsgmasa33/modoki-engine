/** #154 P4b — draw-call batching. The tests that matter are the ones about the KEY: a batch
 *  that merges two entities whose materials diverged is faster AND wrong, and wrong in a way that
 *  looks like "lighting stopped working on some tiles" rather than like a batching bug. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';

// The module registers its world-swap teardown at import time (mirroring flameMeshSync's lathe
// cache); stub the hook so importing it here does not pull in the real world graph.
vi.mock('../../src/runtime/core/ecs/world', () => ({ onWorldSwap: vi.fn() }));

import {
  applyInstancedBatching, clearInstancedBatches, clearAllInstancedBatches, getBatchStats, MIN_INSTANCES,
} from '../../src/runtime/rendering/instancedBatching';

function meshes(n: number, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh[] {
  return Array.from({ length: n }, (_, i) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(i, 0, 0);
    m.updateMatrixWorld(true);
    return m;
  });
}

let scene: THREE.Scene;
let geo: THREE.BufferGeometry;
let mat: THREE.MeshStandardMaterial;

beforeEach(() => {
  scene = new THREE.Scene();
  clearInstancedBatches(scene);
  geo = new THREE.BoxGeometry(1, 1, 1);
  mat = new THREE.MeshStandardMaterial();
});

describe('batch key', () => {
  it('groups meshes sharing geometry AND material', () => {
    const ms = meshes(MIN_INSTANCES, geo, mat);
    ms.forEach((m) => scene.add(m));
    const s = applyInstancedBatching(scene, ms);
    expect(s.groups).toBe(1);
    expect(s.batched).toBe(MIN_INSTANCES);
    expect(s.drawCallsSaved).toBe(MIN_INSTANCES - 1);
  });

  it('does NOT merge across different materials — the tint/mask/instance divergence', () => {
    // This is the whole reason the key is geometry.uuid|material.uuid rather than the authored
    // GUID: a Tint clone, a MaterialInstance clone and a #136 light-mask variant are each a
    // DIFFERENT material object. Merging them would relight or recolour entities.
    const tinted = new THREE.MeshStandardMaterial();   // stands in for a per-entity clone
    const a = meshes(MIN_INSTANCES, geo, mat);
    const b = meshes(MIN_INSTANCES, geo, tinted);
    [...a, ...b].forEach((m) => scene.add(m));
    const s = applyInstancedBatching(scene, [...a, ...b]);
    expect(s.groups).toBe(2);
    // and crucially each batch draws only its OWN material
    const insts = scene.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    expect(insts.map((i) => i.material)).toEqual(expect.arrayContaining([mat, tinted]));
  });

  it('does NOT merge across different geometries', () => {
    const other = new THREE.SphereGeometry(1);
    const a = meshes(MIN_INSTANCES, geo, mat);
    const b = meshes(MIN_INSTANCES, other, mat);
    const s = applyInstancedBatching(scene, [...a, ...b]);
    expect(s.groups).toBe(2);
  });
});

describe('LOD — per-level batching', () => {
  /** An LOD whose current level is `level`, with a distinct geometry per level so the bucket a
   *  candidate lands in reveals which level was read. */
  function lodAt(level: number, geos: THREE.BufferGeometry[], x = 0): THREE.LOD {
    const l = new THREE.LOD();
    geos.forEach((g, i) => l.addLevel(new THREE.Mesh(g, mat), i * 10));
    (l as unknown as { _currentLevel: number })._currentLevel = level;
    l.position.set(x, 0, 0);
    l.updateMatrixWorld(true);
    return l;
  }

  it('batches LODs by the level they are CURRENTLY drawing, not by the wrapper', () => {
    // The defect this replaced: excluding LODs outright skipped 204 of sling's 208 renderables
    // and batched nothing at all, while `renderer.calls` stayed flat and looked like a null result.
    const lo = new THREE.BoxGeometry(1, 1, 1);
    const hi = new THREE.SphereGeometry(1);
    const at0 = Array.from({ length: MIN_INSTANCES }, (_, i) => lodAt(0, [lo, hi], i));
    const at1 = Array.from({ length: MIN_INSTANCES }, (_, i) => lodAt(1, [lo, hi], i));
    const s = applyInstancedBatching(scene, [...at0, ...at1]);
    expect(s.groups).toBe(2);                       // one per level, not one per object
    expect(s.batched).toBe(MIN_INSTANCES * 2);
    expect(s.lodLevels).toEqual({ L0: MIN_INSTANCES, L1: MIN_INSTANCES });
  });

  it('hides the LOD WRAPPER, not the selected child', () => {
    // Hiding the child would make three fall through and draw a different level — the batch and
    // the original would both render, which is slower AND wrong.
    const lods = Array.from({ length: MIN_INSTANCES }, (_, i) => lodAt(0, [geo], i));
    applyInstancedBatching(scene, lods);
    expect(lods.every((l) => !l.visible)).toBe(true);
    expect(lods.every((l) => l.levels[0].object.visible)).toBe(true);
  });

  it('moves an LOD between groups when its level changes', () => {
    const lo = new THREE.BoxGeometry(1, 1, 1);
    const hi = new THREE.SphereGeometry(1);
    const lods = Array.from({ length: MIN_INSTANCES }, (_, i) => lodAt(0, [lo, hi], i));
    expect(applyInstancedBatching(scene, lods).lodLevels).toEqual({ L0: MIN_INSTANCES });
    // The camera pulls back: every tile crosses into L1.
    lods.forEach((l) => { (l as unknown as { _currentLevel: number })._currentLevel = 1; });
    const s = applyInstancedBatching(scene, lods);
    expect(s.lodLevels).toEqual({ L1: MIN_INSTANCES });
    expect(s.groups).toBe(1);
    expect(s.batched).toBe(MIN_INSTANCES);
  });
});

describe('exclusions', () => {

  it('leaves a group below the threshold alone', () => {
    const ms = meshes(MIN_INSTANCES - 1, geo, mat);
    const s = applyInstancedBatching(scene, ms);
    expect(s.groups).toBe(0);
    expect(s.skipped['below-threshold']).toBe(1);
    expect(ms.every((m) => m.visible)).toBe(true);
  });

  it('skips invisible objects rather than batching a hidden thing into view', () => {
    const ms = meshes(MIN_INSTANCES, geo, mat);
    ms[0].visible = false;
    const s = applyInstancedBatching(scene, ms);
    expect(s.skipped.invisible).toBe(1);
    expect(s.batched).toBe(0);   // the rest fall under the threshold
  });
});

describe('lifecycle', () => {
  it('hides the members it draws, and RESTORES them when the batch is cleared', () => {
    const ms = meshes(MIN_INSTANCES, geo, mat);
    ms.forEach((m) => scene.add(m));
    applyInstancedBatching(scene, ms);
    expect(ms.every((m) => !m.visible)).toBe(true);
    clearInstancedBatches(scene);
    // If this regressed, disabling batching would leave the scene permanently half-empty —
    // a far worse failure than the slow frame it set out to fix.
    expect(ms.every((m) => m.visible)).toBe(true);
    expect(scene.children.some((c) => (c as THREE.InstancedMesh).isInstancedMesh)).toBe(false);
  });

  it('clears only the scene it was given — one module, several scenes', () => {
    // The editor runs the Game panel (batching on) and the SceneView (batching off, because it
    // picks by raycasting the meshes a batch hides) against ONE module instance. An unfiltered
    // clear would let the SceneView's sync dispose the game's batches every frame and the game
    // rebuild them every frame — pipeline churn caused by the cleanup path.
    const other = new THREE.Scene();
    const mine = meshes(MIN_INSTANCES, geo, mat);
    mine.forEach((m) => scene.add(m));
    applyInstancedBatching(scene, mine);

    const theirGeo = new THREE.BoxGeometry(2, 2, 2);
    const theirs = meshes(MIN_INSTANCES, theirGeo, mat);
    theirs.forEach((m) => other.add(m));
    applyInstancedBatching(other, theirs);

    clearInstancedBatches(other);
    expect(theirs.every((m) => m.visible)).toBe(true);        // theirs restored
    expect(mine.every((m) => !m.visible)).toBe(true);         // mine untouched
    expect(scene.children.some((c) => (c as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
  });

  it('rebuilds when membership changes, and retires a group that drops below the threshold', () => {
    const ms = meshes(MIN_INSTANCES + 2, geo, mat);
    ms.forEach((m) => scene.add(m));
    applyInstancedBatching(scene, ms);
    expect(getBatchStats().batched).toBe(MIN_INSTANCES + 2);

    const fewer = ms.slice(0, MIN_INSTANCES);
    applyInstancedBatching(scene, fewer);
    expect(getBatchStats().batched).toBe(MIN_INSTANCES);

    const tooFew = ms.slice(0, 2);
    applyInstancedBatching(scene, tooFew);
    expect(getBatchStats().groups).toBe(0);
    // the retired batch must give its members back
    expect(tooFew.every((m) => m.visible)).toBe(true);
  });

  it('writes each member world matrix into the instance buffer', () => {
    const ms = meshes(MIN_INSTANCES, geo, mat);
    applyInstancedBatching(scene, ms);
    const inst = scene.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    inst.getMatrixAt(2, m);
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    expect(pos.x).toBeCloseTo(2);   // meshes() places member i at x=i
  });

  it('follows a member that MOVES — motion is a matrix write, not a rebuild', () => {
    const ms = meshes(MIN_INSTANCES, geo, mat);
    applyInstancedBatching(scene, ms);
    ms[1].position.set(99, 0, 0);
    ms[1].updateMatrixWorld(true);
    applyInstancedBatching(scene, ms);
    const inst = scene.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    inst.getMatrixAt(1, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(99);
  });
});

describe('teardown paths the scene scoping opened', () => {
  it('reclaims an ORPHANED batch instead of stranding its members hidden', () => {
    const ms = meshes(MIN_INSTANCES, geo, mat);
    ms.forEach((m) => scene.add(m));
    applyInstancedBatching(scene, ms);
    const batch = scene.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh)!;

    // The scene is torn down without going through clearInstancedBatches — the batch is now
    // parented to nothing, and no future call will ever be handed its old scene again.
    batch.removeFromParent();

    // A clear for a DIFFERENT scene must still reclaim it: scoping by `parent === scene` alone
    // skipped it forever, leaving every member invisible and the group leaked.
    clearInstancedBatches(new THREE.Scene());
    expect(ms.every((m) => m.visible)).toBe(true);
  });

  it('clearAllInstancedBatches drops batches from EVERY scene — the world is going away', () => {
    const a = meshes(MIN_INSTANCES, geo, mat);
    a.forEach((m) => scene.add(m));
    applyInstancedBatching(scene, a);

    const other = new THREE.Scene();
    const theirGeo = new THREE.BoxGeometry(3, 3, 3);
    const b = meshes(MIN_INSTANCES, theirGeo, mat);
    b.forEach((m) => other.add(m));
    applyInstancedBatching(other, b);

    clearAllInstancedBatches();
    expect([...a, ...b].every((m) => m.visible)).toBe(true);
    expect(scene.children.some((c) => (c as THREE.InstancedMesh).isInstancedMesh)).toBe(false);
    expect(other.children.some((c) => (c as THREE.InstancedMesh).isInstancedMesh)).toBe(false);
  });

  it('does not allocate a stats object on the no-op path', () => {
    // clearInstancedBatches runs on the else branch of EVERY sync — every frame, every surface,
    // for as long as batching ships off. Returning a fresh object there put four allocations per
    // frame into the render loop of every game. Identity is the only way to observe that.
    clearInstancedBatches(scene);
    const first = getBatchStats();
    clearInstancedBatches(scene);
    expect(getBatchStats()).toBe(first);
  });
});

describe('reporting', () => {
  it('says WHY something was not batched', () => {
    const lod = new THREE.LOD();   // no levels at all — nothing to draw, nothing to batch
    const few = meshes(2, geo, mat);
    applyInstancedBatching(scene, [lod, ...few]);
    const s = getBatchStats();
    // The stat that saves an hour: not just "0 batched" but which reason each object hit.
    // NOTE `skipped.lod` is deliberately GONE — an LOD is now resolved to its active level and
    // batched. A level-less LOD is a different, narrower exclusion.
    expect(s.skipped['lod-level-not-a-mesh']).toBe(1);
    expect(s.skipped.lod).toBeUndefined();
    expect(s.skipped['below-threshold']).toBe(1);
    expect(s.considered).toBe(2);
  });
});
