/** `movedSceneFile` (#2078 close-out re-review): the key match only nominates, the guid confirms. `normScenePath` folds
 *  case and decodes escapes, so two DIFFERENT files can share a key; re-pointing the open scene on the key alone aimed
 *  Cmd+S at the other file. The manifest (landed by the route before the renderer's repair, when its rebuild succeeds)
 *  confirms the file and supplies its on-disk spelling. */

import { describe, it, expect, afterEach } from 'vitest';
import { movedSceneFile, scenePathMoveKey } from '../../packages/modoki/src/editor/utils/assetPaths';
import { registerAsset, clearManifest } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { normScenePath } from '../../packages/modoki/src/runtime/scene/scenePathKey';

const G = '00002078-0000-4000-8000-0000000000a1';
const OTHER = '00002078-0000-4000-8000-0000000000a2';
afterEach(() => clearManifest());

describe('movedSceneFile', () => {
  it('does not re-point a scene at ANOTHER file that shares its key (a literal %20 against a space, #1979)', () => {
    const open = '/assets/scenes/my%20level.scene.json';
    registerAsset(G, open, 'scene'); // the open scene did not move
    registerAsset(OTHER, '/assets/scenes/b.scene.json', 'scene'); // the moved file is a different one
    const moves = [{ from: '/assets/scenes/my level.scene.json', to: '/assets/scenes/b.scene.json' }];
    expect(normScenePath(open)).toBe(normScenePath(moves[0].from)); // the premise: one key, two files
    expect(scenePathMoveKey(moves)(open)).toBe('/assets/scenes/b.scene.json'); // the key alone nominates it
    expect(movedSceneFile(moves)(open, G)).toBeUndefined();
  });

  it('answers the on-disk spelling from the manifest for a folder move of a scene held under another spelling', () => {
    registerAsset(G, '/assets/Levels/Sub/Level.scene.json', 'scene'); // where the route put it
    const moves = [{ from: '/assets/Scenes', to: '/assets/Levels', prefix: true }];
    expect(movedSceneFile(moves)('/assets/Scenes/Sub/./Level.scene.json', G)).toBe('/assets/Levels/Sub/Level.scene.json');
  });

  it('with no guid the manifest knows, trusts only an exact-spelling match', () => {
    const moves = [{ from: '/assets/scenes/A.scene.json', to: '/assets/scenes/B.scene.json' }];
    expect(movedSceneFile(moves)('/assets/scenes/A.scene.json', undefined)).toBe('/assets/scenes/B.scene.json');
    expect(movedSceneFile(moves)('/assets/scenes/a.scene.json', undefined)).toBeUndefined();
    expect(movedSceneFile(moves)('/assets/scenes/A.scene.json', 'path:/assets/scenes/A.scene.json')).toBe('/assets/scenes/B.scene.json');
  });

  it('when the manifest has not seen the move (a failed rebuild), an exact-spelling match still moves the scene', () => {
    registerAsset(G, '/assets/scenes/A.scene.json', 'scene'); // still the OLD path
    const moves = [{ from: '/assets/scenes/A.scene.json', to: '/assets/scenes/B.scene.json' }];
    expect(movedSceneFile(moves)('/assets/scenes/A.scene.json', G)).toBe('/assets/scenes/B.scene.json');
    expect(movedSceneFile(moves)('/assets/scenes/./A.scene.json', G), 'a spelling the manifest cannot confirm').toBeUndefined();
  });

  it('a folder move of a file whose name holds a literal %25 escape is decoded once (#1979)', () => {
    registerAsset(G, '/assets/Levels/a%2541.scene.json', 'scene');
    const moves = [{ from: '/assets/Scenes', to: '/assets/Levels', prefix: true }];
    expect(movedSceneFile(moves)('/assets/Scenes/a%2541.scene.json', G)).toBe('/assets/Levels/a%2541.scene.json');
  });

  it('a delete moves nothing', () => {
    registerAsset(G, '/assets/scenes/A.scene.json', 'scene');
    expect(movedSceneFile([{ from: '/assets/scenes/A.scene.json', to: null }])('/assets/scenes/A.scene.json', G)).toBeUndefined();
  });
});
