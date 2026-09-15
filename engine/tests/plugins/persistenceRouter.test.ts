/** /api/persistence, `persistenceMode` on /api/editor-state, and `saved` on the write routes.
 *
 *  **Persistence is MANUAL-ONLY** (owner decision 2026-07-30). The old `auto` mode — in which a
 *  live mutation ALSO saved to disk — is gone, so a mutating tool now behaves exactly one way and
 *  its effect never depends on session state set in some earlier turn. These tests pin that:
 *  a live apply does NOT save, `mode` cannot be set, and the one place a write still happens
 *  (file-direct, where there is no live world to hold the edit) is unchanged. */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { relay } from './backendRelay';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  handleBackendRequest, type BackendContext, type Manifest, getPersistenceMode,
} from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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
const TMP = makeScratchDir('modoki-persistence-');
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    // Required by BackendContext: every write route fingerprints its own write so the
    // watcher skips it. Absent here, /api/create-asset threw once its guard was added.
    markEditorWrite: () => {},
    requestBrowser: relay(),
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
    const ctx = makeCtx({ requestBrowser: vi.fn(async (op: string, params?: unknown) => (
      op === 'resolve-unsaved'
        ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] }
        : { playState: 'stopped' }
    )) });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } }],
    }, ctx)) as { body: { ok: boolean; changed: number; saved?: boolean } };
    expect(r.body.changed).toBe(1);
    expect(r.body.saved).toBe(true);
  });

  it('scene-mutate: saved:false when nothing changed (a bad ref, nothing written)', async () => {
    const scenePath = tempScene();
    const ctx = makeCtx({ requestBrowser: vi.fn(async (op: string, params?: unknown) => (
      op === 'resolve-unsaved'
        ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] }
        : { playState: 'stopped' }
    )) });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 999 }, trait: 'Transform', fields: { x: 9 } }],
    }, ctx)) as { body: { changed: number; saved?: boolean } };
    expect(r.body.changed).toBe(0);
    expect(r.body.saved).toBe(false);
  });

  /** ⚠️ **A relay rejection that does not PROVE the renderer is gone must not skip the
   *  unsaved-work probe** (#1013 close-out F1). This branch was covered by nothing — `grep "did not
   *  answer the state probe" engine/tests` returned zero — which is how adding `unknown agent op`
   *  to `isRelayTransportFailure` turned a 503 into a file write with both gates off, on a green
   *  gate.
   *
   *  `unknown agent op` means the editor OPS are unregistered. It does not mean the WINDOW is gone,
   *  and the window is what holds unsaved work. Two ways to reach it in production: the relay is a
   *  broadcast and WAS first-reply-wins (⚠️ closed by #1030 — kept because this guard must fail
   *  closed on the string regardless of transport), so a second tab on the runtime route answered
   *  instantly and
   *  beats the editor tab; and the launch race, or a bridge connected from a game page rather than
   *  `#/editor`. (An earlier version of this comment also blamed a game-code boot fault — refuted:
   *  `gameBootFaults.ts` is what FIXED that, and `registerEditorAgentOps()` is now unconditionally
   *  reached via `runGameHook`.) */
  it('scene-mutate REFUSES when the state probe fails in a way that does not prove no renderer', async () => {
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf8');
    const ctx = makeCtx({
      requestBrowser: vi.fn(async () => { throw new Error("unknown agent op 'editor-state'"); }),
    });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } }],
    }, ctx)) as { status?: number; body: { ok?: boolean; code?: string; changed?: number } };

    expect(r.status, 'a refusal, not a write').toBe(503);
    expect(r.body.code).toBe('NO_RENDERER');
    // ⚠️ The assertion that actually matters: the FILE. A wrong status is a nuisance; a rewritten
    // scene is the unsaved work gone from the world, the file and the undo stack.
    expect(fs.readFileSync(scenePath, 'utf8'), 'the scene file is untouched').toBe(before);
  });

  it('...but a relay failure that DOES prove no renderer still writes — the accept side', async () => {
    // The direction the fix must not break: a genuinely absent renderer is a normal state, and a
    // mutate against it is a legitimate file-direct write with the guards honestly skipped.
    const scenePath = tempScene();
    const ctx = makeCtx({
      requestBrowser: vi.fn(async () => { throw new Error('no renderer connected to the dev server'); }),
    });
    const r = (await post('/api/scene-mutate', {
      path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 9 } }],
    }, ctx)) as { status?: number; body: { ok?: boolean; changed?: number } };
    expect(r.body.changed, 'an absent renderer does not block the write').toBe(1);
  });

  it('asset-write: saved:true on a successful write', async () => {
    const assetPath = path.join(TMP, `asset-${seq++}.particle.json`);
    // An agent write edits an EXISTING asset; a missing path is NOT_FOUND since #1215.
    fs.writeFileSync(assetPath, '{}');
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      // The renderer's form: /@fs/<abs>. Different string, same file.
      if (op === 'editor-state') return { playState: 'stopped', scenePath: toFsUrl(scenePath), unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const liveBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: liveScene, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
      if (op === 'apply-scene-ops') {
        return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [], created: [{ op: 0, id: 7, guid: 'g-live', name: 'Made' }] };
      }
      throw new Error(`unexpected op ${op}`);
    });
    const liveBody = ((await post('/api/scene-mutate', addBox(liveScene), makeCtx({ requestBrowser: liveBrowser }))) as {
      body: { created?: Array<Record<string, unknown>> };
    }).body;

    const fileScene = tempScene();
    const fileBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: '/some/other/scene.json', unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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

  // #1216 C-12 / D6: `addedTraits` has the same two backends, and the same three literals to be dropped at
  // (the op wrapper, `decodeSceneOpsReply`, this route's two json() calls). Mutation: drop either
  // route spread, or the decoder's.
  it('BOTH branches forward `addedTraits` for a setTrait that added a trait', async () => {
    const addTrait = (scenePath: string) => ({ path: scenePath, ops: [{ op: 'setTrait', entity: { guid: 'g-box' }, trait: 'Renderable3DPrimitive', fields: { size: 2 } }] });
    const liveScene = tempScene();
    const added = [{ op: 0, id: 1, guid: 'g-box', trait: 'Renderable3DPrimitive' }];
    const liveBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: liveScene, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [], addedTraits: added };
      throw new Error(`unexpected op ${op}`);
    });
    const liveBody = ((await post('/api/scene-mutate', addTrait(liveScene), makeCtx({ requestBrowser: liveBrowser }))) as { body: { addedTraits?: unknown } }).body;
    expect(liveBody.addedTraits, 'the live branch dropped addedTraits').toEqual(added);

    const fileScene = tempScene();
    const fileBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: '/some/other/scene.json', unsavedChanges: false };
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
      throw new Error(`unexpected op ${op} — should have stayed file-direct`);
    });
    const fileBody = ((await post('/api/scene-mutate', addTrait(fileScene), makeCtx({ requestBrowser: fileBrowser }))) as { body: { addedTraits?: unknown } }).body;
    expect(fileBody.addedTraits, 'the file branch dropped addedTraits').toEqual([{ op: 0, id: 1, guid: 'g-box', trait: 'Renderable3DPrimitive' }]);
  });

  // #1262: `alsoDeleted` rides the same four places. Mutation: drop any one of the three spreads from
  // either route json(), or from decodeSceneOpsReply.
  it('BOTH branches forward `alsoDeleted` for a removeEntity that took descendants', async () => {
    const withChild = () => {
      const p = tempScene();
      fs.writeFileSync(p, JSON.stringify({ entities: [
        { id: 1, name: 'Box', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Box', guid: 'g-box' } } },
        { id: 2, name: 'Kid', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Kid', guid: 'g-kid', parentId: 'g-box' } } },
        // Enough grandchildren to pass the cap, so the file branch has an `alsoDeletedTotal` to drop.
        ...Array.from({ length: 100 }, (_, i) => ({ id: 10 + i, name: `k${i}`, traits: { EntityAttributes: { name: `k${i}`, guid: `g-k${i}`, parentId: 'g-kid' } } })),
        { id: 3, name: 'Bare', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Bare', parentId: 'g-kid' } } },
      ] }));
      return p;
    };
    const removeBox = (scenePath: string) => ({ path: scenePath, ops: [{ op: 'removeEntity', entity: { guid: 'g-box' } }] });
    const also = { alsoDeleted: ['g-kid'], alsoDeletedNoGuidIds: [3], alsoDeletedTotal: 101 };
    const liveScene = withChild();
    const liveBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: liveScene, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [], ...also };
      throw new Error(`unexpected op ${op}`);
    });
    const liveBody = ((await post('/api/scene-mutate', removeBox(liveScene), makeCtx({ requestBrowser: liveBrowser }))) as { body: object }).body;
    expect(liveBody, 'the live branch dropped a cascade field').toMatchObject(also);

    const fileScene = withChild();
    const fileBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: '/some/other/scene.json', unsavedChanges: false };
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
      throw new Error(`unexpected op ${op} — should have stayed file-direct`);
    });
    const fileBody = ((await post('/api/scene-mutate', removeBox(fileScene), makeCtx({ requestBrowser: fileBrowser }))) as {
      body: { alsoDeleted?: string[]; alsoDeletedNoGuidIds?: number[]; alsoDeletedTotal?: number };
    }).body;
    expect(fileBody.alsoDeleted?.[0], 'the file branch dropped alsoDeleted').toBe('g-kid');
    expect(fileBody.alsoDeletedNoGuidIds, 'the file branch dropped alsoDeletedNoGuidIds').toHaveLength(1);
    expect(fileBody.alsoDeletedTotal, 'the file branch dropped alsoDeletedTotal').toBe(102);
  });

  // #1223 D4, found by the live stale probe: the op answered `stale` and `options` beside its code, and
  // this route's reply literal (and the decoder before it) dropped both. Mutation: delete the `stale`
  // spread from the route's live-branch json(), or from decodeSceneOpsReply.
  it('the LIVE branch carries a refusal\'s `stale` and `options` beside its code', async () => {
    const liveScene = tempScene();
    const liveBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: liveScene, unsavedChanges: false };
      if (op === 'apply-scene-ops') {
        return { ok: false, changed: 0, errors: ['op[0] (setTrait): entity: no LIVE entity with guid "g"'], warnings: [], unresolved: [{ guid: 'g' }],
          code: 'NOT_FOUND', stale: 'world-swapped', options: ['g-other'] };
      }
      throw new Error(`unexpected op ${op}`);
    });
    const body = ((await post('/api/scene-mutate', addBox(liveScene), makeCtx({ requestBrowser: liveBrowser }))) as {
      body: { code?: string; stale?: string; options?: string[] };
    }).body;
    expect(body).toMatchObject({ code: 'NOT_FOUND', stale: 'world-swapped', options: ['g-other'] });
  });

  it('does NOT go live when the requested scene is not the one currently loaded — stays file-direct', async () => {
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf-8');
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath: '/some/other/scene.json', unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
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
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
      if (op === 'apply-scene-ops') throw new Error('renderer wedged mid-call');
      throw new Error(`unexpected op ${op}`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/renderer wedged mid-call/);
  });

  // ── #647: a reply that RETURNED but cannot be read ───────────────────────────────────────
  //
  // The distinction these guard is the whole point of the fix: a relay that never returned is
  // safe to call "the editor is not answering" and safe to retry; a relay that RETURNED an
  // unreadable shape is NEITHER, because the ops already ran. Before the fix both collapsed
  // into the same 500 → NOT_AVAILABLE_HERE → "relaunch the editor", which invites a caller to
  // re-fire a WRITE it was wrongly told had failed.
  //
  // ⚠️ Every mock below returns WITHOUT throwing — a test that throws exercises the case above
  // and cannot tell the two apart, which is exactly how this survived.
  const MALFORMED_REPLIES: Array<[string, unknown]> = [
    ['errors missing', { ok: true, changed: 1, warnings: [], unresolved: [] }],
    ['warnings missing (the spread, not a .length)', { ok: true, changed: 1, errors: [], unresolved: [] }],
    ['unresolved missing', { ok: true, changed: 1, errors: [], warnings: [] }],
    ['errors present but not an array', { ok: true, changed: 1, errors: 'nope', warnings: [], unresolved: [] }],
    ['changed missing', { ok: true, errors: [], warnings: [], unresolved: [] }],
    ['a bare error string from the relay', 'Unknown method: apply-scene-ops'],
    ['null', null],
    ['an array', []],
  ];

  for (const [label, reply] of MALFORMED_REPLIES) {
    it(`reports PARTIAL (never a retryable 500) when apply-scene-ops answers ${label}`, async () => {
      const scenePath = tempScene();
      const before = fs.readFileSync(scenePath, 'utf-8');
      const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
        if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
        if (op === 'apply-scene-ops') return reply;
        throw new Error(`unexpected op ${op}`);
      });
      const ctx = makeCtx({ requestBrowser });
      const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as {
        status?: number; body: { ok: boolean; code?: string; error?: string };
      };
      // NOT a 500 — that maps to NOT_AVAILABLE_HERE in the MCP (context.ts: `status >= 500`),
      // whose remedy is "relaunch the editor", i.e. "try again".
      expect(r.status ?? 200).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(r.body.code).toBe('PARTIAL');
      // The caller must be told BOTH halves: the ops may have landed, and retrying is unsafe.
      expect(r.body.error).toMatch(/ALREADY APPLIED/);
      expect(r.body.error).toMatch(/do NOT retry/);
      // Content-free shape description — a scene op carries authored strings, and this text
      // must never echo them back (the #644 `describeShape` rule).
      expect(r.body.error).not.toMatch(/nope/);
      // And it must NOT have silently fallen through to the file-direct branch, which would
      // re-run the edit against disk while the live world is in an unknown state.
      expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);
    });
  }

  it('a JSON-STRING reply is decoded, not refused — the transport has handed back strings before', async () => {
    // `decodeAimReply`'s header records this exact drift (a relay returning '{"x":…}' rather
    // than an object), caught only on device. A correct reply that merely arrived as a string
    // must not be reported as an unreadable shape.
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string, params?: unknown) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      // #889: the FILE-DIRECT path asks the shared unsaved probe before it writes; `covers` echoes
      // the ask, because a reply without it is correctly read as "could not answer".
      // ⚠️ Reached only on the FILE-DIRECT path — a live-branch case returns before the gate runs,
      // and several cases in this file are each kind. One stub shape serves both rather than each
      // case guessing; its presence is not evidence the gate ran in any particular case.
      if (op === 'resolve-unsaved') return { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] })?.registries ?? [] };
      if (op === 'apply-scene-ops') return JSON.stringify({ ok: true, changed: 1, errors: [], warnings: [], unresolved: [] });
      throw new Error(`unexpected op ${op}`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { body: { ok: boolean; changed: number } };
    expect(r.body.ok).toBe(true);
    expect(r.body.changed).toBe(1);
  });
});

describe('/api/scene-mutate — the prefab-edit world is addressed by its handle, LIVE-ONLY (#1254)', () => {
  // `modoki_prefab edit-open` loads a synthetic world with no scene FILE, and tells the agent to edit it with the
  // scene tools. The route used to 403 that handle (`resolveAssetPath` knows only asset roots) — and could never have
  // gone live anyway, because `canGoLive` compared against the renderer's `scenePath`, which prefab-edit sets to null.
  const WORLD = '/__prefab-edit__/b134802e-0000-4000-8000-000000000001';
  const setX = (p: string, op: Record<string, unknown> = { op: 'setTrait', entity: { name: 'Face' }, trait: 'Transform', fields: { x: 5 } }) =>
    ({ path: p, ops: [op] });
  type Body = { ok?: boolean; changed?: number; code?: string; error?: string; hint?: string; saved?: boolean; options?: string[] };

  /** A renderer holding `prefabEditWorld` (or none), recording every op; `markEditorWrite` spied so a disk write is visible. */
  function rig(prefabEditWorld: string | undefined, over: { playState?: string; editorState?: () => unknown } = {}) {
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') {
        if (over.editorState) return over.editorState();
        return { playState: over.playState ?? 'stopped', runMode: 'stopped', scenePath: null, unsavedChanges: false, ...(prefabEditWorld ? { prefabEditWorld } : {}) };
      }
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] };
      throw new Error(`unexpected op ${op} — a prefab-edit mutate goes live or refuses, nothing else`);
    });
    // Like the real scanner: the synthetic handle resolves to NO file, which is what produced the old 403.
    const resolveAssetPath = vi.fn((p: string) => (p.startsWith("/__prefab-edit__/") ? null : p));
    const markEditorWrite = vi.fn();
    return { requestBrowser, resolveAssetPath, markEditorWrite, ctx: makeCtx({ requestBrowser, resolveAssetPath, markEditorWrite }) };
  }

  it('goes live when the renderer has THAT world loaded — no file gate, no write, and the hint names edit-save', async () => {
    const r = rig(WORLD);
    const res = (await post('/api/scene-mutate', setX(WORLD), r.ctx)) as { status?: number; body: Body };
    expect(res.status ?? 200).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: 1, saved: false });
    expect(r.requestBrowser).toHaveBeenCalledWith('apply-scene-ops', expect.anything(), expect.any(Number));
    expect(r.markEditorWrite).not.toHaveBeenCalled();
    // modoki_save_all REFUSES in prefab-edit mode, so pointing at it would be a dead end.
    expect(res.body.hint).toContain('edit-save');
    expect(res.body.hint).not.toContain('modoki_save_all');
  });

  it('refuses a handle whose world is NOT loaded — a different prefab, or none — and applies nothing', async () => {
    for (const loaded of ['/__prefab-edit__/some-other-prefab', undefined]) {
      const r = rig(loaded);
      const res = (await post('/api/scene-mutate', setX(WORLD), r.ctx)) as { status?: number; body: Body };
      expect(res.status, `loaded=${loaded}`).toBe(409);
      expect(res.body).toMatchObject({ ok: false, changed: 0, code: 'NOT_FOUND' });
      expect(res.body.error).toContain(loaded ? 'DIFFERENT prefab' : 'no prefab-edit session');
      expect(r.requestBrowser).not.toHaveBeenCalledWith('apply-scene-ops', expect.anything(), expect.anything());
      expect(r.markEditorWrite).not.toHaveBeenCalled();
    }
  });

  it('refuses with no renderer at all — there is no file-direct fallback for a world that is not a file', async () => {
    const r = rig(undefined, { editorState: () => { throw new Error('no editor renderer connected'); } });
    const res = (await post('/api/scene-mutate', setX(WORLD), r.ctx)) as { status?: number; body: Body };
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no editor renderer');
    expect(r.markEditorWrite).not.toHaveBeenCalled();
  });

  it('refuses setBaseScene (400) even with the world loaded — it has no meaning inside a template', async () => {
    const r = rig(WORLD);
    const res = (await post('/api/scene-mutate', setX(WORLD, { op: 'setBaseScene', baseScene: null }), r.ctx)) as { status?: number; body: Body };
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REFUSED_BY_OP');
    expect(r.requestBrowser).not.toHaveBeenCalledWith('apply-scene-ops', expect.anything(), expect.anything());
  });

  it('a renderer that does not answer is a 503 that neither blames a file write nor offers save_all', async () => {
    // Neither applies to the prefab-edit handle: there is no file, and save_all refuses in that world (#1254 review).
    const r = rig(undefined, { editorState: () => { throw new Error('timed out waiting for the renderer'); } });
    const res = (await post('/api/scene-mutate', setX(WORLD), r.ctx)) as { status?: number; body: Body };
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NO_RENDERER');
    expect(res.body.error).not.toContain('scene FILE');
    expect(res.body.options?.join(' ')).not.toContain('modoki_save_all');
    expect(res.body.options?.join(' ')).toContain('retry');
    expect(r.requestBrowser).not.toHaveBeenCalledWith('apply-scene-ops', expect.anything(), expect.anything());
  });

  it('keeps the Play refusal ahead of the live apply', async () => {
    const r = rig(WORLD, { playState: 'playing' });
    const res = (await post('/api/scene-mutate', setX(WORLD), r.ctx)) as { status?: number; body: Body };
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('game is playing');
    expect(r.requestBrowser).not.toHaveBeenCalledWith('apply-scene-ops', expect.anything(), expect.anything());
  });

  it("a path outside the asset roots is refused with ITS OWN options, so the MCP does not blame a different editor", async () => {
    const ctx = makeCtx({ resolveAssetPath: () => null });
    const res = (await post('/api/scene-mutate', setX('/@fs/Users/x/scene.json'), ctx)) as { status?: number; body: Body };
    expect(res.status).toBe(403);
    expect(res.body.options?.join(' ')).toContain('asset-root URL');
    expect(res.body.options?.join(' ')).not.toContain('C6');
  });
});

describe('an asset-root path refusal carries its own options on every MCP-reachable route (#1212 A-5, #1254)', () => {
  // A 403 with no route-authored options fell through to the MCP's bare-403 option — "the backend belongs to a
  // DIFFERENT editor/project (C6)" — which is the Electron token gate's meaning and never a rejected path. write-meta's
  // body was not even JSON with an error in it: an empty `{}`.
  const cases: Array<[route: string, body: Record<string, unknown>]> = [
    ['/api/scene-mutate', { path: '/@fs/x.scene.json', ops: [] }],
    ['/api/delete-asset', { path: '/@fs/x.png' }],
    ['/api/duplicate-asset', { from: '/@fs/x.png', to: '/@fs/y.png' }],
    ['/api/move-file', { from: '/@fs/x.png', to: '/@fs/y.png' }],
    ['/api/create-folder', { path: '/@fs/dir' }],
    ['/api/write-meta', { path: '/@fs/x.png', meta: { version: 2 } }],
  ];
  for (const [route, body] of cases) {
    it(`${route} → 403 with an error and asset-root options`, async () => {
      const ctx = makeCtx({ resolveAssetPath: () => null });
      const res = (await post(route, body, ctx)) as { kind: string; status?: number; body: { error?: string; options?: string[] } };
      expect(res.status).toBe(403);
      expect(res.kind).toBe('json');
      expect(res.body.error).toMatch(/outside allowed directories/i);
      expect(res.body.options?.join(' ')).toContain('asset-root URL');
    });
  }
});
