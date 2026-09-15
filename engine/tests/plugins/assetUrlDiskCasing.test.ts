/** #1261 + #1273 — an asset url is spelled the way the DISK spells it, not the way the request did.
 *
 *  `resolveAssetPath` is lexical, and on a case-insensitive filesystem (APFS, NTFS) an fs op on the
 *  result acts on whatever file matches in any case. The manifest and every renderer registry key the
 *  file by its on-disk name (`scanDir` lists it), so a url echoing the request's casing matched
 *  nothing: a delete or move "repaired" no binding and the next Cmd+S resurrected the file (#1261),
 *  and a create-only 409 could not say which asset was really there, so a scene replaced a prefab
 *  (#1273).
 *
 *  Everything here runs against the REAL resolver and canonicaliser over a scratch dir, because the
 *  mechanism IS the filesystem's case folding — a stubbed `absToAssetUrl` (as the router suites use)
 *  can only restate whichever spelling the stub was written with.
 *
 *  ⚠️ Skipped on a case-SENSITIVE filesystem (Linux CI), where the defect cannot occur: there
 *  `/fx/spark.json` and `/FX/spark.json` are different files, and "the file the request matched" is
 *  the one it named. The free public CI's macos-14 and windows legs run it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/** The OS trash, stubbed: a real one shells out to Finder/trash-put. */
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));

import { handleBackendRequest, saveDialogReply, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { resolveAssetPath, absToAssetUrl, scanAllAssets, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
// A junction on win32, not a bare 'dir' symlink — the latter needs a privilege an unelevated clone lacks (#949).
import { makeDirLink } from '../helpers/linkFixture';

/** Does THIS machine's scratch filesystem fold case? Probed with a positive case, so a probe that
 *  cannot see the folding cannot pass for one that saw none. */
const foldsCase = (() => {
  const dir = makeScratchDir('modoki-caseprobe-');
  try {
    fs.writeFileSync(path.join(dir, 'Probe.txt'), 'x');
    return fs.existsSync(path.join(dir, 'probe.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

let tmp = '';
let roots: AssetRoot[] = [];
let asked: Array<{ op: string; params: unknown }> = [];

beforeEach(() => {
  tmp = makeScratchDir('modoki-diskcase-');
  roots = [{ urlPrefix: '/assets', absDir: tmp }];
  asked = [];
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (rel: string, content = '{}') => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};

function makeCtx(): BackendContext {
  // The REAL scan, so a lookup against the manifest meets the disk's spelling as production does.
  let manifest = { version: 2, assets: [] } as unknown as Manifest;
  return {
    projectRoot: tmp,
    editorRoot: tmp,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots),
    absToAssetUrl: (abs: string, opts?: { onDisk?: boolean }) => absToAssetUrl(abs, roots, opts),
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => (manifest = { version: 2, assets: scanAllAssets(roots) } as unknown as Manifest),
    requestBrowser: async (op: string, params: unknown) => {
      if (op === 'resolve-unsaved') {
        return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] }).registries ?? [] };
      }
      asked.push({ op, params });
      return { ok: true, notes: [] };
    },
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

type Reply = { status?: number; body: Record<string, unknown> };
const call = async (method: 'GET' | 'POST', urlPath: string, body?: unknown, query = new URLSearchParams()) =>
  (await handleBackendRequest(makeCtx(), { method, urlPath, query, body })) as Reply;
/** The `from` of every path repair the route asked the renderer for. */
const repairedFrom = () => asked
  .filter((a) => a.op === 'apply-asset-path-moves')
  .flatMap((a) => (a.params as { moves: Array<{ from: string }> }).moves.map((m) => m.from));

const ON_DISK = { onDisk: true };

describe.skipIf(!foldsCase)('absToAssetUrl with onDisk spells an existing path the way the disk does', () => {
  it('a case-variant of an existing file → the on-disk spelling', () => {
    write('FX/Spark.particle.json');
    expect(absToAssetUrl(path.join(tmp, 'fx', 'spark.particle.json'), roots, ON_DISK)).toBe('/assets/FX/Spark.particle.json');
  });

  it('a path that does not exist keeps the caller\'s spelling — there is no on-disk name to prefer', () => {
    fs.mkdirSync(path.join(tmp, 'FX'));
    expect(absToAssetUrl(path.join(tmp, 'fx', 'new.particle.json'), roots, ON_DISK)).toBe('/assets/fx/new.particle.json');
  });

  it('WITHOUT the option a path keeps its own spelling — the watcher\'s unlink of a case-renamed file names the OLD file', () => {
    // Observed in the close-out review: after this rename `realpathSync.native` of the old name already
    // answers the new one, so a canonicalising watcher reported `unlink level` and nobody heard about
    // `Level` — the scene loaded from it stayed stale.
    write('scenes/Level.scene.json');
    fs.renameSync(path.join(tmp, 'scenes', 'Level.scene.json'), path.join(tmp, 'scenes', 'level.scene.json'));
    expect(absToAssetUrl(path.join(tmp, 'scenes', 'Level.scene.json'), roots)).toBe('/assets/scenes/Level.scene.json');
  });

  it('a root reached THROUGH a symlink still yields the on-disk spelling under its own prefix', () => {
    write('Foo.prefab.json');
    // The link lives in its own scratch parent, removed recursively — `rmSync` does not follow a link
    // or junction, and the same call is what removes one on either platform.
    const parent = makeScratchDir('modoki-diskcase-link-');
    const link = path.join(parent, 'root');
    makeDirLink(tmp, link);
    try {
      const viaLink: AssetRoot[] = [{ urlPrefix: '/assets', absDir: link }];
      expect(absToAssetUrl(path.join(link, 'foo.prefab.json'), viaLink, ON_DISK)).toBe('/assets/Foo.prefab.json');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('a symlinked folder INSIDE the root keeps the link\'s name — never a url built from its target', () => {
    write('real/a.json');
    makeDirLink(path.join(tmp, 'real'), path.join(tmp, 'link'));
    expect(absToAssetUrl(path.join(tmp, 'link', 'a.json'), roots, ON_DISK)).toBe('/assets/link/a.json');
  });
});

describe.skipIf(!foldsCase)('the routes hand out the on-disk spelling (#1261, #1273)', () => {
  it('/api/move-file repairs the SOURCE under its on-disk spelling, taken before the move', async () => {
    write('FX/spark.particle.json');
    const r = await call('POST', '/api/move-file', { from: '/assets/fx/spark.particle.json', to: '/assets/moved.particle.json' });
    expect(r.body.ok).toBe(true);
    expect(repairedFrom()).toEqual(['/assets/FX/spark.particle.json']);
  });

  it('/api/move-file repairs the DESTINATION under its on-disk spelling when its folder is named in another case', async () => {
    write('a.particle.json');
    fs.mkdirSync(path.join(tmp, 'FX'));
    const r = await call('POST', '/api/move-file', { from: '/assets/a.particle.json', to: '/assets/fx/a.particle.json' });
    expect(r.body.ok).toBe(true);
    const moves = asked.filter((a) => a.op === 'apply-asset-path-moves')
      .flatMap((a) => (a.params as { moves: Array<{ to: string }> }).moves.map((m) => m.to));
    expect(moves).toEqual(['/assets/FX/a.particle.json']);
  });

  it('/api/import-file into a folder named in another case finds the asset it just copied', async () => {
    fs.mkdirSync(path.join(tmp, 'prefabs'));
    const src = makeScratchDir('modoki-diskcase-src-');
    try {
      fs.writeFileSync(path.join(src, 'Enemy.prefab.json'), '{"id":"11111111-1111-4111-8111-111111111111","entities":[]}');
      const r = await call('POST', '/api/import-file', { srcPath: path.join(src, 'Enemy.prefab.json'), destFolder: '/assets/PREFABS', reimport: false });
      expect(r.status).toBeUndefined();
      expect(r.body).toMatchObject({ ok: true, path: '/assets/prefabs/Enemy.prefab.json' });
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it('/api/delete-asset repairs under the on-disk spelling', async () => {
    write('FX/spark.particle.json');
    const r = await call('POST', '/api/delete-asset', { paths: ['/assets/fx/SPARK.particle.json'], rendererWrite: true });
    expect(r.body.ok).toBe(true);
    expect(repairedFrom()).toEqual(['/assets/FX/spark.particle.json']);
  });

  it('a create-only /api/write-file 409 names the file that is really there', async () => {
    write('prefabs/Enemy.prefab.json', '{"id":"x"}');
    const r = await call('POST', '/api/write-file', { path: '/assets/prefabs/enemy.prefab.json', content: '{}', ifNoneMatch: '*' });
    expect(r.status).toBe(409);
    expect(r.body.existingPath).toBe('/assets/prefabs/Enemy.prefab.json');
    expect(fs.readFileSync(path.join(tmp, 'prefabs', 'Enemy.prefab.json'), 'utf8')).toBe('{"id":"x"}');
  });

  it('/api/write-file names the file it wrote the way the disk does — a folder typed in another case', async () => {
    fs.mkdirSync(path.join(tmp, 'scenes'));
    const r = await call('POST', '/api/write-file', { path: '/assets/SCENES/new.json', content: '{}', ifNoneMatch: '*' });
    expect(r.body).toEqual({ ok: true, path: '/assets/scenes/new.json' });
  });

  it('/api/save-dialog\'s reply: the TYPED spelling to create from, the on-disk one the panel asked about', () => {
    // `saveDialogReply` is the route's whole answer after osascript returns (which cannot run here).
    write('anims/Walk.json');
    const ctx = makeCtx();
    expect(saveDialogReply(ctx, path.join(tmp, 'anims', 'walk.json')))
      .toEqual({ path: '/assets/anims/walk.json', existingPath: '/assets/anims/Walk.json' });
    expect(saveDialogReply(ctx, path.join(tmp, 'anims', 'Fresh.json'))).toEqual({ path: '/assets/anims/Fresh.json' });
    expect(saveDialogReply(ctx, path.join(path.dirname(tmp), 'elsewhere.json'))).toBeNull();
  });

  it('/api/exists names the on-disk spelling, and nothing when absent', async () => {
    write('scenes/Level.json');
    const q = (p: string) => new URLSearchParams({ path: p });
    expect((await call('GET', '/api/exists', undefined, q('/assets/scenes/level.json'))).body)
      .toEqual({ exists: true, path: '/assets/scenes/Level.json' });
    expect((await call('GET', '/api/exists', undefined, q('/assets/scenes/none.json'))).body).toEqual({ exists: false });
  });
});
