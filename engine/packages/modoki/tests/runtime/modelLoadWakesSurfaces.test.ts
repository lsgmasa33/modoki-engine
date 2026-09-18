/** QA-ASSET-0008 / #1363 — a re-import of a model the CURRENT scene renders evicts its live meshes
 *  and then rebuilds nothing until some UNRELATED interaction forces a frame, because every 3D
 *  surface renders on demand. The redraw is armed on two edges, and the LOAD edge is the one that
 *  keeps getting forgotten: a GLB re-fetch+re-parse routinely outlasts the dirty gate's ~1 s grace,
 *  so arming on invalidation alone still leaves the object gone.
 *
 *  ⚠️ **This used to pin a PRIVATE channel** (`modelLoadNotify.ts`'s `onModelTemplatesLoaded`),
 *  which SceneView subscribed to and nothing else ever did — so the fix covered one render-on-demand
 *  surface of two and the stopped GameView stayed empty (#1363, observed on `games/alien-animal`:
 *  0 meshes and 0 submitted frames indefinitely, while the refilled model sat unused in the cache).
 *  The channel is gone; both model caches now call the SHARED `fireDirtyListeners()` that every
 *  other async refill already used. So this file subscribes through `addDirtyListener` — the same
 *  registry `Scene3D`, `Scene2D`, `SceneView`, `uiTreeStore` and `canvas2DDirty` all use — because
 *  reaching THAT registry is the whole of the fix. The RIGGED cache fires the same edge and is
 *  pinned in riggedModelCache.test.ts, which already mocks a real loader. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { setMeshoptDecoder(_d: unknown) {} load() {} },
}));

import { loadModelTemplates, getMeshTemplate, invalidateModel, acquireMesh, getMeshAsset } from '../../src/runtime/loaders/meshTemplateCache';
import { addDirtyListener } from '../../src/runtime/core/renderDirty';
import { offerParsedGltf } from '../../src/runtime/loaders/parsedGltfHandoff';

/** A one-mesh GLB, handed straight to the cache so no loader/network is involved. */
function offer(path: string, meshName: string) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = meshName;
  mesh.userData.name = meshName; // deriveTemplateName keys off the GLB's authored node name
  scene.add(mesh);
  offerParsedGltf(path, { scene } as never);
}

describe('the model load edge wakes every idle-gated surface (#1363)', () => {
  // `invalidateModel` itself fires the shared wake (through emitAssetInvalidated), which is the
  // EVICT edge and was never the broken one. Doing it here, before any listener is registered,
  // keeps these assertions about the LOAD edge alone.
  beforeEach(() => { invalidateModel('/m/ship.glb'); });

  it('fires the shared dirty signal once its templates are in the cache', async () => {
    const seenTemplateAtFireTime: Array<boolean> = [];
    // Read the cache FROM INSIDE the listener: a redraw armed before the cache is populated would
    // draw the same empty frame and settle again, which is the bug this ordering prevents. An
    // assertion made after `await` could not tell the two orderings apart.
    const off = addDirtyListener(() => { seenTemplateAtFireTime.push(!!getMeshTemplate('/m/ship.glb::Hull')); });
    offer('/m/ship.glb', 'Hull');
    await loadModelTemplates('/m/ship.glb');
    off();

    expect(seenTemplateAtFireTime.length).toBeGreaterThan(0);
    // ⚠️ The FIRST fire, not the last — a last-wins check cannot see a premature wake ADDED
    // before the cache write while the real one still fires after it (measured: that mutation
    // left this green).
    expect(seenTemplateAtFireTime[0]).toBe(true);
    expect(getMeshTemplate('/m/ship.glb::Hull')).toBeTruthy();
  });

  // ⚠️ A "stops firing once unsubscribed" case used to sit here. It was VACUOUS for this file:
  // it registered and immediately unsubscribed, so deleting `fireDirtyListeners()` from
  // `loadModelTemplates` left it green — it exercised `addDirtyListener`'s own `Set.delete`, which
  // `renderDirty` covers itself, not the load edge this file is about. Removed rather than kept as
  // reassurance (close-out review).

  it('a throwing listener does not break the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    const offA = addDirtyListener(() => { throw new Error('boom'); });
    const offB = addDirtyListener(after);
    offer('/m/ship.glb', 'Hull');
    await expect(loadModelTemplates('/m/ship.glb')).resolves.toBeUndefined();
    offA(); offB();
    expect(after).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// #1368 D: a `.mesh.json` can land AFTER its GLB was already parsed by another consumer. Then
// neither upstream wake fires — `loadModelTemplates` hands back the settled promise (no parse, no
// wake) and `registerAsset` wakes only on a manifest change — so on an idle surface the mesh asset
// became readable and nothing redrew. `fetchMeshAsset` now wakes once the asset is usable.
describe('a .mesh.json landing after its GLB is already parsed still wakes (#1368 D)', () => {
  beforeEach(() => { invalidateModel('models/hull.glb'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Paths are RELATIVE on purpose: a leading-slash ref is an internal asset path, which `resolveRef`
  // rejects, so the fixture would silently never load (the sanity check below catches exactly that).
  it('fires the shared dirty signal with the mesh asset readable', async () => {
    offer('models/hull.glb', 'Hull');
    await loadModelTemplates('models/hull.glb'); // another consumer parsed it first
    const doc = JSON.stringify({ model: 'models/hull.glb', mesh: 'Hull' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => doc }) as unknown as Response));

    const seenAssetAtFireTime: boolean[] = [];
    const off = addDirtyListener(() => { seenAssetAtFireTime.push(!!getMeshAsset('models/hull.mesh.json')); });
    await acquireMesh(1, 'models/hull.mesh.json');
    off();

    expect(getMeshAsset('models/hull.mesh.json'), 'fixture sanity: the asset loaded').toBeTruthy();
    expect(seenAssetAtFireTime, 'some wake must land once the asset is readable').toContain(true);
  });
});
