/** #1666 — every route OUT of a prefab-edit world runs the leaving repair exactly once: re-read the prefab that was
 *  open (`refreshPrefabSourceForPath`, which skips the one the edit flag names), then `rebaseStaleInstances`.
 *
 *  It lived only in `exitPrefabEditing`, so opening a scene from the Assets panel, the Inspector's Open Scene and agent
 *  `load-scene` (all `serialize.loadScene`) left a carried `Persistent` instance built from the pre-save template, and
 *  the editor's copy of the prefab missed an external write for the rest of the session. It now runs in the load
 *  itself, and in the prefab-to-prefab switch, which swaps the world without a load.
 *
 *  Drives the real `loadScene`, `exitPrefabEditing`, `openAssetInEditor` and `openPrefabForEditing`; the SceneManager
 *  swap is a stub that reports the path the editor's own `isPrefabEditWorld()` reads, and the two repair calls are
 *  recorded with the edit flag they saw. What they DO is covered where they are defined (#1483, #1493).
 *
 *  Since #1698 the debt is the adoption owner's (`sceneAdoption.ts`): recorded by the adopt that replaces an edit world,
 *  paid by `settleLeaveDebts` at the end of the last world switch to end. These cases are unchanged; the owner's own
 *  cases are in sceneAdoption.test.ts.
 *
 *  Mutations (each goes red here, checked against the owner, 2026-09-28):
 *  - drop `settleLeaveDebts()` from `loadScene`'s `finally` → every load route that lands, and the Exits superseded by
 *    a load that lands, FAILS or is REFUSED.
 *  - clear the debts whatever world the repair finished in → the load that swapped in during the repair.
 *  - `endPrefabEditInPlace` records no debt → the failed Exit and the no-return-scene Exit.
 *  - record no debt when the incoming world is itself an edit world → the A → B case.
 *  - drop the adopt's flag write → the refresh sees the flag still naming A. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sm = vi.hoisted(() => ({
  path: '',
  fail: false,
  /** A path whose load fails before its swap. */
  failPath: '',
  /** A path whose load is REFUSED (a format-version refusal) before its swap. */
  refusePath: '',
  /** Runs inside the stubbed swap, after the world has changed — where a newer load can supersede this one. */
  afterSwap: null as null | (() => void),
  /** Runs inside the repair's refresh — where a newer load can swap its world in under the repair. */
  duringRefresh: null as null | (() => Promise<void>),
  /** Resolved by the next swap. */
  swapped: null as null | (() => void),
  /** Let a macrotask pass after the swap, so the load's end comes after work other loads do in the meantime. */
  slowTail: false,
}));
vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', () => ({
  sceneManager: {
    getCurrent: () => (sm.path ? { path: sm.path } : null),
    getNext: () => null,
    getLoadedScenes: () => new Map(),
    getCurrentBaseScene: () => undefined,
    loadScene: async (path: string) => {
      await Promise.resolve();
      if (sm.fail || path === sm.failPath) throw new Error('stub: load failed');
      if (path === sm.refusePath) {
        const { SceneFormatRefusedError } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
        throw new SceneFormatRefusedError('stub: too new', 'too-new');
      }
      // A real swap replaces the ECS world: the repair's "completed in the world it started in" is judged by it.
      const { setCurrentWorld, getCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/world');
      const prev = getCurrentWorld();
      const promoted = (await import('koota')).createWorld();
      setCurrentWorld(promoted);
      prev?.destroy(); // koota allows 16 live worlds
      sm.path = path;
      const s = sm.swapped; sm.swapped = null; s?.();
      if (sm.slowTail) await new Promise((r) => setTimeout(r, 0));
      const f = sm.afterSwap; sm.afterSwap = null; f?.();
      await Promise.resolve();
      return { world: promoted, keptBaseGuids: new Set<string>() };
    },
  },
}));

const calls = vi.hoisted(() => [] as { call: 'refresh' | 'rebase'; path?: string; editing: string | null }[]);
/** The ECS world each rebase ran in, beside `calls` (whose shape the assertions compare whole). */
const rebaseWorlds = vi.hoisted(() => [] as unknown[]);
vi.mock('../../packages/modoki/src/editor/scene/prefabCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/prefabCache')>();
  const editing = async () => (await import('../../packages/modoki/src/editor/store/editorStore')).useEditorStore.getState().editingPrefab?.path ?? null;
  return {
    ...actual,
    refreshPrefabSourceForPath: async (path: string) => {
      calls.push({ call: 'refresh', path, editing: await editing() });
      const f = sm.duringRefresh; sm.duringRefresh = null;
      if (f) await f();
    },
  };
});
vi.mock('../../packages/modoki/src/editor/scene/prefabRebuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/prefabRebuild')>();
  const editing = async () => (await import('../../packages/modoki/src/editor/store/editorStore')).useEditorStore.getState().editingPrefab?.path ?? null;
  return {
    ...actual,
    rebaseStaleInstances: async () => {
      calls.push({ call: 'rebase', editing: await editing() });
      rebaseWorlds.push((await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld());
      return 0;
    },
  };
});

import { setRunMode } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import type { PrefabFile } from '@modoki/engine/editor';
import { openPrefabForEditing, exitPrefabEditing, isPrefabEditWorld } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { loadScene, setCurrentScenePath, markSceneSaved } from '../../packages/modoki/src/editor/scene/serialize';
import { openAssetInEditor } from '../../packages/modoki/src/editor/panels/openAssetInEditor';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';

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

const prefab = (id: string, name: string): PrefabFile => ({
  id, version: 2, name, rootLocalId: 1,
  entities: [{ localId: 1, name, traits: { EntityAttributes: { name, parentId: 0, guid: '' } } }],
} as PrefabFile);
const A = { path: '/games/x/assets/prefabs/Crate.prefab.json', name: 'Crate', doc: prefab('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1666', 'Crate') };
const B = { path: '/games/x/assets/prefabs/Barrel.prefab.json', name: 'Barrel', doc: prefab('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2666', 'Barrel') };
const SCENE = '/assets/scenes/Station.json';
const OTHER = '/assets/scenes/Other.json';

const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};
const refreshes = () => calls.filter((c) => c.call === 'refresh');
const rebases = () => calls.filter((c) => c.call === 'rebase');
/** Exactly one repair, for `path`, run once the flag no longer named it — and the refresh before the rebase. */
const repairedOnce = (path: string) => {
  expect(refreshes()).toEqual([{ call: 'refresh', path, editing: expect.not.stringMatching(`^${path}$`) }]);
  expect(rebases()).toHaveLength(1);
  expect(calls.map((c) => c.call)).toEqual(['refresh', 'rebase']);
};

/** In A's edit world, entered from SCENE, with nothing recorded yet. */
async function editingA() {
  await quietly(() => openPrefabForEditing({ path: A.path, name: A.name }));
  useEditorStore.getState().openPrefabEditor({ path: A.path, guid: A.doc.id!, name: A.name }, SCENE);
  expect(isPrefabEditWorld()).toBe(true); // precondition
  calls.length = 0;
}

beforeEach(() => {
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('');
  setCurrentScenePath(null);
  markSceneSaved();
  useEditorStore.getState().closePrefabEditor();
  _resetSceneAdoptionForTests(); // the owner's own record of what it adopted last (#1698), as a fresh editor starts
  sm.path = ''; sm.fail = false; sm.failPath = ''; sm.refusePath = ''; sm.afterSwap = null; sm.duringRefresh = null; sm.swapped = null; sm.slowTail = false;
  calls.length = 0;
  rebaseWorlds.length = 0;
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async (url: string) => {
    const doc = String(url).includes('Barrel') ? B.doc : A.doc;
    return { ok: true, status: 200, text: async () => JSON.stringify(doc), json: async () => JSON.parse(JSON.stringify(doc)) };
  });
});

describe('leaving a prefab-edit world repairs exactly once, whatever the route (#1666)', () => {
  it('Exit (Back): the load does it, exitPrefabEditing does not do it again', async () => {
    await editingA();
    expect(await quietly(() => exitPrefabEditing())).toBe(SCENE);
    repairedOnce(A.path);
    expect(useEditorStore.getState().editingPrefab).toBeNull();
  });

  it('opening a scene through serialize.loadScene (agent load-scene) — the flag is cleared and the repair runs', async () => {
    await editingA();
    expect(await quietly(() => loadScene(OTHER))).toBe('loaded');
    repairedOnce(A.path);
    expect(useEditorStore.getState().editingPrefab).toBeNull();
  });

  it('the Assets double-click / Inspector Open Scene route (openAssetInEditor)', async () => {
    await editingA();
    await quietly(() => openAssetInEditor({ path: OTHER, type: 'scene', name: 'Other' } as Parameters<typeof openAssetInEditor>[0]));
    expect(sm.path).toBe(OTHER); // precondition: the route loaded
    repairedOnce(A.path);
  });

  it('opening prefab B from inside A`s edit world repairs A once the flag names B', async () => {
    await editingA();
    await quietly(() => openPrefabForEditing({ path: B.path, name: B.name }));
    expect(useEditorStore.getState().editingPrefab?.path).toBe(B.path); // precondition
    expect(refreshes()).toEqual([{ call: 'refresh', path: A.path, editing: B.path }]);
    expect(rebases()).toHaveLength(1);
  });

  it('a load from a plain scene repairs nothing', async () => {
    expect(await quietly(() => loadScene(SCENE))).toBe('loaded');
    calls.length = 0;
    expect(await quietly(() => loadScene(OTHER))).toBe('loaded');
    expect(calls).toEqual([]);
  });

  it('a FAILED load out of the edit world leaves it being edited, unrepaired; a failed Exit then repairs once itself', async () => {
    await editingA();
    sm.fail = true;
    expect(await quietly(() => loadScene(OTHER))).toBe('failed');
    expect(calls).toEqual([]);
    expect(useEditorStore.getState().editingPrefab?.path).toBe(A.path); // still editing: nothing was left

    await quietly(() => exitPrefabEditing());
    expect(useEditorStore.getState().editingPrefab).toBeNull();
    repairedOnce(A.path);
    // The failed loads recorded the repair as owed; Exit in place settled it, so leaving that world later owes nothing.
    sm.fail = false;
    expect(await quietly(() => loadScene(OTHER))).toBe('loaded');
    repairedOnce(A.path);
  });

  it('a load superseded AFTER its swap, the flag already cleared by the breadcrumb`s re-render: still repaired, once', async () => {
    await editingA();
    let second: Promise<unknown> | null = null;
    // SceneBreadcrumb closes the editor on the swap's re-render, before a newer load can start (#1666 close-out review).
    sm.afterSwap = () => { useEditorStore.getState().closePrefabEditor(); second = loadScene(SCENE); };
    expect(await quietly(() => loadScene(OTHER))).toBe('superseded');
    expect(await quietly(() => second!)).toBe('loaded');
    repairedOnce(A.path);
  });

  it('Exit whose load is superseded after its swap by one that lands: repaired once, not again by Exit', async () => {
    await editingA();
    let second: Promise<unknown> | null = null;
    sm.afterSwap = () => { second = loadScene(OTHER); };
    await quietly(() => exitPrefabEditing());
    expect(await quietly(() => second!)).toBe('loaded');
    repairedOnce(A.path);
  });

  it('Exit whose load is superseded after its swap by one that FAILS: the world was left, and it is repaired once', async () => {
    await editingA();
    let second: Promise<unknown> | null = null;
    sm.failPath = '/assets/scenes/Missing.json';
    sm.afterSwap = () => { second = loadScene(sm.failPath); };
    await quietly(() => exitPrefabEditing());
    expect(await quietly(() => second!)).toBe('failed');
    expect(sm.path).toBe(SCENE); // precondition: Exit's swap stands
    repairedOnce(A.path);
    expect(useEditorStore.getState().editingPrefab).toBeNull();
  });

  it('Exit whose load is superseded after its swap by one that is REFUSED: repaired once', async () => {
    await editingA();
    let second: Promise<unknown> | null = null;
    sm.refusePath = '/assets/scenes/TooNew.json';
    sm.afterSwap = () => { second = loadScene(sm.refusePath); };
    await quietly(() => exitPrefabEditing());
    expect(await quietly(() => second!)).toBe('refused');
    repairedOnce(A.path);
  });

  it('a load swapping its world in DURING the repair: the repair stays owed, and that load runs it again in its world', async () => {
    await editingA();
    let second: Promise<unknown> | null = null;
    // The newer load ends AFTER the first repair has finished in the world it swapped in, so only the repair staying
    // owed can reach it.
    sm.duringRefresh = () => new Promise<void>((resolve) => { sm.swapped = resolve; sm.slowTail = true; second = loadScene(OTHER); });
    expect(await quietly(() => loadScene(SCENE))).toBe('superseded');
    expect(await quietly(() => second!)).toBe('loaded');
    // Twice by design (the first rebuilds nothing in production: its ids belong to the world that is gone) — and the
    // last one completed in the world that is live now.
    expect(rebases()).toHaveLength(2);
    expect(rebaseWorlds.at(-1)).toBe((await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld());
  });

  it('Exit with no scene to return to repairs in place, and a later load out of that world does not repair again', async () => {
    await editingA();
    useEditorStore.getState().openPrefabEditor({ path: A.path, guid: A.doc.id!, name: A.name }, null);
    localStorage.clear();
    expect(await quietly(() => exitPrefabEditing())).toBeNull();
    repairedOnce(A.path);
    expect(await quietly(() => loadScene(OTHER))).toBe('loaded');
    repairedOnce(A.path);
  });

  it('a load superseded AFTER its swap: the load that wins starts from a scene world, and still repairs — once', async () => {
    await editingA();
    let second: Promise<unknown> | null = null;
    sm.afterSwap = () => { second = loadScene(SCENE); };
    expect(await quietly(() => loadScene(OTHER))).toBe('superseded');
    expect(await quietly(() => second!)).toBe('loaded');
    expect(sm.path).toBe(SCENE);
    repairedOnce(A.path);
    expect(useEditorStore.getState().editingPrefab).toBeNull();
  });
});
