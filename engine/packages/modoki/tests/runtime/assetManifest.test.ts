/** Unit tests for the asset manifest module — guid detection, registration,
 *  resolution, manifest load/serialize round-trip. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isGuid, newGuid, isExternalUrl, isInternalAssetPath,
  registerAsset, unregisterAsset,
  resolveGuidToPath, getGuidForPath, getAssetType, getAssetEntry,
  resolveRef,
  loadManifestJson, ensureManifestLoaded, serializeManifest,
  clearManifest, getAllAssets, resolveSceneByName,
  registerSprite, getSpriteEpoch,
  type AssetManifestFile,
} from '../../src/runtime/loaders/assetManifest';
import { ASSET_FETCH_INIT } from '../../src/runtime/loaders/assetFetch';

beforeEach(() => clearManifest());

describe('isGuid', () => {
  it('accepts canonical UUID v4 strings', () => {
    expect(isGuid('a1b2c3d4-e5f6-4789-9abc-def012345678')).toBe(true);
    expect(isGuid(newGuid())).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isGuid('A1B2C3D4-E5F6-4789-9ABC-DEF012345678')).toBe(true);
  });

  it('rejects paths, URLs, sprite names, and junk', () => {
    expect(isGuid('/games/3d-test/assets/foo.mesh.json')).toBe(false);
    expect(isGuid('https://example.com/foo.png')).toBe(false);
    expect(isGuid('island/boat')).toBe(false);
    expect(isGuid('')).toBe(false);
    expect(isGuid('a1b2c3d4-e5f6-4789-9abc-def01234567')).toBe(false); // 31 hex
    expect(isGuid('a1b2c3d4-e5f6-4789-9abc-def0123456789')).toBe(false); // 33 hex
    expect(isGuid('not-a-guid')).toBe(false);
  });

  it('rejects nullish input', () => {
    expect(isGuid(undefined)).toBe(false);
    expect(isGuid(null)).toBe(false);
  });
});

describe('newGuid', () => {
  it('emits a distinct UUID on each call', () => {
    const a = newGuid();
    const b = newGuid();
    expect(a).not.toBe(b);
    expect(isGuid(a)).toBe(true);
    expect(isGuid(b)).toBe(true);
  });
});

describe('registerAsset / resolveGuidToPath / getGuidForPath', () => {
  it('round-trips a guid → path → guid lookup', () => {
    const g = newGuid();
    registerAsset(g, '/foo/bar.mesh.json', 'mesh');
    expect(resolveGuidToPath(g)).toBe('/foo/bar.mesh.json');
    expect(getGuidForPath('/foo/bar.mesh.json')).toBe(g);
    expect(getAssetType(g)).toBe('mesh');
  });

  it('re-registering the same guid with a new path drops the old path mapping', () => {
    const g = newGuid();
    registerAsset(g, '/old/path.mesh.json', 'mesh');
    registerAsset(g, '/new/path.mesh.json', 'mesh');
    expect(resolveGuidToPath(g)).toBe('/new/path.mesh.json');
    expect(getGuidForPath('/old/path.mesh.json')).toBeUndefined();
    expect(getGuidForPath('/new/path.mesh.json')).toBe(g);
  });

  it('rejects an invalid guid (logs warning, no entry created)', () => {
    registerAsset('not-a-guid', '/foo.mesh.json', 'mesh');
    expect(resolveGuidToPath('not-a-guid')).toBeUndefined();
    expect(getGuidForPath('/foo.mesh.json')).toBeUndefined();
  });

  it('returns undefined for unknown guids', () => {
    expect(resolveGuidToPath(newGuid())).toBeUndefined();
    expect(getAssetType(newGuid())).toBeUndefined();
  });
});

describe('unregisterAsset', () => {
  it('removes both guid and path entries', () => {
    const g = newGuid();
    registerAsset(g, '/foo.mat.json', 'material');
    unregisterAsset(g);
    expect(resolveGuidToPath(g)).toBeUndefined();
    expect(getGuidForPath('/foo.mat.json')).toBeUndefined();
  });

  it('is a no-op for unknown guids', () => {
    expect(() => unregisterAsset(newGuid())).not.toThrow();
  });

  it('does not strip a path entry that has since been re-registered under a different guid', () => {
    const g1 = newGuid();
    const g2 = newGuid();
    registerAsset(g1, '/foo.mesh.json', 'mesh');
    registerAsset(g2, '/foo.mesh.json', 'mesh'); // overwrites path → g2
    unregisterAsset(g1); // should not touch /foo.mesh.json
    expect(getGuidForPath('/foo.mesh.json')).toBe(g2);
  });
});

describe('isExternalUrl', () => {
  it('accepts http(s), data, and blob URLs', () => {
    expect(isExternalUrl('http://example.com/a.png')).toBe(true);
    expect(isExternalUrl('https://cdn.example.com/sprite.png')).toBe(true);
    expect(isExternalUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isExternalUrl('blob:abcd-1234')).toBe(true);
  });

  it('rejects internal paths, guids, keywords, and nullish', () => {
    expect(isExternalUrl('/games/x.mesh.json')).toBe(false);
    expect(isExternalUrl(newGuid())).toBe(false);
    expect(isExternalUrl('circle')).toBe(false);
    expect(isExternalUrl(undefined)).toBe(false);
    expect(isExternalUrl(null)).toBe(false);
  });
});

describe('isInternalAssetPath', () => {
  it('flags project-internal asset paths across managed extensions', () => {
    expect(isInternalAssetPath('/games/x/a.mesh.json')).toBe(true);
    expect(isInternalAssetPath('/games/x/a.mat.json')).toBe(true);
    expect(isInternalAssetPath('/games/x/a.particle.json')).toBe(true);
    expect(isInternalAssetPath('/games/x/a.prefab.json')).toBe(true);
    expect(isInternalAssetPath('/games/x/a.scene.json')).toBe(true);
    expect(isInternalAssetPath('/games/x/a.shader.json')).toBe(true);
    expect(isInternalAssetPath('/games/x/tex.png')).toBe(true);
    expect(isInternalAssetPath('/games/x/model.glb')).toBe(true);
  });

  it('does NOT flag external URLs, fonts, guids, or keywords', () => {
    expect(isInternalAssetPath('https://cdn.example.com/a.png')).toBe(false);
    expect(isInternalAssetPath('/games/x/font.ttf')).toBe(false); // fonts excluded
    expect(isInternalAssetPath('/games/x/font.woff2')).toBe(false);
    expect(isInternalAssetPath(newGuid())).toBe(false);
    expect(isInternalAssetPath('circle')).toBe(false);
    expect(isInternalAssetPath('Inter')).toBe(false);
    expect(isInternalAssetPath(undefined)).toBe(false);
  });
});

describe('resolveRef', () => {
  it('resolves a known guid to its path', () => {
    const g = newGuid();
    registerAsset(g, '/foo.mesh.json', 'mesh');
    expect(resolveRef(g)).toBe('/foo.mesh.json');
  });

  it('rejects an internal asset path loudly and resolves to undefined', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveRef('/games/x.mesh.json')).toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
    // de-duped: the same offending ref only logs once
    expect(resolveRef('/games/x.mesh.json')).toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it('passes external URLs through unchanged (not manifest assets)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveRef('https://cdn.example.com/sprite.png')).toBe('https://cdn.example.com/sprite.png');
    expect(resolveRef('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('passes non-asset keywords / font names through unchanged', () => {
    expect(resolveRef('circle')).toBe('circle');
    expect(resolveRef('Inter')).toBe('Inter');
  });

  it('returns undefined for an unknown guid', () => {
    expect(resolveRef(newGuid())).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(resolveRef('')).toBeUndefined();
  });
});

describe('getAssetEntry', () => {
  it('indexes both a guid and its resolved path (lower-level lookup utility)', () => {
    const g = newGuid();
    registerAsset(g, '/foo.mesh.json', 'mesh');
    expect(getAssetEntry(g)?.path).toBe('/foo.mesh.json');
    // Reverse path lookup is retained for internal callers (e.g. LOD info by
    // resolved model path) — this is not reference resolution.
    expect(getAssetEntry('/foo.mesh.json')?.guid).toBe(g);
    expect(getAssetEntry(newGuid())).toBeUndefined();
  });
});

describe('loadManifestJson', () => {
  it('imports entries with guids, ignores entries without', () => {
    const g = newGuid();
    const file: AssetManifestFile = {
      version: 2,
      assets: [
        { guid: g, path: '/foo.mesh.json', type: 'mesh' },
        { path: '/legacy/font.ttf', type: 'font' }, // no guid — skipped
      ],
    };
    loadManifestJson(file);
    expect(resolveGuidToPath(g)).toBe('/foo.mesh.json');
    // Skipped entry's path should not be reverse-indexed
    expect(getGuidForPath('/legacy/font.ttf')).toBeUndefined();
  });

  it('skips entries with malformed guids', () => {
    const file: AssetManifestFile = {
      version: 2,
      assets: [{ guid: 'not-a-guid', path: '/foo.mesh.json', type: 'mesh' }],
    };
    loadManifestJson(file);
    expect(getGuidForPath('/foo.mesh.json')).toBeUndefined();
  });

  it('tolerates a non-array assets field without throwing', () => {
    expect(() => loadManifestJson({ version: 2, assets: undefined as unknown as [] })).not.toThrow();
  });
});

describe('ensureManifestLoaded', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('fetches, merges into the map, and returns the parsed manifest', async () => {
    const g = newGuid();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 2, assets: [{ guid: g, path: '/x.mesh.json', type: 'mesh' }] }),
    });
    globalThis.fetch = fetchMock as never;
    const data = await ensureManifestLoaded('/assets.manifest.json');
    expect(fetchMock).toHaveBeenCalledWith('/assets.manifest.json', ASSET_FETCH_INIT);
    expect(resolveGuidToPath(g)).toBe('/x.mesh.json');
    expect(data?.assets).toHaveLength(1);
  });

  it('memoizes — a second call does not re-fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 2, assets: [] }) });
    globalThis.fetch = fetchMock as never;
    await ensureManifestLoaded('/m.json');
    await ensureManifestLoaded('/m.json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
    expect(await ensureManifestLoaded('/missing.json')).toBeNull();
  });

  it('returns null when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as never;
    expect(await ensureManifestLoaded('/x.json')).toBeNull();
  });

  it('clearManifest resets memoization so a later call re-fetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 2, assets: [] }) });
    globalThis.fetch = fetchMock as never;
    await ensureManifestLoaded('/m.json');
    clearManifest();
    await ensureManifestLoaded('/m.json');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Regression: a failed/rejected load must NOT poison the memoized singleton —
  // otherwise a transient failure (or a manifest fetched mid dev-server restart)
  // leaves every GUID unresolved until a full page reload. The fix nulls the memo
  // on failure so the next call self-heals.
  it('does NOT memoize a non-ok load — a later call re-fetches and can succeed', async () => {
    const g = newGuid();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 2, assets: [{ guid: g, path: '/y.mesh.json', type: 'mesh' }] }) });
    globalThis.fetch = fetchMock as never;
    expect(await ensureManifestLoaded('/m.json')).toBeNull();   // first attempt fails, not cached
    const data = await ensureManifestLoaded('/m.json');          // second attempt retries
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data?.assets).toHaveLength(1);
    expect(resolveGuidToPath(g)).toBe('/y.mesh.json');
  });

  it('does NOT memoize a rejected fetch — a later call re-fetches and can succeed', async () => {
    const g = newGuid();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 2, assets: [{ guid: g, path: '/z.mesh.json', type: 'mesh' }] }) });
    globalThis.fetch = fetchMock as never;
    expect(await ensureManifestLoaded('/m.json')).toBeNull();
    const data = await ensureManifestLoaded('/m.json');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data?.assets).toHaveLength(1);
    expect(resolveGuidToPath(g)).toBe('/z.mesh.json');
  });

  it('still memoizes a SUCCESS that follows a failure (no infinite re-fetch on a healthy server)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: true, json: async () => ({ version: 2, assets: [] }) });
    globalThis.fetch = fetchMock as never;
    await ensureManifestLoaded('/m.json'); // fails → not memoized
    await ensureManifestLoaded('/m.json'); // succeeds → memoized
    await ensureManifestLoaded('/m.json'); // served from memo, no 3rd fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('serializeManifest', () => {
  it('round-trips through load → serialize → load', () => {
    const g1 = newGuid();
    const g2 = newGuid();
    registerAsset(g1, '/a.mesh.json', 'mesh');
    registerAsset(g2, '/b.mat.json', 'material');

    const out = serializeManifest();
    expect(out.version).toBe(2);
    expect(out.assets).toHaveLength(2);

    clearManifest();
    expect(resolveGuidToPath(g1)).toBeUndefined();

    loadManifestJson(out);
    expect(resolveGuidToPath(g1)).toBe('/a.mesh.json');
    expect(resolveGuidToPath(g2)).toBe('/b.mat.json');
  });
});

describe('getAllAssets', () => {
  it('reports every registered entry', () => {
    const g1 = newGuid();
    const g2 = newGuid();
    registerAsset(g1, '/a.mesh.json', 'mesh');
    registerAsset(g2, '/b.mat.json', 'material');
    const all = getAllAssets();
    expect(all).toHaveLength(2);
    const guids = all.map(a => a.guid).sort();
    expect(guids).toEqual([g1, g2].sort());
  });
});

describe('registerAsset — model variant paths derive from the current path (survive a move)', () => {
  // A model's baked modelCache stores absolute variant URLs (processedPath/lodPaths)
  // from its import-time location. Moving/renaming the source must NOT strand the
  // loader on the old URLs (which 404) — the entry re-derives them from the CURRENT
  // path so a move needs no re-import.
  const STALE = '/assets/models/OLD.gltf';
  const staleCache = () => ({
    hash: 'cafef00d',
    processedPath: `${STALE}.processed.glb`,
    lodPaths: [`${STALE}.processed.glb`, `${STALE}.lod1.glb`, `${STALE}.lod2.glb`],
    lodDistances: [0, 80, 250],
    triCounts: [2060, 824, 308],
    lodBytes: [37508, 21312, 11704],
  });

  it('derives processedPath + lodPaths from the current source path, ignoring the stored (stale) ones', () => {
    const g = newGuid();
    registerAsset(g, '/assets/models/pad/pad.gltf', 'model', undefined, { modelCache: staleCache() });
    const mc = getAssetEntry(g)?.modelCache;
    expect(mc?.processedPath).toBe('/assets/models/pad/pad.gltf.processed.glb');
    expect(mc?.lodPaths).toEqual([
      '/assets/models/pad/pad.gltf.processed.glb',
      '/assets/models/pad/pad.gltf.lod1.glb',
      '/assets/models/pad/pad.gltf.lod2.glb',
    ]);
  });

  it('preserves location-independent fields (hash, lodDistances, triCounts, lodBytes)', () => {
    const g = newGuid();
    registerAsset(g, '/assets/models/pad/pad.gltf', 'model', undefined, { modelCache: staleCache() });
    const mc = getAssetEntry(g)?.modelCache;
    expect(mc?.hash).toBe('cafef00d');
    expect(mc?.lodDistances).toEqual([0, 80, 250]);
    expect(mc?.triCounts).toEqual([2060, 824, 308]);
    expect(mc?.lodBytes).toEqual([37508, 21312, 11704]);
  });

  it('re-registering the same guid at a new path re-derives to the new location', () => {
    const g = newGuid();
    registerAsset(g, '/assets/models/pad.gltf', 'model', undefined, { modelCache: staleCache() });
    expect(getAssetEntry(g)?.modelCache?.processedPath).toBe('/assets/models/pad.gltf.processed.glb');
    // Move: same guid, new path (the meta's baked cache is unchanged/stale).
    registerAsset(g, '/assets/models/sub/pad.gltf', 'model', undefined, { modelCache: staleCache() });
    expect(getAssetEntry(g)?.modelCache?.processedPath).toBe('/assets/models/sub/pad.gltf.processed.glb');
  });
});

describe('registerSprite / getSpriteEpoch (per-texture)', () => {
  // Helper: register a sliced sprite carved from `texGuid` at `texPath`.
  const addSprite = (sliceGuid: string, texGuid: string, texPath: string) =>
    registerSprite(sliceGuid, texGuid, texPath, {
      texture: texGuid, name: 'frame', rect: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 0.5 },
    });

  it('registers the slice as a "sprite" entry pointing at its parent texture', () => {
    const tex = newGuid(), slice = newGuid();
    registerAsset(tex, '/sheet.png', 'texture');
    addSprite(slice, tex, '/sheet.png');
    expect(getAssetType(slice)).toBe('sprite');
    expect(getAssetEntry(slice)?.sprite?.texture).toBe(tex);
    // Synthetic, collision-free path under the parent texture.
    expect(resolveGuidToPath(slice)).toBe(`/sheet.png#${slice}`);
  });

  it('returns epoch 0 for non-guids, unknown guids, and never-sliced textures', () => {
    const tex = newGuid();
    registerAsset(tex, '/sheet.png', 'texture');
    expect(getSpriteEpoch('')).toBe(0);
    expect(getSpriteEpoch('circle')).toBe(0); // primitive keyword, not a guid
    expect(getSpriteEpoch(newGuid())).toBe(0); // unknown guid
    expect(getSpriteEpoch(tex)).toBe(0); // registered but never sliced
  });

  it('bumps the parent texture epoch on (re-)slice, readable via slice OR texture guid', () => {
    const tex = newGuid(), slice = newGuid();
    registerAsset(tex, '/sheet.png', 'texture');
    addSprite(slice, tex, '/sheet.png');
    expect(getSpriteEpoch(tex)).toBe(1);
    expect(getSpriteEpoch(slice)).toBe(1); // resolves through sprite.texture
    addSprite(slice, tex, '/sheet.png'); // re-slice (same guid) advances again
    expect(getSpriteEpoch(tex)).toBe(2);
    expect(getSpriteEpoch(slice)).toBe(2);
  });

  it('does NOT advance another texture epoch — the per-texture isolation', () => {
    const texA = newGuid(), texB = newGuid(), sliceA = newGuid(), sliceB = newGuid();
    registerAsset(texA, '/a.png', 'texture');
    registerAsset(texB, '/b.png', 'texture');
    addSprite(sliceA, texA, '/a.png');
    expect(getSpriteEpoch(texA)).toBe(1);
    expect(getSpriteEpoch(texB)).toBe(0); // untouched by A's slice

    addSprite(sliceB, texB, '/b.png');
    expect(getSpriteEpoch(texB)).toBe(1);
    expect(getSpriteEpoch(texA)).toBe(1); // still 1 — B's slice didn't disturb A
  });
});

describe('resolveSceneByName', () => {
  const warp = 'a1b2c3d4-e5f6-4789-9abc-def012340001';
  const anim = 'a1b2c3d4-e5f6-4789-9abc-def012340002';
  const tex = 'a1b2c3d4-e5f6-4789-9abc-def012340003';

  beforeEach(() => {
    registerAsset(warp, '/space-console/assets/scenes/Warp.json', 'scene');
    registerAsset(anim, '/3d-test/assets/scenes/2D Animation.json', 'scene');
    registerAsset(tex, '/3d-test/assets/textures/grass.png', 'texture');
  });

  it('resolves by exact filename', () => {
    expect(resolveSceneByName('Warp')).toBe('/space-console/assets/scenes/Warp.json');
  });

  it('is case- and separator-insensitive (spaces/dashes/underscores)', () => {
    expect(resolveSceneByName('warp')).toBe('/space-console/assets/scenes/Warp.json');
    expect(resolveSceneByName('2d-animation')).toBe('/3d-test/assets/scenes/2D Animation.json');
    expect(resolveSceneByName('2D Animation')).toBe('/3d-test/assets/scenes/2D Animation.json');
    expect(resolveSceneByName('2D_Animation.json')).toBe('/3d-test/assets/scenes/2D Animation.json');
  });

  it('resolves a scene GUID directly', () => {
    expect(resolveSceneByName(warp)).toBe('/space-console/assets/scenes/Warp.json');
  });

  it('returns undefined for a non-scene asset, unknown name, or empty input', () => {
    expect(resolveSceneByName('grass')).toBeUndefined(); // a texture, not a scene
    expect(resolveSceneByName(tex)).toBeUndefined();     // GUID of a texture
    expect(resolveSceneByName('does-not-exist')).toBeUndefined();
    expect(resolveSceneByName('')).toBeUndefined();
  });
});
