/** `POST /api/scene-save-as` — the backend half of an agent Save As (#1414).
 *
 *  The editor sends the OPEN scene as serialized, so the body carries that scene's own id and
 *  entity guids. Written as-is, two files would claim one scene guid, and the dev scanner heals that
 *  by re-minting whichever file sorts second — which was the COMMITTED original in the smoke run that
 *  found this. So the route must write the copy under a fresh scene id with reminted entity guids,
 *  overwriting whatever scene is at the target (owner, 2026-09-18), and never cross kinds (#1264). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { resolveAssetPath } from '../../plugins/vite-asset-scanner';

let projectRoot = '';
let manifest: Manifest;

function makeCtx(): BackendContext {
  return {
    projectRoot,
    editorRoot: projectRoot,
    // The REAL resolver: it decodes `%20` and resolves `./`, which is what makes a second spelling of
    // one file possible at all.
    resolveAssetPath: (p: string) => resolveAssetPath(p, [{ urlPrefix: '', absDir: projectRoot }]),
    absToAssetUrl: (p: string) => '/' + path.relative(projectRoot, p).split(path.sep).join('/'),
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const post = (body: unknown) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/scene-save-as', query: new URLSearchParams(), body }) as Promise<{ status?: number; body: { ok?: boolean; guid?: string; path?: string; wrongKind?: boolean } }>;

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';

/** The open scene as the editor serializes it: its own id, a parent and a child that refers to it. */
const openScene = () => ({
  id: SOURCE_ID,
  entities: [
    { name: 'Parent', traits: { EntityAttributes: { guid: PARENT } } },
    { name: 'Child', parentId: PARENT, traits: { EntityAttributes: { guid: CHILD } } },
  ],
});

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(projectRoot, rel), 'utf-8'));

beforeEach(() => {
  projectRoot = makeScratchDir('modoki-scene-save-as-');
  manifest = { version: 2, assets: [] } as Manifest;
});
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/scene-save-as', () => {
  it('writes the copy under a FRESH scene id, and reports that id', async () => {
    const res = await post({ path: '/scenes/copy.scene.json', content: JSON.stringify(openScene()) });
    expect(res.body.ok).toBe(true);
    const copy = readJson('scenes/copy.scene.json');
    expect(copy.id).not.toBe(SOURCE_ID);
    expect(copy.id).toBe(res.body.guid);
    expect(res.body.path).toBe('/scenes/copy.scene.json');
  });

  it('re-mints the entity guids, and the child follows its parent', async () => {
    await post({ path: '/scenes/copy.scene.json', content: JSON.stringify(openScene()) });
    const [parent, child] = readJson('scenes/copy.scene.json').entities;
    const newParent = parent.traits.EntityAttributes.guid;
    expect(newParent).not.toBe(PARENT);
    expect(child.traits.EntityAttributes.guid).not.toBe(CHILD);
    expect(child.parentId).toBe(newParent);
  });

  it('OVERWRITES a scene already at the target, and does not keep its id', async () => {
    const oldTargetId = '44444444-4444-4444-8444-444444444444';
    fs.mkdirSync(path.join(projectRoot, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'scenes/other.scene.json'), JSON.stringify({ id: oldTargetId, entities: [] }));
    manifest.assets.push({ guid: oldTargetId, path: '/scenes/other.scene.json', type: 'scene' } as Manifest['assets'][number]);

    const res = await post({ path: '/scenes/other.scene.json', content: JSON.stringify(openScene()) });
    expect(res.body.ok).toBe(true);
    const written = readJson('scenes/other.scene.json');
    expect(written.entities).toHaveLength(2);
    expect(written.id).not.toBe(oldTargetId);
    expect(written.id).not.toBe(SOURCE_ID);
  });

  it('refuses a target the manifest types as another kind, and leaves it untouched', async () => {
    fs.mkdirSync(path.join(projectRoot, 'prefabs'), { recursive: true });
    const before = JSON.stringify({ id: '55555555-5555-4555-8555-555555555555', entities: [] });
    fs.writeFileSync(path.join(projectRoot, 'prefabs/enemy.json'), before);
    manifest.assets.push({ guid: '55555555-5555-4555-8555-555555555555', path: '/prefabs/enemy.json', type: 'prefab' } as Manifest['assets'][number]);

    const res = await post({ path: '/prefabs/enemy.json', content: JSON.stringify(openScene()) });
    expect(res.status).toBe(409);
    expect(res.body.wrongKind).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'prefabs/enemy.json'), 'utf-8')).toBe(before);
  });

  it('the open scene\'s OWN file under another spelling is refused as sameFile, and left byte-identical', async () => {
    fs.mkdirSync(path.join(projectRoot, 'scenes'), { recursive: true });
    const before = JSON.stringify(openScene());
    fs.writeFileSync(path.join(projectRoot, 'scenes/New Scene.scene.json'), before);
    for (const spelling of ['/scenes/New%20Scene.scene.json', '/scenes/./New Scene.scene.json']) {
      // `loadedPaths` holds the open scene too, as the client always sends it: sameFile must win.
      const res = await post({ path: spelling, content: before, openPath: '/scenes/New Scene.scene.json', loadedPaths: ['/scenes/New Scene.scene.json'] });
      expect(res.status, spelling).toBe(409);
      expect((res.body as { sameFile?: boolean }).sameFile, spelling).toBe(true);
    }
    expect(fs.readFileSync(path.join(projectRoot, 'scenes/New Scene.scene.json'), 'utf-8')).toBe(before);
  });

  it('a different existing file is NOT sameFile (the accept side)', async () => {
    fs.mkdirSync(path.join(projectRoot, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'scenes/open.scene.json'), JSON.stringify(openScene()));
    fs.writeFileSync(path.join(projectRoot, 'scenes/other.scene.json'), JSON.stringify({ id: '66666666-6666-4666-8666-666666666666', entities: [] }));
    const res = await post({ path: '/scenes/other.scene.json', content: JSON.stringify(openScene()), openPath: '/scenes/open.scene.json' });
    expect(res.body.ok).toBe(true);
  });

  it('a NEW file without the scene suffix is refused and not created', async () => {
    const res = await post({ path: '/scenes/copy.json', content: JSON.stringify(openScene()) });
    expect(res.status).toBe(409);
    expect(fs.existsSync(path.join(projectRoot, 'scenes/copy.json'))).toBe(false);
  });

  it('another LOADED scene under another spelling is refused as targetLoaded, and left byte-identical', async () => {
    fs.mkdirSync(path.join(projectRoot, 'scenes'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'scenes/open.scene.json'), JSON.stringify(openScene()));
    const base = JSON.stringify({ id: '77777777-7777-4777-8777-777777777777', entities: [] });
    fs.writeFileSync(path.join(projectRoot, 'scenes/base.scene.json'), base);
    const res = await post({
      path: '/scenes/./base.scene.json', content: JSON.stringify(openScene()),
      openPath: '/scenes/open.scene.json', loadedPaths: ['/scenes/open.scene.json', '/scenes/base.scene.json'],
    });
    expect(res.status).toBe(409);
    expect((res.body as { targetLoaded?: boolean }).targetLoaded).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'scenes/base.scene.json'), 'utf-8')).toBe(base);
  });
});
