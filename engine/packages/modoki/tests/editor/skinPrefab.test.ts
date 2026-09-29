/** makeRigPrefabAsset's forward write and its undo entry (#1868, D1 = Park). A FRESH make is a new asset, saved on
 *  creation, and pushes no entry. An UPDATE's undo and redo restore the prefab IN MEMORY through
 *  `restorePrefabsInMemory` — by the prefab's guid, from the side the other half left — and write nothing; the park they
 *  leave is Save's to write. The #308/#1679 cases (a failed or refused backend write inside an undo) went with the write.
 *
 *  The forward flow's ECS/serialization dependencies are mocked out entirely; `restorePrefabsInMemory` itself is driven
 *  unmocked in tests/editor/prefabPark.test.ts and the engine Apply suites.
 *
 *  The forward write is ONE `commitPrefabWrite`, a model here: what a case asserts is which document LANDED (`landedSpy`),
 *  and that skinPrefab never seats a cache or registers an asset on its own (afterEach) — a spy the model itself called
 *  could only ever measure the model (#1670). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const registerAssetSpy = vi.fn();
// Spread over the real module, not an explicit list: a module this file's graph reaches later (#1751's move re-key put
// the runtime cache under the Assets panel's) needs exports this test never names.
vi.mock('../../src/runtime/loaders/assetManifest', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
/** One call per commit the model LANDED: `(path, doc)`, `doc` null for a delete. */
const landedSpy = vi.fn((..._args: unknown[]) => undefined);
const serializePrefabSpy = vi.fn((..._args: unknown[]) => ({ id: 'g-new', root: {} }));
/** Prefabs parked for Save (#1868), by path — what `parkedPrefabRead` answers. */
const parked = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../src/editor/scene/prefab', () => ({}));
vi.mock('../../src/editor/scene/prefabCache', () => ({
  parkedPrefabRead: (path: string) => (parked.has(path) ? JSON.parse(JSON.stringify(parked.get(path))) : null),
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
vi.mock('../../src/editor/scene/prefabTokens', () => ({}));
vi.mock('../../src/editor/scene/prefabMembers', () => ({}));
vi.mock('../../src/editor/scene/prefabInstanceOverrides', () => ({}));
vi.mock('../../src/editor/scene/prefabCapture', () => ({}));
vi.mock('../../src/editor/scene/prefabFrames', () => ({}));
vi.mock('../../src/editor/scene/prefabInstantiate', () => ({}));
vi.mock('../../src/editor/scene/prefabChain', () => ({}));
vi.mock('../../src/editor/scene/prefabRebuild', () => ({}));
vi.mock('../../src/editor/scene/prefabSerialize', () => ({
  serializeRebuildOver: (...args: unknown[]) => serializePrefabSpy(...args),
}));
vi.mock('../../src/editor/scene/prefabApplyStructure', () => ({}));
vi.mock('../../src/editor/scene/prefabApply', () => ({}));
vi.mock('../../src/editor/scene/prefabLink', () => ({}));
vi.mock('../../src/editor/scene/prefabRevert', () => ({}));

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
// precondition over the bytes the disk holds (`expected` null means "nothing there"), then the write or delete. The real step's hashing and rebuild are driven unmocked in prefabCommit.test.ts.
vi.mock('../../src/editor/scene/prefabCommit', () => ({
  parsePrefabBytes: (text: string) => JSON.parse(text.replace(/^\uFEFF/, '')),
  commitPrefabWrite: async (path: string, doc: { id?: string } | null, opts: { expected: unknown; bytes?: string }) => {
    const next = doc === null ? null : (opts.bytes ?? jsonFileBody(doc));
    if (next === null ? !deleteResult : !writeResult) return { ok: false, path };
    const cur = disk.get(path);
    const exp = opts.expected === null ? null : typeof opts.expected === 'string' ? opts.expected : jsonFileBody(opts.expected);
    if (exp === null ? cur !== undefined : (cur === undefined || hashOf(cur) !== hashOf(exp))) return { ok: false, conflict: true, path };
    if (next === null) { deleteAssetFileSpy(path); disk.delete(path); }
    else await writeAssetFileSpy(path, next);
    landedSpy(path, doc);
    return { ok: true, path };
  },
}));

// The undo's restore: recorded, not run — its own behaviour is covered where it runs unmocked.
const restoreSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../src/editor/scene/prefabMemoryRestore', () => ({
  restorePrefabsInMemory: (...args: unknown[]) => restoreSpy(...args),
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
import { jsonFileBody } from '../../src/editor/backend/editorBackend';

const RIG_BONES = [{ x: 0, y: 0, rot: 0, name: 'root', parent: -1 }];

beforeEach(() => {
  writeResult = true;
  deleteResult = true;
  registerAssetSpy.mockClear();
  spawnEntitySubtreeSpy.mockClear();
  deleteEntitySpy.mockClear();
  setPrefabCacheSpy.mockClear();
  landedSpy.mockClear();
  serializePrefabSpy.mockClear();
  writeAssetFileSpy.mockClear();
  deleteAssetFileSpy.mockClear();
  pushActionSpy.mockClear();
  reportUndoFailureSpy.mockClear();
  restoreSpy.mockClear();
  parked.clear();
  disk.clear();
  writeResult = true; deleteResult = true;
  // Nothing at any path unless a test says so: the prior read is decided by the FILE (#1679), and an unstubbed fetch
  // would THROW — which is "something there that did not read", not a fresh create.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
});

// Unstub in afterEach, NOT at the end of the test body: a failing assertion skips the
// rest of the body, so an inline unstub never runs and `fetch` stays stubbed for every
// later test — one real regression then cascades into several misleading failures. Same
// reasoning as any console-spy restore.
afterEach(() => {
  vi.unstubAllGlobals();
  // The commit seats and registers; skinPrefab doing it too would put a document in the caches before (or without) its write.
  expect(setPrefabCacheSpy).not.toHaveBeenCalled();
  expect(registerAssetSpy).not.toHaveBeenCalled();
});

const make = async (path: string, prior?: string) => {
  if (prior !== undefined) {
    disk.set(path, prior);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(prior, { status: 200 })));
  }
  serializePrefabSpy.mockReturnValue({ id: prior !== undefined ? 'g-existing' : 'g-new', root: { v: 2 } } as any);
  return makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, path, 'Rig');
};

describe('makeRigPrefabAsset — a fresh make (#1868)', () => {
  // Mutation: push the entry for a fresh make again (`if (!updated) return …` removed) — this goes red.
  it('writes the new asset and pushes NO undo entry: a creation is saved on creation, and nothing in memory changed', async () => {
    expect(await make('/fresh.prefab.json')).toEqual({ path: '/fresh.prefab.json', updated: false });
    expect(JSON.parse(disk.get('/fresh.prefab.json')!)).toEqual({ id: 'g-new', root: { v: 2 } });
    expect(pushActionSpy).not.toHaveBeenCalled();
  });
});

describe('makeRigPrefabAsset — an update\'s undo and redo change memory only (#1868)', () => {
  // Mutations: swap `doc` and `from` in the undo — the first case goes red; key the restore by the path instead of the
  // guid — the same (a Rename since would strand it, hub call e).
  it('undo restores the PRIOR document by guid, from the one the update left; redo the reverse; neither writes', async () => {
    expect(await make('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}')).toEqual({ path: '/rigs/existing.prefab.json', updated: true });
    const action = pushActionSpy.mock.calls.at(-1)![0];
    expect(action).toMatchObject({ label: 'Update prefab "Rig"', _isFileDirect: true, _rebasesLiveFrames: true });
    const writes = writeAssetFileSpy.mock.calls.length;
    const after = { id: 'g-existing', root: { v: 2 } };
    await action.undo();
    expect(restoreSpy).toHaveBeenLastCalledWith([{ source: 'g-existing', doc: { id: 'g-existing', old: true }, from: after }]);
    await action.redo();
    expect(restoreSpy).toHaveBeenLastCalledWith([{ source: 'g-existing', doc: after, from: { id: 'g-existing', old: true } }]);
    expect(writeAssetFileSpy.mock.calls.length).toBe(writes);
    expect(deleteAssetFileSpy).not.toHaveBeenCalled();
  });

  // D-i. Mutation: read the prior from the FILE when parked — the update conflicts, and its undo would restore the file.
  it('an update over a PARKED prefab reads the park: it is conditional on it, and its undo restores it', async () => {
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    const fetchMock = vi.fn(async () => new Response('{"id":"g-existing","old":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    parked.set('/rigs/existing.prefab.json', { id: 'g-existing', parked: true });
    serializePrefabSpy.mockReturnValue({ id: 'g-existing', root: { v: 2 } } as any);
    // The mocked commit checks `expected` against the FILE; the real one reads a parked `expected` as the park's own
    // baseline (D-a, prefabPark.test.ts) — here the file is set to hold the park, so the mock lands it too.
    disk.set('/rigs/existing.prefab.json', jsonFileBody({ id: 'g-existing', parked: true }));
    expect(await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig')).not.toBeNull();
    await pushActionSpy.mock.calls.at(-1)![0].undo();
    expect(restoreSpy).toHaveBeenLastCalledWith([expect.objectContaining({ doc: { id: 'g-existing', parked: true } })]);
  });

  // #1692: the update is conditional on what it read, so an unreadable prior refuses the UPDATE itself — before, it
  // wrote blind and left an undo that could only report it had nothing to restore. Never a create, never a trash.
  it('an update whose prior prefab could not be READ is not a create: it is refused, and the file is left as it is', async () => {
    disk.set('/rigs/existing.prefab.json', '{"id":"g-existing","old":true}');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('backend restarting'); }));
    serializePrefabSpy.mockReturnValue({ id: 'g-existing', root: { v: 2 } } as any);
    expect(await quietly(() => makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/rigs/existing.prefab.json', 'Rig'))).toBeNull();
    expect(disk.get('/rigs/existing.prefab.json')).toBe('{"id":"g-existing","old":true}');
    expect(pushActionSpy).not.toHaveBeenCalled();
    expect(deleteAssetFileSpy).not.toHaveBeenCalled();
  });

  it('an id-less prefab already at the path is an update — the read is decided by the FILE, not the id — and its undo restores it', async () => {
    const prior = '{"name":"no id yet"}';
    disk.set('/fresh.prefab.json', prior);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(prior, { status: 200 })));
    serializePrefabSpy.mockReturnValue({ id: 'g-new', root: { v: 2 } } as any);
    // The mocked classifier calls this path free ('mintable'), as the real one does for an id-less file.
    expect(await makeRigPrefabAsset('/rig.rig2d.json', { bones: RIG_BONES, id: 'g-rig' } as any, '/fresh.prefab.json', 'Rig')).toEqual({ path: '/fresh.prefab.json', updated: true });
    await pushActionSpy.mock.calls.at(-1)![0].undo();
    expect(restoreSpy).toHaveBeenLastCalledWith([{ source: 'g-new', doc: { name: 'no id yet' }, from: { id: 'g-new', root: { v: 2 } } }]);
  });
});
