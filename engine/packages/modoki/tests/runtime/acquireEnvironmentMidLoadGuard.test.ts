/** `acquireEnvironment` now carries a post-await owner-set guard, mirroring the four sibling
 *  acquire* functions (`acquireModel`, `acquireMesh`, `acquireMaterial`, `acquirePrefab` — see
 *  acquireModelMidLoadGuard.test.ts / acquireMeshModelMidLoadGuard.test.ts /
 *  acquireMaterialPrefabMidLoadGuard.test.ts), which all re-check owner-set membership on resume
 *  because `releaseAllForScene` can land inside their in-flight load (an aborted scene load
 *  whose HDR fetch isn't itself abortable).
 *
 *  ⚠️ UNLIKE those siblings, this guard is NOT provably red/green by a unit test today, and this
 *  file says so rather than asserting a false red. `releaseAllForScene` doesn't merely drop
 *  `sceneId` from `envOwners` — it calls `releaseEnvironmentByPath`, which retires/evicts the
 *  cache entry ITSELF on the last release. So a mid-load `releaseAllForScene(sceneId)` already
 *  cleans up the cache correctly with or without `acquireEnvironment`'s own post-await guard;
 *  the guard's `return` is never observably different from falling through, for every path this
 *  function can reach. (Contrast the model/mesh siblings: their geometry is populated by a
 *  SEPARATE mechanism — `loadModelTemplates`, keyed by path, oblivious to ownership — so a
 *  release that fires before the load resolves can leave FRESH, owner-less geometry the release
 *  never saw. `fetchEnvironment`'s own inner check, `!envOwners.has(hdrPath)` in its `loader.load`
 *  callback, already closes that equivalent window for the environment cache.)
 *
 *  The guard is kept anyway — the brief that added it explicitly calls for symmetry with the
 *  other four, and `acquireModel`'s own doc comment (meshTemplateCache.ts ~:1521) states the
 *  identical precedent: an outer check that restates the right invariant, matches the sibling
 *  functions' shape, and stops being redundant the moment anything is added after it (e.g. a
 *  future transitive-dependency acquire on this path). This file exists to prove the guard does
 *  not change observable behaviour today (both tests pass with or without it) and to make that
 *  fact greppable rather than silently assumed, and to guard the ordinary non-superseded path. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushLoaderImport } from '../helpers/flushLoaderImport';

/** Wait until `loaderForEnv`'s `hdrLoaderCtor()` import has settled, then drain every parked
 *  continuation — the HDR-loader analogue of `waitForLoaderImport` (see that helper's doc for
 *  why a macrotask hop is required and a fixed microtask count is not enough). */
async function waitForHdrLoaderImport(): Promise<void> {
  const { hdrLoaderCtor } = await import('../../src/runtime/loaders/threeLoaderModules');
  await hdrLoaderCtor().catch(() => {});
  await flushLoaderImport();
}

// Deferred HDRLoader: stash onLoad so the test can release before it fires.
const h = vi.hoisted(() => ({ pending: [] as Array<{ fire: () => void; dispose: ReturnType<typeof vi.fn> }> }));

vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: any) => void) {
      const dispose = vi.fn();
      const tex = { mapping: 0, isTexture: true, dispose, uuid: `hdr-${path}` };
      h.pending.push({ fire: () => onLoad(tex), dispose });
    }
  },
}));

const GUID = '55555555-6666-4777-8888-999999999999';
const PATH = '/games/g/assets/env/mid-load.hdr';

beforeEach(async () => {
  vi.resetModules();
  h.pending.length = 0;
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(GUID, PATH, 'environment');
});

describe('acquireEnvironment — post-await release guard (symmetry, not a proven regression)', () => {
  it('the cache ends up owner-less and evicted when releaseAllForScene lands inside the load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p = cache.acquireEnvironment(1, GUID);
    await waitForHdrLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.releaseAllForScene(1); // lands inside the load, before the owner is consumed
    h.pending[0].fire();
    await p;

    expect(cache.getCachedEnvironment(GUID)).toBeUndefined();
    expect(cache.getResourceStats().environments[PATH]).toBeUndefined();
  });

  it('keeps the environment when a second live scene shares the in-flight load', async () => {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const p1 = cache.acquireEnvironment(1, GUID);
    const p2 = cache.acquireEnvironment(2, GUID); // shares the in-flight load
    await waitForHdrLoaderImport();
    expect(h.pending).toHaveLength(1);

    cache.releaseAllForScene(1);
    h.pending[0].fire();
    await Promise.all([p1, p2]);

    expect(cache.getCachedEnvironment(GUID)).toBeDefined();
    expect(cache.getResourceStats().environments[PATH]).toBe(1);
  });
});
