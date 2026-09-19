// @vitest-environment jsdom
/** #1409: a scene load or Create Scene that DISCARDS unsaved world edits must drop their undo
 *  history too. `modoki_load_scene {discardUnsaved:true}` on the open scene kept the stack
 *  (`swapHistory` no-opped on the unchanged key), and one undo replayed the discarded work onto
 *  the freshly loaded world.
 *
 *  The REAL undoManager, deliberately: the mechanism under test is `serialize` deciding
 *  `discardOutgoing` from the world's dirty state around the swap, and a mocked `swapHistory`
 *  would only assert the argument. Only SceneManager is faked, so a load resolves at once. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';

/** Runs INSIDE the faked load's await — where a human or agent edit can still land (review F1). */
const h = vi.hoisted(() => ({
  duringLoad: null as null | (() => void), kept: new Set<string>(),
  startupErrors: [] as { manager: string; error: unknown }[],
}));

vi.mock('../../src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    // Which bases the load KEPT (#1417): SceneManager's own answer, pinned against the real
    // SceneManager in sceneManagerBaseSceneChain.test.ts's A7 cases.
    loadScene: async () => { const f = h.duringLoad; h.duringLoad = null; f?.(); return { keptBaseGuids: h.kept, startupErrors: h.startupErrors }; },
    replaceWorldContent: async () => { const f = h.duringLoad; h.duringLoad = null; f?.(); },
    getCurrentBaseScene: () => undefined,
    getCurrent: () => null, // not a prefab-edit world, so Create Scene is allowed
  },
}));

import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { setRunMode } from '../../src/runtime/core/playState';
import {
  pushAction, canUndo, canRedo, undo, undoLabel, _resetHistoryContexts,
} from '../../src/editor/undo/undoManager';
import {
  loadScene, newScene, markSceneSaved, hasUnsavedChanges, getCurrentScenePath, getLastSceneLoadStartupErrors,
} from '../../src/editor/scene/serialize';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { markSceneDirty, isSceneDirty, clearAllSceneDirty, clearSceneDirty } from '../../src/editor/scene/sceneDirty';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

const noop = () => {};
/** A real edit: `pushAction` bumps the edit version, so the world now differs from disk. */
const edit = (label: string) => pushAction({ label, undo: noop, redo: noop });

const A = '/assets/scenes/a.scene.json';
const B = '/assets/scenes/b.scene.json';

// koota caps live worlds at 16 per process: free each test's world before making the next.
let world: ReturnType<typeof createWorld> | null = null;
beforeEach(async () => {
  setRunMode('stopped');
  world?.destroy();
  world = createWorld();
  setCurrentWorld(world);
  _resetHistoryContexts();
  h.kept = new Set();
  h.startupErrors = [];
  clearAllSceneDirty();
  await loadScene(A); // bind the history to A, with a clean baseline
});

describe('a discarding world swap drops the discarded work\'s undo history (#1409)', () => {
  it('a same-path reload of a DIRTY scene leaves nothing to undo', async () => {
    edit('Delete Entity');
    expect(hasUnsavedChanges()).toBe(true);
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });

  it('a same-path reload of a CLEAN scene keeps its history — the file still matches it', async () => {
    edit('Delete Entity');
    markSceneSaved();
    await loadScene(A);
    expect(undoLabel()).toBe('Delete Entity');
  });

  it('leaving a DIRTY scene parks nothing: A → B → A finds A\'s stack empty', async () => {
    edit('Reparent');
    await loadScene(B);
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });

  it('leaving a CLEAN scene still parks its stack: A → B → A restores it', async () => {
    edit('Reparent');
    markSceneSaved();
    await loadScene(B);
    expect(canUndo()).toBe(false);
    await loadScene(A);
    expect(undoLabel()).toBe('Reparent');
  });

  it('Create Scene never hands a starter world an old untitled stack', async () => {
    await newScene();
    edit('Create Entity');
    markSceneSaved(); // even a CLEAN untitled stack cannot match the next fresh starter
    await loadScene(B);
    await newScene();
    expect(canUndo()).toBe(false);
  });

  it('an edit made DURING the load is discarded with the world, so it is dropped too', async () => {
    // The outgoing world stays live and editable while the new one loads, and nothing resets the
    // dirty state until after the swap — a read only BEFORE the await missed this edit.
    h.duringLoad = () => edit('Mid-load Move');
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });

  it('an asset-document edit SURVIVES a discard — its file is not part of the world', async () => {
    edit('Move');
    pushAction({ label: 'Material color', undo: noop, redo: noop, _isFileDirect: true });
    edit('Rotate');
    pushAction({ label: 'Clip key', undo: noop, redo: noop, _isFileDirect: true });
    await undo(); // 'Clip key' → redo: a surviving redo entry, too
    await loadScene(A);
    expect(undoLabel()).toBe('Material color');
    expect(canRedo()).toBe(true);
    await undo();
    expect(canUndo()).toBe(false); // 'Move' and 'Rotate' went with the world
  });

  it('Create Scene: an edit made DURING the swap is dropped with the outgoing scene', async () => {
    h.duringLoad = () => edit('Mid-swap Move');
    await newScene();
    await loadScene(A); // the starter world is clean, so A's parked stack is what comes back
    expect(canUndo()).toBe(false);
  });

  it('Create Scene over a DIRTY scene drops that scene\'s stack', async () => {
    edit('Move');
    await newScene();
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });
});

/** #1417: SceneManager KEEPS a base whose guid is unchanged across the swap, carrying its entities
 *  from the live world, so its unsaved edits survive the load. Its dirty flag must survive with
 *  them, or `saveAll` (which writes a base only `if (isSceneDirty(guid))`) skips it and the
 *  unsaved-work guard stops asking. */
describe('a load that KEEPS a dirty base keeps its dirty flag (#1417)', () => {
  const BASE = 'bbbbbbbb-0000-4000-8000-00000000ba5e';
  const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000e2';

  it('a kept base stays dirty, so the unsaved guard still sees its edit', async () => {
    edit('Move base Camera');
    markSceneDirty(BASE);
    h.kept = new Set([BASE]);
    await loadScene(B);
    expect(isSceneDirty(BASE)).toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a base the load did NOT keep loses its flag with its edits', async () => {
    markSceneDirty(OTHER); // a base of A that B's chain drops
    h.kept = new Set([BASE]);
    await loadScene(B);
    expect(isSceneDirty(OTHER)).toBe(false);
  });

  it('a kept dirty base alone is not discarded work, so the outgoing stack is parked, not dropped', async () => {
    // The state a Save All leaves when it wrote the primary and failed on the base: the edit
    // version is clean, and only the base flag says the edit is unsaved.
    edit('Move base Camera');
    markSceneSaved();
    markSceneDirty(BASE);
    h.kept = new Set([BASE]);
    await loadScene(B);
    h.kept = new Set();
    await loadScene(A);
    expect(undoLabel()).toBe('Move base Camera');
  });

  it('the same dirty base, NOT kept, is discarded work and drops the stack', async () => {
    edit('Move base Camera');
    markSceneSaved();
    markSceneDirty(BASE);
    await loadScene(B);
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });

  // The pre-await read (#1409): dirt CLEARED during the load (a save landing mid-load) must not make
  // discarded work look clean. The after-read alone would see a clean world and park the stack.
  it('a world edit whose dirt is cleared mid-load still drops the stack', async () => {
    edit('Move');
    h.duringLoad = () => markSceneSaved();
    await loadScene(B);
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });

  it('an unkept dirty base whose flag is cleared mid-load still drops the stack', async () => {
    edit('Move base Camera');
    markSceneSaved();
    markSceneDirty(OTHER);
    h.duringLoad = () => clearSceneDirty(OTHER);
    await loadScene(B);
    await loadScene(A);
    expect(canUndo()).toBe(false);
  });
});

// #1425: SceneManager used to REJECT when a manager's init() failed after the swap, and this load's
// failure branch then skipped all of the adopt below while the world was already the new scene: the
// editor kept the OLD path open, so Save All wrote the new scene into the old file. SceneManager now
// resolves with `startupErrors` (pinned against the real one in sceneManagerLifecycle.test.ts); this
// pins that the editor adopts that world like any other and says what failed.
describe('a load whose managers failed to start is still ADOPTED (#1425)', () => {
  it('opens the new path, drops the discarded work, and reports the failed manager', async () => {
    edit('Delete Entity');
    h.startupErrors = [{ manager: 'boomManager', error: new Error('init boom') }];
    expect(await loadScene(B)).toBe('loaded');
    expect(getCurrentScenePath()).toBe(B);
    expect(canUndo()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
    expect(getLastSceneLoadStartupErrors()).toEqual(['boomManager: init boom']);
    expect(useEditorStore.getState().toast).toMatchObject({ kind: 'warn', message: expect.stringContaining('boomManager') });
  });

  it('a clean load after it clears the report', async () => {
    h.startupErrors = [{ manager: 'boomManager', error: new Error('init boom') }];
    await loadScene(B);
    h.startupErrors = [];
    await loadScene(A);
    expect(getLastSceneLoadStartupErrors()).toEqual([]);
  });
});
