/** `pinnedSideClone` + `pinnedStandIns` (#238) — the side-pinned-pass helpers, used by BOTH the
 *  pre-swap prewarm and the post-swap live compile. three
 *  draws a transparent double-sided material in TWO passes (BackSide then FrontSide), and
 *  `compileAsync` doesn't walk that branch, so the prewarm has to build both pipelines itself by
 *  cloning the material with `side` pinned and standing in a placeholder mesh for each. A clone
 *  that drops a property the pipeline cache keys on (`lightsNode`, `customProgramCacheKey`) warms
 *  a pipeline nothing reads and reproduces the exact boot stall this code exists to prevent — that
 *  is the case this file is most protective of. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

beforeEach(() => { vi.resetModules(); });

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(), resolveMaterialForMesh: vi.fn(), resolveMaterial: vi.fn(),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    onModelInvalidated: vi.fn(() => () => {}), getMeshAsset: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/primitives', () => ({ createPrimitiveMesh: vi.fn() }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));
  vi.doMock('../../src/runtime/loaders/riggedModelCache', () => ({
    getRiggedModel: vi.fn(() => undefined), ensureRiggedModelLoaded: vi.fn(), ensureRiggedModelLoadedFor: vi.fn(),
  }));
  // Any non-empty sprite ref is treated as a GUID so the texture-load path fires.
  vi.doMock('../../src/runtime/core/assetRefRules', () => ({ isGuid: (s: string) => !!s }));
  // Mock the KTX2 loader (billboards load part.url via getKTX2Loader / TextureLoader).
  const loadAsync = vi.fn(async () => ({ isTexture: true, colorSpace: '', flipY: false }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    getKTX2Loader: () => ({ loadAsync }),
  }));

  const sync = await import('../../src/runtime/rendering/scene3DSync');
  return { sync };
}

/** A material that draws in two side-pinned passes: transparent + DoubleSide + single-pass off. */
function sidePinnedMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide });
}

describe('pinnedSideClone', () => {
  it('returns a different material with the requested side, leaving the source untouched', async () => {
    const { sync } = await setup();
    const material = sidePinnedMaterial();

    const clone = sync.pinnedSideClone(material, THREE.BackSide);

    expect(clone).not.toBe(material);
    expect(clone.side).toBe(THREE.BackSide);
    expect(material.side).toBe(THREE.DoubleSide);
  });

  it('carries over lightsNode + customProgramCacheKey — the two properties that decide the cache key', async () => {
    const { sync } = await setup();
    const material = sidePinnedMaterial();
    const lightsNode = { mask: 0b1 };
    const cacheKey = () => 'fixed-key';
    const src = material as unknown as { lightsNode?: unknown; customProgramCacheKey?: () => string };
    src.lightsNode = lightsNode;
    src.customProgramCacheKey = cacheKey;

    const clone = sync.pinnedSideClone(material, THREE.FrontSide);

    const dst = clone as unknown as { lightsNode?: unknown; customProgramCacheKey?: () => string };
    expect(dst.lightsNode).toBe(lightsNode);
    expect(dst.customProgramCacheKey).toBe(cacheKey);
  });

  it('does not carry over `_`- or `is`-prefixed own properties (e.g. `_listeners`)', async () => {
    const { sync } = await setup();
    const material = sidePinnedMaterial();
    const listeners = { dispose: [vi.fn()] };
    (material as unknown as { _listeners: unknown })._listeners = listeners;

    const clone = sync.pinnedSideClone(material, THREE.FrontSide);

    // Sharing this object would make a dispose on either material fire the other's handlers.
    const dstListeners = (clone as unknown as { _listeners?: unknown })._listeners;
    expect(dstListeners).not.toBe(listeners);
  });

  it('does not put userData through a JSON round-trip, and leaves it untouched afterward', async () => {
    const { sync } = await setup();
    const material = sidePinnedMaterial();
    // A circular object: JSON.stringify would throw on it.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    material.userData = circular;

    expect(() => sync.pinnedSideClone(material, THREE.FrontSide)).not.toThrow();
    expect(material.userData).toBe(circular);
  });

  it('restores the source userData even when the clone throws', async () => {
    const { sync } = await setup();
    const material = sidePinnedMaterial();
    const original = { tag: 'original' };
    material.userData = original;
    (material as unknown as { clone: () => THREE.Material }).clone = () => {
      throw new Error('clone failed');
    };

    expect(() => sync.pinnedSideClone(material, THREE.FrontSide)).toThrow('clone failed');
    expect(material.userData).toBe(original);
  });
});

describe('pinnedStandIns', () => {
  it('returns two meshes (BackSide + FrontSide) for a transparent double-sided material, both retained', async () => {
    const { sync } = await setup();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, sidePinnedMaterial());
    const retain: Array<{ dispose(): void }> = [];

    const stands = sync.pinnedStandIns(mesh, retain);

    expect(stands).toHaveLength(2);
    const sides = stands.map((s) => (s.material as THREE.Material).side);
    expect(sides).toContain(THREE.BackSide);
    expect(sides).toContain(THREE.FrontSide);
    expect(retain).toHaveLength(2);
    for (const s of stands) expect(retain).toContain(s.material);
  });

  it('returns [] when the material is not side-pinned', async () => {
    const { sync } = await setup();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const opaque = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: false, side: THREE.DoubleSide }));
    const singleSided = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ transparent: true, side: THREE.FrontSide }));

    expect(sync.pinnedStandIns(opaque, [])).toEqual([]);
    expect(sync.pinnedStandIns(singleSided, [])).toEqual([]);
  });

  it('returns [] for a mesh whose cache key would fold in its own uuid (instanced / batched / morph)', async () => {
    const { sync } = await setup();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = sidePinnedMaterial();

    const instanced = new THREE.InstancedMesh(geometry, material, 1);
    expect(sync.pinnedStandIns(instanced, [])).toEqual([]);

    const batched = new THREE.Mesh(geometry, material) as unknown as THREE.Mesh & { isBatchedMesh: boolean };
    batched.isBatchedMesh = true;
    expect(sync.pinnedStandIns(batched, [])).toEqual([]);

    const morphed = new THREE.Mesh(geometry, material);
    morphed.morphTargetInfluences = [0.5];
    expect(sync.pinnedStandIns(morphed, [])).toEqual([]);
  });

  it('copies the flags/order/matrix that reach the pipeline key or the render list', async () => {
    const { sync } = await setup();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, sidePinnedMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.mask = 0b0101;
    mesh.renderOrder = 42;
    mesh.position.set(1, 2, 3);
    mesh.updateMatrixWorld(true);

    const [stand] = sync.pinnedStandIns(mesh, []);

    expect(stand.castShadow).toBe(true);
    expect(stand.receiveShadow).toBe(true);
    expect(stand.layers.mask).toBe(0b0101);
    expect(stand.renderOrder).toBe(42);
    expect(stand.frustumCulled).toBe(false); // never drawn — compileAsync must not cull it
    expect(stand.matrixAutoUpdate).toBe(false);
    expect(stand.matrix.equals(mesh.matrixWorld)).toBe(true);
  });

  it('a SkinnedMesh source produces SkinnedMesh stand-ins bound to the SAME skeleton', async () => {
    const { sync } = await setup();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const bone = new THREE.Bone();
    const skeleton = new THREE.Skeleton([bone]);
    const mesh = new THREE.SkinnedMesh(geometry, sidePinnedMaterial());
    mesh.bind(skeleton);

    const stands = sync.pinnedStandIns(mesh, []);

    expect(stands).toHaveLength(2);
    for (const stand of stands) {
      expect((stand as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh).toBe(true);
      // Sharing one skeleton across the two passes is what three itself does for LOD levels.
      expect((stand as THREE.SkinnedMesh).skeleton).toBe(skeleton);
    }
  });
});
