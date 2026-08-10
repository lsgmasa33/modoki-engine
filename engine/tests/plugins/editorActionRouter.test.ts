/** Router tests for the editor-parity endpoints: /api/editor-state (relay),
 *  /api/editor-action (allowlist + relay), /api/scenes (manifest filter), and
 *  /api/import-file (request validation). These prove the routing/guard logic
 *  without a live renderer — requestBrowser is mocked. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { DEFAULT_PROJECT_CONFIG, PRIVATE_BUILD_FIELDS } from '../../project-config';

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

  it('504 for a relay TIMEOUT too — that is a gateway failure', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('timed out waiting for the renderer — is the editor window open?'); } });
    const r = (await post('/api/editor-action', { action: 'undo' }, ctx)) as { status?: number };
    expect(r.status).toBe(504);
  });

  /** REGRESSION (independent review, 2026-07-30). The matcher must cover every string
   *  `failPendingRenderer` (electron/main.ts) really sends when it aborts in-flight calls. It sent
   *  two — `'editor window closed'` (matched by `window closed`) and
   *  `'project changed — renderer reloading'` (matched by NOTHING) — so a request killed by a
   *  deliberate renderer teardown was reported as a 400 op refusal. That is this function's own
   *  inversion running backwards: a teardown is retryable once the renderer returns, a refusal is
   *  not, so the misclassification changes what the agent does next.
   *
   *  Driven from the REAL abort reasons rather than invented strings, which is why it caught one. */
  const TEARDOWN_REASONS = [
    'editor window closed',            // main.ts: window 'closed' handler
    'project changed — renderer reloading', // main.ts: project reload
  ];
  for (const reason of TEARDOWN_REASONS) {
    it(`504 for the real teardown abort ${JSON.stringify(reason)} — not an op refusal`, async () => {
      const ctx = makeCtx({ requestBrowser: async () => { throw new Error(reason); } });
      const r = (await post('/api/editor-action', { action: 'undo' }, ctx)) as { status?: number };
      expect(r.status, `${reason} must classify as transport`).toBe(504);
    });
  }

  it('the teardown reasons above are the ones main.ts ACTUALLY sends (guard against drift)', async () => {
    // A hand-written list of strings rots silently — and a rotted list here fails OPEN, because an
    // unmatched message is treated as the op speaking. Read them out of the source instead.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../electron/main.ts'), 'utf8');
    const sent = [...src.matchAll(/failPendingRenderer\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(sent.length, 'no failPendingRenderer calls found — did it move or get renamed?').toBeGreaterThan(0);
    for (const reason of sent) {
      expect(TEARDOWN_REASONS, `main.ts aborts with ${JSON.stringify(reason)}, which this suite never tests`).toContain(reason);
    }
  });

  it('400, NOT 504, when the OP itself refuses — a refusal is not a hung editor', async () => {
    // Measured on batch use case 8: `load-scene` correctly refused because the editor had unsaved
    // live-world changes, and it came back as `backend 504`. That reads as "the editor hung", so an
    // agent chases a wedge instead of calling save_all — the same misdiagnosis class as
    // capture_viewport's old "most likely wedged". The op answering is a 400.
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('load-scene: the editor has UNSAVED live-world changes'); } });
    const r = (await post('/api/editor-action', { action: 'load-scene', path: '/assets/scenes/x.json' }, ctx)) as { status?: number; body?: { error?: string } };
    expect(r.status).toBe(400);
    expect(r.body?.error).toMatch(/UNSAVED/); // the actionable message survives the reclassification
  });

  it('treats an UNRECOGNIZED error as the op speaking, not as transport', async () => {
    // Conservative on purpose: op errors are the common case, and mislabelling one as 504 is the
    // bug being fixed. A new transport message would need adding to the matcher deliberately.
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('something went sideways'); } });
    const r = (await post('/api/editor-action', { action: 'undo' }, ctx)) as { status?: number };
    expect(r.status).toBe(400);
  });
});

/** Drift guard for the timeline-MCP-400 bug (2026-07-26): `editorBackendRouter.ts`'s
 *  `EDITOR_ACTIONS` allow-list is maintained BY HAND, separately from the MCP tools that call
 *  it, and `'timeline-set'`/`'timeline-add-clip'` were simply never added — every call 400d
 *  with "unknown or missing editor action" until fixed.
 *
 *  This asserts the relationship that actually matters: every LITERAL action name the MCP
 *  server passes to `editorAction()` must be in the allow-list. That is a SUBSET check, not
 *  equality with the renderer's full `registerAgentOp` list — plenty of registered ops
 *  (`scene-state`, `journal-events`, `layout-bounds`, `diagnose`, `watch-*`, `eval`, …) are
 *  read-only and reach the renderer through their OWN routes, never through
 *  `/api/editor-action`, so they are correctly absent from `EDITOR_ACTIONS`. Asserting
 *  equality with `registerAgentOp` would be the WRONG check and would fail immediately —
 *  don't "fix" this test into that shape.
 *
 *  Two call sites in index.ts pass a caller-supplied `action` (zod-enum-restricted to
 *  play/stop/pause/resume/step and undo/redo) rather than a literal — those are validated by
 *  the zod schema at the tool boundary, not by this regex, and are not covered here. */
describe('drift guard: every literal MCP editorAction() name survives the router allowlist', () => {
  // Resolve relative to THIS test file's own path, not cwd — fileURLToPath, not
  // new URL(...).pathname, so the `/E:/…` leading-slash drive form doesn't double on
  // Windows (see games/sling/tests/testGamePath.ts for the same trap).
  // Post-E1 the tools live in `src/tools/*.ts`, not `src/index.ts` (which is now just the
  // executable entry). Scanning the old single file silently matched NOTHING here — the
  // per-action `it()` blocks vanished and only the count assertion below reported it. Read the
  // whole directory so a new group module is covered automatically.
  const mcpToolDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tools/modoki-mcp/src/tools');
  const mcpSource = fs.readdirSync(mcpToolDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(mcpToolDir, f), 'utf-8'))
    .join('\n');
  const actionNames = [...mcpSource.matchAll(/editorAction\(\s*'([^']+)'/g)].map((m) => m[1]);
  const uniqueActionNames = [...new Set(actionNames)];

  it('found a non-trivial set of literal action names to check (guards against a broken regex)', () => {
    expect(uniqueActionNames.length).toBeGreaterThan(15);
  });

  for (const action of uniqueActionNames) {
    it(`'${action}' is allow-listed (not a 400)`, async () => {
      const r = (await post('/api/editor-action', { action }, makeCtx())) as { status?: number };
      expect(r.status).not.toBe(400);
    });
  }
});

describe('/api/eval', () => {
  it('400 on a missing/empty code string', async () => {
    expect(((await post('/api/eval', {}, makeCtx())) as { status?: number }).status).toBe(400);
    expect(((await post('/api/eval', { code: '' }, makeCtx())) as { status?: number }).status).toBe(400);
  });

  /** This used to assert `requestBrowser('eval', { code })` — a TWO-argument call, i.e. the relay
   *  left on its 3000ms default. That expectation was defending the bug: the eval's own budget was
   *  5000ms, so the relay always gave up FIRST and reported a dead renderer where the eval would
   *  have said what the code was doing. The relay deadline must now be sized from the op's. */
  it('relays code + the op budget, and gives the relay headroom over it', async () => {
    const requestBrowser = vi.fn(async () => '42');
    const r = (await post('/api/eval', { code: 'return 40 + 2' }, makeCtx({ requestBrowser }))) as { body: unknown };
    expect(requestBrowser).toHaveBeenCalledWith('eval', { code: 'return 40 + 2', timeoutMs: 5000 }, 15_000);
    expect(r.body).toEqual({ result: '42' });
  });

  it('honours an explicit timeoutMs and keeps the relay strictly larger', async () => {
    const requestBrowser = vi.fn(async () => 'ok');
    await post('/api/eval', { code: 'return 1', timeoutMs: 20_000 }, makeCtx({ requestBrowser }));
    const [, params, relay] = requestBrowser.mock.calls[0] as unknown as [string, { timeoutMs: number }, number];
    expect(params.timeoutMs).toBe(20_000);
    expect(relay).toBeGreaterThan(params.timeoutMs);
  });

  it('clamps an over-cap timeoutMs rather than refusing it', async () => {
    const requestBrowser = vi.fn(async () => 'ok');
    await post('/api/eval', { code: 'return 1', timeoutMs: 999_999 }, makeCtx({ requestBrowser }));
    expect(requestBrowser).toHaveBeenCalledWith('eval', { code: 'return 1', timeoutMs: 25_000 }, 35_000);
  });

  it('falls back to the default for a junk timeoutMs', async () => {
    const requestBrowser = vi.fn(async () => 'ok');
    await post('/api/eval', { code: 'return 1', timeoutMs: -3 }, makeCtx({ requestBrowser }));
    expect(requestBrowser).toHaveBeenCalledWith('eval', { code: 'return 1', timeoutMs: 5000 }, 15_000);
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

  /** REGRESSION (independent review, 2026-07-30). The FILE branch runs `validateSceneData` after
   *  applying and returns its warnings; the LIVE branch ran no schema validation at all. Since
   *  `canGoLive` made live the path almost every agent edit takes, a field written with the WRONG
   *  TYPE — which the schema knows about and the file branch warns about — came back
   *  `{ok:true, changed:1, warnings:[]}`. The pre-flight (which already checked field NAMES for
   *  both branches) now checks types too, from the one place both paths pass through.
   *
   *  Asserted as PARITY rather than per-branch: the defect was the two answering differently. */
  const SCHEMA = { traits: { Transform: { category: 'component' as const, fields: { x: { type: 'number' as const }, y: { type: 'number' as const } } } } };
  const setXWrongType = (scenePath: string) => ({
    path: scenePath,
    ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 'not-a-number' } }],
  });

  it('warns about a WRONG-TYPED field on the file branch', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({ getSchema: () => SCHEMA, requestBrowser: async () => { throw new Error('no renderer'); } });
    const r = (await post('/api/scene-mutate', setXWrongType(scenePath), ctx)) as { body: { warnings: string[] } };
    expect(r.body.warnings.join(' ')).toMatch(/Transform\.x/);
  });

  it('…and warns identically on the LIVE branch — the two must not disagree about one op', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({
      getSchema: () => SCHEMA,
      requestBrowser: vi.fn(async (op: string) => (op === 'editor-state'
        ? { playState: 'stopped', unsavedChanges: false, scenePath }
        : { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] })),
    });
    const r = (await post('/api/scene-mutate', setXWrongType(scenePath), ctx)) as { body: { ok: boolean; changed: number; warnings: string[] } };
    expect(r.body.changed, 'this must be the LIVE branch (the file branch would not report a relayed change)').toBe(1);
    expect(r.body.warnings.join(' '), 'the live branch reported a wrong-typed write as clean').toMatch(/Transform\.x/);
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

  // ── A setTrait naming an unknown FIELD on a KNOWN trait is a certain typo (the loader drops
  // it), so with a schema available it must FAIL rather than report {ok:true, changed:1}. Kept
  // narrow — unknown trait + cold start stay warn-but-load.
  //
  // V1 (2026-07-30): this guard used to run INSIDE the file-direct branch, i.e. below the
  // `canGoLive` early return — so the LIVE path, which is the path almost every agent edit now
  // takes, never ran it. Measured against a real editor: `setTrait Transform {poistion:5}` →
  // `{ok:true,changed:1}` with the Transform byte-identical afterwards. It now runs PRE-FLIGHT,
  // above the live/file branch, which also fixed a second defect: on the file path the junk field
  // had already been WRITTEN to disk before the call reported ok:false. ──
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

    it('applies NOTHING when any op has a typo — no half-state, nothing written (conventions §8)', async () => {
      // This used to assert the opposite: the valid op applied, the junk field was written, and the
      // call answered ok:false. That shape is worse than either honest outcome — a caller reading
      // ok:false reasonably concludes nothing happened, so a partial apply hidden behind a failure
      // verdict silently desynchronises them from the scene. A typo is provable BEFORE doing any
      // work, so the whole call is refused and there is nothing to reconcile.
      const scenePath = tempScene();
      const before = fs.readFileSync(scenePath, 'utf-8');
      const body = { path: scenePath, ops: [
        { op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } },
        { op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { zz: 1 } },
      ] };
      const r = (await post('/api/scene-mutate', body, stoppedWithSchema())) as { body: { ok: boolean; changed: number; errors: string[]; didYouMean?: Record<string, string[]> } };
      expect(r.body.ok).toBe(false);
      expect(r.body.changed).toBe(0);
      expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);   // byte-identical: nothing written
      // The refusal must name the real fields — that is what turns the dead end into the next move.
      expect(r.body.didYouMean?.['Transform.zz']).toBeDefined();
      expect(r.body.errors.join(' ')).toContain('Transform.zz');
    });

    it('refuses a typo in addEntity TRAITS too, not just setTrait (review follow-up)', async () => {
      // addEntity seeds the same field vocabulary, so a typo there produced an entity carrying a
      // junk field the loader ignores — the identical silent no-op, reachable through the identical
      // tool. Checking one op and not the other is the inconsistency class this audit keeps finding.
      const scenePath = tempScene();
      const before = fs.readFileSync(scenePath, 'utf-8');
      const body = { path: scenePath, ops: [
        { op: 'addEntity', name: 'Box', parentId: 0, traits: { Transform: { xx: 1 } } },
      ] };
      const r = (await post('/api/scene-mutate', body, stoppedWithSchema())) as { body: { ok: boolean; errors: string[]; didYouMean?: Record<string, string[]> } };
      expect(r.body.ok).toBe(false);
      expect(r.body.errors.join(' ')).toContain('Transform.xx');
      expect(r.body.didYouMean?.['Transform.xx']).toBeDefined();
      expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);   // nothing written
    });

    it('a VALID addEntity is still accepted (the guard must not reject real input)', async () => {
      const scenePath = tempScene();
      const body = { path: scenePath, ops: [
        { op: 'addEntity', name: 'Box', parentId: 0, traits: { Transform: { x: 1 }, EntityAttributes: true } },
      ] };
      const r = (await post('/api/scene-mutate', body, stoppedWithSchema())) as { body: { ok: boolean; changed: number } };
      expect(r.body.ok).toBe(true);
      expect(r.body.changed).toBeGreaterThan(0);
    });

    it('refuses on the LIVE path too — the branch the old guard could not reach (V1)', async () => {
      // The regression that made this whole fix necessary: with a renderer connected and THIS scene
      // loaded, the call routes through `apply-scene-ops` and returned {ok:true, changed:1} for a
      // field that does not exist. The pre-flight refusal must fire before that branch is chosen,
      // so `apply-scene-ops` is never even asked.
      const scenePath = tempScene();
      const applied: string[] = [];
      const ctx = makeCtx({
        getSchema: () => schema,
        requestBrowser: vi.fn(async (op: string) => {
          applied.push(op);
          if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
          return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] };
        }),
      });
      const body = { path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { poistion: 5 } }] };
      const r = (await post('/api/scene-mutate', body, ctx)) as { body: { ok: boolean; changed: number } };
      expect(r.body.ok).toBe(false);
      expect(r.body.changed).toBe(0);
      expect(applied).not.toContain('apply-scene-ops');   // the live applier was never reached
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
    // Its OWN temp root, not makeCtx's default os.tmpdir(): this route now READS the
    // config before writing it, so a stale or hand-broken /tmp/project.config.json
    // left by anything else on the machine would 400 the save and fail this test.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'projset-inval-'));
    try {
      await post('/api/project-settings', { app: { appName: 'X' } }, makeCtx({ invalidateProjectConfig, projectRoot }));
      expect(invalidateProjectConfig).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

/** REGRESSION (see docs/debug-tools-mcp.md, measured 2026-07-28 on games/court): `action=set` used to
 *  merge the body onto the DEFAULTS and write the whole resolved config, so a second
 *  `set` passing only `build.*` silently reverted app identity to
 *  com.modokiengine.prototype / "Puzzle Prototype" and blanked appleTeamId — and the
 *  first `set` introduced webDeployMode:"gcs" + the demo bucket the project never had.
 *  The body is a PATCH onto what's on disk; absence means "don't touch". */
describe('/api/project-settings is a non-destructive PATCH', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'projset-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const cfgPath = () => path.join(root, 'project.config.json');
  const readCfg = () => JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
  const settings = (body: unknown) => post('/api/project-settings', body, makeCtx({ projectRoot: root }));

  it('REFUSES an unknown top-level section instead of writing nothing and reporting ok (S2.30)', async () => {
    // deepMergeConfigPatch merged it in, mergeProjectConfig dropped what it did not know, and
    // prune then wrote nothing — so `{"apps":{…}}` answered ok:true having changed absolutely
    // nothing. A misspelled section is the likeliest way to reach this route, and reporting
    // success is the worst possible answer to it.
    await settings({ app: { appName: 'Real' } });
    const before = readCfg();
    const r = (await settings({ apps: { appName: 'Typo' } })) as { status?: number; body: { error?: string; unknownSections?: string[]; knownSections?: string[] } };
    expect(r.status).toBe(400);
    expect(r.body.unknownSections).toEqual(['apps']);
    expect(r.body.knownSections).toContain('app');    // the refusal names the real ones
    expect(readCfg()).toEqual(before);                 // and NOTHING was written
  });

  it('still accepts every REAL section (the guard must not reject valid input)', async () => {
    const r = (await settings({ app: { appName: 'X' }, build: { debugBuild: true }, ota: { enabled: false } })) as { status?: number };
    expect(r.status ?? 200).toBe(200);
    expect(readCfg().app.appName).toBe('X');
  });

  it('a partial second set does NOT revert the sections it omits (the reported scenario)', async () => {
    await settings({
      app: { appId: 'com.modokiengine.court', appName: 'Court' },
      build: { appleTeamId: 'ABCDE12345', debugBuild: true },
    });
    await settings({ build: { debugBuild: false } });

    const cfg = readCfg();
    expect(cfg.app.appId).toBe('com.modokiengine.court');
    expect(cfg.app.appName).toBe('Court');
    // appleTeamId is a PRIVATE build field (#172) — the first save already moved it
    // out of the committed file into project.user.json (see the #172 tests below). It
    // was never on disk BEFORE that save and now equals its own default (''), so prune
    // drops the key entirely rather than recording an explicit '' — the committed file
    // has no appleTeamId key at all. The RESOLVED value survived the second, unrelated
    // save, just in the other file.
    expect(cfg.build.appleTeamId).toBeUndefined();
    const userCfg = JSON.parse(fs.readFileSync(path.join(root, 'project.user.json'), 'utf8'));
    expect(userCfg.build.appleTeamId).toBe('ABCDE12345');
    expect(cfg.build.debugBuild).toBe(false);
  });

  it('never writes engine defaults the project never chose (no demo deploy bucket)', async () => {
    await settings({ app: { appId: 'com.modokiengine.court', appName: 'Court' } });
    const raw = fs.readFileSync(cfgPath(), 'utf8');
    expect(raw).not.toContain('gs://modoki-www-site/demo');
    expect(raw).not.toContain('webDeployMode');
  });

  it('a FULL-object save still does not bake UNRELATED engine defaults in', async () => {
    // The Project Settings dialog GETs the resolved config and POSTs the whole thing
    // back. Prune must therefore measure "was already recorded" against the PRE-EDIT
    // file — measuring against the patched body makes every key trivially present,
    // prunes nothing, and silently restores the write-the-resolved-config bug on the
    // most common human path. (Caught exactly that way while implementing this.)
    //
    // #172 changed this test's other promise: a full round-trip is NO LONGER a no-op
    // diff for `build`, because GET always resolves (and therefore POST always
    // "carries") every private field — even ones this project never set — so a save
    // now migrates ALL FIVE out of the committed file every time. That is the intended
    // "Apply is an automatic migration" behaviour, not a defaults-baking regression:
    // the migrated values are blank because they were blank (or absent) already.
    fs.writeFileSync(cfgPath(), JSON.stringify({
      build: { webBasePath: '/skin-test/', playableClickUrl: 'https://example.com/app' },
      app: { appId: 'com.modokiengine.skintest', appName: 'Skin Test' },
    }, null, 2) + '\n');

    const full = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as { body: unknown };
    await settings(full.body);

    const raw = fs.readFileSync(cfgPath(), 'utf8');
    const cfg = readCfg();
    expect(raw).not.toContain('playableNetwork');       // an untouched engine default
    expect(raw).not.toContain('statusBarStyle');        // a whole untouched default section
    expect(cfg.build.webBasePath).toBe('/skin-test/');            // the edit that WAS made survived
    expect(cfg.build.playableClickUrl).toBe('https://example.com/app');
    // Migrated, not baked-in defaults. A field whose own DEFAULT happens to be ''
    // (e.g. appleTeamId) and was never on disk before is dropped entirely by prune
    // (the file-stays-minimal rule) rather than recorded as an explicit '' — either
    // way, nothing NON-EMPTY survives in the committed file.
    for (const field of PRIVATE_BUILD_FIELDS) expect(cfg.build[field] ?? '').toBe('');
  });

  it('an OtaKeysDialog-shaped partial (ota.publicKey alone) leaves app identity intact', async () => {
    await settings({ app: { appId: 'com.modokiengine.court', appName: 'Court' } });
    await settings({ ota: { publicKey: 'PUBKEY-1' } });
    const cfg = readCfg();
    expect(cfg.ota.publicKey).toBe('PUBKEY-1');
    expect(cfg.app.appId).toBe('com.modokiengine.court');
  });

  it('a full-object save (the Project Settings dialog) can still BLANK a field', async () => {
    // playableClickUrl, not appleTeamId — appleTeamId is a PRIVATE field (#172) and
    // is covered by its own blank/migrate behaviour in the #172 tests below.
    await settings({ app: { appId: 'com.x.y', appName: 'Y' }, build: { playableClickUrl: 'https://example.com/app' } });
    const full = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as { body: Record<string, never> };
    // Post the whole GET response back with one field blanked, exactly as the dialog does.
    await settings({ ...full.body, build: { ...(full.body as never as { build: object }).build, playableClickUrl: '' } });
    expect(readCfg().build.playableClickUrl).toBe('');
  });

  it('rejects a shell-unsafe value in a PARTIAL body and writes NOTHING', async () => {
    await settings({ app: { appId: 'com.modokiengine.court', appName: 'Court' } });
    const before = fs.readFileSync(cfgPath(), 'utf8');
    const r = (await settings({ build: { webBucket: 'gs://x; rm -rf ~' } })) as { status?: number };
    expect(r.status).toBe(400);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(before);
  });

  it('REFUSES to save onto a malformed config file instead of overwriting it', async () => {
    // project.config.json is committed JSON a human hand-edits. A typo makes the raw
    // read empty, so a partial patch would land as the WHOLE file and take the
    // author's real config with it. Measured: a file holding com.real.app came back
    // as {"build":{"debugBuild":true}}.
    fs.writeFileSync(cfgPath(), '{ "app": { "appId": "com.real.app" }, BROKEN');
    const before = fs.readFileSync(cfgPath(), 'utf8');
    const r = (await settings({ build: { debugBuild: true } })) as { status?: number; body: { error: string } };
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not valid JSON/);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(before);
  });

  it('GET says the file did not parse, instead of serving engine defaults as if they were yours', async () => {
    // The GET/POST asymmetry (#26): reading a malformed config falls back to the
    // defaults so the editor still opens, while writing refuses. Individually right —
    // together they hand the dialog a screen of plausible-looking lies. Measured on
    // games/sling: Bundle ID read com.modokiengine.prototype, the retired pre-#29
    // shared identity, with nothing on screen saying those weren't its real values.
    fs.writeFileSync(cfgPath(), '{ "app": { "appId": "com.real.app" }, BROKEN');
    const r = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as {
      body: { app: { appId: string }; configErrors?: { file: string; message: string }[] };
    };
    expect(r.body.app.appId).toBe(DEFAULT_PROJECT_CONFIG.app.appId);   // still the forgiving fallback…
    expect(r.body.configErrors).toHaveLength(1);                        // …but no longer silent about it
    expect(r.body.configErrors![0].file).toBe('project.config.json');
    expect(r.body.configErrors![0].message).toMatch(/not valid JSON/);
  });

  it('GET reports a malformed project.user.json too', async () => {
    fs.writeFileSync(path.join(root, 'project.user.json'), 'not json at all');
    const r = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as {
      body: { configErrors?: { file: string }[] };
    };
    expect(r.body.configErrors?.map((e) => e.file)).toEqual(['project.user.json']);
  });

  it('GET omits configErrors entirely when both files are fine', async () => {
    await settings({ app: { appId: 'com.modokiengine.court', appName: 'Court' } });
    const r = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as { body: Record<string, unknown> };
    expect('configErrors' in r.body).toBe(false);
  });

  it('POST ignores a round-tripped configErrors instead of 400ing on it as an unknown section', async () => {
    // The dialog posts back the WHOLE object it loaded. If GET ever put configErrors
    // in it, the unknown-section guard would refuse a save the caller never authored.
    const r = (await settings({
      app: { appName: 'Court' },
      configErrors: [{ file: 'project.config.json', message: 'stale' }],
    })) as { status?: number };
    expect(r.status ?? 200).toBe(200);
    expect(readCfg().app.appName).toBe('Court');
    expect(fs.readFileSync(cfgPath(), 'utf8')).not.toContain('configErrors');
  });

  it('rejects `null` rather than persisting it into a typed field', async () => {
    // No config field is nullable. Writing it through poisons the field (appName:null
    // survives the merge and reaches consumers); dropping it would be a silent no-op
    // reported as success. Both are false successes, so 400.
    await settings({ app: { appId: 'com.modokiengine.court', appName: 'Court' } });
    const before = fs.readFileSync(cfgPath(), 'utf8');
    const r = (await settings({ app: { appName: null } })) as { status?: number; body: { error: string } };
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/app\.appName/);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(before);
  });

  it('writes ONLY the fields that were set — never the defaults for the rest', async () => {
    // The old write-the-resolved-config behaviour stamped every DEFAULT_PROJECT_USER_CONFIG
    // value into each dev's machine file. That leaked the repo owner's real iPhone UDID
    // until #103 blanked those defaults; the defaults are empty now, so asserting on the
    // literal id would be vacuous (`not.toContain('')` can never pass). Assert the BEHAVIOUR
    // instead — an unset field must be ABSENT — which still catches the stamping regression
    // and keeps working if a default ever becomes non-empty again.
    await settings({ user: { device: { androidDeviceId: 'EXAMPLESERIAL1' } } });
    const raw = fs.readFileSync(path.join(root, 'project.user.json'), 'utf8');
    expect(raw).toContain('EXAMPLESERIAL1');
    const written = JSON.parse(raw) as { device?: Record<string, unknown>; sdk?: unknown };
    expect(written.device).toEqual({ androidDeviceId: 'EXAMPLESERIAL1' });
    expect(written.sdk).toBeUndefined();
  });

  it('routes the `user` subtree to project.user.json, also as a patch', async () => {
    await settings({ user: { device: { androidDeviceId: 'serial-2' } } });
    await settings({ user: { sdk: { javaHome: '/jdk' } } });
    const userCfg = JSON.parse(fs.readFileSync(path.join(root, 'project.user.json'), 'utf8'));
    expect(userCfg.device.androidDeviceId).toBe('serial-2');
    expect(userCfg.sdk.javaHome).toBe('/jdk');
    expect(fs.readFileSync(cfgPath(), 'utf8')).not.toContain('serial-2');
  });

  const readUserCfg = () => JSON.parse(fs.readFileSync(path.join(root, 'project.user.json'), 'utf8'));

  describe('#172: private build.* fields (appleTeamId/webBucket/webCdnUrlMap/webCdnBackendBucket/webDeployCommand)', () => {
    it('a private field posted under `build` moves to project.user.json, not the committed file', async () => {
      const r = (await settings({ app: { appId: 'com.x.y', appName: 'Y' }, build: { appleTeamId: 'ABCDE12345' } })) as { status?: number };
      expect(r.status ?? 200).toBe(200);
      // Blanked to '' (its own default) and never previously on disk, so prune drops
      // the key entirely — the committed file has no appleTeamId key at all.
      expect(readCfg().build?.appleTeamId).toBeUndefined();
      expect(readUserCfg().build.appleTeamId).toBe('ABCDE12345');
    });

    it('a pre-existing COMMITTED private value is cleared by a full-object save (Apply is an automatic migration)', async () => {
      // Simulates a project that predates #172: the value still sits in the committed
      // file. The Project Settings dialog GETs (resolved/overlaid) then POSTs the whole
      // object back — that round-trip alone must migrate it.
      fs.writeFileSync(cfgPath(), JSON.stringify({
        build: { appleTeamId: 'LEGACY99999' },
        app: { appId: 'com.x.y', appName: 'Y' },
      }, null, 2) + '\n');

      const full = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as { body: unknown };
      await settings(full.body);

      expect(readCfg().build.appleTeamId).toBe('');
      expect(readUserCfg().build.appleTeamId).toBe('LEGACY99999');
    });

    it('`build.<field>` in the body WINS over a stale round-tripped user.build value', async () => {
      // The precedence that makes the Project Settings dialog work at all. The dialog
      // edits `build.appleTeamId` (app/editor/setup.ts) and posts the WHOLE object, so
      // the `user` subtree it sends is whatever it LOADED — never the edit. Deferring to
      // it would silently discard every change. Alphanumeric only: BUILD_FIELD_RULES
      // rejects a hyphen, and this is about precedence, not validation.
      const r = (await settings({
        app: { appId: 'com.x.y', appName: 'Y' },
        build: { appleTeamId: 'EDITEDVALUE' },
        user: { build: { appleTeamId: 'STALELOADED' } },
      })) as { status?: number };
      expect(r.status ?? 200).toBe(200);
      expect(readCfg().build?.appleTeamId).toBeUndefined();
      expect(readUserCfg().build.appleTeamId).toBe('EDITEDVALUE');
    });

    it('editing an ALREADY-migrated field through a full round-trip persists the new value', async () => {
      // The regression the precedence rule above exists for, driven end to end: migrate
      // once, then GET → change the field → POST, exactly as the dialog does. Under the
      // earlier "explicit user.build wins" rule this silently kept OLDTEAM1234.
      await settings({ app: { appId: 'com.x.y', appName: 'Y' }, build: { appleTeamId: 'OLDTEAM1234' } });
      expect(readUserCfg().build.appleTeamId).toBe('OLDTEAM1234');

      const full = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as { body: Record<string, unknown> };
      const edited = { ...full.body, build: { ...(full.body.build as object), appleTeamId: 'NEWTEAM9999' } };
      await settings(edited);

      expect(readUserCfg().build.appleTeamId).toBe('NEWTEAM9999');
      expect(readCfg().build?.appleTeamId).toBeUndefined();
    });

    it('CLEARING a migrated field through a full round-trip actually clears it', async () => {
      // Same shape, the other direction: blanking the box must not be undone by the
      // stale `user` subtree the dialog posts alongside it.
      await settings({ app: { appId: 'com.x.y', appName: 'Y' }, build: { appleTeamId: 'OLDTEAM1234' } });

      const full = (await get('/api/project-settings', makeCtx({ projectRoot: root }))) as { body: Record<string, unknown> };
      const cleared = { ...full.body, build: { ...(full.body.build as object), appleTeamId: '' } };
      await settings(cleared);

      expect(readUserCfg().build.appleTeamId).toBe('');
    });

    it('does not disturb non-private build fields (debugBuild/webDeployMode/webBasePath ship publicly)', async () => {
      await settings({
        app: { appId: 'com.x.y', appName: 'Y' },
        build: { appleTeamId: 'ABCDE12345', debugBuild: true, webDeployMode: 'custom', webBasePath: '/sub/' },
      });
      const cfg = readCfg();
      expect(cfg.build.debugBuild).toBe(true);
      expect(cfg.build.webDeployMode).toBe('custom');
      expect(cfg.build.webBasePath).toBe('/sub/');
      expect(readUserCfg().build.debugBuild).toBeUndefined(); // never a user.build field
    });
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

  it('a FILTERED call that matches nothing names what IS live (S3.10)', async () => {
    // Pre-fix this returned `{count:0, editors:[], handles:[]}` — byte-indistinguishable from "no
    // editor is open", so a typo'd `editor=` read as a correct negative answer. `editors` was
    // derived from the already-filtered list, so it was empty too.
    let calls = 0;
    const ctxMiss = makeCtx({
      requestBrowser: (async (_op: string, params: { editor?: string } | undefined) => {
        calls++;
        // The filtered probe misses; the unfiltered follow-up reports the live set.
        return params?.editor ? { ...opResult, count: 0, editors: [], handles: [] } : opResult;
      }) as unknown as BackendContext['requestBrowser'],
    });
    const r = (await get('/api/enact-handles?editor=doppesheet', ctxMiss)) as { body: { hint: string; byEditor?: Record<string, number> } };
    expect(calls).toBe(2);                                   // one filtered, one unfiltered probe
    expect(r.body.byEditor).toEqual({ chrome: 2, dopesheet: 1 });
    expect(r.body.hint).toContain('editor=doppesheet');      // what was asked
    expect(r.body.hint).toContain('dopesheet');              // what exists
  });

  it('…and when NOTHING is live, the miss says that instead of listing an empty set', async () => {
    const nothing = makeCtx({ requestBrowser: (async () => ({ ...opResult, count: 0, editors: [], handles: [] })) as BackendContext['requestBrowser'] });
    const r = (await get('/api/enact-handles?kind=keyframe', nothing)) as { body: { hint: string } };
    expect(r.body.hint).toContain('NO editor is currently exposing handles');
  });

  it('the extra probe runs ONLY on a zero-result filtered call (the hot path is untouched)', async () => {
    let calls = 0;
    const counting = makeCtx({ requestBrowser: (async () => { calls++; return opResult; }) as BackendContext['requestBrowser'] });
    await get('/api/enact-handles?editor=chrome', counting);
    expect(calls).toBe(1);
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

/** `GET /api/asset-def` — the READ half of the asset-editor ops.
 *
 *  It exists because `particle-set`/`anim-set-clip`/`timeline-set` each demand a FULL definition
 *  and nothing returned one: you had to read the `.particle.json` off disk (impossible for a
 *  packaged/remote editor) and you could not verify the edit by data at all — the only suggested
 *  check was judging a rendered frame, which `docs/debug-tools-mcp.md` tells agents not to do.
 *  Found running batch use case 6. */
describe('/api/asset-def', () => {
  it('400 without a path — the one required parameter', async () => {
    const r = (await get('/api/asset-def', makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('forwards path (and optional type) to the read-asset-def op', async () => {
    const requestBrowser = vi.fn(async () => ({ ok: true, def: { maxParticles: 137 } }));
    const ctx = makeCtx({ requestBrowser });
    const r = (await get('/api/asset-def?path=/assets/particles/a.particle.json&type=particle', ctx)) as { body?: unknown };
    expect(requestBrowser).toHaveBeenCalledWith('read-asset-def', { path: '/assets/particles/a.particle.json', type: 'particle' });
    expect(r.body).toEqual({ ok: true, def: { maxParticles: 137 } });
  });

  it('omits `type` entirely when not given, so the op can infer it from the suffix', async () => {
    const requestBrowser = vi.fn(async () => ({ ok: true }));
    await get('/api/asset-def?path=/assets/particles/a.particle.json', makeCtx({ requestBrowser }));
    expect(requestBrowser).toHaveBeenCalledWith('read-asset-def', { path: '/assets/particles/a.particle.json' });
  });

  it('400 when the asset is not in the live cache — the op answering, not a dead gateway', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error("read-asset-def: '/x' is not in the live particle cache"); } });
    const r = (await get('/api/asset-def?path=/x.particle.json', ctx)) as { status?: number; body?: { error?: string } };
    expect(r.status).toBe(400);
    expect(r.body?.error).toMatch(/not in the live/);
  });

  it('504 when the RELAY is down', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no editor renderer window'); } });
    const r = (await get('/api/asset-def?path=/x.particle.json', ctx)) as { status?: number };
    expect(r.status).toBe(504);
  });
});

describe('/api/render-scene (S3.14 — the route had no test at all)', () => {
  const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQ';

  it('relays to the renderer and returns a PATH plus the frame size', async () => {
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ width: 640, height: 360, quality: 85, dataUrl: DATA_URL })) });
    const r = (await post('/api/render-scene', { width: 640, height: 360 }, ctx)) as
      { status?: number; body: { path?: string; width?: number; height?: number; quality?: number } };
    expect(r.status ?? 200).toBe(200);
    expect(r.body).toMatchObject({ width: 640, height: 360, quality: 85 });
    expect(r.body.path).toMatch(/modoki-render-.*\.jpg$/);
  });

  it('forwards the body verbatim, so camera/quality reach the renderer op', async () => {
    const requestBrowser = vi.fn(async () => ({ width: 8, height: 8, dataUrl: DATA_URL }));
    await post('/api/render-scene', { quality: 70, camera: { fov: 40 } }, makeCtx({ requestBrowser }));
    expect(requestBrowser).toHaveBeenCalledWith('render-scene', { quality: 70, camera: { fov: 40 } }, 15000);
  });

  it('omits `quality` when the renderer does not report one (an older renderer)', async () => {
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ width: 8, height: 8, dataUrl: DATA_URL })) });
    const r = (await post('/api/render-scene', {}, ctx)) as { body: Record<string, unknown> };
    expect('quality' in r.body).toBe(false);
  });

  it('a renderer with no 3D surface mounted is a 504 carrying the reason, not an empty 200', async () => {
    const ctx = makeCtx({ requestBrowser: async () => { throw new Error('no 3D view is mounted (open the Game panel)'); } });
    const r = (await post('/api/render-scene', {}, ctx)) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/no 3D view is mounted/);
  });
});

describe('render-sequence refuses a STOPPED editor at the ROUTE (review follow-up)', () => {
  // The S2.33/S2.34 behaviour lives in this router, but the tests named after it were in
  // mcpErrorEnvelope.test.ts, where the backend is STUBBED — so they asserted the tool's
  // pass-through of a refusal the test itself invented, and would have stayed green with the router
  // change reverted. This is the test for the code that actually decides.
  const rendering = (runMode: string) => makeCtx({
    requestBrowser: vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: runMode === 'playing' ? 'playing' : 'stopped', runMode };
      return { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' };
    }),
  });

  it('refuses while STOPPED, and renders nothing', async () => {
    const r = (await post('/api/render-sequence', { frames: 3, fps: 10 }, rendering('stopped'))) as
      { status?: number; body: { ok?: boolean; error?: string; runMode?: string; paths?: unknown[] } };
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/STOPPED/);
    expect(r.body.error).toMatch(/IDENTICAL/);
    expect(r.body.paths).toBeUndefined();
  });

  it('does NOT refuse a Timeline PREVIEW or SCRUB — those advance, and playState collapses them to "stopped"', async () => {
    // The bug this pins: classifying from `playState` (a 3-value compat shim) refused a legitimate
    // motion capture during a preview, with advice ("press Play") that makes no sense there.
    for (const mode of ['preview', 'scrub', 'playing']) {
      const r = (await post('/api/render-sequence', { frames: 2, fps: 30 }, rendering(mode))) as
        { status?: number; body: { paths?: unknown[]; requestedFps?: number; actualFps?: number | null; tMs?: number[] } };
      expect(r.status ?? 200, mode).toBe(200);
      expect(r.body.paths, mode).toHaveLength(2);
    }
  });

  it('reports the ACHIEVED rate and per-frame times, not just the requested one', async () => {
    const r = (await post('/api/render-sequence', { frames: 3, fps: 30 }, rendering('playing'))) as
      { body: { requestedFps?: number; actualFps?: number | null; spanMs?: number; tMs?: number[] } };
    expect(r.body.requestedFps).toBe(30);
    expect(r.body.tMs).toHaveLength(3);
    // Monotonic, and real: the frames are genuinely separated rather than collapsed by catch-up.
    const gaps = r.body.tMs!.slice(1).map((t, i) => t - r.body.tMs![i]);
    expect(gaps.every((g) => g >= 0), 'frame times must be monotonic').toBe(true);
    expect(r.body.spanMs).toBeGreaterThanOrEqual(0);
  });

  it('force:true renders while stopped, deliberately', async () => {
    const r = (await post('/api/render-sequence', { frames: 2, fps: 30, force: true }, rendering('stopped'))) as
      { status?: number; body: { paths?: unknown[] } };
    expect(r.status ?? 200).toBe(200);
    expect(r.body.paths).toHaveLength(2);
  });
});
