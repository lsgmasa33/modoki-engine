/** Regression test for the `getLoader()` unconfigured-loader race (riggedModelCache.ts).
 *
 *  Since #254 the shared GLTFLoader is built in two awaited steps:
 *    1. `await makeGltfLoader()`      — constructs the loader + wires the meshopt decoder
 *    2. `loader.setKTX2Loader(await getKTX2Loader())` — wires the KTX2 transcoder
 *
 *  Before #254 `getLoader()` was synchronous (both halves were synchronous setup), so there
 *  was no window between "the loader exists" and "the loader is fully configured" — a second
 *  caller could never observe a half-built loader. Making the function ASYNC opened exactly
 *  that window: the BUGGY shape memoised the LOADER itself —
 *
 *    if (!_gltfLoader) {
 *      _gltfLoader = await makeGltfLoader();
 *      _gltfLoader.setKTX2Loader(await getKTX2Loader());   // <-- caller can park HERE
 *    }
 *    return _gltfLoader;
 *
 *  — so a caller B that entered while caller A was parked on the `getKTX2Loader()` await saw
 *  `_gltfLoader` already truthy (assigned on the line above) and returned it immediately,
 *  BEFORE `setKTX2Loader` ran. B then calls `.load()` on an unconfigured loader; an optimized
 *  `.processed.glb` carrying KTX2 textures (KHR_texture_basisu) throws "setKTX2Loader must be
 *  called before loading KTX2 textures". Concurrent rigged acquires within one scene load
 *  (multiple SkinnedModel entities resolving in the same frame) are the normal case, not a
 *  corner — so this is not a hypothetical race.
 *
 *  The FIX memoises the PROMISE instead: `return (_gltfLoader ??= (async () => { ... })());`
 *  Every caller awaits the SAME in-flight setup, so nobody can observe the loader before
 *  `setKTX2Loader` has run on it, and there is still exactly one loader + one import.
 *
 *  This test pins that fix by forcing the race deterministically: a `vi.mock` factory for
 *  KTX2Loader.js is gated behind a manually-resolved promise, so two concurrent
 *  `acquireRiggedModel` calls can be interleaved exactly at the point that used to be unsafe —
 *  caller A parked mid-setup while caller B enters `getLoader()` — with no reliance on timing.
 *  Two DIFFERENT model refs are used because `fetchRiggedModel` dedupes same-path loads via its
 *  own `loadPromises` map, which would never reach `getLoader()` a second time. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));

// Deferred gate for the KTX2Loader.js module import: nothing that awaits `ktx2LoaderCtor()`
// (i.e. `getKTX2Loader()`, i.e. the second half of `getLoader()`'s setup) can resolve until the
// test explicitly opens it. This is what makes the interleave deterministic — caller A always
// parks exactly here, and the test controls exactly when it wakes up.
const ktx2Gate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
});
vi.mock('three/examples/jsm/loaders/KTX2Loader.js', async () => {
  await ktx2Gate.promise;
  return {
    KTX2Loader: class {
      setTranscoderPath(_p: string) {}
    },
  };
});

// Tracks every constructed GLTFLoader instance and, for every `.load()` call, whether
// `setKTX2Loader` had already run on THAT instance by the time `.load()` fired.
const gltfState = vi.hoisted(() => ({
  instanceCount: 0,
  loads: [] as { instanceId: number; ktx2SetBeforeLoad: boolean }[],
}));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    instanceId: number;
    ktx2Set = false;
    constructor() {
      this.instanceId = ++gltfState.instanceCount;
    }
    setMeshoptDecoder(_d: unknown) {}
    setKTX2Loader(_k: unknown) {
      this.ktx2Set = true;
    }
    load(_path: string, onLoad: (gltf: unknown) => void) {
      gltfState.loads.push({ instanceId: this.instanceId, ktx2SetBeforeLoad: this.ktx2Set });
      // Minimal gltf shape — traverse() is called by fetchRiggedModel to strip lights/cameras.
      setTimeout(() => onLoad({ scene: { traverse(_cb: (o: unknown) => void) {} }, animations: [] }), 0);
    }
  },
}));

// Two distinct refs → two distinct paths, so both acquires reach fetchRiggedModel's
// loadPromises miss and both call getLoader().
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  resolveRef: (ref: string) => (ref ? `/models/${ref}` : undefined),
  isGuid: () => false,
  isInternalAssetPath: (ref: string) => ref.startsWith('/'),
  getAssetEntry: () => undefined,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (path: string) => path,
  withCacheBust: (url: string) => url,
}));

import { acquireRiggedModel, disposeAllRiggedModels } from '../../src/runtime/loaders/riggedModelCache';
import { markKtx2CapsReady } from '../../src/runtime/core/activeRenderer';
import { flushLoaderImport } from '../helpers/flushLoaderImport';

const REF_A = 'alien.glb';
const REF_B = 'other.glb';

beforeEach(() => {
  disposeAllRiggedModels();
  gltfState.instanceCount = 0;
  gltfState.loads = [];
  // Bypass ensureKtx2Caps' viewport wait entirely — this test is about getLoader()'s internal
  // ordering, not about caps-probe timing. Marking caps ready makes `ensureKtx2Caps().then(getLoader)`
  // resolve to `getLoader()` on the very next microtask, which is what we need to land the race.
  markKtx2CapsReady('viewport');
});

describe('riggedModelCache getLoader() init ordering', () => {
  it('never lets a concurrent acquire observe the loader before setKTX2Loader has run', async () => {
    // Caller A: starts the setup and parks on `await getKTX2Loader()` (the KTX2Loader.js import
    // is gated shut).
    const pA = acquireRiggedModel(1, REF_A);
    await flushLoaderImport(); // let A reach makeGltfLoader() -> assign/park -> ensures A is mid-setup

    // Caller B: enters getLoader() while A is still parked. On the buggy (loader-memoised)
    // shape this would see the loader already assigned and return it — unconfigured — letting
    // B's `.load()` fire before setKTX2Loader ever runs. On the fixed (promise-memoised) shape
    // B awaits the SAME in-flight setup and cannot proceed until it completes.
    const pB = acquireRiggedModel(2, REF_B);
    await flushLoaderImport();

    // Now let the gated KTX2Loader.js import (and therefore the rest of getLoader()'s setup)
    // resolve, and let both acquires finish.
    ktx2Gate.resolve();
    await Promise.all([pA, pB]);

    expect(gltfState.loads.length).toBe(2);
    for (const load of gltfState.loads) {
      expect(load.ktx2SetBeforeLoad).toBe(true);
    }
    // The memo still holds: exactly one GLTFLoader was ever constructed, and both loads ran on it.
    expect(gltfState.instanceCount).toBe(1);
    expect(new Set(gltfState.loads.map((l) => l.instanceId)).size).toBe(1);
  });
});
