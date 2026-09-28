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
  // #1468: the existing-id lookup moved off `getGuidForPath` (manifest only, so it minted a fresh
  // guid over a prefab the scanner had not indexed yet) onto the shared classifier. Mirrored here
  // against the same fixture path the mocked manifest answers for, so these tests keep driving the
  // same two cases — fresh create, and update over an existing prefab.
  classifyExistingPrefabId: async (path: string) => (
    path === '/rigs/existing.prefab.json'
      ? { kind: 'known', id: 'g-existing' }
      : { kind: 'mintable', reason: 'absent' }
  ),
}));

let writeResult = true;
let deleteResult = true;
/** The prefab files as the writes left them — the bytes each write SENT, so the preconditions below (#1679) compare the
 *  hash the step sends against what was really written, as `/api/write-file` and `/api/delete-asset` do. */
const disk = vi.hoisted(() => new Map<string, string>());
const hashOf = (t: string) => createHash('sha256').update(t).digest('hex');
const writeAssetFileSpy = vi.fn(async (path: string, content: string) => { if (writeResult) disk.set(path, content); return writeResult; });
const deleteAssetFileSpy = vi.fn();
vi.mock('../../src/editor/panels/assetOps', async (importOriginal) => ({
  // The REAL `readPriorDocument`, over the test's stubbed `fetch` — a copy here once modelled a failed read as
  // "absent", the opposite of the function it stood in for (close-out re-review).
  ...(await importOriginal<Record<string, unknown>>()),
}));

// Every write, forward and undo, is ONE `commitPrefabWrite` (#1692). Modelled over `disk` with the route's rules: the
// precondition over the bytes the disk holds (`expected` null means "nothing there"), then — only once it landed — the
// manifest and the editor cache. The real step's hashing and rebuild are driven unmocked in prefabCommit.test.ts.
vi.mock('../../src/editor/scene/prefabCommit', () => ({
  parsePrefabBytes: (text: string) => JSON.parse(text.replace(/^\uFEFF/, '')),
  commitPrefabWrite: async (path: string, doc: { id?: string } | null, opts: { expected: unknown; bytes?: string }) => {
    const next = doc === null ? null : (opts.bytes ?? jsonFileBody(doc));
    if (next === null ? !deleteResult : !writeResult) return { ok: false, path };
    const cur = disk.get(path);
    const exp = opts.expected === null ? null : typeof opts.expected === 'string' ? opts.expected : jsonFileBody(opts.expected);
    if (exp === null ? cur !== undefined : (cur === undefined || hashOf(cur) !== hashOf(exp))) return { ok: false, conflict: true, path };
    const guid = doc?.id ?? (exp ? (JSON.parse(exp) as { id?: string }).id : undefined);
    if (next === null) { deleteAssetFileSpy(path); disk.delete(path); }
    else { await writeAssetFileSpy(path, next); registerAssetSpy(guid, path, 'prefab'); }
    if (guid) setPrefabCacheSpy(guid, doc);
    return { ok: true, path };
  },
}));

const pushActionSpy = vi.fn();
vi.mock('../../src/editor/undo/undoManager', () => ({
  pushAction: (...args: unknown[]) => pushActionSpy(...args),
}));

const reportUndoFailureSpy = vi.fn();
vi.mock('../../src/editor/undo/undoFailure', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportUndoFailure: (...args: unknown[]) => reportUndoFailureSpy(...args),
}));

import { createHash } from 'node:crypto';
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { return await fn(); } finally { spy.mockRestore(); }
};
import { makeRigPrefabAsset } from '../../src/editor/scene/skinPrefab';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';
import { jsonFileBody } from '../../src/editor/backend/editorBackend';

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
  disk.clear();
  writeResult = true; deleteResult = true;
  // Nothing at any path unless a test says so: the prior read is decided by the FILE (#1679), and an unstubbed fetch
  // would THROW — which is "something there that did not read", not a fresh create.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
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
    // The prior prefab is ON DISK (the update is conditional on it, #1692) and served by the read.
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    const fetchMock = vi.fn(async () => new Response('{"id":"g-existing","old":true}', { status: 200 }));
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
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/new3.prefab.json', jsonFileBody(prefab));
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
    // The prior prefab is ON DISK (the update is conditional on it, #1692) and served by the read.
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    const fetchMock = vi.fn(async () => new Response('{"id":"g-existing","old":true}', { status: 200 }));
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
    expect(disk.get('/rigs/existing.prefab.json')).toBe('{"id":"g-existing","old":true}');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-existing', { id: 'g-existing', old: true });
  });

  // The redo-UPDATE case: forward-writes the NEW content again (not the old snapshot), keyed
  // by the prefab's (preserved) existing identity — untested anywhere before this.
  it('redo (update) re-writes the NEW content and setPrefabCache/registerAsset under the existing id', async () => {
    // The prior prefab is ON DISK (the update is conditional on it, #1692) and served by the read.
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    const fetchMock = vi.fn(async () => new Response('{"id":"g-existing","old":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const newPrefab = { id: 'g-existing', root: { new: true } };
    serializePrefabSpy.mockReturnValue(newPrefab as any);
    const result = await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig7');
    expect(result).toEqual({ path: '/rigs/existing.prefab.json', updated: true });
    // The mock returns `id: 'g-existing'` whatever it is given, so the id assertions below cannot
    // tell an update that KEPT the prefab's GUID from one that minted a new one. Pin the argument
    // the update actually passes (#1670).
    expect(serializePrefabSpy).toHaveBeenCalledWith(expect.anything(), 'g-existing');
    const action = pushActionSpy.mock.calls[0][0];

    writeAssetFileSpy.mockClear();
    setPrefabCacheSpy.mockClear();
    registerAssetSpy.mockClear();
    await action.redo();

    expect(reportUndoFailureSpy).not.toHaveBeenCalled();
    expect(writeAssetFileSpy).toHaveBeenCalledWith('/rigs/existing.prefab.json', jsonFileBody(newPrefab));
    expect(registerAssetSpy).toHaveBeenCalledWith('g-existing', '/rigs/existing.prefab.json', 'prefab');
    expect(setPrefabCacheSpy).toHaveBeenCalledWith('g-existing', newPrefab);
  });
});

/** #1679 — the prefab file is global, and this entry outlives a later save of it (open the skin prefab, edit, Cmd+S,
 *  then Cmd+Z here). Each half changes the file only while it holds what the other half left there, and otherwise
 *  REFUSES with nothing changed. Mutations, each checked red on its own case: the undo expecting the wrong bytes, the
 *  redo expecting nothing after an update's undo (accept case), and the redo ignoring an undo that did not apply. The
 *  preconditions themselves live in `replaceFileIfMatch`, mutation-checked in createPrefabUndo.test.ts. */
describe('makeRigPrefabAsset — undo/redo preconditions (#1679)', () => {
  const make = async (path: string, prior?: string) => {
    if (prior !== undefined) {
      disk.set(path, prior);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(prior, { status: 200 })));
    }
    serializePrefabSpy.mockReturnValue({ id: prior !== undefined ? 'g-existing' : 'g-new', root: { v: 2 } } as any);
    expect(await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, path, 'Rig')).not.toBeNull();
    return pushActionSpy.mock.calls.at(-1)![0];
  };

  it('undo of a fresh create refuses to delete a prefab saved since, and changes nothing', async () => {
    const action = await make('/fresh.prefab.json');
    disk.set('/fresh.prefab.json', '{"edited":true}');
    setPrefabCacheSpy.mockClear();
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(disk.get('/fresh.prefab.json')).toBe('{"edited":true}');
    expect(setPrefabCacheSpy).not.toHaveBeenCalled();
  });

  it('undo of an update refuses to restore over a prefab saved since', async () => {
    const action = await make('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","edited":true}');
    await expect(action.undo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(disk.get('/rigs/existing.prefab.json')).toContain('edited');
  });

  it('redo of a fresh create refuses a prefab made at the path since', async () => {
    const action = await make('/fresh.prefab.json');
    await action.undo();
    disk.set('/fresh.prefab.json', '{"someone":"else"}');
    await expect(action.redo()).rejects.toBeInstanceOf(UndoRefusedError);
    expect(disk.get('/fresh.prefab.json')).toBe('{"someone":"else"}');
  });

  it('accept side: create and update both round-trip undo → redo → undo', async () => {
    const created = await make('/fresh.prefab.json');
    const written = disk.get('/fresh.prefab.json');
    await created.undo(); expect(disk.has('/fresh.prefab.json')).toBe(false);
    await created.redo(); expect(disk.get('/fresh.prefab.json')).toBe(written);
    await created.undo(); expect(disk.has('/fresh.prefab.json')).toBe(false);

    const updated = await make('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    const after = disk.get('/rigs/existing.prefab.json');
    await updated.undo(); expect(disk.get('/rigs/existing.prefab.json')).toBe('{"id":"g-existing","old":true}');
    await updated.redo(); expect(disk.get('/rigs/existing.prefab.json')).toBe(after);
  });

  // #1692: the update is conditional on what it read, so an unreadable prior refuses the UPDATE itself — before, it
  // wrote blind and left an undo that could only report it had nothing to restore. Never a create, never a trash.
  it('an update whose prior prefab could not be READ is not a create: it is refused, and the file is left as it is', async () => {
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('backend restarting'); }));
    serializePrefabSpy.mockReturnValue({ id: 'g-existing', root: { v: 2 } } as any);
    const pushes = pushActionSpy.mock.calls.length;
    expect(await quietly(() => makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig'))).toBeNull();
    expect(disk.get('/rigs/existing.prefab.json')).toBe('{"id":"g-existing","old":true}');
    expect(pushActionSpy.mock.calls.length).toBe(pushes);
    expect(deleteAssetFileSpy).not.toHaveBeenCalled();
  });

  it('an id-less prefab already at the path is still read and restored — the read is decided by the FILE, not the id', async () => {
    const prior = '{"name":"no id yet"}';
    disk.set('/fresh.prefab.json', prior);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(prior, { status: 200 })));
    serializePrefabSpy.mockReturnValue({ id: 'g-new', root: { v: 2 } } as any);
    // The mocked classifier calls this path free ('mintable'), as the real one does for an id-less file.
    expect(await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/fresh.prefab.json', 'Rig')).toEqual({ path: '/fresh.prefab.json', updated: true });
    await pushActionSpy.mock.calls.at(-1)![0].undo();
    expect(disk.get('/fresh.prefab.json')).toBe(prior);
  });

  it('a redo after an undo that FAILED expects the bytes still there', async () => {
    const action = await make('/fresh.prefab.json');
    deleteResult = false;
    await action.undo(); // reported, not applied
    deleteResult = true;
    await action.redo(); // must not refuse
    expect(disk.has('/fresh.prefab.json')).toBe(true);
  });
});
