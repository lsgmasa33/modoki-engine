/** Light masks wired through the render sync (#136) — the INTEGRATION half.
 *
 *  `lightMaskVariants.test.ts` covers the cache in isolation. This drives the real
 *  `syncLights` → `syncRenderables` pair against a live koota world so the wiring itself is
 *  pinned: masks published from the Light trait, the variant bound to the entity's meshes, and
 *  — the one that matters most — `syncMaterial` NOT stomping the variant on the next frame.
 *
 *  That last case is why this file exists. The first hand-patched measurement of this feature on
 *  a real device showed NO improvement and read as a refuted idea; the cause was `syncMaterial`
 *  re-binding the resolved base underneath the override every frame. A green unit suite would
 *  not have caught it, because the cache was behaving perfectly — it was never consulted. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const deactivatedEntities = new Set<number>();
const worldTransforms = new Map<number, unknown>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  deactivatedEntities.clear();
  worldTransforms.clear();
});

/** Records every light list handed to createNode, so we can assert on SELECTION. */
function stubRenderer() {
  const calls: THREE.Light[][] = [];
  return { calls, lighting: { createNode: (l: THREE.Light[]) => { calls.push([...l]); return { n: l.length }; } } };
}

async function setup() {
  const sharedMaterial = new THREE.MeshStandardMaterial();
  // A distinct material per ref, so a material-ref SWAP is observable. A single shared stub
  // would make "changed the ref" and "did nothing" produce identical materials.
  const byRef = new Map<string, THREE.MeshStandardMaterial>();
  const materialFor = (ref: string) => {
    if (!ref) return sharedMaterial;
    let m = byRef.get(ref);
    if (!m) { m = new THREE.MeshStandardMaterial(); byRef.set(ref, m); }
    return m;
  };
  const renderer = stubRenderer();
  /** retired base → its successor, the answer `refreshedMaterial` gives (#318). Empty by
   *  default: nothing here is retired, so every masked target falls back to the base it had. */
  const successors = new Map<THREE.Material, THREE.Material>();

  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    registerEnvDisposeHook: vi.fn(), // (#739) envPmrem.ts registers with this at module scope
    resolveMeshTemplate: vi.fn(() => ({ geometry: new THREE.BoxGeometry(), material: sharedMaterial })),
    resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn((ref: string) => materialFor(ref)),
    resolveMaterial: vi.fn((ref: string) => materialFor(ref)),
    // #318 — `applyLightMask` asks this on every masked target so a variant bound to a RETIRED
    // base can find the re-imported one. `successors` is empty unless a test stages a re-import.
    refreshedMaterial: vi.fn((m: THREE.Material) => successors.get(m)),
    getCachedEnvironment: vi.fn(),
    acquireEnvironment: vi.fn(),
  }));
  vi.doMock('../../src/runtime/core/activeRenderer', () => ({
    getActiveRenderer: () => renderer,
    onRendererLost: () => () => {},
  }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const { Light } = await import('../../src/three/traits/Light');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const variants = await import('../../src/runtime/rendering/lightMaskVariants');
  variants.resetLightMaskVariants();

  const scene = new THREE.Scene();
  return { world: createWorld(), traits, Light, sync, variants, scene, sharedMaterial, renderer, materialFor, successors };
}

/** One frame: lights then renderables, the order Scene3D uses. */
function frame(sync: any, world: any, scene: THREE.Scene, ecsLights: Map<number, THREE.Light>, state: any) {
  sync.syncLights(world, scene, ecsLights);
  sync.syncRenderables(world, scene, state);
}

describe('unauthored scene — masks are inert', () => {
  it('binds the shared material and builds no variant when every mask is the default', async () => {
    const { world, traits, Light, sync, variants, scene, renderer, materialFor } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point' }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true }));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material).toBe(materialFor('mat'));
    expect(variants.getLightMaskStats().variants).toBe(0);
    expect(renderer.calls).toHaveLength(0);
  });
});

describe('authored masks', () => {
  it('binds a variant carrying only the intersecting light', async () => {
    const { world, traits, Light, sync, scene, renderer, materialFor } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    const base = materialFor('mat');
    const bound = (state.ecsObjects.get(e.id()) as THREE.Mesh).material;
    expect(bound).not.toBe(base);
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]).toHaveLength(1);
    // The shared base is cache-owned and must never be given a lightsNode.
    expect((base as THREE.Material & { lightsNode?: unknown }).lightsNode).toBeUndefined();
  });

  it('gives a renderer whose mask matches NO light a variant with zero lights', async () => {
    // Meaningful on its own: this is how "this object is lit only by its own key light" degrades
    // when that light is removed — unlit, not silently lit by everything.
    const { world, traits, Light, sync, variants, scene, renderer } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point' })); // default mask 1
    world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b10 }));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    expect(renderer.calls[0]).toEqual([]);
    expect(variants.getLightMaskStats().active).toBe(true);
  });

  it('shares ONE variant across many meshes on the same mask', async () => {
    const { world, traits, Light, sync, variants, scene } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const ents = Array.from({ length: 12 }, () =>
      world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b01 })));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    expect(variants.getLightMaskStats().variants).toBe(1);
    const first = (state.ecsObjects.get(ents[0].id()) as THREE.Mesh).material;
    for (const e of ents) expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material).toBe(first);
  });
});

describe('primitives (Renderable3DPrimitive)', () => {
  // These are the room — floor, walls, plinths — i.e. the big screen-covering surfaces where the
  // fragment cost actually lives. Leaving them out is why the first on-device run through the
  // real code path got 1.55x where the hand-patched one got 7x: 24 of the scene's renderers were
  // still seeing all 19 lights.
  it('binds a variant for an explicit-material primitive', async () => {
    const { world, traits, Light, sync, scene, renderer, materialFor } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'box', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material).not.toBe(materialFor('mat'));
    expect(renderer.calls[0]).toHaveLength(1);
  });

  it('leaves a DEFAULT-material primitive alone — the live colour path owns it', async () => {
    // A default-material primitive owns a per-entity material that `color` is written into each
    // frame; a variant is shared by (material, mask), so binding one would fight the colour.
    const { world, traits, Light, sync, variants, scene, renderer } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'box', material: '', color: 0x00ff00, isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    expect(variants.getLightMaskStats().variants).toBe(0);
    expect(renderer.calls).toHaveLength(0);
  });

  it('arms masking when ONLY a primitive is masked', async () => {
    // The arming scan has to cover primitives too, or a primitive-only authoring pass would
    // silently do nothing while every mask read as set.
    const { world, traits, Light, sync, variants, scene } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    world.spawn(Transform(), Light({ lightType: 'point' })); // default mask
    world.spawn(Transform(), Renderable3DPrimitive({ mesh: 'box', material: 'mat', isVisible: true, renderingLayerMask: 0b10 }));
    const state = sync.createRenderState();

    frame(sync, world, scene, new Map(), state);

    expect(variants.getLightMaskStats().active).toBe(true);
  });
});

describe('the stomp — syncMaterial must not reclaim a masked mesh', () => {
  it('holds the variant across repeated frames and reassigns nothing', async () => {
    const { world, traits, Light, sync, scene, sharedMaterial, materialFor } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();
    const ecsLights = new Map<number, THREE.Light>();

    frame(sync, world, scene, ecsLights, state);
    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const variant = mesh.material;
    expect(variant).not.toBe(sharedMaterial);
    expect(variant).not.toBe(materialFor('mat'));

    // Watch for ANY write to .material on later frames — the churn itself is the bug, even
    // though the end-of-frame value would look correct.
    let writes = 0;
    let backing = mesh.material;
    Object.defineProperty(mesh, 'material', {
      get: () => backing,
      set: (v) => { writes++; backing = v; },
      configurable: true,
    });

    frame(sync, world, scene, ecsLights, state);
    frame(sync, world, scene, ecsLights, state);

    expect(writes).toBe(0);
    expect(backing).toBe(variant);
  });

  it('still picks up a genuine material-ref change and rebuilds from the new base', async () => {
    const { world, traits, Light, sync, scene } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat-a', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();
    const ecsLights = new Map<number, THREE.Light>();

    frame(sync, world, scene, ecsLights, state);
    const before = (state.ecsObjects.get(e.id()) as THREE.Mesh).material;

    e.set(Renderable3D, { ...e.get(Renderable3D)!, material: 'mat-b' });
    frame(sync, world, scene, ecsLights, state);

    // Suppressing the per-frame re-bind must not suppress a real ref change: the mask branch
    // skips only the "async load may have landed" path, never the changed-material path.
    expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material).not.toBe(before);
  });
});

describe('light-set changes invalidate', () => {
  it('rebinds when a light joins the mask mid-scene', async () => {
    const { world, traits, Light, sync, scene, renderer } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    const held = world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b100 }));
    // Permanently outside 0b01, so the mask stays NARROWER than the full set after `held` joins.
    // Without it, 0b01 would come to see every light and correctly fall back to the scene's
    // global lights node — testing the sees-everything shortcut, not the rebuild.
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b1000 }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();
    const ecsLights = new Map<number, THREE.Light>();

    frame(sync, world, scene, ecsLights, state);
    expect(renderer.calls[0]).toHaveLength(1);

    held.set(Light, { ...held.get(Light)!, renderingLayerMask: 0b01 });
    frame(sync, world, scene, ecsLights, state);

    expect(renderer.calls[1]).toHaveLength(2);
    expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material).toBeDefined();
  });
});

describe('a re-imported base (#318)', () => {
  it('re-derives the variant from the successor instead of the retired instance', async () => {
    // THE DEFECT: `syncMaterial` skips its per-frame re-bind for a masked entity (so it does not
    // fight the variant), which means nothing ever hands that mesh the re-imported material.
    // `applyLightMask` then recovers the base from the bound variant's `userData` — the RETIRED
    // instance — and re-derives under the unchanged `${uuid}|${sel}` key. Left alone the mesh
    // shows the pre-reimport bytes for the rest of the session.
    const { world, traits, Light, sync, variants, scene, materialFor, successors } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();
    // ONE lights map for every frame. A fresh one rebuilds the THREE.Lights, and the variant key
    // is the light IDENTITIES (see `lightId`) — so a per-frame map changes the key on its own and
    // would make this test pass for the wrong reason.
    const ecsLights = new Map<number, THREE.Light>();

    frame(sync, world, scene, ecsLights, state);
    const oldBase = materialFor('mat');
    const meshOf = () => state.ecsObjects.get(e.id()) as THREE.Mesh;
    const staleVariant = meshOf().material as THREE.Material;
    expect(staleVariant).not.toBe(oldBase);
    expect(variants.getLightMaskStats().variants).toBe(1);

    // Frames while the refetch is still in flight: no successor yet, so the mesh keeps the
    // variant it has. Rendering the old bytes beats rendering nothing, and the retired base is
    // held alive by the sweep meanwhile.
    frame(sync, world, scene, ecsLights, state);
    expect(meshOf().material).toBe(staleVariant);

    // The refetch lands.
    const newBase = new THREE.MeshStandardMaterial();
    successors.set(oldBase, newBase);
    frame(sync, world, scene, ecsLights, state);

    const fresh = meshOf().material as THREE.Material;
    expect(fresh, 'the mesh must move off the variant of the dead base').not.toBe(staleVariant);
    expect(variants.baseOf(fresh), 'and onto one derived from the successor').toBe(newBase);
    // The stale entry is evicted, not merely shadowed — one variant, not two.
    expect(variants.getLightMaskStats().variants).toBe(1);
  });

  it('settles — it does not re-derive a new variant every frame once refreshed', async () => {
    // `refreshedMaterial` keeps answering for as long as the old base is retired, so the guard
    // that matters is that `retireVariantsOf` is idempotent and the second frame is a no-op.
    const { world, traits, Light, sync, variants, scene, materialFor, successors } = await setup();
    const { Transform, Renderable3D } = traits;
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(), Renderable3D({ mesh: 'm', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();
    const ecsLights = new Map<number, THREE.Light>();
    frame(sync, world, scene, ecsLights, state);

    successors.set(materialFor('mat'), new THREE.MeshStandardMaterial());
    frame(sync, world, scene, ecsLights, state);
    const settled = (state.ecsObjects.get(e.id()) as THREE.Mesh).material;
    frame(sync, world, scene, ecsLights, state);
    frame(sync, world, scene, ecsLights, state);

    expect((state.ecsObjects.get(e.id()) as THREE.Mesh).material).toBe(settled);
    expect(variants.getLightMaskStats().variants).toBe(1);
  });
});
