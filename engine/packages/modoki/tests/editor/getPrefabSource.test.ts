/** getPrefabSource ref-handling tests. A freshly-instantiated prefab instance
 *  (dragged into the Hierarchy, before its scene is saved + GUID-normalized) can
 *  carry a PATH source. resolveRef hard-rejects internal asset paths, so
 *  getPrefabSource must fetch a path ref directly via assetUrl — and use
 *  resolveRef only for GUIDs. Regression guard for the "path reference no longer
 *  supported" console error on prefab drop. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (p: string) => `ASSETURL:${p}`,
}));

vi.mock('../../src/runtime/loaders/assetManifest', async (orig) => {
  const actual = await orig<typeof import('../../src/runtime/loaders/assetManifest')>();
  return {
    ...actual,                       // keep the real isGuid / getGuidForPath
    resolveRef: vi.fn((ref: string) => `RESOLVED:${ref}`),
    registerAsset: vi.fn(),
  };
});

const prefabJson = (name: string) => ({
  ok: true,
  json: async () => ({ name, entities: [], rootLocalId: 1 }),
});

describe('getPrefabSource ref handling', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches a PATH source via assetUrl, never resolveRef (no GUID-rejection)', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const { getPrefabSource } = await import('../../src/editor/scene/prefab');
    const path = '/games/x/assets/planets/mars/MarsPlanet.prefab.json';
    global.fetch = vi.fn(async () => prefabJson('Mars')) as unknown as typeof fetch;

    const prefab = await getPrefabSource(path);

    expect(prefab?.name).toBe('Mars');
    // The path must NOT go through resolveRef (which rejects internal paths).
    expect(manifest.resolveRef).not.toHaveBeenCalled();
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(`ASSETURL:${path}`);
  });

  it('resolves a GUID source through resolveRef', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const { getPrefabSource } = await import('../../src/editor/scene/prefab');
    const guid = '11111111-2222-4333-8444-555555555555';
    global.fetch = vi.fn(async () => prefabJson('ByGuid')) as unknown as typeof fetch;

    const prefab = await getPrefabSource(guid);

    expect(prefab?.name).toBe('ByGuid');
    expect(manifest.resolveRef).toHaveBeenCalledWith(guid);
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(`RESOLVED:${guid}`);
  });
});
