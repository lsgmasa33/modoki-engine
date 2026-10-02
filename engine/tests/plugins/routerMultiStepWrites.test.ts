/** #1958 family — a router write with several steps must leave the disk as its reply says.
 *
 *  Each member broke that a different way. A step failing part way stranded data: project-settings (#1958 ①),
 *  moveAssetFile (#1958 ②) and the win32 trash (#1977). A step that ran after the write landed turned a success into a
 *  500 (#1963). A decision taken before an await was never asked again (#2045). And a cleanup step removed what the
 *  caller had just written (#1992). One describe per member, against the real router and a real scratch disk, each
 *  with its accept side. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { moveAssetFile, trashCommand, trashGroups } from '../../plugins/asset-fs-ops';
import { registerReimportHandler } from '../../plugins/reimport-registry';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { resolveAssetPath } from '../../plugins/vite-asset-scanner';

const cleanup: string[] = [];
afterEach(() => {
  for (const r of cleanup.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});
const scratch = (tag: string) => { const d = makeScratchDir(`modoki-multistep-${tag}-`); cleanup.push(d); return d; };

type Reply = { status?: number; body: Record<string, unknown> };
const clearUnsaved = (params: unknown) => ({
  ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] } | undefined)?.registries ?? [],
});

/** A context over a real scratch project. `during` runs inside every renderer call, so it lands inside whichever
 *  await a route makes, which is after any check the route made before awaiting. */
function makeCtx(root: string, opts: {
  manifest?: Manifest; rebuild?: () => Manifest; during?: () => void; noRenderer?: boolean;
  requestBrowser?: (op: string, params: unknown) => Promise<unknown>;
} = {}): BackendContext {
  const manifest = opts.manifest ?? ({ version: 2, assets: [] } as unknown as Manifest);
  return {
    projectRoot: root,
    editorRoot: root,
    resolveAssetPath: (p: string) => resolveAssetPath(p, [{ urlPrefix: '', absDir: root }]),
    absToAssetUrl: (p: string) => { const rel = path.relative(root, p); return rel === '' ? null : '/' + rel.split(path.sep).join('/'); },
    firstRootDir: () => root,
    getManifest: () => manifest,
    rebuildManifest: opts.rebuild ?? (() => manifest),
    requestBrowser: opts.requestBrowser ?? (async (op: string, params: unknown) => {
      opts.during?.();
      if (opts.noRenderer) throw new Error('no editor renderer connected');
      return op === 'resolve-unsaved' ? clearUnsaved(params) : { ok: true, notes: [] };
    }),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}
const post = (ctx: BackendContext, urlPath: string, body: unknown) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body }) as Promise<Reply>;
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, Record<string, unknown>>;

describe('#1958 ① /api/project-settings writes the user file before blanking the committed value', () => {
  const setup = () => {
    const root = scratch('settings');
    // A pre-migration project: the private Team ID still sits in the COMMITTED file.
    fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ app: { appId: 'com.x.y' }, build: { appleTeamId: 'LEGACY9999' } }));
    fs.writeFileSync(path.join(root, 'project.user.json'), JSON.stringify({}));
    return root;
  };
  const apply = (root: string) => post(makeCtx(root), '/api/project-settings', { build: { appleTeamId: 'EDITED1234' } });

  // A write fails by its tmp path being a folder (EISDIR): the writes are tmp + rename, so a read-only FILE no longer
  // stops them, and a failure inside the tmp write is the full-disk shape the atomic write exists for.
  const failWritesTo = (root: string, name: string) => fs.mkdirSync(path.join(root, `${name}.tmp`));

  it('an unwritable user file costs nothing: the committed Team ID is still there', async () => {
    const root = setup();
    failWritesTo(root, 'project.user.json');
    const r = await apply(root);
    expect(r.status).toBe(500);
    expect(readJson(path.join(root, 'project.config.json')).build.appleTeamId).toBe('LEGACY9999');
  });

  it('an unwritable committed file leaves the new value in the user file, and the 500 says which file landed', async () => {
    const root = setup();
    failWritesTo(root, 'project.config.json');
    const r = await apply(root);
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ written: ['project.user.json'], notWritten: ['project.config.json'] });
    expect(readJson(path.join(root, 'project.user.json')).build.appleTeamId).toBe('EDITED1234');
    expect(readJson(path.join(root, 'project.config.json')).build.appleTeamId).toBe('LEGACY9999');
  });

  it('a write that fails part way leaves the previous file whole (tmp + rename, close-out review)', async () => {
    const root = setup();
    const before = fs.readFileSync(path.join(root, 'project.user.json'), 'utf-8');
    failWritesTo(root, 'project.user.json');
    await apply(root);
    expect(fs.readFileSync(path.join(root, 'project.user.json'), 'utf-8')).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('the atomic write keeps the file\'s mode and writes through a symlink (close-out review)', async () => {
    const root = setup();
    const user = path.join(root, 'project.user.json');
    fs.chmodSync(user, 0o600);   // it holds the keystore passwords
    expect((await apply(root)).body.ok).toBe(true);
    expect(fs.statSync(user).mode & 0o777).toBe(0o600);
    // A linked user file: the link stays a link, and its TARGET gets the write.
    const real = path.join(scratch('settings-link'), 'real.user.json');
    fs.renameSync(user, real);
    fs.symlinkSync(real, user);
    await post(makeCtx(root), '/api/project-settings', { build: { appleTeamId: 'LINKED1234' } });
    expect(fs.lstatSync(user).isSymbolicLink()).toBe(true);
    expect(readJson(real).build.appleTeamId).toBe('LINKED1234');
    // A DANGLING link is written through too: its target is created, and the link stays.
    fs.rmSync(real);
    await post(makeCtx(root), '/api/project-settings', { build: { appleTeamId: 'DANGLE1234' } });
    expect(fs.lstatSync(user).isSymbolicLink()).toBe(true);
    expect(readJson(real).build.appleTeamId).toBe('DANGLE1234');
  });

  it('ACCEPT SIDE: both writable → the value moves to the user file and the committed one is cleared', async () => {
    const root = setup();
    const r = await apply(root);
    expect(r.status ?? 200).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(readJson(path.join(root, 'project.user.json')).build.appleTeamId).toBe('EDITED1234');
    expect(readJson(path.join(root, 'project.config.json')).build?.appleTeamId ?? '').toBe('');
  });
});

describe('#1958 ② moveAssetFile is all or nothing over the asset and its sidecars', () => {
  it('a sidecar rename that throws puts the asset and the sidecars already moved back', () => {
    const root = scratch('move');
    const at = (p: string) => path.join(root, p);
    fs.writeFileSync(at('x.png'), 'png');
    fs.writeFileSync(at('x.png.meta.json'), '{"id":"g"}');
    fs.writeFileSync(at('x.png.meta.local.json'), '{}');
    // The SECOND sidecar's destination is a non-empty folder, so its rename fails after the first one moved.
    fs.mkdirSync(at('y.png.meta.local.json'));
    fs.writeFileSync(at('y.png.meta.local.json/keep'), '');
    expect(() => moveAssetFile(at('x.png'), at('y.png'))).toThrow();
    expect(fs.readFileSync(at('x.png'), 'utf-8')).toBe('png');
    expect(fs.readFileSync(at('x.png.meta.json'), 'utf-8')).toBe('{"id":"g"}');
    expect(fs.existsSync(at('x.png.meta.local.json'))).toBe(true);
    expect(fs.existsSync(at('y.png'))).toBe(false);
    expect(fs.existsSync(at('y.png.meta.json'))).toBe(false);
  });

  it('ACCEPT SIDE: nothing in the way → the asset and every sidecar move', () => {
    const root = scratch('move-ok');
    const at = (p: string) => path.join(root, p);
    fs.writeFileSync(at('x.png'), 'png');
    fs.writeFileSync(at('x.png.meta.json'), '{"id":"g"}');
    moveAssetFile(at('x.png'), at('sub/y.png'));
    expect(fs.existsSync(at('sub/y.png'))).toBe(true);
    expect(fs.readFileSync(at('sub/y.png.meta.json'), 'utf-8')).toBe('{"id":"g"}');
    expect(fs.existsSync(at('x.png.meta.json'))).toBe(false);
  });
});

describe('#1977 the win32 trash never splits a file from its sidecars', () => {
  it('orders every file before its sidecars, and names the file each sidecar waits on', () => {
    const groups = trashGroups(['C:\\p\\x.png.meta.json', 'C:\\p\\x.png', 'C:\\p\\orphan.png.meta.json', 'C:\\p\\x.png.meta.local.json']);
    expect(groups).toEqual([
      { path: 'C:\\p\\x.png' },
      // Its file is not in the batch (the route sends an orphan's sidecar alone): nothing to wait on.
      { path: 'C:\\p\\orphan.png.meta.json' },
      { path: 'C:\\p\\x.png.meta.json', base: 'C:\\p\\x.png' },
      { path: 'C:\\p\\x.png.meta.local.json', base: 'C:\\p\\x.png' },
    ]);
  });

  it('the script reads those groups: a sidecar line carries its file after a tab', () => {
    const { input } = trashCommand(['C:\\p\\x.png.meta.json', 'C:\\p\\x.png'], 'win32');
    expect(input).toBe('C:\\p\\x.png\nC:\\p\\x.png.meta.json\tC:\\p\\x.png\n');
  });

  it('refuses to build a line protocol a tab in a path would corrupt', () => {
    expect(() => trashCommand(['C:\\p\\a\tb.png'], 'win32')).toThrow(/newline or tab/);
  });
});

describe('#1963 a rebuild that fails AFTER the write landed is manifestRebuilt:false, not a 500', () => {
  const throwing = () => { throw new Error('EMFILE: too many open files'); };

  it('/api/create-asset: 200 with the file on disk', async () => {
    const root = scratch('create');
    const r = await post(makeCtx(root, { rebuild: throwing }), '/api/create-asset', { type: 'material', path: '/m/new.mat.json' });
    expect(r.status ?? 200).toBe(200);
    expect(r.body).toMatchObject({ ok: true, manifestRebuilt: false });
    expect(fs.existsSync(path.join(root, 'm/new.mat.json'))).toBe(true);
  });

  it('ACCEPT SIDE: /api/create-asset with a working rebuild says manifestRebuilt:true', async () => {
    const root = scratch('create-ok');
    const r = await post(makeCtx(root), '/api/create-asset', { type: 'material', path: '/m/new.mat.json' });
    expect(r.body).toMatchObject({ ok: true, manifestRebuilt: true });
  });

  it('/api/import-file: the copy-landed 422, never "registered no asset" or a 500', async () => {
    const root = scratch('import');
    const src = path.join(scratch('import-src'), 'pic.png');
    fs.writeFileSync(src, 'png');
    const r = await post(makeCtx(root, { rebuild: throwing }), '/api/import-file', { srcPath: src, destFolder: '/tex' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ ok: false, manifestRebuilt: false, path: '/tex/pic.png' });
    expect(String(r.body.error)).toMatch(/do not import it again/);
    expect(fs.existsSync(path.join(root, 'tex/pic.png'))).toBe(true);
  });

  it('/api/reimport: the bake still answers 200 and the renderer is still told to evict', async () => {
    const root = scratch('reimport');
    fs.mkdirSync(path.join(root, 'r'));
    fs.writeFileSync(path.join(root, 'r/a.fake1963'), 'x');
    registerReimportHandler('fake1963', async () => {});
    const manifest = { version: 2, assets: [{ guid: 'g', path: '/r/a.fake1963', type: 'fake1963' }] } as unknown as Manifest;
    const ops: string[] = [];
    const ctx = makeCtx(root, {
      manifest, rebuild: throwing,
      requestBrowser: async (op, params) => { ops.push(op); return op === 'resolve-unsaved' ? clearUnsaved(params) : { ok: true }; },
    });
    const r = await post(ctx, '/api/reimport', { path: '/r/a.fake1963' });
    expect(r.status ?? 200).toBe(200);
    expect(r.body).toMatchObject({ ok: true, converted: 1, manifestRebuilt: false });
    expect(ops).toContain('invalidate-assets');
  });
});

describe('#2045 the commit point: a decision taken before an await is asked again after it', () => {
  it('/api/reimport: a target renamed away during the unsaved probe is not baked', async () => {
    const root = scratch('reimport-moved');
    fs.mkdirSync(path.join(root, 'r'));
    fs.writeFileSync(path.join(root, 'r/a.fake2045'), 'x');
    const handler = vi.fn(async () => {});
    registerReimportHandler('fake2045', handler);
    const manifest = { version: 2, assets: [{ guid: 'g', path: '/r/a.fake2045', type: 'fake2045' }] } as unknown as Manifest;
    const ctx = makeCtx(root, { manifest, during: () => {
      if (fs.existsSync(path.join(root, 'r/a.fake2045'))) fs.renameSync(path.join(root, 'r/a.fake2045'), path.join(root, 'r/b.fake2045'));
    } });
    const r = await post(ctx, '/api/reimport', { path: '/r/a.fake2045' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: true, reason: 'changed', changed: ['/r/a.fake2045'], converted: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a mix of moved and too-new targets is one 409 that names both (close-out review)', async () => {
    const root = scratch('reimport-mixed');
    fs.mkdirSync(path.join(root, 'r'));
    fs.writeFileSync(path.join(root, 'r/a.fake2045d'), 'x');
    fs.writeFileSync(path.join(root, 'r/b.fake2045d'), 'x');
    fs.writeFileSync(path.join(root, 'r/b.fake2045d.meta.json'), JSON.stringify({ id: 'g2', version: 999 }));
    registerReimportHandler('fake2045d', async () => {});
    const manifest = { version: 2, assets: [
      { guid: 'g1', path: '/r/a.fake2045d', type: 'fake2045d' }, { guid: 'g2', path: '/r/b.fake2045d', type: 'fake2045d' },
    ] } as unknown as Manifest;
    const ctx = makeCtx(root, { manifest, during: () => {
      if (fs.existsSync(path.join(root, 'r/a.fake2045d'))) fs.renameSync(path.join(root, 'r/a.fake2045d'), path.join(root, 'r/z.fake2045d'));
    } });
    const r = await post(ctx, '/api/reimport', { path: '/r', recursive: true });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'changed', code: 'REFUSED_BY_OP', changed: ['/r/a.fake2045d'] });
    expect(String(r.body.error)).toContain('/r/b.fake2045d');
  });

  it('ACCEPT SIDE: the same asset re-saved atomically during the probe is still baked (close-out review)', async () => {
    const root = scratch('reimport-resaved');
    fs.mkdirSync(path.join(root, 'r'));
    const at = path.join(root, 'r/a.fake2045c');
    fs.writeFileSync(at, 'x');
    const handler = vi.fn(async () => {});
    registerReimportHandler('fake2045c', handler);
    const manifest = { version: 2, assets: [{ guid: 'g', path: '/r/a.fake2045c', type: 'fake2045c' }] } as unknown as Manifest;
    let saved = false;
    const ctx = makeCtx(root, { manifest, during: () => {
      if (saved) return;
      saved = true;
      fs.writeFileSync(`${at}.tmp`, 'newer bytes');
      fs.renameSync(`${at}.tmp`, at);   // another directory entry at the same path: what an atomic save leaves
    } });
    const r = await post(ctx, '/api/reimport', { path: '/r/a.fake2045c' });
    expect(r.body).toMatchObject({ ok: true, converted: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ACCEPT SIDE: /api/reimport with nothing moving bakes the target', async () => {
    const root = scratch('reimport-still');
    fs.mkdirSync(path.join(root, 'r'));
    fs.writeFileSync(path.join(root, 'r/a.fake2045b'), 'x');
    const handler = vi.fn(async () => {});
    registerReimportHandler('fake2045b', handler);
    const manifest = { version: 2, assets: [{ guid: 'g', path: '/r/a.fake2045b', type: 'fake2045b' }] } as unknown as Manifest;
    const r = await post(makeCtx(root, { manifest, during: () => {} }), '/api/reimport', { path: '/r/a.fake2045b' });
    expect(r.body).toMatchObject({ ok: true, converted: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  const SCENE = { id: '11111111-1111-4111-8111-111111111111', version: 1, entities: [] };
  it('/api/scene-mutate: a scene renamed away during the probe answers 404, not a 500, and writes nothing', async () => {
    const root = scratch('mutate-moved');
    fs.mkdirSync(path.join(root, 'scenes'));
    fs.writeFileSync(path.join(root, 'scenes/a.scene.json'), JSON.stringify(SCENE));
    const ctx = makeCtx(root, { noRenderer: true, during: () => {
      if (fs.existsSync(path.join(root, 'scenes/a.scene.json'))) fs.renameSync(path.join(root, 'scenes/a.scene.json'), path.join(root, 'scenes/b.scene.json'));
    } });
    const r = await post(ctx, '/api/scene-mutate', { path: '/scenes/a.scene.json', ops: [{ op: 'createEntity', name: 'N' }] });
    expect(r.status).toBe(404);
    expect(String(r.body.error)).toMatch(/moved or deleted while scene-mutate waited/);
    expect(fs.existsSync(path.join(root, 'scenes/a.scene.json'))).toBe(false);
  });
});

describe('#1992 a sidecar written ahead of its file is kept by that file\'s create', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const write = (ctx: BackendContext, p: string, content: string) =>
    post(ctx, '/api/write-file', { path: p, content: b64(content), encoding: 'base64', ifNoneMatch: '*' });
  const META = '{"id":"dropped-guid","sprite":{"slices":[{"id":"s1"}]}}';

  it('the OS drop with the .meta.json first: the png keeps the dropped GUID and slices', async () => {
    const root = scratch('drop');
    const ctx = makeCtx(root);
    expect((await write(ctx, '/x.png.meta.json', META)).body.ok).toBe(true);
    expect((await write(ctx, '/x.png', 'png')).body.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'x.png.meta.json'), 'utf-8')).toBe(META);
  });

  it.skipIf(process.platform === 'linux')('an upper-case sidecar written ahead is kept too, where the disk folds case (close-out review)', async () => {
    const root = scratch('upper');
    const ctx = makeCtx(root);
    await write(ctx, '/C.PNG.META.JSON', META);
    await write(ctx, '/C.PNG', 'png');
    expect(fs.readdirSync(root).sort()).toEqual(['C.PNG', 'C.PNG.META.JSON']);
  });

  it('ACCEPT SIDE: an orphan nothing here wrote (the file went in Finder) is still removed by the create', async () => {
    const root = scratch('orphan');
    fs.writeFileSync(path.join(root, 'x.png.meta.json'), '{"id":"dead-guid"}');
    expect((await write(makeCtx(root), '/x.png', 'png')).body.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'x.png.meta.json'))).toBe(false);
  });

  it('the record is used up by the create: the same file deleted later leaves an ordinary orphan', async () => {
    const root = scratch('used-up');
    const ctx = makeCtx(root);
    await write(ctx, '/x.png.meta.json', META);
    await write(ctx, '/x.png', 'png');
    fs.rmSync(path.join(root, 'x.png'));   // deleted outside the editor; its sidecar stays behind
    await write(ctx, '/x.png', 'another png');
    expect(fs.existsSync(path.join(root, 'x.png.meta.json'))).toBe(false);
  });

  it('a sidecar REPLACED since this backend wrote it is judged like any other', async () => {
    const root = scratch('replaced');
    const ctx = makeCtx(root);
    await write(ctx, '/x.png.meta.json', META);
    fs.rmSync(path.join(root, 'x.png.meta.json'));
    fs.writeFileSync(path.join(root, 'x.png.meta.json'), '{"id":"someone-else"}');
    await write(ctx, '/x.png', 'png');
    expect(fs.existsSync(path.join(root, 'x.png.meta.json'))).toBe(false);
  });

  it('a create that FAILS keeps the record: the drop\'s retry still keeps the dropped sidecar (close-out review)', async () => {
    const root = scratch('retry');
    const ctx = makeCtx(root);
    await write(ctx, '/x.png.meta.json', META);
    // The png's first create fails AT its commit, after the orphan removal ran (EPERM: a Windows scanner holding the tmp).
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
    try {
      expect((await write(ctx, '/x.png', 'png')).status).toBe(500);
      expect(rename).toHaveBeenCalledTimes(1);
    } finally { rename.mockRestore(); }
    expect((await write(ctx, '/x.png', 'png')).body.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'x.png.meta.json'), 'utf-8')).toBe(META);
  });

  it('an OVERWRITE of a dead orphan does not vouch for it — only a create records (close-out review)', async () => {
    const root = scratch('overwrite');
    const ctx = makeCtx(root);
    fs.writeFileSync(path.join(root, 'x.png.meta.json'), '{"id":"dead-guid"}');   // its png went in Finder
    await post(ctx, '/api/write-file', { path: '/x.png.meta.json', content: b64('{"id":"dead-guid","v":2}'), encoding: 'base64' });
    await write(ctx, '/x.png', 'png');
    expect(fs.existsSync(path.join(root, 'x.png.meta.json'))).toBe(false);
  });

  it('part 2: a write that fails before its commit removes no orphan', async () => {
    const root = scratch('tmp-fails');
    fs.writeFileSync(path.join(root, 'x.png.meta.json'), '{"id":"g"}');
    fs.mkdirSync(path.join(root, 'x.png.tmp'));   // the tmp write hits a folder: EISDIR
    const r = await write(makeCtx(root), '/x.png', 'png');
    expect(r.status).toBe(500);
    expect(fs.existsSync(path.join(root, 'x.png.meta.json'))).toBe(true);
  });
});
