/** flameMeshSync — FlameMesh entity → two-cone TSL flame group (runtime-rendering-3d
 *  Missing Test #7). Covers the per-frame state machine: create/reap, the
 *  additive-blending toggle, the radial-segment geometry swap, and the afterNPR
 *  layer assignment.
 *
 *  three/webgpu (NodeMaterial) and three/tsl are mocked — the TSL node graph is a
 *  GPU concern and irrelevant here; we exercise the THREE.Group/Mesh bookkeeping
 *  and the live-update branches around it. `three` itself stays REAL (Group, Mesh,
 *  LatheGeometry, blending constants, layers). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// NodeMaterial → a plain bag with the fields flameMeshSync writes (blending,
// needsUpdate, dispose). No GPU.
vi.mock('three/webgpu', () => ({
  NodeMaterial: class {
    transparent = false; depthWrite = true; side = 0; blending = 0; needsUpdate = false;
    colorNode: unknown = null; opacityNode: unknown = null;
    dispose = vi.fn();
  },
}));

// TSL: concrete chainable node stubs (NOT a catch-all Proxy — a Proxy returns a
// function for `.then`, making the mocked module look thenable and hanging vitest
// forever). Each node has the chain methods the builder calls plus `.y`; tsl
// functions return a node; `uniform(v)` returns a real `{ value }` so applyColors
// can `.set(...).convertSRGBToLinear()` on real THREE.Color uniforms.
vi.mock('three/tsl', () => {
  // One self-referential leaf node: every chain method + `.y` returns it, so
  // arbitrary `float(0).mul(x).add(y)` / `positionLocal.y` chains stay finite.
  const node: any = {};
  for (const m of ['mul', 'add', 'sub', 'div', 'clamp', 'smoothstep', 'mix', 'oneMinus', 'abs', 'dot', 'sin', 'cos']) node[m] = () => node;
  node.y = node;
  const fn = () => node;
  return {
    positionLocal: node, normalView: node, positionViewDirection: node, time: node,
    dot: fn, abs: fn, clamp: fn, mix: fn, smoothstep: fn, oneMinus: fn, vec3: fn, float: fn, sin: fn,
    uniform: (v: unknown) => ({ value: v }),
  };
});

// World transform map: empty → syncFlameMeshes falls back to the entity Transform.
vi.mock('../../src/three/systems/transformPropagationSystem', () => ({
  worldTransforms: new Map(),
}));
// onWorldSwap is called at module load to register the geometry-cache teardown —
// make it a no-op so importing the module doesn't pull the real world graph.
vi.mock('../../src/runtime/ecs/world', () => ({ onWorldSwap: vi.fn() }));

import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/traits/Transform';
import { FlameMesh } from '../../src/runtime/traits/FlameMesh';
import { PARTICLE_LAYER, DEFAULT_LAYER } from '../../src/runtime/rendering/layers';
import { createFlameMeshSyncState, syncFlameMeshes, disposeFlameMeshSyncState } from '../../src/runtime/rendering/flameMeshSync';

let world: ReturnType<typeof createWorld>;
let scene: THREE.Scene;
let state: ReturnType<typeof createFlameMeshSyncState>;

beforeEach(() => {
  world = createWorld();
  scene = new THREE.Scene();
  state = createFlameMeshSyncState();
});

describe('syncFlameMeshes — create / reap', () => {
  it('creates a group with outer+inner cone meshes on the PARTICLE_LAYER and adds it to the scene', () => {
    const e = world.spawn(Transform({ x: 1, y: 2, z: 3 }), FlameMesh({}));
    syncFlameMeshes(world, scene, state);

    const rec = state.recs.get(e.id())!;
    expect(rec).toBeDefined();
    expect(rec.group.children).toContain(rec.outerMesh);
    expect(rec.group.children).toContain(rec.innerMesh);
    expect(scene.children).toContain(rec.group);
    // afterNPR defaults true → particle layer (composited after the NPR pass).
    expect(rec.group.layers.isEnabled(PARTICLE_LAYER)).toBe(true);
    // Group carries the (fallback) entity transform.
    expect(rec.group.position.x).toBe(1);
    expect(rec.group.position.y).toBe(2);
    // Inner core drawn over the outer envelope.
    expect(rec.outerMesh.renderOrder).toBe(0);
    expect(rec.innerMesh.renderOrder).toBe(1);
  });

  it('is idempotent — a second frame reuses the same rec (no new group)', () => {
    const e = world.spawn(Transform(), FlameMesh({}));
    syncFlameMeshes(world, scene, state);
    const rec = state.recs.get(e.id());
    syncFlameMeshes(world, scene, state);
    expect(state.recs.get(e.id())).toBe(rec);
    expect(scene.children).toHaveLength(1);
  });

  it('reaps a removed entity: group off the scene, materials disposed, rec dropped', () => {
    const e = world.spawn(Transform(), FlameMesh({}));
    syncFlameMeshes(world, scene, state);
    const rec = state.recs.get(e.id())!;

    e.destroy();
    syncFlameMeshes(world, scene, state);

    expect(state.recs.has(e.id())).toBe(false);
    expect(scene.children).not.toContain(rec.group);
    expect(rec.outerMat.dispose).toHaveBeenCalled();
    expect(rec.innerMat.dispose).toHaveBeenCalled();
  });
});

describe('syncFlameMeshes — live updates', () => {
  it('toggles additive ↔ normal blending in place (no rebuild)', () => {
    const e = world.spawn(Transform(), FlameMesh({ additive: false }));
    syncFlameMeshes(world, scene, state);
    const rec = state.recs.get(e.id())!;
    expect(rec.outerMat.blending).toBe(THREE.NormalBlending);

    e.set(FlameMesh, { ...e.get(FlameMesh)!, additive: true });
    syncFlameMeshes(world, scene, state);
    expect(state.recs.get(e.id())).toBe(rec); // same rec — updated in place
    expect(rec.outerMat.blending).toBe(THREE.AdditiveBlending);
    expect(rec.innerMat.blending).toBe(THREE.AdditiveBlending);
    expect(rec.outerMat.needsUpdate).toBe(true);
    expect(rec.additive).toBe(true);
  });

  it('swaps the cone geometry when the radial-segment count changes (shared, not owned)', () => {
    const e = world.spawn(Transform(), FlameMesh({ radialSegments: 16 }));
    syncFlameMeshes(world, scene, state);
    const rec = state.recs.get(e.id())!;
    const geo16 = rec.outerMesh.geometry;

    e.set(FlameMesh, { ...e.get(FlameMesh)!, radialSegments: 32 });
    syncFlameMeshes(world, scene, state);
    expect(rec.segments).toBe(32);
    expect(rec.outerMesh.geometry).not.toBe(geo16);
    expect(rec.innerMesh.geometry).toBe(rec.outerMesh.geometry); // both share one geo
    // The 16-seg geometry is module-cached (shared), not disposed on swap.
    expect(geo16.attributes.position).toBeDefined();
  });

  it('assigns the DEFAULT layer when afterNPR is off (renders through the NPR pass)', () => {
    const e = world.spawn(Transform(), FlameMesh({ afterNPR: false }));
    syncFlameMeshes(world, scene, state);
    const rec = state.recs.get(e.id())!;
    expect(rec.group.layers.isEnabled(DEFAULT_LAYER)).toBe(true);
    expect(rec.group.layers.isEnabled(PARTICLE_LAYER)).toBe(false);
    expect(rec.outerMesh.layers.isEnabled(DEFAULT_LAYER)).toBe(true);
  });

  it('scales the cones by radius/length (length = length × lengthScale)', () => {
    const e = world.spawn(Transform(), FlameMesh({ radius: 0.2, length: 2, lengthScale: 1.5, innerScale: 0.5, innerLength: 0.5 }));
    syncFlameMeshes(world, scene, state);
    const rec = state.recs.get(e.id())!;
    expect(rec.outerMesh.scale.x).toBeCloseTo(0.2, 5);
    expect(rec.outerMesh.scale.y).toBeCloseTo(3, 5); // 2 × 1.5
    expect(rec.innerMesh.scale.x).toBeCloseTo(0.1, 5); // 0.2 × 0.5
    expect(rec.innerMesh.scale.y).toBeCloseTo(1.5, 5); // 3 × 0.5
  });
});

describe('disposeFlameMeshSyncState', () => {
  it('removes every group from the scene, disposes materials, and clears recs', () => {
    const a = world.spawn(Transform(), FlameMesh({}));
    const b = world.spawn(Transform(), FlameMesh({}));
    syncFlameMeshes(world, scene, state);
    const recs = [state.recs.get(a.id())!, state.recs.get(b.id())!];
    expect(state.recs.size).toBe(2);

    disposeFlameMeshSyncState(state, scene);
    expect(state.recs.size).toBe(0);
    for (const rec of recs) {
      expect(scene.children).not.toContain(rec.group);
      expect(rec.outerMat.dispose).toHaveBeenCalled();
      expect(rec.innerMat.dispose).toHaveBeenCalled();
    }
  });
});
