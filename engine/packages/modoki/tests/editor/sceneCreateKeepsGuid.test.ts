/** Assets → Create Scene over an EXISTING scene keeps that scene's guid (#1264, owner 2026-09-15).
 *
 *  The override writes through `saveScene`, whose serializer reads a new scene's id back through the
 *  manifest entry for its path. That already held the old id when the manifest had indexed the file —
 *  so the case that needs pinning is the one it had NOT: a scene another tool just wrote. The create
 *  registers the on-disk id BEFORE the save overwrites it. (`runCreate` asks first — `mayCreateOver`,
 *  covered in createAssetDocument.test.ts.) */

import { describe, it, expect, afterEach, vi } from 'vitest';

const OLD = '55555555-5555-4555-8555-555555555555';
const PATH = '/assets/scenes/unindexed.json';

/** What the manifest said about PATH at the moment the save ran — the id the serializer would stamp. */
let idAtSave: string | undefined;
vi.mock('../../src/editor/scene/serialize', async () => {
  const { getGuidForPath } = await import('../../src/runtime/loaders/assetManifest');
  return {
    newScene: async () => {},
    saveScene: async () => { idAtSave = getGuidForPath(PATH); return { saved: true, path: PATH, reason: 'ok' }; },
    NewSceneRefusedError: class extends Error {},
  };
});

const { registerBuiltinCreatableAssets } = await import('../../src/editor/panels/builtinCreatableAssets');
const { getCreatableAssets } = await import('../../src/editor/panels/creatableAssets');
const { getGuidForPath, unregisterAsset } = await import('../../src/runtime/loaders/assetManifest');

afterEach(() => { vi.unstubAllGlobals(); unregisterAsset(OLD); idAtSave = undefined; });

describe("Create Scene's override", () => {
  it('registers an unindexed scene\'s ON-DISK id before the save that overwrites it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith(PATH)
      ? ({ ok: true, json: async () => ({ id: OLD, entities: [] }) } as unknown as Response)
      : ({ ok: false, json: async () => ({}) } as unknown as Response))));
    expect(getGuidForPath(PATH), 'precondition: the manifest does not know the file').toBeUndefined();
    registerBuiltinCreatableAssets();
    await getCreatableAssets().find((d) => d.id === 'scene')!.create!(PATH);
    expect(idAtSave).toBe(OLD);
  });

  it('a fresh path registers nothing, so the save mints as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) } as unknown as Response)));
    registerBuiltinCreatableAssets();
    await getCreatableAssets().find((d) => d.id === 'scene')!.create!(PATH);
    expect(idAtSave).toBeUndefined();
  });
});
