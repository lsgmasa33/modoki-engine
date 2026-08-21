/** assetUndo — the delete/duplicate/rename/move/paste/folder undo builders
 *  (editor-panels missing test #5, extended by #308). Extracted from Assets.tsx
 *  (F6, then #308) so the snapshot/GUID-sidecar restore + failure-reporting
 *  logic is testable without rendering the panel. The builders go through the
 *  shared assetOps backend wrappers (writeAssetFile / deleteAssetFile[s] /
 *  duplicateAssetFile / createFolderApi / moveFileToStatus), which post to
 *  /api/* via the editor backendFetch → global fetch; we stub fetch and
 *  assert the requests. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeDeleteUndo, makeDuplicateUndo, isTextAsset,
  makeRenameUndo, makeEmptyFolderDeleteUndo, makeNewFolderUndo, makeFolderRenameUndo,
  makePasteUndo, makeFilesDropUndo, makeModelImportUndo, makeFileImportUndo,
  type DeleteResult, type DupResult,
} from '../../src/editor/panels/assetUndo';
import { COLLISION_STATUS } from '../../src/editor/undo/undoFailure';
import { useEditorStore } from '../../src/editor/store/editorStore';
import type { AssetEntry } from '../../src/editor/utils/assetPaths';

// Record every /api/* call the builders make.
type Call = { url: string; body: any };
let calls: Call[] = [];

// Per-URL status override for the NEXT matching call, consumed once — lets a test make e.g.
// "the second /api/move-file call" fail with a specific status without disturbing the others.
let statusOverrides: Array<{ url: string; status: number; ok: boolean }> = [];

const mockFetch = vi.fn(async (url: string, opts?: any) => {
  calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
  const i = statusOverrides.findIndex((o) => o.url === url);
  if (i >= 0) {
    const { status, ok } = statusOverrides[i];
    statusOverrides.splice(i, 1);
    return { ok, status, json: async () => ({}) } as any;
  }
  return { ok: true, status: 200, json: async () => ({}) } as any;
});
vi.stubGlobal('fetch', mockFetch);

// Queue ONE failing response for the next call to `url`, consumed in FIFO order per-url.
function failNext(url: string, status: number) {
  statusOverrides.push({ url, status, ok: false });
}

// Queue ONE successful response for the next call to `url` — the mirror of failNext, needed
// when a test must make the Nth call to a URL fail while an earlier call to the SAME url
// succeeds (mockFetch's default response is already success, but once ANY override is queued
// for a url it is consumed strictly FIFO, so an earlier call can't fall through to the default).
function succeedNext(url: string) {
  statusOverrides.push({ url, status: 200, ok: true });
}

const A = (path: string, type = 'model'): AssetEntry => ({ path, name: path.split('/').pop()!, type });

// Console spies are restored in afterEach, NOT at the end of each test: an assertion that
// fails skips the rest of its body, so an inline `mockRestore()` never runs and console stays
// mocked for every later test — one real regression then cascades into several misleading
// failures (measured while mutation-checking the #291 guards).
let consoleSpies: Array<{ mockRestore: () => void }> = [];
const spyConsole = (level: 'error' | 'warn') => {
  const s = vi.spyOn(console, level).mockImplementation(() => {});
  consoleSpies.push(s);
  return s;
};

beforeEach(() => {
  calls = []; mockFetch.mockClear(); statusOverrides = [];
  useEditorStore.setState({ toast: null, editingParticleAsset: null, editingSpriteAnimAsset: null });
});
afterEach(() => { for (const s of consoleSpies) s.mockRestore(); consoleSpies = []; });

describe('isTextAsset', () => {
  it('classifies text vs binary by extension', () => {
    expect(isTextAsset('/a/x.json')).toBe(true);
    expect(isTextAsset('/a/x.PREFAB.JSON')).toBe(true); // case-insensitive
    expect(isTextAsset('/a/x.glb')).toBe(false);
    expect(isTextAsset('/a/x.png')).toBe(false);
  });
});

describe('makeDeleteUndo', () => {
  it('undo restores the FULL snapshot set; redo re-trashes the whole set in ONE call', async () => {
    // A model delete: the GLB + its sidecar + a generated mesh/mat + their sidecars.
    const result: DeleteResult = {
      asset: A('/assets/models/island.glb'),
      snapshots: [
        { path: '/assets/models/island.glb', content: 'QkFTRTY0', encoding: 'base64' },
        { path: '/assets/models/island.glb.meta.json', content: '{"guid":"g1"}' },
        { path: '/assets/models/island.mesh.json', content: '{"id":"m1"}' },
        { path: '/assets/models/island.mat.json', content: '{"id":"mat1"}' },
      ],
      deletePaths: [
        '/assets/models/island.glb',
        '/assets/models/island.glb.meta.json',
        '/assets/models/island.mesh.json',
        '/assets/models/island.mat.json',
      ],
    };
    const refresh = vi.fn();
    const action = makeDeleteUndo([result], refresh);
    expect(action.label).toBe('Delete island.glb');

    await action.undo();
    // Every snapshot is re-written (restored), preserving its encoding so binary
    // bytes round-trip via base64 (not UTF-8-corrupting fetch().text()).
    const writes = calls.filter((c) => c.url === '/api/write-file');
    expect(writes.map((w) => w.body.path)).toEqual(result.snapshots.map((s) => s.path));
    const glb = writes.find((w) => w.body.path.endsWith('.glb'))!;
    expect(glb.body.encoding).toBe('base64');
    expect(glb.body.content).toBe('QkFTRTY0');
    const meta = writes.find((w) => w.body.path.endsWith('.meta.json'))!;
    expect(meta.body.encoding).toBeUndefined(); // text asset → no base64
    expect(refresh).toHaveBeenCalledTimes(1);

    calls = [];
    await action.redo();
    // ONE batched trash request carrying every path (one OS-trash sound).
    const deletes = calls.filter((c) => c.url === '/api/delete-asset');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body.paths.sort()).toEqual([...result.deletePaths].sort());
  });

  it('labels a multi-asset delete and de-dups shared paths in the redo batch', async () => {
    const a: DeleteResult = { asset: A('/assets/a.glb'), snapshots: [], deletePaths: ['/assets/a.glb', '/assets/shared.tex'] };
    const b: DeleteResult = { asset: A('/assets/b.glb'), snapshots: [], deletePaths: ['/assets/b.glb', '/assets/shared.tex'] };
    const action = makeDeleteUndo([a, b], vi.fn());
    expect(action.label).toBe('Delete 2 items');
    await action.redo();
    const deletes = calls.filter((c) => c.url === '/api/delete-asset');
    expect(deletes).toHaveLength(1);
    // shared.tex appears once despite being in both results.
    expect(deletes[0].body.paths.sort()).toEqual(['/assets/a.glb', '/assets/b.glb', '/assets/shared.tex']);
  });

  // #291: an undo that restores only PART of what it trashed is the sharper false success —
  // the panel refreshes, some files reappear, and the ones whose snapshot read failed stay in
  // the trash with nothing naming them. The shortfall check covers this and the total case.
  it('undo reports the SHORTFALL when only some files were restorable', async () => {
    const error = spyConsole('error');
    const good: DeleteResult = {
      asset: A('/assets/good.glb'),
      snapshots: [{ path: '/assets/good.glb', content: 'QQ==', encoding: 'base64' }],
      deletePaths: ['/assets/good.glb'],
    };
    // Its snapshot read failed, so nothing can bring this one back.
    const bad: DeleteResult = { asset: A('/assets/bad.glb'), snapshots: [], deletePaths: ['/assets/bad.glb'] };
    const refresh = vi.fn();
    await makeDeleteUndo([good, bad], refresh).undo();

    // The restorable half IS restored — a partial failure must not abandon the good files.
    const writes = calls.filter((c) => c.url === '/api/write-file');
    expect(writes.map((w) => w.body.path)).toEqual(['/assets/good.glb']);
    // ...and the panel still refreshes so those files reappear.
    expect(refresh).toHaveBeenCalledTimes(1);
    // The error names ONLY the file still in the trash, and says how many of how many.
    expect(error).toHaveBeenCalledTimes(1);
    const msg = String(error.mock.calls[0][0]);
    expect(msg).toContain('restored 1 of 2');
    expect(msg).toContain('/assets/bad.glb');
    expect(msg).not.toContain('/assets/good.glb');
  });

  // #291: deletionPathsFor deliberately lists maybe-absent sidecars (.meta.local.json is
  // gitignored and usually not on disk). Diffing against deletePaths would send the user
  // hunting in the trash for a file that never existed — so the backend's `missing` wins.
  it('undo does NOT name a path the backend reported as never on disk', async () => {
    const error = spyConsole('error');
    const r: DeleteResult = {
      asset: A('/assets/x.glb'),
      snapshots: [{ path: '/assets/x.glb', content: 'QQ==', encoding: 'base64' }],
      // The gitignored sidecar was listed for deletion but was never there.
      deletePaths: ['/assets/x.glb', '/assets/x.glb.meta.local.json'],
    };
    await makeDeleteUndo([r], vi.fn(), ['/assets/x.glb.meta.local.json']).undo();
    // Everything that actually existed came back → no shortfall → no error at all.
    expect(error).not.toHaveBeenCalled();
  });

  // #291: the same false-success shape on the other half of the pair — a failed re-delete
  // left the files on disk while refresh() re-listed them, so redo read as a no-op.
  it('redo ERRORS when the re-delete fails instead of reporting a silent no-op', async () => {
    const error = spyConsole('error');
    mockFetch.mockImplementationOnce(async (url: string, opts?: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
      return { ok: false, json: async () => ({}) } as any;
    });
    const refresh = vi.fn();
    await makeDeleteUndo(
      [{ asset: A('/assets/x.glb'), snapshots: [], deletePaths: ['/assets/x.glb'] }],
      refresh,
    ).redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/x.glb');
    expect(refresh).toHaveBeenCalledTimes(1); // still refreshes — the panel must show reality
  });

  // #291: an undo that restores nothing looks like a working Cmd+Z. It cannot be a silent
  // console.warn — the files are already in the OS trash, so the log IS the recovery path.
  it('undo with no restorable snapshots ERRORS with the trashed paths and writes nothing', async () => {
    const error = spyConsole('error');
    const warn = spyConsole('warn');
    const action = makeDeleteUndo(
      [{ asset: A('/assets/x.glb'), snapshots: [], deletePaths: ['/assets/x.glb', '/assets/x.glb.meta.json'] }],
      vi.fn(),
    );
    await action.undo();
    expect(calls.filter((c) => c.url === '/api/write-file')).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    // Error LEVEL, not warn — a warn is filtered out of most console views.
    expect(warn).not.toHaveBeenCalled();
    const msg = String(error.mock.calls[0][0]);
    // Names the action and EVERY trashed path, so hand-recovery does not need the source.
    expect(msg).toContain('Delete x.glb');
    expect(msg).toContain('restored 0 of 2');
    expect(msg).toContain('/assets/x.glb');
    expect(msg).toContain('/assets/x.glb.meta.json');
  });
});

describe('makeDuplicateUndo', () => {
  it('undo trashes each copy + its sidecar (binary); redo re-copies', async () => {
    const results: DupResult[] = [{ asset: A('/assets/island.glb'), toPath: '/assets/island copy.glb' }];
    const refresh = vi.fn();
    const action = makeDuplicateUndo(results, refresh);
    expect(action.label).toBe('Duplicate island.glb');

    await action.undo();
    // Binary copy → BOTH sidecar halves are trashed: the committed `.meta.json` (GUID +
    // settings) and the gitignored machine-local `.meta.local.json` (byte stats). Dropping
    // only the committed half stranded the local one on disk after every undone duplicate —
    // the QA-CTX-0005 leak class, in the flow that fix's first sweep did not reach.
    const deletes = calls.filter((c) => c.url === '/api/delete-asset').map((c) => c.body.path);
    expect(deletes).toEqual([
      '/assets/island copy.glb',
      '/assets/island copy.glb.meta.json',
      '/assets/island copy.glb.meta.local.json',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    calls = [];
    await action.redo();
    const dups = calls.filter((c) => c.url === '/api/duplicate-asset');
    expect(dups).toHaveLength(1);
    expect(dups[0].body).toEqual({ from: '/assets/island.glb', to: '/assets/island copy.glb' });
  });

  it('does NOT trash a sidecar for a text-asset duplicate (carries its id inline)', async () => {
    const results: DupResult[] = [{ asset: A('/assets/x.prefab.json', 'prefab'), toPath: '/assets/x copy.prefab.json' }];
    const action = makeDuplicateUndo(results, vi.fn());
    await action.undo();
    const deletes = calls.filter((c) => c.url === '/api/delete-asset').map((c) => c.body.path);
    expect(deletes).toEqual(['/assets/x copy.prefab.json']); // no sidecar
  });

  it('labels a multi-asset duplicate', () => {
    const action = makeDuplicateUndo(
      [{ asset: A('/a.glb'), toPath: '/a copy.glb' }, { asset: A('/b.glb'), toPath: '/b copy.glb' }],
      vi.fn(),
    );
    expect(action.label).toBe('Duplicate 2 items');
  });

  // #308: undo used to discard the deleteAssetFile boolean entirely — a failed trash left
  // the copy on disk with nothing reported, and the editor still unbound the (still-open,
  // still-live) file as if it were gone.
  it('undo ERRORS (no toast) when the primary delete fails, and does not unbind it', async () => {
    const error = spyConsole('error');
    mockFetch.mockImplementationOnce(async (url: string, opts?: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
      return { ok: false, status: 500, json: async () => ({}) } as any;
    });
    const refresh = vi.fn();
    await makeDuplicateUndo([{ asset: A('/assets/x.glb'), toPath: '/assets/x copy.glb' }], refresh).undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/x copy.glb');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #308: redo (re-copy) never checked duplicateAssetFile's result at all.
  //
  // A fresh action's `redo()` is a no-op — `undoManager` only ever pushes an action onto
  // `redoStack` via `undo()`, so `redo()` before `undo()` is a sequence production cannot
  // produce (undoManager.ts:327/426). Drive undo() first to put the copy into the UNDONE
  // state, then exercise redo()'s own failure handling on the SAME action instance.
  it('redo ERRORS when the re-copy fails', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const action = makeDuplicateUndo([{ asset: A('/assets/x.glb'), toPath: '/assets/x copy.glb' }], refresh);
    await action.undo(); // trashes the copy — now in the undone state, so redo has something to do
    error.mockClear();
    refresh.mockClear();
    failNext('/api/duplicate-asset', 500);
    await action.redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/x copy.glb');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('makeRenameUndo (#308 site 1)', () => {
  const build = (refresh = vi.fn()) => makeRenameUndo({
    originalPath: '/assets/old.png', originalName: 'old.png', toPath: '/assets/new.png', newName: 'new.png', refresh,
  });

  it('undo moves the file back on success and reports nothing', async () => {
    const refresh = vi.fn();
    await build(refresh).undo();
    const moves = calls.filter((c) => c.url === '/api/move-file');
    expect(moves).toHaveLength(1);
    expect(moves[0].body).toEqual({ from: '/assets/new.png', to: '/assets/old.png' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).toBeNull();
  });

  // #308: a 409 collision (something now occupies the original path) is the ONE case that
  // gets a toast on top of the console error.
  it('undo on a 409 collision ERRORS and TOASTS', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', COLLISION_STATUS);
    const refresh = vi.fn();
    await build(refresh).undo();
    expect(error).toHaveBeenCalledTimes(1);
    const toast = useEditorStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.kind).toBe('warn');
    expect(refresh).toHaveBeenCalledTimes(1); // still refreshes on a partial failure
  });

  // #308: a non-409 backend failure logs but must NOT toast — only a collision is
  // user-fixable.
  it('redo on a non-collision (500) failure ERRORS and does NOT toast', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', 500);
    const refresh = vi.fn();
    await build(refresh).redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/old.png');
    expect(String(error.mock.calls[0][0])).toContain('/assets/new.png');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('makeEmptyFolderDeleteUndo (#308 site 2)', () => {
  it('undo ERRORS (no toast) when the folder recreate fails, but still refreshes', async () => {
    const error = spyConsole('error');
    failNext('/api/create-folder', 500);
    const refresh = vi.fn();
    await makeEmptyFolderDeleteUndo({ folderPath: '/assets/empty', folderName: 'empty', refresh }).undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/empty');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('redo succeeds silently when the re-delete works', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    await makeEmptyFolderDeleteUndo({ folderPath: '/assets/empty', folderName: 'empty', refresh }).redo();
    expect(error).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #C-5 (#308 close-out) — literally the bug class #308 exists to fix: this redo failure
  // path had no test at all, and a mutation that reverted redo to discard deleteAssetFile's
  // boolean entirely passed the whole suite.
  it('redo ERRORS (no toast) when the re-delete fails, but still refreshes', async () => {
    const error = spyConsole('error');
    failNext('/api/delete-asset', 500);
    const refresh = vi.fn();
    await makeEmptyFolderDeleteUndo({ folderPath: '/assets/empty', folderName: 'empty', refresh }).redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/empty');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('makeNewFolderUndo (#308 site 6)', () => {
  it('undo removes the pending folder from client state ONLY when the delete succeeds', async () => {
    const setPendingFolders = vi.fn();
    const refresh = vi.fn();
    await makeNewFolderUndo({ path: '/assets/New Folder', refresh, setPendingFolders }).undo();
    expect(setPendingFolders).toHaveBeenCalledTimes(1);
    // Apply the updater the callback was given, against a set containing the folder.
    const updater = setPendingFolders.mock.calls[0][0];
    expect(updater(new Set(['/assets/New Folder']))).toEqual(new Set());
  });

  // #308: setPendingFolders used to run unconditionally — a failed delete left the folder
  // physically on disk while the client believed it was gone.
  it('undo does NOT touch client state when the delete fails, and reports it', async () => {
    const error = spyConsole('error');
    failNext('/api/delete-asset', 500);
    const setPendingFolders = vi.fn();
    const refresh = vi.fn();
    await makeNewFolderUndo({ path: '/assets/New Folder', refresh, setPendingFolders }).undo();
    expect(setPendingFolders).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/New Folder');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('redo does NOT touch client state when the recreate fails, and reports it', async () => {
    const error = spyConsole('error');
    failNext('/api/create-folder', 500);
    const setPendingFolders = vi.fn();
    const refresh = vi.fn();
    await makeNewFolderUndo({ path: '/assets/New Folder', refresh, setPendingFolders }).redo();
    expect(setPendingFolders).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #C-4 (#308 close-out): the success path had no test — a mutation that inverted add/delete
  // on pendingFolders passed the whole suite.
  it('redo adds the folder to client state when the recreate succeeds', async () => {
    const setPendingFolders = vi.fn();
    const refresh = vi.fn();
    await makeNewFolderUndo({ path: '/assets/New Folder', refresh, setPendingFolders }).redo();
    expect(setPendingFolders).toHaveBeenCalledTimes(1);
    const updater = setPendingFolders.mock.calls[0][0];
    expect(updater(new Set())).toEqual(new Set(['/assets/New Folder']));
  });
});

describe('makeFolderRenameUndo (#308 site 5 — the worst one)', () => {
  const build = (refresh = vi.fn(), setPendingFolders = vi.fn(), setExpanded = vi.fn()) => makeFolderRenameUndo({
    oldPath: '/assets/Old', newPath: '/assets/New', folderName: 'New', refresh, setPendingFolders, setExpanded,
  });

  it('undo remaps BOTH pendingFolders and expanded when the move succeeds', async () => {
    const setPendingFolders = vi.fn();
    const setExpanded = vi.fn();
    await build(vi.fn(), setPendingFolders, setExpanded).undo();
    expect(setPendingFolders).toHaveBeenCalledTimes(1);
    expect(setExpanded).toHaveBeenCalledTimes(1);
    const pf = setPendingFolders.mock.calls[0][0](new Set(['/assets/New', '/assets/New/inner']));
    expect(pf).toEqual(new Set(['/assets/Old', '/assets/Old/inner']));
    const ex = setExpanded.mock.calls[0][0](new Set(['/assets/New']));
    expect(ex).toEqual(new Set(['/assets/Old']));
  });

  // #308: this was the active-desync bug — setPendingFolders (and, previously, nothing for
  // setExpanded at all) ran UNCONDITIONALLY, remapping the client tree to the OTHER path
  // while the folder stayed physically where the move left it.
  it('undo does NOT remap EITHER client set when the move fails (a collision), and toasts', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', COLLISION_STATUS);
    const setPendingFolders = vi.fn();
    const setExpanded = vi.fn();
    const refresh = vi.fn();
    await build(refresh, setPendingFolders, setExpanded).undo();
    expect(setPendingFolders).not.toHaveBeenCalled();
    expect(setExpanded).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const toast = useEditorStore.getState().toast;
    expect(toast).not.toBeNull();
    expect(toast!.kind).toBe('warn');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('redo does NOT remap either client set on a non-collision failure, and does not toast', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', 500);
    const setPendingFolders = vi.fn();
    const setExpanded = vi.fn();
    await build(vi.fn(), setPendingFolders, setExpanded).redo();
    expect(setPendingFolders).not.toHaveBeenCalled();
    expect(setExpanded).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).toBeNull();
  });

  // #C-3 (#308 close-out) — "the worst site": redo's SUCCESS path had no test at all. A
  // mutation that swapped `remapPrefix(p, oldPath, newPath)` → `remapPrefix(p, newPath, oldPath)`
  // in redo's success branch passed the whole suite. Pin the FORWARD direction of both sets.
  it('redo remaps BOTH pendingFolders and expanded FORWARD when the move succeeds', async () => {
    const setPendingFolders = vi.fn();
    const setExpanded = vi.fn();
    await build(vi.fn(), setPendingFolders, setExpanded).redo();
    expect(setPendingFolders).toHaveBeenCalledTimes(1);
    expect(setExpanded).toHaveBeenCalledTimes(1);
    const pf = setPendingFolders.mock.calls[0][0](new Set(['/assets/Old', '/assets/Old/inner']));
    expect(pf).toEqual(new Set(['/assets/New', '/assets/New/inner']));
    const ex = setExpanded.mock.calls[0][0](new Set(['/assets/Old']));
    expect(ex).toEqual(new Set(['/assets/New']));
  });
});

describe('makePasteUndo (#308 site 3)', () => {
  it('cut-undo: moves everything back and reports nothing on full success', async () => {
    const refresh = vi.fn();
    const action = makePasteUndo({ op: 'cut', done: [{ from: '/a.glb', to: '/b/a.glb' }, { from: '/c.glb', to: '/b/c.glb' }], refresh });
    await action.undo();
    const moves = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(moves).toEqual([{ from: '/b/a.glb', to: '/a.glb' }, { from: '/b/c.glb', to: '/c.glb' }]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).toBeNull();
  });

  // #308: the original loop pushed to `back` only on success and silently dropped the rest —
  // with every item failing, `back` was empty and NOTHING was reported.
  it('cut-undo: reports ALL skipped items as ONE message when every move fails', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', 500);
    failNext('/api/move-file', 500);
    const refresh = vi.fn();
    const action = makePasteUndo({ op: 'cut', done: [{ from: '/a.glb', to: '/b/a.glb' }, { from: '/c.glb', to: '/b/c.glb' }], refresh });
    await action.undo();
    expect(error).toHaveBeenCalledTimes(1); // ONE message, not one per item
    const msg = String(error.mock.calls[0][0]);
    expect(msg).toContain('/b/a.glb');
    expect(msg).toContain('/b/c.glb');
    expect(useEditorStore.getState().toast).toBeNull(); // 500s aren't user-fixable
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cut-undo: a 409 among the failures toasts', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', COLLISION_STATUS);
    const refresh = vi.fn();
    await makePasteUndo({ op: 'cut', done: [{ from: '/a.glb', to: '/b/a.glb' }], refresh }).undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).not.toBeNull();
  });

  // #C-1 (#308 close-out): cut-redo had ZERO coverage, success or failure — a mutation that
  // swapped the pushed move to the WRONG direction (`fwd.push({from:to,to:from})`) passed
  // every existing test. Pin it by asserting the binding-remap direction through
  // `applyAssetPathMoves`, not just the raw /api/move-file call.
  it('cut-redo: moves everything forward and remaps a bound editor to the NEW path', async () => {
    const refresh = vi.fn();
    const action = makePasteUndo({ op: 'cut', done: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo(); // a moves back to /a.glb — puts it in the undone state redo needs
    // Bind an editor at the pre-redo (undone) location, so redo's remap is what's under test.
    useEditorStore.setState({ editingParticleAsset: { path: '/a.glb', type: 'particle', name: 'a.glb' } });
    calls = [];
    await action.redo();
    const moves = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(moves).toEqual([{ from: '/a.glb', to: '/b/a.glb' }]);
    // The FORWARD direction: the binding follows the file to its new location.
    expect(useEditorStore.getState().editingParticleAsset?.path).toBe('/b/a.glb');
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('cut-redo ERRORS when the forward move fails, and does not remap a bound editor', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const action = makePasteUndo({ op: 'cut', done: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo();
    useEditorStore.setState({ editingParticleAsset: { path: '/a.glb', type: 'particle', name: 'a.glb' } });
    error.mockClear();
    failNext('/api/move-file', 500);
    await action.redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/a.glb');
    expect(String(error.mock.calls[0][0])).toContain('/b/a.glb');
    expect(useEditorStore.getState().toast).toBeNull();
    // The move never landed — the binding must stay exactly where it was.
    expect(useEditorStore.getState().editingParticleAsset?.path).toBe('/a.glb');
  });

  // #308: the copy branch's redo (re-duplicate) was never checked at all.
  //
  // Same "undo() first" fix as the makeDuplicateUndo redo test above — a fresh action's
  // redo() is a no-op, so drive undo() to put the copy into the undone (trashed) state first.
  it('copy-redo: reports every path whose re-copy fails', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const action = makePasteUndo({ op: 'copy', done: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo(); // trashes the copy — puts it in the undone state
    error.mockClear();
    refresh.mockClear();
    failNext('/api/duplicate-asset', 500);
    await action.redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/a.glb');
    expect(String(error.mock.calls[0][0])).toContain('/b/a.glb');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #308: the copy branch's undo (delete the copy) was never checked either.
  it('copy-undo: reports the copy that failed to delete', async () => {
    const error = spyConsole('error');
    failNext('/api/delete-asset', 500);
    const refresh = vi.fn();
    await makePasteUndo({ op: 'copy', done: [{ from: '/a.glb', to: '/b/a.glb' }], refresh }).undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/b/a.glb');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// Part B (#308 close-out): the partial-failure fix itself — these would FAIL against the old
// replay-everything behaviour, which re-asked the backend to move/copy an item that never
// actually left its undone state and folded the resulting 404/409 into the failure report as
// though the item had been lost.
describe('makePasteUndo — partial-failure state tracking (#308 close-out)', () => {
  it('cut: redo after a partial undo failure only retries the items that actually moved back', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const done = [
      { from: '/a.glb', to: '/b/a.glb' },
      { from: '/c.glb', to: '/b/c.glb' },
      { from: '/e.glb', to: '/b/e.glb' },
    ];
    const action = makePasteUndo({ op: 'cut', done, refresh });
    // a and c move back fine; e's move-back fails and stays at its forward location.
    succeedNext('/api/move-file');
    succeedNext('/api/move-file');
    failNext('/api/move-file', 500);
    await action.undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/b/e.glb');

    calls = [];
    error.mockClear();
    await action.redo();
    // Only a and c — the ones undo() actually moved back — are retried.
    const moves = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(moves).toEqual([{ from: '/a.glb', to: '/b/a.glb' }, { from: '/c.glb', to: '/b/c.glb' }]);
    // e was never lost — no spurious request for it, and no false failure report naming it.
    expect(error).not.toHaveBeenCalled();
  });

  it('copy: redo after a partial undo failure only re-copies the items that were actually deleted', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    // Text-asset (.json) paths so undo's copy branch makes exactly ONE /api/delete-asset call
    // per item (no binary sidecar deletes), keeping the per-item response queue simple.
    const done = [
      { from: '/a.prefab.json', to: '/b/a.prefab.json' },
      { from: '/c.prefab.json', to: '/b/c.prefab.json' },
      { from: '/e.prefab.json', to: '/b/e.prefab.json' },
    ];
    const action = makePasteUndo({ op: 'copy', done, refresh });
    succeedNext('/api/delete-asset');
    succeedNext('/api/delete-asset');
    failNext('/api/delete-asset', 500);
    await action.undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/b/e.prefab.json');

    calls = [];
    error.mockClear();
    await action.redo();
    const dups = calls.filter((c) => c.url === '/api/duplicate-asset').map((c) => c.body);
    expect(dups).toEqual([
      { from: '/a.prefab.json', to: '/b/a.prefab.json' },
      { from: '/c.prefab.json', to: '/b/c.prefab.json' },
    ]);
    // e's copy was never deleted — no spurious re-copy request, and no false report.
    expect(error).not.toHaveBeenCalled();
  });

  // Pins that the skip is STATE-based, not a permanent exclusion: a genuine retry still retries.
  it('retry: a later undo re-attempts an item that a preceding redo skipped', async () => {
    const refresh = vi.fn();
    const done = [{ from: '/e.glb', to: '/b/e.glb' }];
    const action = makePasteUndo({ op: 'cut', done, refresh });
    failNext('/api/move-file', 500); // the first undo attempt fails — e never leaves /b/e.glb
    await action.undo();
    calls = [];
    await action.redo(); // e is not in the undone set — skipped, no request at all
    expect(calls.filter((c) => c.url === '/api/move-file')).toHaveLength(0);
    calls = [];
    await action.undo(); // retried — this time it succeeds
    const moves = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(moves).toEqual([{ from: '/b/e.glb', to: '/e.glb' }]);
  });
});

describe('makeFilesDropUndo (#308 site 4)', () => {
  it('undo moves everything back on success', async () => {
    const refresh = vi.fn();
    const action = makeFilesDropUndo({ moves: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo();
    const moves = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(moves).toEqual([{ from: '/b/a.glb', to: '/a.glb' }]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #308: same skip-every-item shape as the paste cut branch.
  it('reports ALL skipped items as ONE message when every move-back fails', async () => {
    const error = spyConsole('error');
    failNext('/api/move-file', 500);
    failNext('/api/move-file', 500);
    const refresh = vi.fn();
    const action = makeFilesDropUndo({
      moves: [{ from: '/a.glb', to: '/b/a.glb' }, { from: '/c.glb', to: '/b/c.glb' }], refresh,
    });
    await action.undo();
    expect(error).toHaveBeenCalledTimes(1);
    const msg = String(error.mock.calls[0][0]);
    expect(msg).toContain('/b/a.glb');
    expect(msg).toContain('/b/c.glb');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // Same "undo() first" fix as the makeDuplicateUndo/makePasteUndo redo tests above — a
  // fresh action's redo() is a no-op, so drive undo() to put the item into the undone state.
  it('redo on a 409 collision toasts', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const action = makeFilesDropUndo({ moves: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo(); // moves it back — puts it in the undone state
    error.mockClear();
    failNext('/api/move-file', COLLISION_STATUS);
    await action.redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).not.toBeNull();
  });

  // #C-2 (#308 close-out): redo's success path and its non-collision failure path had no
  // coverage at all — only the 409 case above was tested. Also assert the binding-remap
  // direction (like the makePasteUndo cut-redo test above) — the raw /api/move-file body
  // alone can't distinguish a correct `fwd` push from a swapped one, since both directions
  // send the SAME request; only `applyAssetPathMoves(fwd)`'s effect on a bound editor does.
  it('redo moves everything forward on success and remaps a bound editor to the NEW path', async () => {
    const refresh = vi.fn();
    const action = makeFilesDropUndo({ moves: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo();
    useEditorStore.setState({ editingParticleAsset: { path: '/a.glb', type: 'particle', name: 'a.glb' } });
    calls = [];
    await action.redo();
    const fwd = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(fwd).toEqual([{ from: '/a.glb', to: '/b/a.glb' }]);
    expect(useEditorStore.getState().editingParticleAsset?.path).toBe('/b/a.glb');
    expect(useEditorStore.getState().toast).toBeNull();
  });

  it('redo on a non-collision (500) failure ERRORS and does NOT toast', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const action = makeFilesDropUndo({ moves: [{ from: '/a.glb', to: '/b/a.glb' }], refresh });
    await action.undo();
    error.mockClear();
    failNext('/api/move-file', 500);
    await action.redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().toast).toBeNull();
  });
});

// Part B (#308 close-out): same partial-failure-then-redo shape as makePasteUndo's cut branch.
describe('makeFilesDropUndo — partial-failure state tracking (#308 close-out)', () => {
  it('redo after a partial undo failure only retries the items that actually moved back', async () => {
    const error = spyConsole('error');
    const refresh = vi.fn();
    const moves = [
      { from: '/a.glb', to: '/b/a.glb' },
      { from: '/c.glb', to: '/b/c.glb' },
      { from: '/e.glb', to: '/b/e.glb' },
    ];
    const action = makeFilesDropUndo({ moves, refresh });
    succeedNext('/api/move-file');
    succeedNext('/api/move-file');
    failNext('/api/move-file', 500);
    await action.undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/b/e.glb');

    calls = [];
    error.mockClear();
    await action.redo();
    const fwd = calls.filter((c) => c.url === '/api/move-file').map((c) => c.body);
    expect(fwd).toEqual([{ from: '/a.glb', to: '/b/a.glb' }, { from: '/c.glb', to: '/b/c.glb' }]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('makeModelImportUndo (#308 follow-up A)', () => {
  const build = (onDone = vi.fn()) => makeModelImportUndo({
    assetName: 'Rig', prefabPath: '/assets/models/rig.prefab.json', content: '{"id":"p1"}', onDone,
  });

  it('undo trashes the prefab and calls onDone on success', async () => {
    const onDone = vi.fn();
    await build(onDone).undo();
    const deletes = calls.filter((c) => c.url === '/api/delete-asset');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body.path).toBe('/assets/models/rig.prefab.json');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // #308: both directions used to discard the boolean entirely.
  it('undo ERRORS (no toast) when the trash fails, but still calls onDone', async () => {
    const error = spyConsole('error');
    failNext('/api/delete-asset', 500);
    const onDone = vi.fn();
    await build(onDone).undo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('/assets/models/rig.prefab.json');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('redo re-writes the prefab and calls onDone on success', async () => {
    const onDone = vi.fn();
    await build(onDone).redo();
    const writes = calls.filter((c) => c.url === '/api/write-file');
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ path: '/assets/models/rig.prefab.json', content: '{"id":"p1"}', encoding: undefined });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('redo ERRORS when the re-write fails, but still calls onDone', async () => {
    const error = spyConsole('error');
    failNext('/api/write-file', 500);
    const onDone = vi.fn();
    await build(onDone).redo();
    expect(error).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('makeFileImportUndo (#308 follow-up B)', () => {
  it('undo trashes every imported file and unbinds all of them on full success', async () => {
    const refresh = vi.fn();
    const action = makeFileImportUndo({
      imported: [{ path: '/assets/a.png', content: 'AA==' }, { path: '/assets/b.png', content: 'BB==' }],
      refresh,
    });
    await action.undo();
    const deletes = calls.filter((c) => c.url === '/api/delete-asset').map((c) => c.body.path);
    expect(deletes).toEqual(['/assets/a.png', '/assets/b.png']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // #308: undo used to unbind ALL N files regardless of which deletes actually landed —
  // a file whose delete failed is still on disk, so its editor binding is still valid.
  it('undo does NOT unbind a file whose delete failed, and batch-reports the failure', async () => {
    const error = spyConsole('error');
    failNext('/api/delete-asset', 500); // the first delete (a.png) fails; b.png succeeds
    // Bind a live editor to EACH imported path, so "does not unbind" is a real assertion on
    // the store rather than an inference from the console message.
    useEditorStore.setState({
      editingParticleAsset: { path: '/assets/a.png', type: 'particle', name: 'a.png' },
      editingSpriteAnimAsset: { path: '/assets/b.png', type: 'sprite', name: 'b.png' },
    });
    const refresh = vi.fn();
    const action = makeFileImportUndo({
      imported: [{ path: '/assets/a.png', content: 'AA==' }, { path: '/assets/b.png', content: 'BB==' }],
      refresh,
    });
    await action.undo();
    // a.png's delete FAILED — it's still on disk, so its binding must survive.
    expect(useEditorStore.getState().editingParticleAsset?.path).toBe('/assets/a.png');
    // b.png's delete SUCCEEDED — it's gone, so its binding must be closed.
    expect(useEditorStore.getState().editingSpriteAnimAsset).toBeNull();
    expect(error).toHaveBeenCalledTimes(1); // ONE batched message, not one per item
    const msg = String(error.mock.calls[0][0]);
    expect(msg).toContain('/assets/a.png');
    expect(msg).not.toContain('/assets/b.png'); // only the FAILED one is named
    expect(useEditorStore.getState().toast).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('redo re-writes every file on success', async () => {
    const refresh = vi.fn();
    const action = makeFileImportUndo({ imported: [{ path: '/assets/a.png', content: 'AA==' }], refresh });
    await action.redo();
    const writes = calls.filter((c) => c.url === '/api/write-file');
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ path: '/assets/a.png', content: 'AA==', encoding: 'base64' });
  });

  // #308: redo's re-write loop was entirely unchecked.
  it('redo batch-reports every path whose re-write fails', async () => {
    const error = spyConsole('error');
    failNext('/api/write-file', 500);
    failNext('/api/write-file', 500);
    const refresh = vi.fn();
    const action = makeFileImportUndo({
      imported: [{ path: '/assets/a.png', content: 'AA==' }, { path: '/assets/b.png', content: 'BB==' }],
      refresh,
    });
    await action.redo();
    expect(error).toHaveBeenCalledTimes(1);
    const msg = String(error.mock.calls[0][0]);
    expect(msg).toContain('/assets/a.png');
    expect(msg).toContain('/assets/b.png');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
