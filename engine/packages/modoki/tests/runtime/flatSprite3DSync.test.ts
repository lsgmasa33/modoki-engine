/** Flat (ground-plane) 2D skinned sprites — the SkinnedSprite2D + FlatSprite3D path in
 *  scene3DSync. It reuses the billboard machinery (entries live in state.billboards) but
 *  with mode 'flat': the sprite plane lies in world XZ (flip.rotation.x = -π/2) and the
 *  entity's OWN Transform rotation (heading yaw) is KEPT — orientBillboards must not
 *  re-orient it, only depth-rank it. Uses the REAL skin2DBuffers module (seeded via
 *  putSkin2DBuffer) with textures mocked, mirroring billboard3DSync.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/three/systems/transformPropagationSystem', () => ({
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
    getRiggedModel: vi.fn(() => undefined), ensureRiggedModelLoaded: vi.fn(),
  }));
  vi.doMock('../../src/runtime/loaders/assetRefRules', () => ({ isGuid: (s: string) => !!s }));
  const loadAsync = vi.fn(async () => ({ isTexture: true, colorSpace: '', flipY: false }));
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    getKTX2Loader: () => ({ loadAsync }),
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const bufs = await import('../../src/runtime/systems/skin2DBuffers');
  const T = await import('three');
  bufs.clearSkin2DBuffers();
  return { world: createWorld(), traits, sync, bufs, T, loadAsync };
}

/** A one-part rig buffer: a quad in pixel space (0,0)-(100,200), 2 tris. */
function quadPart() {
  return {
    positions: new Float32Array([0, 0, 100, 0, 100, 200, 0, 200]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    url: '/x~uastc.ktx2',
    sprite: 'aaaaaaaa-0000-4000-8000-000000000000',
    order: 0, name: 'body', visible: true,
  };
}

function spawnFlat(world: any, traits: any, opts: { ppu?: number; x?: number; z?: number; ry?: number } = {}) {
  const { Transform, SkinnedSprite2D, FlatSprite3D } = traits;
  return world.spawn(
    Transform({ x: opts.x ?? 0, y: 0, z: opts.z ?? 0, ry: opts.ry ?? 0 }),
    SkinnedSprite2D({ rig: 'rig-guid', color: 0xffffff, opacity: 1, flipX: false, flipY: false, isVisible: true }),
    FlatSprite3D({ alphaTest: 0.5, pixelsPerUnit: opts.ppu ?? 100 }),
  );
}

describe('syncBillboardSprites — flat (ground-plane) sprites', () => {
  it('builds an entry with mode "flat", lays the plane into XZ (flip.rotation.x = -π/2), centred pivot', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnFlat(world, traits, { ppu: 200 });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    const scene = new T.Scene();

    sync.syncBillboardSprites(world, scene, state);

    const entry = state.billboards.get(e.id())!;
    expect(entry).toBeDefined();
    expect(entry.mode).toBe('flat');
    expect(entry.meshes).toHaveLength(1);
    expect(scene.children).toContain(entry.group);
    // The sprite plane is laid flat into the world XZ plane.
    expect(entry.flip.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
    // Centred pivot: no anchor offset (unlike the billboard bottom/center anchor).
    expect(entry.flip.position.x).toBe(0);
    expect(entry.flip.position.y).toBe(0);
    expect(entry.flip.position.z).toBe(0);
    // pixels-per-unit still lives on the flip scale.
    expect(entry.flip.scale.x).toBeCloseTo(1 / 200, 6);
    expect(entry.flip.scale.y).toBeCloseTo(1 / 200, 6);
  });

  it('KEEPS the entity Transform rotation (heading) — orientBillboards must not re-orient it', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnFlat(world, traits, { ry: 0.7, x: 0, z: 0 });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    // applyTransform already set the group yaw from the entity Transform.
    const g = state.billboards.get(e.id())!.group;
    expect(g.rotation.y).toBeCloseTo(0.7, 6);

    // A camera off to the +X side would yaw a billboard ~90°. A flat sprite must NOT move.
    const cam = new T.PerspectiveCamera();
    cam.position.set(10, 5, 0);
    cam.updateMatrixWorld(true);
    sync.orientBillboards(state, cam);

    expect(g.rotation.y).toBeCloseTo(0.7, 6); // heading unchanged
    expect(g.rotation.x).toBeCloseTo(0, 6);
    expect(g.rotation.z).toBeCloseTo(0, 6);
  });

  it('still depth-ranks flat sprites past opaque geometry (renderOrder ≥ 10000)', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnFlat(world, traits);
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    const cam = new T.PerspectiveCamera();
    cam.position.set(0, 10, 10);
    cam.updateMatrixWorld(true);
    sync.orientBillboards(state, cam);

    expect(state.billboards.get(e.id())!.meshes[0].renderOrder).toBeGreaterThanOrEqual(10000);
  });

  it('sweeps the entity when FlatSprite3D is removed', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnFlat(world, traits);
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    const scene = new T.Scene();
    sync.syncBillboardSprites(world, scene, state);
    const firstGroup = state.billboards.get(e.id())!.group;

    e.remove(traits.FlatSprite3D);
    sync.syncBillboardSprites(world, scene, state);
    expect(state.billboards.has(e.id())).toBe(false);
    expect(scene.children).not.toContain(firstGroup);
  });
});
