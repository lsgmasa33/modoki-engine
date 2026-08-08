/** blobShadowSync — BlobShadow entity → ground-contact shadow quad (low-end-device-support
 *  §0b: a cheap grounding cue for entities that don't cast a real shadow).
 *
 *  Covers the PURE decision logic (`blobShadowPlacement`): the fade curve from full
 *  opacity at the surface down to 0 at `fadeHeight` and beyond (clamped), and that a
 *  null raycast result (no ground / no physics world) yields a hidden blob. Also a light
 *  sync smoke test (create/update/reap), mirroring flameMeshSync's mock shape. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('three/webgpu', () => ({
  NodeMaterial: class {
    transparent = false; depthWrite = true; colorNode: unknown = null; opacityNode: unknown = null;
    dispose = vi.fn();
  },
}));

vi.mock('three/tsl', () => {
  const node: any = {};
  for (const m of ['mul', 'add', 'sub', 'div']) node[m] = () => node;
  // `positionLocal` is a NODE, not a function — it is swizzled (`.xy`), not called. The falloff
  // reads the quad's local position rather than `uv()`; see `buildBlobMaterial` for the measured
  // reason.
  node.xy = node;
  const fn = () => node;
  return {
    vec3: fn, mul: fn, float: fn, length: fn, smoothstep: fn,
    positionLocal: node,
    uniform: (v: unknown) => ({ value: v }),
  };
});

vi.mock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
  worldTransforms: new Map(),
  deactivatedEntities: new Set(),
}));
vi.mock('../../src/runtime/core/ecs/world', () => ({ onWorldSwap: vi.fn() }));

const raycast3DMock = vi.fn();
vi.mock('../../src/runtime/core/raycast3DRegistry', () => ({
  getRaycast3D: () => (...args: unknown[]) => raycast3DMock(...args),
}));

import { createWorld } from 'koota';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { BlobShadow } from '../../src/runtime/traits/BlobShadow';
import {
  blobShadowPlacement, createBlobShadowSyncState, syncBlobShadows, disposeBlobShadowSyncState,
} from '../../src/runtime/rendering/blobShadowSync';

describe('blobShadowPlacement — pure fade curve', () => {
  it('hides when the raycast finds no ground', () => {
    const p = blobShadowPlacement(null, 0.02, 2, 0.5);
    expect(p.visible).toBe(false);
    expect(p.opacity).toBe(0);
    expect(p.position).toBeNull();
    expect(p.normal).toBeNull();
  });

  it('is at full opacity right at the surface (distance 0)', () => {
    const p = blobShadowPlacement({ x: 1, y: 2, z: 3, nx: 0, ny: 1, nz: 0, distance: 0 }, 0.02, 2, 0.5);
    expect(p.visible).toBe(true);
    expect(p.opacity).toBeCloseTo(0.5, 9);
  });

  it('fades linearly between the surface and fadeHeight', () => {
    const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 1 }, 0.02, 2, 0.5);
    expect(p.visible).toBe(true);
    expect(p.opacity).toBeCloseTo(0.25, 9); // halfway to fadeHeight=2 → half the peak opacity
  });

  it('is exactly 0 at fadeHeight', () => {
    const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 2 }, 0.02, 2, 0.5);
    expect(p.opacity).toBeCloseTo(0, 9);
  });

  it('clamps to 0 beyond fadeHeight (never negative)', () => {
    const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 5 }, 0.02, 2, 0.5);
    expect(p.opacity).toBe(0);
  });

  it('lifts the position along the hit normal by groundOffset', () => {
    const p = blobShadowPlacement({ x: 1, y: 5, z: 1, nx: 0, ny: 1, nz: 0, distance: 0 }, 0.1, 2, 0.5);
    expect(p.position).toEqual({ x: 1, y: 5.1, z: 1 });
    expect(p.normal).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('does not divide by zero when fadeHeight is 0', () => {
    const atSurface = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 0 }, 0, 0, 0.5);
    expect(atSurface.opacity).toBeCloseTo(0.5, 9);
    const above = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 0.01 }, 0, 0, 0.5);
    expect(above.opacity).toBe(0);
  });

  describe('fadeStart — hit.distance is measured from the entity ORIGIN, not its feet', () => {
    it('is at full opacity when distance equals fadeStart (e.g. a standing capsule character)', () => {
      // A capsule whose origin sits 1 unit above the ground it stands on: fully grounded,
      // yet hit.distance reads 1 — without fadeStart this would already be half-faded.
      const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 1 }, 0.02, 2, 0.5, 1);
      expect(p.opacity).toBeCloseTo(0.5, 9);
    });

    it('fades linearly between fadeStart and fadeStart + fadeHeight', () => {
      const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 2 }, 0.02, 2, 0.5, 1);
      expect(p.opacity).toBeCloseTo(0.25, 9); // rise = 2 - 1 = 1, halfway to fadeHeight=2
    });

    it('is exactly 0 at fadeStart + fadeHeight', () => {
      const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 3 }, 0.02, 2, 0.5, 1);
      expect(p.opacity).toBeCloseTo(0, 9);
    });

    // A fully faded blob must be HIDDEN, not drawn at zero opacity: an entity beyond
    // fadeStart+fadeHeight (a jumping character) would otherwise keep costing a draw call to
    // rasterize nothing, which is the cost-without-benefit this whole feature exists to avoid.
    it('is HIDDEN once fully faded, not merely transparent', () => {
      const atZero = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 3 }, 0.02, 2, 0.5, 1);
      expect(atZero.visible).toBe(false);
      const wayAbove = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 50 }, 0.02, 2, 0.5, 1);
      expect(wayAbove.visible).toBe(false);
      expect(wayAbove.position).toBeNull();
    });

    it('is HIDDEN when the authored opacity is 0 (an authored-off blob costs no draw call)', () => {
      const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 1 }, 0.02, 2, 0, 1);
      expect(p.visible).toBe(false);
    });

    it('stays at full opacity below fadeStart (never over-brightens, never negative rise)', () => {
      const p = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 0.3 }, 0.02, 2, 0.5, 1);
      expect(p.opacity).toBeCloseTo(0.5, 9);
    });

    it('defaults to 0 (reproduces the original distance-from-surface behaviour)', () => {
      const withDefault = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 1 }, 0.02, 2, 0.5);
      const withExplicitZero = blobShadowPlacement({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 1 }, 0.02, 2, 0.5, 0);
      expect(withDefault.opacity).toBeCloseTo(withExplicitZero.opacity, 9);
      expect(withDefault.opacity).toBeCloseTo(0.25, 9);
    });
  });
});

describe('syncBlobShadows — create / reap / hide', () => {
  let world: ReturnType<typeof createWorld>;
  let scene: THREE.Scene;
  let state: ReturnType<typeof createBlobShadowSyncState>;

  beforeEach(() => {
    world = createWorld();
    scene = new THREE.Scene();
    state = createBlobShadowSyncState();
    raycast3DMock.mockReset();
  });

  it('creates a mesh on a ground hit and positions it at the lifted hit point', () => {
    raycast3DMock.mockReturnValue({ x: 1, y: 0, z: 1, nx: 0, ny: 1, nz: 0, distance: 0 });
    const e = world.spawn(Transform({ x: 1, y: 5, z: 1 }), BlobShadow({ groundOffset: 0.02 }));
    syncBlobShadows(world, scene, state);

    const rec = state.recs.get(e.id())!;
    expect(rec).toBeDefined();
    expect(scene.children).toContain(rec.mesh);
    expect(rec.mesh.visible).toBe(true);
    expect(rec.mesh.position.y).toBeCloseTo(0.02, 9);
  });

  it('excludes the casting entity itself from the raycast (never grounds on its own body)', () => {
    raycast3DMock.mockReturnValue({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 1 });
    const e = world.spawn(Transform({ x: 0, y: 1, z: 0 }), BlobShadow({}));
    syncBlobShadows(world, scene, state);

    expect(raycast3DMock).toHaveBeenCalledWith(
      world, 0, 1, 0, 0, -1, 0,
      expect.objectContaining({ exclude: e.id() }),
    );
  });

  it('hides the mesh (does not remove it) when the raycast finds no ground', () => {
    raycast3DMock.mockReturnValue(null);
    const e = world.spawn(Transform({ x: 0, y: 0, z: 0 }), BlobShadow({}));
    syncBlobShadows(world, scene, state);

    const rec = state.recs.get(e.id())!;
    expect(rec.mesh.visible).toBe(false);
    expect(scene.children).toContain(rec.mesh); // still tracked, just hidden
  });

  it('reaps a removed entity: mesh off the scene, material disposed, rec dropped', () => {
    raycast3DMock.mockReturnValue({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 0 });
    const e = world.spawn(Transform(), BlobShadow({}));
    syncBlobShadows(world, scene, state);
    const rec = state.recs.get(e.id())!;

    e.destroy();
    syncBlobShadows(world, scene, state);

    expect(state.recs.has(e.id())).toBe(false);
    expect(scene.children).not.toContain(rec.mesh);
    expect(rec.mat.dispose).toHaveBeenCalled();
  });

  it('is idempotent — a second frame reuses the same rec (no new mesh)', () => {
    raycast3DMock.mockReturnValue({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 0 });
    const e = world.spawn(Transform(), BlobShadow({}));
    syncBlobShadows(world, scene, state);
    const rec = state.recs.get(e.id());
    syncBlobShadows(world, scene, state);
    expect(state.recs.get(e.id())).toBe(rec);
    expect(scene.children).toHaveLength(1);
  });
});

describe('disposeBlobShadowSyncState', () => {
  it('removes every mesh from the scene, disposes materials, and clears recs', () => {
    raycast3DMock.mockReturnValue({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, distance: 0 });
    const world = createWorld();
    const scene = new THREE.Scene();
    const state = createBlobShadowSyncState();
    const a = world.spawn(Transform(), BlobShadow({}));
    const b = world.spawn(Transform(), BlobShadow({}));
    syncBlobShadows(world, scene, state);
    const recs = [state.recs.get(a.id())!, state.recs.get(b.id())!];
    expect(state.recs.size).toBe(2);

    disposeBlobShadowSyncState(state, scene);
    expect(state.recs.size).toBe(0);
    for (const rec of recs) {
      expect(scene.children).not.toContain(rec.mesh);
      expect(rec.mat.dispose).toHaveBeenCalled();
    }
  });
});
