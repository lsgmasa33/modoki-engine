/** A save ALWAYS writes the parked asset docs — whatever the scene half does (#259).
 *
 *  The flush used to live inside `saveScene`, AFTER the scene write had succeeded, so five
 *  independent refusals silently swallowed it: run-mode not stopped, a prefab-edit world, no scene
 *  path, a cancelled Save-As, and a failed scene write. While the panels autosaved that was
 *  invisible — the file was already on disk by another route. With the panels parking, four of
 *  those five read as "I pressed Cmd+S and my edit was not saved", which is the failure this whole
 *  change exists to prevent, reintroduced by the fix for it.
 *
 *  These are the guards that let the autosave be removed. They are unit-level on purpose: the
 *  first draft of the plan assumed only a live editor could reach this, and it cannot — `saveAll`
 *  runs headless here against a stubbed fetch, and the run mode is a function call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState, registerAsset } from '@modoki/engine/runtime';
import {
  clearHistory, clearDirtyAssets, getDirtyAssetPaths, markAssetDirty, saveAll,
  setCurrentScenePath, markSceneSaved, hasUnsavedChanges,
} from '@modoki/engine/editor';
import { enterScrubMode, exitPreviewMode } from '../../packages/modoki/src/editor/scene/playMode';
import { registerAllTraits } from '../../app/ecs/registerTraits';

const PARTICLE = '/assets/fx/parked.particle.json';
const RIG = '/assets/rigs/parked.rig2d.json';

registerAllTraits();

let game: TestWorld | undefined;
let writes: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  registerAsset('00000010-0000-4000-8000-000000000010', PARTICLE, 'particle');
  registerAsset('00000011-0000-4000-8000-000000000011', RIG, 'rig2d');
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.body) writes.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
  }));
});
afterEach(() => {
  exitPreviewMode('animation'); // never leave the shared run-mode set for the next file
  game?.dispose();
  game = undefined;
  clearDirtyAssets();
  vi.unstubAllGlobals();
});

const assetWrites = () => writes.filter((w) => w.url.includes('/api/asset-write'));

describe('the asset flush does not depend on the scene save', () => {
  it('flushes while SCRUBBING, when the scene save is refused — Risk A', async () => {
    // The case that made this blocking: the Animation panel owns scrub mode and is also where a
    // clip is edited, so a refusal here left a human with edits and no way to save them at all.
    setCurrentScenePath('/assets/scenes/scrub.scene.json');
    markSceneSaved();
    markAssetDirty(PARTICLE, 'particle', { version: 1, duration: 3 }, 'panel');
    enterScrubMode('animation');

    const r = await saveAll({ allowDialog: false });

    expect(r.saved).toBe(false);          // the SCENE is still refused — that guard is untouched
    expect(r.reason).toBe('playing');
    expect(r.assets?.saved).toEqual([PARTICLE]); // …and the asset doc went to disk anyway
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(assetWrites()).toHaveLength(1);
  });

  it('flushes when the scene has NO PATH and no dialog is allowed (the agent save)', async () => {
    setCurrentScenePath(null);
    markAssetDirty(PARTICLE, 'particle', { version: 1 }, 'panel');

    const r = await saveAll({ allowDialog: false });

    expect(r.saved).toBe(false);
    expect(r.reason).toBe('needs-path');
    expect(r.assets?.saved).toEqual([PARTICLE]);
  });

  it('flushes even when the SCENE WRITE FAILS — one bad write does not take both down', async () => {
    setCurrentScenePath('/assets/scenes/write-fail.scene.json');
    markSceneSaved();
    markAssetDirty(PARTICLE, 'particle', { version: 1 }, 'panel');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.body) writes.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
      if (url.includes('/api/write-file')) return { ok: false, json: async () => ({ ok: false }) } as unknown as Response;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));

    const r = await saveAll({ allowDialog: false });

    expect(r.saved).toBe(false);
    expect(r.reason).toBe('write-failed');
    expect(r.assets?.saved).toEqual([PARTICLE]);
  });

  it('leaves hasUnsavedChanges() honest: the flushed asset stops counting, the refused scene does not', async () => {
    setCurrentScenePath('/assets/scenes/scrub2.scene.json');
    markSceneSaved();
    markAssetDirty(PARTICLE, 'particle', { version: 1 }, 'panel');
    enterScrubMode('animation');
    await saveAll({ allowDialog: false });
    // Nothing dirtied the live world in this test, so with the asset flushed there is nothing left.
    expect(hasUnsavedChanges()).toBe(false);
  });
});

describe('a panel write is a FULL-DOCUMENT write; an agent write is not — Risk B', () => {
  it('sends replace:true for a PANEL-origin doc', async () => {
    // Without it, /api/asset-write 409s any write that drops a top-level key — and the first
    // "+ Add Part" on a v1 rig drops four of them (ensurePartsArray moves sprite/mesh/
    // skinIndices/skinWeights into parts[]). A panel that cannot save a legal edit is worse than
    // one that autosaves.
    setCurrentScenePath('/assets/scenes/replace.scene.json');
    markSceneSaved();
    markAssetDirty(RIG, 'rig2d', { bones: [], parts: [{ name: 'main' }] }, 'panel');

    await saveAll({ allowDialog: false });

    expect(assetWrites()[0].body.replace).toBe(true);
  });

  it('does NOT send replace:true for an AGENT-origin doc — the drop-key guard stays armed', async () => {
    setCurrentScenePath('/assets/scenes/noreplace.scene.json');
    markSceneSaved();
    markAssetDirty(PARTICLE, 'particle', { version: 1 }, 'agent');

    await saveAll({ allowDialog: false });

    expect(assetWrites()[0].body.replace).toBeUndefined();
  });

  it('origin follows the LAST writer, so an agent park edited in a panel flushes as a panel write', async () => {
    setCurrentScenePath('/assets/scenes/origin.scene.json');
    markSceneSaved();
    markAssetDirty(PARTICLE, 'particle', { version: 1 }, 'agent');
    markAssetDirty(PARTICLE, 'particle', { version: 1, duration: 2 }, 'panel'); // human edits it next

    await saveAll({ allowDialog: false });

    expect(assetWrites()).toHaveLength(1); // last-write-wins, one write
    expect(assetWrites()[0].body.replace).toBe(true);
  });

  it('marks the flush as the editor OWN write, so the watcher does not discard the next edit', async () => {
    // Unsuppressed, the flush's own change event comes back ~150ms later and dropParkedWriteFor
    // discards whatever is parked by then — i.e. an edit made in the second after Cmd+S.
    setCurrentScenePath('/assets/scenes/selfwrite.scene.json');
    markSceneSaved();
    markAssetDirty(PARTICLE, 'particle', { version: 1 }, 'panel');

    await saveAll({ allowDialog: false });

    expect(assetWrites()[0].body.selfWrite).toBe(true);
  });
});
