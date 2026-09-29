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
const saveScene = vi.fn<(...args: any[]) => Promise<unknown>>(async () => ({ saved: true, reason: 'ok' }));
/** The prefab half is ONE in-memory restore (#1868): it seats and parks, then runs its rebuild (the world restore). */
const restorePrefabsInMemory = vi.fn<(...args: any[]) => Promise<unknown>>(async (_restores: unknown, opts: { rebuild?: () => unknown }) => {
  await opts.rebuild?.();
});
const loadScene = vi.fn<(...args: any[]) => Promise<unknown>>(async () => ({ world: (await import('../../src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() }));
const selectEntity = vi.fn();
let pushed: UndoAction | null = null;
let applyResult: any;

const setCurrentBaseScene = vi.fn();
vi.mock('../../src/editor/scene/serialize', () => ({
  serializeScene: (...a: any[]) => serializeScene(...a),
  saveScene: (...a: any[]) => saveScene(...a),
  getCurrentScenePath: () => 'scenes/test.json',
  setCurrentScenePath: vi.fn(),
  setCurrentBaseScene: (...a: any[]) => setCurrentBaseScene(...a),
  isSceneLoadSwapping: () => false,
}));

vi.mock('../../src/editor/scene/prefabMemoryRestore', () => ({
  restorePrefabsInMemory: (...a: any[]) => restorePrefabsInMemory(...a),
}));

vi.mock('../../src/editor/scene/prefab', () => ({
  applyToPrefabSelective: vi.fn(async () => applyResult),
  guidForEntityId: (id: number) => (id === 1 ? 'g-root' : ''),
  entityIdForGuid: (guid: string) => (guid === 'g-root' ? 1 : 0),
  // #1431: undo/redo re-derive carried BASE instances; this suite's instance is primary, and its
  // subject is the prefab + primary scene pair — pinned in engine/tests/editor/applyPrefabDirtiesBase.test.ts.
  refreshBaseInstances: vi.fn(),
  // #1483: the restore rebases carried roots; nothing here is carried.
  rebaseStaleInstances: vi.fn(async () => 0),
}));

let currentBaseScene: string | undefined;
vi.mock('../../src/runtime/scene/SceneManager', () => ({
  // `getCurrent`: a real scene, so the Apply is not the prefab-edit world's (#1573).
  sceneManager: { loadScene: (...a: any[]) => loadScene(...a), getCurrentBaseScene: () => currentBaseScene, getCurrent: () => ({ path: '/scenes/main.json' }), getNext: () => null },
}));

vi.mock('../../src/editor/store/editorStore', () => ({
  // `showToast`: a refused scene save is one the user can fix, so its report toasts (#1695).
  useEditorStore: { getState: () => ({ selectEntity, selectedEntityId: 1, closePrefabEditor: () => {}, showToast: () => {} }) },
}));

vi.mock('../../src/editor/undo/undoManager', () => ({
  pushAction: (a: UndoAction) => { pushed = a; },
  // The restore reads its target from `currentSceneKey` (#1575), whose module registers a barrier on import.
  registerUndoRestoreBarrier: () => {},
  // A forward Apply holds world switches for its whole run (#1667).
  isWorldSwitchInProgress: () => false,
  beginWorldBoundOperation: () => () => {},
}));

async function getModule() {
  // `serialize.ts` is mocked whole, so it never binds the adoption owner's writers (#1698): bound here, with the base
  // write routed to the spy the A3 case asserts on — the restore's base write now goes through the owner.
  const { bindEditorSceneState } = await import('../../src/editor/scene/sceneAdoption');
  bindEditorSceneState({
    setScenePath: () => {}, setBaseScene: (b) => setCurrentBaseScene(b), markSaved: () => {},
    worldEdited: () => false, sceneLoadsComing: () => 0, sceneLoadsSwappingComing: () => 0,
  });
  return import('../../src/editor/undo/applyPrefabUndo');
}

describe('applyToPrefabWithUndo — Apply is undoable, restores BOTH prefab + scene', () => {
  beforeEach(() => {
    serializeScene.mockReset();
    serializeScene.mockResolvedValueOnce(sceneBefore).mockResolvedValueOnce(sceneAfter);
    saveScene.mockClear();
    restorePrefabsInMemory.mockClear();
    loadScene.mockClear();
    selectEntity.mockClear();
    setCurrentBaseScene.mockClear();
    currentBaseScene = undefined;
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
    // Not even a promotion (promotedAdditions>0) saves the scene (#1868): Unity's Apply never does.
    expect(saveScene).not.toHaveBeenCalled();

    // ── undo: BEFORE prefab + BEFORE scene ──
    restorePrefabsInMemory.mockClear(); loadScene.mockClear(); saveScene.mockClear();
    await pushed!.undo();
    // In memory, from the other side (#1868), and no scene save.
    expect(restorePrefabsInMemory).toHaveBeenCalledWith([{ source: SRC, doc: prefabBefore, from: prefabAfter }], expect.anything());
    expect(saveScene).not.toHaveBeenCalled();
    expect(loadScene).toHaveBeenCalledWith('scenes/test.json', { preloaded: sceneBefore });
    // selection re-anchored to the applied instance root by guid (id 1).
    expect(selectEntity).toHaveBeenLastCalledWith(1);

    // ── redo: AFTER prefab + AFTER scene ──
    restorePrefabsInMemory.mockClear(); loadScene.mockClear();
    await pushed!.redo();
    expect(restorePrefabsInMemory).toHaveBeenCalledWith([{ source: SRC, doc: prefabAfter, from: prefabBefore }], expect.anything());
    expect(loadScene).toHaveBeenCalledWith('scenes/test.json', { preloaded: sceneAfter });
  });

  // A3 (base-scene plan, Phase 1): sceneManager.loadScene({preloaded}) records a
  // restored scene's baseScene ref internally, but the editor's own tracking
  // (re-emitted by serializeScene) is separate module state — restoreSnapshot must
  // re-sync it explicitly, exactly like it does for setCurrentScenePath, or a
  // post-undo save would silently drop the base ref.
  it('re-syncs the editor baseScene tracking after restoreSnapshot reloads the scene', async () => {
    const { applyToPrefabWithUndo } = await getModule();
    await applyToPrefabWithUndo(1, new Set(['1.Transform.x']));

    currentBaseScene = 'base-guid-after-undo';
    setCurrentBaseScene.mockClear();
    await pushed!.undo();
    expect(setCurrentBaseScene).toHaveBeenCalledWith('base-guid-after-undo');
  });

  // #1258: the agent `apply` op answers with `result.warnings`, and this wrapper is the layer between it and
  // applyToPrefabSelective, which fills them. A wrapper that rebuilt its result would empty the agent's list silently.
  it('hands back the validation warnings applyToPrefabSelective reported, the same list', async () => {
    const warnings = ['entity[localId=1] "Ship".UIElement.width is inert'];
    applyResult = { ...applyResult, warnings };
    const { applyToPrefabWithUndo } = await getModule();
    const result = await applyToPrefabWithUndo(1, new Set(['1.Transform.x']));
    expect(result.warnings).toBe(warnings);
  });

  it('does not push an undo entry for a no-op apply', async () => {
    applyResult = { applied: false };
    const { applyToPrefabWithUndo } = await getModule();
    await applyToPrefabWithUndo(1, new Set());
    expect(pushed).toBeNull();
  });
});

/** #1868 (it supersedes #1695's scene half): an Apply and its undo and redo NEVER save the scene — Unity's Apply never
 *  does; a promotion leaves the scene dirty, as every undo does. Before, the forward Apply saved it on a promotion, and
 *  the undo and redo then saved it over the other half's bytes, which needed #1695's precondition to stay safe.
 *  Mutation: put the forward promotion save back in `applyHeld` — this goes red. */
describe('Apply, its undo and its redo never save the scene (#1868)', () => {
  beforeEach(() => {
    serializeScene.mockReset();
    serializeScene.mockResolvedValueOnce(sceneBefore).mockResolvedValueOnce(sceneAfter);
    pushed = null;
    saveScene.mockClear();
  });

  it('a promotion Apply, undone and redone, saves nothing', async () => {
    applyResult = { applied: true, source: SRC, prefabBefore, prefabAfter, promotedAdditions: 1 };
    const { applyToPrefabWithUndo } = await getModule();
    await applyToPrefabWithUndo(1, new Set(['+added.x']));
    await pushed!.undo();
    await pushed!.redo();
    expect(saveScene).not.toHaveBeenCalled();
  });
});
