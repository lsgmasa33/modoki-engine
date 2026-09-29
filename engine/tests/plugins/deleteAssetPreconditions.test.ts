/** #1679 — `/api/delete-asset`'s per-path precondition, and the hash `/api/duplicate-asset` reports, against the REAL
 *  router over a real scratch directory.
 *
 *  A trash of a file the caller created states what it expects there: `ifMatch` (the sha256 of the bytes, BOM-stripped
 *  exactly as `ifMatchRefusal` hashes them for `/api/write-file`) — a prefab commit's rollback. One miss trashes NOTHING
 *  — 409 `reason:'if-match'` naming every miss. (`ifEmpty` and `ifSettings` went with the Assets file-op undo builders,
 *  their only callers, #1868.) The trash itself is stubbed to delete from the scratch dir, so what went is observable.
 *
 *  Mutations, each checked: red on the named cases and nothing else in this file:
 *  - skip `deletePreconditionConflicts`: "one mismatch trashes nothing", "a gone file".
 *  - keep the lone-path 404 when a precondition is present: "a gone file … is a 409".
 *  - hash without stripping the BOM: "the BOM is not part of the hash".
 *  - drop the BOM strip from the CLIENT's `sha256OfBytes`: "a base64 write of bytes that start with a BOM".
 *  - move the precondition check above the awaited gates: "the check runs AFTER the gates that await".
 *  (The duplicate's reported hash and sidecar went with the duplicate's undo, #1868.) */

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

describe('/api/duplicate-asset', () => {
  it('a binary copy gets the source\'s committed sidecar, with a fresh id and no generated list (#1696)', async () => {
    put('t.png', 'PNG'); put('t.png.meta.json', JSON.stringify({ id: 'aaaaaaaa-0000-4000-8000-000000000004', texture: { maxSize: 128 }, generated: { meshes: [] } }));
    await post('/api/duplicate-asset', { from: '/t.png', to: '/t copy.png' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 't copy.png.meta.json'), 'utf8')) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ texture: { maxSize: 128 } });
    expect(onDisk.id).not.toBe('aaaaaaaa-0000-4000-8000-000000000004');
    expect(onDisk.generated).toBeUndefined();
  });

  it('a JSON copy is re-minted', async () => {
    put('p.prefab.json', '{\n  "id": "aaaaaaaa-0000-4000-8000-000000000001",\n  "name": "P"\n}\n');
    const r = await post('/api/duplicate-asset', { from: '/p.prefab.json', to: '/p copy.prefab.json' });
    expect(r.status).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'p copy.prefab.json')).toString()).not.toContain('000000000001');
  });
});
