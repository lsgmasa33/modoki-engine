/** assetUndo — the delete/duplicate undo builders (editor-panels missing test
 *  #5). Extracted from Assets.tsx (F6) so the snapshot/GUID-sidecar restore
 *  logic is testable without rendering the panel. The builders go through the
 *  shared assetOps backend wrappers (writeAssetFile / deleteAssetFile[s] /
 *  duplicateAssetFile), which post to /api/* via the editor backendFetch →
 *  global fetch; we stub fetch and assert the requests. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

beforeEach(() => { calls = []; mockFetch.mockClear(); });

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

  it('undo with no restorable snapshots warns and writes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const action = makeDeleteUndo([{ asset: A('/assets/x.glb'), snapshots: [], deletePaths: ['/assets/x.glb'] }], vi.fn());
    await action.undo();
    expect(calls.filter((c) => c.url === '/api/write-file')).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('makeDuplicateUndo', () => {
  it('undo trashes each copy + its sidecar (binary); redo re-copies', async () => {
    const results: DupResult[] = [{ asset: A('/assets/island.glb'), toPath: '/assets/island copy.glb' }];
    const refresh = vi.fn();
    const action = makeDuplicateUndo(results, refresh);
    expect(action.label).toBe('Duplicate island.glb');

    await action.undo();
    // Binary copy → its .meta.json sidecar is trashed too (carries GUID + settings).
    const deletes = calls.filter((c) => c.url === '/api/delete-asset').map((c) => c.body.path);
    expect(deletes).toEqual(['/assets/island copy.glb', '/assets/island copy.glb.meta.json']);
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
