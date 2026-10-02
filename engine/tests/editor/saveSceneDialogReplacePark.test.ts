/** #2050, the dialog half: an untitled scene saved through the Save dialog with REPLACE swaps an existing file's bytes for
 *  its own, exactly as a Save As does, so a `baseScene` edit parked on that file goes with them
 *  (`dropReplacedBaseSceneEdit`). The native panel and the create-only write are mocked — a test cannot answer the panel
 *  (docs/editor.md § Panels) — so this pins the branch's decision, not the dialog. The agent and Save As halves:
 *  saveSceneAs.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { clearHistory, clearDirtyAssets, saveScene, setCurrentScenePath, markSceneSaved } from '@modoki/engine/editor';
import { markBaseSceneEdit, getPendingBaseScenePaths, clearPendingBaseScenes } from '../../packages/modoki/src/editor/scene/pendingBaseScene';
import { registerAllTraits } from '../../app/ecs/registerTraits';

const TARGET = '/assets/scenes/existing.scene.json';
let outcome: 'replaced' | 'created' = 'replaced';

vi.mock('../../packages/modoki/src/editor/utils/saveDialog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chooseNewAssetPath: async () => ({ path: TARGET, confirmReplace: async () => true }),
}));
vi.mock('../../packages/modoki/src/editor/scene/createAssetDocument', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeNewAssetDocument: async () => ({ outcome, path: TARGET, guid: '00000041-0000-4000-8000-000000000041' }),
}));

registerAllTraits();
let game: TestWorld | undefined;

beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' })));
  setCurrentScenePath(null);
  markSceneSaved();
  markBaseSceneEdit(TARGET, '/assets/scenes/Base.scene.json');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  clearPendingBaseScenes();
  game?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Save dialog → Replace over a file holding a parked baseScene edit (#2050)', () => {
  it('a Replace drops the park and reports it', async () => {
    outcome = 'replaced';
    const r = await saveScene({ allowDialog: true });
    expect(r).toMatchObject({ saved: true, path: TARGET, droppedBaseSceneEdit: true });
    expect(getPendingBaseScenePaths()).not.toContain(TARGET);
  });

  it('a Create (no file was there) drops nothing', async () => {
    outcome = 'created';
    const r = await saveScene({ allowDialog: true });
    expect(r.saved).toBe(true);
    expect(r.droppedBaseSceneEdit).toBeUndefined();
    expect(getPendingBaseScenePaths()).toContain(TARGET);
  });
});
