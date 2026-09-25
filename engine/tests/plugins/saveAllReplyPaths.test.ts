/** `modoki_save_all`'s reply names every file in the asset-root form (#1562).
 *
 *  The renderer builds the reply from its own paths, and the open scene's is whatever spelling it was
 *  opened under — Vite's `/@fs/<abs>` for a boot candidate or an explicit `/@fs/` load. Observed on
 *  Court: a Save As answered `scenePath: "/assets/mcp-smoke/…"` beside
 *  `savedAsCopyOf: "/@fs/…/games/court/runtime/assets/scenes/main.scene.json"` — one reply, two
 *  address spaces, and the live smoke's #1414 case read that as "a copy of some other file". A plain
 *  save answered `scenePath: "/@fs/…"` too, which `modoki_mutate_scene {path}` refuses.
 *
 *  Driven through the REAL `/api/editor-action` route with a stand-in renderer, because the mapping
 *  lives in the relay: an op-level test would see the renderer's paths, which is the defect. */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

const PROJECT = path.join(os.tmpdir(), 'proj1562');
const ROOT = path.join(PROJECT, 'runtime');
const abs = (rel: string) => path.join(ROOT, 'assets', ...rel.split('/'));
const toFs = (p: string) => path.posix.join('/@fs/', p.replace(/\\/g, '/'));

/** A ctx whose asset root is `<PROJECT>/runtime` (so `/assets/…` URLs), answering every relayed op
 *  with `reply`. */
function makeCtx(reply: unknown): BackendContext {
  return {
    projectRoot: PROJECT,
    resolveAssetPath: (p: string) => (p.startsWith('/assets/') ? path.join(ROOT, p.slice(1)) : null),
    absToAssetUrl: (a: string) => {
      const rel = path.relative(ROOT, a);
      return rel && !rel.startsWith('..') ? '/' + rel.split(path.sep).join('/') : null;
    },
    firstRootDir: () => ROOT,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => reply,
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

async function act(action: string, reply: unknown) {
  const r = await handleBackendRequest(makeCtx(reply), {
    method: 'POST', urlPath: '/api/editor-action', query: new URLSearchParams(), body: { action },
  }) as { status?: number; body: Record<string, unknown> };
  return r;
}

describe('save_all reply paths (#1562)', () => {
  it('a Save As names the copy and its source in ONE address space', async () => {
    // The observed reply, with the renderer's `/@fs/` spelling of the open scene.
    const { status, body } = await act('save-all', {
      ok: true, scenePath: '/assets/mcp-smoke/save.scene.json',
      savedAsCopyOf: toFs(abs('scenes/main.scene.json')), freshSceneId: true,
    });
    expect(status).toBeUndefined();
    expect(body.scenePath).toBe('/assets/mcp-smoke/save.scene.json');
    // What the smoke compares against: the path the caller addresses the scene by.
    expect(body.savedAsCopyOf).toBe('/assets/scenes/main.scene.json');
    expect(body.freshSceneId).toBe(true);
    // `scenePathRef` means one thing on every reply of this route, save-all included (second review).
    expect(body.scenePathRef).toBe('/assets/mcp-smoke/save.scene.json');
  });

  it('a plain save answers scenePath in the form modoki_mutate_scene {path} accepts', async () => {
    const { body } = await act('save-all', { ok: true, scenePath: toFs(abs('scenes/main.scene.json')) });
    expect(body.scenePath).toBe('/assets/scenes/main.scene.json');
    expect(makeCtx(null).resolveAssetPath(body.scenePath as string)).toBe(abs('scenes/main.scene.json'));
  });

  it('maps the list fields too — every file the reply names, not only the primary', async () => {
    const { body } = await act('save-all', {
      ok: true, scenePath: '/assets/scenes/level.scene.json',
      extraSaved: [{ path: toFs(abs('scenes/base.scene.json')), guid: 'g1' }],
      savedBaseScenes: [toFs(abs('scenes/level.scene.json'))],
      savedAssets: ['/assets/fx/spark.particle.json'],
    });
    expect(body.extraSaved).toEqual([{ path: '/assets/scenes/base.scene.json', guid: 'g1' }]);
    expect(body.savedBaseScenes).toEqual(['/assets/scenes/level.scene.json']);
    expect(body.savedAssets).toEqual(['/assets/fx/spark.particle.json']);
  });

  it('maps by VALUE — a path field the mapper was never told about is mapped too (close-out review)', async () => {
    // A hand list named five of the op's six path fields; `savedImportSettings` was the one missed.
    const { body } = await act('save-all', {
      ok: true, scenePath: '/assets/scenes/main.scene.json',
      savedImportSettings: [toFs(abs('tex/a.png'))],
      aFieldAddedNextYear: toFs(abs('scenes/x.scene.json')),
      unsavedCauses: ['scene'], freshSceneId: true,
    });
    expect(body.savedImportSettings).toEqual(['/assets/tex/a.png']);
    expect(body.aFieldAddedNextYear).toBe('/assets/scenes/x.scene.json');
    // Non-path values pass untouched.
    expect(body.unsavedCauses).toEqual(['scene']);
    expect(body.freshSceneId).toBe(true);
  });

  it('keeps a path outside every asset root as the renderer spelled it, never drops it', async () => {
    const elsewhere = toFs(path.join(os.tmpdir(), 'elsewhere', 'x.scene.json'));
    const { body } = await act('save-all', { ok: true, scenePath: elsewhere });
    expect(body.scenePath).toBe(elsewhere);
  });

  it('passes a REFUSAL through untouched — its status and its prose', async () => {
    // The shape an `OpRefusal` thrown in the renderer arrives in.
    const refusal = {
      ok: false,
      error: `save-all: the scene WAS written … ${toFs(abs('scenes/main.scene.json'))} itself was not written.`,
      code: 'PARTIAL',
    };
    const { status, body } = await act('save-all', refusal);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body).toEqual(refusal);
  });

  it('every OTHER editor-action reply keeps scenePath and GAINS scenePathRef, as editor-state does', async () => {
    // Sibling found by the close-out sweep: ~17 ops spread `readEditorState()` into their reply, and
    // `load_scene` answered `scenePath: "/@fs/…"` with no ref — observed live on Court.
    const fsPath = toFs(abs('scenes/main.scene.json'));
    const { body } = await act('load-scene', { ok: true, scenePath: fsPath });
    expect(body.scenePath).toBe(fsPath);
    expect(body.scenePathRef).toBe('/assets/scenes/main.scene.json');
    // No scenePath → nothing added; a path outside every root → no ref rather than a wrong one.
    expect((await act('undo', { ok: true })).body).toEqual({ ok: true });
    // prefab edit-open's scene-to-return-to is the same renderer spelling, so it gets the same ref.
    const opened = (await act('prefab', { ok: true, scenePath: null, returnScene: fsPath })).body;
    expect(opened.returnScene).toBe(fsPath);
    expect(opened.returnSceneRef).toBe('/assets/scenes/main.scene.json');
    expect('scenePathRef' in opened).toBe(false);
    const out = toFs(path.join(os.tmpdir(), 'elsewhere', 'x.scene.json'));
    expect('scenePathRef' in (await act('play', { ok: true, scenePath: out })).body).toBe(false);
  });
});
