/** #1959 — the ENGINE's built-in asset root (`/modoki/assets`) is READ-ONLY through the project routes (hub ruling,
 *  2026-10-03; Unity's registry packages are immutable). `modoki_delete_asset {path:"/modoki/assets/fonts/Inter.ttf"}`
 *  answered `ok:true` and trashed the engine's own font, while `/api/unused-assets` and `defaultSaveRootDir` already
 *  kept away from that root.
 *
 *  Against the real router and a real scratch disk with TWO roots, the engine's and a project's, so every refusal has
 *  its accept side on the same route: the project root still takes the write. `write-meta` and `reimport` (the
 *  Inspector's import-settings pair) stay open in a dev clone and refuse only in the packaged editor. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { resolveAssetPath, absToAssetUrl, type AssetRoot } from '../../plugins/vite-asset-scanner';

const cleanup: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of cleanup.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

type Reply = { status?: number; body: Record<string, unknown> };
const clearUnsaved = (params: unknown) => ({
  ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] } | undefined)?.registries ?? [],
});

/** A scratch disk holding an engine root (with one built-in font and its sidecar) and a project root. */
function setup(opts: { manifest?: Manifest; chosen?: (engine: string) => string } = {}) {
  const top = makeScratchDir('modoki-engine-root-');
  cleanup.push(top);
  const engine = path.join(top, 'engine-assets');
  const project = path.join(top, 'project');
  fs.mkdirSync(path.join(engine, 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(engine, 'fonts', 'Inter.ttf'), 'ttf');
  fs.writeFileSync(path.join(engine, 'fonts', 'Inter.ttf.meta.json'), '{"id":"inter-guid","version":1}');
  fs.writeFileSync(path.join(project, 'assets', 'hero.png'), 'png');
  const roots: AssetRoot[] = [
    { urlPrefix: '/modoki/assets', absDir: engine },
    { urlPrefix: '/assets', absDir: path.join(project, 'assets') },
  ];
  const manifest = opts.manifest ?? ({ version: 2, assets: [] } as unknown as Manifest);
  const ctx = {
    projectRoot: project,
    editorRoot: top,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots),
    absToAssetUrl: (p: string, o?: { onDisk?: boolean }) => absToAssetUrl(p, roots, o),
    firstRootDir: () => path.join(project, 'assets'),
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    requestBrowser: async (op: string, params: unknown) => (op === 'resolve-unsaved' ? clearUnsaved(params) : { ok: true, notes: [] }),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
    nativeChooser: { saveFile: async () => ({ path: opts.chosen ? opts.chosen(engine) : path.join(project, 'assets', 'x.json') }) },
  } as unknown as BackendContext;
  return { ctx, engine, project, font: path.join(engine, 'fonts', 'Inter.ttf') };
}
const post = (ctx: BackendContext, urlPath: string, body: unknown) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body }) as Promise<Reply>;
const b64 = (s: string) => Buffer.from(s).toString('base64');
/** The coded refusal every route answers for the engine root. */
const expectEngineRefusal = (r: Reply) => {
  expect(r.status).toBe(400);
  expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'engine-asset-root', engineAssetRoot: true });
  expect(String((r.body.options as string[])[0])).toMatch(/engine repo/);
};

describe('#1959 every project write route refuses the engine root, and still takes the project root', () => {
  it('delete-asset: the built-in font stays (the observed case)', async () => {
    const { ctx, font } = setup();
    expectEngineRefusal(await post(ctx, '/api/delete-asset', { path: '/modoki/assets/fonts/Inter.ttf', rendererWrite: true }));
    expect(fs.existsSync(font)).toBe(true);
    expect(fs.existsSync(font + '.meta.json')).toBe(true);
  });

  it('move-file: neither OUT of the engine root nor INTO it', async () => {
    const { ctx, font, project } = setup();
    expectEngineRefusal(await post(ctx, '/api/move-file', { from: '/modoki/assets/fonts/Inter.ttf', to: '/assets/Inter.ttf' }));
    expect(fs.existsSync(font)).toBe(true);
    expectEngineRefusal(await post(ctx, '/api/move-file', { from: '/assets/hero.png', to: '/modoki/assets/hero.png' }));
    expect(fs.existsSync(path.join(project, 'assets', 'hero.png'))).toBe(true);
    // Accept side: a move within the project root.
    expect((await post(ctx, '/api/move-file', { from: '/assets/hero.png', to: '/assets/hero2.png' })).body.ok).toBe(true);
  });

  it('write-file: neither an overwrite of a built-in nor a new file in the root', async () => {
    const { ctx, font, engine, project } = setup();
    expectEngineRefusal(await post(ctx, '/api/write-file', { path: '/modoki/assets/fonts/Inter.ttf', content: b64('x'), encoding: 'base64' }));
    expect(fs.readFileSync(font, 'utf-8')).toBe('ttf');
    expectEngineRefusal(await post(ctx, '/api/write-file', { path: '/modoki/assets/new.txt', content: 'x' }));
    expect(fs.existsSync(path.join(engine, 'new.txt'))).toBe(false);
    // Accept side.
    expect((await post(ctx, '/api/write-file', { path: '/assets/new.txt', content: 'x' })).body.ok).toBe(true);
    expect(fs.existsSync(path.join(project, 'assets', 'new.txt'))).toBe(true);
  });

  it('asset-write and create-asset', async () => {
    const { ctx, engine } = setup();
    expectEngineRefusal(await post(ctx, '/api/asset-write', { path: '/modoki/assets/m.material.json', type: 'material', data: {} }));
    expectEngineRefusal(await post(ctx, '/api/create-asset', { path: '/modoki/assets/m.material.json', type: 'material' }));
    expect(fs.existsSync(path.join(engine, 'm.material.json'))).toBe(false);
    // Accept side for asset-write: the project root is not refused for this reason.
    expect((await post(ctx, '/api/asset-write', { path: '/assets/m2.material.json', type: 'material', data: {} })).body.reason).not.toBe('engine-asset-root');
    // Accept side: the same create in the project root is not refused for this reason.
    expect((await post(ctx, '/api/create-asset', { path: '/assets/m.material.json', type: 'material' })).body.reason).not.toBe('engine-asset-root');
  });

  it('create-folder and import-file', async () => {
    const { ctx, engine, project } = setup();
    expectEngineRefusal(await post(ctx, '/api/create-folder', { path: '/modoki/assets/sub' }));
    expect(fs.existsSync(path.join(engine, 'sub'))).toBe(false);
    const src = path.join(project, 'outside.txt');
    fs.writeFileSync(src, 'x');
    expectEngineRefusal(await post(ctx, '/api/import-file', { srcPath: src, destFolder: '/modoki/assets/fonts', reimport: false }));
    expect(fs.existsSync(path.join(engine, 'fonts', 'outside.txt'))).toBe(false);
    expect((await post(ctx, '/api/create-folder', { path: '/assets/sub' })).body.ok).toBe(true);
  });

  it('the engine root FOLDER itself is inside it too (an import into /modoki/assets/)', async () => {
    const { ctx, engine, project } = setup();
    const src = path.join(project, 'outside.txt');
    fs.writeFileSync(src, 'x');
    expectEngineRefusal(await post(ctx, '/api/import-file', { srcPath: src, destFolder: '/modoki/assets/', reimport: false }));
    expect(fs.existsSync(path.join(engine, 'outside.txt'))).toBe(false);
  });

  it('duplicate-asset: a copy OUT of the engine root is the remedy and is allowed; a copy INTO it is refused', async () => {
    const { ctx, engine, project } = setup();
    expectEngineRefusal(await post(ctx, '/api/duplicate-asset', { from: '/assets/hero.png', to: '/modoki/assets/hero.png' }));
    expect(fs.existsSync(path.join(engine, 'hero.png'))).toBe(false);
    const out = await post(ctx, '/api/duplicate-asset', { from: '/modoki/assets/fonts/Inter.ttf', to: '/assets/Inter.ttf' });
    expect(out.body.reason).not.toBe('engine-asset-root');
    expect(fs.existsSync(path.join(project, 'assets', 'Inter.ttf'))).toBe(true);
  });

  it('scene-save-as', async () => {
    const { ctx, engine } = setup();
    expectEngineRefusal(await post(ctx, '/api/scene-save-as', { path: '/modoki/assets/s.scene.json', content: '{"id":"s","entities":[]}' }));
    expect(fs.existsSync(path.join(engine, 's.scene.json'))).toBe(false);
  });

  it('the save dialog answers engine-asset-root for a location in the engine root, and the url elsewhere', async () => {
    const { ctx } = setup({ chosen: (engine) => path.join(engine, 'x.particle.json') });
    expect((await post(ctx, '/api/save-dialog', {})).body).toMatchObject({ reason: 'engine-asset-root' });
    expect((await post(setup().ctx, '/api/save-dialog', {})).body).toEqual({ path: '/assets/x.json' });
  });
});

describe('#1959 the import-settings pair is a dev-only writer: open in a clone, refused in the packaged editor', () => {
  const META = { id: 'inter-guid', version: 1, font: { size: 48 } };

  it('write-meta on a built-in WRITES in a dev clone', async () => {
    const { ctx, font } = setup();
    const r = await post(ctx, '/api/write-meta', { path: '/modoki/assets/fonts/Inter.ttf', meta: META, rendererWrite: true });
    expect(r.body.reason).not.toBe('engine-asset-root');
    expect(JSON.parse(fs.readFileSync(font + '.meta.json', 'utf-8')).font).toEqual({ size: 48 });
  });

  it('write-meta on a built-in is REFUSED in the packaged editor, and the sidecar is untouched', async () => {
    vi.stubEnv('MODOKI_PACKAGED', '1');
    const { ctx, font } = setup();
    expectEngineRefusal(await post(ctx, '/api/write-meta', { path: '/modoki/assets/fonts/Inter.ttf', meta: META, rendererWrite: true }));
    expect(fs.readFileSync(font + '.meta.json', 'utf-8')).toBe('{"id":"inter-guid","version":1}');
  });

  it('a packaged editor still writes a PROJECT asset\'s import settings', async () => {
    vi.stubEnv('MODOKI_PACKAGED', '1');
    const { ctx } = setup();
    const r = await post(ctx, '/api/write-meta', { path: '/assets/hero.png', meta: { id: 'hero-guid' }, rendererWrite: true });
    expect(r.body.reason).not.toBe('engine-asset-root');
  });

  it('reimport of ONE built-in is refused in the packaged editor only', async () => {
    const manifest = { version: 2, assets: [{ path: '/modoki/assets/fonts/Inter.ttf', type: 'font', guid: 'inter-guid' }] } as unknown as Manifest;
    expect((await post(setup({ manifest }).ctx, '/api/reimport', { path: '/modoki/assets/fonts/Inter.ttf' })).body.reason).not.toBe('engine-asset-root');
    vi.stubEnv('MODOKI_PACKAGED', '1');
    expectEngineRefusal(await post(setup({ manifest }).ctx, '/api/reimport', { path: '/modoki/assets/fonts/Inter.ttf' }));
  });

  it('a recursive reimport in a DEV clone keeps the built-ins, at / and AT the engine root', async () => {
    const manifest = { version: 2, assets: [{ path: '/modoki/assets/fonts/Inter.ttf', type: 'font', guid: 'inter-guid' }] } as unknown as Manifest;
    for (const target of ['/', '/modoki/assets', '/modoki/assets/fonts/']) {
      const r = await post(setup({ manifest }).ctx, '/api/reimport', { path: target, recursive: true });
      expect(r.body.reason, target).not.toBe('engine-asset-root');
      // The built-in was KEPT as a target: the route reached it (this scratch has no font pipeline to run it).
      expect(JSON.stringify(r.body), target).toContain('/modoki/assets/fonts/Inter.ttf');
    }
  });

  it('a packaged recursive reimport AT the engine root is the coded refusal, not "no manifest asset matches"', async () => {
    vi.stubEnv('MODOKI_PACKAGED', '1');
    const manifest = { version: 2, assets: [{ path: '/modoki/assets/fonts/Inter.ttf', type: 'font', guid: 'inter-guid' }] } as unknown as Manifest;
    expectEngineRefusal(await post(setup({ manifest }).ctx, '/api/reimport', { path: '/modoki/assets', recursive: true }));
    expectEngineRefusal(await post(setup({ manifest }).ctx, '/api/reimport', { path: '/modoki/assets/fonts/', recursive: true }));
    // Above the root: every match a built-in, so it is the coded refusal too, not "check the path/casing".
    expectEngineRefusal(await post(setup({ manifest }).ctx, '/api/reimport', { path: '/modoki', recursive: true }));
    // …but `/` is not inside the engine root: a project with no assets of its own keeps the 404 (close-out review 3).
    expect((await post(setup({ manifest }).ctx, '/api/reimport', { path: '/', recursive: true })).status).toBe(404);
  });

  it('a recursive reimport in the packaged editor leaves the built-ins out and keeps the project\'s assets', async () => {
    vi.stubEnv('MODOKI_PACKAGED', '1');
    const manifest = { version: 2, assets: [
      { path: '/modoki/assets/fonts/Inter.ttf', type: 'font', guid: 'inter-guid' },
      { path: '/assets/hero.png', type: 'texture', guid: 'hero-guid' },
    ] } as unknown as Manifest;
    const r = await post(setup({ manifest }).ctx, '/api/reimport', { path: '/', recursive: true });
    expect(r.body.reason).not.toBe('engine-asset-root');
    expect(JSON.stringify(r.body)).not.toContain('Inter.ttf');
    expect(JSON.stringify(r.body)).toContain('/assets/hero.png');
  });
});
