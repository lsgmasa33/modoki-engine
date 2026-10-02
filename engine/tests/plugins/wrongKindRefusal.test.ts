/** #1472 — never cross kinds, on EVERY route that writes a caller-named JSON asset.
 *
 *  #1264 wrote the refusal inline in `/api/scene-save-as`; the other routes that write a path the
 *  caller names decided the document's kind from the CALLER (the route for scene-mutate, the body's
 *  `type` for asset-write and create-asset) and never asked what the FILE is. Observed before the
 *  fix: a `setTrait` posted to `/api/scene-mutate` at a `.prefab.json` answered `saved:true` and
 *  rewrote the prefab through the scene path. They now share `wrongKindRefusal`.
 *
 *  One refusal per route, each asserting the file is byte-identical (or, for a create, absent), and
 *  an accept side for each — a guard tested only on the reject side is how the next author "fixes" a
 *  spurious refusal by deleting it. `/api/scene-save-as`'s cases live in sceneSaveAsRoute.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, toFsUrl, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { defaultAssetData } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { resolveAssetPath } from '../../plugins/vite-asset-scanner';

let projectRoot = '';
let manifest: Manifest;

function makeCtx(): BackendContext {
  return {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => resolveAssetPath(p, [{ urlPrefix: '', absDir: projectRoot }]),
    // `onDisk` answers with the spelling the DISK has, as the real one does (#1273) — what makes the
    // case-variant cases below mean anything on a case-insensitive filesystem.
    absToAssetUrl: (p: string, opts?: { onDisk?: boolean }) => {
      const onDisk = !!opts?.onDisk && fs.existsSync(p);
      const [root, abs] = onDisk ? [fs.realpathSync.native(projectRoot), fs.realpathSync.native(p)] : [projectRoot, p];
      const rel = path.relative(root, abs);
      return rel === '' ? null : '/' + rel.split(path.sep).join('/');   // the root has no url, as in production
    },
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    // No renderer at all — the headless path, where the file-direct write is the ONLY write and
    // nothing but the route's own preconditions stands in front of it.
    requestBrowser: async () => { throw new Error('no editor renderer connected'); },
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

type Reply = { status?: number; body: { ok?: boolean; saved?: boolean; wrongKind?: boolean; existingType?: string; nameType?: string } };
const post = (urlPath: string, body: unknown) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath, query: new URLSearchParams(), body }) as Promise<Reply>;

const ENTITY = '44444444-4444-4444-8444-444444444444';
const doc = (id: string) => ({ id, entities: [{ name: 'Root', traits: { EntityAttributes: { guid: ENTITY }, Transform: { x: 0 } } }] });

/** Put a JSON file on disk, optionally registered in the manifest as `type`; returns its bytes. */
function place(rel: string, content: object, type?: string): string {
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = JSON.stringify(content, null, 2);
  fs.writeFileSync(abs, bytes);
  if (type) manifest.assets.push({ guid: (content as { id: string }).id, path: '/' + rel, type } as Manifest['assets'][number]);
  return bytes;
}
const read = (rel: string) => fs.readFileSync(path.join(projectRoot, rel), 'utf-8');
const moveX = { op: 'setTrait', entity: { guid: ENTITY }, trait: 'Transform', fields: { x: 5 } };

/** APFS/NTFS fold case by default; ext4 does not, and there a case variant is simply another file. */
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

beforeEach(() => {
  projectRoot = makeScratchDir('modoki-wrong-kind-');
  manifest = { version: 2, assets: [] } as Manifest;
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/scene-mutate', () => {
  it('refuses a file the manifest types as a prefab, and leaves it byte-identical', async () => {
    const before = place('prefabs/enemy.prefab.json', doc('55555555-5555-4555-8555-555555555555'), 'prefab');
    const res = await post('/api/scene-mutate', { path: '/prefabs/enemy.prefab.json', ops: [moveX] });
    expect(res.status).toBe(409);
    expect(res.body.wrongKind).toBe(true);
    expect(res.body.existingType).toBe('prefab');
    expect(read('prefabs/enemy.prefab.json')).toBe(before);
  });

  it('refuses a prefab the manifest does NOT list, by its suffix', async () => {
    const before = place('prefabs/fresh.prefab.json', doc('66666666-6666-4666-8666-666666666666'));
    const res = await post('/api/scene-mutate', { path: '/prefabs/fresh.prefab.json', ops: [moveX] });
    expect(res.status).toBe(409);
    expect(res.body.existingType).toBe('prefab');
    expect(read('prefabs/fresh.prefab.json')).toBe(before);
  });

  it('refuses a LEGACY-folder material the manifest does not list yet — the scanner\'s folder rule, not just suffixes', async () => {
    // A plain `.json` under `/materials/` is typed `material` by the scan (issue #54). A suffix-only
    // check read it as "unknown" and wrote scene ops into it (close-out review).
    const before = place('materials/old.json', { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', entities: [] });
    const res = await post('/api/scene-mutate', { path: '/materials/old.json', ops: [moveX] });
    expect(res.status).toBe(409);
    expect(res.body.existingType).toBe('material');
    expect(read('materials/old.json')).toBe(before);
  });

  it.skipIf(!caseInsensitive)('an unindexed prefab reached through a CASE VARIANT is judged by the disk\'s spelling', async () => {
    const before = place('prefabs/fresh.prefab.json', doc('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    const res = await post('/api/scene-mutate', { path: '/prefabs/Fresh.Prefab.json', ops: [moveX] });
    expect(res.status).toBe(409);
    expect(res.body.existingType).toBe('prefab');
    expect(read('prefabs/fresh.prefab.json')).toBe(before);
  });

  it('still writes a real scene (the accept side)', async () => {
    place('scenes/main.scene.json', { ...doc('77777777-7777-4777-8777-777777777777'), version: SCENE_FORMAT_VERSION }, 'scene');
    const res = await post('/api/scene-mutate', { path: '/scenes/main.scene.json', ops: [moveX] });
    expect(res.body.ok).toBe(true);
    expect(res.body.saved).toBe(true);
    expect(JSON.parse(read('scenes/main.scene.json')).entities[0].traits.Transform.x).toBe(5);
  });

  it('still writes a LEGACY scene — a plain .json the manifest types scene', async () => {
    place('scenes/old.json', { ...doc('88888888-8888-4888-8888-888888888888'), version: SCENE_FORMAT_VERSION }, 'scene');
    const res = await post('/api/scene-mutate', { path: '/scenes/old.json', ops: [moveX] });
    expect(res.body.ok).toBe(true);
    expect(JSON.parse(read('scenes/old.json')).entities[0].traits.Transform.x).toBe(5);
  });
});

describe('/api/asset-write', () => {
  const material = (id: string) => ({ ...(defaultAssetData('material') as object), id });

  it('refuses type:material over a prefab, and leaves the prefab byte-identical', async () => {
    const before = place('prefabs/enemy.prefab.json', doc('55555555-5555-4555-8555-555555555555'), 'prefab');
    const res = await post('/api/asset-write', { path: '/prefabs/enemy.prefab.json', type: 'material', data: material('55555555-5555-4555-8555-555555555555') });
    expect(res.status).toBe(409);
    expect(res.body.wrongKind).toBe(true);
    expect(res.body.existingType).toBe('prefab');
    expect(read('prefabs/enemy.prefab.json')).toBe(before);
  });

  it('still writes a material over a material (the accept side)', async () => {
    const id = '99999999-9999-4999-8999-999999999999';
    place('materials/red.mat.json', material(id), 'material');
    const res = await post('/api/asset-write', { path: '/materials/red.mat.json', type: 'material', data: { ...material(id), roughness: 0.25 } });
    expect(res.body.ok).toBe(true);
    expect(JSON.parse(read('materials/red.mat.json')).roughness).toBe(0.25);
  });
});

describe('/api/create-asset', () => {
  it('refuses a name the manifest would type as another kind, and creates nothing', async () => {
    const res = await post('/api/create-asset', { type: 'material', path: '/scenes/oops.scene.json' });
    expect(res.status).toBe(409);
    expect(res.body.wrongKind).toBe(true);
    expect(res.body.nameType).toBe('scene');
    expect(fs.existsSync(path.join(projectRoot, 'scenes/oops.scene.json'))).toBe(false);
  });

  it('refuses a plain .json under the LEGACY /scenes/ folder — the scan would type it scene', async () => {
    fs.mkdirSync(path.join(projectRoot, 'scenes'));
    const res = await post('/api/create-asset', { type: 'particle', path: '/scenes/burst.json' });
    expect(res.status).toBe(409);
    expect(res.body.nameType).toBe('scene');
    expect(fs.existsSync(path.join(projectRoot, 'scenes/burst.json'))).toBe(false);
  });

  it.skipIf(!caseInsensitive)('a NEW file under a case variant of an on-disk legacy folder is typed by the disk\'s folder', async () => {
    // `/Scenes/` lands in the existing `scenes/`, and the scan reads `scenes` (second close-out review).
    fs.mkdirSync(path.join(projectRoot, 'scenes'));
    const res = await post('/api/create-asset', { type: 'particle', path: '/Scenes/burst.json' });
    expect(res.status).toBe(409);
    expect(res.body.nameType).toBe('scene');
    expect(fs.readdirSync(path.join(projectRoot, 'scenes'))).toEqual([]);
  });

  // Both of these used to be ACCEPTED, as "not a scene, so not refused". Neither is a particle either: the scan lists
  // neither file, so the create answered ok with a GUID that resolved to nothing (#1981). They still must NOT read as a
  // scene — `nameType:null`, not `'scene'` — which is what each case was written to pin.
  it.skipIf(!caseInsensitive)('…and the mirror: a lowercase /scenes/ over an on-disk Scenes/ is NOT a legacy scene folder', async () => {
    fs.mkdirSync(path.join(projectRoot, 'Scenes'));
    const res = await post('/api/create-asset', { type: 'particle', path: '/scenes/burst.json' });
    expect(res.status).toBe(409);
    expect(res.body.nameType).toBeNull();
  });

  it('a sidecar name is not read as a scene — and, being no particle either, is refused as nameless (#1981)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'scenes'));
    const res = await post('/api/create-asset', { type: 'particle', path: '/scenes/hero.png.meta.json' });
    expect(res.status).toBe(409);
    expect(res.body.nameType).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, 'scenes/hero.png.meta.json'))).toBe(false);
  });

  it('creates at a matching suffix (the accept side)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'materials'));
    const res = await post('/api/create-asset', { type: 'material', path: '/materials/blue.mat.json' });
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'materials/blue.mat.json'))).toBe(true);
  });

  // #1981: this case used to pin the opposite ("an unknown kind is not a wrong one"), and the asset it created was one the
  // scan never lists — `ok:true` with a GUID nothing could resolve. A NEW name must claim the kind; the refusal names it.
  for (const [name, corrected] of [['blue.json', 'blue.mat.json'], ['blue.material.json', 'blue.mat.json'], ['blue.particle.json', 'blue.mat.json']] as const) {
    it(`refuses a NEW ${name} for a material, names the suffix, and creates nothing (#1981)`, async () => {
      fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
      const res = await post('/api/create-asset', { type: 'material', path: `/data/${name}` }) as Reply & { body: { expectedSuffix?: string; options?: string[] } };
      if (name === 'blue.particle.json') {
        // A name ANOTHER kind claims keeps its own refusal (#1472) — this one is the cross-kind case, not #1981's.
        expect(res.body.nameType).toBe('particle');
        return;
      }
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ wrongKind: true, nameType: null, expectedSuffix: '.mat.json' });
      expect(res.body.options).toEqual([`use /data/${corrected}`]);
      expect(fs.existsSync(path.join(projectRoot, `data/${name}`))).toBe(false);
    });
  }

  it('asset-write to a NEW nameless path is refused the same way (#1981 — the route shares the check)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
    const res = await post('/api/asset-write', { path: '/data/new.json', type: 'material', data: { ...(defaultAssetData('material') as object), id: '12121212-1212-4121-8121-121212121212' } });
    expect(res.status).toBe(409);
    expect(res.body.nameType).toBeNull();
    expect(fs.existsSync(path.join(projectRoot, 'data/new.json'))).toBe(false);
  });

  it('asset-write to an EXISTING nameless file is still not refused — an unknown kind is not a wrong one (accept side)', async () => {
    const id = '13131313-1313-4131-8131-131313131313';
    place('data/old.json', { ...(defaultAssetData('material') as object), id });
    const res = await post('/api/asset-write', { path: '/data/old.json', type: 'material', data: { ...(defaultAssetData('material') as object), id, roughness: 0.5 } });
    expect(res.body.wrongKind).toBeUndefined();
  });
});

// ── #1960: move and duplicate never retype an asset through the destination's name ──────────────────────────────────
describe('/api/move-file and /api/duplicate-asset (#1960)', () => {
  type Retype = { status?: number; body: { ok?: boolean; wrongKind?: boolean; retyped?: Array<{ from: string; to: string; type: string; newType: string | null }> } };
  const move = (from: string, to: string) => post('/api/move-file', { from, to }) as unknown as Promise<Retype>;
  const dup = (from: string, to: string) => post('/api/duplicate-asset', { from, to }) as unknown as Promise<Retype>;
  const exists = (rel: string) => fs.existsSync(path.join(projectRoot, rel));
  const MAT = '99999999-9999-4999-8999-999999999999';

  it('move refuses a material renamed to .prefab.json, and changes nothing', async () => {
    const before = place('mats/m.mat.json', { id: MAT }, 'material');
    const res = await move('/mats/m.mat.json', '/mats/m.prefab.json');
    expect(res.status).toBe(409);
    expect(res.body.wrongKind).toBe(true);
    expect(res.body.retyped).toEqual([{ from: '/mats/m.mat.json', to: '/mats/m.prefab.json', type: 'material', newType: 'prefab' }]);
    expect(read('mats/m.mat.json')).toBe(before);
    expect(exists('mats/m.prefab.json')).toBe(false);
  });

  it('duplicate refuses a material copied to .scene.json, and writes no copy', async () => {
    place('mats/m.mat.json', { id: MAT }, 'material');
    const res = await dup('/mats/m.mat.json', '/c.scene.json');
    expect(res.status).toBe(409);
    expect(res.body.retyped?.[0]).toMatchObject({ type: 'material', newType: 'scene' });
    expect(exists('c.scene.json')).toBe(false);
  });

  it('refuses a binary renamed into another kind (texture → audio)', async () => {
    fs.writeFileSync(path.join(projectRoot, 'a.png'), 'png');
    expect((await move('/a.png', '/a.wav')).body.retyped?.[0]).toMatchObject({ type: 'texture', newType: 'audio' });
    expect(exists('a.png')).toBe(true);
  });

  it('a FOLDER move is judged per file — legacy scenes/ renamed to materials/ turns its plain .json scenes into materials', async () => {
    place('scenes/old.json', { id: MAT }, 'scene');
    const res = await move('/scenes', '/materials');
    expect(res.status).toBe(409);
    expect(res.body.retyped).toEqual([{ from: '/scenes/old.json', to: '/materials/old.json', type: 'scene', newType: 'material' }]);
    expect(exists('scenes/old.json')).toBe(true);
  });

  it('judges at the COMMIT point — a file that lands in the moving folder during the probe is judged too', async () => {
    place('scenes/old/a.particle.json', { id: MAT }, 'particle');
    const ctx = {
      ...makeCtx(),
      requestBrowser: async (op: string, params: unknown) => {
        const registries = (params as { registries?: string[] } | undefined)?.registries ?? [];
        // Inside the held-editor probe: the move's last await before its commit point.
        if (op === 'resolve-unsaved') place('scenes/old/q.json', { id: '16161616-1616-4616-8616-161616161616' });
        return op === 'resolve-unsaved' ? { ok: true, holds: [], discarded: [], covers: registries } : { ok: true, notes: [] };
      },
    } as unknown as BackendContext;
    const res = await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/move-file', query: new URLSearchParams(), body: { from: '/scenes/old', to: '/materials/old' } }) as Retype;
    expect(res.status).toBe(409);
    expect(res.body.retyped).toEqual([{ from: '/scenes/old/q.json', to: '/materials/old/q.json', type: 'scene', newType: 'material' }]);
    expect(exists('scenes/old/a.particle.json')).toBe(true);
  });

  it('ACCEPT SIDE: same kind under a new name, a folder of suffix-typed files, a texture to .jpg', async () => {
    place('mats/m.mat.json', { id: MAT }, 'material');
    expect((await move('/mats/m.mat.json', '/mats/n.mat.json')).body.ok).toBe(true);
    expect((await dup('/mats/n.mat.json', '/mats/o.mat.json')).body.ok).toBe(true);
    place('fx/a.particle.json', { id: '12121212-1212-4212-8212-121212121212' }, 'particle');
    expect((await move('/fx', '/vfx')).body.ok).toBe(true);
    fs.writeFileSync(path.join(projectRoot, 'a.png'), 'png');
    expect((await move('/a.png', '/b.jpg')).body.ok).toBe(true);
    expect(exists('mats/n.mat.json') && exists('mats/o.mat.json') && exists('vfx/a.particle.json') && exists('b.jpg')).toBe(true);
  });

  it('ACCEPT SIDE: no one-way door — a kind GAINED and the same kind LOST are both allowed, so every move can be undone', async () => {
    place('data/levels.json', { id: '13131313-1313-4313-8313-131313131313' });
    expect((await move('/data/levels.json', '/scenes/levels.json')).body.ok).toBe(true);   // gains 'scene' (legacy folder)
    expect((await move('/scenes/levels.json', '/data/levels.json')).body.ok).toBe(true);   // and loses it again
    place('fx/s.particle.json', { id: MAT }, 'particle');
    expect((await move('/fx/s.particle.json', '/fx/s.json')).body.ok).toBe(true);
    expect((await move('/fx/s.json', '/fx/s.particle.json')).body.ok).toBe(true);
    // A copy of a legacy scene pasted into another folder keeps its name and loses the folder-given kind.
    place('scenes/x.json', { id: '17171717-1717-4717-8717-171717171717' }, 'scene');
    expect((await dup('/scenes/x.json', '/data/x.json')).body.ok).toBe(true);
  });

  it.runIf(caseInsensitive)('ACCEPT SIDE: a case-only rename', async () => {
    place('mats/m.mat.json', { id: MAT }, 'material');
    expect((await move('/mats/m.mat.json', '/mats/M.mat.json')).body.ok).toBe(true);
  });
});

// ── #1980: scene-save-as replaces only a scene, and an in-project /@fs/ path reaches files outside the asset roots ──
describe('/api/scene-save-as over a file no kind names (#1980)', () => {
  /** The production shape: the asset root is `<project>/assets`, so `game.ts` beside it is in the project but has no url. */
  function rootedCtx(): BackendContext {
    const assets = path.join(projectRoot, 'assets');
    return {
      ...makeCtx(),
      resolveAssetPath: (p: string) => resolveAssetPath(p, [{ urlPrefix: '/assets', absDir: assets }]),
      absToAssetUrl: (p: string) => {
        const rel = path.relative(assets, p);
        return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : '/assets/' + rel.split(path.sep).join('/');
      },
    } as unknown as BackendContext;
  }
  type SaveAs = { status?: number; body: { ok?: boolean; wrongKind?: boolean; existingType?: string | null; error?: string; options?: string[] } };
  const saveAs = (p: string) => handleBackendRequest(rootedCtx(), {
    method: 'POST', urlPath: '/api/scene-save-as', query: new URLSearchParams(),
    body: { path: p, content: JSON.stringify({ ...doc('14141414-1414-4414-8414-141414141414'), version: SCENE_FORMAT_VERSION }) },
  }) as Promise<SaveAs>;
  // `toFsUrl`, never `'/@fs' + abs` — that is `/@fsC:/…` on Windows, which the route reads as an asset url (fsUrl.test.ts).
  const fsUrl = (rel: string) => toFsUrl(path.join(projectRoot, rel));

  it('refuses game.ts named by an in-project /@fs/ path, and leaves it byte-identical', async () => {
    fs.writeFileSync(path.join(projectRoot, 'game.ts'), 'export const game = {};\n');
    const res = await saveAs(fsUrl('game.ts'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ wrongKind: true, existingType: null });
    expect(read('game.ts')).toBe('export const game = {};\n');
  });

  it('refuses a plain data .json inside the asset root too — save-as replaces only a scene', async () => {
    const before = place('assets/data/levels.json', { levels: [1, 2] });
    const res = await saveAs('/assets/data/levels.json');
    expect(res.status).toBe(409);
    expect(read('assets/data/levels.json')).toBe(before);
  });

  it('a path outside the project is refused with advice that does not call /@fs/ unaccepted', async () => {
    const res = await saveAs(toFsUrl(path.join(path.dirname(projectRoot), 'elsewhere.scene.json')));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('/@fs/ path must be inside the project');
    expect(JSON.stringify(res.body.options)).not.toContain('not accepted');
  });

  it('ACCEPT SIDE: overwrites an existing scene through /@fs/, and creates a new .scene.json', async () => {
    place('assets/scenes/a.scene.json', { ...doc('15151515-1515-4515-8515-151515151515'), version: SCENE_FORMAT_VERSION }, 'scene');
    expect((await saveAs(fsUrl('assets/scenes/a.scene.json'))).body.ok).toBe(true);
    expect((await saveAs('/assets/scenes/b.scene.json')).body.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'assets/scenes/b.scene.json'))).toBe(true);
  });
});
