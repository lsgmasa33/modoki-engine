/** #1215 — an agent's asset write takes its target on trust.
 *
 *  Two halves of one defect, both at the route layer:
 *  (a) **no precondition on what the write destroys or orphans** — an existing file
 *      (`/api/write-file` `ifNoneMatch`, A-1), a missing asset (`/api/write-meta`, A-2), the asset's
 *      on-disk identity (`writeMetaSidecar`, A-10), or a human's unsaved work on the path
 *      (`/api/delete-asset`, A-7);
 *  (b) **the reply runs ahead of the state the caller verifies with** — no inline manifest rebuild
 *      (`/api/move-file`, `/api/duplicate-asset`, A-6) and no `saved` field (A-21).
 *
 *  Every refusal has its ACCEPT side beside it. A guard tested only on the reject side is how the
 *  next author "fixes" a spurious refusal by deleting the precondition.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/** The OS trash, stubbed: a real one shells out to Finder/trash-put. The partial-failure branches
 *  are covered in deleteAssetRouter.test.ts; this file only needs "it went". */
const trashed: string[][] = [];
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    const list = Array.isArray(paths) ? paths : [paths];
    trashed.push(list);
    for (const p of list) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));

import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { readMetaSidecar } from '../../plugins/meta-sidecar';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let projectRoot = '';
/** Renderer calls, `[op, params]`. */
let asked: Array<{ op: string; params: unknown }> = [];
let rebuilds = 0;
/** What the stub renderer reports as held, per registry. */
let heldNow: Array<{ path: string; registry: string }> = [];

const ALL = ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'];

/** A renderer that answers the #889 probe. `covers` is required — a reply without it reads as a
 *  skewed renderer and refuses. With `paths` it filters holds to those paths exactly, which is what
 *  the real op does; with none it returns every hold, the global mode. */
function resolveUnsaved(params: unknown) {
  const p = (params ?? {}) as { paths?: string[]; registries?: string[] };
  const registries = p.registries?.length ? p.registries : ALL;
  const holds = heldNow.filter((h) => registries.includes(h.registry)
    && (p.paths === undefined || p.paths.includes(h.path)));
  return { ok: true, holds, discarded: [], covers: registries };
}

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (abs: string) => `/${path.relative(projectRoot, abs).split(path.sep).join('/')}`,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => { rebuilds++; return { version: 2, assets: [] } as Manifest; },
    requestBrowser: async (op: string, params: unknown) => {
      asked.push({ op, params });
      if (op === 'resolve-unsaved') return resolveUnsaved(params);
      return { ok: true, notes: [] };
    },
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

type Reply = { status?: number; body: Record<string, unknown> };
const post = async (urlPath: string, body: unknown, ctx = makeCtx()) =>
  (await handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body })) as Reply;

const abs = (rel: string) => path.join(projectRoot, rel.replace(/^\//, ''));
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
};

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  projectRoot = makeScratchDir('modoki-asset-preconditions-');
  asked = [];
  rebuilds = 0;
  heldNow = [];
  trashed.length = 0;
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('A-1: /api/write-file ifNoneMatch — a create cannot overwrite', () => {
  it('refuses 409 when the file exists, and leaves it untouched', async () => {
    write('/m/probe.mat.json', '{"id":"old"}\n');
    const r = await post('/api/write-file', { path: '/m/probe.mat.json', content: '{"id":"new"}\n', ifNoneMatch: '*' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: true, reason: 'if-none-match' });
    expect(fs.readFileSync(abs('/m/probe.mat.json'), 'utf-8')).toBe('{"id":"old"}\n');
  });

  it('writes when the file does not exist', async () => {
    const r = await post('/api/write-file', { path: '/m/fresh.mat.json', content: '{"id":"new"}\n', ifNoneMatch: '*' });
    expect(r.body.ok).toBe(true);
    expect(fs.readFileSync(abs('/m/fresh.mat.json'), 'utf-8')).toBe('{"id":"new"}\n');
  });

  it('absent ifNoneMatch still overwrites — scene save, prefab save and re-import depend on it', async () => {
    write('/s/level.scene.json', 'old');
    const r = await post('/api/write-file', { path: '/s/level.scene.json', content: 'new' });
    expect(r.body.ok).toBe(true);
    expect(fs.readFileSync(abs('/s/level.scene.json'), 'utf-8')).toBe('new');
  });
});

describe('A-2: /api/write-meta refuses a sidecar for an asset that is not there', () => {
  it('404 NOT_FOUND for a missing asset, and no orphan .meta.json is written', async () => {
    const r = await post('/api/write-meta', { path: '/tex/typo.png', meta: { id: GUID_A } });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(String(r.body.error)).toMatch(/\/tex\/typo\.png/);
    expect(Array.isArray(r.body.options) && (r.body.options as string[]).join(' ')).toMatch(/modoki_list_assets/);
    expect(fs.existsSync(`${abs('/tex/typo.png')}.meta.json`)).toBe(false);
  });

  it('the SIDECAR path itself is refused — the mistake the error message names', async () => {
    write('/tex/rock.png', 'png-bytes');
    write('/tex/rock.png.meta.json', JSON.stringify({ id: GUID_A, version: 1 }));
    const r = await post('/api/write-meta', { path: '/tex/rock.png.meta.json', meta: { texture: { maxSize: 512 } } });
    expect(r.status).toBe(404);
    expect(String(r.body.error)).toMatch(/is a sidecar/);
    expect(fs.existsSync(`${abs('/tex/rock.png.meta.json')}.meta.json`)).toBe(false);
  });

  it('a FOLDER is refused — no sidecar describes a directory', async () => {
    fs.mkdirSync(abs('/fx'), { recursive: true });
    const r = await post('/api/write-meta', { path: '/fx', meta: {} });
    expect(r.status).toBe(404);
    expect(fs.existsSync(`${abs('/fx')}.meta.json`)).toBe(false);
  });

  it('the renderer\'s own flush is NOT refused — a stranded park must still be able to clear', async () => {
    // `flushPendingMeta` re-parks every non-conflict failure, and nothing drops a sidecar park when
    // its asset disappears. Refusing it here means every later save 404s and re-parks, forever.
    fs.mkdirSync(abs('/tex'), { recursive: true });
    const r = await post('/api/write-meta', { path: '/tex/gone.png', meta: { id: GUID_A }, rendererWrite: true });
    expect(r.body.ok).toBe(true);
  });

  it('writes when the asset exists', async () => {
    write('/tex/rock.png', 'png-bytes');
    const r = await post('/api/write-meta', { path: '/tex/rock.png', meta: { id: GUID_A } });
    expect(r.body.ok).toBe(true);
    expect(readMetaSidecar(abs('/tex/rock.png')).id).toBe(GUID_A);
  });
});

describe('A-2 sibling (close-out sweep): /api/asset-write edits an asset, it does not create one', () => {
  const MAT = { id: GUID_A, shader: 'standard' };

  it('an agent write to a missing path is NOT_FOUND, and no file appears', async () => {
    const r = await post('/api/asset-write', { path: '/m/typo.mat.json', type: 'material', data: MAT });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((r.body.options as string[]).join(' ')).toMatch(/modoki_create_asset/);
    expect(fs.existsSync(abs('/m/typo.mat.json'))).toBe(false);
  });

  it('a FOLDER is NOT_FOUND too, not an EISDIR 500', async () => {
    fs.mkdirSync(abs('/m/sub.mat.json'), { recursive: true });
    const r = await post('/api/asset-write', { path: '/m/sub.mat.json', type: 'material', data: MAT });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });

  it('the editor\'s own flush (selfWrite) is not refused on that ground', async () => {
    const r = await post('/api/asset-write', { path: '/m/flushed.mat.json', type: 'material', data: MAT, selfWrite: true });
    expect(r.status).not.toBe(404);
  });

  it('an agent write to an existing asset still goes through', async () => {
    write('/m/rock.mat.json', `${JSON.stringify(MAT, null, 2)}\n`);
    const r = await post('/api/asset-write', { path: '/m/rock.mat.json', type: 'material', data: { ...MAT, shader: 'unlit' } });
    expect(r.status).not.toBe(404);
    expect(r.body.ok).toBe(true);
  });
});

describe('A-10: a sidecar write without an id keeps the id on disk', () => {
  it('a VALID sidecar posted without `id` keeps its GUID', async () => {
    write('/tex/rock.png', 'png-bytes');
    write('/tex/rock.png.meta.json', JSON.stringify({ id: GUID_A, version: 1, texture: { maxSize: 1024 } }));
    const r = await post('/api/write-meta', { path: '/tex/rock.png', meta: { texture: { maxSize: 512 } } });
    expect(r.body.ok).toBe(true);
    const meta = readMetaSidecar(abs('/tex/rock.png'));
    expect(meta.id).toBe(GUID_A);
    expect((meta.texture as { maxSize: number }).maxSize).toBe(512);
  });

  it('a caller-supplied GUID still wins over the one on disk', async () => {
    write('/tex/rock.png', 'png-bytes');
    write('/tex/rock.png.meta.json', JSON.stringify({ id: GUID_A, version: 1 }));
    await post('/api/write-meta', { path: '/tex/rock.png', meta: { id: GUID_B } });
    expect(readMetaSidecar(abs('/tex/rock.png')).id).toBe(GUID_B);
  });

  it('no sidecar on disk and no id posted writes no id (the scan mints one, as before)', async () => {
    write('/tex/rock.png', 'png-bytes');
    await post('/api/write-meta', { path: '/tex/rock.png', meta: {} });
    expect(readMetaSidecar(abs('/tex/rock.png')).id).toBeUndefined();
  });
});

describe('A-7: an agent delete refuses while a human holds unsaved work on the path', () => {
  it('refuses 409 REQUIRES_SAVE and trashes nothing', async () => {
    write('/fx/spark.particle.json', '{}');
    heldNow = [{ path: '/fx/spark.particle.json', registry: 'dirtyAsset' }];
    const r = await post('/api/delete-asset', { paths: ['/fx/spark.particle.json'] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REQUIRES_SAVE' });
    expect((r.body.options as string[]).join(' ')).toMatch(/discardUnsaved:true/);
    expect(trashed).toEqual([]);
    expect(fs.existsSync(abs('/fx/spark.particle.json'))).toBe(true);
  });

  it('a hold INSIDE a deleted folder refuses the folder delete', async () => {
    write('/fx/sub/spark.particle.json', '{}');
    heldNow = [{ path: '/fx/sub/spark.particle.json', registry: 'dirtyAsset' }];
    const r = await post('/api/delete-asset', { paths: ['/fx/sub'] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('REQUIRES_SAVE');
    expect(trashed).toEqual([]);
  });

  it('a hold on a SIBLING whose name shares the prefix does not refuse (`/fx/sub` vs `/fx/subway`)', async () => {
    write('/fx/sub/a.particle.json', '{}');
    write('/fx/subway.particle.json', '{}');
    heldNow = [{ path: '/fx/subway.particle.json', registry: 'dirtyAsset' }];
    const r = await post('/api/delete-asset', { paths: ['/fx/sub'] });
    expect(r.body.ok).toBe(true);
    expect(trashed).toHaveLength(1);
  });

  it('a path in DIFFERENT CASE still finds the hold (case-insensitive filesystems trash the same file)', async () => {
    write('/fx/spark.particle.json', '{}');
    heldNow = [{ path: '/fx/spark.particle.json', registry: 'dirtyAsset' }];
    // The stub echoes the request's casing, as `absToAssetUrl` does on APFS.
    const ctx = makeCtx({
      resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '').toLowerCase()),
      absToAssetUrl: () => '/FX/spark.particle.json',
    });
    const r = await post('/api/delete-asset', { paths: ['/FX/spark.particle.json'] }, ctx);
    expect(r.status).toBe(409);
    expect(trashed).toEqual([]);
  });

  it('a hold recorded in DIFFERENT CASE from a lowercase request still refuses (the other half of the match)', async () => {
    write('/fx/spark.particle.json', '{}');
    heldNow = [{ path: '/FX/Spark.particle.json', registry: 'dirtyAsset' }];
    const r = await post('/api/delete-asset', { paths: ['/fx/spark.particle.json'] });
    expect(r.status).toBe(409);
    expect(trashed).toEqual([]);
  });

  it('the asset ROOT (no canonical url) is gated against every hold, not skipped', async () => {
    write('/fx/spark.particle.json', '{}');
    heldNow = [{ path: '/fx/spark.particle.json', registry: 'dirtyAsset' }];
    const ctx = makeCtx({ absToAssetUrl: () => null as unknown as string });
    const r = await post('/api/delete-asset', { paths: ['/'] }, ctx);
    expect(r.status).toBe(409);
    expect(trashed).toEqual([]);
  });

  it('a live-world edit does not refuse: deleting the file does not destroy the world', async () => {
    write('/s/level.scene.json', '{}');
    heldNow = [{ path: '/s/level.scene.json', registry: 'liveScene' }];
    const r = await post('/api/delete-asset', { paths: ['/s/level.scene.json'] });
    expect(r.body.ok).toBe(true);
  });

  it('discardUnsaved:true deletes anyway, and asks the renderer to repair the dead path', async () => {
    write('/fx/spark.particle.json', '{}');
    heldNow = [{ path: '/fx/spark.particle.json', registry: 'dirtyAsset' }];
    const r = await post('/api/delete-asset', { paths: ['/fx/spark.particle.json'], discardUnsaved: true });
    expect(r.body.ok).toBe(true);
    expect(trashed).toHaveLength(1);
    expect(asked.some((a) => a.op === 'resolve-unsaved')).toBe(false);
  });

  it('rendererWrite:true (the Assets panel, the Cleanup dialog) is not gated — the human chose to delete', async () => {
    write('/fx/spark.particle.json', '{}');
    heldNow = [{ path: '/fx/spark.particle.json', registry: 'dirtyAsset' }];
    const r = await post('/api/delete-asset', { paths: ['/fx/spark.particle.json'], rendererWrite: true });
    expect(r.body.ok).toBe(true);
    expect(trashed).toHaveLength(1);
    expect(asked.some((a) => a.op === 'resolve-unsaved')).toBe(false);
  });

  it('nothing held → deletes', async () => {
    write('/fx/spark.particle.json', '{}');
    const r = await post('/api/delete-asset', { paths: ['/fx/spark.particle.json'] });
    expect(r.body.ok).toBe(true);
    expect(trashed).toHaveLength(1);
  });

  it('a renderer that does not answer refuses (NO_RENDERER) — "could not look" is not "nothing is there"', async () => {
    write('/fx/spark.particle.json', '{}');
    const ctx = makeCtx({
      requestBrowser: (async (op: string) => {
        if (op === 'resolve-unsaved') return { ok: true };  // no `covers`
        return { ok: true, notes: [] };
      }) as BackendContext['requestBrowser'],
    });
    const r = await post('/api/delete-asset', { paths: ['/fx/spark.particle.json'] }, ctx);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('NO_RENDERER');
    expect(trashed).toEqual([]);
  });
});

describe('A-6: move and duplicate rebuild the manifest before replying', () => {
  it('/api/move-file', async () => {
    write('/fx/a.particle.json', '{"id":"x"}');
    const r = await post('/api/move-file', { from: '/fx/a.particle.json', to: '/fx/b.particle.json' });
    expect(r.body.ok).toBe(true);
    expect(rebuilds).toBe(1);
    expect(r.body.manifestRebuilt).toBe(true);
  });

  it('/api/duplicate-asset', async () => {
    write('/fx/a.particle.json', `{"id":"${GUID_A}"}`);
    const r = await post('/api/duplicate-asset', { from: '/fx/a.particle.json', to: '/fx/b.particle.json' });
    expect(r.body.ok).toBe(true);
    expect(rebuilds).toBe(1);
    expect(r.body.manifestRebuilt).toBe(true);
  });

  it('a rebuild that throws is manifestRebuilt:false, not a failed move — the file DID move', async () => {
    write('/fx/a.particle.json', '{"id":"x"}');
    const r = await post('/api/move-file', { from: '/fx/a.particle.json', to: '/fx/b.particle.json' },
      makeCtx({ rebuildManifest: () => { throw new Error('scan failed'); } }));
    expect(r.body.ok).toBe(true);
    expect(r.body.manifestRebuilt).toBe(false);
    expect(fs.existsSync(abs('/fx/b.particle.json'))).toBe(true);
  });
});

describe('A-21: every disk-writing asset route says saved:true (§8)', () => {
  it('create-folder', async () => {
    expect((await post('/api/create-folder', { path: '/fx' })).body.saved).toBe(true);
  });
  it('move-file', async () => {
    write('/fx/a.particle.json', '{}');
    expect((await post('/api/move-file', { from: '/fx/a.particle.json', to: '/fx/b.particle.json' })).body.saved).toBe(true);
  });
  it('duplicate-asset', async () => {
    write('/fx/a.particle.json', `{"id":"${GUID_A}"}`);
    expect((await post('/api/duplicate-asset', { from: '/fx/a.particle.json', to: '/fx/b.particle.json' })).body.saved).toBe(true);
  });
  it('write-meta', async () => {
    write('/tex/rock.png', 'png');
    expect((await post('/api/write-meta', { path: '/tex/rock.png', meta: {} })).body.saved).toBe(true);
  });
  it('delete-asset', async () => {
    write('/fx/a.particle.json', '{}');
    expect((await post('/api/delete-asset', { paths: ['/fx/a.particle.json'] })).body.saved).toBe(true);
  });
  it('import-file', async () => {
    const srcDir = makeScratchDir('modoki-import-src-');
    try {
      fs.writeFileSync(path.join(srcDir, 'song.txt'), 'x');
      const r = await post('/api/import-file', { srcPath: path.join(srcDir, 'song.txt'), destFolder: '/audio', reimport: false },
        makeCtx({ getManifest: () => ({ version: 2, assets: [{ path: '/audio/song.txt', type: 'audio', guid: GUID_A }] }) as unknown as Manifest }));
      expect(r.body.ok).toBe(true);
      expect(r.body.saved).toBe(true);
    } finally { fs.rmSync(srcDir, { recursive: true, force: true }); }
  });
});
