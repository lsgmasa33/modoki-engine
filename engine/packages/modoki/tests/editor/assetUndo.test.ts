/** assetUndo — the delete/duplicate undo builders (editor-panels missing test
 *  #5). Extracted from Assets.tsx (F6) so the snapshot/GUID-sidecar restore
 *  logic is testable without rendering the panel. The builders go through the
 *  shared assetOps backend wrappers (writeAssetFile / deleteAssetFile[s] /
 *  duplicateAssetFile), which post to /api/* via the editor backendFetch →
 *  global fetch; we stub fetch and assert the requests. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeDeleteUndo, makeDuplicateUndo, isTextAsset, type DeleteResult, type DupResult } from '../../src/editor/panels/assetUndo';
import type { AssetEntry } from '../../src/editor/utils/assetPaths';

// Record every /api/* call the builders make.
type Call = { url: string; body: any };
let calls: Call[] = [];

const mockFetch = vi.fn(async (url: string, opts?: any) => {
  calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
  return { ok: true, json: async () => ({}) } as any;
});
vi.stubGlobal('fetch', mockFetch);

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

beforeEach(() => { calls = []; mockFetch.mockClear(); });
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
});
