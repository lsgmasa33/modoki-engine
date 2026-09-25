/** `otherAssetKindAt` — the client half of "a Replace never crosses kinds" (#1264, #1472).
 *
 *  The scene flows write plain `.json` through `/api/write-file`, which is byte-opaque, so this is the
 *  only kind check in front of a scene Replace. It asked the manifest alone, so a `.prefab.json` the
 *  manifest had not indexed yet read as "no conflict" and the scene was written over the prefab under
 *  the prefab's own guid. It now falls back to the scanner's suffix rule, as the backend's
 *  `wrongKindRefusal` does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadManifestJson, clearManifest } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { otherAssetKindAt } from '../../packages/modoki/src/editor/scene/createAssetDocument';

beforeEach(() => {
  loadManifestJson({ version: 1, assets: [
    { guid: '11111111-1111-4111-8111-111111111111', path: '/prefabs/enemy.prefab.json', type: 'prefab' },
    { guid: '22222222-2222-4222-8222-222222222222', path: '/scenes/old.json', type: 'scene' },
    { guid: '33333333-3333-4333-8333-333333333333', path: '/prefabs/legacy.json', type: 'prefab' },
  ] });
});
afterEach(() => { clearManifest(); });

describe('otherAssetKindAt', () => {
  it('names the kind the manifest gives a registered file', () => {
    expect(otherAssetKindAt('/prefabs/enemy.prefab.json', 'scene')).toBe('prefab');
  });

  it('the MANIFEST wins over the name — a plain .json it types prefab is a prefab', () => {
    expect(otherAssetKindAt('/prefabs/legacy.json', 'scene')).toBe('prefab');
  });

  it('names the kind an UNINDEXED file will get from its suffix', () => {
    expect(otherAssetKindAt('/prefabs/fresh.prefab.json', 'scene')).toBe('prefab');
  });

  it('names the kind an UNINDEXED file gets from the LEGACY folder rules and .layout.json', () => {
    expect(otherAssetKindAt('/assets/scenes/level2.json', 'particle')).toBe('scene');
    expect(otherAssetKindAt('/assets/materials/red.json', 'scene')).toBe('material');
    expect(otherAssetKindAt('/layouts/main.layout.json', 'scene')).toBe('layout');
  });

  it('is no conflict for the same kind, registered or by name', () => {
    expect(otherAssetKindAt('/scenes/old.json', 'scene')).toBeUndefined();
    expect(otherAssetKindAt('/scenes/new.scene.json', 'scene')).toBeUndefined();
  });

  it('is no conflict for a name no kind claims', () => {
    expect(otherAssetKindAt('/data/whatever.json', 'scene')).toBeUndefined();
  });
});
