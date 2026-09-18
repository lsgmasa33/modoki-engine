/** riggedModelCache tests — load, clip listing, scene-scoped refcount, disposal.
 *
 *  Mocks the GLTFLoader (returns a scene + named clips) and the asset manifest
 *  (ref → path) so the cache can be exercised without real GLB binary data. */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));

const loads = vi.hoisted(() => ({ count: {} as Record<string, number>, last: '' }));
// Mutable manifest entry the assetManifest mock returns, so a test can opt into a
// derived variant (modelCache) + content hash to exercise the ?v= cache-bust.
const manifest = vi.hoisted(() => ({ entry: undefined as { modelCache?: unknown; hash?: string; postprocessor?: string } | undefined }));
// Opt-in: when cfg.dropPlane, the mock scene also yields a named "Plane" mesh, so
// a test can exercise the postprocessor filterMesh path. planeHolder exposes its
// dispose/removeFromParent spies.
// failVariant: make a `.processed.glb` URL error so the raw-source fallback (#7)
// kicks in. dropPlane: opt into the postprocessor filterMesh path.
const cfg = vi.hoisted(() => ({
  dropPlane: false, failVariant: false, holdLoad: false,
  // #1397: every load of a url this returns an error for fails with that error.
  failWith: null as null | ((path: string) => unknown),
}));
// When cfg.holdLoad, the mock does NOT auto-resolve on a 0ms timer — each load's onLoad is parked
// here so a test can settle a SPECIFIC in-flight load by hand. Without that, two loads racing on
// two 0ms timers makes any assertion about which settles first timing-dependent.
const held = vi.hoisted(() => ({ fire: [] as Array<() => void> }));
const planeHolder = vi.hoisted(() => ({ mesh: undefined as any }));
// Captures the most recently built body mesh so the released-mid-load tests (#6)
// can assert its GPU resources were disposed (the model never reaches the cache).
const bodyHolder = vi.hoisted(() => ({ mesh: undefined as any }));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder(_d: unknown) {}
    load(path: string, onLoad: (gltf: any) => void, _onProgress?: any, onError?: (err: any) => void) {
      loads.count[path] = (loads.count[path] || 0) + 1;
      loads.last = path;
      const failure = cfg.failWith?.(path);
      if (failure !== undefined) { setTimeout(() => onError?.(failure), 0); return; }
      // #7: a derived `.processed.glb` variant that 404s → onError, so the cache
      // retries the stripped raw URL (and only the raw load builds a scene).
      if (cfg.failVariant && path.endsWith('.processed.glb')) {
        setTimeout(() => onError?.(new Error('variant 404')), 0);
        return;
      }
      // removeFromParent marks the child removed so later traverse() skips it
      // (mirrors THREE's behavior the filter relies on).
      const make = (extra: any) => ({ removeFromParent: vi.fn(function (this: any) { this._removed = true; }), ...extra });
      // Stable mesh instance so traverse() yields the SAME object every call
      // (disposePrototype + the test must inspect the same dispose spies).
      const mesh = make({
        isMesh: true,
        geometry: { dispose: vi.fn() },
        material: { dispose: vi.fn(), map: { isTexture: true, dispose: vi.fn() } },
      });
      bodyHolder.mesh = mesh;
      const bone = make({ isBone: true, name: 'Head' });
      const children: any[] = [mesh, bone];
      if (cfg.dropPlane) {
        const plane = make({ isMesh: true, name: 'Plane', geometry: { dispose: vi.fn() }, material: { dispose: vi.fn() } });
        planeHolder.mesh = plane;
        children.push(plane);
      }
      const scene = { traverse: (cb: (child: any) => void) => { for (const c of children) if (!c._removed) cb(c); } };
      const animations = [
        { name: 'Walk-Cycle' },
        { name: 'Run-Cycle' },
        { name: 'Idle_Aggressive' },
      ];
      if (cfg.holdLoad) { held.fire.push(() => onLoad({ scene, animations })); return; }
      setTimeout(() => onLoad({ scene, animations }), 0);
    }
  },
}));

// Postprocessor registry: 'drop-plane' filters out meshes named "Plane".
vi.mock('../../src/runtime/loaders/modelPostprocessorRegistry', () => ({
  getModelPostprocessor: (id: string) => id === 'drop-plane'
    ? { name: 'Drop Plane', fixupMesh: () => {}, filterMesh: (m: any) => m.name !== 'Plane' }
    : { name: 'None', fixupMesh: () => {} },
}));

// Manifest: a ref resolves to a path; treat everything as a non-guid path so the
// unknown-guid warning branch is skipped.
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  resolveRef: (ref: string) => (ref ? `/models/${ref}` : undefined),
  isGuid: () => false,
  isInternalAssetPath: (ref: string) => ref.startsWith('/'),
  // Defaults to undefined (refToPath falls back to resolveRef raw); a test can
  // set manifest.entry to opt into a derived variant + hash.
  getAssetEntry: () => manifest.entry,
  // Needed since this suite imports `reimportInvalidation`, which pulls in `meshTemplateCache`,
  // which transitively loads `fontAtlasLoader` — and that module SUBSCRIBES at module load
  // (`onFontInvalidated(invalidateFont)`). An explicit-list mock factory has to carry every export
  // its importers actually reach, or the import throws before a single test runs.
  onFontInvalidated: () => () => {},
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (path: string) => path,
  // Mirror the real PROD-gated, query-aware appender so the cache-bust tests below
  // exercise the actual scheme.
  withCacheBust: (url: string, hash?: string) =>
    (import.meta.env?.PROD && hash) ? url + (url.includes('?') ? '&' : '?') + 'v=' + hash : url,
}));

import {
  acquireRiggedModel, releaseRiggedModelsForScene, ensureRiggedModelLoaded,
  ensureRiggedModelLoadedFor, getRiggedOwnerCounts,
  getRiggedModel, getClipNames, getBoneNames, disposeAllRiggedModels, invalidateRiggedModel,
} from '../../src/runtime/loaders/riggedModelCache';
import { invalidateModelAndRig } from '../../src/runtime/loaders/reimportInvalidation';
import {
  offerParsedGltf, hasPendingGltf, clearParsedGltfHandoff,
} from '../../src/runtime/loaders/parsedGltfHandoff';
import { setActiveRenderer, getKTX2Loader } from '../../src/runtime/loaders/textureResolver';
import { addDirtyListener } from '../../src/runtime/core/renderDirty';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { RETRY_BASE_MS } from '../../src/runtime/core/loadFailureMemo';

const REF = 'alien.glb';
const PATH = '/models/alien.glb';

// fetchRiggedModel gates its GLTFLoader.load on `ensureKtx2Caps()` (an optimized
// rigged GLB carries embedded KTX2, decoded by the shared KTX2Loader, which needs
// GPU caps from detectSupport first — the Android renderer-init race fix). Priming
// via setActiveRenderer marks KTX2 caps ready too (a real renderer implies caps —
// see activeRenderer.ts), so the load-path tests here don't hang waiting on a probe.
// Stub detectSupport so a {} renderer doesn't warn.
beforeAll(async () => {
  const detect = vi.spyOn(await getKTX2Loader(), 'detectSupport').mockImplementation(function (this: { workerConfig?: { astcSupported?: boolean } }) {
    this.workerConfig = { astcSupported: false }; return this as never;
  });
  await setActiveRenderer({} as never);
  detect.mockRestore();
});

beforeEach(() => {
  disposeAllRiggedModels();
  clearParsedGltfHandoff();
  loads.count = {};
  loads.last = '';
  manifest.entry = undefined;
  cfg.dropPlane = false;
  cfg.failVariant = false;
  cfg.holdLoad = false;
  cfg.failWith = null;
  held.fire = [];
  planeHolder.mesh = undefined;
  bodyHolder.mesh = undefined;
});

describe('riggedModelCache', () => {
  /** QA-ASSET-0008's sibling. EVERY 3D surface renders on demand, so a re-imported model is
   *  evicted immediately and rebuilt only on a frame that runs; the dirty gate is re-armed off
   *  this shared edge because a GLB re-fetch+re-parse outlasts its ~1 s grace. The fix was first
   *  wired only into meshTemplateCache, which would have left a re-imported CHARACTER missing
   *  while every static mesh recovered — the rigged prototype lives in THIS cache, with its own
   *  loader.
   *
   *  ⚠️ The edge is the SHARED `fireDirtyListeners()` now, not the private `onModelTemplatesLoaded`
   *  channel this asserted on before (#1363 — that channel had one subscriber, so the stopped
   *  GameView never saw it). It carries no path argument, so these count fires rather than
   *  collecting paths. */
  it('fires the shared dirty edge once the prototype is cached', async () => {
    let cachedAtFireTime: boolean | null = null;
    // Read the cache from INSIDE the listener: the edge must land AFTER the cache write, never
    // before — a redraw armed ahead of it would draw the same empty frame and settle again, and
    // an assertion made after the `await` cannot tell those two orderings apart.
    // ⚠️ The FIRST fire, not the last. Recording the last one made this unfalsifiable: a mutation
    // that ADDED a premature wake before the cache write left the real one still firing after it,
    // so a last-wins capture stayed true and the test stayed green. A premature wake is exactly
    // the hazard this asserts against, so it has to be the first fire that is judged.
    const off = addDirtyListener(() => { cachedAtFireTime ??= !!getRiggedModel(REF); });
    try {
      await acquireRiggedModel(1, REF);
    } finally { off(); }
    expect(cachedAtFireTime).toBe(true);
    expect(getRiggedModel(REF)).toBeTruthy();
  });

  it('does not fire the loaded edge when the load is dropped mid-flight', async () => {
    // Released before the parse lands → the prototype is disposed and never cached, so there is
    // nothing new to draw and no redraw to arm.
    const fired = vi.fn();
    const off = addDirtyListener(fired);
    const p = acquireRiggedModel(1, REF);
    releaseRiggedModelsForScene(1);
    await p;
    off();
    expect(fired).not.toHaveBeenCalled();
    expect(getRiggedModel(REF)).toBeUndefined();
  });

  it('returns undefined / empty clips before load', () => {
    expect(getRiggedModel(REF)).toBeUndefined();
    expect(getClipNames(REF)).toEqual([]);
  });

  it('loads a model and exposes its named clips', async () => {
    await acquireRiggedModel(1, REF);
    const model = getRiggedModel(REF);
    expect(model).toBeDefined();
    expect(model!.animations).toHaveLength(3);
    expect(getClipNames(REF)).toEqual(['Walk-Cycle', 'Run-Cycle', 'Idle_Aggressive']);
  });

  it('exposes skeleton bone names (for BoneAttachment dropdown)', async () => {
    expect(getBoneNames(REF)).toEqual([]); // empty before load
    await acquireRiggedModel(1, REF);
    expect(getBoneNames(REF)).toEqual(['Head']);
  });

  it('shares one underlying load across two scene owners', async () => {
    await acquireRiggedModel(1, REF);
    await acquireRiggedModel(2, REF);
    expect(loads.count['/models/alien.glb']).toBe(1);

    // Releasing one owner keeps the model resident for the other.
    releaseRiggedModelsForScene(1);
    expect(getRiggedModel(REF)).toBeDefined();

    // Releasing the last owner disposes + evicts it.
    releaseRiggedModelsForScene(2);
    expect(getRiggedModel(REF)).toBeUndefined();
  });

  it('invalidates by a literal asset path, not only a guid (import re-import path)', async () => {
    // The import pipeline calls invalidateRiggedModel with the PATH (the guid
    // isn't read from the meta yet). It must clear the cache (and not route the
    // path through resolveRef, which rejects literal paths with a console.error).
    await acquireRiggedModel(1, REF);                  // cached under '/models/alien.glb'
    expect(getRiggedModel(REF)).toBeDefined();
    invalidateRiggedModel('/models/alien.glb');         // PATH input, as the importer passes
    expect(getRiggedModel(REF)).toBeUndefined();        // actually evicted
  });

  /** #1366 — the mechanism every re-import entry point now shares. Evicting a re-imported GLB
   *  takes TWO calls, and for a long time only the drag-in importer made both: the Assets-panel
   *  batch, the agent/MCP `invalidate-assets` op and the Model Inspector's own Re-import button
   *  each called `invalidateModel` alone, so a re-imported SKINNED GLB kept its pre-import
   *  skeleton, bind pose and clips for the session — while its live clones WERE rebuilt, from
   *  that stale prototype, so the viewport re-seated the mesh and the re-import looked fine.
   *
   *  `invalidateModelAndRig` is what all four call now. This asserts the rigged half specifically:
   *  the static half is `invalidateModel`'s own event, covered elsewhere. */
  it('invalidateModelAndRig evicts the rigged prototype, not just the mesh templates (#1366)', async () => {
    await acquireRiggedModel(1, REF);
    expect(getRiggedModel(REF)).toBeDefined(); // the priming took — otherwise this asserts nothing

    invalidateModelAndRig('/models/alien.glb');

    expect(getRiggedModel(REF)).toBeUndefined();
  });

  /** A stale load settling must not evict the REPLACEMENT load's in-flight entry.
   *
   *  `loadPromises` is pure in-flight dedupe, cleared on settle — but it was cleared
   *  UNCONDITIONALLY, so this sequence left the map empty while a load was still running:
   *  L1 in flight → `invalidateRiggedModel` deletes L1's entry → the next frame starts L2 under the
   *  same key → L1 settles (stale branch) and its `finally` deletes **L2's** entry. A second render
   *  surface then sees a cache miss with an empty in-flight map and starts L3, and L2 and L3 both
   *  reach `finishLoad` and both `cache.set` — orphaning one complete prototype (geometry,
   *  materials, decoded KTX2) undisposed and unreachable. `meshTemplateCache`'s twin has carried the
   *  identity check for exactly this reason; this cache did not.
   *
   *  ⚠️ Deterministic by construction: `cfg.holdLoad` parks each load's resolver so this test
   *  settles L1 BY HAND. With both loads on 0 ms timers the outcome would depend on which timer ran
   *  first, and a racy assertion here would be worse than none. */
  it('a stale load settling does not evict the replacement load in flight', async () => {
    // `fetchRiggedModel` reaches the loader through `ensureKtx2Caps().then(getLoader)`, so the mock
    // is not called synchronously — drain the microtask queue after each acquire. Safe under
    // holdLoad: nothing is on a timer, so this cannot settle a load behind our back.
    const settleQueue = () => new Promise((r) => setTimeout(r, 0));

    cfg.holdLoad = true;
    const p1 = acquireRiggedModel(1, REF);     // L1 in flight, parked
    await settleQueue();
    expect(held.fire).toHaveLength(1);

    invalidateRiggedModel(REF);                 // drops L1's entry + invalidates its liveness key
    const p2 = acquireRiggedModel(1, REF);      // L2 in flight under the same key, parked
    await settleQueue();
    expect(held.fire).toHaveLength(2);

    held.fire[0]!();                            // L1 settles STALE — must not touch L2's entry
    await p1;
    await settleQueue();

    // If L1's settle evicted L2, this third acquire finds no cache entry AND no in-flight promise,
    // so it starts a THIRD load. That extra load is the observable leak.
    const loadsBefore = held.fire.length;
    const p3 = acquireRiggedModel(1, REF);
    await settleQueue();
    expect(held.fire).toHaveLength(loadsBefore); // deduped onto L2 — no third load started

    held.fire[1]!();
    await Promise.all([p2, p3]);
    expect(getRiggedModel(REF)).toBeTruthy();
  });

  it('disposes geometry/material on last release', async () => {
    await acquireRiggedModel(1, REF);
    const model = getRiggedModel(REF)!;
    const disposed: any[] = [];
    model.prototype.traverse((c: any) => { if (c.isMesh) disposed.push(c); });
    releaseRiggedModelsForScene(1);
    // The mesh's geometry + material dispose fns were invoked.
    expect(disposed[0].geometry.dispose).toHaveBeenCalled();
    expect(disposed[0].material.dispose).toHaveBeenCalled();
  });

  it('ensureRiggedModelLoaded loads without a scene owner (editor convenience)', async () => {
    ensureRiggedModelLoaded(REF);
    // POLL, never a fixed sleep. This was `setTimeout(r, 5)`, which is a bet that the stubbed
    // loader's `setTimeout(..., 0)` resolves within 5ms of wall-clock — true on an idle machine and
    // false under load, so this test was a known spurious red in `npm run verify`. It got worse
    // when verify started running its legs CONCURRENTLY (2026-08-06): the whole point of that
    // change is to keep every core busy, which is exactly the condition this raced under. A gate
    // you have to re-run to believe is worth less than a slow one.
    await vi.waitFor(() => expect(getRiggedModel(REF)).toBeDefined());
    // A real scene release must NOT evict a lazily-held model.
    releaseRiggedModelsForScene(1);
    expect(getRiggedModel(REF)).toBeDefined();
    // Full teardown clears it.
    disposeAllRiggedModels();
    expect(getRiggedModel(REF)).toBeUndefined();
  });

  // #747 — the scene-scoped sibling of the editor's LAZY_OWNER pin. The render sync
  // uses this one; a scene's own release must actually reach it (unlike LAZY_OWNER,
  // which no release can ever remove).
  describe('ensureRiggedModelLoadedFor (scene-scoped lazy acquire, #747)', () => {
    it('registers scene ownership, and the scene release actually reaches it', async () => {
      ensureRiggedModelLoadedFor(1, REF);
      await vi.waitFor(() => expect(getRiggedModel(REF)).toBeDefined());
      // Positive control FIRST: a registry that starts empty would pass the next
      // (post-release) assertion for the wrong reason.
      expect(getRiggedOwnerCounts()[PATH]).toBe(1);

      releaseRiggedModelsForScene(1);
      expect(getRiggedOwnerCounts()[PATH]).toBeUndefined();
      expect(getRiggedModel(REF)).toBeUndefined(); // disposed, not just unowned
    });

    it('does NOT change the editor pin: ensureRiggedModelLoaded still survives a scene release', async () => {
      ensureRiggedModelLoaded(REF); // the editor session pin (LAZY_OWNER)
      await vi.waitFor(() => expect(getRiggedModel(REF)).toBeDefined());
      releaseRiggedModelsForScene(1); // no scene ever held it — must be a no-op here
      expect(getRiggedModel(REF)).toBeDefined(); // still resident + cached
      disposeAllRiggedModels();
      expect(getRiggedModel(REF)).toBeUndefined(); // only full teardown reclaims it
    });

    it('an already-cached model still takes the new scene stamp', async () => {
      await acquireRiggedModel(1, REF); // cached, owned by scene 1
      ensureRiggedModelLoadedFor(2, REF); // second owner stamped on the cached model
      expect(getRiggedOwnerCounts()[PATH]).toBe(2);

      releaseRiggedModelsForScene(1); // scene 1 drops its hold
      expect(getRiggedModel(REF)).toBeDefined();  // scene 2 still holds it
      expect(getRiggedOwnerCounts()[PATH]).toBe(1);
    });
  });

  describe('postprocessor filterMesh', () => {
    it('drops a baked "Plane" mesh from the prototype (rigged mirror of static)', async () => {
      cfg.dropPlane = true;
      manifest.entry = { postprocessor: 'drop-plane' };
      await acquireRiggedModel(1, REF);
      const model = getRiggedModel(REF)!;
      const meshNames: string[] = [];
      model.prototype.traverse((c: any) => { if (c.isMesh) meshNames.push(c.name || '(body)'); });
      expect(meshNames).not.toContain('Plane');     // filtered out
      expect(meshNames).toContain('(body)');         // creature kept
      // The dropped mesh was detached + its GPU resources disposed.
      expect(planeHolder.mesh.removeFromParent).toHaveBeenCalled();
      expect(planeHolder.mesh.geometry.dispose).toHaveBeenCalled();
    });

    it('keeps all meshes when the model has no postprocessor', async () => {
      cfg.dropPlane = true;
      manifest.entry = { postprocessor: undefined };
      await acquireRiggedModel(1, REF);
      const model = getRiggedModel(REF)!;
      const meshNames: string[] = [];
      model.prototype.traverse((c: any) => { if (c.isMesh) meshNames.push(c.name || '(body)'); });
      expect(meshNames).toContain('Plane'); // no filter → Plane stays
    });
  });

  describe('cache-bust (?v=) via modelGlbUrl', () => {
    it('requests the .processed.glb variant with ?v=<hash> in production', async () => {
      vi.stubEnv('PROD', true);
      manifest.entry = { modelCache: {}, hash: 'cafe1234' };
      try {
        await acquireRiggedModel(1, REF);
        // A derived variant exists → load the .processed.glb URL, hash-busted.
        expect(loads.last).toBe('/models/alien.glb.processed.glb?v=cafe1234');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('omits ?v in dev even with a derived variant + hash', async () => {
      manifest.entry = { modelCache: {}, hash: 'cafe1234' };
      await acquireRiggedModel(1, REF);
      expect(loads.last).toBe('/models/alien.glb.processed.glb');
      expect(loads.last).not.toContain('?v=');
    });
  });

  // Missing Test #6 — the `gen !== generation || !owners.has(path)` branch in
  // fetchRiggedModel: a model whose load resolves AFTER its owner is gone (scene
  // released, or full teardown) must be disposed, not cached.
  describe('released-mid-load dispose (Missing Test #6)', () => {
    it('releasing the only owner before onLoad fires disposes the prototype, never caches it', async () => {
      // acquire adds the owner + starts the load (mock fires onLoad on a 0ms timer).
      const p = acquireRiggedModel(1, REF);
      // Drop the only owner BEFORE the timer fires → the !owners.has(path) branch.
      releaseRiggedModelsForScene(1);
      await p;
      expect(getRiggedModel(REF)).toBeUndefined();           // never cached
      // The just-parsed prototype's GPU resources were disposed.
      expect(bodyHolder.mesh.geometry.dispose).toHaveBeenCalled();
      expect(bodyHolder.mesh.material.dispose).toHaveBeenCalled();
    });

    it('disposeAllRiggedModels mid-load (generation bump) also discards the result', async () => {
      const p = acquireRiggedModel(1, REF);
      disposeAllRiggedModels(); // bumps generation; the in-flight load is now stale
      await p;
      expect(getRiggedModel(REF)).toBeUndefined();
      expect(bodyHolder.mesh.geometry.dispose).toHaveBeenCalled();
    });

    // #863: `invalidateRiggedModel` (a re-import) used to touch only `cache`/`loadPromises`,
    // never `liveness` — so a load carrying the PRE-import bytes that resolved AFTER the
    // per-key evict re-cached the stale prototype (owners are left intact by invalidate, so the
    // `!owners.has(path)` half of the guard alone could not catch this — only the liveness half
    // can). Distinct from the test above: that one is the FULL-teardown path
    // (`disposeAllRiggedModels`, which already bumped `liveness` wholesale); this is the PER-KEY
    // path that had no liveness check at all before #863.
    it('invalidateRiggedModel mid-load discards the stale result, not just a full teardown', async () => {
      const p = acquireRiggedModel(1, REF); // starts the load; onLoad fires on a 0ms timer
      invalidateRiggedModel(REF); // per-key evict while the load is still pending — owner untouched
      await p;
      // FAILS before #863: the stale prototype would land in `cache` here.
      expect(getRiggedModel(REF)).toBeUndefined();
      expect(bodyHolder.mesh.geometry.dispose).toHaveBeenCalled();
      expect(bodyHolder.mesh.material.dispose).toHaveBeenCalled();
    });
  });

  // F4 — the editor-import parse handoff: importModel parses the GLB once for rig
  // inspection, then offers it; fetchRiggedModel must consume that parse instead of
  // a second GLTFLoader.load. Runtime acquires (no offer) still parse normally.
  describe('import parse handoff (F4 — no second parse)', () => {
    function offerHandoff(animName: string, boneName: string) {
      const geom = { dispose: vi.fn() };
      const material = { dispose: vi.fn(), map: { isTexture: true, dispose: vi.fn() } };
      const mesh = { isMesh: true, name: 'Body', geometry: geom, material, removeFromParent: vi.fn() };
      const bone = { isBone: true, name: boneName, removeFromParent: vi.fn() };
      const scene = { traverse: (cb: (c: any) => void) => { for (const c of [mesh, bone]) cb(c); } };
      offerParsedGltf(PATH, { scene, animations: [{ name: animName }] } as any);
      return { mesh };
    }

    it('consumes an offered parse instead of calling GLTFLoader.load', async () => {
      offerHandoff('Jump', 'Hip');
      await acquireRiggedModel(1, REF);

      expect(loads.count).toEqual({});                  // GLTFLoader.load NEVER ran
      expect(getRiggedModel(REF)).toBeDefined();
      expect(getClipNames(REF)).toEqual(['Jump']);      // clips from the handoff, not the loader
      expect(getBoneNames(REF)).toEqual(['Hip']);
      expect(hasPendingGltf(PATH)).toBe(false);         // single-use, consumed
    });

    it('falls back to GLTFLoader.load when nothing is offered (runtime path)', async () => {
      await acquireRiggedModel(1, REF);
      expect(loads.count[PATH]).toBe(1);
      expect(getClipNames(REF)).toEqual(['Walk-Cycle', 'Run-Cycle', 'Idle_Aggressive']);
    });

    it('ensureRiggedModelLoaded disposes an offer it cannot use (already cached)', async () => {
      await acquireRiggedModel(1, REF);                 // model now cached
      const { mesh } = offerHandoff('Stale', 'Spine');
      ensureRiggedModelLoaded(REF);                     // cache.has → drops the offer
      expect(hasPendingGltf(PATH)).toBe(false);
      expect(mesh.geometry.dispose).toHaveBeenCalled(); // un-taken parse freed, not leaked
    });
  });

  // Missing Test #7 — rawFallbackOf + the tryLoad(i+1) fallback: when the derived
  // `.processed.glb` variant fails (e.g. served from a different URL context than
  // it was imported in), the cache retries the stripped raw source so the model
  // still renders (unoptimized) instead of going invisible.
  describe('raw-source fallback (Missing Test #7)', () => {
    it('falls back to the raw URL when the .processed.glb variant errors', async () => {
      cfg.failVariant = true;              // the derived variant load errors
      manifest.entry = { modelCache: {} }; // → refToPath returns base + .processed.glb
      await acquireRiggedModel(1, REF);
      // The variant 404'd; the raw fallback loaded + cached the model.
      expect(getRiggedModel(REF)).toBeDefined();
      expect(loads.last).toBe('/models/alien.glb'); // raw URL, suffix stripped
      // Both candidates were attempted (variant first, then raw).
      expect(loads.count['/models/alien.glb.processed.glb']).toBe(1);
      expect(loads.count['/models/alien.glb']).toBe(1);
      // Cache is keyed under the original (variant) path; getRiggedModel(REF) resolves it.
      expect(getClipNames(REF)).toEqual(['Walk-Cycle', 'Run-Cycle', 'Idle_Aggressive']);
    });
  });
});

/** #1397 — a failed rig load is remembered, classified. The render sync calls
 *  `ensureRiggedModelLoadedFor` every frame, so before this a missing rig was requested again every
 *  frame — two GLB requests per lap (variant, then raw). */
describe('riggedModelCache — a failed load is classified before it is remembered (#1397)', () => {
  const VARIANT = '/models/alien.glb.processed.glb';
  const httpError = (status: number) => Object.assign(new Error(`responded with ${status}`), { response: { status } });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  /** Ask the way the render sync does: once per "frame", letting each lap settle. */
  const frames = async (n: number) => { for (let i = 0; i < n; i++) { ensureRiggedModelLoadedFor(1, REF); await settle(); } };

  beforeEach(() => {
    setManualNow(0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    manifest.entry = { modelCache: {} }; // two candidates: the variant, then the raw source
  });
  afterEach(() => { restoreRealClock(); vi.restoreAllMocks(); });

  it('a 404 on both candidates is requested ONCE across many frames, until invalidateRiggedModel', async () => {
    cfg.failWith = () => httpError(404);
    await frames(5);
    expect(loads.count[VARIANT]).toBe(1);
    expect(loads.count[PATH]).toBe(1);
    advanceManual(60 * 60 * 1000); // however long the session runs
    await frames(2);
    expect(loads.count[PATH]).toBe(1);

    cfg.failWith = null; // the re-import fixed the file
    invalidateRiggedModel(REF);
    await frames(1);
    expect(loads.count[PATH]).toBe(1); // the variant now loads — no fallback lap needed
    expect(loads.count[VARIANT]).toBe(2);
    expect(getRiggedModel(REF)).toBeDefined();
  });

  it('a dropped connection backs off, then retries and loads (was: a request every frame)', async () => {
    cfg.failWith = () => new TypeError('Failed to fetch');
    await frames(4);
    expect(loads.count[VARIANT]).toBe(1);
    advanceManual(RETRY_BASE_MS);
    cfg.failWith = null;
    await frames(1);
    expect(loads.count[VARIANT]).toBe(2);
    expect(getRiggedModel(REF)).toBeDefined();
  });

  it('a variant the server could not serve is TRANSIENT even when the raw fallback 404s — the variant may yet load', async () => {
    // The LAST error is a permanent 404, so recording only it would stick for the session.
    cfg.failWith = (path) => (path === VARIANT ? httpError(503) : httpError(404));
    await frames(3);
    expect(loads.count[PATH]).toBe(1);
    advanceManual(RETRY_BASE_MS);
    await frames(1);
    expect(loads.count[PATH]).toBe(2);
  });

  it('a failure landing after its last owner let go is not remembered', async () => {
    cfg.failWith = () => httpError(404);
    ensureRiggedModelLoadedFor(1, REF);  // in flight — the error fires on a 0 ms timer
    releaseRiggedModelsForScene(1);      // the scene goes before it lands
    await settle(); await settle();
    ensureRiggedModelLoadedFor(2, REF);  // the next scene
    await settle(); await settle();
    expect(loads.count[PATH]).toBe(2);
  });

  it('a transient failure wakes idle render-on-demand surfaces when its retry is due', async () => {
    cfg.failWith = () => new TypeError('Failed to fetch');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      ensureRiggedModelLoadedFor(1, REF);
      await vi.advanceTimersByTimeAsync(5); // both candidates fail
      const fired = vi.fn();
      const off = addDirtyListener(fired);
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 20);
      expect(fired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(fired).toHaveBeenCalled();
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('failure memory is scene-scoped: the last owner letting go forgets a permanent failure', async () => {
    cfg.failWith = () => httpError(404);
    await frames(1);
    releaseRiggedModelsForScene(1);
    await frames(1);
    expect(loads.count[PATH]).toBe(2);
  });
});
