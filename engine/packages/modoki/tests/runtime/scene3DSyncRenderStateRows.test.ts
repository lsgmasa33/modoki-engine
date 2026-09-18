/** #1388 — every teardown of an `ecsObjects` object clears its per-entity rows through ONE list,
 *  `ECS_OBJECT_ROWS`. Four sites used to hand-list the maps to clear and one drifted (#1385: the
 *  GLB mesh swap kept `ecsMaterials`). Two halves:
 *
 *  - **The ledger** — every collection on a fresh `RenderState` is either in `ECS_OBJECT_ROWS`
 *    or named below as owned by another pass, so a NEW map fails here until somebody decides
 *    which it is. The site tests below read `ECS_OBJECT_ROWS`, so a name DROPPED from it is
 *    caught here, not there.
 *  - **Each site** — seed a sentinel into the rows, trigger that site's teardown, and assert no
 *    sentinel survives. A row the rebuild re-sets anyway cannot discriminate at a rebuilding site,
 *    so each test asserts only what its site can show; the evict and reap sites show all eight.
 *
 *  Fixture shape from `scene3DSyncMeshAssetEdit.test.ts` (mocked `meshTemplateCache`, real
 *  `scene3DSync` and real primitives via dynamic import). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { assertExemptionLedger } from '../helpers/exemptionLedger';

const GLB_A = '44444444-5555-4666-8777-dddddddddddd';
const GLB_B = '55555555-6666-4777-8888-eeeeeeeeeeee';
const PATHS: Record<string, string> = {
  [GLB_A]: '/assets/models/meshes/a.mesh.json',
  [GLB_B]: '/assets/models/meshes/b.mesh.json',
};
const templates = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>();

/** RenderState's collections that are NOT rows of the `ecsObjects` object, and why. */
const OWNED_ELSEWHERE = [
  { item: 'skinnedShadowFlags', reason: 'the SKINNED pass\'s shadow cache — dropped by `skinned`\'s dispose hook; an entity may carry a SkinnedModel beside a Renderable3D under the same id' },
  { item: 'skinned', reason: 'EntityTable of rigs — its own dispose hook and reap in syncSkinnedModels' },
  { item: 'billboards', reason: 'Billboard3D / SkinnedSprite2D meshes — reaped by their own active-set sweep' },
  { item: 'textMeshes', reason: 'Text3D meshes — reaped by their own active-set sweep' },
  { item: 'ownedMaterials', reason: 'keyed by MATERIAL, not entity id — each site disposes or retires what it owns' },
];

const SENTINEL = Symbol('stale row');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  templates.clear();
});

async function setup() {
  vi.doMock('../../src/three/traits/Light', () => ({ Light: {} }));
  vi.doMock('../../src/three/traits/Environment', () => ({ Environment: {} }));
  vi.doMock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
    worldTransforms: new Map(), deactivatedEntities: new Set(),
  }));
  vi.doMock('../../src/runtime/loaders/meshTemplateCache', () => ({
    registerEnvDisposeHook: vi.fn(),
    resolveMeshTemplate: vi.fn((ref: string) => templates.get(ref)),
    resolveMeshLodInfo: vi.fn(() => null),
    resolveMaterialForMesh: vi.fn(() => undefined),
    resolveMaterial: vi.fn(() => undefined),
    getCachedEnvironment: vi.fn(), acquireEnvironment: vi.fn(),
    retiredEnvironments: () => new Set(), disposeRetiredEnvironment: vi.fn(),
    retiredMaterials3D: () => new Set(), disposeRetiredMaterial: vi.fn(),
    onModelInvalidated: () => () => {},
    getMeshAsset: () => undefined,
    getTemplatesForModel: () => new Map(),
  }));
  vi.doMock('../../src/runtime/loaders/assetManifest', () => ({
    resolveRef: (r: string) => PATHS[r] ?? r, onFontInvalidated: () => () => {},
  }));
  vi.doMock('../../src/runtime/rendering/renderUtils', () => ({ isImagePath: () => false }));

  const { createWorld } = await import('koota');
  const traits = await import('../../src/runtime/traits');
  const sync = await import('../../src/runtime/rendering/scene3DSync');
  const { emitAssetInvalidated } = await import('../../src/runtime/core/assetInvalidation');
  return { world: createWorld(), traits, sync, emitAssetInvalidated };
}

type Sync = Awaited<ReturnType<typeof setup>>['sync'];
type State = ReturnType<Sync['createRenderState']>;
type RowKey = Sync['ECS_OBJECT_ROWS'][number];

/** Write a sentinel into each named row (a Set row just gets the id). */
function seed(state: State, id: number, keys: readonly RowKey[]): void {
  for (const key of keys) {
    const row = state[key] as Map<number, unknown> | Set<number>;
    if (row instanceof Set) row.add(id); else row.set(id, SENTINEL);
  }
}

/** The named rows that still hold what `seed` put there. */
function survivors(state: State, id: number, keys: readonly RowKey[]): RowKey[] {
  return keys.filter((key) => {
    const row = state[key] as Map<number, unknown> | Set<number>;
    return row instanceof Set ? row.has(id) : row.get(id) === SENTINEL;
  });
}

describe('ECS_OBJECT_ROWS ledger (#1388)', () => {
  it('classifies every collection on a fresh RenderState', async () => {
    const { sync } = await setup();
    const state = sync.createRenderState();
    const rows = new Set<string>(sync.ECS_OBJECT_ROWS);
    const collections = Object.entries(state)
      .filter(([, v]) => v instanceof Map || v instanceof Set || typeof (v as { clear?: unknown })?.clear === 'function')
      .map(([k]) => k);
    expect(sync.ECS_OBJECT_ROWS.filter((k) => !collections.includes(k)), 'ECS_OBJECT_ROWS names a field RenderState no longer has').toEqual([]);
    // Every collection outside ECS_OBJECT_ROWS must be paid for by exactly one OWNED_ELSEWHERE
    // row; a row with no field, or a field in both, fails as over-blessed.
    assertExemptionLedger({
      label: 'OWNED_ELSEWHERE in scene3DSyncRenderStateRows',
      population: collections.filter((k) => !rows.has(k)).map((k) => ({ item: k, site: `RenderState.${k}` })),
      exempt: OWNED_ELSEWHERE,
      scanned: collections.length,
      floor: 9,
      fix: 'a RenderState collection must join ECS_OBJECT_ROWS (a per-entity row of the ecsObjects '
        + 'object, cleared by forgetEcsObject) or OWNED_ELSEWHERE with the pass that owns it (#1388).',
    });
  });

  it('disposeRenderState clears every row', async () => {
    const { sync } = await setup();
    const state = sync.createRenderState();
    seed(state, 7, sync.ECS_OBJECT_ROWS.filter((k) => k !== 'ecsObjects'));
    sync.disposeRenderState(state, new THREE.Scene());
    expect(sync.ECS_OBJECT_ROWS.filter((k) => state[k].size > 0)).toEqual([]);
  });
});

describe('each teardown site clears every row (#1388)', () => {
  it('attachInvalidationListener eviction — all eight', async () => {
    const { world, traits, sync, emitAssetInvalidated } = await setup();
    templates.set(GLB_A, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(traits.Transform(), traits.Renderable3D({ mesh: GLB_A, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    const off = sync.attachInvalidationListener(state, scene);
    sync.syncRenderables(world, scene, state);
    expect(state.ecsObjects.has(e.id()), 'sanity — built').toBe(true);

    // Not ecsSprites: it holds the ref the listener matches the event's path against.
    seed(state, e.id(), sync.ECS_OBJECT_ROWS.filter((k) => k !== 'ecsObjects' && k !== 'ecsSprites'));
    emitAssetInvalidated('mesh', PATHS[GLB_A]);
    expect(sync.ECS_OBJECT_ROWS.filter((k) => state[k].has(e.id()))).toEqual([]);
    off();
  });

  it('end-of-pass reap (removeEcsObject) — all eight', async () => {
    const { world, traits, sync } = await setup();
    templates.set(GLB_A, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(traits.Transform(), traits.Renderable3D({ mesh: GLB_A, material: '', isVisible: true }));
    const id = e.id();
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);

    // Not ecsOwners: a mismatched owner would take the #868 eviction instead — also
    // removeEcsObject, but this test is about the reap.
    seed(state, id, sync.ECS_OBJECT_ROWS.filter((k) => k !== 'ecsObjects' && k !== 'ecsOwners'));
    e.destroy();
    sync.syncRenderables(world, scene, state);
    expect(sync.ECS_OBJECT_ROWS.filter((k) => state[k].has(id))).toEqual([]);
  });

  it('GLB mesh swap — the rows a GLB rebuild does not re-set', async () => {
    const { world, traits, sync } = await setup();
    templates.set(GLB_A, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    templates.set(GLB_B, { geometry: new THREE.SphereGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(traits.Transform(), traits.Renderable3D({ mesh: GLB_A, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);
    const before = state.ecsObjects.get(e.id());

    // Primitive-only rows plus ownsGeometry: a GLB build writes none of them, so only the
    // teardown can drop them. A SENTINEL in ecsMaterials/ecsShadowFlags is overwritten by the
    // rebuild whether or not the teardown cleared it, so those two are pinned by behaviour
    // instead: #1385's test in scene3DSyncMeshAssetEdit, and the shadow test below.
    const seeded: RowKey[] = ['ecsColors', 'ecsSizes', 'ownsGeometry'];
    seed(state, e.id(), seeded);
    e.set(traits.Renderable3D, { mesh: GLB_B });
    sync.syncRenderables(world, scene, state);
    expect(state.ecsObjects.get(e.id()), 'sanity — rebuilt').not.toBe(before);
    expect(survivors(state, e.id(), seeded)).toEqual([]);
  });

  it('GLB mesh swap — the rebuilt mesh gets its shadow flags re-applied', async () => {
    // A fresh THREE mesh starts unshadowed; a STALE real key (not a sentinel) reads "unchanged"
    // and `applyShadowFlags` never runs — the defect a sentinel cannot show (close-out review).
    const { world, traits, sync } = await setup();
    templates.set(GLB_A, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    templates.set(GLB_B, { geometry: new THREE.SphereGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(traits.Transform(), traits.Renderable3D({
      mesh: GLB_A, material: '', isVisible: true, castShadow: 'on', receiveShadow: true,
    }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);
    const before = state.ecsObjects.get(e.id()) as THREE.Mesh;
    expect([before.castShadow, before.receiveShadow], 'sanity — applied on first build').toEqual([true, true]);

    e.set(traits.Renderable3D, { mesh: GLB_B });
    sync.syncRenderables(world, scene, state);
    const after = state.ecsObjects.get(e.id()) as THREE.Mesh;
    expect(after, 'sanity — rebuilt').not.toBe(before);
    expect([after.castShadow, after.receiveShadow]).toEqual([true, true]);
  });

  it('GLB mesh swap — a primitive replaced by a GLB in one frame frees what the primitive owned', async () => {
    // The swap removed the object and forgot its rows without disposing, so the primitive's owned
    // geometry and default material were lost to everything — disposeRenderState walks only
    // ecsObjects, which no longer held them (#1388 close-out).
    const { world, traits, sync } = await setup();
    const { retiredDerivedMaterials } = await import('../../src/runtime/rendering/derivedMaterials');
    templates.set(GLB_A, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(traits.Transform(), traits.Renderable3DPrimitive({ mesh: 'cube', material: '' }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);
    const prim = state.ecsObjects.get(e.id()) as THREE.Mesh;
    const primMat = prim.material as THREE.Material;
    expect(state.ownsGeometry.has(e.id()) && state.ownedMaterials.has(primMat), 'sanity — the primitive owns both').toBe(true);
    const geoDispose = vi.spyOn(prim.geometry, 'dispose');

    e.remove(traits.Renderable3DPrimitive);
    e.add(traits.Renderable3D({ mesh: GLB_A, material: '', isVisible: true }));
    sync.syncRenderables(world, scene, state);
    expect(state.ecsObjects.get(e.id()), 'sanity — now the GLB').not.toBe(prim);
    expect(geoDispose, 'owned geometry disposed').toHaveBeenCalled();
    expect(state.ownedMaterials.has(primMat), 'owned material no longer held').toBe(false);
    expect(retiredDerivedMaterials().has(primMat), 'handed to the retirement sweep, not dropped').toBe(true);
  });

  it('GLB mesh swap — a material the object does NOT own is never retired', async () => {
    // An empty-ref GLB binds the module-wide `_defaultMaterial` (#1385); a set ref binds a shared
    // cached `.mat.json`. discardForRebuild must retire only what `ownedMaterials` names, or the
    // sweep disposes a material every other entity is still drawing with (close-out review).
    const { world, traits, sync } = await setup();
    const { retiredDerivedMaterials } = await import('../../src/runtime/rendering/derivedMaterials');
    templates.set(GLB_A, { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() });
    templates.set(GLB_B, { geometry: new THREE.SphereGeometry(), material: new THREE.MeshStandardMaterial() });
    const e = world.spawn(traits.Transform(), traits.Renderable3D({ mesh: GLB_A, material: '', isVisible: true }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);
    const shared = (state.ecsObjects.get(e.id()) as THREE.Mesh).material as THREE.Material;
    expect(state.ownedMaterials.has(shared), 'sanity — a GLB owns nothing').toBe(false);

    e.set(traits.Renderable3D, { mesh: GLB_B });
    sync.syncRenderables(world, scene, state);
    expect(retiredDerivedMaterials().has(shared)).toBe(false);
  });

  it('primitive rebuild — the rebuilt mesh gets its shadow flags re-applied', async () => {
    // A primitive rebuild rewrites every row it later reads, so a sentinel cannot discriminate
    // here. What CAN: a fresh THREE mesh starts with castShadow/receiveShadow false, and if the
    // teardown kept `ecsShadowFlags`, `applyShadowFlags` reads "unchanged" and never sets them.
    const { world, traits, sync } = await setup();
    const e = world.spawn(traits.Transform(), traits.Renderable3DPrimitive({
      mesh: 'cube', material: '', size: 1, castShadow: 'on', receiveShadow: true,
    }));
    const state = sync.createRenderState();
    const scene = new THREE.Scene();
    sync.syncRenderables(world, scene, state);
    const before = state.ecsObjects.get(e.id()) as THREE.Mesh;
    expect([before.castShadow, before.receiveShadow], 'sanity — applied on first build').toEqual([true, true]);

    e.set(traits.Renderable3DPrimitive, { size: 2 });
    sync.syncRenderables(world, scene, state);
    const after = state.ecsObjects.get(e.id()) as THREE.Mesh;
    expect(after, 'sanity — rebuilt').not.toBe(before);
    expect([after.castShadow, after.receiveShadow]).toEqual([true, true]);
  });
});
