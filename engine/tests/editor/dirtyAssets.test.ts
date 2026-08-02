/** Phase 3 (mcp-persistence.md) — the dirty-asset registry: 'manual'-mode
 *  particle/anim/timeline edits park a pending write instead of persisting immediately,
 *  `hasUnsavedChanges()`/`get_editor_state` surface it, and `save_all` flushes it. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, registerAsset,
} from '@modoki/engine/runtime';
import {
  getEditVersion, hasUnsavedChanges, markSceneSaved, clearHistory,
  clearDirtyAssets, getDirtyAssetPaths, markAssetDirty, saveAll, setCurrentScenePath,
} from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

/** `particle-set`/`anim-set-clip`/`timeline-set` REPLACE an existing def and now refuse a path no
 *  asset exists at (a typo used to be applied to nothing, reported ok, and then materialised as a
 *  brand-new file by save_all). These suites use synthetic paths, so register them the way a real
 *  editor would have. */
function registerTestAssets() {
  registerAsset(`00000000-0000-4000-8000-000000000000`.slice(0,36), '/assets/fx/auto.particle.json', 'particle');
  registerAsset(`00000001-0000-4000-8000-000000000001`.slice(0,36), '/assets/fx/dirty.particle.json', 'particle');
  registerAsset(`00000002-0000-4000-8000-000000000002`.slice(0,36), '/assets/fx/flush.particle.json', 'particle');
  registerAsset(`00000003-0000-4000-8000-000000000003`.slice(0,36), '/assets/fx/op-ok.particle.json', 'particle');
  registerAsset(`00000004-0000-4000-8000-000000000004`.slice(0,36), '/assets/fx/op-willfail.particle.json', 'particle');
  registerAsset(`00000005-0000-4000-8000-000000000005`.slice(0,36), '/assets/fx/willfail.particle.json', 'particle');
  registerAsset(`00000006-0000-4000-8000-000000000006`.slice(0,36), '/assets/fx/x.particle.json', 'particle');
  registerAsset(`00000007-0000-4000-8000-000000000007`.slice(0,36), '/assets/fx/y.particle.json', 'particle');
}


registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  registerTestAssets();
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

  it('parks the write even with NO mode param — there is no auto path left to fall into', async () => {
    // This test used to assert the opposite: an absent `_persistenceMode` meant "auto", so an
    // in-process caller (one not coming through the backend relay) wrote straight to disk while
    // every relayed call parked. Removing `auto` removed the parameter too, precisely so that
    // split cannot exist — same op, same effect, whoever calls it.
    const { writes } = stubFetch();
    const r = await runAgentOp('particle-set', {
      path: '/assets/fx/auto.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
    }) as { ok: boolean; saved: boolean };
    expect(r.saved).toBe(false);
    expect(writes.some((w) => w.url.includes('/api/asset-write'))).toBe(false);
    expect(getDirtyAssetPaths()).toEqual(['/assets/fx/auto.particle.json']);
    expect(hasUnsavedChanges()).toBe(true);
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

describe('the unsaved-work refusal names the ACTUAL cause (S3.11)', () => {
  it('a pending ASSET edit is reported as an asset edit, not as live entities', async () => {
    // Pre-fix, `new-scene` refused with one fixed string blaming create_entity/duplicate_entity/
    // prefab — so an agent whose only unsaved work was a dirty particle doc went hunting for live
    // entities it had never created. Both causes clear with save_all; what differs is what
    // force:true would discard, which is the whole point of naming it.
    stubFetch();
    await runAgentOp('particle-set', { path: '/assets/fx/dirty.particle.json', def: { particle: { lifetime: 1 } }, _persistenceMode: 'manual' });
    await expect(runAgentOp('new-scene', {})).rejects.toThrow(/pending ASSET edit/);
    await expect(runAgentOp('new-scene', {})).rejects.toThrow(/dirty\.particle\.json/);
    // …and it must NOT blame the live-world path, which is clean here.
    await expect(runAgentOp('new-scene', {})).rejects.not.toThrow(/create_entity/);
  });

  it('a dirty LIVE WORLD is still reported as live-world scene edits', async () => {
    stubFetch();
    await runAgentOp('create-entity', { spec: { kind: 'empty', name: 'S311Probe' } });
    await expect(runAgentOp('new-scene', {})).rejects.toThrow(/LIVE-WORLD scene edits/);
    await expect(runAgentOp('new-scene', {})).rejects.not.toThrow(/pending ASSET edit/);
  });

  it('force:true still discards deliberately (the guard is not a wall)', async () => {
    stubFetch();
    await runAgentOp('particle-set', { path: '/assets/fx/dirty.particle.json', def: { particle: { lifetime: 1 } }, _persistenceMode: 'manual' });
    await expect(runAgentOp('new-scene', { force: true })).resolves.toBeTruthy();
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

  // …and the AGENT must be told. saveAll's own `{saved:true}` is about the primary SCENE and is
  // correct; the bug was that the `save-all` op passed that through as a flat success while an
  // asset write had been rejected. The agent then believes its work is on disk, and a build —
  // which reads FILES — ships without it. PARTIAL is a failure (conventions §5).
  it('the save_all AGENT OP fails when an asset flush failed, instead of reporting ok:true', async () => {
    setCurrentScenePath('/assets/scenes/dirty-op-fail.json');
    markSceneSaved();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/asset-write')) return { ok: false, json: async () => ({ ok: false, error: 'disk full' }) } as unknown as Response;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));
    await runAgentOp('particle-set', {
      path: '/assets/fx/op-willfail.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    });

    await expect(runAgentOp('save-all', {})).rejects.toThrow(/PARTIALLY failed[\s\S]*op-willfail\.particle\.json/);
    // …and it must name the consequence, not just the fact.
    await expect(runAgentOp('save-all', {})).rejects.toThrow(/build reads FILES/);
    expect(getDirtyAssetPaths()).toEqual(['/assets/fx/op-willfail.particle.json']); // still pending
  });

  it('the save_all AGENT OP still reports success when everything lands', async () => {
    stubFetch();
    setCurrentScenePath('/assets/scenes/dirty-op-ok.json');
    markSceneSaved();
    await runAgentOp('particle-set', {
      path: '/assets/fx/op-ok.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    });
    const r = await runAgentOp('save-all', {}) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(getDirtyAssetPaths()).toEqual([]);
  });
});

describe('the wholesale asset ops REPLACE — so they refuse a path with no asset (S2.28)', () => {
  // A typo'd path used to be applied live (to nothing), reported ok:true, and then MATERIALISED
  // by save_all as a brand-new file — so the agent believed it edited an existing effect while it
  // had really created a second one under a slightly wrong name, leaving the original untouched.
  it('particle-set refuses an unknown path, applies nothing, parks nothing', async () => {
    const r = await runAgentOp('particle-set', {
      path: '/assets/fx/does-not-exist.particle.json',
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    }) as { ok: boolean; error: string; hint: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no particle asset exists/);
    expect(r.error).toMatch(/nothing was applied and nothing was parked/);
    expect(r.hint).toMatch(/modoki_create_asset/);
    expect(getDirtyAssetPaths()).toEqual([]);   // the load-bearing half
  });

  it('anim-set-clip and timeline-set refuse the same way', async () => {
    const a = await runAgentOp('anim-set-clip', { clipPath: '/assets/anim/nope.anim.json', clip: { tracks: [] } }) as { ok: boolean; error: string };
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/no animation asset exists/);
    const t = await runAgentOp('timeline-set', { timelinePath: '/assets/tl/nope.timeline.json', timeline: { tracks: [] } }) as { ok: boolean; error: string };
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/no timeline asset exists/);
  });

  it('a REAL path still works — the guard must not block the intended flow', async () => {
    stubFetch();
    const r = await runAgentOp('particle-set', {
      path: '/assets/fx/flush.particle.json',   // registered in setup, like a real editor
      def: { emitter: { shape: 'point' }, particle: { lifetime: 1 } },
      _persistenceMode: 'manual',
    }) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});

/** The counterpart to `save_all` for parked writes. Manual persistence shipped with only ONE exit
 *  from the registry — a save — so an exploratory asset edit could not be abandoned at all.
 *
 *  Found while reviewing the tool-quality audit: `test-smoke.mjs`'s UC6 "restored" confetti by
 *  re-applying the previous def and reported that it had cleaned up. It had not. Re-applying is not
 *  an undo — it RE-PARKS a write, so the asset stayed dirty and the next `save_all` committed it —
 *  and the def a caller can read back is the MIGRATED one, so the committed `"gravity": 6` came back
 *  as `[0,-6,0]`. Both properties are pinned below, because both are why "just write the old value"
 *  is not a substitute for this op. */
describe('discard-asset-edits — abandoning a parked write', () => {
  const A = '/assets/fx/x.particle.json';
  const B = '/assets/fx/y.particle.json';
  const def = () => ({ emitter: { shape: 'point' }, particle: { lifetime: 1 } });

  it('drops one pending write and leaves the others alone', async () => {
    markAssetDirty(A, 'particle', def());
    markAssetDirty(B, 'particle', def());
    const r = await runAgentOp('discard-asset-edits', { paths: [A] }) as { ok: boolean; discarded: string[]; remaining: string[] };
    expect(r.ok).toBe(true);
    expect(r.discarded).toEqual([A]);
    expect(r.remaining).toEqual([B]);
    expect(getDirtyAssetPaths()).toEqual([B]);
  });

  it('all:true drops everything', async () => {
    markAssetDirty(A, 'particle', def());
    markAssetDirty(B, 'particle', def());
    const r = await runAgentOp('discard-asset-edits', { all: true }) as { discarded: string[]; remaining: string[] };
    expect(r.discarded.sort()).toEqual([A, B].sort());
    expect(r.remaining).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a discarded write does NOT reach disk on the next save', async () => {
    // The property that matters. Without the discard, save_all writes it — which is exactly how a
    // committed game asset got modified by a test suite that reported it had cleaned up.
    markAssetDirty(A, 'particle', def());
    await runAgentOp('discard-asset-edits', { paths: [A] });
    const { writes } = stubFetch();
    setCurrentScenePath('/assets/scenes/s.json');
    await saveAll({ allowDialog: false });
    expect(writes.filter((w) => w.url.includes('/api/asset-write'))).toEqual([]);
  });

  it('a BARE call is refused, and the refusal lists what is pending', async () => {
    // `set_selection`'s lesson: a bare call that means "drop everything" turns one misspelled
    // argument key into an unrecoverable destructive action.
    markAssetDirty(A, 'particle', def());
    // Refusals on this surface THROW (the relay turns that into the §5 error envelope) — the same
    // convention as guardUnsaved and the load-scene refusals.
    await expect(runAgentOp('discard-asset-edits', {})).rejects.toThrow(/paths/);
    await expect(runAgentOp('discard-asset-edits', {})).rejects.toThrow(/all:true/);
    // The refusal must name what it would have dropped, so obeying it is a copy-paste.
    await expect(runAgentOp('discard-asset-edits', {})).rejects.toThrow(A);
    expect(getDirtyAssetPaths(), 'a refused call must not discard anything').toEqual([A]);
  });

  it('`paths` and `all` together are refused — they disagree about the scope', async () => {
    markAssetDirty(A, 'particle', def());
    await expect(runAgentOp('discard-asset-edits', { paths: [A], all: true })).rejects.toThrow(/not both/);
    expect(getDirtyAssetPaths()).toEqual([A]);
  });

  it('a path that was not pending is reported as such, not counted as discarded', async () => {
    markAssetDirty(A, 'particle', def());
    const r = await runAgentOp('discard-asset-edits', { paths: [A, B] }) as { discarded: string[]; notPending: string[] };
    expect(r.discarded).toEqual([A]);
    expect(r.notPending).toEqual([B]);
  });

  it('discards the WRITE, not the edit — and says so', async () => {
    // The honesty half. An agent that discards and then reads the def back still sees its own
    // change (the editor cache is untouched); if the op implied otherwise, that would read as a
    // failed discard and invite a second, real, destructive attempt.
    markAssetDirty(A, 'particle', def());
    const r = await runAgentOp('discard-asset-edits', { paths: [A] }) as { note: string };
    expect(r.note).toMatch(/live editor cache still holds/i);
  });
});
