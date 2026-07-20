/** Router-level tests for GET /api/unused-assets — the handler that surfaces the
 *  tree-shaker's orphans to the editor's "Clean Up Unused Assets" dialog. The
 *  reachability walk itself is covered by assetTreeShaker.test.ts; here we prove
 *  only the router's shaping: orphans sorted largest-first, totalBytes summed,
 *  scene count + warnings passed through, and a thrown shaker → 500. */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import type { TreeShakeResult } from '../../plugins/asset-tree-shaker';

const PROJECT_ROOT = path.join(os.tmpdir(), 'modoki-unused-router-test-project');

// resolveAssetPath mirrors the real host: the project's own roots (`/assets`,
// `/games/<id>/assets`) map UNDER projectRoot; the engine-shared `/modoki/assets`
// root maps to a sibling engine dir OUTSIDE projectRoot, so the handler's
// in-project filter drops it.
function defaultResolve(p: string): string | null {
  if (p.startsWith('/modoki/assets/')) return path.join(os.tmpdir(), 'modoki-engine-pkg', p.slice('/modoki/assets/'.length));
  if (p.startsWith('/assets/')) return path.join(PROJECT_ROOT, 'runtime/assets', p.slice('/assets/'.length));
  if (p.startsWith('/games/')) return path.join(PROJECT_ROOT, p.slice(1));
  return null;
}

function makeCtx(computeUnused: () => TreeShakeResult, resolve: (p: string) => string | null = defaultResolve): BackendContext {
  return {
    projectRoot: PROJECT_ROOT,
    computeUnused,
    resolveAssetPath: resolve,
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const get = (ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath: '/api/unused-assets', query: new URLSearchParams(), body: undefined });

function result(over: Partial<TreeShakeResult>): TreeShakeResult {
  return {
    kept: new Set(),
    stats: { scenes: 0, keptByType: {}, totalByType: {}, keptBytes: 0, droppedBytes: 0 },
    warnings: [],
    orphans: [],
    orphanDetails: [],
    ...over,
  };
}

describe('GET /api/unused-assets', () => {
  it('sorts orphans largest-first and sums totalBytes', async () => {
    const ctx = makeCtx(() => result({
      stats: { scenes: 3, keptByType: {}, totalByType: {}, keptBytes: 0, droppedBytes: 0 },
      orphanDetails: [
        { path: '/games/x/assets/a.png', type: 'texture', bytes: 100 },
        { path: '/games/x/assets/b.glb', type: 'model', bytes: 5000 },
        { path: '/games/x/assets/c.mat.json', type: 'material', bytes: 250 },
      ],
    }));
    const r = (await get(ctx)) as { body: { orphans: { path: string; bytes: number }[]; totalBytes: number; sceneCount: number } };
    expect(r.body.orphans.map((o) => o.path)).toEqual([
      '/games/x/assets/b.glb',
      '/games/x/assets/c.mat.json',
      '/games/x/assets/a.png',
    ]);
    expect(r.body.totalBytes).toBe(5350);
    expect(r.body.sceneCount).toBe(3);
  });

  it('passes through scan warnings and reports empty when nothing is orphaned', async () => {
    const ctx = makeCtx(() => result({ warnings: ['unresolved GUID ref: abc'] }));
    const r = (await get(ctx)) as { body: { orphans: unknown[]; totalBytes: number; warnings: string[] } };
    expect(r.body.orphans).toEqual([]);
    expect(r.body.totalBytes).toBe(0);
    expect(r.body.warnings).toEqual(['unresolved GUID ref: abc']);
  });

  it('filters out engine-shared /modoki/assets orphans (not the project to clean)', async () => {
    const ctx = makeCtx(() => result({
      orphanDetails: [
        { path: '/assets/textures/unused.png', type: 'texture', bytes: 100 },
        { path: '/modoki/assets/fonts/Roboto/Roboto.ttf', type: 'font', bytes: 99999 },
      ],
    }));
    const r = (await get(ctx)) as { body: { orphans: { path: string }[]; totalBytes: number } };
    expect(r.body.orphans.map((o) => o.path)).toEqual(['/assets/textures/unused.png']);
    expect(r.body.totalBytes).toBe(100); // the big engine font is excluded from the total
  });

  it('returns 500 when the shaker throws', async () => {
    const ctx = makeCtx(() => { throw new Error('boom'); });
    const r = (await get(ctx)) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('boom');
  });
});
