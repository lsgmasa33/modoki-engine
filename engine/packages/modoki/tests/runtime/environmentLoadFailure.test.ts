/** #1397 — a failed HDR environment load is classified before it is remembered.
 *
 *  `syncEnvironment` asks `acquireEnvironment(-1, …)` every frame while the env cache misses, and
 *  `fetchEnvironment` used to remember nothing about a failure — so a missing HDR was requested
 *  again every frame. A 404 (three's FileLoader `HttpError`) now stays failed until
 *  `invalidateEnvironment`; anything else backs off. Counts loader calls — the observable that
 *  separates "every frame", "backs off" and "stays failed". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushLoaderImport } from '../helpers/flushLoaderImport';

const h = vi.hoisted(() => ({
  loads: 0, failWith: null as unknown,
  // When set, the next failing load parks its onError in `settle` for the test to fire.
  defer: false, settle: null as null | (() => void),
  parked: [] as Array<() => void>,
}));

vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: unknown) => void, _p: unknown, onError: (e: unknown) => void) {
      h.loads++;
      if (h.failWith !== null) {
        const err = h.failWith;
        if (h.defer) { h.settle = () => onError(err); h.parked.push(h.settle); return; }
        onError(err);
        return;
      }
      if (h.defer) { h.parked.push(() => onLoad({ mapping: 0, isTexture: true, dispose: () => {}, uuid: `hdr-${path}` })); return; }
      onLoad({ mapping: 0, isTexture: true, dispose: () => {}, uuid: `hdr-${path}` });
    }
  },
}));

const GUID = '55555555-6666-4777-8888-aaaaaaaaaaaa';
const PATH = '/games/g/assets/env/fail.hdr';
const httpError = (status: number) => Object.assign(new Error(`responded with ${status}`), { response: { status } });

async function mods() {
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  const clock = await import('../../src/runtime/core/clock');
  const memo = await import('../../src/runtime/core/loadFailureMemo');
  return { cache, clock, memo };
}

/** Ask the way `syncEnvironment` does, once per "frame". */
async function frames(n: number): Promise<void> {
  const { cache } = await mods();
  for (let i = 0; i < n; i++) {
    const p = cache.acquireEnvironment(-1, GUID);
    await flushLoaderImport();
    await p;
  }
}

beforeEach(async () => {
  vi.resetModules();
  h.loads = 0;
  h.failWith = null;
  h.defer = false;
  h.settle = null;
  h.parked = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { cache, clock } = await mods();
  clock.setManualNow(0);
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(GUID, PATH, 'environment');
});
afterEach(async () => {
  (await mods()).clock.restoreRealClock();
  vi.restoreAllMocks();
});

describe('fetchEnvironment remembers a failed load (#1397)', () => {
  it('a 404 is requested ONCE across many frames, until invalidateEnvironment', async () => {
    const { cache, clock } = await mods();
    h.failWith = httpError(404);
    await frames(5);
    expect(h.loads).toBe(1);
    clock.advanceManual(60 * 60 * 1000);
    await frames(2);
    expect(h.loads).toBe(1);

    h.failWith = null; // the re-import fixed it
    cache.invalidateEnvironment(GUID);
    await frames(1);
    expect(h.loads).toBe(2);
    expect(cache.getCachedEnvironment(GUID)).toBeDefined();
  });

  it('a dropped connection backs off, then retries and loads', async () => {
    const { cache, clock, memo } = await mods();
    h.failWith = new TypeError('Failed to fetch');
    await frames(4);
    expect(h.loads).toBe(1);
    clock.advanceManual(memo.RETRY_BASE_MS);
    h.failWith = null;
    await frames(1);
    expect(h.loads).toBe(2);
    expect(cache.getCachedEnvironment(GUID)).toBeDefined();
  });

  it('failure memory ends with a scene release — even though the per-frame fallback owner -1 is never released', async () => {
    const { cache } = await mods();
    h.failWith = httpError(404);
    await cache.acquireEnvironment(7, GUID); // the scene's own acquire
    await frames(2);                         // then syncEnvironment's, as owner -1
    expect(h.loads).toBe(1);
    cache.releaseAllForScene(7);             // the swap: -1 still holds the path
    await frames(1);
    expect(h.loads).toBe(2);
  });

  it('a failure landing after its last owner let go is not remembered', async () => {
    const { cache } = await mods();
    h.failWith = httpError(404);
    h.defer = true;
    const p = cache.acquireEnvironment(7, GUID);
    await flushLoaderImport();
    cache.releaseAllForScene(7); // last owner gone; the load is still in flight
    h.settle!();
    await p;
    h.defer = false;
    await cache.acquireEnvironment(8, GUID); // the next scene
    expect(h.loads).toBe(2);
  });

  it('a stale load settling does not evict its replacement\'s in-flight entry', async () => {
    const { cache } = await mods();
    h.defer = true;
    const stale = cache.acquireEnvironment(7, GUID);
    await flushLoaderImport();
    cache.invalidateEnvironment(GUID);            // supersedes it; owners are kept
    const replacement = cache.acquireEnvironment(7, GUID);
    await flushLoaderImport();
    expect(h.loads).toBe(2);
    h.parked[0]();                                // the stale load settles first
    await stale;
    void cache.acquireEnvironment(-1, GUID);      // a frame while the replacement is in flight
    await flushLoaderImport();
    expect(h.loads).toBe(2);                      // was 3
    h.parked[1]();
    await replacement;
  });

  it('a transient failure wakes idle render-on-demand surfaces when its retry is due', async () => {
    const { clock, memo } = await mods();
    const { cache } = await mods();
    const { addDirtyListener } = await import('../../src/runtime/core/renderDirty');
    // Warm the lazily-imported HDR loader first: `flushLoaderImport` needs a REAL macrotask, so
    // with setTimeout faked the acquire below must need nothing but microtasks.
    const { hdrLoaderCtor } = await import('../../src/runtime/loaders/threeLoaderModules');
    await hdrLoaderCtor();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.failWith = new TypeError('Failed to fetch');
      await cache.acquireEnvironment(-1, GUID);
      expect(h.loads).toBe(1);
      const fired = vi.fn();
      const off = addDirtyListener(fired);
      await vi.advanceTimersByTimeAsync(memo.RETRY_BASE_MS - 10);
      expect(fired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(fired).toHaveBeenCalled();
      off();
    } finally {
      vi.useRealTimers();
      clock.advanceManual(0);
    }
  });
});
