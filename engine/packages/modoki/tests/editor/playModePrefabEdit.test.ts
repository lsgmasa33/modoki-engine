/** Play → Stop must leave the prefab-edit world still BEING the prefab-edit world.
 *
 *  ⚠️ **The bug, as reported: "when I press play, and stop, the prefab edit mode loses the prefab
 *  name, and cmd+s ends up the new file dialog."**
 *
 *  Play snapshots the world and Stop reverts by reloading that snapshot through SceneManager. Both
 *  ends took the scene path from `getCurrentScenePath()` — the editor's FILE path, which prefab-edit
 *  deliberately sets to **null** so a normal save cannot target a real file. So Stop reloaded under
 *  `path ?? ''`, and the live scene's path became an EMPTY STRING instead of
 *  `/__prefab-edit__/<guid>`.
 *
 *  Everything downstream ground-truths prefab-edit on that path, so one empty string produced both
 *  reported symptoms at once:
 *   - the SceneView breadcrumb stops showing the prefab (it tests the live path's prefix);
 *   - `isEditingPrefab()` fails the same test and runs its self-heal, CLEARING `editingPrefab`, so
 *     Cmd+S stops routing to `savePrefabEdit()` and falls through to a scene save with no path —
 *     the native "Save Scene As" panel.
 *
 *  This pins the REVERT PATH, because that single value is what both symptoms hang off. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentPath: string | null = null;
const loadScene = vi.fn(async (path: string, _opts?: unknown) => { currentPath = path; });
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (currentPath === null ? null : { path: currentPath }),
    getLoadedScenes: () => new Map(),
    loadScene: (p: string, o: unknown) => loadScene(p, o as never),
  },
}));

// The editor's FILE path — null in prefab-edit, which is the whole point.
let filePath: string | null = null;
vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: async () => ({ version: 1, entities: [], resources: [] }),
  getCurrentScenePath: () => filePath,
}));

vi.mock('../../src/editor/scene/timelinePreview', () => ({
  hasTimelinePreviewSession: () => false,
  endTimelinePreviewSession: async () => {},
}));
vi.mock('../../src/editor/panels/aiSettingsModel', () => ({
  fetchAiSettings: async () => ({}),
  getCachedAiSettings: () => ({}),
}));
vi.mock('../../src/editor/undo/undoManager', () => ({ undoDepth: () => 0, truncateUndoTo: vi.fn() }));
vi.mock('../../src/editor/editorJournal', () => ({ editorEmit: vi.fn() }));

const { enterPlay, stopPlay } = await import('../../src/editor/scene/playMode');
const { setPlayState } = await import('../../src/runtime/core/playState');

const SYNTH = '/__prefab-edit__/320bf1fc-b607-451b-928a-570b0112d8d6';

beforeEach(() => {
  loadScene.mockClear();
  setPlayState('stopped');
});

describe('Play/Stop in the prefab-edit world', () => {
  it('reverts under the SYNTHETIC path, not an empty string', async () => {
    currentPath = SYNTH;
    filePath = null; // prefab-edit: no file path, deliberately

    await enterPlay();
    await stopPlay();

    expect(loadScene, 'Stop reloads the snapshot').toHaveBeenCalledTimes(1);
    // THE REGRESSION: this was '' , which silently ended prefab-edit mode.
    expect(loadScene.mock.calls[0][0]).toBe(SYNTH);
    expect(currentPath, 'the live world is still the prefab-edit world after Stop').toBe(SYNTH);
  });

  it('an ordinary scene is unaffected — same path in, same path out', async () => {
    // The file path and the live path agree for a real scene, so this change is a no-op there.
    currentPath = '/assets/scenes/main.scene.json';
    filePath = '/assets/scenes/main.scene.json';

    await enterPlay();
    await stopPlay();

    expect(loadScene.mock.calls[0][0]).toBe('/assets/scenes/main.scene.json');
  });

  it('still refuses to revert onto a DIFFERENT scene swapped in during Play', async () => {
    // The mismatch guard is why the path is captured at all; it must survive the fix, and it must
    // now compare like-for-like (both ends read the live identity).
    currentPath = SYNTH;
    filePath = null;
    await enterPlay();
    currentPath = '/assets/scenes/other.scene.json'; // a swap landed mid-play
    await stopPlay();
    expect(loadScene, 'no revert — the snapshot belongs to a scene that is no longer loaded')
      .not.toHaveBeenCalled();
  });

  it('an UNTITLED new scene does not revert under the PREVIOUS scene\'s identity', async () => {
    // ⚠️ The regression a blanket `sceneManager.getCurrent()?.path ?? getCurrentScenePath()` caused.
    // newScene() leaves sceneManager pointing at the OLD scene while nulling the file path, so
    // preferring the live path made Stop reload the blank untitled world under scene A's identity —
    // registering unrelated content as if it were A. Only the SYNTHETIC path may win that
    // preference.
    currentPath = '/assets/scenes/A.scene.json';   // stale — newScene did not touch sceneManager
    filePath = null;                                // untitled
    await enterPlay();
    await stopPlay();
    expect(loadScene.mock.calls[0]?.[0], 'must NOT impersonate scene A').not.toBe('/assets/scenes/A.scene.json');
  });
});
