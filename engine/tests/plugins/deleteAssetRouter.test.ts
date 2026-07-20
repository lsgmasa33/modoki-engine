/** Router-level tests for POST /api/delete-asset's request handling — the
 *  branch logic that decides single-vs-batch, 403/404/400, and the skip-missing
 *  behavior that lets a batch carry maybe-absent `.meta.json` sidecars. The
 *  actual OS-trash batching (a path list → one invocation) is proven in
 *  assetFsOps.integration.test.ts; here we deliberately exercise ONLY the
 *  no-trash branches so the test never shells out to Finder/trash-put. */

import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

// Minimal context: /api/delete-asset only touches resolveAssetPath. The rest is
// cast away — if a future change makes the handler reach another method, the
// undefined call will throw loudly rather than pass silently.
function makeCtx(resolve: (p: string) => string | null): BackendContext {
  return {
    projectRoot: os.tmpdir(),
    resolveAssetPath: resolve,
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const del = (body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/delete-asset', query: new URLSearchParams(), body });

// A directory that does not exist — so every resolvable path is "missing on disk"
// and the handler never calls moveToTrash (resolved.length stays 0).
const ABSENT_ROOT = path.join(os.tmpdir(), 'modoki-delete-router-test-nonexistent');
const resolvableButAbsent = makeCtx((p) => path.join(ABSENT_ROOT, p));

describe('/api/delete-asset routing (batch + back-compat)', () => {
  it('400 when neither path nor paths is provided', async () => {
    const r = (await del({}, resolvableButAbsent)) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('403 when a single path escapes the allowed roots', async () => {
    const r = (await del({ path: '/etc/passwd' }, makeCtx(() => null))) as { status?: number };
    expect(r.status).toBe(403);
  });

  it('single missing path → 404 (back-compat for Hierarchy / import-prune callers)', async () => {
    const r = (await del({ path: '/games/x/gone.png' }, resolvableButAbsent)) as { status?: number };
    expect(r.status).toBe(404);
  });

  it('a paths LIST of all-missing files → 200 ok, trashed:0, reports missing (NOT a wholesale 404)', async () => {
    const paths = ['/games/x/a.png', '/games/x/a.png.meta.json'];
    const r = (await del({ paths }, resolvableButAbsent)) as { status?: number; body: { ok: boolean; trashed: number; missing: string[] } };
    expect(r.status).toBeUndefined(); // json() without an explicit status = 200
    expect(r.body.ok).toBe(true);
    expect(r.body.trashed).toBe(0);
    expect(r.body.missing).toEqual(paths);
  });

  it('403 short-circuits the WHOLE batch if any path escapes the roots', async () => {
    const ctx = makeCtx((p) => (p.includes('bad') ? null : path.join(ABSENT_ROOT, p)));
    const r = (await del({ paths: ['/games/x/ok.png', '/games/x/bad.png'] }, ctx)) as { status?: number };
    expect(r.status).toBe(403);
  });
});
