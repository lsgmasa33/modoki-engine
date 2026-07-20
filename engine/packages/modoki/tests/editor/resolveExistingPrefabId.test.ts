/** resolveExistingPrefabId — keeps a model re-import from minting a fresh prefab
 *  guid that orphans scenes referencing the old one (the tropical-island bug).
 *  Resolution order: asset-manifest guid (survives a file rewrite, offline) →
 *  on-disk file id → undefined (genuinely new prefab → caller mints a guid). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (p: string) => `ASSETURL:${p}`,
}));

const PREFAB_PATH = '/games/3d-test/assets/models/tropical-island/island.prefab.json';
const KNOWN_ID = '23bd8d04-6202-4514-a936-315c42c40109';

describe('resolveExistingPrefabId', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('returns the manifest guid without fetching when the path is registered', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const { resolveExistingPrefabId } = await import('../../src/editor/scene/prefab');
    manifest.clearManifest();
    manifest.registerAsset(KNOWN_ID, PREFAB_PATH, 'prefab');
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    expect(await resolveExistingPrefabId(PREFAB_PATH)).toBe(KNOWN_ID);
    expect(fetchSpy).not.toHaveBeenCalled(); // manifest short-circuits the disk read
  });

  it('falls back to the on-disk file id when the manifest does not know the path', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const { resolveExistingPrefabId } = await import('../../src/editor/scene/prefab');
    manifest.clearManifest();
    global.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ id: KNOWN_ID, entities: [] }),
    })) as unknown as typeof fetch;

    expect(await resolveExistingPrefabId(PREFAB_PATH)).toBe(KNOWN_ID);
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
      .toBe(`ASSETURL:${PREFAB_PATH}`);
  });

  it('returns undefined for a genuinely new prefab (no manifest entry, no file)', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const { resolveExistingPrefabId } = await import('../../src/editor/scene/prefab');
    manifest.clearManifest();
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;

    expect(await resolveExistingPrefabId(PREFAB_PATH)).toBeUndefined();
  });

  it('returns undefined when the on-disk prefab has no id field', async () => {
    const manifest = await import('../../src/runtime/loaders/assetManifest');
    const { resolveExistingPrefabId } = await import('../../src/editor/scene/prefab');
    manifest.clearManifest();
    global.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ entities: [] }),
    })) as unknown as typeof fetch;

    expect(await resolveExistingPrefabId(PREFAB_PATH)).toBeUndefined();
  });
});
