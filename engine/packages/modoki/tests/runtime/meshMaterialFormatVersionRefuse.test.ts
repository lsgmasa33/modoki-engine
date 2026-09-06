/** #784 phase C2b item 6 — the runtime read side of `.mesh.json`/`.mat.json` never looked at the
 *  version field at all. A too-new or unreadable document must be REFUSED (not cached/built),
 *  landing in the SAME permanent `MESH_FAILED`/`MATERIAL_FAILED` sentinel a genuine 404 or an
 *  unknown material `type` already uses — mirrors `particleCache.ts`'s refusal for
 *  `.particle.json` (phase C2a). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MESH_GUID = '55555555-2222-4333-8444-666666666666';
const MESH_PATH = '/games/g/assets/mesh/too-new.mesh.json';
const MAT_GUID = '77777777-2222-4333-8444-666666666666';
const MAT_PATH = '/games/g/assets/material/too-new.mat.json';

function stubFetch(bodies: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [path, body] of Object.entries(bodies)) {
      if (url.includes(path)) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => body } as unknown as Response;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

beforeEach(async () => {
  vi.resetModules();
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  cache.disposeAllCachedResources();
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  manifest.clearManifest();
  manifest.registerAsset(MESH_GUID, MESH_PATH, 'mesh');
  manifest.registerAsset(MAT_GUID, MAT_PATH, 'material');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('.mesh.json — refused, not cached, when too-new or unreadable', () => {
  // `model: ''` throughout — a real path/guid would send `acquireMesh` down the GLB-load branch,
  // which is unrelated to what this test guards (the version classification runs before that
  // branch is even reached) and would otherwise hit the real GLTFLoader/fetch machinery.

  it('a too-new .mesh.json is not cached and getMeshAsset stays undefined', async () => {
    stubFetch({ [MESH_PATH]: JSON.stringify({ version: 999, id: MESH_GUID, model: '', mesh: 'm', postprocessor: 'none' }) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    await cache.acquireMesh(1, MESH_GUID);
    expect(cache.getMeshAsset(MESH_GUID)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('newer than'));
    errorSpy.mockRestore();
  });

  it('an unreadable .mesh.json (non-numeric version field) is not cached', async () => {
    // A real parse failure (corrupt/conflict-markered bytes) is caught earlier, by
    // `parseAssetJson`'s SyntaxError — pre-existing behaviour (console.warn, MESH_FAILED),
    // unrelated to this item. This exercises the classification THIS fix adds: valid JSON whose
    // `version` field is not a readable integer (docs/format-versioning.md § 2a "unreadable").
    stubFetch({ [MESH_PATH]: JSON.stringify({ version: 'two', id: MESH_GUID, model: '', mesh: 'm', postprocessor: 'none' }) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    await cache.acquireMesh(1, MESH_GUID);
    expect(cache.getMeshAsset(MESH_GUID)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
    errorSpy.mockRestore();
  });

  it('an ordinary (absent-version) .mesh.json still loads normally — the guard is not over-eager', async () => {
    stubFetch({ [MESH_PATH]: JSON.stringify({ id: MESH_GUID, model: '', mesh: 'm', postprocessor: 'none' }) });
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    await cache.acquireMesh(1, MESH_GUID);
    expect(cache.getMeshAsset(MESH_GUID)).toBeDefined();
  });
});

describe('.mat.json — refused, not built, when too-new or unreadable', () => {
  it('a too-new .mat.json resolves to no material (MATERIAL_FAILED)', async () => {
    stubFetch({ [MAT_PATH]: JSON.stringify({ version: 999, id: MAT_GUID, shader: 'builtin', color: 0xffffff }) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = await import('../../src/runtime/loaders/meshTemplateCache');
    await cache.acquireMaterial(1, MAT_GUID);
    expect(cache.resolveMaterial(MAT_GUID)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
