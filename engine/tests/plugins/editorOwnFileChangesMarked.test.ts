/** #1702 — the editor's OWN file changes are marked for the watcher's self-write guard, so none comes back as an
 *  external change. Unmarked, a Move to Trash of ANY prefab hot-reloaded the open scene from disk and silently discarded
 *  its unsaved edits and its whole undo stack, the delete's own entry included (observed live on Windows, #1684).
 *
 *  Against the REAL router over a scratch directory, with a REAL `createEditorWriteGuard` as `ctx.markEditorWrite` — so
 *  each case asks the guard exactly what the watcher asks on the event (`isWrite(file, lazy re-hash)`), not whether a
 *  mark function was called. The trash is stubbed to delete from the scratch dir (a folder recursively).
 *
 *  Mutations, each checked red on its own cases here and nothing else:
 *  - drop the delete route's mark loop: every delete case.
 *  - mark only the top-level path (`vanishing` → `[abs]`): "a folder delete marks every file inside it".
 *  - mark every resolved path, not only what went: "a path the trash refused is not marked".
 *  - the guard ignores `EDITOR_DELETE_FINGERPRINT` (plain hash compare): "an unlink landing past the TTL".
 *  - drop the duplicate route's mark: "a duplicate"; drop the import route's mark: "an import".
 *  - mark the move's source AFTER its landings again: "a case-only rename". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const trash = vi.hoisted(() => ({ refuse: new Set<string>() }));
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    const failed: string[] = [];
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      if (trash.refuse.has(p)) { failed.push(p); continue; }
      fs.rmSync(p, { recursive: true, force: true });
    }
    return { failed };
  },
}));

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { createEditorWriteGuard } from '../../plugins/editorWriteGuard';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let dir: string;
let now = 0;
let guard: ReturnType<typeof createEditorWriteGuard>;
beforeEach(() => {
  dir = makeScratchDir('modoki-own-changes-');
  now = 0;
  guard = createEditorWriteGuard(1500, () => now);
  trash.refuse.clear();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function ctx(): BackendContext {
  return {
    projectRoot: dir,
    resolveAssetPath: (p: string) => path.join(dir, p),
    rebuildManifest: () => ({ version: 2, assets: [], folders: [] }),
    getManifest: () => ({ version: 2, assets: [], folders: [] }),
    absToAssetUrl: (abs: string) => `/${path.relative(dir, abs).split(path.sep).join('/')}`,
    requestBrowser: async (op: string, params: unknown) => (op === 'resolve-unsaved'
      ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] }).registries ?? [] }
      : { ok: true, notes: [] }),
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
    markEditorWrite: guard.mark,
  } as unknown as BackendContext;
}
const post = (urlPath: string, body: unknown) =>
  handleBackendRequest(ctx(), { method: 'POST', urlPath, query: new URLSearchParams(), body }) as Promise<{ status?: number; body: Record<string, unknown> }>;
const put = (rel: string, bytes: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), bytes); };
const abs = (rel: string) => path.join(dir, rel);
/** What the watcher asks on an event for `rel`: the guard, handed a lazy re-hash of the file (null once it is gone). */
const watcherSkips = (rel: string) => guard.isWrite(abs(rel), () => {
  try { return createHash('sha1').update(fs.readFileSync(abs(rel))).digest('hex'); } catch { return null; }
});
const PREFAB = JSON.stringify({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1702', version: 2, name: 'Probe', rootLocalId: 1, entities: [] });

describe('#1702: a delete is the editor`s own change', () => {
  it('a trashed prefab`s unlink is recognised — it does not look external', async () => {
    put('prefabs/probe.prefab.json', PREFAB);
    const r = await post('/api/delete-asset', { paths: ['/prefabs/probe.prefab.json'], rendererWrite: true });
    expect(r.body.ok).toBe(true);
    expect(fs.existsSync(abs('prefabs/probe.prefab.json')), 'premise: it went').toBe(false);
    expect(watcherSkips('prefabs/probe.prefab.json')).toBe(true);
  });

  it('a folder delete marks every file inside it — chokidar reports an unlink per child', async () => {
    put('kit/a.prefab.json', PREFAB);
    put('kit/deep/b.prefab.json', PREFAB);
    put('kit/deep/c.mat.json', '{}');
    const r = await post('/api/delete-asset', { paths: ['/kit'], rendererWrite: true });
    expect(r.body.ok).toBe(true);
    for (const rel of ['kit/a.prefab.json', 'kit/deep/b.prefab.json', 'kit/deep/c.mat.json']) expect(watcherSkips(rel), rel).toBe(true);
  });

  it('an unlink landing past the TTL is still recognised while the file stays gone — and not once it comes back', async () => {
    put('p.prefab.json', PREFAB);
    await post('/api/delete-asset', { paths: ['/p.prefab.json'], rendererWrite: true });
    now = 60_000; // a Finder trash over AppleScript can take seconds
    expect(watcherSkips('p.prefab.json')).toBe(true);
    put('p.prefab.json', PREFAB); // someone else re-creates it
    expect(watcherSkips('p.prefab.json'), 'the re-create is external').toBe(false);
  });

  it('a path the trash refused is not marked — its later changes are still external', async () => {
    put('a.prefab.json', PREFAB); put('b.prefab.json', PREFAB);
    trash.refuse.add(abs('b.prefab.json'));
    await post('/api/delete-asset', { paths: ['/a.prefab.json', '/b.prefab.json'], rendererWrite: true });
    expect(watcherSkips('a.prefab.json')).toBe(true);
    expect(fs.existsSync(abs('b.prefab.json')), 'premise: b stayed').toBe(true);
    expect(watcherSkips('b.prefab.json')).toBe(false);
  });
});

describe('#1702 siblings: the other routes that create a watched file', () => {
  it('a duplicate of a prefab: its add is recognised', async () => {
    put('p.prefab.json', PREFAB);
    const r = await post('/api/duplicate-asset', { from: '/p.prefab.json', to: '/p copy.prefab.json' });
    expect(r.body.ok).toBe(true);
    expect(watcherSkips('p copy.prefab.json')).toBe(true);
  });

  it('an import of a prefab: its add is recognised', async () => {
    const src = path.join(dir, '..', `outside-${path.basename(dir)}.prefab.json`);
    fs.writeFileSync(src, PREFAB);
    try {
      fs.mkdirSync(abs('imported'));
      await post('/api/import-file', { srcPath: src, destFolder: '/imported', reimport: false });
      expect(fs.existsSync(abs(`imported/${path.basename(src)}`)), 'premise: it was copied').toBe(true);
      expect(watcherSkips(`imported/${path.basename(src)}`)).toBe(true);
    } finally { fs.rmSync(src, { force: true }); }
  });

  it('a case-only rename keeps its landing`s content hash — a rename event past the TTL is still ours (close-out review)', async () => {
    guard = createEditorWriteGuard(1500, () => now, 'darwin'); // case-folding keys, whatever this machine is
    put('Crate.prefab.json', PREFAB);
    const r = await post('/api/move-file', { from: '/Crate.prefab.json', to: '/crate.prefab.json' });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    now = 60_000; // past the TTL: only the landing's content hash can still recognise it
    expect(watcherSkips('crate.prefab.json'), 'the source`s TTL-only mark replaced the landing`s hash').toBe(true);
  });
});
