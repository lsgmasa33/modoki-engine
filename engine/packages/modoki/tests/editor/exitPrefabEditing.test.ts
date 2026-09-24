/** exitPrefabEditing's fallback, when there is no `prefabReturnScenePath` (entering
 *  prefab-edit from a project with no scene loaded). #478: this used to read the
 *  UNSCOPED `modoki-last-scene` localStorage key — global across every project
 *  sharing the origin, so a boot with no scene loaded still held the PREVIOUS
 *  project's path and would try (and fail) to load it. It now reads the same
 *  per-project key `setCurrentScenePath` writes (`lastSceneKey`, scene/serialize.ts). */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Node environment — no jsdom, so no localStorage (see lastSkinRigRestore.test.ts, the
// #473 scoping tests this mirrors). The module only needs get/set/remove.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
});

const loadScene = vi.fn(async (_path: string) => {});
vi.mock('../../src/editor/scene/serialize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/editor/scene/serialize')>();
  return { ...actual, loadScene: (p: string) => loadScene(p) };
});

// The editor's copy of the prefab that was open is re-read on exit (#1483 review) — recorded with what the
// editor state was at the moment of the call, since the refresh skips a prefab that is still open.
const refreshed: { path: string; editingAtCall: unknown }[] = [];
vi.mock('../../src/editor/scene/prefab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/editor/scene/prefab')>();
  return {
    ...actual,
    refreshPrefabSourceForPath: async (path: string) => {
      const { useEditorStore: store } = await import('../../src/editor/store/editorStore');
      refreshed.push({ path, editingAtCall: store.getState().editingPrefab });
    },
    rebaseStaleInstances: async () => { refreshed.push({ path: '<rebase>', editingAtCall: null }); return 0; },
  };
});

import { useEditorStore } from '../../src/editor/store/editorStore';
import { exitPrefabEditing, PREFAB_EDIT_SCENE_PREFIX } from '../../src/editor/scene/prefabEdit';
import { lastSceneKey, setScenePersistenceProject } from '../../src/editor/scene/serialize';

const PREFAB = { path: '/games/x/assets/prefabs/Ship.prefab.json', guid: 'g-ship', name: 'Ship' };

beforeEach(() => {
  refreshed.length = 0;
  loadScene.mockClear();
  localStorage.clear();
  useEditorStore.getState().closePrefabEditor();
  setScenePersistenceProject('current-project');
});

describe('exitPrefabEditing — return-scene fallback', () => {
  it('uses prefabReturnScenePath when set, ignoring localStorage entirely', async () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, '/assets/scenes/Station.json');
    localStorage.setItem(lastSceneKey('current-project'), '/assets/scenes/other.json');

    const target = await exitPrefabEditing();

    expect(target).toBe('/assets/scenes/Station.json');
    expect(loadScene).toHaveBeenCalledWith('/assets/scenes/Station.json');
  });

  it('with prefabReturnScenePath empty, falls back to the SCOPED per-project key, not a global one', async () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, null);
    localStorage.setItem(lastSceneKey('current-project'), '/assets/scenes/remembered.json');

    const target = await exitPrefabEditing();

    expect(target).toBe('/assets/scenes/remembered.json');
    expect(loadScene).toHaveBeenCalledWith('/assets/scenes/remembered.json');
  });

  it('ignores a stale UNSCOPED modoki-last-scene left by another project (the #478 regression)', async () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, null);
    // A previous project's boot left the old unscoped key behind. Nothing in this
    // codebase writes it any more, but a pre-existing browser profile can still carry
    // one from before the fix — it must never be read.
    localStorage.setItem('modoki-last-scene', '/games/other-project/assets/scenes/main.json');
    // No scoped key for THIS project — simulates "no scene loaded yet" at boot.

    const target = await exitPrefabEditing();

    expect(target).toBeNull();
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('skips a synthetic prefab-edit path even if it were the stored fallback', async () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, null);
    localStorage.setItem(lastSceneKey('current-project'), `${PREFAB_EDIT_SCENE_PREFIX}some-other-guid`);

    const target = await exitPrefabEditing();

    expect(target).toBeNull();
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('clears the prefab-edit store flags either way', async () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, '/assets/scenes/Station.json');
    await exitPrefabEditing();
    expect(useEditorStore.getState().editingPrefab).toBeNull();
    expect(useEditorStore.getState().prefabReturnScenePath).toBeNull();
  });
});

describe('exitPrefabEditing re-reads the editor`s copy of the prefab that was open (#1483 review)', () => {
  // Mutation: drop the refresh from exitPrefabEditing, or run it before closePrefabEditor (the refresh skips
  // the prefab still open, so it would re-read nothing).
  it('after the editor is closed, so the refresh does not skip it as the prefab being edited', async () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, '/assets/scenes/Station.json');
    await exitPrefabEditing();
    // …and then rebuilds a carried (Persistent) instance a saved edit left stale (close-out review 2).
    expect(refreshed).toEqual([{ path: PREFAB.path, editingAtCall: null }, { path: '<rebase>', editingAtCall: null }]);
  });
});
