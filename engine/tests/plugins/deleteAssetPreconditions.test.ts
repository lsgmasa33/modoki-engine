/** #1679 — `/api/delete-asset`'s per-path precondition, and the hash `/api/duplicate-asset` reports, against the REAL
 *  router over a real scratch directory.
 *
 *  An undo/redo that trashes a file it created or restored states what it expects there: `ifMatch` (the sha256 of the
 *  bytes, BOM-stripped exactly as `ifMatchRefusal` hashes them for `/api/write-file`) or `ifEmpty` (a folder holding
 *  nothing but OS litter). One miss trashes NOTHING — 409 `reason:'if-match'` naming every miss — so the step can
 *  refuse before anything moved. The trash itself is stubbed to delete from the scratch dir, so what went is observable.
 *
 *  Mutations, each checked: red on the named cases and nothing else in this file:
 *  - skip `deletePreconditionConflicts`: "one mismatch trashes nothing", "a gone file", "a folder with content".
 *  - keep the lone-path 404 when a precondition is present: "a gone file … is a 409".
 *  - count `.DS_Store` as content: "a folder holding only OS litter".
 *  - hash without stripping the BOM: "the BOM is not part of the hash".
 *  - drop `sha256` from the duplicate reply: "the duplicate reports the hash of the bytes it wrote".
 *  - drop the BOM strip from the CLIENT's `sha256OfBytes`: "a base64 write of bytes that start with a BOM".
 *  - move the precondition check above the awaited gates: "the check runs AFTER the gates that await".
 *  #1696 (`ifSettings`), each red on its named cases only:
 *  - skip `sidecarSettingsRefusal`: "a changed import setting refuses", "a non-resolved key", "an unparseable one".
 *  - `sameImportSettings` compares raw (no resolver): "a bake's rewrite is not a change".
 *  - `canonicalJson` without the key sort: "key order is not a change".
 *  - a gone sidecar refuses: "a gone sidecar passes".
 *  - drop the `.meta.json` check in `readDeleteExpectations`: "…not a .meta.json, is a caller bug".
 *  - drop `sidecar` from the duplicate reply: "reports the committed sidecar a binary copy got". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const trashCalls: string[][] = [];
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    const list = Array.isArray(paths) ? paths : [paths];
    trashCalls.push(list);
    for (const p of list) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { sha256OfWritten } from '../../packages/modoki/src/editor/utils/contentHash';
import { resolveTextureSettings, resolveTextureType } from '../../packages/modoki/src/runtime/loaders/textureSettings';

let dir: string;
beforeEach(() => { dir = makeScratchDir('modoki-delete-preconditions-'); trashCalls.length = 0; });
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
    markEditorWrite: () => {},
  } as unknown as BackendContext;
}
const post = (urlPath: string, body: unknown) =>
  handleBackendRequest(ctx(), { method: 'POST', urlPath, query: new URLSearchParams(), body }) as Promise<{ status?: number; body: Record<string, unknown> }>;
const put = (rel: string, bytes: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), bytes); };
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const there = (rel: string) => fs.existsSync(path.join(dir, rel));

describe('/api/delete-asset ifMatch', () => {
  it('accept side: the hash of the bytes on disk trashes the file', async () => {
    put('a.png', 'AAAA');
    const r = await post('/api/delete-asset', { paths: ['/a.png'], ifMatch: { '/a.png': sha('AAAA') }, rendererWrite: true });
    expect(r.status).toBeUndefined();
    expect(r.body.ok).toBe(true);
    expect(there('a.png')).toBe(false);
  });

  it('one mismatch trashes NOTHING, and names every miss', async () => {
    put('a.png', 'AAAA'); put('b.png', 'EDITED'); put('b.png.meta.json', '{}');
    const r = await post('/api/delete-asset', {
      paths: ['/a.png', '/b.png', '/b.png.meta.json'],
      ifMatch: { '/a.png': sha('AAAA'), '/b.png': sha('BBBB') },
      rendererWrite: true,
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: true, reason: 'if-match', conflicts: ['/b.png'] });
    expect(trashCalls).toHaveLength(0);
    expect(there('a.png') && there('b.png') && there('b.png.meta.json')).toBe(true);
  });

  it('a gone file with a precondition is a 409, not the lone-path 404', async () => {
    const r = await post('/api/delete-asset', { path: '/gone.png', ifMatch: sha('x'), rendererWrite: true });
    expect(r.status).toBe(409);
    expect(r.body.conflicts).toEqual(['/gone.png']);
    // …and without one the back-compat 404 stands.
    expect((await post('/api/delete-asset', { path: '/gone.png', rendererWrite: true })).status).toBe(404);
  });

  it('the BOM is not part of the hash — the same rule `/api/write-file` applies', async () => {
    put('t.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"id":"t"}\n')]));
    const r = await post('/api/delete-asset', { path: '/t.json', ifMatch: sha('{"id":"t"}\n'), rendererWrite: true });
    expect(r.body.ok).toBe(true);
    expect(there('t.json')).toBe(false);
  });

  it('a precondition on a path the request does not trash is refused as a caller bug', async () => {
    put('a.png', 'AAAA');
    const r = await post('/api/delete-asset', { paths: ['/a.png'], ifMatch: { '/other.png': sha('AAAA') }, rendererWrite: true });
    expect(r.status).toBe(400);
    expect(there('a.png')).toBe(true);
  });
});

describe('/api/delete-asset ifMatch — the close-out review\'s cases', () => {
  it('a base64 write of bytes that start with a BOM is matched by the client\'s hash of what it wrote', async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('newmtl x\n')]);
    put('m.mtl', bom); // the exact bytes a base64 write of `bom` stores (write-file decodes and writes verbatim)
    const r = await post('/api/delete-asset', { path: '/m.mtl', ifMatch: await sha256OfWritten(bom.toString('base64'), 'base64'), rendererWrite: true });
    expect(r.body.ok).toBe(true);
    expect(there('m.mtl')).toBe(false);
  });

  it('the check runs AFTER the gates that await: a file changed during an agent delete\'s unsaved-work probe is refused', async () => {
    put('a.png', 'AAAA');
    // The agent path (no rendererWrite) awaits the renderer's unsaved-work probe. The file changes while it waits.
    const racing = { ...ctx(), requestBrowser: async (op: string, params: unknown) => {
      if (op === 'resolve-unsaved') { put('a.png', 'EDITED'); return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] }).registries ?? [] }; }
      return { ok: true, notes: [] };
    } } as unknown as BackendContext;
    const r = await handleBackendRequest(racing, { method: 'POST', urlPath: '/api/delete-asset', query: new URLSearchParams(), body: { path: '/a.png', ifMatch: sha('AAAA') } }) as { status?: number };
    expect(r.status).toBe(409);
    expect(fs.readFileSync(path.join(dir, 'a.png'), 'utf8')).toBe('EDITED');
  });
});

describe('/api/delete-asset ifEmpty', () => {
  it('a folder holding only OS litter is empty, and is trashed', async () => {
    put('F/.DS_Store', 'finder');
    const r = await post('/api/delete-asset', { path: '/F', ifEmpty: true, rendererWrite: true });
    expect(r.body.ok).toBe(true);
    expect(there('F')).toBe(false);
  });

  it('a folder with content — a stray sidecar counts — is refused and kept whole', async () => {
    put('G/x.png.meta.json', '{}');
    const r = await post('/api/delete-asset', { paths: ['/G'], ifEmpty: ['/G'], rendererWrite: true });
    expect(r.status).toBe(409);
    expect(there('G/x.png.meta.json')).toBe(true);
  });
});

describe('/api/delete-asset ifSettings (#1696) — a sidecar is trashed only while it holds the import settings expected', () => {
  // Typed as the resolvers take it (a sidecar document), not as the literal's narrower inferred shape.
  const SIDE: { id: string; texture: Record<string, unknown> } = { id: 'aaaaaaaa-0000-4000-8000-000000000002', texture: { maxSize: 512 } };
  const trash = (body: Record<string, unknown>) => post('/api/delete-asset', { paths: ['/t.png', '/t.png.meta.json'], rendererWrite: true, ...body });

  it('a changed import setting refuses, and nothing is trashed — the file included', async () => {
    put('t.png', 'PNG'); put('t.png.meta.json', JSON.stringify({ ...SIDE, texture: { maxSize: 256 } }));
    const r = await trash({ ifMatch: { '/t.png': sha('PNG') }, ifSettings: { '/t.png.meta.json': SIDE } });
    expect(r.status).toBe(409);
    expect(r.body.conflicts).toEqual(['/t.png.meta.json']);
    expect(trashCalls).toHaveLength(0);
    expect(there('t.png') && there('t.png.meta.json')).toBe(true);
  });

  it('a bake\'s rewrite is not a change: resolved defaults, a stamped type, a cache block, a new version and id', async () => {
    put('t.png', 'PNG');
    put('t.png.meta.json', JSON.stringify({
      version: 2, id: 'bbbbbbbb-0000-4000-8000-000000000003', type: resolveTextureType(SIDE),
      texture: resolveTextureSettings(SIDE), textureCache: { hash: 'h', variants: [] },
    }));
    const r = await trash({ ifSettings: { '/t.png.meta.json': SIDE } });
    expect(r.body.ok).toBe(true);
    expect(there('t.png.meta.json')).toBe(false);
  });

  it('key order is not a change', async () => {
    put('t.png.meta.json', '{"texture":{"maxSize":512},"sprites":[{"name":"a","x":0}],"id":"x"}');
    const r = await trash({ ifSettings: { '/t.png.meta.json': { id: 'x', sprites: [{ x: 0, name: 'a' }], texture: { maxSize: 512 } } } });
    expect(r.body.ok).toBe(true);
  });

  it('a non-resolved key (sprite slices) that changed refuses', async () => {
    put('t.png.meta.json', '{"id":"x","sprites":[{"name":"b"}]}');
    const r = await trash({ ifSettings: { '/t.png.meta.json': { id: 'x', sprites: [{ name: 'a' }] } } });
    expect(r.status).toBe(409);
  });

  it('a gone sidecar passes — nothing to lose; an unparseable one refuses — somebody wrote something', async () => {
    put('t.png', 'PNG');
    expect((await trash({ ifSettings: { '/t.png.meta.json': SIDE } })).body.ok).toBe(true);
    put('t.png', 'PNG'); put('t.png.meta.json', '{ not json');
    expect((await trash({ ifSettings: { '/t.png.meta.json': SIDE } })).status).toBe(409);
    expect(there('t.png.meta.json')).toBe(true);
  });

  it('the single-path form takes the document itself', async () => {
    put('t.png.meta.json', JSON.stringify({ ...SIDE, texture: { maxSize: 64 } }));
    expect((await post('/api/delete-asset', { path: '/t.png.meta.json', ifSettings: SIDE, rendererWrite: true })).status).toBe(409);
    put('t.png.meta.json', JSON.stringify(SIDE));
    expect((await post('/api/delete-asset', { path: '/t.png.meta.json', ifSettings: SIDE, rendererWrite: true })).body.ok).toBe(true);
  });

  it('a key outside paths, or one that is not a .meta.json, is a caller bug (400)', async () => {
    put('t.png', 'PNG');
    expect((await trash({ ifSettings: { '/other.png.meta.json': SIDE } })).status).toBe(400);
    expect((await trash({ ifSettings: { '/t.png': SIDE } })).status).toBe(400);
    expect(there('t.png')).toBe(true);
  });
});

describe('/api/duplicate-asset', () => {
  it('reports the committed sidecar a binary copy got (#1696): the source\'s, with a fresh id and no generated list', async () => {
    put('t.png', 'PNG'); put('t.png.meta.json', JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000004', texture: { maxSize: 128 }, generated: { meshes: [] } }));
    const r = await post('/api/duplicate-asset', { from: '/t.png', to: '/t copy.png' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 't copy.png.meta.json'), 'utf8')) as Record<string, unknown>;
    expect(r.body.sidecar).toEqual(onDisk);
    expect(onDisk).toMatchObject({ texture: { maxSize: 128 } });
    expect(onDisk.generated).toBeUndefined();
  });

  it('reports the hash of the bytes it wrote, for the undo to trash the copy by', async () => {
    put('p.prefab.json', '{\n  "id": "aaaaaaaa-0000-4000-8000-000000000001",\n  "name": "P"\n}\n');
    const r = await post('/api/duplicate-asset', { from: '/p.prefab.json', to: '/p copy.prefab.json' });
    expect(r.status).toBeUndefined();
    const onDisk = fs.readFileSync(path.join(dir, 'p copy.prefab.json'));
    expect(onDisk.toString()).not.toContain('000000000001'); // re-minted, so the client could not know these bytes
    expect(r.body.sha256).toBe(sha(onDisk));
  });
});
