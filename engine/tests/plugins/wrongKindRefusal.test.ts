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
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { defaultAssetData } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
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
    place('scenes/main.scene.json', doc('77777777-7777-4777-8777-777777777777'), 'scene');
    const res = await post('/api/scene-mutate', { path: '/scenes/main.scene.json', ops: [moveX] });
    expect(res.body.ok).toBe(true);
    expect(res.body.saved).toBe(true);
    expect(JSON.parse(read('scenes/main.scene.json')).entities[0].traits.Transform.x).toBe(5);
  });

  it('still writes a LEGACY scene — a plain .json the manifest types scene', async () => {
    place('scenes/old.json', doc('88888888-8888-4888-8888-888888888888'), 'scene');
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

  it.skipIf(!caseInsensitive)('…and the mirror: a lowercase /scenes/ over an on-disk Scenes/ is NOT a legacy scene folder', async () => {
    fs.mkdirSync(path.join(projectRoot, 'Scenes'));
    const res = await post('/api/create-asset', { type: 'particle', path: '/scenes/burst.json' });
    expect(res.body.ok).toBe(true);
  });

  it('refuses nothing for a sidecar name — the scan never indexes a .meta.json', async () => {
    fs.mkdirSync(path.join(projectRoot, 'scenes'));
    const res = await post('/api/create-asset', { type: 'particle', path: '/scenes/hero.png.meta.json' });
    expect(res.body.wrongKind).toBeUndefined();
  });

  it('creates at a matching suffix (the accept side)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'materials'));
    const res = await post('/api/create-asset', { type: 'material', path: '/materials/blue.mat.json' });
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'materials/blue.mat.json'))).toBe(true);
  });

  it('does not refuse a name no kind claims — an unknown kind is not a wrong one', async () => {
    fs.mkdirSync(path.join(projectRoot, 'data'));
    const res = await post('/api/create-asset', { type: 'material', path: '/data/blue.json' });
    expect(res.body.ok).toBe(true);
  });
});
