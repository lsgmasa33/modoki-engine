/** `/api/editor-state` must answer the active scene in a form the EDIT routes accept.
 *
 *  The renderer reports `scenePath` as Vite's `/@fs/<abs>` URL — correct for the renderer, and
 *  rejected by `/api/scene-mutate`, whose `resolveAssetPath` only understands asset-root URLs and
 *  403s "path outside allowed directories" on anything else. So "edit the scene that is open" was
 *  a two-step dance every caller had to get right, and `modoki_set_transform` got it wrong: its
 *  documented `path` default 403'd on EVERY call, for as long as it existed, because every test of
 *  it passed an explicit `path`.
 *
 *  That is the gap these tests close — the default path, exercised. `scenePathRef` is additive:
 *  `scenePath` keeps its old value for the renderer-facing consumers. */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

const PROJECT = path.join(os.tmpdir(), 'proj');
const SCENE_ABS = path.join(PROJECT, 'runtime', 'assets', 'scenes', 'main.json');
const toFs = (abs: string) => path.posix.join('/@fs/', abs.replace(/\\/g, '/'));

/** A ctx whose asset root is `<PROJECT>/runtime`, mirroring a real project layout. */
function makeCtx(scenePath: string | undefined, over: Partial<BackendContext> = {}): BackendContext {
  const root = path.join(PROJECT, 'runtime');
  return {
    projectRoot: PROJECT,
    resolveAssetPath: (p: string) => (p.startsWith('/assets/') ? path.join(root, p.slice(1)) : null),
    absToAssetUrl: (abs: string) => {
      const rel = path.relative(root, abs);
      return rel && !rel.startsWith('..') ? '/' + rel.split(path.sep).join('/') : null;
    },
    firstRootDir: () => root,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => (scenePath === undefined ? {} : { scenePath, unsavedChanges: false }),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
    ...over,
  } as unknown as BackendContext;
}

const state = async (ctx: BackendContext) => {
  const r = await handleBackendRequest(ctx, {
    method: 'GET', urlPath: '/api/editor-state', query: new URLSearchParams(), body: undefined,
  });
  return (r as { body: Record<string, unknown> }).body;
};

describe('/api/editor-state scenePathRef', () => {
  it('converts the renderer /@fs URL into an asset-root path the edit routes accept', async () => {
    const body = await state(makeCtx(toFs(SCENE_ABS)));
    expect(body.scenePathRef).toBe('/assets/scenes/main.json');
    // The round trip is the actual contract: whatever we hand back must resolve.
    expect(makeCtx(undefined).resolveAssetPath(body.scenePathRef as string)).toBe(SCENE_ABS);
  });

  it('leaves `scenePath` untouched — the field is ADDITIVE', async () => {
    const fsUrl = toFs(SCENE_ABS);
    const body = await state(makeCtx(fsUrl));
    expect(body.scenePath).toBe(fsUrl);
  });

  it('passes through a path that is ALREADY asset-root', async () => {
    const body = await state(makeCtx('/assets/scenes/main.json'));
    expect(body.scenePathRef).toBe('/assets/scenes/main.json');
  });

  it('OMITS the field for a scene outside every asset root, rather than sending a 403-bait value', async () => {
    // An untitled/elsewhere scene is real; what would be wrong is handing back a path that
    // resolves to nothing, since a caller would then post it and get an opaque 403.
    const body = await state(makeCtx(toFs(path.join(os.tmpdir(), 'elsewhere', 'x.json'))));
    expect(body).not.toHaveProperty('scenePathRef');
  });

  it('omits the field when no editor is connected', async () => {
    const body = await state(makeCtx(undefined));
    expect(body).not.toHaveProperty('scenePathRef');
    expect(body.persistenceMode).toBeDefined(); // route still answers
  });

  it('survives an absToAssetUrl that returns null without breaking the route', async () => {
    const body = await state(makeCtx(toFs(SCENE_ABS), { absToAssetUrl: () => null }));
    expect(body).not.toHaveProperty('scenePathRef');
    expect(body.scenePath).toBeDefined();
  });
});
