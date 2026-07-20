/** Apply-to-Prefab must be undoable (engine-review editor-prefab-system.md F2).
 *
 *  Apply mutates TWO things — the prefab FILE (the shared base) and the live
 *  SCENE (every instance is re-instantiated; a promoted "added" child is deleted).
 *  A correct undo therefore records before/after of BOTH and reverses both:
 *  undo installs the BEFORE prefab snapshot AND rebuilds the scene from the BEFORE
 *  scene snapshot; redo re-installs the AFTER prefab + AFTER scene.
 *
 *  This pins the orchestration contract of `applyToPrefabWithUndo`: exactly one
 *  undo entry is pushed, and its undo/redo restore the right (prefab, scene) pair.
 *  The heavy collaborators (real apply, serialize, SceneManager) are mocked so the
 *  test exercises only the undo wiring. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UndoAction } from '../../src/editor/undo/undoManager';

const SRC = 'aaaaaaaa-0000-4000-8000-000000000002';
const prefabBefore = { id: SRC, version: 1, name: 'ship', rootLocalId: 1, entities: [{ localId: 1, name: 'Ship', traits: {} }] };
const prefabAfter = { id: SRC, version: 1, name: 'ship', rootLocalId: 1, entities: [{ localId: 1, name: 'Ship', traits: { Transform: { x: 5 } } }] };
const sceneBefore = { id: 'scene-1', entities: [{ id: 1, name: 'Ship', traits: {} }] };
const sceneAfter = { id: 'scene-1', entities: [{ id: 1, name: 'Ship', traits: { Transform: { x: 5 } } }] };

// serializeScene returns sceneBefore on the first call (pre-apply snapshot), then
// sceneAfter on the second (post-apply snapshot) — mirroring real ordering.
const serializeScene = vi.fn();
const saveScene = vi.fn(async () => {});
const installPrefabSnapshot = vi.fn(async () => {});
const loadScene = vi.fn(async () => {});
const selectEntity = vi.fn();
let pushed: UndoAction | null = null;
let applyResult: any;

vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: (...a: any[]) => serializeScene(...a),
  saveScene: (...a: any[]) => saveScene(...a),
  getCurrentScenePath: () => 'scenes/test.json',
  setCurrentScenePath: vi.fn(),
}));

vi.mock('../../src/editor/scene/prefab', () => ({
  applyToPrefabSelective: vi.fn(async () => applyResult),
  installPrefabSnapshot: (...a: any[]) => installPrefabSnapshot(...a),
  guidForEntityId: (id: number) => (id === 1 ? 'g-root' : ''),
  entityIdForGuid: (guid: string) => (guid === 'g-root' ? 1 : 0),
}));

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: { loadScene: (...a: any[]) => loadScene(...a) },
}));

vi.mock('../../src/editor/store/editorStore', () => ({
  useEditorStore: { getState: () => ({ selectEntity, selectedEntityId: 1 }) },
}));

vi.mock('../../src/editor/undo/undoManager', () => ({
  pushAction: (a: UndoAction) => { pushed = a; },
}));

async function getModule() { return import('../../src/editor/undo/applyPrefabUndo'); }

describe('applyToPrefabWithUndo — Apply is undoable, restores BOTH prefab + scene', () => {
  beforeEach(() => {
    serializeScene.mockReset();
    serializeScene.mockResolvedValueOnce(sceneBefore).mockResolvedValueOnce(sceneAfter);
    saveScene.mockClear();
    installPrefabSnapshot.mockClear();
    loadScene.mockClear();
    selectEntity.mockClear();
    pushed = null;
    applyResult = {
      applied: true, source: SRC,
      prefabBefore, prefabAfter,
      promotedAdditions: 1,
    };
  });

  it('pushes one undo action; undo restores BEFORE pair, redo restores AFTER pair', async () => {
    const { applyToPrefabWithUndo } = await getModule();

    await applyToPrefabWithUndo(1, new Set(['1.Transform.x']));

    // Exactly one undo entry pushed for the whole apply gesture.
    expect(pushed).not.toBeNull();
    expect(pushed!.label).toBe('Apply to Prefab');
    // A promotion (promotedAdditions>0) persists the post-apply scene to disk.
    expect(saveScene).toHaveBeenCalled();

    // ── undo: BEFORE prefab + BEFORE scene ──
    installPrefabSnapshot.mockClear(); loadScene.mockClear();
    await pushed!.undo();
    expect(installPrefabSnapshot).toHaveBeenCalledWith(SRC, prefabBefore);
    expect(loadScene).toHaveBeenCalledWith('scenes/test.json', { preloaded: sceneBefore });
    // selection re-anchored to the applied instance root by guid (id 1).
    expect(selectEntity).toHaveBeenLastCalledWith(1);

    // ── redo: AFTER prefab + AFTER scene ──
    installPrefabSnapshot.mockClear(); loadScene.mockClear();
    await pushed!.redo();
    expect(installPrefabSnapshot).toHaveBeenCalledWith(SRC, prefabAfter);
    expect(loadScene).toHaveBeenCalledWith('scenes/test.json', { preloaded: sceneAfter });
  });

  it('does not push an undo entry for a no-op apply', async () => {
    applyResult = { applied: false };
    const { applyToPrefabWithUndo } = await getModule();
    await applyToPrefabWithUndo(1, new Set());
    expect(pushed).toBeNull();
  });
});
