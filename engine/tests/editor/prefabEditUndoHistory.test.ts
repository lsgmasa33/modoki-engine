/** #1409 review: entering prefab edit swaps the world, so it owes the same undo-history rule as a
 *  scene load. Unsaved world edits the save cannot write (an untitled scene) are discarded by the
 *  swap and take their undo entries with them. The prefab world starts at a clean baseline, since
 *  it IS the prefab file. Before the baseline, the untitled scene's dirty flag rode into the prefab
 *  world, and leaving it later dropped a stack that was still valid.
 *
 *  Drives the REAL `openPrefabForEditing` and the real undoManager. Only the SceneManager load is
 *  stubbed, the same way `prefabEditZIndexRoundTrip.test.ts` does it. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Runs INSIDE the faked load's await, where an edit to the outgoing world can still land. */
const h = vi.hoisted(() => ({ duringLoad: null as null | (() => void) }));

vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => null,
    loadScene: async () => { const f = h.duringLoad; h.duringLoad = null; f?.(); },
    getLoadedScenes: () => new Map(),
  },
}));

import { setRunMode } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import type { PrefabFile } from '@modoki/engine/editor';
import { openPrefabForEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { setCurrentScenePath, hasUnsavedChanges, markSceneSaved } from '../../packages/modoki/src/editor/scene/serialize';
import {
  pushAction, canUndo, undoLabel, swapHistory, _resetHistoryContexts,
} from '../../packages/modoki/src/editor/undo/undoManager';

registerAllTraits();

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

const PREFAB: PrefabFile = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
  version: 2,
  name: 'Crate',
  rootLocalId: 1,
  entities: [{ localId: 1, name: 'Crate', traits: { EntityAttributes: { name: 'Crate', parentId: 0, guid: '' } } }],
};
const OPEN = { path: '/games/x/assets/prefabs/Crate.prefab.json', name: 'Crate' };
const noop = () => {};
const edit = (label: string) => pushAction({ label, undo: noop, redo: noop });

beforeEach(() => {
  setRunMode('stopped');
  _resetHistoryContexts();
  setCurrentScenePath(null); // untitled: openPrefabForEditing has no file to save it to
  swapHistory('');
  markSceneSaved();
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify(PREFAB),
    json: async () => JSON.parse(JSON.stringify(PREFAB)),
  }));
});

describe('openPrefabForEditing and the undo history (#1409 review)', () => {
  it('an unsaved untitled scene is discarded by the swap, and so are its undo entries', async () => {
    edit('Move');
    await openPrefabForEditing(OPEN);
    // Back to the untitled key: nothing of the discarded world may come back.
    swapHistory('');
    expect(canUndo()).toBe(false);
  });

  it('an edit made DURING the swap is discarded too, and so is its entry', async () => {
    h.duringLoad = () => edit('Mid-swap Move');
    await openPrefabForEditing(OPEN);
    swapHistory('');
    expect(canUndo()).toBe(false);
  });

  it('the prefab world starts CLEAN, so a clean exit keeps its own history', async () => {
    edit('Move');
    await openPrefabForEditing(OPEN);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a CLEAN untitled scene keeps its parked history across the round trip', async () => {
    edit('Move');
    markSceneSaved();
    await openPrefabForEditing(OPEN);
    swapHistory('');
    expect(undoLabel()).toBe('Move');
  });
});
