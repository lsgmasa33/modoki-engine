/** #1718 — every reader that NAMES the open scene asks `openScenePath()`: SceneManager's primary when it has one, else
 *  the file the editor saves the world to. A `newScene()` world saved to a file has no SceneManager entry, so a reader
 *  asking SceneManager alone refused a take ("no scene is open"), labelled the SceneView "Untitled", and reported the
 *  capture's scene as null until the scene was reopened (OBSERVED live in the work-ai editor, and gone after the fix).
 *  The SceneView label also follows a path change with no world swap (`onScenePathChange`).
 *
 *  Mutations: drop the editor fallback in `openScenePath` → the second case goes red; let SceneManager lose to the editor
 *  path → the first; notify on every set, or never → the last. */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });

const { openScenePath, setEditorScenePathReader } = await import('../../packages/modoki/src/runtime/scene/openScenePath');
const { sceneManager } = await import('../../packages/modoki/src/runtime/scene/SceneManager');
const { setCurrentScenePath, getCurrentScenePath, onScenePathChange } = await import('../../packages/modoki/src/editor/scene/serialize');

afterEach(() => {
  vi.restoreAllMocks();
  setEditorScenePathReader(null);
  setCurrentScenePath(null);
});

describe('openScenePath (#1718)', () => {
  it('SceneManager wins whenever it answers (a loaded scene, the prefab-edit world)', () => {
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: '/__prefab-edit__/x' } as never);
    setEditorScenePathReader(() => '/assets/scenes/Other.scene.json');
    expect(openScenePath()).toBe('/__prefab-edit__/x');
  });

  it('a newScene() world saved to a file — no SceneManager entry — is named by the file the editor saved it to', () => {
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null);
    setCurrentScenePath('/assets/scenes/Fresh.scene.json');
    setEditorScenePathReader(getCurrentScenePath);
    expect(openScenePath()).toBe('/assets/scenes/Fresh.scene.json');
  });

  it('nothing open, or the game runtime (no editor reader): null', () => {
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null);
    expect(openScenePath()).toBeNull();
    setEditorScenePathReader(getCurrentScenePath);
    expect(openScenePath()).toBeNull();
  });

  it('a path change is announced once, and a set to the same path is not', () => {
    const heard: string[] = [];
    const off = onScenePathChange(() => heard.push(String(getCurrentScenePath())));
    setCurrentScenePath('/assets/scenes/A.scene.json');
    setCurrentScenePath('/assets/scenes/A.scene.json');
    setCurrentScenePath('/assets/scenes/B.scene.json');
    off();
    setCurrentScenePath('/assets/scenes/C.scene.json');
    expect(heard).toEqual(['/assets/scenes/A.scene.json', '/assets/scenes/B.scene.json']);
  });
});
