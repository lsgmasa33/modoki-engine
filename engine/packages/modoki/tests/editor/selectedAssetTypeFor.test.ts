/** `selectedAssetTypeFor` (AssetRefField, #423 item 3) — the `SelectedAsset.type` used by
 *  "Locate in Assets" / "Open in editor" / Find References navigation. It must prefer the live
 *  asset manifest's own type over `assetTypeFromPath`'s classifier, because the two are
 *  DELIBERATELY different for a scanner-only import source like `.obj`: `assetTypeFromPath`
 *  reports 'unknown' (correct for the tree-shaker question — `.obj` never ships, only the
 *  converted GLB does), but the manifest types it 'model' (the Assets panel offers "Import
 *  Model" for it). A caller that used `assetTypeFromPath` for NAVIGATION sent the Inspector a
 *  type it has no importer section for, so a `.obj` reached via "Locate in Assets" rendered a
 *  dead Inspector while the SAME file clicked in the Assets tree worked (#423).
 *
 *  `assetTypeFromPath` itself and its own pinning test (assetTypeFromPath.test.ts) are
 *  unchanged by this — this file pins the two functions as deliberately different for a path
 *  the manifest knows about. */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const manifestEntries = new Map<string, { type: string }>();

vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: (sel: (s: unknown) => unknown) => sel({}),
}));
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  isGuid: () => false,
  isExternalUrl: () => false,
  resolveGuidToPath: () => null,
  getGuidForPath: () => undefined,
  getAllAssets: () => [],
  getAssetEntry: (ref: string) => manifestEntries.get(ref),
}));
vi.mock('../../src/runtime/loaders/fontLoader', () => ({
  loadFont: () => Promise.resolve(null),
  fontPathFromFamily: () => null,
  fontFamilyFromPath: (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, ''),
}));

import { assetTypeFromPath, selectedAssetTypeFor } from '../../src/editor/panels/AssetRefField';

describe('selectedAssetTypeFor prefers the manifest entry over assetTypeFromPath', () => {
  it('a .obj WITH a manifest entry resolves to \'model\', while assetTypeFromPath alone still says \'unknown\'', () => {
    const path = '/games/x/assets/models/hero.obj';
    manifestEntries.set(path, { type: 'model' });
    expect(assetTypeFromPath(path)).toBe('unknown');
    expect(selectedAssetTypeFor(path)).toBe('model');
    manifestEntries.delete(path);
  });

  it('falls back to assetTypeFromPath when the manifest has no entry for the path', () => {
    const path = '/games/x/assets/models/orphan.obj';
    expect(manifestEntries.has(path)).toBe(false);
    expect(selectedAssetTypeFor(path)).toBe(assetTypeFromPath(path));
    expect(selectedAssetTypeFor(path)).toBe('unknown');
  });

  it('agrees with assetTypeFromPath for a normal manifest-typed asset', () => {
    const path = '/games/x/assets/materials/hero.mat.json';
    manifestEntries.set(path, { type: 'material' });
    expect(selectedAssetTypeFor(path)).toBe('material');
    expect(selectedAssetTypeFor(path)).toBe(assetTypeFromPath(path));
    manifestEntries.delete(path);
  });
});
