/** /api/persistence + the Phase 1 additions to existing routes (mcp-persistence-
 *  unification.md): the session mode knob, `persistenceMode` on /api/editor-state, and
 *  `saved` on the file-direct write routes. Phase 1's ship gate is "auto mode, no save
 *  param ⇒ byte-identical to today" — these tests pin the ADDITIVE fields, not a
 *  behaviour change. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  handleBackendRequest, type BackendContext, type Manifest,
  getPersistenceMode, setPersistenceMode, _resetPersistenceMode,
} from '../../plugins/backend/editorBackendRouter';

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
const get = (urlPath: string, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath, query: new URLSearchParams(), body: undefined });

afterEach(() => { _resetPersistenceMode(); });

describe('/api/persistence', () => {
  it('defaults to auto', () => {
    expect(getPersistenceMode()).toBe('auto');
  });

  it('bare call (no mode) reads without changing anything', async () => {
    const r = (await post('/api/persistence', {}, makeCtx())) as { body: { mode: string; unsavedChanges: boolean | null } };
    expect(r.body.mode).toBe('auto');
    expect(r.body.unsavedChanges).toBeNull(); // no editor connected (default requestBrowser resolves {})
    expect(getPersistenceMode()).toBe('auto');
  });

  it('sets the mode and it is readable on a later call (shared across calls in the session)', async () => {
    const r1 = (await post('/api/persistence', { mode: 'manual' }, makeCtx())) as { body: { mode: string } };
    expect(r1.body.mode).toBe('manual');
    expect(getPersistenceMode()).toBe('manual');
    const r2 = (await post('/api/persistence', {}, makeCtx())) as { body: { mode: string } };
    expect(r2.body.mode).toBe('manual'); // persisted across the "session" (module state)
  });

  it('400s on an invalid mode, leaving the current mode untouched', async () => {
    setPersistenceMode('manual');
    const r = (await post('/api/persistence', { mode: 'bogus' }, makeCtx())) as { status?: number };
    expect(r.status).toBe(400);
    expect(getPersistenceMode()).toBe('manual');
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
    setPersistenceMode('manual');
    const ctx = makeCtx({ requestBrowser: vi.fn(async () => ({ scenePath: '/x.json', unsavedChanges: false })) });
    const r = (await get('/api/editor-state', ctx)) as { body: { scenePath?: string; persistenceMode?: string } };
    expect(r.body.scenePath).toBe('/x.json');
    expect(r.body.persistenceMode).toBe('manual');
  });
});

describe('Phase 1: file-direct routes report `saved` (additive, no behaviour change)', () => {
  let seq = 0;
  function tempScene(): string {
    const p = path.join(os.tmpdir(), `modoki-persistence-saved-${process.pid}-${seq++}.json`);
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
    const assetPath = path.join(os.tmpdir(), `modoki-persistence-asset-${process.pid}-${seq++}.particle.json`);
    const r = (await post('/api/asset-write', {
      path: assetPath, type: 'particle', data: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
    }, makeCtx())) as { body: { ok: boolean; saved?: boolean } };
    expect(r.body.ok).toBe(true);
    expect(r.body.saved).toBe(true);
  });

  it('create-asset: saved:true on a successful scaffold', async () => {
    const assetPath = path.join(os.tmpdir(), `modoki-persistence-create-${process.pid}-${seq++}.particle.json`);
    const r = (await post('/api/create-asset', { type: 'particle', path: assetPath }, makeCtx())) as { body: { ok: boolean; saved?: boolean } };
    expect(r.body.ok).toBe(true);
    expect(r.body.saved).toBe(true);
  });
});

describe('Phase 2b: scene-mutate goes LIVE when a renderer is connected on the matching scene', () => {
  let seq = 0;
  function tempScene(): string {
    const p = path.join(os.tmpdir(), `modoki-live-mutate-${process.pid}-${seq++}.json`);
    fs.writeFileSync(p, JSON.stringify({
      entities: [{ id: 1, name: 'Box', traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Box', guid: 'g-box' } } }],
    }));
    return p;
  }
  const setX = (scenePath: string) => ({ path: scenePath, ops: [{ op: 'setTrait', entity: { id: 1 }, trait: 'Transform', fields: { x: 5 } }] });

  it('goes live and does NOT write the file itself when the active scene matches (auto mode: save-all does that instead)', async () => {
    const scenePath = tempScene();
    const before = fs.readFileSync(scenePath, 'utf-8');
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] };
      if (op === 'save-all') return { ok: true, scenePath };
      throw new Error(`unexpected op ${op}`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { body: { ok: boolean; changed: number; saved?: boolean; mode?: string } };
    expect(r.body.ok).toBe(true);
    expect(r.body.changed).toBe(1);
    expect(r.body.saved).toBe(true); // auto mode: save-all ran and reported ok
    expect(r.body.mode).toBe('auto');
    expect(requestBrowser).toHaveBeenCalledWith('apply-scene-ops', { ops: setX(scenePath).ops }, expect.any(Number));
    expect(requestBrowser).toHaveBeenCalledWith('save-all', {}, expect.any(Number));
    // The route itself never touched the file — the LIVE apply + save-all did the work.
    expect(fs.readFileSync(scenePath, 'utf-8')).toBe(before);
  });

  it('manual mode: goes live but does NOT save — saved:false, no save-all call', async () => {
    setPersistenceMode('manual');
    const scenePath = tempScene();
    const requestBrowser = vi.fn(async (op: string) => {
      if (op === 'editor-state') return { playState: 'stopped', scenePath, unsavedChanges: false };
      if (op === 'apply-scene-ops') return { ok: true, changed: 1, errors: [], warnings: [], unresolved: [] };
      throw new Error(`unexpected op ${op} in manual mode`);
    });
    const ctx = makeCtx({ requestBrowser });
    const r = (await post('/api/scene-mutate', setX(scenePath), ctx)) as { body: { saved?: boolean; mode?: string } };
    expect(r.body.saved).toBe(false);
    expect(r.body.mode).toBe('manual');
    expect(requestBrowser).not.toHaveBeenCalledWith('save-all', expect.anything(), expect.any(Number));
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
