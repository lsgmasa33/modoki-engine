/** What a new scene file is called (#1413), and the guard the issue asked for: every built-in
 *  "Create X" kind's extension must classify, through the manifest's own classifier, as the asset
 *  type it registers. Create Scene's `ext: '.json'` (from before #54) wrote `<name>.json`, which the
 *  manifest reads as a scene only inside `/scenes/` by a legacy rule — the same drift can hit any
 *  kind, so the guard covers all of them. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/editor/scene/serialize', () => ({
  newScene: async () => {},
  saveScene: async () => ({ saved: true, path: null, reason: 'ok' }),
  NewSceneRefusedError: class extends Error {},
}));

const { SCENE_EXT, correctedScenePath, isAcceptableScenePath } = await import('../../src/editor/scene/sceneFileName');
const { classifyJsonAssetSuffix } = await import('../../src/runtime/loaders/assetTypeClassifier');
const { registerBuiltinCreatableAssets } = await import('../../src/editor/panels/builtinCreatableAssets');
const { getCreatableAssets } = await import('../../src/editor/panels/creatableAssets');

describe('every built-in creatable kind names a file the manifest types as that kind', () => {
  it('ext classifies as assetType, for each built-in kind', () => {
    registerBuiltinCreatableAssets();
    const defs = getCreatableAssets();
    expect(defs.length, 'precondition: the built-ins registered').toBeGreaterThan(5);
    const wrong = defs
      .map((d) => ({ id: d.id, ext: d.ext, want: d.assetType, got: classifyJsonAssetSuffix(`/assets/x/${d.defaultName}${d.ext}`) }))
      .filter((r) => r.got !== r.want);
    expect(wrong, 'a kind whose file the manifest will type as something else (or nothing)').toEqual([]);
  });
});

describe('the scene suffix', () => {
  it('is the classifier\'s own', () => {
    expect(SCENE_EXT).toBe('.scene.json');
    expect(classifyJsonAssetSuffix(`a${SCENE_EXT}`)).toBe('scene');
  });

  it('correctedScenePath swaps whatever JSON suffix the name carried for the scene one', () => {
    expect(correctedScenePath('/assets/scenes/foo.json')).toBe('/assets/scenes/foo.scene.json');
    expect(correctedScenePath('/assets/scenes/foo.prefab.json')).toBe('/assets/scenes/foo.scene.json');
    expect(correctedScenePath('/assets/scenes/foo')).toBe('/assets/scenes/foo.scene.json');
    expect(correctedScenePath('/assets/scenes/Foo.Scene.JSON')).toBe('/assets/scenes/Foo.scene.json');
    expect(correctedScenePath('/assets/scenes/Foo.JSON')).toBe('/assets/scenes/Foo.scene.json');
  });
});

describe('isAcceptableScenePath — what an explicit save path may be', () => {
  const none = { currentPath: null, existingType: undefined };
  it('accepts a .scene.json name', () => {
    expect(isAcceptableScenePath('/assets/scenes/a.scene.json', none)).toBe(true);
  });
  it('refuses a plain .json or another kind\'s suffix for a new file', () => {
    expect(isAcceptableScenePath('/assets/scenes/a.json', none)).toBe(false);
    expect(isAcceptableScenePath('/assets/scenes/a.prefab.json', none)).toBe(false);
  });
  it('accepts the open scene, and a file the manifest already types scene (legacy /scenes/*.json)', () => {
    expect(isAcceptableScenePath('/assets/scenes/old.json', { currentPath: '/assets/scenes/old.json', existingType: undefined })).toBe(true);
    expect(isAcceptableScenePath('/assets/scenes/old.json', { currentPath: null, existingType: 'scene' })).toBe(true);
  });
  it('does not accept an existing file of another kind', () => {
    expect(isAcceptableScenePath('/assets/p/a.prefab.json', { currentPath: null, existingType: 'prefab' })).toBe(false);
  });
});
