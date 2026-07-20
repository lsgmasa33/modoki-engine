/** assetRoots — writable asset-root resolution for Create Prefab / Import.
 *
 *  Regression guard for "[Hierarchy] No writable asset root for prefab": a flat
 *  one-game project (#29) serves its assets under the bare `/assets` prefix, which
 *  the pre-#29 regex did not match — so Create Prefab found no root and failed. */

import { describe, it, expect } from 'vitest';
import { ASSET_ROOT_RE, firstAssetRoot } from '../../src/editor/panels/assetRoots';

describe('ASSET_ROOT_RE', () => {
  it('matches the flat one-game project prefix /assets (#29)', () => {
    expect('/assets/prefabs/Foo.prefab.json'.match(ASSET_ROOT_RE)?.[1]).toBe('/assets');
    expect('/assets'.match(ASSET_ROOT_RE)?.[1]).toBe('/assets');
  });

  it('matches the engine built-ins prefix /modoki/assets', () => {
    expect('/modoki/assets/fonts/Inter.ttf'.match(ASSET_ROOT_RE)?.[1]).toBe('/modoki/assets');
  });

  it('matches the multi-game prefix /games/<id>/assets', () => {
    expect('/games/3d-test/assets/scenes/x.json'.match(ASSET_ROOT_RE)?.[1]).toBe('/games/3d-test/assets');
    expect('/games/alien-animal/assets/models/a.glb'.match(ASSET_ROOT_RE)?.[1]).toBe('/games/alien-animal/assets');
  });

  it('does NOT match virtual tree nodes or look-alike prefixes', () => {
    expect('/'.match(ASSET_ROOT_RE)).toBeNull();
    expect('/games'.match(ASSET_ROOT_RE)).toBeNull();
    expect('/assetsfoo/bar'.match(ASSET_ROOT_RE)).toBeNull(); // not a real "/assets" root
    expect('/other/assets/x'.match(ASSET_ROOT_RE)).toBeNull();
  });
});

describe('firstAssetRoot', () => {
  it('returns null when no path is under a real root', () => {
    expect(firstAssetRoot(['/', '/games', '/unknown/x'])).toBeNull();
    expect(firstAssetRoot([])).toBeNull();
  });

  it('resolves /assets for a flat one-game project (the failing case)', () => {
    const paths = [
      '/assets/scenes/tropical-island.json',
      '/assets/models/island.glb',
      '/assets/prefabs/Island.prefab.json',
    ];
    expect(firstAssetRoot(paths)).toBe('/assets');
  });

  it('prefers the game root over engine /modoki/assets when both are present', () => {
    // A flat project also exposes engine built-ins under /modoki/assets; new
    // prefabs/imports must land in the game (/assets), never the read-only engine.
    expect(firstAssetRoot(['/modoki/assets/fonts/Inter.ttf', '/assets/scenes/x.json'])).toBe('/assets');
    expect(firstAssetRoot(['/modoki/assets/f.ttf', '/games/3d-test/assets/x.json'])).toBe('/games/3d-test/assets');
  });

  it('resolves /modoki/assets when that is the only real root', () => {
    expect(firstAssetRoot(['/', '/modoki/assets/fonts/Inter.ttf'])).toBe('/modoki/assets');
  });
});
