/** Router-level tests for POST /api/delete-asset's request handling — the
 *  branch logic that decides single-vs-batch, 403/404/400, and the skip-missing
 *  behavior that lets a batch carry maybe-absent `.meta.json` sidecars. The
 *  actual OS-trash batching (a path list → one invocation) is proven in
 *  assetFsOps.integration.test.ts; here we deliberately exercise ONLY the
 *  no-trash branches so the test never shells out to Finder/trash-put. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// The trash itself is proven against disk in assetFsOps.integration.test.ts. Here it
// is stubbed so the REBUILD branch — which only runs when something was actually
// trashed — is reachable without shelling out to Finder/trash-put. Without the stub
// the positive case below could not be written at all, and the rebuild would only
// ever be asserted in its did-not-happen form.
const trashed: string[][] = [];
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => { trashed.push(Array.isArray(paths) ? paths : [paths]); },
}));

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

// Minimal context: /api/delete-asset touches resolveAssetPath and (once anything
// was actually trashed) rebuildManifest. The rest is cast away — if a future change
// makes the handler reach another method, the undefined call will throw loudly
// rather than pass silently.
function makeCtx(
  resolve: (p: string) => string | null,
  rebuild: () => unknown = () => ({ version: 2, assets: [], folders: [] }),
): BackendContext {
  return {
    projectRoot: os.tmpdir(),
    resolveAssetPath: resolve,
    rebuildManifest: rebuild,
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

/** The manifest rebuild (#288 gap 3). Both backends DO watch `unlink` and rebuild,
 *  but on a 150ms debounce — so the reply used to be AHEAD of the state a caller
 *  verifies with, and a `list_assets` issued straight after (or in the same
 *  `modoki_batch`, where there is no wall-clock gap at all) could still see the
 *  asset it had just been told was trashed. The sibling mutating routes rebuild
 *  inline; this one did not. */
describe('/api/delete-asset rebuilds the asset manifest inline', () => {
  /** A tmpdir with one real file, so `fs.existsSync` puts the path in `resolved`
   *  and the handler reaches the trash+rebuild branch. */
  function withRealFile(): { ctx: (rebuild: () => unknown) => BackendContext; url: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-delete-router-'));
    fs.writeFileSync(path.join(dir, 'probe.particle.json'), '{}');
    return {
      dir,
      url: '/probe.particle.json',
      ctx: (rebuild) => makeCtx((p) => path.join(dir, p), rebuild),
    };
  }

  it('rebuilds ONCE when a file was trashed, and says so in the reply', async () => {
    const { ctx, url, dir } = withRealFile();
    trashed.length = 0;
    let rebuilds = 0;
    const r = (await del({ paths: [url] }, ctx(() => { rebuilds++; return {}; }))) as
      { status?: number; body: { ok: boolean; trashed: number; manifestRebuilt: boolean } };
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBeUndefined();
    expect(r.body.trashed).toBe(1);
    expect(trashed.length).toBe(1); // ONE OS call for the whole list — one trash sound.
    // The claim the tool's description rests on: a modoki_list_assets issued straight
    // after this reply — including in the same modoki_batch, where there is no
    // wall-clock gap for the watcher's 150ms debounce to land in — sees the deletion.
    expect(rebuilds).toBe(1);
    expect(r.body.manifestRebuilt).toBe(true);
  });

  it('a rebuild that THROWS is not a failed delete — it downgrades to manifestRebuilt:false', async () => {
    const { ctx, url, dir } = withRealFile();
    const r = (await del({ paths: [url] }, ctx(() => { throw new Error('manifest exploded'); }))) as
      { status?: number; body: { ok: boolean; trashed: number; manifestRebuilt: boolean } };
    fs.rmSync(dir, { recursive: true, force: true });
    // The trash ALREADY happened. A 500 here would read as "nothing was deleted" and
    // invite a retry against files that are already gone — a wrong answer stated
    // authoritatively, which outranks the inconvenience of a stale manifest.
    expect(r.status).toBeUndefined();
    expect(r.body.ok).toBe(true);
    expect(r.body.trashed).toBe(1);
    expect(r.body.manifestRebuilt).toBe(false);
  });

  it('does NOT rebuild when nothing was trashed (all paths missing)', async () => {
    let rebuilds = 0;
    const ctx = makeCtx((p) => path.join(ABSENT_ROOT, p), () => { rebuilds++; return {}; });
    const r = (await del({ paths: ['/games/x/gone.png'] }, ctx)) as { body: { manifestRebuilt: boolean } };
    // Nothing left the disk, so there is nothing for the manifest to catch up ON.
    // Reporting `manifestRebuilt:true` here would be a claim about work that never
    // happened — the shape §0 ranks worst.
    expect(rebuilds).toBe(0);
    expect(r.body.manifestRebuilt).toBe(false);
  });
});
