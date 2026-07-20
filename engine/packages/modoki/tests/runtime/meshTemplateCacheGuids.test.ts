/** Tests for the GUID-only resolver inside meshTemplateCache: GUID refs flow
 *  through assetManifest before hitting the cache, unknown GUIDs return
 *  undefined, external URLs pass through, and internal asset *paths* are
 *  rejected loudly (one console.error per offending ref) → undefined. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

async function fresh() {
  const manifest = await import('../../src/runtime/loaders/assetManifest');
  const cache = await import('../../src/runtime/loaders/meshTemplateCache');
  manifest.clearManifest();
  return { manifest, cache };
}

describe('meshTemplateCache — guid resolution', () => {
  it('resolveMeshTemplate returns undefined for an unknown guid (no crash)', async () => {
    const { manifest, cache } = await fresh();
    const g = manifest.newGuid();
    expect(cache.resolveMeshTemplate(g)).toBeUndefined();
  });

  it('resolveMaterial returns undefined for an unknown guid', async () => {
    const { manifest, cache } = await fresh();
    const g = manifest.newGuid();
    expect(cache.resolveMaterial(g)).toBeUndefined();
  });

  it('resolveMaterial of a known mat guid does not crash and triggers the same flow as a path', async () => {
    const { manifest, cache } = await fresh();
    const g = manifest.newGuid();
    manifest.registerAsset(g, '/materials/foo.mat.json', 'material');
    // Async fetch will fail (no network) but the sync path returns undefined cleanly
    expect(cache.resolveMaterial(g)).toBeUndefined();
  });

  it('resolveMeshTemplate of a known mesh guid behaves like the .mesh.json path version', async () => {
    const { manifest, cache } = await fresh();
    const g = manifest.newGuid();
    manifest.registerAsset(g, '/meshes/foo.mesh.json', 'mesh');
    expect(cache.resolveMeshTemplate(g)).toBeUndefined();
    // Calling with the path equivalent should also return undefined (not throw)
    expect(cache.resolveMeshTemplate('/meshes/foo.mesh.json')).toBeUndefined();
  });
});

describe('meshTemplateCache — passthrough cases', () => {
  it('legacy sprite names (no extension) return undefined cleanly when not cached', async () => {
    const { cache } = await fresh();
    expect(cache.resolveMeshTemplate('island/boat')).toBeUndefined();
  });

  it('resolveMaterial rejects a non-.mat.json path', async () => {
    const { cache } = await fresh();
    expect(cache.resolveMaterial('/textures/foo.png')).toBeUndefined();
  });

  it('empty refs return undefined', async () => {
    const { cache } = await fresh();
    expect(cache.resolveMeshTemplate('')).toBeUndefined();
    expect(cache.resolveMaterial('')).toBeUndefined();
  });
});

describe('meshTemplateCache — resolveMaterialForMesh', () => {
  it('accepts a guid in either argument', async () => {
    const { manifest, cache } = await fresh();
    const matGuid = manifest.newGuid();
    const meshGuid = manifest.newGuid();
    manifest.registerAsset(matGuid, '/materials/foo.mat.json', 'material');
    manifest.registerAsset(meshGuid, '/meshes/foo.mesh.json', 'mesh');
    // No crash + no synchronous result (async fetch path)
    expect(cache.resolveMaterialForMesh(matGuid, '')).toBeUndefined();
    expect(cache.resolveMaterialForMesh('', meshGuid)).toBeUndefined();
  });

  it('returns undefined when neither side has a registered guid or known path', async () => {
    const { cache } = await fresh();
    expect(cache.resolveMaterialForMesh('', '')).toBeUndefined();
  });
});

describe('internal path rejection (GUID-only)', () => {
  it('errors once per offending internal asset path ref', async () => {
    const { cache } = await fresh();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // First call — emit error
    expect(cache.resolveMaterial('/materials/foo.mat.json')).toBeUndefined();
    // Second call with the same ref — should NOT error again (deduped)
    expect(cache.resolveMaterial('/materials/foo.mat.json')).toBeUndefined();
    // Different path — second error
    expect(cache.resolveMaterial('/materials/bar.mat.json')).toBeUndefined();

    const pathErrors = spy.mock.calls
      .map(c => String(c[0] ?? ''))
      .filter(s => s.includes('path reference no longer supported'));
    expect(pathErrors.length).toBe(2);
    spy.mockRestore();
  });

  it('does not error for URLs, data:/blob: refs, or guids', async () => {
    const { manifest, cache } = await fresh();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    cache.resolveMaterial('https://cdn.example.com/foo.mat.json');
    cache.resolveMaterial('data:application/json,{}');
    cache.resolveMaterial('blob:abc123');
    cache.resolveMaterial(manifest.newGuid()); // unknown guid emits a console.warn, not error

    const pathErrors = spy.mock.calls
      .map(c => String(c[0] ?? ''))
      .filter(s => s.includes('path reference no longer supported'));
    expect(pathErrors).toEqual([]);
    spy.mockRestore();
  });
});
