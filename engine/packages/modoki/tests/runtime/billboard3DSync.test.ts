/** Billboarded 2D skinned sprites (2.5D) — the SkinnedSprite2D + Billboard3D pass
 *  in scene3DSync. Verifies the deform-buffer → THREE.BufferGeometry bridge (the
 *  riskiest assumption), the pixels-per-unit/flip scale, the version-gated position
 *  re-upload, camera-facing orientation (cylindrical yaw + spherical copy), and the
 *  teardown sweep. Uses the REAL skin2DBuffers module (seeded via putSkin2DBuffer) —
 *  the same seam PixiJS Scene2D reads — with textures mocked. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    registerEnvDisposeHook: vi.fn(), // (#739) envPmrem.ts registers with this at module scope
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
  // `ensureKtx2Caps` too: `loadBillboardPage` gates a KTX2 page on it. Without it every page load
  // in this file REJECTED (a missing-export error, swallowed by the `.catch` warn), so no test here
  // ever saw a page land — found by #1368's G2 test, the first one to wait for one.
  vi.doMock('../../src/runtime/loaders/textureResolver', () => ({
    getKTX2Loader: () => ({ loadAsync }),
    ensureKtx2Caps: async () => {},
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const bufs = await import('../../src/runtime/skinning/skin2DBuffers');
  const T = await import('three');
  bufs.clearSkin2DBuffers();
  return { world: createWorld(), traits, sync, bufs, T, loadAsync };
}

/** A one-part rig buffer: a quad in pixel space (0,0)-(100,200), 2 tris. */
function quadPart(positions?: Float32Array) {
  return {
    positions: positions ?? new Float32Array([0, 0, 100, 0, 100, 200, 0, 200]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    url: '/x~uastc.ktx2',
    sprite: 'aaaaaaaa-0000-4000-8000-000000000000',
    order: 0, name: 'body', visible: true,
  };
}

function spawnBillboard(world: any, traits: any, opts: { mode?: 'cylindrical' | 'spherical'; ppu?: number; x?: number; z?: number; anchor?: 'bottom' | 'center' } = {}) {
  const { Transform, SkinnedSprite2D, Billboard3D } = traits;
  return world.spawn(
    Transform({ x: opts.x ?? 0, y: 0, z: opts.z ?? 0 }),
    SkinnedSprite2D({ rig: 'rig-guid', color: 0xffffff, opacity: 1, flipX: false, flipY: false, isVisible: true }),
    Billboard3D({ mode: opts.mode ?? 'cylindrical', alphaTest: 0.5, pixelsPerUnit: opts.ppu ?? 100, anchor: opts.anchor ?? 'bottom' }),
  );
}

describe('syncBillboardSprites — geometry bridge', () => {
  it('builds a group + one mesh per part, mapping pixel verts to (x, -y, 0)', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits);
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    const scene = new T.Scene();

    sync.syncBillboardSprites(world, scene, state);

    const entry = state.billboards.get(e.id())!;
    expect(entry).toBeDefined();
    expect(entry.meshes).toHaveLength(1);
    expect(scene.children).toContain(entry.group);
    const pos = entry.meshes[0].geometry.getAttribute('position');
    // vertex 2 was pixel (100,200) → world (100, -200, 0) (Y negated: 2D down → 3D up)
    expect(pos.getX(2)).toBe(100);
    expect(pos.getY(2)).toBe(-200);
    expect(pos.getZ(2)).toBe(0);
  });

  it('puts pixels-per-unit + flipX on the inner flip group (not the geometry)', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits, { ppu: 200 });
    e.set(traits.SkinnedSprite2D, { ...e.get(traits.SkinnedSprite2D)!, flipX: true });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    const flip = state.billboards.get(e.id())!.flip;
    expect(flip.scale.x).toBeCloseTo(-1 / 200, 6); // flipX ⇒ negative, /ppu
    expect(flip.scale.y).toBeCloseTo(1 / 200, 6);
  });

  it("anchor 'bottom' places the feet (lowest bind vertex) at the group origin", async () => {
    const { world, traits, sync, bufs, T } = await setup();
    // quad spans pixel y 0..200; ppu 100 ⇒ 2 units tall. Feet (pixel y=200) → group y=0.
    const e = spawnBillboard(world, traits, { anchor: 'bottom', ppu: 100 });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    const { flip, meshes } = state.billboards.get(e.id())!;
    // lowest vertex (pixel y=200) local group-y = flip.scale.y*(-200) + flip.position.y
    const py = meshes[0].geometry.getAttribute('position');
    const lowest = Math.min(...[0, 1, 2, 3].map((i) => flip.scale.y * py.getY(i) + flip.position.y));
    const highest = Math.max(...[0, 1, 2, 3].map((i) => flip.scale.y * py.getY(i) + flip.position.y));
    expect(lowest).toBeCloseTo(0, 6);   // feet at the entity origin (on the ground)
    expect(highest).toBeCloseTo(2, 6);  // 200px / 100ppu tall, all above the origin
  });

  it("anchor 'center' places the vertical mid-point at the group origin", async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits, { anchor: 'center', ppu: 100 });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    const { flip, meshes } = state.billboards.get(e.id())!;
    const py = meshes[0].geometry.getAttribute('position');
    const ys = [0, 1, 2, 3].map((i) => flip.scale.y * py.getY(i) + flip.position.y);
    expect(Math.min(...ys)).toBeCloseTo(-1, 6); // centred: ±1 unit about the origin
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
  });

  it('re-uploads positions only on a deform-version bump', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits);
    const buf = bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    const scene = new T.Scene();
    sync.syncBillboardSprites(world, scene, state);
    const entry = state.billboards.get(e.id())!;
    // Relative, not literal: versions come from one module-wide counter (#1141), so the first
    // put is whatever that counter reached — the contract is "tracks the buffer", not "starts at 0".
    expect(entry.deformVersion).toBe(buf.version);
    const built = buf.version;

    // Move a vertex + bump: the geometry follows.
    buf.parts[0].positions[4] = 150; // x of vertex 2
    bufs.bumpSkin2DVersion(buf);
    sync.syncBillboardSprites(world, scene, state);
    expect(entry.deformVersion).toBe(buf.version);
    expect(entry.deformVersion).not.toBe(built);
    expect(entry.meshes[0].geometry.getAttribute('position').getX(2)).toBe(150);
  });

  it('rebuilds when the rig ref changes and sweeps entities that stop billboarding', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits);
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    const scene = new T.Scene();
    sync.syncBillboardSprites(world, scene, state);
    const firstGroup = state.billboards.get(e.id())!.group;

    // Drop Billboard3D → the entity no longer billboards → swept from scene.
    e.remove(traits.Billboard3D);
    sync.syncBillboardSprites(world, scene, state);
    expect(state.billboards.has(e.id())).toBe(false);
    expect(scene.children).not.toContain(firstGroup);
  });
});

describe('orientBillboards — camera facing', () => {
  it('cylindrical: yaws to face the camera horizontally (Y-locked)', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits, { mode: 'cylindrical', x: 0, z: 0 });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    // Camera to the +X side of the sprite → it should yaw ~ +90° about Y.
    const cam = new T.PerspectiveCamera();
    cam.position.set(10, 0, 0);
    cam.updateMatrixWorld(true);
    sync.orientBillboards(state, cam);

    const g = state.billboards.get(e.id())!.group;
    // yaw = atan2(dx, dz) = atan2(10, 0) = +PI/2
    expect(g.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    expect(g.rotation.x).toBe(0); // stays upright
    expect(g.rotation.z).toBe(0);
  });

  it('spherical: copies the camera orientation (full-face)', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits, { mode: 'spherical' });
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    const cam = new T.PerspectiveCamera();
    cam.position.set(3, 4, 5);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    sync.orientBillboards(state, cam);

    const g = state.billboards.get(e.id())!.group;
    expect(g.quaternion.x).toBeCloseTo(cam.quaternion.x, 6);
    expect(g.quaternion.y).toBeCloseTo(cam.quaternion.y, 6);
    expect(g.quaternion.z).toBeCloseTo(cam.quaternion.z, 6);
    expect(g.quaternion.w).toBeCloseTo(cam.quaternion.w, 6);
  });

  it('depth-ranks overlapping billboards: the NEAR sprite gets a higher renderOrder', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const near = spawnBillboard(world, traits, { x: 0, z: 5 });  // closer to a +Z camera
    const far = spawnBillboard(world, traits, { x: 0, z: -5 });  // farther
    bufs.putSkin2DBuffer(near.id(), { parts: [quadPart()] });
    bufs.putSkin2DBuffer(far.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    sync.syncBillboardSprites(world, new T.Scene(), state);

    const cam = new T.PerspectiveCamera();
    cam.position.set(0, 0, 50);
    cam.updateMatrixWorld(true);
    sync.orientBillboards(state, cam);

    const nearRO = state.billboards.get(near.id())!.meshes[0].renderOrder;
    const farRO = state.billboards.get(far.id())!.meshes[0].renderOrder;
    expect(nearRO).toBeGreaterThan(farRO);   // near drawn last (on top) where they overlap
    expect(farRO).toBeGreaterThanOrEqual(10000); // both still composite after opaque geometry
  });
});

describe('syncBillboardSprites — per-part visibility + bind-pose anchor', () => {
  it('honors a per-part visibility toggle each frame (no rebuild needed)', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits);
    const buf = bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
    const state = sync.createRenderState();
    const scene = new T.Scene();
    sync.syncBillboardSprites(world, scene, state);
    expect(state.billboards.get(e.id())!.meshes[0].visible).toBe(true);

    // Toggle the part off — no topology change, so no rebuild; the mesh must hide anyway.
    const firstGroup = state.billboards.get(e.id())!.group;
    buf.parts[0].visible = false;
    sync.syncBillboardSprites(world, scene, state);
    expect(state.billboards.get(e.id())!.group).toBe(firstGroup);       // same entry (not rebuilt)
    expect(state.billboards.get(e.id())!.meshes[0].visible).toBe(false); // but hidden
  });

  it("anchors feet from the BIND pose — a later posed frame doesn't move the ground", async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const e = spawnBillboard(world, traits, { anchor: 'bottom', ppu: 100 });
    const buf = bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] }); // bind quad, y 0..200
    const state = sync.createRenderState();
    const scene = new T.Scene();
    sync.syncBillboardSprites(world, scene, state);
    const anchorY = state.billboards.get(e.id())!.flip.position.y;

    // Simulate an animation lifting the feet (shift every y up by 60px) + a version bump.
    for (let i = 1; i < buf.parts[0].positions.length; i += 2) buf.parts[0].positions[i] -= 60;
    bufs.bumpSkin2DVersion(buf);
    sync.syncBillboardSprites(world, scene, state);
    // Anchor is from the stable bind extent, so the flip offset (the ground plane) is unchanged.
    expect(state.billboards.get(e.id())!.flip.position.y).toBeCloseTo(anchorY, 9);
  });
});

/** #1197 — the screen-bounds provider refuses a billboard whose `owner` is dead. The entry SURVIVES
 *  a same-rig respawn on the dead entity's index (the rebuild gate compares rig + topology only), so a
 *  stamp written only when the entry is BUILT would name the dead entity forever and the newcomer
 *  would never be measurable. The stamp must follow every visit. */
describe('syncBillboardSprites — owner stamp (#1197)', () => {
  it('stamps the building entity, and re-stamps the newcomer that inherits the entry on its index', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const scene = new T.Scene();
    const state = sync.createRenderState();

    const first = spawnBillboard(world, traits);
    bufs.putSkin2DBuffer(first.id(), { parts: [quadPart()] });
    sync.syncBillboardSprites(world, scene, state);
    const entry = state.billboards.get(first.id())!;
    expect(entry.owner).toBe(first.valueOf());

    const id = first.id();
    first.destroy();
    const second = spawnBillboard(world, traits);
    expect(second.id()).toBe(id); // premise: the index was reclaimed
    expect(second.valueOf()).not.toBe(entry.owner);
    sync.syncBillboardSprites(world, scene, state);

    expect(state.billboards.get(id)).toBe(entry); // kept, not rebuilt — the case the stamp must follow
    expect(entry.owner).toBe(second.valueOf());
  });
});

// #1368 G2: a billboard page lands asynchronously and binds `mat.map`, but nothing woke the idle
// gate — so on a stopped Scene3D the page arriving after the ~1 s grace was never drawn. The wake
// rides the SHARED page job (once per load, whatever number of parts share the page).
describe('syncBillboardSprites — a landed texture page wakes the idle gate (#1368 G2)', () => {
  it('wakes once per page load, and the frame it buys sees the map bound', async () => {
    const { world, traits, sync, bufs, T } = await setup();
    const { addDirtyListener } = await import('../../src/runtime/core/renderDirty');
    const e = spawnBillboard(world, traits);
    bufs.putSkin2DBuffer(e.id(), { parts: [quadPart(), { ...quadPart(), name: 'arm', order: 1 }] }); // two parts, ONE page
    const state = sync.createRenderState();

    const mapsOnWokenFrame: boolean[] = [];
    const off = addDirtyListener(() => {
      setTimeout(() => {
        const entry = state.billboards.get(e.id())!;
        mapsOnWokenFrame.push(entry.meshes.every((m: any) => !!m.material.map));
      }, 0);
    });
    sync.syncBillboardSprites(world, new T.Scene(), state);
    await vi.waitFor(() => expect(mapsOnWokenFrame.length, 'a landed page must wake an idle surface').toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(mapsOnWokenFrame, 'one wake for the shared page, and its frame sees every part bound').toEqual([true]);
  });
});

// #1397: a billboard entry is rebuilt only on a `billboardSig` change, so a page whose load failed
// stayed missing for the entry's whole life — a network blip blanked the sprite until its rig
// changed. The failure now backs off, and the per-frame sync re-asks once the backoff expires.
describe('syncBillboardSprites — a failed page is retried after its backoff (#1397)', () => {
  it('retries once the backoff expires (not every frame before it) and binds the page', async () => {
    const { world, traits, sync, bufs, T, loadAsync } = await setup();
    const clock = await import('../../src/runtime/core/clock');
    const { RETRY_BASE_MS } = await import('../../src/runtime/core/loadFailureMemo');
    clock.setManualNow(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadAsync.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const e = spawnBillboard(world, traits);
      bufs.putSkin2DBuffer(e.id(), { parts: [quadPart()] });
      const state = sync.createRenderState();
      const scene = new T.Scene();
      const settle = () => new Promise((r) => setTimeout(r, 0));

      sync.syncBillboardSprites(world, scene, state);
      await settle();
      for (let frame = 0; frame < 5; frame++) { sync.syncBillboardSprites(world, scene, state); await settle(); }
      expect(loadAsync, 'backing off: frames inside the backoff do not refetch').toHaveBeenCalledTimes(1);
      const mesh = state.billboards.get(e.id())!.meshes[0] as any;
      expect(mesh.material.map).toBeFalsy();

      clock.advanceManual(RETRY_BASE_MS);
      sync.syncBillboardSprites(world, scene, state);
      await vi.waitFor(() => expect(mesh.material.map, 'the retried page binds').toBeTruthy());
      expect(loadAsync).toHaveBeenCalledTimes(2);
    } finally {
      clock.restoreRealClock();
      warn.mockRestore();
    }
  });
});
