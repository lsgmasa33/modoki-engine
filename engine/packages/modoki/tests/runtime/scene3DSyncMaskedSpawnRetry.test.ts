/** #479, a FOURTH door: an entity SPAWNED with a material ref that has not resolved yet.
 *
 *  `syncMaterial`'s own branch 1 (the main #479 fix) only helps once it actually RUNS with
 *  `ecsMaterials` unset for the id. The primitive CREATE path recorded the ref into
 *  `ecsMaterials` unconditionally on the very frame the mesh was minted — whether or not
 *  `resolveMaterial` returned anything — so `syncMaterial`, called later in that SAME callback,
 *  saw `prevMat === curMat` immediately and took the unchanged-ref `else if` from frame one. For
 *  a light-masked (or tinted/instanced) primitive that branch is SKIPPED outright, so nothing
 *  ever bound the resolved material: worse than the stale-look #479 symptom, because the mesh
 *  stays on `primitives._placeholderMaterial` (`visible: false`) — the entity is invisible.
 *
 *  Modeled on `lightMaskSync.test.ts`'s mock shape (real `syncLights` + `syncRenderables` against
 *  a live koota world, `meshTemplateCache` and `core/activeRenderer` mocked), with one addition:
 *  `resolveMaterial` here is unresolved until the test releases it, so the load-timing this
 *  defect depends on is actually exercised, not assumed. */

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

function stubRenderer() {
  const calls: THREE.Light[][] = [];
  return { calls, lighting: { createNode: (l: THREE.Light[]) => { calls.push([...l]); return { n: l.length }; } } };
}

async function setup() {
  const base = new THREE.MeshStandardMaterial();
  /** Flips once the test "releases" the load — `resolveMaterial('mat')` returns nothing before
   *  this, the real base after. */
  let loaded = false;
  const release = () => { loaded = true; };
  const renderer = stubRenderer();

  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms, deactivatedEntities, transformPropagationSystem: {},
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    resolveMeshTemplate: vi.fn(() => ({ geometry: new THREE.BoxGeometry(), material: base })),
    resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn((ref: string) => (ref === 'mat' && loaded ? base : undefined)),
    resolveMaterial: vi.fn((ref: string) => (ref === 'mat' && loaded ? base : undefined)),
    refreshedMaterial: vi.fn(() => undefined),
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
  return { world: createWorld(), traits, Light, sync, variants, scene, base, renderer, release };
}

function frame(sync: any, world: any, scene: THREE.Scene, ecsLights: Map<number, THREE.Light>, state: any) {
  sync.syncLights(world, scene, ecsLights);
  sync.syncRenderables(world, scene, state);
}

describe('a light-masked primitive spawned with an unresolved ref', () => {
  it('stays off the invisible placeholder once the load lands, and does not bind it forever', async () => {
    const { world, traits, Light, sync, variants, scene, base, release } = await setup();
    const { Transform, Renderable3DPrimitive } = traits;
    // Two disjoint masks so 0b01 sees fewer than every light — masking arms and this primitive
    // needs a VARIANT, which is exactly the path the unchanged-ref `else if` skips.
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b01 }));
    world.spawn(Transform(), Light({ lightType: 'point', renderingLayerMask: 0b10 }));
    const e = world.spawn(Transform(),
      Renderable3DPrimitive({ mesh: 'box', material: 'mat', isVisible: true, renderingLayerMask: 0b01 }));
    const state = sync.createRenderState();
    const ecsLights = new Map<number, THREE.Light>();

    // Creation frame — the ref has not resolved.
    frame(sync, world, scene, ecsLights, state);
    const mesh = state.ecsObjects.get(e.id()) as THREE.Mesh;
    expect(mesh, 'the primitive must actually be built').toBeTruthy();
    expect((mesh.material as THREE.Material & { visible: boolean }).visible,
      'still on the invisible placeholder — nothing has resolved yet').toBe(false);

    // A couple more frames, still unresolved.
    frame(sync, world, scene, ecsLights, state);
    frame(sync, world, scene, ecsLights, state);
    expect((mesh.material as THREE.Material & { visible: boolean }).visible,
      'must still be retrying, not stuck').toBe(false);

    // The load lands.
    release();
    frame(sync, world, scene, ecsLights, state);

    expect((mesh.material as THREE.Material & { visible: boolean }).visible,
      'THE DEFECT: must move OFF the invisible placeholder once the ref actually resolves').not.toBe(false);
    expect(variants.baseOf(mesh.material as THREE.Material), 'bound to a variant of the resolved base').toBe(base);

    // No flip-flop once bound.
    const bound = mesh.material;
    frame(sync, world, scene, ecsLights, state);
    frame(sync, world, scene, ecsLights, state);
    expect(mesh.material, 'stable across further frames').toBe(bound);
  });
});
