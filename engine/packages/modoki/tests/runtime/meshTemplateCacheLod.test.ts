/** LOD-aware mesh template cache lookups — `resolveMeshLodInfo` walks the
 *  parent model's `modelCache.lodPaths` to find templates per LOD level.
 *  We use only synchronous behavior here; the async fetch path is exercised
 *  by integration tests against the dev server. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

beforeEach(() => {
  vi.resetModules();
});

async function getMods() {
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  return { cache, manifest };
}

/** Seed the meshTemplateCache by reaching into its module-scope map.
 *  Tests need synchronous control over what's "loaded" since the real path
 *  goes through fetch + GLTFLoader. The cache map is named `cache` in
 *  meshTemplateCache.ts. We rebuild a minimal template { geometry, material, name }
 *  per LOD path so resolveMeshLodInfo can find all 3. */
async function seedLodTemplates(
  mod: typeof import('../../src/runtime/loaders/meshTemplateCache'),
  modelPaths: string[],
  meshName: string,
): Promise<THREE.BufferGeometry[]> {
  // Access the singleton cache map. Exposed for debug via __meshTemplateCache.
  const cacheMap: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> =
    (globalThis as { __meshTemplateCache?: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> }).__meshTemplateCache!;
  expect(cacheMap, 'meshTemplateCache must expose __meshTemplateCache in DEV').toBeDefined();
  const geometries: THREE.BufferGeometry[] = [];
  for (const p of modelPaths) {
    const g = new THREE.BufferGeometry();
    const m = new THREE.MeshStandardMaterial();
    cacheMap.set(`${p}::${meshName}`, { geometry: g, material: m, name: meshName });
    geometries.push(g);
  }
  // Also seed a fake mesh-asset cache entry so resolveMeshLodInfo finds the
  // parent model + mesh name without going through the network fetch path.
  // The internal meshAssetCache isn't exported — we reach into it via the
  // module's resolveMeshTemplate which populates it on first fetch.
  // Workaround: stub fetch so the mesh-asset cache populates from a fake JSON.
  (globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('.mesh.json')) {
      return new Response(JSON.stringify({
        version: 1, model: modelPaths[0].replace(/\.processed\.glb$/, ''),
        mesh: meshName, postprocessor: 'none',
      }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  // Trigger a synchronous resolveMeshTemplate to enqueue + await the fetch.
  mod.resolveMeshTemplate('/x/some.mesh.json');
  // Let the microtask drain so meshAssetCache is populated.
  await new Promise<void>((r) => setTimeout(r, 0));
  return geometries;
}

describe('resolveMeshLodInfo', () => {
  it('returns undefined when no mesh asset is loaded yet', async () => {
    const { cache } = await getMods();
    expect(cache.resolveMeshLodInfo('/anything.mesh.json')).toBeUndefined();
  });

  it('returns undefined for a model with no modelCache (no baked LODs)', async () => {
    const { cache, manifest } = await getMods();
    const sourceGlb = '/x/no-lods.glb';
    manifest.registerAsset(
      '11111111-1111-4111-8111-111111111111',
      sourceGlb, 'model',
      undefined,
      {}, // no modelCache
    );
    // Build a fake mesh-asset entry that points at the LOD-less model
    await seedLodTemplates(cache, [sourceGlb], 'rock');
    // resolveMeshLodInfo returns undefined when modelCache.lodPaths is absent
    expect(cache.resolveMeshLodInfo('/x/some.mesh.json')).toBeUndefined();
  });

  // Missing Test #8 — the positive path: a model with 3 baked LODs, all templates
  // loaded, returns each level's template in distance order plus the matching
  // switch distances. The existing tests only cover the no-asset / no-modelCache
  // negatives; nothing pinned the in-order assembly.
  it('returns every LOD template in distance order with matching distances when all are loaded', async () => {
    const { cache, manifest } = await getMods();
    const sourceGlb = '/x/palm.glb';
    const lodPaths = [sourceGlb + '.processed.glb', sourceGlb + '.lod1.glb', sourceGlb + '.lod2.glb'];
    const lodDistances = [0, 80, 250];
    manifest.registerAsset(
      '55555555-5555-4555-8555-555555555555',
      sourceGlb, 'model',
      undefined,
      {
        modelCache: {
          hash: 'h', processedPath: lodPaths[0],
          lodPaths, lodDistances, triCounts: [0, 0, 0], lodBytes: [0, 0, 0],
        },
      },
    );

    // Seed a template per LOD path keyed `${lodPath}::palm`, and populate the
    // mesh-asset cache (model = base sourceGlb, mesh = 'palm') via a stub fetch.
    const cacheMap: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> =
      (globalThis as { __meshTemplateCache?: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> }).__meshTemplateCache!;
    const geoms: THREE.BufferGeometry[] = [];
    for (const p of lodPaths) {
      const g = new THREE.BufferGeometry();
      cacheMap.set(`${p}::palm`, { geometry: g, material: new THREE.MeshStandardMaterial(), name: 'palm' });
      geoms.push(g);
    }
    (globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async (url: string | URL) =>
      String(url).endsWith('.mesh.json')
        ? new Response(JSON.stringify({ version: 1, model: sourceGlb, mesh: 'palm', postprocessor: 'none' }), { status: 200 })
        : new Response('', { status: 404 }),
    ) as unknown as typeof fetch;
    cache.resolveMeshTemplate('/x/palm.mesh.json'); // populates meshAssetCache
    await new Promise<void>((r) => setTimeout(r, 0));

    const info = cache.resolveMeshLodInfo('/x/palm.mesh.json');
    expect(info).toBeDefined();
    expect(info!.templates).toHaveLength(3);
    // Templates come back in LOD order (LOD0 → LOD2), matching the seeded geometries.
    expect(info!.templates.map((t) => t.geometry)).toEqual(geoms);
    expect(info!.distances).toEqual(lodDistances);
  });

  it('returns undefined until EVERY LOD template is loaded (partial load falls back)', async () => {
    const { cache, manifest } = await getMods();
    const sourceGlb = '/x/partial.glb';
    const lodPaths = [sourceGlb + '.processed.glb', sourceGlb + '.lod1.glb'];
    manifest.registerAsset(
      '66666666-6666-4666-8666-666666666666',
      sourceGlb, 'model',
      undefined,
      { modelCache: { hash: 'h', processedPath: lodPaths[0], lodPaths, lodDistances: [0, 100], triCounts: [0, 0], lodBytes: [0, 0] } },
    );
    const cacheMap: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> =
      (globalThis as { __meshTemplateCache?: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }> }).__meshTemplateCache!;
    // Seed ONLY LOD0 — LOD1 is still loading.
    cacheMap.set(`${lodPaths[0]}::trunk`, { geometry: new THREE.BufferGeometry(), material: new THREE.MeshStandardMaterial(), name: 'trunk' });
    (globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async (url: string | URL) =>
      String(url).endsWith('.mesh.json')
        ? new Response(JSON.stringify({ version: 1, model: sourceGlb, mesh: 'trunk', postprocessor: 'none' }), { status: 200 })
        : new Response('', { status: 404 }),
    ) as unknown as typeof fetch;
    cache.resolveMeshTemplate('/x/partial.mesh.json');
    await new Promise<void>((r) => setTimeout(r, 0));

    // A missing LOD template ⇒ the whole thing returns undefined (caller falls back
    // to the single-mesh mount until every level is resident).
    expect(cache.resolveMeshLodInfo('/x/partial.mesh.json')).toBeUndefined();
  });
});

describe('invalidateModel with LODs', () => {
  it('does not throw when modelCache references multiple LOD paths', async () => {
    const { cache, manifest } = await getMods();
    const sourceGlb = '/x/lodset.glb';
    manifest.registerAsset(
      '22222222-2222-4222-8222-222222222222',
      sourceGlb, 'model',
      undefined,
      {
        modelCache: {
          hash: 'h',
          processedPath: sourceGlb + '.processed.glb',
          lodPaths: [sourceGlb + '.processed.glb', sourceGlb + '.lod1.glb', sourceGlb + '.lod2.glb'],
          lodDistances: [0, 80, 250],
          triCounts: [0, 0, 0],
          lodBytes: [0, 0, 0],
        },
      },
    );
    expect(() => cache.invalidateModel(sourceGlb)).not.toThrow();
  });
});

describe('onModelInvalidated listener', () => {
  it('fires with the modelPath + the full LOD target set BEFORE GPU disposal', async () => {
    const { cache, manifest } = await getMods();
    const sourceGlb = '/x/listen.glb';
    manifest.registerAsset(
      '33333333-3333-4333-8333-333333333333',
      sourceGlb, 'model',
      undefined,
      {
        modelCache: {
          hash: 'h',
          processedPath: sourceGlb + '.processed.glb',
          lodPaths: [sourceGlb + '.processed.glb', sourceGlb + '.lod1.glb'],
          lodDistances: [0, 80],
          triCounts: [0, 0],
          lodBytes: [0, 0],
        },
      },
    );

    let received: { modelPath: string; targets: string[] } | null = null;
    const unsub = cache.onModelInvalidated((modelPath, targets) => {
      received = { modelPath, targets: [...targets] };
    });

    cache.invalidateModel(sourceGlb);

    expect(received).not.toBeNull();
    expect(received!.modelPath).toBe(sourceGlb);
    // Target set includes the source path itself plus every LOD path so
    // renderers can drop THREE.LOD children that point at LOD-derived GLBs.
    expect(received!.targets).toEqual(
      expect.arrayContaining([sourceGlb, sourceGlb + '.processed.glb', sourceGlb + '.lod1.glb']),
    );
    expect(received!.targets).toHaveLength(3);

    // After unsubscribe, the listener no longer fires.
    unsub();
    received = null;
    cache.invalidateModel(sourceGlb);
    expect(received).toBeNull();
  });

  it('without a modelCache, fires with just the source path as the only target', async () => {
    const { cache, manifest } = await getMods();
    const sourceGlb = '/x/noL.glb';
    manifest.registerAsset(
      '44444444-4444-4444-8444-444444444444',
      sourceGlb, 'model',
      undefined,
      {}, // no modelCache → LOD-less single-mesh path
    );

    let targets: string[] = [];
    const unsub = cache.onModelInvalidated((_p, t) => { targets = [...t]; });
    cache.invalidateModel(sourceGlb);
    unsub();

    expect(targets).toEqual([sourceGlb]);
  });

  it('isolates listener errors so other listeners still run', async () => {
    const { cache } = await getMods();
    const sourceGlb = '/x/err.glb';

    const calls: string[] = [];
    const unsubA = cache.onModelInvalidated(() => { throw new Error('boom'); });
    const unsubB = cache.onModelInvalidated((p) => { calls.push(p); });

    // A throws but B still receives the event.
    expect(() => cache.invalidateModel(sourceGlb)).not.toThrow();
    expect(calls).toEqual([sourceGlb]);

    unsubA();
    unsubB();
  });
});

describe('invalidateModel — loading-map key matching', () => {
  // Regression guard: a previous version used `key.includes(target)` to clear
  // the in-flight `loading` map; that substring-matched paths like
  // `/m/foobar` whenever `/m/foo` was invalidated, silently killing unrelated
  // loads. The fix splits on the final `:` (key shape: `${path}:${postprocessorId}`)
  // and exact-compares the path. We verify by stubbing the GLTFLoader so
  // BOTH loads sit pending in `loading`, then invalidate one path and check
  // that the OTHER path's pending promise survives.
  it('does not cancel an in-flight load for a path that has the invalidated path as a prefix', async () => {
    const { cache } = await getMods();
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    // Make every GLB load hang forever — the success/error callbacks never
    // fire, so `loading.set(key, promise)` sticks until invalidate runs.
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});

    try {
      const fooPromise = cache.loadModelTemplates('/m/foo', undefined, 'none');
      const foobarPromise = cache.loadModelTemplates('/m/foobar', undefined, 'none');

      // Invalidating "/m/foo" must NOT touch "/m/foobar"'s entry. Re-asking
      // for "/m/foobar" should hand back the SAME pending promise (same key
      // still in the loading map). Re-asking for "/m/foo" should hand back
      // a FRESH promise (its key was cleared).
      cache.invalidateModel('/m/foo');

      const fooAfter = cache.loadModelTemplates('/m/foo', undefined, 'none');
      const foobarAfter = cache.loadModelTemplates('/m/foobar', undefined, 'none');

      expect(fooAfter).not.toBe(fooPromise);     // foo's load was cleared
      expect(foobarAfter).toBe(foobarPromise);   // foobar's load survived
    } finally {
      loadSpy.mockRestore();
    }
  });

  it('clears the correct in-flight load when multiple postprocessors are active for the same path (editor hook-applied keys)', async () => {
    const { cache } = await getMods();
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(() => {});

    try {
      // Two postprocessor IDs only produce two distinct keys for the EDITOR
      // hook-applied parse (applyPostprocessorHooks=true): `/m/x:none` and
      // `/m/x:island`. invalidateModel('/m/x') must clear BOTH (they share the
      // same source GLB) — the lastIndexOf(':') split strips both suffixes.
      const noneBefore = cache.loadModelTemplates('/m/x', undefined, 'none', true);
      const islandBefore = cache.loadModelTemplates('/m/x', undefined, 'island', true);
      expect(islandBefore).not.toBe(noneBefore); // distinct hook-applied keys

      cache.invalidateModel('/m/x');

      const noneAfter = cache.loadModelTemplates('/m/x', undefined, 'none', true);
      const islandAfter = cache.loadModelTemplates('/m/x', undefined, 'island', true);

      expect(noneAfter).not.toBe(noneBefore);
      expect(islandAfter).not.toBe(islandBefore);
    } finally {
      loadSpy.mockRestore();
    }
  });

  // F1: the RUNTIME parse (applyPostprocessorHooks=false) is postprocessor-agnostic,
  // so a GLB requested under two different postprocessors must DEDUPE to one
  // in-flight load + parse — not parse twice (the second clobbering the first under
  // the shared `${path}::${name}` cache key). The editor hook-applied parse keeps a
  // per-postprocessor key (covered above).
  it('dedupes the runtime load for the same path across different postprocessors (F1)', async () => {
    const { cache } = await getMods();
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    let loadCount = 0;
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
      (_url: string, onLoad: (gltf: { scene: THREE.Object3D }) => void) => {
        loadCount++;
        const root = new THREE.Group();
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
        mesh.name = 'm'; mesh.userData.name = 'm';
        root.add(mesh);
        onLoad({ scene: root });
      },
    );

    try {
      // Acquired as a `model` with the scene's postprocessor AND transitively via a
      // `mesh` with 'none' — both runtime (hooks off). One parse only.
      const a = cache.loadModelTemplates('/m/shared.glb', undefined, 'tropical-island');
      const b = cache.loadModelTemplates('/m/shared.glb', undefined, 'none');
      expect(b).toBe(a);          // same in-flight promise (one load)
      await Promise.all([a, b]);
      expect(loadCount).toBe(1);  // GLB parsed exactly once
    } finally {
      loadSpy.mockRestore();
    }
  });
});

describe('loadModelTemplates — Float32 conversion + node TRS preservation', () => {
  // The runtime LOAD path must:
  //   - Dequantize KHR_mesh_quantization Int16 attributes to plain Float32
  //     so the WebGPU NodeMaterial pipeline accepts the geometry.
  //   - Leave `mesh.matrix` UNTOUCHED on the node so `matrixWorld.decompose`
  //     produces an entity Transform equal to the artist-authored node TRS.
  //
  // Before the fix, the editor path skipped the bake on Float32 input
  // (Transform = node TRS) while the runtime baked `mesh.matrix` into the
  // geometry on Int16 input (Transform = parent_chain). Render applied
  // `mesh.matrix` twice → wrong scale.
  //
  // The earlier attempted fix (always bake) made Transforms identity, which
  // broke animation (no per-mesh handle to tween). The correct behavior
  // converts the buffer type but keeps the node TRS — render =
  // `node_TRS × local_geom = world position`, and animation has a Transform
  // to drive.

  async function loadWithStubbedGLTF(
    setupGltf: () => { scene: THREE.Object3D },
  ): Promise<{
    hierarchy: ReturnType<typeof import('../../src/runtime/loaders/meshTemplateCache').getModelHierarchy>;
    templates: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }>;
  }> {
    const { cache } = await getMods();
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
      (_url: string, onLoad: (gltf: { scene: THREE.Object3D }) => void) => {
        onLoad(setupGltf());
      },
    );
    try {
      await cache.loadModelTemplates('/m/stub.glb', undefined, 'none', false);
    } finally {
      loadSpy.mockRestore();
    }
    return {
      hierarchy: cache.getModelHierarchy('/m/stub.glb'),
      templates: cache.getTemplatesForModel('/m/stub.glb'),
    };
  }

  it('preserves the node TRS in the hierarchy entry (Float32 source, non-identity matrix)', async () => {
    // The artist authored a non-identity node TRS — the entity's Transform
    // must capture it so animation can target the mesh.
    const setup = () => {
      const root = new THREE.Group();
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array([1, 0, 0,   0, 1, 0,   0, 0, 1]), 3,
      ));
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
      mesh.name = 'oar'; mesh.userData.name = 'oar';
      mesh.position.set(10, 0, 0);
      mesh.scale.set(2, 3, 4);
      root.add(mesh);
      return { scene: root };
    };

    const { hierarchy, templates } = await loadWithStubbedGLTF(setup);

    expect(hierarchy).toBeDefined();
    expect(hierarchy!.length).toBe(1);
    expect(hierarchy![0].position[0]).toBeCloseTo(10, 5);
    expect(hierarchy![0].scale[0]).toBeCloseTo(2, 5);
    expect(hierarchy![0].scale[1]).toBeCloseTo(3, 5);
    expect(hierarchy![0].scale[2]).toBeCloseTo(4, 5);

    // Geometry stays in LOCAL space — exactly the source bytes the artist
    // authored. The shader applies the node TRS once via the mesh's matrix.
    const tmpl = templates.get('oar')!;
    const pos = tmpl.geometry.getAttribute('position');
    expect(pos.getX(0)).toBe(1);
    expect(pos.getY(0)).toBe(0);
    expect(pos.getY(1)).toBe(1);
    expect(pos.getZ(2)).toBe(1);
  });

  it('dequantizes Int16 normalized positions to non-normalized Float32 while keeping the node TRS intact', async () => {
    // Simulates a KHR_mesh_quantization GLB (e.g. the LOD pipeline output):
    // positions packed as normalized Int16 with the dequant rescale sitting
    // on the node. Runtime must convert to Float32 [-1, 1] (WebGPU
    // NodeMaterial-friendly) and leave the matrix alone.
    const setup = () => {
      const root = new THREE.Group();
      const geom = new THREE.BufferGeometry();
      const raw = new Int16Array([
        32767, 0,     0,
        0,     32767, 0,
        0,     0,     32767,
      ]);
      geom.setAttribute('position', new THREE.BufferAttribute(raw, 3, /* normalized */ true));
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
      mesh.name = 'palm'; mesh.userData.name = 'palm';
      mesh.scale.set(0.5, 0.5, 0.5);
      root.add(mesh);
      return { scene: root };
    };

    const { hierarchy, templates } = await loadWithStubbedGLTF(setup);

    // Node TRS is preserved.
    expect(hierarchy![0].scale[0]).toBeCloseTo(0.5, 5);

    // Geometry is now Float32 non-normalized, with values in [-1, 1]
    // (Three.js's `getX` denormalizes Int16 by dividing by 32767).
    const tmpl = templates.get('palm')!;
    const pos = tmpl.geometry.getAttribute('position');
    expect(pos.array).toBeInstanceOf(Float32Array);
    expect(pos.normalized).toBe(false);
    expect(pos.getX(0)).toBeCloseTo(1, 5);
    expect(pos.getY(1)).toBeCloseTo(1, 5);
    expect(pos.getZ(2)).toBeCloseTo(1, 5);
  });

  it('skips the conversion (no realloc) for Float32 non-normalized inputs', async () => {
    const setup = () => {
      const root = new THREE.Group();
      const geom = new THREE.BufferGeometry();
      const sourcePositions = new Float32Array([1, 2, 3,   4, 5, 6,   7, 8, 9]);
      geom.setAttribute('position', new THREE.BufferAttribute(sourcePositions, 3));
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
      mesh.name = 'noop'; mesh.userData.name = 'noop';
      root.add(mesh);
      // Tag the source array so we can detect whether the loader allocated a
      // new BufferAttribute (it shouldn't).
      (sourcePositions as unknown as { _tag: string })._tag = 'original';
      return { scene: root };
    };

    const { templates } = await loadWithStubbedGLTF(setup);
    const tmpl = templates.get('noop')!;
    const pos = tmpl.geometry.getAttribute('position');
    expect((pos.array as unknown as { _tag?: string })._tag).toBe('original');
  });
});

describe('loadModelTemplates — cross-path equivalence', () => {
  // Property tests guarding the editor ↔ runtime contract. The bug we just
  // fixed lived in the gap between these paths: the editor read a Float32
  // source and wrote `parent × mesh.matrix` into the prefab Transform; the
  // runtime read an Int16 LOD GLB, applied `mesh.matrix` to the geometry,
  // and saved `parent_chain` into the hierarchy entry. Render applied
  // `mesh.matrix` twice. Tests here keep those two paths in lockstep so any
  // future divergence trips on a green-to-red flip.

  /** Build a fresh stubbed GLB load, isolated by path. The module-level
   *  cache survives across calls within one test (vi.resetModules runs
   *  per-test), so use a unique path per call to avoid the dedup short-
   *  circuit in `loadModelTemplates`. */
  async function loadStubAt(
    path: string,
    applyPostprocessorHooks: boolean,
    setupGltf: () => { scene: THREE.Object3D },
  ) {
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loadSpy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
      (_url: string, onLoad: (gltf: { scene: THREE.Object3D }) => void) => {
        onLoad(setupGltf());
      },
    );
    try {
      await cache.loadModelTemplates(path, undefined, 'none', applyPostprocessorHooks);
    } finally {
      loadSpy.mockRestore();
    }
    return {
      hierarchy: cache.getModelHierarchy(path),
      templates: cache.getTemplatesForModel(path),
    };
  }

  /** Build a scene factory parameterized by encoding. Same logical mesh —
   *  unit triangle at three axis-aligned vertices, under a node with TRS
   *  (translation, rotation, scale) the artist would notice if it drifted. */
  function makeSceneFactory(encoding: 'float32' | 'int16-normalized') {
    return () => {
      const root = new THREE.Group();
      const geom = new THREE.BufferGeometry();
      // Logical unit positions: (1,0,0), (0,1,0), (0,0,1).
      if (encoding === 'float32') {
        geom.setAttribute('position', new THREE.BufferAttribute(
          new Float32Array([1, 0, 0,  0, 1, 0,  0, 0, 1]), 3,
        ));
      } else {
        // Int16 max = 32767; normalized=true means three reads 32767 → 1.0.
        geom.setAttribute('position', new THREE.BufferAttribute(
          new Int16Array([32767, 0, 0,  0, 32767, 0,  0, 0, 32767]), 3, true,
        ));
      }
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
      mesh.name = 'leaf'; mesh.userData.name = 'leaf';
      mesh.position.set(7, -2, 0.5);
      mesh.scale.set(0.116, 0.614, 1.999); // a real value from island.glb
      mesh.quaternion.set(0.6568, 0.0758, -0.2146, 0.7189).normalize();
      root.add(mesh);
      return { scene: root };
    };
  }

  it('produces equivalent hierarchy entries for Float32 source and Int16-normalized LOD inputs', async () => {
    // Editor sees Float32, runtime sees Int16 normalized for the same mesh.
    // If the load paths diverge — for any reason — entity Transforms drift
    // between the two and rendering double-applies (or drops) the node TRS.
    const f32 = await loadStubAt('/m/eq-f32.glb', true, makeSceneFactory('float32'));
    const i16 = await loadStubAt('/m/eq-i16.glb', false, makeSceneFactory('int16-normalized'));

    expect(f32.hierarchy).toBeDefined();
    expect(i16.hierarchy).toBeDefined();
    expect(f32.hierarchy!.length).toBe(1);
    expect(i16.hierarchy!.length).toBe(1);

    const a = f32.hierarchy![0];
    const b = i16.hierarchy![0];

    // Each TRS component must match to floating-point tolerance —
    // matrixWorld.decompose runs the same on both, and the conversion path
    // never mutates mesh.matrix.
    for (let i = 0; i < 3; i++) {
      expect(b.position[i]).toBeCloseTo(a.position[i], 5);
      expect(b.rotation[i]).toBeCloseTo(a.rotation[i], 5);
      expect(b.scale[i]).toBeCloseTo(a.scale[i], 5);
    }
    expect(b.parentName).toBe(a.parentName);
  });

  it('produces the same rendered world position for Float32 and Int16 paths', async () => {
    // The render contract: entity.Transform × loaded_geometry == GLB's
    // intended world position. Reconstruct the entity Transform from each
    // hierarchy entry, multiply by the first cached vertex, and compare
    // against the source GLB's matrixWorld × source vertex.
    const f32 = await loadStubAt('/m/render-f32.glb', false, makeSceneFactory('float32'));
    const i16 = await loadStubAt('/m/render-i16.glb', false, makeSceneFactory('int16-normalized'));

    const toMatrix4 = (entry: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }) => {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(entry.rotation[0], entry.rotation[1], entry.rotation[2]),
      );
      m.compose(
        new THREE.Vector3(entry.position[0], entry.position[1], entry.position[2]),
        q,
        new THREE.Vector3(entry.scale[0], entry.scale[1], entry.scale[2]),
      );
      return m;
    };

    const tF = toMatrix4(f32.hierarchy![0]);
    const tI = toMatrix4(i16.hierarchy![0]);

    // Read the first cached vertex from each load; both should map to the
    // SAME world point after the entity Transform applies.
    const vF = new THREE.Vector3();
    vF.fromBufferAttribute(f32.templates.get('leaf')!.geometry.getAttribute('position'), 0);
    const vI = new THREE.Vector3();
    vI.fromBufferAttribute(i16.templates.get('leaf')!.geometry.getAttribute('position'), 0);

    const worldF = vF.clone().applyMatrix4(tF);
    const worldI = vI.clone().applyMatrix4(tI);

    expect(worldI.x).toBeCloseTo(worldF.x, 4);
    expect(worldI.y).toBeCloseTo(worldF.y, 4);
    expect(worldI.z).toBeCloseTo(worldF.z, 4);
  });

  it('applyPostprocessorHooks=true vs false produce the same hierarchy when the postprocessor is "none"', async () => {
    // 'none' is a no-op postprocessor (filterMesh always true, fixupMesh
    // never mutates). Editor (`true`) and runtime (`false`) must therefore
    // produce identical hierarchies. If a future change to the 'none'
    // postprocessor starts mutating, this test catches the divergence
    // before it lands in prefabs.
    const withHooks = await loadStubAt('/m/hooks-on.glb', true, makeSceneFactory('float32'));
    const noHooks = await loadStubAt('/m/hooks-off.glb', false, makeSceneFactory('float32'));

    const a = withHooks.hierarchy![0];
    const b = noHooks.hierarchy![0];
    expect(b.position).toEqual(a.position);
    expect(b.rotation).toEqual(a.rotation);
    expect(b.scale).toEqual(a.scale);
    expect(b.parentName).toBe(a.parentName);

    // Geometry should also match — same bytes in, same bytes out.
    const posA = withHooks.templates.get('leaf')!.geometry.getAttribute('position');
    const posB = noHooks.templates.get('leaf')!.geometry.getAttribute('position');
    expect(posB.getX(0)).toBe(posA.getX(0));
    expect(posB.getY(0)).toBe(posA.getY(0));
    expect(posB.getZ(0)).toBe(posA.getZ(0));
  });

  it('re-loading after invalidateModel produces the same hierarchy (idempotency)', async () => {
    // Catches drift introduced by hidden state (caches that aren't fully
    // cleared, mesh.matrix accidentally mutated in place, etc.).
    const path = '/m/idem.glb';
    const factory = makeSceneFactory('int16-normalized');

    const first = await loadStubAt(path, false, factory);
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    cache.invalidateModel(path);
    const second = await loadStubAt(path, false, factory);

    const a = first.hierarchy![0];
    const b = second.hierarchy![0];
    expect(b.position).toEqual(a.position);
    expect(b.rotation).toEqual(a.rotation);
    expect(b.scale).toEqual(a.scale);
    expect(b.parentName).toBe(a.parentName);
  });
});
