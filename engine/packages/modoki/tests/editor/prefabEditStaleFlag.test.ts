/** isEditingPrefab ground-truths prefab-edit mode against the LIVE scene, not the
 *  editingPrefab store flag alone. The flag can go stale when you return to a real
 *  scene without an explicit exit (e.g. loading a scene directly while the flag is
 *  set, or nested prefab editing). A stale flag routed Cmd+S to savePrefabEdit,
 *  which then errored "prefab root not found". isEditingPrefab must report false
 *  AND self-heal the flag in that case. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentPath: string | null = null;
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: { getCurrent: () => (currentPath ? { path: currentPath } : null) },
}));

import { useEditorStore } from '../../src/editor/store/editorStore';
import { isEditingPrefab, PREFAB_EDIT_SCENE_PREFIX } from '../../src/editor/scene/prefabEdit';

const PREFAB = { path: '/games/x/assets/prefabs/Ship.prefab.json', guid: 'g-ship', name: 'Ship' };

beforeEach(() => {
  currentPath = null;
  useEditorStore.getState().closePrefabEditor();
});

describe('isEditingPrefab', () => {
  it('false when not editing', () => {
    expect(isEditingPrefab()).toBe(false);
  });

  it('true while the live scene IS the prefab-edit world', () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, '/games/x/assets/scenes/Station.json');
    currentPath = `${PREFAB_EDIT_SCENE_PREFIX}${PREFAB.guid}`;
    expect(isEditingPrefab()).toBe(true);
    expect(useEditorStore.getState().editingPrefab).not.toBeNull(); // flag preserved
  });

  it('false + self-heals when the flag is set but the live scene is a real scene', () => {
    useEditorStore.getState().openPrefabEditor(PREFAB, '/games/x/assets/scenes/Station.json');
    currentPath = '/games/space-console/assets/scenes/Station.json';
    expect(isEditingPrefab()).toBe(false);
    expect(useEditorStore.getState().editingPrefab).toBeNull(); // stale flag cleared
  });
});
