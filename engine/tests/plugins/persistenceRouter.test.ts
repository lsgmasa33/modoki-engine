/** /api/persistence, `persistenceMode` on /api/editor-state, and `saved` on the write routes.
 *
 *  **Persistence is MANUAL-ONLY** (owner decision 2026-07-30). The old `auto` mode — in which a
 *  live mutation ALSO saved to disk — is gone, so a mutating tool now behaves exactly one way and
 *  its effect never depends on session state set in some earlier turn. These tests pin that:
 *  a live apply does NOT save, `mode` cannot be set, and the one place a write still happens
 *  (file-direct, where there is no live world to hold the edit) is unchanged. */

import { describe, it, expect, vi, afterAll } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  handleBackendRequest, type BackendContext, type Manifest, getPersistenceMode,
} from '../../plugins/backend/editorBackendRouter';

/** A PRIVATE temp dir per run, removed afterwards.
 *
 *  These tests used to name their scratch files `<os.tmpdir()>/modoki-…-${process.pid}-${seq}` and
 *  never delete them. Two consequences, and the second is why this changed:
 *
 *   • the LEAK — 1536 stale files had accumulated in this machine's temp dir; and
 *   • a real FLAKE, because `pid` is reused by the OS. `/api/create-asset` refuses with a 409 when
 *     the destination already exists (correctly — it must not clobber), so a run that drew a pid
 *     whose leftovers were still on disk failed `create-asset: saved:true on a successful scaffold`
 *     with nothing in the test itself having changed. It failed once in ~5 full runs here.
 *
 *  `mkdtempSync` makes the name unique BY CONSTRUCTION rather than by hoping pid+seq is, and the
 *  teardown means a name can never be seen twice. Note the audit's own lesson: a test whose fixture
 *  outlives the run is a test that can be poisoned by its own history. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-persistence-'));
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

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
/** Vite's `/@fs/<abs>` form — how the renderer reports the active scene. The identity
 *  resolveAssetPath/absToAssetUrl in makeCtx means normalization must still reduce this to the
 *  same value as the plain path, which is exactly what the fix does. */
const toFsUrl = (abs: string) => path.posix.join('/@fs/', abs.replace(/\\/g, '/'));

const get = (urlPath: string, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(), body: undefined });

describe('/api/persistence — manual-only', () => {
  it('reports manual, with no way to change it', async () => {
    expect(getPersistenceMode()).toBe('manual');
    const r = (await post('/api/persistence', {}, makeCtx())) as { body: { mode: string } };
    expect(r.body.mode).toBe('manual');
  });

  it("REFUSES mode:'auto' with a 400 instead of ignoring it", async () => {
    // Silently accepting it would let a caller believe auto-save was back on and then lose work
    // when nothing saved. The refusal has to name the replacement.
    const r = (await post('/api/persistence', { mode: 'auto' }, makeCtx())) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('manual-only');
    expect(r.body.error).toContain('modoki_save_all');
  });

  it("accepts an explicit mode:'manual' as a no-op (a caller stating the status quo is not an error)", async () => {
    const r = (await post('/api/persistence', { mode: 'manual' }, makeCtx())) as { status?: number; body: { mode: string } };
    expect(r.status).toBeUndefined();
    expect(r.body.mode).toBe('manual');
  });

  it('rejects any other value too', async () => {
    const r = (await post('/api/persistence', { mode: 'bogus' }, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('reports the renderer unsavedChanges when an editor is connected', async () => {
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ unsavedChanges: true })) });
    const r = (await post('/api/persistence', {}, ctx)) as { body: { unsavedChanges: boolean | null } };
    expect(r.body.unsavedChanges).toBe(true);
  });

  it('unsavedChanges stays null (not false) when the relay throws — no editor is not "nothing pending"', async () => {
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => { throw new Error('no renderer'); }) });
    const r = (await post('/api/persistence', {}, ctx)) as { body: { unsavedChanges: boolean | null } };
    expect(r.body.unsavedChanges).toBeNull();
  });
});

describe('/api/editor-state reports persistenceMode alongside the renderer state', () => {
  it('merges persistenceMode into whatever the renderer returns', async () => {
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ scenePath: '/x.json', unsavedChanges: false })) });
    const r = (await get('/api/editor-state', ctx)) as { body: { scenePath?: string; persistenceMode?: string } };
    expect(r.body.scenePath).toBe('/x.json');
    expect(r.body.persistenceMode).toBe('manual');
  });
});

describe('Phase 1: file-direct routes report `saved` (additive, no behaviour change)', () => {
  let seq = 0;
  function tempScene(): string {
    const p = path.join(TMP, `saved-${seq++}.json`);
    fs.writeFileSync(p, JSON.stringify({
      entities: [{ id: 1, name: 'Box', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Box', guid: 'g-box' } } }],
    }));
    return p;
  }

  it('scene-mutate: saved:true when something changed (the file WAS written)', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped' })) });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } }],
    }, ctx)) as { body: { ok: boolean; changed: number; saved?: boolean } };
    expect(r.body.changed).toBe(1);
    expect(r.body.saved).toBe(true);
  });

  it('scene-mutate: saved:false when nothing changed (a bad ref, nothing written)', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ playState: 'stopped' })) });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 999 }, trait: 'Transform', fields: { x: 9 } }],
    }, ctx)) as { body: { changed: number; saved?: boolean } };
    expect(r.body.changed).toBe(0);
    expect(r.body.saved).toBe(false);
  });

  it('asset-write: saved:true on a successful write', async () => {
    const assetPath = path.join(TMP, `asset-${seq++}.particle.json`);
    const r = (await post('/api/asset-write', {
      path: assetPath, type: 'particle', data: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
    }, makeCtx())) as { body: { ok: boolean; saved?: boolean } };
    expect(r.body.ok).toBe(true);
    expect(r.body.saved).toBe(true);
  });

  it('create-asset: saved:true on a successful scaffold', async () => {
    const assetPath = path.join(TMP, `create-${seq++}.particle.json`);
    const r = (await post('/api/create-asset', { type: 'particle', path: assetPath }, makeCtx())) as { body: { ok: boolean; saved?: boolean } };
    expect(r.body.ok).toBe(true);
    expect(r.body.saved).toBe(true);
  });
});

describe('Phase 2b: scene-mutate goes LIVE when a renderer is connected on the matching scene', () => {
  let seq = 0;
  function tempScene(): string {
    const p = path.join(TMP, `live-mutate-${seq++}.json`);
    fs.writeFileSync(p, JSON.stringify({
      entities: [{ id: 1, name: 'Box', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Box', guid: 'g-box' } } }],
    }));
    return p;
  }
  const setX = (scenePath: string) => ({ path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 5 } }] });

  it('goes live, does NOT write the file, and does NOT save — manual-only', async () => {
    // The core of removing `auto`: a live apply touches the live world and NOTHING else. It used
    // to fire save-all here, so `saved` was true and the scene reached disk on every mutate.
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf-8');
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] };
      throw new Error(`unexpected op ${op} — a live apply must not save`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { body: { ok: boolean; changed: number; saved?: boolean; mode?: string; hint?: string } };
    expect(r.body.ok).toBe(true);
    expect(r.body.changed).toBe(1);
    expect(r.body.saved).toBe(false);
    expect(r.body.mode).toBe('manual');
    // The response must SAY how to persist — `saved:false` alone reads like a failure.
    expect(r.body.hint).toContain('modoki_save_all');
    expect(requestBrowser).not.toHaveBeenCalledWith('save-all', expect.anything(), expect.any(Number));
    expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);
  });

  it('goes live when the renderer reports the SAME scene as a /@fs URL — normalized comparison', async () => {
    // The regression this exists for: the check was `st.scenePath === scenePath`, a raw string
    // compare between the renderer's Vite `/@fs/<abs>` URL and the ASSET-ROOT path this route
    // requires. No value satisfied both — `resolveAssetPath` 403s the /@fs form before it gets
    // here, and an asset-root path never equalled it — so the live path was UNREACHABLE and every
    // call silently wrote the file instead. Nothing failed loudly, which is why it survived.
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf-8');
    const requestBrowser = vi.fn(async (op: string) => {
      // The renderer's form: /@fs/<abs>. Different string, same file.
      if (op === 'editor-state') return { playState: 'stopped', scenePath: toFsUrl(scenePath), unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] };
      throw new Error(`unexpected op ${op}`);
    });
    const r = (await post('/api/scene-mutate', setX(scenePath), makeCtx({ requestBrowser }))) as { body: { changed: number; saved?: boolean } };
    expect(requestBrowser).toHaveBeenCalledWith('apply-scene-ops', expect.anything(), expect.any(Number));
    expect(r.body.saved).toBe(false);          // live, so nothing written
    expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);
  });

  it('omits the save hint when nothing changed (no pending work to persist)', async () => {
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 0, errors: [], warnings: [], unresolved: [] };
      throw new Error(`unexpected op ${op}`);
    });
    const r = (await post('/api/scene-mutate', setX(scenePath), makeCtx({ requestBrowser }))) as { body: { hint?: string } };
    expect(r.body.hint).toBeUndefined();
  });

  // ── S3.12 parity: `created` must come back from BOTH branches ────────────────────────────────
  //
  // S3.12 gave `addEntity` a `created:[{op,id,guid,name}]` receipt so an agent never has to re-find
  // its own new entity by name — which this surface refuses outright when the name is ambiguous, so
  // "create then edit" could dead-end on the second step. It landed in `applyOps` (file) AND
  // `applySceneOpsLive` (live), and both were unit-tested… but the ROUTE's live branch never
  // forwarded it, so the receipt existed on the fallback path and was missing on the path almost
  // every agent edit takes. Measured against a real editor on 2026-07-30 (file → `created`, live →
  // absent).
  //
  // The general lesson is the audit's own #4, recurring: a capability with two backends chosen by
  // ambient state gets "verified live" against whichever branch the ambient state happened to pick.
  // So this asserts the CONTRACT on both branches in one place, rather than each applier in
  // isolation — that is what the isolated unit tests already did while the route dropped the field.
  const addBox = (scenePath: string) => ({
    path: scenePath,
    ops: [{ op: 'addEntity', name: 'Made', traits: { Transform: { x: 1 } } }],
  });
  const CREATED_KEYS = ['guid', 'id', 'name', 'op'];

  it('LIVE branch forwards `created` from apply-scene-ops', async () => {
    const scenePath = tempScene();
    const created = [{ op: 0, id: 42, guid: 'g-made', name: 'Made' }];
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [], created };
      throw new Error(`unexpected op ${op}`);
    });
    const r = (await post('/api/scene-mutate', addBox(scenePath), makeCtx({ requestBrowser }))) as {
      body: { created?: Array<Record<string, unknown>> };
    };
    expect(r.body.created, 'the live branch dropped the created receipt the op returned').toEqual(created);
  });

  it('…and omits it (absent, not []) when the live apply created nothing', async () => {
    // Same rule as `applyOps`: an empty array would read as "the add produced nothing" rather than
    // "there were no adds in this batch".
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [], created: [] };
      throw new Error(`unexpected op ${op}`);
    });
    const r = (await post('/api/scene-mutate', setX(scenePath), makeCtx({ requestBrowser }))) as { body: Record<string, unknown> };
    expect('created' in r.body).toBe(false);
  });

  it('BOTH branches report the same created SHAPE for the same addEntity op', async () => {
    // The parity check proper. The live side is stubbed at the relay (the defect was the route, not
    // the applier); the file side runs the real `applyOps`, so its receipt is genuine — including a
    // freshly minted guid, which is the field an agent actually needs.
    const liveScene = tempScene();
    const liveBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: liveScene, unsavedChanges: false };
      if (op === 'apply-scene-ops') {
        return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [], created: [{ op: 0, id: 7, guid: 'g-live', name: 'Made' }] };
      }
      throw new Error(`unexpected op ${op}`);
    });
    const liveBody = ((await post('/api/scene-mutate', addBox(liveScene), makeCtx({ requestBrowser: liveBrowser }))) as {
      body: { created?: Array<Record<string, unknown>> };
    }).body;

    const fileScene = tempScene();
    const fileBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: '/some/other/scene.json', unsavedChanges: false };
      throw new Error(`unexpected op ${op} — should have stayed file-direct`);
    });
    const fileBody = ((await post('/api/scene-mutate', addBox(fileScene), makeCtx({ requestBrowser: fileBrowser }))) as {
      body: { created?: Array<Record<string, unknown>> };
    }).body;

    expect(fileBody.created, 'the file branch lost its created receipt').toHaveLength(1);
    expect(liveBody.created, 'the live branch lost its created receipt').toHaveLength(1);
    expect(Object.keys(fileBody.created![0]).sort()).toEqual(CREATED_KEYS);
    expect(Object.keys(liveBody.created![0]).sort()).toEqual(CREATED_KEYS);
    // The file branch's guid is real (minted by applyOps), not an empty string — the receipt is
    // only useful if the agent can address the entity with it.
    expect(String(fileBody.created![0].guid).length).toBeGreaterThan(0);
  });

  it('does NOT go live when the requested scene is not the one currently loaded — stays file-direct', async () => {
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf-8');
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: '/some/other/scene.json', unsavedChanges: false };
      throw new Error(`unexpected op ${op} — should have stayed file-direct`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { body: { changed: number; saved?: boolean } };
    expect(r.body.changed).toBe(1);
    expect(r.body.saved).toBe(true); // file-direct path wrote it directly
    expect(fs.readFileSync(scenePath, 'utf-8')).not.toBe(before); // the FILE changed this time
  });

  it('setBaseScene forces file-direct even when the scene matches the live one (no live equivalent)', async () => {
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      throw new Error(`unexpected op ${op} — setBaseScene must stay file-direct`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setBaseScene', baseScene: 'some-guid' }],
    }, ctx)) as { body: { changed: number } };
    expect(r.body.changed).toBe(1); // applied via the file-direct applyOps path, not live
  });

  it('unresolved refs from the live apply are reported, no live/file hint needed (already known to be missing live)', async () => {
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return {
        ok: false, changed: 0, errors: ['op[0] (setTrait): no LIVE entity matching {"id":999}'],
        warnings: [], unresolved: [{ id: 999 }],
      };
      throw new Error(`unexpected op ${op}`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 999 }, trait: 'Transform', fields: { x: 1 } }],
    }, ctx)) as { body: { ok: boolean; unresolved?: unknown[]; saved?: boolean } };
    expect(r.body.ok).toBe(false);
    expect(r.body.unresolved).toEqual([{ id: 999 }]);
    expect(r.body.saved).toBe(false); // changed:0 ⇒ auto mode never even attempts a save
  });

  it('a mid-call apply-scene-ops failure is a hard 500, not a silent file-direct retry', async () => {
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') throw new Error('renderer wedged mid-call');
      throw new Error(`unexpected op ${op}`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/renderer wedged mid-call/);
  });
});
