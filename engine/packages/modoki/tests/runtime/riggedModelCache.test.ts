/** riggedModelCache tests — load, clip listing, scene-scoped refcount, disposal.
 *
 *  Mocks the GLTFLoader (returns a scene + named clips) and the asset manifest
 *  (ref → path) so the cache can be exercised without real GLB binary data. */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

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
const cfg = vi.hoisted(() => ({ dropPlane: false, failVariant: false }));
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
  getRiggedModel, getClipNames, getBoneNames, disposeAllRiggedModels, invalidateRiggedModel,
} from '../../src/runtime/loaders/riggedModelCache';
import {
  offerParsedGltf, hasPendingGltf, clearParsedGltfHandoff,
} from '../../src/runtime/loaders/parsedGltfHandoff';
import { setActiveRenderer, getKTX2Loader } from '../../src/runtime/loaders/textureResolver';

const REF = 'alien.glb';
const PATH = '/models/alien.glb';

// fetchRiggedModel now gates its GLTFLoader.load on `rendererReady` (an optimized
// rigged GLB carries embedded KTX2, decoded by the shared KTX2Loader, which needs
// setActiveRenderer's detectSupport first — the Android renderer-init race fix).
// Prime that ready state once so the load-path tests here don't hang waiting for a
// renderer. Stub detectSupport so a {} renderer doesn't warn.
beforeAll(() => {
  const detect = vi.spyOn(getKTX2Loader(), 'detectSupport').mockImplementation(function (this: { workerConfig?: { astcSupported?: boolean } }) {
    this.workerConfig = { astcSupported: false }; return this as never;
  });
  setActiveRenderer({} as never);
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
  planeHolder.mesh = undefined;
  bodyHolder.mesh = undefined;
});

describe('riggedModelCache', () => {
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
    await new Promise((r) => setTimeout(r, 5));
    expect(getRiggedModel(REF)).toBeDefined();
    // A real scene release must NOT evict a lazily-held model.
    releaseRiggedModelsForScene(1);
    expect(getRiggedModel(REF)).toBeDefined();
    // Full teardown clears it.
    disposeAllRiggedModels();
    expect(getRiggedModel(REF)).toBeUndefined();
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
      vi.stubEnv('PROD', 'true');
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
