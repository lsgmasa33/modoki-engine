/** /api/reimport → renderer notification (the fix for "reimport needs an editor
 *  restart"). The endpoint re-bakes files on disk but had no channel to the live
 *  renderer, so the path-keyed GPU cache kept serving stale geometry. It now pushes
 *  the freshly-baked model/texture paths to the renderer via
 *  requestBrowser('invalidate-assets', {items}) so the live viewport rebinds without
 *  a restart. These tests lock that wiring at the router seam. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { registerReimportHandler } from '../../plugins/reimport-registry';

/** A full mock context — every field a vi.fn/stub; tests override the few they read. */
function makeCtx(manifest: Manifest, requestBrowser = vi.fn().mockResolvedValue({ ok: true })): BackendContext {
  return {
    projectRoot: '/proj',
    resolveAssetPath: (p: string) => '/abs' + p,   // truthy so the handler runs
    absToAssetUrl: () => null,
    firstRootDir: () => '/proj',
    getManifest: () => manifest,
    rebuildManifest: vi.fn(() => manifest),
    requestBrowser,
    getSchema: () => undefined,
    markEditorWrite: vi.fn(),
    ssrLoadModule: vi.fn(),
    invalidateProjectConfig: vi.fn(),
    computeUnused: vi.fn(() => ({ orphans: [], orphanDetails: [] }) as unknown as ReturnType<BackendContext['computeUnused']>),
  };
}

function reimportReq(body: { path: string; recursive?: boolean }) {
  return { method: 'POST', urlPath: '/api/reimport', query: new URLSearchParams(), body };
}

describe('/api/reimport → invalidate-assets notification', () => {
  beforeEach(() => {
    // Mock handlers so no real bake runs; each just resolves (a "successful convert").
    registerReimportHandler('model', async () => {});
    registerReimportHandler('texture', async () => {});
    registerReimportHandler('audio', async () => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('notifies the renderer with the baked MODEL path after a single reimport', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/models/thing.glb', type: 'model' }] };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/models/thing.glb' }));

    expect((res as { body: { converted: number } }).body.converted).toBe(1);
    expect(requestBrowser).toHaveBeenCalledTimes(1);
    expect(requestBrowser).toHaveBeenCalledWith('invalidate-assets', {
      items: [{ path: '/assets/models/thing.glb', type: 'model' }],
    });
  });

  it('includes ONLY model/texture items — a baked audio asset is excluded', async () => {
    const manifest: Manifest = {
      version: 2,
      assets: [
        { path: '/assets/a/m.glb', type: 'model' },
        { path: '/assets/a/t.png', type: 'texture' },
        { path: '/assets/a/s.wav', type: 'audio' },   // converts, but not a GPU cache the renderer keys by path
      ],
    };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/a', recursive: true }));

    expect((res as { body: { converted: number } }).body.converted).toBe(3); // all three baked
    expect(requestBrowser).toHaveBeenCalledTimes(1);
    const [, payload] = requestBrowser.mock.calls[0];
    expect(payload).toEqual({
      items: [
        { path: '/assets/a/m.glb', type: 'model' },
        { path: '/assets/a/t.png', type: 'texture' },
      ],
    });
  });

  it('does NOT notify when nothing converts (no handler for the type)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/x/data.json', type: 'json' }] };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/x/data.json' }));

    expect((res as { body: { skipped: number } }).body.skipped).toBe(1);
    expect(requestBrowser).not.toHaveBeenCalled();
  });

  it('still returns the bake summary when the renderer is disconnected (requestBrowser rejects)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/models/thing.glb', type: 'model' }] };
    const requestBrowser = vi.fn().mockRejectedValue(new Error('no live renderer / timeout'));
    const ctx = makeCtx(manifest, requestBrowser);

    // Best-effort: the bake landed on disk, so the reimport must not fail on a
    // headless/disconnected renderer.
    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/models/thing.glb' }));

    expect((res as { status?: number }).status).not.toBe(500);
    expect((res as { body: { converted: number } }).body.converted).toBe(1);
    expect(requestBrowser).toHaveBeenCalledTimes(1);
  });

  it('a handler that THROWS is excluded from invalidate items; a partial-failure batch still 200s', async () => {
    // A failed bake must NOT poison the renderer notification: only the assets that
    // actually re-baked get pushed to invalidate-assets. A batch that converted at
    // least one asset is a success (200) even though it also collected errors.
    const manifest: Manifest = {
      version: 2,
      assets: [
        { path: '/assets/a/good.glb', type: 'model' },
        { path: '/assets/a/bad.glb', type: 'model' },
      ],
    };
    // Handlers are keyed by TYPE, so branch on the path arg to fail exactly one model.
    registerReimportHandler('model', async (p: string) => {
      if (p === '/assets/a/bad.glb') throw new Error('bake blew up');
    });
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/a', recursive: true }));

    const body = (res as { body: { converted: number; errors: string[] } }).body;
    expect(body.converted).toBe(1);                       // only the good model baked
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain('/assets/a/bad.glb'); // the failure is reported
    expect((res as { status?: number }).status).toBe(200); // converted>0 → not a 500
    // The renderer is told to evict ONLY the successfully re-baked asset.
    expect(requestBrowser).toHaveBeenCalledTimes(1);
    expect(requestBrowser).toHaveBeenCalledWith('invalidate-assets', {
      items: [{ path: '/assets/a/good.glb', type: 'model' }],
    });
  });

  it('an ALL-error batch returns 500 and never notifies the renderer', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/a/only.glb', type: 'model' }] };
    registerReimportHandler('model', async () => { throw new Error('bake blew up'); });
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/a/only.glb' }));

    const body = (res as { body: { converted: number; errors: string[] } }).body;
    expect(body.converted).toBe(0);
    expect(body.errors.length).toBeGreaterThan(0);
    // converted===0 && errors>0 → 500, and nothing to invalidate → no browser push.
    expect((res as { status?: number }).status).toBe(500);
    expect(requestBrowser).not.toHaveBeenCalled();
  });

  it('a path matching NO manifest asset → ok:false 404, and never notifies the renderer (F4)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/models/thing.glb', type: 'model' }] };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    // A typo/casing/derived path resolves to zero targets. Before F4 the loop was skipped and
    // ok = converted>0 || errors.length===0 = true → {ok:true, converted:0}, a stale-asset trap.
    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/models/TYPO.glb' }));

    const body = (res as { body: { ok: boolean; converted: number; error?: string } }).body;
    expect(body.ok).toBe(false);
    expect(body.converted).toBe(0);
    expect(body.error).toMatch(/no manifest asset matches/);
    expect((res as { status?: number }).status).toBe(404);
    expect(requestBrowser).not.toHaveBeenCalled();
  });

  it('a recursive path under which NO asset lives → ok:false 404 (F4)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/models/thing.glb', type: 'model' }] };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);
    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/nonexistent', recursive: true }));
    expect((res as { body: { ok: boolean } }).body.ok).toBe(false);
    expect((res as { status?: number }).status).toBe(404);
    expect(requestBrowser).not.toHaveBeenCalled();
  });

  it("recursive target '/' selects EVERY absolute-path asset (empty prefix special-case)", async () => {
    // The router special-cases target==='/' to prefix='' so the startsWith('/') filter
    // matches every absolute manifest path — a whole-project re-bake.
    const manifest: Manifest = {
      version: 2,
      assets: [
        { path: '/assets/models/a.glb', type: 'model' },
        { path: '/assets/tex/b.png', type: 'texture' },
        { path: '/games/x/c.glb', type: 'model' },
      ],
    };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/', recursive: true }));

    const body = (res as { body: { converted: number; skipped: number } }).body;
    expect(body.converted).toBe(3);   // every asset under root baked
    expect(body.skipped).toBe(0);
    expect(requestBrowser).toHaveBeenCalledTimes(1);
    expect(requestBrowser).toHaveBeenCalledWith('invalidate-assets', {
      items: [
        { path: '/assets/models/a.glb', type: 'model' },
        { path: '/assets/tex/b.png', type: 'texture' },
        { path: '/games/x/c.glb', type: 'model' },
      ],
    });
  });
});
