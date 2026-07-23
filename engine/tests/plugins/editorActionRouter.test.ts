/** Router tests for the editor-parity endpoints: /api/editor-state (relay),
 *  /api/editor-action (allowlist + relay), /api/scenes (manifest filter), and
 *  /api/import-file (request validation). These prove the routing/guard logic
 *  without a live renderer — requestBrowser is mocked. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });
const get = (url: string, ctx: BackendContext) => {
  const [urlPath, qs] = url.split('?');
  return handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(qs ?? ''), body: undefined });
};

describe('/api/editor-action', () => {
  it('400 on a missing action', async () => {
    const r = (await post('/api/editor-action', {}, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('400 on an action outside the allowlist', async () => {
    const r = (await post('/api/editor-action', { action: 'rm -rf' }, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('relays an allowed action to the renderer, stripping `action` from params', async () => {
    const requestBrowser = vi.fn(async () => ({ ok: true, playState: 'playing' }));
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/editor-action', { action: 'play', foo: 1 }, ctx)) as { body: unknown };
    expect(requestBrowser).toHaveBeenCalledWith('play', { foo: 1 }, expect.any(Number));
    expect(r.body).toEqual({ ok: true, playState: 'playing' });
  });

  it('504 when the renderer relay throws (no editor connected)', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no renderer'); } });
    const r = (await post('/api/editor-action', { action: 'undo' }, ctx)) as { status?: number };
    expect(r.status).toBe(504);
  });
});

describe('/api/eval', () => {
  it('400 on a missing/empty code string', async () => {
    expect(((await post('/api/eval', {}, makeCtx())) as { status?: number }).status).toBe(400);
    expect(((await post('/api/eval', { code: '' }, makeCtx())) as { status?: number }).status).toBe(400);
  });

  it('relays code to the renderer `eval` op and returns the result', async () => {
    const requestBrowser = vi.fn(async () => '42');
    const r = (await post('/api/eval', { code: 'return 40 + 2' }, makeCtx({ requestBrowser }))) as { body: unknown };
    expect(requestBrowser).toHaveBeenCalledWith('eval', { code: 'return 40 + 2' });
    expect(r.body).toEqual({ result: '42' });
  });

  it('504 when the renderer relay throws (no editor connected)', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no renderer'); } });
    expect(((await post('/api/eval', { code: 'return 1' }, ctx)) as { status?: number }).status).toBe(504);
  });

  it('passes an "Error: …" renderer result through as a 200 body (error-shaping is the TOOL\'s job)', async () => {
    // handleEval returns a thrown eval as an in-band "Error: …" string, not a rejected promise. The
    // router must NOT turn that into a 5xx — the MCP tool (evalRenderer) is what flags it isError.
    const requestBrowser = vi.fn(async () => 'Error: boom is not defined');
    const r = (await post('/api/eval', { code: 'return boom' }, makeCtx({ requestBrowser }))) as { status?: number; body: unknown };
    expect(r.status).toBeUndefined(); // 200
    expect(r.body).toEqual({ result: 'Error: boom is not defined' });
  });
});

describe('/api/editor-state', () => {
  it('relays the editor-state op', async () => {
    const requestBrowser = vi.fn(async () => ({ playState: 'stopped', selection: { entityId: 3 } }));
    const ctx = makeCtx({ requestBrowser });
    const r = (await get('/api/editor-state', ctx)) as { body: unknown };
    expect(requestBrowser).toHaveBeenCalledWith('editor-state', {});
    expect(r.body).toMatchObject({ playState: 'stopped' });
  });
});

describe('/api/scenes', () => {
  it('lists only scene-type assets from the manifest', async () => {
    const ctx = makeCtx({
      getManifest: () => ({ version: 2, assets: [
        { path: '/games/x/assets/scenes/a.json', type: 'scene', guid: 'g-a' },
        { path: '/games/x/assets/foo.mesh.json', type: 'mesh' },
      ] }) as unknown as Manifest,
    });
    const r = (await get('/api/scenes', ctx)) as { body: { count: number; scenes: Array<{ path: string; guid?: string }> } };
    expect(r.body.count).toBe(1);
    expect(r.body.scenes[0]).toMatchObject({ path: '/games/x/assets/scenes/a.json', guid: 'g-a' });
  });
});

describe('/api/asset-schema + /api/asset-write (Phase C, host-side)', () => {
  it('asset-schema returns field metadata + example for a type', async () => {
    const r = (await get('/api/asset-schema?type=material', makeCtx())) as { body: { type: string; fields: unknown[]; example: unknown } };
    expect(r.body.type).toBe('material');
    expect(r.body.fields.length).toBeGreaterThan(0);
    expect(r.body.example).toBeTruthy();
  });

  it('asset-schema 400 on a missing/unknown type', async () => {
    const r = (await get('/api/asset-schema', makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  /**
   * C7 — write_asset must PRESERVE the asset's GUID, as its own description promises.
   *
   * The bug: the preserve branch was `out.id == null`, but normalizeAssetData NORMALISES a
   * missing id to an EMPTY STRING (normalizeAnimationClip: `id: json.id ?? ''`), and
   * '' == null is FALSE — so for animations the branch never fired. The file was written with
   * id:'', readAssetGuid rejected it, and the watcher's heal minted a BRAND-NEW guid ~150ms
   * later. Every scene/Animator reference to the old guid dangled and the clip silently
   * stopped loading — while the tool reported ok:true. Nothing errored at any step.
   */
  describe('asset-write GUID preservation (C7)', () => {
    let dir: string;
    const ctx = () => makeCtx({ resolveAssetPath: (p: string) => path.join(dir, path.basename(p)) });
    const readBack = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-assetwrite-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('ANIMATION: keeps the existing id when data omits it (the empty-string trap)', async () => {
      fs.writeFileSync(path.join(dir, 'run.anim.json'), JSON.stringify({ id: 'GUID-A', name: 'Run', duration: 1, tracks: [] }));
      const r = (await post('/api/asset-write', {
        path: '/games/x/run.anim.json', type: 'animation',
        data: { name: 'Run v2', duration: 2, tracks: [] }, // no id — exactly what asset_schema's example shows
      }, ctx())) as { body?: { ok?: boolean } };
      expect(r.body?.ok).toBe(true);
      expect(readBack('run.anim.json').id).toBe('GUID-A'); // was '' → watcher minted a NEW guid → scene refs dangled
    });

    it('ANIMATION: an explicit id still wins (renaming the asset is deliberate)', async () => {
      fs.writeFileSync(path.join(dir, 'run.anim.json'), JSON.stringify({ id: 'GUID-A', name: 'Run', duration: 1, tracks: [] }));
      await post('/api/asset-write', {
        path: '/games/x/run.anim.json', type: 'animation',
        data: { id: 'GUID-B', name: 'Run', duration: 1, tracks: [] },
      }, ctx());
      expect(readBack('run.anim.json').id).toBe('GUID-B');
    });

    it('MATERIAL: keeps the existing id too (the branch must not regress for other types)', async () => {
      fs.writeFileSync(path.join(dir, 'm.mat.json'), JSON.stringify({ id: 'GUID-M', color: '#fff' }));
      await post('/api/asset-write', { path: '/games/x/m.mat.json', type: 'material', data: { color: '#000' } }, ctx());
      expect(readBack('m.mat.json').id).toBe('GUID-M');
    });

    it('a NEW file with no prior id is written without inventing one', async () => {
      const r = (await post('/api/asset-write', {
        path: '/games/x/new.anim.json', type: 'animation', data: { name: 'New', duration: 1, tracks: [] },
      }, ctx())) as { body?: { ok?: boolean } };
      expect(r.body?.ok).toBe(true);
      expect(readBack('new.anim.json').id).toBeFalsy(); // create-asset owns minting, not this route
    });
  });

  it('asset-write 400 on hard-invalid data (non-object)', async () => {
    const r = (await post('/api/asset-write', { path: '/games/x/a.mat.json', type: 'material', data: 5 }, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('asset-write 400 when path/type missing', async () => {
    const r = (await post('/api/asset-write', { data: {} }, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });
});

describe('relay GET routes 504 without a renderer', () => {
  const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no renderer'); } });
  for (const route of ['/api/journal', '/api/game-introspect', '/api/layout-bounds', '/api/diagnose']) {
    it(`${route} → 504`, async () => {
      const r = (await get(route, ctx)) as { status?: number };
      expect(r.status).toBe(504);
    });
  }
});

describe('/api/read-meta (F10: outside-root & missing-asset are not a silent {})', () => {
  it('403 for a path outside allowed directories (was a silent {})', async () => {
    const ctx = makeCtx({ resolveAssetPath: () => null });
    const r = (await get('/api/read-meta?path=/etc/passwd', ctx)) as { status?: number };
    expect(r.status).toBe(403);
  });

  it('404 when the asset does not exist', async () => {
    const ctx = makeCtx({ resolveAssetPath: (p: string) => p });
    const missing = path.join(os.tmpdir(), `modoki-nometa-${process.pid}-none.glb`);
    const r = (await get('/api/read-meta?path=' + encodeURIComponent(missing), ctx)) as { status?: number };
    expect(r.status).toBe(404);
  });

  it('200 raw when the asset EXISTS but has no sidecar — now unambiguously "no sidecar"', async () => {
    const asset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-meta-')), 'x.glb');
    fs.writeFileSync(asset, 'glb-bytes');
    const ctx = makeCtx({ resolveAssetPath: (p: string) => p });
    const r = (await get('/api/read-meta?path=' + encodeURIComponent(asset), ctx)) as { kind?: string; status?: number; body: string };
    expect(r.status).toBeUndefined();       // 200, not an error
    expect(r.kind).toBe('raw');
    expect(typeof JSON.parse(r.body)).toBe('object');
  });
});

describe('/api/import-file (F11: an unrecognized type is not a phantom success)', () => {
  it('copies the file but returns ok:false 422 when nothing registers as an asset', async () => {
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-imp-')), 'thing.xyz');
    fs.writeFileSync(src, 'not an asset');
    const destFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-dest-'));
    const ctx = makeCtx({
      resolveAssetPath: (p: string) => p,   // destFolder resolves to itself (a real dir)
      absToAssetUrl: (p: string) => p,      // dest abs → a "url"
      getManifest: () => ({ version: 2, assets: [] }) as Manifest,       // scanner registered nothing
      rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    });
    const r = (await post('/api/import-file', { srcPath: src, destFolder }, ctx)) as { status?: number; body: { ok: boolean; imported: boolean; error?: string } };
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.imported).toBe(false);
    expect(r.body.error).toMatch(/registered no asset/);
    expect(fs.existsSync(path.join(destFolder, 'thing.xyz'))).toBe(true); // the copy DID land
  });
});

describe('/api/scene-mutate (play-mode guard)', () => {
  // The mutate handler reads/writes a real scene file, so each case gets a temp
  // scene on disk. resolveAssetPath is identity (makeCtx default), so the abs
  // temp path passed as `body.path` resolves straight through.
  let seq = 0;
  function tempScene(): string {
    const p = path.join(os.tmpdir(), `modoki-mutate-guard-${process.pid}-${seq++}.json`);
    fs.writeFileSync(p, JSON.stringify({
      entities: [{ id: 1, name: 'Box', traits: { Transform: { x: 0, y: 0 }, EntityAttributes: { name: 'Box', guid: 'g-box' } } }],
    }));
    return p;
  }
  const setX = (scenePath: string) => ({
    path: scenePath,
    ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 5 } }],
  });

  for (const playState of ['playing', 'paused'] as const) {
    it(`refuses with 409 while ${playState}, leaving the file untouched`, async () => {
      const scenePath = tempScene();
      const before = fs.readFileSync(scenePath, 'utf-8');
      const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ playState })) });
      const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { status?: number; body: { playState?: string } };
      expect(r.status).toBe(409);
      expect(r.body.playState).toBe(playState);
      // No write happened — the on-disk scene is byte-identical.
      expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);
    });
  }

  it('refuses with 409 when the editor has UNSAVED live changes, leaving the file untouched (F3)', async () => {
    // The write would hot-reload the scene FILE, rebuilding the live world and destroying live-only
    // entities (create_entity / prefab) not yet saved. Refuse, like load_scene/new_scene guardUnsaved.
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf-8');
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped', unsavedChanges: true })) });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { status?: number; body: { ok: boolean; unsavedChanges?: boolean; error?: string } };
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.unsavedChanges).toBe(true);
    expect(r.body.error).toMatch(/save_all/);
    expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before); // no write
  });

  it('applies the mutate when the editor is stopped', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped' })) });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { body: { ok: boolean; changed: number } };
    expect(r.body.ok).toBe(true);
    expect(r.body.changed).toBeGreaterThan(0);
    // The write landed on disk.
    const written = JSON.parse(fs.readFileSync(scenePath, 'utf-8'));
    expect(written.entities[0].traits.Transform.x).toBe(5);
  });

  it('applies the mutate when no editor is connected (relay throws)', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no renderer'); } });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { status?: number; body: { ok: boolean; changed: number } };
    expect(r.status).toBeUndefined(); // 200 (not blocked)
    expect(r.body.ok).toBe(true);
    expect(r.body.changed).toBeGreaterThan(0);
  });

  // ── The scene echo (docs/mcp-response-budget.md Phase 2). ──
  // A successful mutate used to return the whole scene FILE. `setTrait` always changes
  // something, so it always fired: ~10k tokens of agent context per edit, on the hottest
  // write path, that nothing read — and the wrong data besides (the pre-expansion file,
  // not the live world). Now opt-in.
  describe('scene echo', () => {
    const stopped = () => makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped' })) });

    it('omits `scene` by default, even on a successful change', async () => {
      const scenePath = tempScene();
      const r = (await post('/api/scene-mutate', setX(scenePath), stopped())) as { body: Record<string, unknown> };
      expect(r.body.changed).toBeGreaterThan(0);
      expect(r.body.scene).toBeUndefined();
      expect('scene' in r.body).toBe(false); // absent, not merely undefined
      // The useful fields survive.
      expect(r.body).toMatchObject({ ok: true, errors: [], warnings: [] });
    });

    it('returns `scene` when the caller opts in with returnScene', async () => {
      const scenePath = tempScene();
      const body = { ...setX(scenePath), returnScene: true };
      const r = (await post('/api/scene-mutate', body, stopped())) as { body: { scene?: { entities: { traits: { Transform: { x: number } } }[] } } };
      expect(r.body.scene).toBeDefined();
      expect(r.body.scene!.entities[0].traits.Transform.x).toBe(5); // post-mutate state
    });

    it('omits `scene` even with returnScene when nothing changed', async () => {
      const scenePath = tempScene();
      // entity-not-found → structural no-op: changed === 0, file untouched.
      const body = {
        path: scenePath,
        ops: [{ op: 'setTrait', entity: { id: 999 }, trait: 'Transform', fields: { x: 5 } }],
        returnScene: true,
      };
      const r = (await post('/api/scene-mutate', body, stopped())) as { body: { changed: number; scene?: unknown } };
      expect(r.body.changed).toBe(0);
      expect(r.body.scene).toBeUndefined();
    });
  });

  // ── C7 re-audit: a setTrait naming an unknown FIELD on a KNOWN trait is a certain typo (the
  // loader drops it), so with a schema available it must FAIL rather than report {ok:true,
  // changed:1}. Kept narrow — unknown trait + cold start stay warn-but-load. ──
  describe('schema-aware field-typo guard', () => {
    const schema = { traits: { Transform: { category: 'component' as const, fields: { x: { type: 'number' as const }, y: { type: 'number' as const } } } } };
    const stoppedWithSchema = () => makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped' })), getSchema: () => schema });

    it('fails ok:false when a setTrait writes an unknown field on a known trait', async () => {
      const scenePath = tempScene();
      const body = { path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { xx: 5 } }] };
      const r = (await post('/api/scene-mutate', body, stoppedWithSchema())) as { body: { ok: boolean; errors: string[] } };
      expect(r.body.ok).toBe(false);
      expect(r.body.errors.some((e) => /Transform\.xx|unknown field/i.test(e))).toBe(true);
    });

    it('still applies the VALID fields (warn-but-load) while failing on the typo', async () => {
      const scenePath = tempScene();
      const body = { path: scenePath, ops: [
        { op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } },
        { op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { zz: 1 } },
      ] };
      const r = (await post('/api/scene-mutate', body, stoppedWithSchema())) as { body: { ok: boolean; changed: number } };
      expect(r.body.ok).toBe(false);              // the typo fails the call
      expect(r.body.changed).toBeGreaterThan(0);  // but the valid field applied
      expect(JSON.parse(fs.readFileSync(scenePath, 'utf-8')).entities[0].traits.Transform.x).toBe(9);
    });

    it('leaves an UNKNOWN TRAIT as warn-but-load (ok:true) — forward-compat, not a typo', async () => {
      const scenePath = tempScene();
      const body = { path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'FutureTrait', fields: { a: 1 } }] };
      const r = (await post('/api/scene-mutate', body, stoppedWithSchema())) as { body: { ok: boolean; warnings: string[] } };
      expect(r.body.ok).toBe(true);
      expect(r.body.warnings.some((w) => /unknown trait/i.test(w))).toBe(true);
    });

    it('cold start (no schema) stays warn-but-load — an unknown field is NOT failed', async () => {
      const scenePath = tempScene();
      const body = { path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { xx: 5 } }] };
      const r = (await post('/api/scene-mutate', body, makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped' })) }))) as { body: { ok: boolean } };
      expect(r.body.ok).toBe(true); // getSchema() undefined → can't know it is a typo
    });
  });
});

/** Phase 6 of docs/mcp-response-budget.md. Two distinct hazards live here.
 *
 *  1. The router ALLOWLISTS query params. A param the tool sends but the router does not parse is
 *     silently dropped — the caller believes it narrowed and it did nothing. That is the worst
 *     failure mode in this whole surface, and it has happened.
 *  2. `enact-handles` is the ONE seam whose summary lives in the router rather than the agent op,
 *     because `engine/electron/inputRoutes.ts` calls the op directly to resolve `tap_handle`
 *     coordinates. Summarizing the op would break trusted input while every test stayed green. */
// Re-audit finding 4: the cross-process config-invalidate route the Electron main POSTs to the
// child Vite so a project_settings write invalidates the cached config module (no page reload).
describe('/api/invalidate-project-config', () => {
  it('calls ctx.invalidateProjectConfig and returns ok', async () => {
    const invalidateProjectConfig = vi.fn();
    const r = (await post('/api/invalidate-project-config', {}, makeCtx({ invalidateProjectConfig }))) as { body: { ok: boolean } };
    expect(invalidateProjectConfig).toHaveBeenCalledTimes(1);
    expect(r.body).toEqual({ ok: true });
  });

  it('project_settings POST also invalidates the config module', async () => {
    const invalidateProjectConfig = vi.fn();
    await post('/api/project-settings', { app: { appName: 'X' } }, makeCtx({ invalidateProjectConfig }));
    expect(invalidateProjectConfig).toHaveBeenCalledTimes(1);
  });
});

describe('router forwards the size-control params (never silently drops them)', () => {
  /** Capture the params that actually reach the renderer op. */
  function spyCtx() {
    const seen: Array<{ op: string; params: unknown }> = [];
    const ctx = makeCtx({
      requestBrowser: (async (op: string, params: unknown) => {
        seen.push({ op, params });
        return { handles: [] };
      }) as BackendContext['requestBrowser'],
    });
    return { ctx, seen };
  }

  it('/api/journal forwards limit', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/journal?limit=5', ctx);
    expect(seen[0]).toMatchObject({ op: 'journal-events', params: { limit: 5 } });
  });

  it('/api/journal omits limit when absent (so the op applies its default)', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/journal', ctx);
    expect((seen[0].params as { limit?: number }).limit).toBeUndefined();
  });

  it('/api/watch/read forwards samples=1', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/watch/read?id=w1&samples=1', ctx);
    expect(seen[0]).toMatchObject({ op: 'watch-read', params: { id: 'w1', samples: true } });
  });

  it('/api/watch/read defaults samples to false (stats-only)', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/watch/read?id=w1', ctx);
    expect(seen[0]).toMatchObject({ params: { samples: false } });
  });

  it('/api/layout-bounds forwards entities + overlaps', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/layout-bounds?entities=1&overlaps=1', ctx);
    expect(seen[0]).toMatchObject({ op: 'layout-bounds', params: { entities: true, overlaps: true } });
  });

  it('/api/layout-bounds omits them when absent (counts-only default)', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/layout-bounds', ctx);
    const p = seen[0].params as { entities?: boolean; overlaps?: boolean };
    expect(p.entities).toBeUndefined();
    expect(p.overlaps).toBeUndefined();
  });

  it('/api/console-logs DROPS a non-numeric limit rather than passing NaN', async () => {
    // NaN defeats the op's tail (`NaN ?? 50` is NaN; `length > NaN` is false), so `?limit=abc`
    // would return the whole 500-entry ring — a full-buffer flood produced by a typo.
    const { ctx, seen } = spyCtx();
    await get('/api/console-logs?limit=abc', ctx);
    expect((seen[0].params as { limit?: number }).limit).toBeUndefined();
  });

  it('/api/console-logs DROPS a non-numeric since rather than passing NaN', async () => {
    // `ts > NaN` is false for every entry → zero logs, silently hiding real errors.
    const { ctx, seen } = spyCtx();
    await get('/api/console-logs?since=abc', ctx);
    expect((seen[0].params as { since?: number }).since).toBeUndefined();
  });

  it('/api/console-logs still forwards a valid limit', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/console-logs?limit=5', ctx);
    expect(seen[0]).toMatchObject({ op: 'console-logs', params: { limit: 5 } });
  });

  it('/api/layout-bounds forwards a numeric limit and drops a bad one', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/layout-bounds?layer=3d&limit=10', ctx);
    expect(seen[0]).toMatchObject({ params: { layer: '3d', limit: 10 } });
    const b = spyCtx();
    await get('/api/layout-bounds?layer=3d&limit=abc', b.ctx);
    expect((b.seen[0].params as { limit?: number }).limit).toBeUndefined();
  });

  it('/api/editor-journal forwards limit', async () => {
    const { ctx, seen } = spyCtx();
    await get('/api/editor-journal?limit=7', ctx);
    expect(seen[0]).toMatchObject({ op: 'editor-journal', params: { limit: 7 } });
  });
});

describe('/api/enact-handles summarizes in the ROUTER, not the op', () => {
  const HANDLES = [
    { id: 'a', editor: 'chrome', kind: 'button', x: 1, y: 2 },
    { id: 'b', editor: 'chrome', kind: 'toggle', x: 3, y: 4 },
    { id: 'c', editor: 'dopesheet', kind: 'keyframe', x: 5, y: 6 },
  ];
  const opResult = {
    count: 3, editors: ['chrome', 'dopesheet'], offScreenCount: 0, occludedCount: 0,
    occlusionUnchecked: 1, disabledCount: 0, viewport: { w: 800, h: 600 }, handles: HANDLES,
  };
  const ctx = () => makeCtx({ requestBrowser: (async () => opResult) as BackendContext['requestBrowser'] });

  it('a bare call returns counts and DROPS handles[]', async () => {
    const r = (await get('/api/enact-handles', ctx())) as { body: Record<string, unknown> };
    expect(r.body.handles).toBeUndefined();
    expect(r.body.byEditor).toEqual({ chrome: 2, dopesheet: 1 });
    expect(r.body.byKind).toEqual({ button: 1, toggle: 1, keyframe: 1 });
    expect(r.body.hint).toContain('editor=');
  });

  it('keeps every occlusion counter — occludedCount:0 is a lie without occlusionUnchecked', async () => {
    const r = (await get('/api/enact-handles', ctx())) as { body: Record<string, unknown> };
    expect(r.body).toMatchObject({
      count: 3, occludedCount: 0, occlusionUnchecked: 1, offScreenCount: 0,
      disabledCount: 0, viewport: { w: 800, h: 600 },
    });
  });

  for (const q of ['editor=chrome', 'kind=keyframe', 'ids=a,b']) {
    it(`a targeted call (?${q}) passes the geometry through untouched`, async () => {
      const r = (await get(`/api/enact-handles?${q}`, ctx())) as { body: { handles?: unknown[]; byEditor?: unknown } };
      expect(r.body.handles).toHaveLength(3); // whatever the op returned, verbatim
      expect(r.body.byEditor).toBeUndefined();
    });
  }

  it('an empty handle set hints at opening the editor, rather than reading as "nothing to aim at"', async () => {
    const empty = makeCtx({ requestBrowser: (async () => ({ ...opResult, count: 0, handles: [] })) as BackendContext['requestBrowser'] });
    const r = (await get('/api/enact-handles', empty)) as { body: { hint: string } };
    expect(r.body.hint).toContain('open the relevant editor');
  });
});

describe('/api/import-file (validation)', () => {
  it('400 when srcPath/destFolder missing', async () => {
    const r = (await post('/api/import-file', { srcPath: '/tmp/a.png' }, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('404 when the source file does not exist', async () => {
    const r = (await post('/api/import-file', { srcPath: '/tmp/definitely-missing-xyz.png', destFolder: '/games/x/assets' }, makeCtx())) as { status?: number };
    expect(r.status).toBe(404);
  });
});
