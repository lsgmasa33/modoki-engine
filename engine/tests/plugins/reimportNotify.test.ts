/** /api/reimport → renderer notification (the fix for "reimport needs an editor
 *  restart"). The endpoint re-bakes files on disk but had no channel to the live
 *  renderer, so the path-keyed GPU cache kept serving stale geometry. It now pushes
 *  every freshly-baked path to the renderer via
 *  requestBrowser('invalidate-assets', {items}) so the live viewport rebinds without
 *  a restart. These tests lock that wiring at the router seam.
 *
 *  ⚠️ **`requestBrowser` is no longer this route's ONLY renderer call** (#872/#882). It now also
 *  asks `resolve-meta-park` — before the bake — whether a human's Inspector import-settings edit is
 *  parked for a target, because every handler reads the sidecar off DISK and would otherwise
 *  convert with the pre-edit values. So these assertions count and inspect the `invalidate-assets`
 *  call SPECIFICALLY rather than "the one call": a bare `toHaveBeenCalledTimes(1)` here would break
 *  on any future renderer round trip this route grows, and — worse — would pass while pointing at
 *  the wrong call. `invalidateCalls` is that filter. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { registerReimportHandler } from '../../plugins/reimport-registry';

// Real `assertSidecarWritable` only throws for an actual too-new sidecar ON DISK — these
// tests use fake in-memory paths, so mock it to throw for one chosen path instead of
// standing up real files. Every other export passes through unmocked.
vi.mock('../../plugins/meta-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plugins/meta-sidecar')>();
  return { ...actual, assertSidecarWritable: vi.fn(actual.assertSidecarWritable) };
});
import { assertSidecarWritable } from '../../plugins/meta-sidecar';

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
    computeRefEdges: vi.fn(() => ({ edges: [], entities: [], allFiles: [], seeds: [], warnings: [], guidIndex: new Map(), guidOrigin: new Map() }) as ReturnType<BackendContext['computeRefEdges']>),
  };
}

/** Only the `invalidate-assets` calls. See the header: the park probe shares this spy. */
const invalidateCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => c[0] === 'invalidate-assets');

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
    expect(invalidateCalls(requestBrowser)).toHaveLength(1);
    expect(requestBrowser).toHaveBeenCalledWith('invalidate-assets', {
      items: [{ path: '/assets/models/thing.glb', type: 'model' }],
    });
  });

  /** This used to assert the OPPOSITE — that an audio item was filtered out here, on the
   *  stated grounds that a clip is "not a GPU cache the renderer keys by path". That
   *  premise was false: `audioBufferCache` is keyed by path and holds a decoded
   *  AudioBuffer, so the filter meant an MCP/curl re-import of a `.wav` re-encoded the
   *  file while the game kept playing the OLD audio until an editor restart (#304
   *  close-out). Worse, the same two-type list existed in the renderer op, so teaching
   *  either side about a new kind alone changed nothing.
   *
   *  The contract now: the route forwards EVERY baked type and `invalidate-assets`
   *  decides which hold a cache. A type it does not know costs one ignored array entry. */
  it('forwards every baked type and lets the renderer op decide what holds a cache', async () => {
    const manifest: Manifest = {
      version: 2,
      assets: [
        { path: '/assets/a/m.glb', type: 'model' },
        { path: '/assets/a/t.png', type: 'texture' },
        { path: '/assets/a/s.wav', type: 'audio' },
      ],
    };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/a', recursive: true }));

    expect((res as { body: { converted: number } }).body.converted).toBe(3); // all three baked
    expect(invalidateCalls(requestBrowser)).toHaveLength(1);
    const [, payload] = invalidateCalls(requestBrowser)[0];
    expect(payload).toEqual({
      items: [
        { path: '/assets/a/m.glb', type: 'model' },
        { path: '/assets/a/t.png', type: 'texture' },
        { path: '/assets/a/s.wav', type: 'audio' },
      ],
    });
  });

  it('does NOT notify when nothing converts (no handler for the type)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/x/data.json', type: 'json' }] };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/x/data.json' }));

    expect((res as { body: { skipped: number } }).body.skipped).toBe(1);
    expect(invalidateCalls(requestBrowser)).toHaveLength(0);
  });

  it('still returns the bake summary when the renderer is disconnected (requestBrowser rejects)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/models/thing.glb', type: 'model' }] };
    // ⚠️ The message must be one `isRelayTransportFailure` REALLY matches. It used to read
    // 'no live renderer / timeout' — a hand-written approximation of a wording no host emits, and
    // therefore a case that proved nothing about a disconnected renderer once anything started
    // CLASSIFYING the rejection. `#867` extracted that matcher precisely because hand-copies of it
    // are born wrong; a hand-copy in a TEST is the same hazard, one layer out.
    const requestBrowser = vi.fn().mockRejectedValue(new Error('no editor renderer window'));
    const ctx = makeCtx(manifest, requestBrowser);

    // Best-effort: the bake landed on disk, so the reimport must not fail on a
    // headless/disconnected renderer.
    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/models/thing.glb' }));

    expect((res as { status?: number }).status).not.toBe(500);
    expect((res as { body: { converted: number } }).body.converted).toBe(1);
    expect(invalidateCalls(requestBrowser)).toHaveLength(1);
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
    expect(invalidateCalls(requestBrowser)).toHaveLength(1);
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
    expect(invalidateCalls(requestBrowser)).toHaveLength(0);
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
    expect(invalidateCalls(requestBrowser)).toHaveLength(0);
  });

  it('a recursive path under which NO asset lives → ok:false 404 (F4)', async () => {
    const manifest: Manifest = { version: 2, assets: [{ path: '/assets/models/thing.glb', type: 'model' }] };
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);
    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/nonexistent', recursive: true }));
    expect((res as { body: { ok: boolean } }).body.ok).toBe(false);
    expect((res as { status?: number }).status).toBe(404);
    expect(invalidateCalls(requestBrowser)).toHaveLength(0);
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
    expect(invalidateCalls(requestBrowser)).toHaveLength(1);
    expect(requestBrowser).toHaveBeenCalledWith('invalidate-assets', {
      items: [
        { path: '/assets/models/a.glb', type: 'model' },
        { path: '/assets/tex/b.png', type: 'texture' },
        { path: '/games/x/c.glb', type: 'model' },
      ],
    });
  });

  it('a too-new-sidecar refusal on one asset lands in errors[] — the rest of a recursive reimport still bakes and the manifest still rebuilds', async () => {
    // `assertSidecarWritable` sits inside the per-asset try now (not outside it) — a
    // refusal on one asset must not abort the whole route and discard already-baked work.
    const manifest: Manifest = {
      version: 2,
      assets: [
        { path: '/assets/a/good.glb', type: 'model' },
        { path: '/assets/a/toonew.glb', type: 'model' },
        { path: '/assets/a/also-good.glb', type: 'model' },
      ],
    };
    vi.mocked(assertSidecarWritable).mockImplementation((abs: string) => {
      // A deliberately synthetic sentinel — NOT real prose from the real
      // `assertSidecarWritable` — so the assertion below proves the error
      // propagates through, not that we verified the real wording.
      if (abs.includes('toonew')) throw new Error('SENTINEL_TOO_NEW_MOCK_ERROR_xyz');
    });
    const requestBrowser = vi.fn().mockResolvedValue({ ok: true });
    const ctx = makeCtx(manifest, requestBrowser);

    const res = await handleBackendRequest(ctx, reimportReq({ path: '/assets/a', recursive: true }));

    const body = (res as { body: { converted: number; errors: string[] } }).body;
    expect(body.converted).toBe(2);                             // the other two still baked
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain('/assets/a/toonew.glb');   // the refused asset is named
    expect(body.errors[0]).toContain('SENTINEL_TOO_NEW_MOCK_ERROR_xyz');
    expect((res as { status?: number }).status).toBe(200);       // converted>0 → not a 500
    expect(ctx.rebuildManifest).toHaveBeenCalled();               // the route still finished
    // The renderer is told to evict only the two that actually re-baked.
    expect(invalidateCalls(requestBrowser)).toHaveLength(1);
    expect(requestBrowser).toHaveBeenCalledWith('invalidate-assets', {
      items: [
        { path: '/assets/a/good.glb', type: 'model' },
        { path: '/assets/a/also-good.glb', type: 'model' },
      ],
    });
  });
});
