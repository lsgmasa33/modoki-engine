/** #1713 — an imported JSON asset keeps its own id unless the project already holds it (owner ruling, 2026-09-28: copy
 *  Unity), and that is decided before its bytes reach disk.
 *
 *  `modoki_import_file` copied the file byte for byte and left identity to the scanner. Importing a copy of an asset
 *  the project already has then put two files under one guid, and the scanner's collision heal keeps the id for the
 *  path that sorts FIRST: an import sorting before its original re-minted the ORIGINAL, and every ref to it silently
 *  re-pointed at the import. The Assets panel's OS drop had the same defect by another route (`/api/write-file`,
 *  verbatim); it now takes its bytes from `/api/import-identity`, the same decision.
 *
 *  Over the REAL scan (`scanAllAssets`, which heals a collision exactly as production does), so the harm the fix
 *  prevents is observed rather than assumed: the original sorts AFTER the import folder.
 *
 *  Mutations, each checked red: `/api/import-file` back to `copyFileSync` — the colliding prefab, colliding scene and
 *  no-id cases go red, and every keep case stays green; `importedAssetBytes` ignoring `guidTaken` (always mint) — the three
 *  keep cases go red; ignoring the collision (never mint) — both colliding cases and the route's colliding case go
 *  red; the route answering the bytes it was given — its colliding case goes red; reading every source whole (the
 *  `importDecidesIdentity` gate dropped) — only the never-read case goes red; the route ignoring `claimed` — only the
 *  batch case goes red. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { resolveAssetPath, absToAssetUrl, scanAllAssets, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';

const ORIGINAL_ID = '11111111-1111-4111-8111-111111111111';
const UNUSED_ID = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const CHILD = '44444444-4444-4444-8444-444444444444';

let tmp = '';
let src = '';
let roots: AssetRoot[] = [];
let manifest: Manifest;

function makeCtx(): BackendContext {
  return {
    projectRoot: tmp,
    editorRoot: tmp,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots),
    absToAssetUrl: (abs: string, opts?: { onDisk?: boolean }) => absToAssetUrl(abs, roots, opts),
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => (manifest = { version: 2, assets: scanAllAssets(roots) } as unknown as Manifest),
    requestBrowser: async () => ({ ok: true }),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

type Reply = { status?: number; body: Record<string, unknown> };
const post = async (urlPath: string, body: unknown) =>
  (await handleBackendRequest(makeCtx(), { method: 'POST', urlPath, query: new URLSearchParams(), body })) as Reply;
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(tmp, rel), 'utf-8'));
const writeAt = (dir: string, rel: string, content: string | Buffer) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const prefab = (id: string) => JSON.stringify({ id, entities: [{ name: 'Box', traits: {} }] });

beforeEach(() => {
  tmp = makeScratchDir('modoki-import-identity-');
  src = makeScratchDir('modoki-import-identity-src-');
  roots = [{ urlPrefix: '/assets', absDir: tmp }];
  // The original sorts AFTER `/assets/imp/…`, so a colliding import is the path the heal would keep the id for.
  writeAt(tmp, 'zoo/Box.prefab.json', prefab(ORIGINAL_ID));
  fs.mkdirSync(path.join(tmp, 'imp'));
  manifest = { version: 2, assets: scanAllAssets(roots) } as unknown as Manifest;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe('/api/import-file: a JSON asset keeps its id unless the project holds it (#1713)', () => {
  it('a copy of an asset already in the project: the import gets its own guid, and the ORIGINAL keeps its id', async () => {
    const from = writeAt(src, 'Box.prefab.json', prefab(ORIGINAL_ID));
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body).toMatchObject({ ok: true, path: '/assets/imp/Box.prefab.json', type: 'prefab' });
    expect(r.body.guid).not.toBe(ORIGINAL_ID);
    expect(readJson('imp/Box.prefab.json').id).toBe(r.body.guid);
    expect(readJson('zoo/Box.prefab.json').id, 'the scanner re-minted the original — every ref to it now names the import').toBe(ORIGINAL_ID);
    expect(readJson('imp/Box.prefab.json').entities).toEqual([{ name: 'Box', traits: {} }]);
  });

  it('KEEP SIDE: an id no asset holds is kept, and the file lands byte for byte', async () => {
    const bytes = prefab(UNUSED_ID);
    const from = writeAt(src, 'Crate.prefab.json', bytes);
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body).toMatchObject({ ok: true, guid: UNUSED_ID });
    expect(fs.readFileSync(path.join(tmp, 'imp/Crate.prefab.json'), 'utf-8')).toBe(bytes);
  });

  it('a file with no id gets one', async () => {
    const from = writeAt(src, 'Bare.prefab.json', JSON.stringify({ entities: [] }));
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.guid).toBe('string');
    expect(readJson('imp/Bare.prefab.json').id).toBe(r.body.guid);
  });

  const scene = (id: string) => ({ id, version: SCENE_FORMAT_VERSION, entities: [
    { name: 'Parent', traits: { EntityAttributes: { guid: PARENT } } },
    { name: 'Child', parentId: PARENT, traits: { EntityAttributes: { guid: CHILD } } },
  ] });

  it('a colliding scene: fresh scene id AND reminted entity guids, the child still pointing at its parent', async () => {
    const from = writeAt(src, 'Level.scene.json', JSON.stringify(scene(ORIGINAL_ID)));
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body).toMatchObject({ ok: true, type: 'scene' });
    const got = readJson('imp/Level.scene.json');
    expect(got.id).toBe(r.body.guid);
    expect(got.id).not.toBe(ORIGINAL_ID);
    const [parent, child] = got.entities;
    expect(parent.traits.EntityAttributes.guid).not.toBe(PARENT);
    expect(child.traits.EntityAttributes.guid).not.toBe(CHILD);
    expect(child.parentId).toBe(parent.traits.EntityAttributes.guid);
  });

  it('KEEP SIDE: a scene no asset holds keeps its id and its entity guids', async () => {
    const from = writeAt(src, 'Level.scene.json', JSON.stringify(scene(UNUSED_ID)));
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body).toMatchObject({ ok: true, type: 'scene', guid: UNUSED_ID });
    expect(readJson('imp/Level.scene.json')).toEqual(scene(UNUSED_ID));
  });

  it('OTHER SIDE: a binary is copied byte for byte (the scan mints its sidecar)', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const from = writeAt(src, 'dot.png', bytes);
    const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
    expect(r.body.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'imp/dot.png')).equals(bytes)).toBe(true);
  });

  it('a binary is never read into memory — a file past 2 GiB, which readFileSync refuses, still imports (close-out review)', async () => {
    const from = writeAt(src, 'clip.mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const r = await post('/api/import-file', { srcPath: from, destFolder: '/assets/imp', reimport: false });
      expect(r.body.ok).toBe(true);
      expect(read.mock.calls.map((c) => String(c[0])), 'the source was read whole').not.toContain(from);
    } finally { read.mockRestore(); }
  });
});

describe('/api/import-identity: the Assets panel drop takes the same decision (#1713)', () => {
  const ask = (p: string, text: string) => post('/api/import-identity', { path: p, content: Buffer.from(text).toString('base64') });
  const docOf = (r: Reply) => JSON.parse(Buffer.from(String(r.body.content), 'base64').toString('utf-8'));

  it('a colliding prefab comes back under a fresh id, and nothing is written', async () => {
    const r = await ask('/assets/imp/Box.prefab.json', prefab(ORIGINAL_ID));
    expect(r.body.ok).toBe(true);
    expect(docOf(r).id).toBe(r.body.guid);
    expect(docOf(r).id).not.toBe(ORIGINAL_ID);
    expect(fs.existsSync(path.join(tmp, 'imp/Box.prefab.json'))).toBe(false);
  });

  it('KEEP SIDE: a prefab no asset holds comes back exactly as sent', async () => {
    const r = await ask('/assets/imp/Crate.prefab.json', prefab(UNUSED_ID));
    expect(r.body).toMatchObject({ ok: true, content: Buffer.from(prefab(UNUSED_ID)).toString('base64') });
    expect(r.body.guid).toBeUndefined();
  });

  it("a batch: an id the panel already decided on for this batch counts as taken — the manifest cannot see it yet", async () => {
    // The panel writes through /api/write-file, which rebuilds no manifest: without `claimed`, a file and its Finder
    // duplicate carrying one unused id both kept it (close-out re-review, observed).
    const first = await ask('/assets/imp/Crate.prefab.json', prefab(UNUSED_ID));
    expect(first.body.id).toBe(UNUSED_ID);
    const second = await post('/api/import-identity', {
      path: '/assets/imp/Crate copy.prefab.json', content: Buffer.from(prefab(UNUSED_ID)).toString('base64'), claimed: [UNUSED_ID.toUpperCase()],
    });
    expect(second.body.guid).toBeDefined();
    expect(docOf(second).id).toBe(second.body.guid);
    expect(second.body.id).toBe(second.body.guid);
  });

  it('OTHER SIDE: a non-asset or binary file comes back exactly as sent, with no guid — even carrying a taken id', async () => {
    for (const p of ['/assets/imp/dot.png', '/assets/imp/notes.json', '/assets/imp/Box.prefab.json.meta.json']) {
      const content = Buffer.from(`{"id":"${ORIGINAL_ID}"}`).toString('base64');
      const r = await post('/api/import-identity', { path: p, content });
      expect(r.body, p).toMatchObject({ ok: true, content });
      expect(r.body.guid, p).toBeUndefined();
    }
  });
});
