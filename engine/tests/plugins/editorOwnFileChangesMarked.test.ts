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
import { createEditorWriteGuard, fingerprintFile } from '../../plugins/editorWriteGuard';
import { createAssetTreeIndex, type TreeEventKind } from '../../plugins/assetTreeIndex';
import { nodeTreeFs } from '../../plugins/assetTreeWatcher';
import { classifySceneChange, pathToClassifyForChange } from '../../plugins/vite-asset-scanner';
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
const watcherSkips = (rel: string) => guard.isWrite(abs(rel), () => fingerprintFile(abs(rel)));
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

/** #1744 — inside the TTL, only the editor's OWN bytes are its echo. The TTL used to answer before the content did, so
 *  for 1.5 s after a save every change to that path was swallowed: a `git checkout` right after `save_all` never
 *  hot-reloaded (the stale undo stack then duplicated a guid), and an outside edit of a parked prefab 816 ms after an
 *  Apply never reached the park (the next Save overwrote it with no dialog). Both observed live; both driven here
 *  through the real `/api/write-file` save, with the outside write made by `fs` the way git or `gsed` makes it.
 *
 *  Mutations: restore the TTL fast path (`if (e.exp > now()) return true` first) → the three outside cases red, the echo
 *  case green; compare the hash only past the TTL but answer false inside it → the echo case red. */
describe('#1744: an outside write inside the TTL is reported; the save`s own echo is not', () => {
  const SCENE = JSON.stringify({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1744', version: 13, entities: [{ guid: 'probe' }] }, null, 2);
  const save = (rel: string, content: string) => post('/api/write-file', { path: `/${rel}`, content });

  it('the save`s own burst, inside the TTL, is still the editor`s echo', async () => {
    const r = await save('scenes/main.scene.json', SCENE);
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    now = 100;
    for (let i = 0; i < 3; i++) expect(watcherSkips('scenes/main.scene.json'), `event ${i} of the burst`).toBe(true);
  });

  it('(1) a checkout of the scene right after the save is an outside change, inside the TTL', async () => {
    await save('scenes/main.scene.json', SCENE);
    now = 200;
    put('scenes/main.scene.json', SCENE.replace('"probe"', '"committed"')); // `git checkout -- main.scene.json`
    expect(watcherSkips('scenes/main.scene.json')).toBe(false);
  });

  it('(2) an outside edit of a prefab 816 ms after its Apply wrote it is an outside change', async () => {
    await save('prefabs/crate.prefab.json', PREFAB);
    now = 816;
    put('prefabs/crate.prefab.json', PREFAB.replace('"Probe"', '"Edited"')); // `gsed -i` on the parked prefab
    expect(watcherSkips('prefabs/crate.prefab.json')).toBe(false);
  });

  it('(3) on macOS/Linux, a checkout that DELETES the just-saved scene is an outside change (close-out review)', async () => {
    guard = createEditorWriteGuard(1500, () => now, 'linux'); // Windows keeps an unreadable read inconclusive
    await save('scenes/main.scene.json', SCENE);
    now = 300;
    fs.rmSync(abs('scenes/main.scene.json')); // `git checkout` of a branch without the scene
    expect(watcherSkips('scenes/main.scene.json')).toBe(false);
  });
});

/** #1708 — on Windows the watcher is ONE recursive `fs.watch` per root, which reports a recycled folder as a single
 *  event. `assetTreeIndex` expands it into the per-file unlinks the marks were written against, and a rescan after an
 *  overflow emits its own. Those SYNTHETIC events must still be recognised as the editor's own, or the delete of a
 *  folder with subfolders reloads the open scene again. The real index over the real scratch dir, the real router, the
 *  real guard — so a spelling the index invents that `normalizeWriteGuardKey` does not fold to the mark fails here.
 *
 *  Mutations, each red here: the index emits the RELATIVE path instead of `join(root, rel)`; the folder expansion
 *  unlinks only the folder itself; drop the delete route's mark loop. */
describe('#1708: the Windows watcher`s synthetic events still meet the marks', () => {
  function watched() {
    const events: Array<[TreeEventKind, string]> = [];
    const index = createAssetTreeIndex({ root: dir, fs: nodeTreeFs, emit: (k, a) => events.push([k, a]) });
    index.seed();
    return { index, events };
  }
  const isOwn = (absPath: string) => guard.isWrite(absPath, () => fingerprintFile(absPath));
  const nested = ['kit/a.prefab.json', 'kit/sub é/b.prefab.json', 'kit/sub é/deeper/c.mat.json'];

  it('the folder expansion of a delete with nested subfolders (one non-ASCII): every unlink is the editor`s own', async () => {
    for (const f of nested) put(f, PREFAB);
    const w = watched();
    const r = await post('/api/delete-asset', { paths: ['/kit'], rendererWrite: true });
    expect(r.body.ok).toBe(true);
    w.index.note({ rel: 'kit', kind: 'rename' }); // what the recursive watch reports for the whole tree
    w.index.flush();
    expect(w.events.map(([k, p]) => [k, p]).sort()).toEqual(nested.map((f) => ['unlink', abs(f)]).sort());
    for (const [, p] of w.events) expect(isOwn(p), p).toBe(true);
  });

  it('the rescan after an overflow: its unlinks are the editor`s own too', async () => {
    for (const f of nested) put(f, PREFAB);
    const w = watched();
    await post('/api/delete-asset', { paths: ['/kit'], rendererWrite: true });
    w.index.note({ overflow: true });
    w.index.flush();
    expect(w.events).toHaveLength(nested.length);
    for (const [, p] of w.events) expect(isOwn(p), p).toBe(true);
  });

  it('an OUTSIDE edit to a prefab still arrives as external and classifies as a prefab change (it must reload)', () => {
    put('prefabs/used.prefab.json', PREFAB);
    const w = watched();
    fs.writeFileSync(abs('prefabs/used.prefab.json'), `${PREFAB}\n`); // an outside tool, no mark
    w.index.note({ rel: path.join('prefabs', 'used.prefab.json'), kind: 'change' });
    w.index.flush();
    expect(w.events).toEqual([['change', abs('prefabs/used.prefab.json')]]);
    const p = w.events[0][1];
    expect(isOwn(p)).toBe(false);
    expect(classifySceneChange(pathToClassifyForChange(p)!.split(path.sep).join('/'))).toBe('prefab');
  });
});
