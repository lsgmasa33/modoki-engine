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
 *
 * ⚠️ #863 changed HOW the material test below closes: `releaseMaterialByPath` (called by
 * `releaseAllForScene` on last release) has always called `invalidateMaterial`, and #863 gave
 * `fetchMaterial` its own PER-KEY liveness capture — so that `invalidateMaterial` call now also
 * refuses the in-flight fetch's own liveness check, and `fetchMaterial` disposes the result
 * directly (never writing it to `materialCache`) before `acquireMaterial`'s post-await guard
 * below even runs. Before #863, `fetchMaterial` could not see that mid-flight invalidate at all
 * (its capture was keyless, invalidated only by a FULL teardown), so it wrote an ownerless entry
 * that THIS function's guard then retired — see the updated assertion for the new shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
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
  // Restore here, not at the end of a test body: a spy on THREE.Material.prototype installed by a
  // test that then FAILS never reaches an in-body mockRestore, and survives into every later test
  // in this file, making their dispose counts nonsense. Observed while mutation-checking #863 in
  // the sibling materialInvalidationRetires suite.
  vi.restoreAllMocks();
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('acquireMaterial — post-await release guard (#520)', () => {
  it('discards the material outright (never cached, so nothing to retire) when releaseAllForScene invalidates it mid-fetch', async () => {
    expect(retiredMaterials3D().size, 'sanity — nothing retired yet').toBe(0);
    const disposeSpy = vi.spyOn(THREE.Material.prototype, 'dispose');

    const p = acquireMaterial(1, MAT_GUID);
    await Promise.resolve(); // let acquireMaterial reach the fetch/gate
    releaseAllForScene(1); // lands inside the load, before the owner is consumed — and (#863)
    // also invalidates the in-flight fetch's OWN per-key liveness capture via releaseMaterialByPath's invalidateMaterial call.
    gateFor(MAT_PATH).release();
    await p;

    // Ownerless: not counted in the refcount map.
    expect(getResourceStats().materials[MAT_PATH]).toBeUndefined();
    // #863: `fetchMaterial`'s own liveness guard now catches this BEFORE the material is ever
    // written to `materialCache`, so there is nothing left for `acquireMaterial`'s post-await
    // guard to retire — it is disposed directly instead (still freed, never leaked).
    expect(retiredMaterials3D().size, 'never cached — nothing to retire').toBe(0);
    expect(disposeSpy, 'the re-seated instance must still be freed, just earlier and more directly').toHaveBeenCalled();
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
