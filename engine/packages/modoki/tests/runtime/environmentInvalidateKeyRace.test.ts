/** #863 — `fetchEnvironment`/`invalidateEnvironment` captured `cacheToken` liveness KEYLESSLY
 *  (`cacheToken.capture()`, no key), against a generation only a FULL `disposeAllCachedResources()`
 *  ever bumped. A per-key `invalidateEnvironment` (an editor HDR re-import) never touched that
 *  generation at all, so an in-flight HDR load carrying the PRE-import bytes stayed "live" across
 *  the invalidate and re-cached the stale texture on top of whatever refetch followed it.
 *
 *  ⚠️ This is a DIFFERENT axis from `environmentInvalidationRetires.test.ts`'s existing
 *  "invalidate mid-flight" coverage: that file's owners never change either, but it lets the two
 *  loads resolve in whatever order the mocked HDRLoader's `setTimeout(0)` calls happen to land in
 *  and only asserts a count ("the loser is retired"), not WHICH one wins. This file deliberately
 *  controls the order — stale resolves LAST — and asserts the cache holds the FRESH one, which is
 *  the one shape that distinguishes "per-key liveness closes the race" from "whichever texture
 *  happens to land last wins by luck".
 *
 *  Sibling of `meshTemplateCacheInvalidateKeyRace.test.ts` (material/prefab) — split into its own
 *  file because the HDRLoader mock needs the `vi.resetModules()` + dynamic-import harness that
 *  `acquireEnvironmentMidLoadGuard.test.ts` already uses, and the material/prefab tests don't. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushLoaderImport } from '../helpers/flushLoaderImport';

/** Wait until `loaderForEnv`'s `hdrLoaderCtor()` import has settled, then drain every parked
 *  continuation. Mirrors `acquireEnvironmentMidLoadGuard.test.ts`'s helper of the same name. */
async function waitForHdrLoaderImport(): Promise<void> {
  const { hdrLoaderCtor } = await import('../../src/runtime/loaders/threeLoaderModules');
  await hdrLoaderCtor().catch(() => {});
  await flushLoaderImport();
}

// Deferred HDRLoader: stash onLoad per call so the test controls resolution order explicitly.
const h = vi.hoisted(() => ({ pending: [] as Array<{ fire: (tex: unknown) => void }> }));

vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(_path: string, onLoad: (texture: unknown) => void) {
      h.pending.push({ fire: (tex: unknown) => onLoad(tex) });
    }
  },
}));

const GUID = '33333333-4444-4555-8666-cccccccccccc';
const PATH = '/games/g/assets/env/race.hdr';

beforeEach(async () => {
  vi.resetModules();
  h.pending.length = 0;
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(GUID, PATH, 'environment');
});

describe('fetchEnvironment / invalidateEnvironment — per-key liveness race (#863)', () => {
  it('a stale HDR resolving AFTER invalidateEnvironment must not overwrite the fresh reload', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');

    const p1 = cache.acquireEnvironment(1, GUID); // fetch #1 (stale) — owner (sceneId 1) stays live throughout
    await waitForHdrLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.invalidateEnvironment(PATH); // per-key evict mid-flight — NOT a scene release; owners untouched

    const p2 = cache.acquireEnvironment(1, GUID); // re-acquire — cache+promise cleared by invalidate, kicks fetch #2 (fresh)
    await waitForHdrLoaderImport();
    expect(h.pending).toHaveLength(2);

    const staleTex = { mapping: 0, isTexture: true, dispose: vi.fn(), uuid: 'stale-hdr' };
    const freshTex = { mapping: 0, isTexture: true, dispose: vi.fn(), uuid: 'fresh-hdr' };

    h.pending[1].fire(freshTex); // the fresh reload resolves first
    await p2;
    expect(cache.getCachedEnvironment(GUID)).toBe(freshTex);

    h.pending[0].fire(staleTex); // NOW the stale (pre-invalidation) bytes resolve
    await p1;

    // FAILS before #863: `envOwners.has(hdrPath)` stays true the whole time (no release ever
    // happened), and the old keyless `cacheToken.capture()` never went stale on a per-key
    // invalidate — only a full teardown ever bumped it — so the stale texture would overwrite the
    // fresh one here.
    expect(cache.getCachedEnvironment(GUID)).toBe(freshTex);
    expect(staleTex.dispose, 'the stale load must be discarded, not cached or retired').toHaveBeenCalledTimes(1);
    expect(cache.retiredEnvironments().size, 'discarded outright — never occupied a live binding to retire from').toBe(0);
  });
});
