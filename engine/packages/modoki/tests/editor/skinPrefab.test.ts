/** makeRigPrefabAsset's undo/redo closures (#308) — both directions used to discard
 *  writeAssetFile/deleteAssetFile's boolean AND then update `setPrefabCache`
 *  unconditionally, so a failed backend write left the in-memory cache reverted
 *  while the file on disk stayed un-reverted (surfacing only on the next scene
 *  load / editor relaunch, which reads the FILE). The fix guards the cache update
 *  on the write/delete actually succeeding and reports through `reportUndoFailure`.
 *
 *  The forward (create) flow and its ECS/serialization dependencies are mocked out
 *  entirely — this file is only about the undo/redo closures' handling of a failed
 *  backend call, not about prefab serialization itself (covered elsewhere). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const registerAssetSpy = vi.fn();
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  registerAsset: (...args: unknown[]) => registerAssetSpy(...args),
  getGuidForPath: (path: string) => (path === '/rigs/existing.prefab.json' ? 'g-existing' : undefined),
}));

vi.mock('../../src/runtime/skinning/rig2dTypes', () => ({
  coerceRigBones: (bones: unknown) => bones,
}));

const spawnEntitySubtreeSpy = vi.fn((..._args: unknown[]) => 42);
vi.mock('../../src/editor/undo/entityActions', () => ({
  spawnEntitySubtree: (...args: unknown[]) => spawnEntitySubtreeSpy(...args),
}));

const deleteEntitySpy = vi.fn((..._args: unknown[]) => undefined);
vi.mock('../../src/runtime/core/ecs/entityUtils', () => ({
  deleteEntity: (...args: unknown[]) => deleteEntitySpy(...args),
}));

const setPrefabCacheSpy = vi.fn((..._args: unknown[]) => undefined);
const serializePrefabSpy = vi.fn((..._args: unknown[]) => ({ id: 'g-new', root: {} }));
vi.mock('../../src/editor/scene/prefab', () => ({
  serializePrefab: (...args: unknown[]) => serializePrefabSpy(...args),
  setPrefabCache: (...args: unknown[]) => setPrefabCacheSpy(...args),
}));

let writeResult = true;
let deleteResult = true;
const writeAssetFileSpy = vi.fn(async (..._args: unknown[]) => writeResult);
const deleteAssetFileSpy = vi.fn(async (..._args: unknown[]) => deleteResult);
vi.mock('../../src/editor/panels/assetOps', () => ({
  writeAssetFile: (...args: unknown[]) => writeAssetFileSpy(...args),
  deleteAssetFile: (...args: unknown[]) => deleteAssetFileSpy(...args),
}));

const pushActionSpy = vi.fn();
vi.mock('../../src/editor/undo/undoManager', () => ({
  pushAction: (...args: unknown[]) => pushActionSpy(...args),
}));

const reportUndoFailureSpy = vi.fn();
vi.mock('../../src/editor/undo/undoFailure', () => ({
  reportUndoFailure: (...args: unknown[]) => reportUndoFailureSpy(...args),
}));

import { makeRigPrefabAsset } from '../../src/editor/scene/skinPrefab';

const RIG_BONES = [{ x: 0, y: 0, rot: 0, name: 'root', parent: -1 }];

beforeEach(() => {
  writeResult = true;
  deleteResult = true;
  registerAssetSpy.mockClear();
  spawnEntitySubtreeSpy.mockClear();
  deleteEntitySpy.mockClear();
  setPrefabCacheSpy.mockClear();
  serializePrefabSpy.mockClear();
  writeAssetFileSpy.mockClear();
  deleteAssetFileSpy.mockClear();
  pushActionSpy.mockClear();
  reportUndoFailureSpy.mockClear();
});

// Unstub in afterEach, NOT at the end of the test body: a failing assertion skips the
// rest of the body, so an inline unstub never runs and `fetch` stays stubbed for every
// later test — one real regression then cascades into several misleading failures. Same
// reasoning as the console-spy restore in assetUndo.test.ts.
afterEach(() => { vi.unstubAllGlobals(); });

describe('makeRigPrefabAsset undo/redo — fresh create (no prior prefab)', () => {
  it('redo does not update setPrefabCache and REPORTS when the write fails', async () => {
    serializePrefabSpy.mockReturnValue({ id: 'g-new', root: {} } as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/new.prefab.json', 'Rig');
    expect(result).toEqual({ path: '/new.prefab.json', updated: false });
    expect(pushActionSpy).toHaveBeenCalledTimes(1);
    const action = pushActionSpy.mock.calls[0][0];

    setPrefabCacheSpy.mockClear();
    registerAssetSpy.mockClear();
    writeResult = false; // the redo's own write now fails
    await action.redo();

    expect(reportUndoFailureSpy).toHaveBeenCalledTimes(1);
    const call = reportUndoFailureSpy.mock.calls[0][0];
    expect(call.direction).toBe('Redo');
    expect(call.detail).toContain('/new.prefab.json');
    // Neither dependent update happened — the cache must not diverge from the
    // (unwritten) file.
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
    expect(registerAssetSpy).not.toHaveBeenCalled();
  });

  it('undo (delete) does not clear setPrefabCache and REPORTS when the delete fails', async () => {
    serializePrefabSpy.mockReturnValue({ id: 'g-new', root: {} } as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/new2.prefab.json', 'Rig2');
    expect(result).not.toBeNull();
    const action = pushActionSpy.mock.calls[0][0];

    setPrefabCacheSpy.mockClear();
    deleteResult = false; // undo's delete fails
    await action.undo();

    expect(reportUndoFailureSpy).toHaveBeenCalledTimes(1);
    const call = reportUndoFailureSpy.mock.calls[0][0];
    expect(call.direction).toBe('Undo');
    expect(call.detail).toContain('/new2.prefab.json');
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
  });
});

describe('makeRigPrefabAsset undo — update (a prior prefab existed)', () => {
  it('undo (restore) does not set setPrefabCache to the old content and REPORTS when the write fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{"id":"g-existing","old":true}' }));
    vi.stubGlobal('fetch', fetchMock);

    serializePrefabSpy.mockReturnValue({ id: 'g-existing', root: {} } as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig3');
    expect(result).toEqual({ path: '/rigs/existing.prefab.json', updated: true });
    const action = pushActionSpy.mock.calls[0][0];

    setPrefabCacheSpy.mockClear();
    writeResult = false; // the restore write fails
    await action.undo();

    expect(reportUndoFailureSpy).toHaveBeenCalledTimes(1);
    const call = reportUndoFailureSpy.mock.calls[0][0];
    expect(call.direction).toBe('Undo');
    expect(call.detail).toContain('/rigs/existing.prefab.json');
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
  });
});

// #C-6 (#308 close-out): all three describe blocks above only assert the FAILURE branch —
// none pins that a successful write/delete actually updates setPrefabCache/registerAsset with
// the right arguments. Also adds the redo-UPDATE case, which existed nowhere (only
// redo-fresh-create and undo restore/delete were covered).
describe('makeRigPrefabAsset undo/redo — success paths', () => {
  it('redo (fresh create) writes the content and calls setPrefabCache/registerAsset with it', async () => {
    const prefab = { id: 'g-new', root: {} };
    serializePrefabSpy.mockReturnValue(prefab as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/new3.prefab.json', 'Rig4');
    expect(result).toEqual({ path: '/new3.prefab.json', updated: false });
    const action = pushActionSpy.mock.calls[0][0];

    writeAssetFileSpy.mockClear();
    setPrefabCacheSpy.mockClear();
    registerAssetSpy.mockClear();
    await action.redo();

    expect(reportUndoFailureSpy).not.toHaveBeenCalled();
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/new3.prefab.json', JSON.stringify(prefab, null, 2));
    expect(registerAssetSpy).toHaveBeenCalledWith('g-new', '/new3.prefab.json', 'prefab');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-new', prefab);
  });

  it('undo (delete, fresh create) deletes the file and clears setPrefabCache with the right key', async () => {
    const prefab = { id: 'g-new2', root: {} };
    serializePrefabSpy.mockReturnValue(prefab as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/new4.prefab.json', 'Rig5');
    expect(result).toEqual({ path: '/new4.prefab.json', updated: false });
    const action = pushActionSpy.mock.calls[0][0];

    deleteAssetFileSpy.mockClear();
    setPrefabCacheSpy.mockClear();
    await action.undo();

    expect(reportUndoFailureSpy).not.toHaveBeenCalled();
    expect(deleteAssetFileSpy).toHaveBeenCalledWith('/new4.prefab.json');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-new2', null);
  });

  it('undo (restore, update) restores the PRIOR content and setPrefabCache with the parsed old doc', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{"id":"g-existing","old":true}' }));
    vi.stubGlobal('fetch', fetchMock);

    serializePrefabSpy.mockReturnValue({ id: 'g-existing', root: { new: true } } as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig6');
    expect(result).toEqual({ path: '/rigs/existing.prefab.json', updated: true });
    const action = pushActionSpy.mock.calls[0][0];

    writeAssetFileSpy.mockClear();
    setPrefabCacheSpy.mockClear();
    await action.undo();

    expect(reportUndoFailureSpy).not.toHaveBeenCalled();
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-existing', { id: 'g-existing', old: true });
  });

  // The redo-UPDATE case: forward-writes the NEW content again (not the old snapshot), keyed
  // by the prefab's (preserved) existing identity — untested anywhere before this.
  it('redo (update) re-writes the NEW content and setPrefabCache/registerAsset under the existing id', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '{"id":"g-existing","old":true}' }));
    vi.stubGlobal('fetch', fetchMock);

    const newPrefab = { id: 'g-existing', root: { new: true } };
    serializePrefabSpy.mockReturnValue(newPrefab as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig7');
    expect(result).toEqual({ path: '/rigs/existing.prefab.json', updated: true });
    const action = pushActionSpy.mock.calls[0][0];

    writeAssetFileSpy.mockClear();
    setPrefabCacheSpy.mockClear();
    registerAssetSpy.mockClear();
    await action.redo();

    expect(reportUndoFailureSpy).not.toHaveBeenCalled();
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/rigs/existing.prefab.json', JSON.stringify(newPrefab, null, 2));
    expect(registerAssetSpy).toHaveBeenCalledWith('g-existing', '/rigs/existing.prefab.json', 'prefab');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-existing', newPrefab);
  });
});
