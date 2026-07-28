/** Phase 3 (mcp-persistence.md) — the dirty-asset registry: 'manual'-mode
 *  particle/anim/timeline edits park a pending write instead of persisting immediately,
 *  `hasUnsavedChanges()`/`get_editor_state` surface it, and `save_all` flushes it. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import {
  getEditVersion, hasUnsavedChanges, markSceneSaved, clearHistory,
  clearDirtyAssets, getDirtyAssetPaths, saveAll, setCurrentScenePath,
} from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  // setCurrentScenePath persists the "last scene" to localStorage, absent in this test env.
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
});
afterEach(() => { game?.dispose(); game = undefined; clearDirtyAssets(); });

/** Every asset-write call this test session made, so a test can assert on exactly what was
 *  (or wasn't) persisted, distinguishing scene writes from asset writes. */
function stubFetch(): { writes: Array<{ url: string; body: unknown }> } {
  const writes: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.body) writes.push({ url, body: JSON.parse(init.body as string) });
    return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
  }));
  return { writes };
}

describe('particle-set / anim-set-clip / timeline-set in \'manual\' mode: apply live, park the write', () => {
  it('particle-set with _persistenceMode:"manual" reports saved:false and does NOT call asset-write', async () => {
    const { writes } = stubFetch();
    const before = getEditVersion();
    const r = await runAgentOp('particle-set', {
      path: '/assets/fx/dirty.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    }) as { ok: boolean; saved: boolean };
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(false);
    expect(writes.some((w) => w.url.includes('/api/asset-write'))).toBe(false);
    expect(getDirtyAssetPaths()).toEqual(['/assets/fx/dirty.particle.json']);
    // A dirty ASSET counts as unsaved work even though nothing bumped the scene edit version.
    expect(getEditVersion()).toBe(before);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('no _persistenceMode (today\'s default / auto) still persists immediately, unchanged', async () => {
    const { writes } = stubFetch();
    const r = await runAgentOp('particle-set', {
      path: '/assets/fx/auto.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
    }) as { ok: boolean; saved: boolean };
    expect(r.saved).toBe(true);
    expect(writes.some((w) => w.url.includes('/api/asset-write'))).toBe(true);
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a later manual-mode write to the SAME path supersedes the first (last-write-wins)', async () => {
    stubFetch();
    await runAgentOp('particle-set', { path: '/assets/fx/x.particle.json', def: { particle: { lifetime: 1 } }, _persistenceMode: 'manual' });
    await runAgentOp('particle-set', { path: '/assets/fx/x.particle.json', def: { particle: { lifetime: 2 } }, _persistenceMode: 'manual' });
    expect(getDirtyAssetPaths()).toEqual(['/assets/fx/x.particle.json']); // one entry, not two
  });

  it('get_editor_state lists the pending asset paths, and omits the field when there are none', async () => {
    stubFetch();
    const clean = await runAgentOp('editor-state', {}) as { dirtyAssetPaths?: string[] };
    expect(clean.dirtyAssetPaths).toBeUndefined();

    await runAgentOp('particle-set', { path: '/assets/fx/y.particle.json', def: { particle: { lifetime: 1 } }, _persistenceMode: 'manual' });
    const dirty = await runAgentOp('editor-state', {}) as { dirtyAssetPaths?: string[] };
    expect(dirty.dirtyAssetPaths).toEqual(['/assets/fx/y.particle.json']);
  });
});

describe('save_all flushes the dirty-asset registry alongside the scene write', () => {
  it('flushes a pending manual-mode particle write, clearing it and its contribution to hasUnsavedChanges()', async () => {
    const { writes } = stubFetch();
    setCurrentScenePath('/assets/scenes/dirty-test.json');
    markSceneSaved(); // baseline: matches disk before the manual edit

    await runAgentOp('particle-set', {
      path: '/assets/fx/flush.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    });
    expect(hasUnsavedChanges()).toBe(true);

    const result = await saveAll({ allowDialog: false });
    expect(result.saved).toBe(true);
    expect(result.assets?.saved).toEqual(['/assets/fx/flush.particle.json']);
    expect(getDirtyAssetPaths()).toEqual([]); // flushed — no longer pending
    expect(hasUnsavedChanges()).toBe(false); // both the scene AND the asset now match disk
    expect(writes.some((w) => w.url.includes('/api/asset-write') && (w.body as { path?: string }).path === '/assets/fx/flush.particle.json')).toBe(true);
  });

  it('a failed asset flush leaves the entry pending (never silently dropped) and does not block the scene save', async () => {
    setCurrentScenePath('/assets/scenes/dirty-fail-test.json');
    markSceneSaved();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/asset-write')) return { ok: false, json: async () => ({ ok: false, error: 'disk full' }) } as unknown as Response;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));

    await runAgentOp('particle-set', {
      path: '/assets/fx/willfail.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    });

    const result = await saveAll({ allowDialog: false });
    expect(result.saved).toBe(true); // the SCENE still saved
    expect(result.assets?.failed).toEqual([{ path: '/assets/fx/willfail.particle.json', error: 'disk full' }]);
    expect(getDirtyAssetPaths()).toEqual(['/assets/fx/willfail.particle.json']); // still pending
    expect(hasUnsavedChanges()).toBe(true); // the failed asset keeps this true
  });
});
