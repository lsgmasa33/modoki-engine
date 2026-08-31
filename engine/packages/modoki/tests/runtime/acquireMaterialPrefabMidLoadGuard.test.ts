/**
 * Regression for #520: `acquireMaterial` and `acquirePrefab` add their sceneId owner
 * BEFORE awaiting the fetch (`fetchMaterial` / `fetchPrefab`). `releaseAllForScene` is
 * synchronous and can land inside that await — it removes the owner and drops the
 * (still in-flight) cache entry, and the resumed fetch then re-seats an OWNERLESS
 * entry in `materialCache` / `prefabCache` that nothing will ever release again
 * (`releaseAllForScene` is never called for that sceneId again).
 *
 * `acquireMesh` (:1570-ish) and `acquireModel`'s post-await guard already handle this
 * shape — see `acquireModelMidLoadGuard.test.ts`. This file pins the same guard added
 * to `acquireMaterial` and `acquirePrefab`.
 *
 * Uses a gated `fetch` mock (same pattern as scene3DSyncMaterialOwnership.test.ts) so
 * the release can be interleaved between the fetch call and its resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import {
  acquireMaterial, acquirePrefab, releaseAllForScene, getResourceStats,
  getCachedPrefab, resolveMaterial, retiredMaterials3D, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';

const MAT_GUID = '33333333-2222-4333-8444-666666666666';
const MAT_PATH = '/games/g/assets/mat/mid-load.mat.json';
const PREFAB_GUID = '44444444-2222-4333-8444-666666666666';
const PREFAB_PATH = '/games/g/assets/prefab/mid-load.prefab.json';

/** One gate per path, resolved on demand so different tests (and concurrent
 *  acquires of the SAME path) can release the SAME in-flight fetch. */
const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
function gateFor(path: string) {
  let g = gates.get(path);
  if (!g) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    g = { promise, release };
    gates.set(path, g);
  }
  return g;
}

beforeEach(() => {
  gates.clear();
  clearManifest();
  registerAsset(MAT_GUID, MAT_PATH, 'material');
  registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    await gateFor(url).promise;
    const id = url === MAT_PATH ? MAT_GUID : PREFAB_GUID;
    const body = url === MAT_PATH ? { version: 1, id, type: 'pbr' } : { version: 1, id };
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }));
});

afterEach(() => {
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('acquireMaterial — post-await release guard (#520)', () => {
  it('retires the material and drops it from materialCache when releaseAllForScene lands inside the fetch', async () => {
    expect(retiredMaterials3D().size, 'sanity — nothing retired yet').toBe(0);

    const p = acquireMaterial(1, MAT_GUID);
    await Promise.resolve(); // let acquireMaterial reach the fetch/gate
    releaseAllForScene(1); // lands inside the load, before the owner is consumed
    gateFor(MAT_PATH).release();
    await p;

    // Ownerless: not counted in the refcount map.
    expect(getResourceStats().materials[MAT_PATH]).toBeUndefined();
    // And RETIRED (#317's rule), not left live+ownerless in materialCache — deliberately
    // checked without calling resolveMaterial(), which would itself kick off a fresh
    // (unawaited, dangling) fetch now that the cache entry is gone.
    expect(retiredMaterials3D().size, 'the re-seated instance must be retired, not orphaned').toBe(1);
  });

  it('keeps the material when a second live scene shares the in-flight load', async () => {
    const p1 = acquireMaterial(1, MAT_GUID);
    const p2 = acquireMaterial(2, MAT_GUID); // shares the in-flight fetch (fetchMaterial dedupes)
    await Promise.resolve();
    releaseAllForScene(1);
    gateFor(MAT_PATH).release();
    await Promise.all([p1, p2]);

    expect(getResourceStats().materials[MAT_PATH]).toBe(1);
    const resolved = resolveMaterial(MAT_GUID);
    expect(resolved, 'scene 2 still owns it — must resolve to a live material').toBeTruthy();
    expect(retiredMaterials3D().has(resolved!), 'must not be retired while scene 2 owns it').toBe(false);
  });
});

describe('acquirePrefab — post-await release guard (#520)', () => {
  it('drops the prefab from prefabCache when releaseAllForScene lands inside the fetch', async () => {
    const p = acquirePrefab(1, PREFAB_GUID);
    await Promise.resolve();
    releaseAllForScene(1);
    gateFor(PREFAB_PATH).release();
    await p;

    expect(getResourceStats().prefabs[PREFAB_PATH]).toBeUndefined();
    expect(getCachedPrefab(PREFAB_GUID)).toBeUndefined();
  });

  it('keeps the prefab when a second live scene shares the in-flight load', async () => {
    const p1 = acquirePrefab(1, PREFAB_GUID);
    const p2 = acquirePrefab(2, PREFAB_GUID); // shares the in-flight fetch (fetchPrefab dedupes)
    await Promise.resolve();
    releaseAllForScene(1);
    gateFor(PREFAB_PATH).release();
    await Promise.all([p1, p2]);

    expect(getResourceStats().prefabs[PREFAB_PATH]).toBe(1);
    expect(getCachedPrefab(PREFAB_GUID), 'scene 2 still owns it — must still be cached').toBeTruthy();
  });
});
