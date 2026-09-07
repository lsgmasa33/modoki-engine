/** #863 — `fetchMaterial`/`invalidateMaterial` and `fetchPrefab`/`invalidatePrefab` captured
 *  `cacheToken` liveness KEYLESSLY (`cacheToken.capture()`, no key), against a generation only a
 *  FULL `disposeAllCachedResources()` ever bumped. A per-key `invalidateMaterial`/`invalidatePrefab`
 *  (an editor re-import) never touched that generation at all, so an in-flight load carrying the
 *  asset's PRE-import bytes stayed "live" across the invalidate and re-cached the stale value on
 *  top of whatever refetch followed it.
 *
 *  `loadModelTemplates`/`invalidateModel`'s equivalent race (plus the two module-wide shared
 *  behaviours — cross-key isolation and full-teardown supersession, both proven once against the
 *  same shared `cacheToken` this file also exercises) is covered by `meshTemplateGenGuard.test.ts`.
 *  `fetchEnvironment`/`invalidateEnvironment`'s is `environmentInvalidateKeyRace.test.ts` (needs a
 *  `vi.resetModules()` + dynamic-import harness for the HDRLoader mock, so it doesn't share this
 *  file). `riggedModelCache`'s own token is covered in `riggedModelCache.test.ts`.
 *
 *  Each test below races TWO loads of the SAME key against ONE `invalidate*` call landing between
 *  them, with the STALE (first) load resolving LAST — the exact production shape (a re-import
 *  replaces the file while the old parse is still in flight; nothing guarantees the fresh refetch
 *  wins the race). Without the fix, the stale load's `stillLive()` never goes false on a per-key
 *  invalidate, so it unconditionally overwrites the fresh entry when it finally lands. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { completeResponse } from '../stubs/assetResponse';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { registerBuiltinMaterialTypes } from '../../src/runtime/loaders/materialPresets';
import {
  resolveMaterial, invalidateMaterial,
  acquirePrefab, invalidatePrefab, getCachedPrefab,
  disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';

const flush = () => new Promise((r) => setTimeout(r, 0));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registerBuiltinMaterialTypes();
  clearManifest();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('fetchMaterial / invalidateMaterial — per-key liveness race (#863)', () => {
  const MAT_GUID = '11111111-2222-4333-8444-aaaaaaaaaaaa';
  const MAT_PATH = '/games/g/assets/mat/race.mat.json';

  it('a stale load that FAILS must not stamp the permanent MATERIAL_FAILED sentinel over the fresh material', async () => {
    // The residual half of #863 in this same function, found by #864's close-out rather than by
    // #863's own tests: giving `fetchMaterial` a per-key capture fixed the SUCCESS write, but its
    // three `materialCache.set(matPath, MATERIAL_FAILED)` early-returns are also post-await and
    // were left unguarded. MATERIAL_FAILED is PERMANENT — `resolveMaterial` returns undefined for
    // it forever, with no retry — so a stale continuation that 404s after a successful re-import
    // does not merely lose the race, it kills that material for the rest of the session. Strictly
    // worse than the stale-bytes case this file's sibling test covers.
    registerAsset(MAT_GUID, MAT_PATH, 'material');

    // Fetch #1 — the STALE load, gated, and destined to FAIL (a 404 is the ordinary shape: the
    // file was replaced/renamed by the re-import that triggered the invalidate).
    let resolveStale: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }));
    expect(resolveMaterial(MAT_GUID)).toBeUndefined(); // kicks fetch #1

    invalidateMaterial(MAT_PATH); // per-key evict mid-flight

    // Fetch #2 — the FRESH reload, succeeds immediately.
    fetchMock.mockImplementationOnce(async () => completeResponse({
      ok: true, json: async () => ({ id: MAT_GUID, type: 'pbr', color: 0x0000ff }),
    }));
    expect(resolveMaterial(MAT_GUID)).toBeUndefined(); // kicks fetch #2
    await flush();
    expect((resolveMaterial(MAT_GUID) as { color: { getHex(): number } } | undefined)?.color.getHex(),
      'sanity — the fresh fetch must actually land before the stale one resolves').toBe(0x0000ff);

    // NOW let the stale fetch resolve, not-ok. Unguarded, its early return stamps MATERIAL_FAILED.
    resolveStale(completeResponse({ ok: false, status: 404, json: async () => ({}) }));
    await flush();

    // FAILS without the guard: resolveMaterial returns undefined forever, because the cache holds
    // the permanent failure sentinel instead of the material that loaded perfectly well.
    const after = resolveMaterial(MAT_GUID) as { color: { getHex(): number } } | undefined;
    expect(after, 'the fresh material must survive a LATE failure of the load it replaced').toBeTruthy();
    expect(after?.color.getHex()).toBe(0x0000ff);
  });

  it('a stale material resolving AFTER invalidateMaterial must not overwrite the fresh reload', async () => {
    registerAsset(MAT_GUID, MAT_PATH, 'material');

    // Fetch #1 — the STALE load. Gated so the test controls exactly when it resolves.
    let resolveStale: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }));
    expect(resolveMaterial(MAT_GUID)).toBeUndefined(); // kicks fetch #1

    invalidateMaterial(MAT_PATH); // per-key evict mid-flight — no owner/scene release involved at all

    // Fetch #2 — the FRESH reload, resolves immediately.
    fetchMock.mockImplementationOnce(async () => completeResponse({
      ok: true, json: async () => ({ id: MAT_GUID, type: 'pbr', color: 0x00ff00 }),
    }));
    expect(resolveMaterial(MAT_GUID)).toBeUndefined(); // kicks fetch #2 — cache+promise cleared by invalidate
    await flush();

    const fresh = resolveMaterial(MAT_GUID) as { color: { getHex(): number } } | undefined;
    expect(fresh?.color.getHex(), 'sanity — the fresh fetch must actually land').toBe(0x00ff00);

    // NOW the stale (pre-invalidation) bytes resolve.
    resolveStale(await completeResponse({
      ok: true, json: async () => ({ id: MAT_GUID, type: 'pbr', color: 0xff0000 }),
    }));
    await flush();

    // FAILS before #863: the stale (red) material overwrites the fresh (green) one here.
    const after = resolveMaterial(MAT_GUID) as { color: { getHex(): number } } | undefined;
    expect(after?.color.getHex()).toBe(0x00ff00);
  });
});

describe('fetchPrefab / invalidatePrefab — per-key liveness race (#863)', () => {
  const PREFAB_GUID = '22222222-3333-4444-8555-bbbbbbbbbbbb';
  const PREFAB_PATH = '/games/g/assets/prefab/race.prefab.json';

  it('a stale prefab resolving AFTER invalidatePrefab must not overwrite the fresh reload', async () => {
    registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');

    // Fetch #1 — the STALE load. Gated so the test controls exactly when it resolves.
    let resolveStale: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }));
    const p1 = acquirePrefab(1, PREFAB_GUID); // kicks fetch #1
    await Promise.resolve(); // let acquirePrefab reach the fetch call

    invalidatePrefab(PREFAB_PATH); // per-key evict mid-flight — owner (sceneId 1) is left untouched

    // Fetch #2 — the FRESH reload, resolves immediately.
    fetchMock.mockImplementationOnce(async () => completeResponse({
      ok: true, json: async () => ({ id: PREFAB_GUID, entities: [], marker: 'fresh' }),
    }));
    await acquirePrefab(1, PREFAB_GUID); // re-acquire — cache+promise cleared by invalidate, so this is fetch #2

    expect((getCachedPrefab(PREFAB_GUID) as { marker?: string })?.marker, 'sanity — the fresh fetch must actually land').toBe('fresh');

    // NOW the stale (pre-invalidation) bytes resolve.
    resolveStale(await completeResponse({
      ok: true, json: async () => ({ id: PREFAB_GUID, entities: [], marker: 'stale' }),
    }));
    await p1;

    // FAILS before #863: the stale prefab overwrites the fresh one here.
    expect((getCachedPrefab(PREFAB_GUID) as { marker?: string })?.marker).toBe('fresh');
  });
});
