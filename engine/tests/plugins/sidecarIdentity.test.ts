/** "A sidecar's identity belongs to exactly one live file" (docs/editor.md § "A sidecar's identity belongs to exactly one live file"), through the
 *  real routes, the real resolver and the real manifest scan:
 *  - the COPY half (#1974): a duplicated sliced texture shares no GUID with its source, and the source's slice refs
 *    still resolve to the source;
 *  - the CREATE half (#1975): a file created where an orphaned sidecar sits gets a new identity, on every create route;
 *    and a path where a LIVE file and its sidecar exist is refused or kept exactly as before (the accept side). */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { resolveAssetPath, absToAssetUrl, buildManifest, scanAllAssets, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const TEX = 'aaaaaaaa-1111-4111-8111-111111111111';
const S1 = 'bbbbbbbb-2222-4222-8222-222222222222';
const S2 = 'cccccccc-3333-4333-8333-333333333333';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let dir = '';
let assets = '';
let outside = '';
let ctx: BackendContext;
let manifest: Manifest;

beforeEach(() => {
  dir = makeScratchDir('modoki-sidecar-identity-');
  assets = path.join(dir, 'runtime', 'assets');
  outside = path.join(dir, 'incoming');
  fs.mkdirSync(path.join(assets, 'art'), { recursive: true });
  fs.mkdirSync(outside);
  const roots: AssetRoot[] = [{ urlPrefix: '/assets', absDir: assets }];
  const rebuild = () => { manifest = buildManifest(scanAllAssets(roots), true) as Manifest; return manifest; };
  rebuild();
  ctx = {
    projectRoot: dir,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots),
    absToAssetUrl: (abs: string, o?: { onDisk?: boolean }) => absToAssetUrl(abs, roots, o),
    firstRootDir: () => assets,
    getManifest: () => manifest,
    rebuildManifest: rebuild,
    // A renderer that holds nothing: every unsaved-work probe answers "clear".
    requestBrowser: async (op: string, params: unknown) => (op === 'resolve-unsaved'
      ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] }).registries ?? [] }
      : { ok: true }),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    invalidateProjectConfig: () => {},
    ssrLoadModule: async () => { throw new Error('no SSR'); },
  } as unknown as BackendContext;
});

const post = async (urlPath: string, body: unknown) => {
  const r = await handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });
  if (!r || r.kind !== 'json') throw new Error(`${urlPath}: no json reply`);
  return { status: r.status ?? 200, body: r.body as Record<string, unknown> };
};
const abs = (url: string) => path.join(assets, url.slice('/assets/'.length));
/** A sliced texture on disk: `hero.png` defines TEX, S1 and S2. */
function slicedTexture(url: string): void {
  fs.writeFileSync(abs(url), PNG);
  fs.writeFileSync(`${abs(url)}.meta.json`, JSON.stringify({
    id: TEX, version: 1, texture: { type: '2d' },
    spriteSheet: { width: 64, height: 32 },
    sprites: [
      { guid: S1, name: 'idle', rect: { x: 0, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } },
      { guid: S2, name: 'run', rect: { x: 32, y: 0, w: 32, h: 32 }, pivot: { x: 0.5, y: 0.5 } },
    ],
  }));
}
const guidsIn = (file: string) => new Set(fs.readFileSync(file, 'utf8').match(GUID) ?? []);
const entriesFor = (guid: string) => ctx.rebuildManifest().assets.filter((a) => a.guid === guid);

describe('#1974: a copy re-mints every GUID its sidecar defines', () => {
  it('a duplicated sliced texture shares no GUID with its source, and the source\'s slices still resolve to the source', async () => {
    slicedTexture('/assets/art/hero.png');
    // ' copy' sorts BEFORE the original, which is the order that made the original's slice refs draw the copy.
    const r = await post('/api/duplicate-asset', { from: '/assets/art/hero.png', to: '/assets/art/hero copy.png' });
    expect(r.status).toBe(200);

    const source = guidsIn(abs('/assets/art/hero.png') + '.meta.json');
    const copy = guidsIn(abs('/assets/art/hero copy.png') + '.meta.json');
    expect(source).toEqual(new Set([TEX, S1, S2]));
    expect(copy.size).toBe(3);
    expect([...copy].filter((g) => source.has(g))).toEqual([]);

    // One manifest entry per source slice, and it belongs to the source texture.
    for (const s of [S1, S2]) {
      const e = entriesFor(s);
      expect(e).toHaveLength(1);
      expect((e[0] as { sprite?: { texture: string } }).sprite?.texture).toBe(TEX);
    }
  });
});

describe('#1975: a file created where an orphaned sidecar sits gets a new identity', () => {
  /** `art/hero.png` was deleted outside the editor: its sidecar (GUID TEX, slices S1/S2) is all that is left. */
  function orphan(): void {
    slicedTexture('/assets/art/hero.png');
    // Its machine-local half too: a stale conversion record a new file would read as "already converted" (#1279).
    fs.writeFileSync(`${abs('/assets/art/hero.png')}.meta.local.json`, JSON.stringify({ textureCache: { hash: 'dead' } }));
    // And a quarantined copy of its fields (#778), which would read as the NEW file's lost settings. A binary copy's own
    // sidecar write replaces the other two halves, so this one is what holds duplicate-asset to the rule.
    fs.writeFileSync(`${abs('/assets/art/hero.png')}.meta.json.corrupt`, '<<<<<<< dead asset');
    fs.rmSync(abs('/assets/art/hero.png'));
  }
  /** After the create: a fresh GUID, none of the dead asset's slices, no sidecar left that names them. */
  function expectFreshIdentity(): void {
    const m = ctx.rebuildManifest();
    const entry = m.assets.find((a) => a.path === '/assets/art/hero.png');
    expect(entry?.guid).toBeTruthy();
    expect(entry?.guid).not.toBe(TEX);
    for (const g of [TEX, S1, S2]) expect(m.assets.filter((a) => a.guid === g)).toEqual([]);
    expect(fs.existsSync(`${abs('/assets/art/hero.png')}.meta.local.json`)).toBe(false);
    expect(fs.existsSync(`${abs('/assets/art/hero.png')}.meta.json.corrupt`)).toBe(false);
  }

  it('import-file', async () => {
    orphan();
    fs.writeFileSync(path.join(outside, 'hero.png'), PNG);
    const r = await post('/api/import-file', { srcPath: path.join(outside, 'hero.png'), destFolder: '/assets/art', reimport: false });
    expect(r.status).toBe(200);
    expect(r.body.guid).not.toBe(TEX);
    expectFreshIdentity();
  });

  it('write-file (the Assets panel\'s OS drop: a create-only write)', async () => {
    orphan();
    const r = await post('/api/write-file', { path: '/assets/art/hero.png', content: PNG.toString('base64'), encoding: 'base64', ifNoneMatch: '*' });
    expect(r.status).toBe(200);
    expectFreshIdentity();
  });

  it('duplicate-asset onto the orphan\'s path', async () => {
    orphan();
    fs.writeFileSync(abs('/assets/other.png'), PNG);
    const r = await post('/api/duplicate-asset', { from: '/assets/other.png', to: '/assets/art/hero.png' });
    expect(r.status).toBe(200);
    expectFreshIdentity();
  });

  it('move-file of a file with no sidecar of its own onto the orphan\'s path', async () => {
    orphan();
    fs.writeFileSync(abs('/assets/other.png'), PNG); // no sidecar yet: the next scan would mint one
    const r = await post('/api/move-file', { from: '/assets/other.png', to: '/assets/art/hero.png' });
    expect(r.status).toBe(200);
    expectFreshIdentity();
  });

  it('adopt-file into the orphan\'s path', async () => {
    orphan();
    // The Project Settings icon drop: the bytes, a name and a folder, as the dialog sends them.
    const r = await post('/api/adopt-file', { name: 'hero.png', content: PNG.toString('base64'), copyFolder: 'runtime/assets/art' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fs.existsSync(abs('/assets/art/hero.png'))).toBe(true);
    expectFreshIdentity();
  });
});

describe('#1975 accept side: a LIVE file keeps its sidecar', () => {
  it('a create-only write over a live file is refused and its sidecar is untouched', async () => {
    slicedTexture('/assets/art/hero.png');
    const before = fs.readFileSync(abs('/assets/art/hero.png') + '.meta.json', 'utf8');
    const r = await post('/api/write-file', { path: '/assets/art/hero.png', content: PNG.toString('base64'), encoding: 'base64', ifNoneMatch: '*' });
    expect(r.status).toBe(409);
    expect(fs.readFileSync(abs('/assets/art/hero.png') + '.meta.json', 'utf8')).toBe(before);
  });

  it('an overwrite of a live file (a re-import\'s write) keeps its GUID and slices', async () => {
    slicedTexture('/assets/art/hero.png');
    const r = await post('/api/write-file', { path: '/assets/art/hero.png', content: PNG.toString('base64'), encoding: 'base64' });
    expect(r.status).toBe(200);
    expect(entriesFor(TEX)).toHaveLength(1);
    expect(entriesFor(S1)).toHaveLength(1);
  });

  it('import-file onto a live file is still a 409, and its sidecar is untouched', async () => {
    slicedTexture('/assets/art/hero.png');
    const before = fs.readFileSync(abs('/assets/art/hero.png') + '.meta.json', 'utf8');
    fs.writeFileSync(path.join(outside, 'hero.png'), PNG);
    const r = await post('/api/import-file', { srcPath: path.join(outside, 'hero.png'), destFolder: '/assets/art', reimport: false });
    expect(r.status).toBe(409);
    expect(fs.readFileSync(abs('/assets/art/hero.png') + '.meta.json', 'utf8')).toBe(before);
  });

  it('a move carries the moved file\'s OWN sidecar, and a case-only rename keeps it', async () => {
    slicedTexture('/assets/art/hero.png');
    let r = await post('/api/move-file', { from: '/assets/art/hero.png', to: '/assets/art/hero2.png' });
    expect(r.status).toBe(200);
    expect(entriesFor(TEX).map((e) => e.path)).toEqual(['/assets/art/hero2.png']);
    r = await post('/api/move-file', { from: '/assets/art/hero2.png', to: '/assets/art/Hero2.png' });
    expect(r.status).toBe(200);
    expect(entriesFor(TEX)).toHaveLength(1);
    expect(entriesFor(S1)).toHaveLength(1);
  });
});
