/** `assetTypeFromPath` (AssetRefField) must classify every asset kind the shared
 *  `assetTypeClassifier` knows, over BOTH halves — JSON suffix and binary extension (#417).
 *
 *  It is the predicate behind "Locate in Assets" and Find References in the Inspector. The
 *  binary half used to be a hand-written regex ladder that only covered a subset of
 *  `BINARY_EXT_TYPE`, while the docstring claimed the whole function shared the classifier
 *  and "can't drift". It had drifted: `.fbx` (model), `.exr` (environment) and every video
 *  container (`.mp4`/`.mov`/`.m4v`/`.webm`/`.mkv`) read as 'unknown' here while the build
 *  classified them correctly — video is a shipped feature. This is a drift guard, not a style
 *  check, and it is retrospective like `assetPathPredicate.test.ts`, which uses the same shape
 *  (iterate the shared table, collect mismatches, name the concrete regression separately). */
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// ── module mocks: keep the field free of the editor store / manifest / font IO, same as
//    assetRefField.test.tsx — assetTypeFromPath itself touches none of these, but the module
//    imports them at load time. ──
vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: (sel: (s: unknown) => unknown) => sel({}),
}));
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  isGuid: () => false,
  isExternalUrl: () => false,
  resolveGuidToPath: () => null,
  getGuidForPath: () => undefined,
  getAllAssets: () => [],
  getAssetEntry: () => undefined,
}));
vi.mock('../../src/runtime/loaders/fontLoader', () => ({
  loadFont: () => Promise.resolve(null),
  fontPathFromFamily: () => null,
  fontFamilyFromPath: (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, ''),
}));

import { assetTypeFromPath } from '../../src/editor/panels/AssetRefField';
import { JSON_ASSET_SUFFIX_TYPE, BINARY_EXT_TYPE } from '../../src/runtime/loaders/assetTypeClassifier';

describe('assetTypeFromPath covers both halves of the shared classifier', () => {
  it('classifies every JSON asset suffix the classifier knows', () => {
    const mismatches = JSON_ASSET_SUFFIX_TYPE
      .filter(([suffix, type]) => assetTypeFromPath(`/games/x/assets/thing${suffix}`) !== type)
      .map(([suffix, type]) => `${suffix} expected ${type}, got ${assetTypeFromPath(`/games/x/assets/thing${suffix}`)}`);
    expect(
      mismatches,
      'assetTypeFromPath (AssetRefField.tsx) disagrees with JSON_ASSET_SUFFIX_TYPE for these suffixes.',
    ).toEqual([]);
  });

  it('classifies every shippable binary extension the classifier knows', () => {
    const mismatches = Object.entries(BINARY_EXT_TYPE)
      .filter(([ext, type]) => assetTypeFromPath(`/games/x/assets/thing${ext}`) !== type)
      .map(([ext, type]) => `${ext} expected ${type}, got ${assetTypeFromPath(`/games/x/assets/thing${ext}`)}`);
    expect(
      mismatches,
      'assetTypeFromPath (AssetRefField.tsx) disagrees with BINARY_EXT_TYPE for these extensions — '
        + 'this is the #417 drift class (a hand-written ladder missing entries the shared table has).',
    ).toEqual([]);
  });

  it('the seven kinds the drift actually exposed are now classified correctly', () => {
    // Named explicitly so a future narrowing fails on the concrete regression, not only on the
    // abstract table comparison above.
    expect(assetTypeFromPath('/games/x/assets/models/hero.fbx')).toBe('model');
    expect(assetTypeFromPath('/games/x/assets/env/sky.exr')).toBe('environment');
    expect(assetTypeFromPath('/games/x/assets/video/intro.mp4')).toBe('video');
    expect(assetTypeFromPath('/games/x/assets/video/intro.mov')).toBe('video');
    expect(assetTypeFromPath('/games/x/assets/video/intro.m4v')).toBe('video');
    expect(assetTypeFromPath('/games/x/assets/video/intro.webm')).toBe('video');
    expect(assetTypeFromPath('/games/x/assets/video/intro.mkv')).toBe('video');
  });

  it('classifies an uppercase extension the same as lowercase', () => {
    expect(assetTypeFromPath('/a/THING.MP4')).toBe('video');
  });

  it('does not mistake a dot in a DIRECTORY name for a file extension', () => {
    expect(assetTypeFromPath('/games/my.game/assets/README')).toBe('unknown');
  });

  it('leaves a scanner-only import source unknown — scenes reference the converted GLB, never the source', () => {
    expect(assetTypeFromPath('/a/model.obj')).toBe('unknown');
  });

  it('leaves a bare unknown extension unknown', () => {
    expect(assetTypeFromPath('/a/x.zip')).toBe('unknown');
  });
});
