/** #1698 — the scene adoption owner (`editor/scene/sceneAdoption.ts`): one function adopts a loaded world iff that world
 *  is current. One case per absorbed bug (#1688, #1690 and its Exit variant) and per hub decision, each against the
 *  real `serialize.loadScene`, `newScene`, `openPrefabForEditing`, `exitPrefabEditing` and `restoreAuthoredSnapshot`.
 *
 *  `SceneManager` is a stub that behaves like the real one where this depends on it: every load PROMOTES A WORLD of
 *  its own (the owner adopts by world identity), a newer load or a teardown CANCELS every load still before its swap
 *  (S2), and a load can be held before its swap or in its post-swap tail, where nothing cancels it. The leave repair's
 *  two calls are recorded with the edit flag they saw; what they do is covered where they are defined.
 *
 *  Mutations (each goes red here, and only its own cases):
 *  - `adopt` ignores the world check (`record.world !== getCurrentWorld()`) → the replaced edit-open, the restore
 *    decision, the #1690 scenario.
 *  - `loadScene` adopts by request order again (`if (!stillLive()) return 'superseded'` before the offer) → #1688.
 *  - `owed` is one slot (`owed.clear()` before `owed.add`) → the set case.
 *  - `endPrefabEditInPlace` ignores `since` → the Exit variant.
 *  - the S8 tag is ignored (`const before = dirt`) → the stale pre-read case.
 *  - `newScene`'s history write bypasses the offer → the newScene-joins case.
 *  - `restored` does not record the restored world → the restore decision.
 *  - `runSwitch`'s `finally` keeps the pending entry → the never-stranded cases.
 *  - `loadSceneReporting`'s `adopted` drops the still-adopted check (`adoptedWorld() === adoptedHere`) → the newer
 *    load landing before the call ends; `adopted` reads the outcome instead → the request that installs nothing.
 *  - `loadScene`'s `finally` drops its `settleLeaveDebts()` → the deferred repair's endings; `settleLeaveDebts` runs
 *    while a scene load is still in flight → the newer load still WAITING (its repair is cut in half, and runs twice);
 *    while another route is pending → the newer load that lands, the same way.
 *  - `adopt` parks a prefab-edit stack again (drop `leavingPrefabEdit`) → every #1704 case (the accept side through its
 *    depth: the whole earlier visit comes back); read off the edit flag (`lastAdopted.edit !== null`) instead of the
 *    stack's key → the Exit-in-place case; `parkSurvivors` keeps no `_isFileDirect` entry → the accept side only. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sm = vi.hoisted(() => ({
  path: '',
  failPaths: new Set<string>(),
  refusePaths: new Set<string>(),
  /** A load of this path throws before it returns a promise at all. */
  throwSyncPath: '',
  /** Held BEFORE the swap (preloading): a newer load cancels it, as SceneManager does. */
  holdBefore: new Map<string, Promise<void>>(),
  /** Held AFTER the swap (the post-swap tail): nothing cancels it. */
  holdTail: new Map<string, Promise<void>>(),
  /** Held after `replaceWorldContent`'s swap. */
  holdReplaceTail: null as Promise<void> | null,
  /** Cancels a load still before its swap. */
  preSwap: new Set<(e: unknown) => void>(),
  minted: [] as { destroy(): void }[],
  /** Runs inside the repair's refresh. */
  duringRefresh: null as null | (() => Promise<void>),
  /** Prefab paths whose refresh throws. */
  refreshThrows: new Set<string>(),
  /** Managers that fail to start for a load of this path (#1425). */
  startupErrors: new Map<string, { manager: string; error: unknown }[]>(),
}));

vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const cancelPreSwap = () => {
    for (const abort of [...sm.preSwap]) abort(new DOMException('Aborted', 'AbortError'));
  };
  const promote = async () => {
    const { createWorld } = await import('koota');
    const { setCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/world');
    return (after: () => void) => {
      const w = createWorld();
      sm.minted.push(w);
      setCurrentWorld(w);
      after();
      return w;
    };
  };
  return {
    ...real,
    sceneManager: {
      getCurrent: () => (sm.path ? { path: sm.path } : null),
      getNext: () => null,
      getLoadedScenes: () => new Map(),
      getCurrentBaseScene: () => undefined,
      loadScene: (path: string) => {
        if (path === sm.throwSyncPath) throw new Error(`stub: ${path} threw at the call`);
        cancelPreSwap();
        let abort!: (e: unknown) => void;
        const aborted = new Promise<never>((_, reject) => { abort = reject; });
        aborted.catch(() => {});
        sm.preSwap.add(abort);
        return (async () => {
          const swap = await promote();
          try {
            await Promise.race([Promise.resolve(), aborted]);
            const hold = sm.holdBefore.get(path);
            if (hold) await Promise.race([hold, aborted]);
            await Promise.race([Promise.resolve(), aborted]);
            if (sm.failPaths.has(path)) throw new Error(`stub: no scene at ${path}`);
            if (sm.refusePaths.has(path)) {
              const { SceneFormatRefusedError } = await import('../../packages/modoki/src/runtime/loaders/loadSceneFile');
              throw new SceneFormatRefusedError('stub: too new', 'too-new');
            }
          } finally {
            sm.preSwap.delete(abort);
          }
          const world = swap(() => { sm.path = path; });
          const tail = sm.holdTail.get(path);
          if (tail) await tail;
          await Promise.resolve();
          const startupErrors = sm.startupErrors.get(path);
          return { world, keptBaseGuids: new Set<string>(), ...(startupErrors ? { startupErrors } : {}) };
        })();
      },
      replaceWorldContent: async (populate: (w: unknown) => void) => {
        cancelPreSwap();
        const swap = await promote();
        const world = swap(() => { sm.path = ''; });
        populate(world);
        if (sm.holdReplaceTail) await sm.holdReplaceTail;
        return world;
      },
    },
  };
});

const calls = vi.hoisted(() => [] as { call: 'refresh' | 'rebase'; path?: string; editing: string | null }[]);
const rebaseWorlds = vi.hoisted(() => [] as unknown[]);
vi.mock('../../packages/modoki/src/editor/scene/prefabCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/prefabCache')>();
  const editing = async () => (await import('../../packages/modoki/src/editor/store/editorStore')).useEditorStore.getState().editingPrefab?.path ?? null;
  return {
    ...actual,
    refreshPrefabSourceForPath: async (path: string) => {
      if (sm.refreshThrows.has(path)) throw new Error(`stub: refresh of ${path} failed`);
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

/** Holds Play's settings fetch — its last await before the re-check (#1703). */
const ai = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('../../packages/modoki/src/editor/panels/aiSettingsModel', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getCachedAiSettings: () => (ai.gate ? null : { captureContactOnLaunch: false }),
  fetchAiSettings: async () => { if (ai.gate) await ai.gate; return { captureContactOnLaunch: false }; },
}));

import { setRunMode } from '@modoki/engine/runtime';
import type { PrefabFile } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getCurrentWorld, setCurrentWorld } from '../../packages/modoki/src/runtime/core/ecs/world';
import { openPrefabForEditing, exitPrefabEditing, isPrefabEditWorld } from '../../packages/modoki/src/editor/scene/prefabEdit';
import {
  loadScene, loadSceneReporting, newScene, setCurrentScenePath, getCurrentScenePath, markSceneSaved, hasUnsavedChanges,
  isSceneLoadInFlight, registerBeforeSceneLoad, getLastSceneLoadStartupErrors, adoptWorldReloadedFromDisk,
} from '../../packages/modoki/src/editor/scene/serialize';
import { restoreAuthoredSnapshot, type AuthoredSnapshot } from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import {
  withAdoption, pendingAdoptions, adoptionsSettled, isWorldAdopted, owedLeaveRepairs, _resetSceneAdoptionForTests,
} from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { enterPlay, stopPlay, type PlayOutcome } from '../../packages/modoki/src/editor/scene/playMode';
import { getPlayState } from '../../packages/modoki/src/runtime/core/playState';
import { worldHasUnsavedEdits } from '../../packages/modoki/src/editor/scene/serialize';
import { pushAction, canUndo, undoLabel, undoDepth, swapHistory, undo, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';

registerAllTraits();
vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {}, clear: () => {} });

const prefab = (id: string, name: string): PrefabFile => ({
  id, version: 2, name, rootLocalId: 1,
  entities: [{ localId: 1, name, traits: { EntityAttributes: { name, parentId: 0, guid: '' } } }],
} as PrefabFile);
const E1 = { path: '/games/x/assets/prefabs/Crate.prefab.json', name: 'Crate', doc: prefab('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1698', 'Crate') };
const E2 = { path: '/games/x/assets/prefabs/Barrel.prefab.json', name: 'Barrel', doc: prefab('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2698', 'Barrel') };
const SCENE = '/assets/scenes/Station.json';
const OTHER = '/assets/scenes/Other.json';
const OLD = '/assets/scenes/Old.json';
const MISSING = '/assets/scenes/Missing.json';
const editWorldOf = (p: { doc: PrefabFile }) => `/__prefab-edit__/${p.doc.id}`;

const home = getCurrentWorld();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await tick();
  expect(cond(), 'the stubbed switch never got there').toBe(true);
}
/** Every gate a case made — opened after it, so a failing case cannot leave a switch in flight for the next one. */
const gates: (() => void)[] = [];
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  gates.push(open);
  return { promise, open };
}
const action = (label: string) => ({ label, undo: () => {}, redo: () => {} });
const editing = () => useEditorStore.getState().editingPrefab?.path ?? null;
const refreshed = (path: string) => calls.filter((c) => c.call === 'refresh' && c.path === path);

/** In `p`'s edit world, entered from SCENE, with nothing recorded yet. */
async function editingPrefab(p: typeof E1) {
  await loadScene(SCENE);
  await openPrefabForEditing({ path: p.path, name: p.name });
  expect(isPrefabEditWorld()).toBe(true); // precondition
  expect(editing()).toBe(p.path);
  calls.length = 0;
}

beforeEach(() => {
  for (const k of ['log', 'warn', 'info', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory('');
  setCurrentScenePath(null);
  markSceneSaved();
  useEditorStore.getState().closePrefabEditor();
  _resetSceneAdoptionForTests();
  sm.path = ''; sm.failPaths.clear(); sm.refusePaths.clear(); sm.throwSyncPath = '';
  sm.holdBefore.clear(); sm.holdTail.clear(); sm.holdReplaceTail = null; sm.preSwap.clear();
  sm.duringRefresh = null; sm.refreshThrows.clear(); sm.startupErrors.clear();
  ai.gate = null;
  calls.length = 0;
  rebaseWorlds.length = 0;
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async (url: string) => {
    const doc = String(url).includes('Barrel') ? E2.doc : E1.doc;
    return { ok: true, status: 200, text: async () => JSON.stringify(doc), json: async () => JSON.parse(JSON.stringify(doc)) };
  });
});
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  ai.gate = null;
  if (getPlayState() !== 'stopped') await stopPlay().catch(() => {});
  registerBeforeSceneLoad(() => null);
  for (let i = 0; i < 50 && (isSceneLoadInFlight() || pendingAdoptions().length > 0); i++) await tick();
  await tick();
  setCurrentWorld(home);
  for (const w of sm.minted.splice(0)) w.destroy(); // koota allows 16 live worlds
  vi.restoreAllMocks();
});

describe('#1688: a load superseded in its tail by a request that installs nothing adopts its own world', () => {
  for (const [how, arm, outcome] of [
    ['FAILS', () => sm.failPaths.add(MISSING), 'failed'],
    ['is REFUSED', () => sm.refusePaths.add(MISSING), 'refused'],
  ] as const) {
    it(`the newer request ${how}: path, history and baseline follow the world on screen; the outcome stays 'superseded'`, async () => {
      await loadScene(OLD);
      pushAction(action('edit in OLD'));
      markSceneSaved(); // saved: OLD's stack is parked when it is left, not dropped
      const tail = gate();
      sm.holdTail.set(SCENE, tail.promise);
      const first = loadScene(SCENE);
      await until(() => sm.path === SCENE);
      arm();
      expect(await loadScene(MISSING)).toBe(outcome);
      tail.open();

      expect(await first, 'S11: a newer request began, so this call reports superseded').toBe('superseded');
      expect(sm.path).toBe(SCENE); // precondition: SCENE's world is the one on screen
      expect(getCurrentScenePath()).toBe(SCENE);
      expect(canUndo(), `OLD's entry must not replay onto SCENE's world (got "${undoLabel()}")`).toBe(false);
      expect(hasUnsavedChanges()).toBe(false);
      expect(isWorldAdopted()).toBe(true);
    });
  }
});

describe('loadSceneReporting: `adopted` says whether this call`s scene is the open one, whatever the outcome', () => {
  it('superseded by a request that installs nothing: superseded, AND adopted', async () => {
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const first = loadSceneReporting(SCENE);
    await until(() => sm.path === SCENE);
    sm.failPaths.add(MISSING);
    expect(await loadScene(MISSING)).toBe('failed');
    tail.open();
    expect(await first).toEqual({ outcome: 'superseded', adopted: true });
  });

  it('a newer load that lands before this call ENDS: not adopted, though this call`s own adopt ran', async () => {
    await editingPrefab(E1); // so this load's end runs a leave repair, where the newer load lands
    let newer: Promise<unknown> | null = null;
    sm.duringRefresh = async () => { newer = loadScene(OTHER); await until(() => sm.path === OTHER); await tick(); };
    expect(await loadSceneReporting(SCENE)).toEqual({ outcome: 'superseded', adopted: false });
    expect(await newer).toBe('loaded');
    expect(getCurrentScenePath()).toBe(OTHER);
  });
});

describe('#1690: leave debts', () => {
  it('a second debt recorded while the first is still owed does not replace it (a set, not one slot)', async () => {
    await editingPrefab(E1);
    sm.refreshThrows.add(E1.path); // E1's repair fails, so its debt stays owed
    expect(await loadScene(SCENE)).toBe('loaded');
    expect(owedLeaveRepairs()).toEqual([E1.path]);
    await openPrefabForEditing({ path: E2.path, name: E2.name });
    expect(editing()).toBe(E2.path);
    expect(await loadScene(OTHER)).toBe('loaded'); // leaves E2's world: a second debt, recorded over the first
    expect(owedLeaveRepairs()).toEqual([E1.path, E2.path]);

    sm.refreshThrows.clear();
    expect(await loadScene(SCENE)).toBe('loaded'); // the next switch to end pays both
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(refreshed(E2.path)).toHaveLength(1);
    expect(owedLeaveRepairs()).toEqual([]);
  });

  // An edit-open that reaches a scene load's post-swap tail REFUSES since #1750 (the world is not savable there: its save
  // wrote the incoming world into the outgoing scene's file), so it can no longer out-adopt that load. These two pin that
  // the load it left alone then pays E1's debt once, with no second session in between.
  it('a prefab edit-open reaching a scene load`s tail refuses; the load lands and repairs the prefab left, once', async () => {
    await editingPrefab(E1);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const load = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    expect((await openPrefabForEditing({ path: E2.path, name: E2.name }))?.refused).toMatch(/a scene is still loading/);
    tail.open();

    expect(await load).toBe('loaded');
    expect(editing()).toBeNull();
    expect(isPrefabEditWorld()).toBe(false);
    expect(refreshed(E1.path), 'E1 was left: its repair runs, once').toEqual([{ call: 'refresh', path: E1.path, editing: null }]);
    expect(refreshed(E2.path)).toEqual([]);
  });

  it('Exit variant: an edit-open reaching Exit`s load tail refuses; Exit lands, ends E1`s session and repairs it once', async () => {
    await editingPrefab(E1);
    useEditorStore.getState().openPrefabEditor({ path: E1.path, guid: E1.doc.id!, name: E1.name }, SCENE);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const exit = exitPrefabEditing();
    await until(() => sm.path === SCENE);
    expect((await openPrefabForEditing({ path: E2.path, name: E2.name }))?.refused).toMatch(/a scene is still loading/);
    tail.open();
    expect(await exit).toBe(SCENE);

    expect(editing()).toBeNull();
    expect(isPrefabEditWorld()).toBe(false);
    expect(refreshed(E1.path)).toHaveLength(1);
  });
});

describe('S8: a pre-swap dirt read counts only against the baseline it was read from', () => {
  it('a newer load whose read predates an older load`s adopt does not drop that scene`s clean parked stack', async () => {
    await loadScene(SCENE);
    pushAction(action('edit in SCENE'));
    markSceneSaved(); // clean: parked when left
    await loadScene(OLD);
    pushAction(action('edit in OLD')); // dirty: this is what both loads below read before their swaps

    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const back = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    const hold = gate();
    sm.holdBefore.set(OTHER, hold.promise);
    const next = loadScene(OTHER); // reads OLD's dirt now, before SCENE's adopt moves the baseline
    tail.open();
    expect(await back).toBe('superseded');
    expect(undoLabel(), 'precondition: SCENE adopted, its parked stack active').toBe('edit in SCENE');

    hold.open();
    expect(await next).toBe('loaded');
    expect(await loadScene(SCENE)).toBe('loaded');
    expect(canUndo(), 'SCENE was clean when OTHER replaced it: its stack is parked, not dropped').toBe(true);
    expect(undoLabel()).toBe('edit in SCENE');
  });
});

describe('hub decisions (#1698)', () => {
  const snapshotOf = (key: string): AuthoredSnapshot => ({ key, primary: { entities: [] } as never, bases: new Map() });

  it('a RESTORE is the adopter: a load whose world it replaced adopts nothing', async () => {
    await loadScene(OLD);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const load = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    await restoreAuthoredSnapshot(snapshotOf(OLD)); // a Stop / preview exit, under OLD's key
    tail.open();

    expect(await load).toBe('superseded');
    expect(getCurrentScenePath(), 'what is on screen is OLD`s restored world').toBe(OLD);
    expect(isWorldAdopted(), 'the restored world is the adopted one').toBe(true);
  });

  it('newScene joins for history and baseline only: its path is written before the await, the rest follows the world', async () => {
    await loadScene(SCENE);
    pushAction(action('edit in SCENE')); // unsaved
    const tail = gate();
    sm.holdReplaceTail = tail.promise;
    const created = newScene('/assets/scenes/New.json');
    await until(() => getCurrentScenePath() === '/assets/scenes/New.json' && sm.path === '');
    await restoreAuthoredSnapshot(snapshotOf(SCENE)); // the starter world is replaced before newScene adopts it
    tail.open();
    await created;

    expect(getCurrentScenePath(), 'written before the await (#887), and not the owner`s').toBe('/assets/scenes/New.json');
    expect(undoLabel(), 'the starter was never adopted: no history swap').toBe('edit in SCENE');
    expect(hasUnsavedChanges(), 'no baseline move either').toBe(true);
    expect(isWorldAdopted()).toBe(true);
  });

  it('ACCEPT SIDE: newScene with nothing in the way adopts its starter — a fresh stack and a clean baseline', async () => {
    await loadScene(SCENE);
    pushAction(action('edit in SCENE'));
    await newScene('/assets/scenes/New.json');
    expect(getCurrentScenePath()).toBe('/assets/scenes/New.json');
    expect(canUndo()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
    expect(isWorldAdopted()).toBe(true);
  });

  it('a prefab edit-open whose world was replaced in its tail enters no session', async () => {
    await loadScene(SCENE);
    const tail = gate();
    sm.holdTail.set(editWorldOf(E1), tail.promise);
    const open = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(() => sm.path === editWorldOf(E1));
    expect(await loadScene(OTHER)).toBe('loaded');
    tail.open();
    await open;

    expect(editing()).toBeNull();
    expect(isPrefabEditWorld()).toBe(false);
    expect(getCurrentScenePath()).toBe(OTHER);
  });
});

describe('the pending record (#1692 reads it) can never be stranded', () => {
  it('a route that throws synchronously inside its switch is dropped, and adoptions settle', async () => {
    await expect(withAdoption('scene-load', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pendingAdoptions()).toEqual([]);
    expect(adoptionsSettled()).toBeNull();
  });

  it('a scene load whose SceneManager call throws before returning a promise: dropped, and settled', async () => {
    sm.throwSyncPath = SCENE;
    expect(await loadScene(SCENE)).toBe('failed');
    expect(pendingAdoptions()).toEqual([]);
    expect(adoptionsSettled()).toBeNull();
  });

  it('adoptionsSettled waits for a switch in flight, and resolves once it adopts', async () => {
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const load = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    expect(pendingAdoptions()).toEqual(['scene-load']);
    let settled = false;
    void adoptionsSettled()!.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    tail.open();
    expect(await load).toBe('loaded');
    await tick();
    expect(settled).toBe(true);
    expect(pendingAdoptions()).toEqual([]);
  });
});

describe('a leave repair handed to a newer load runs exactly once, however that load ends', () => {
  const B = '/assets/scenes/B.json';
  const C = '/assets/scenes/C.json';

  /** E1's world is left by a load that adopts while a newer load B is still before its swap: the repair is B's. */
  async function handedToB() {
    await editingPrefab(E1);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const older = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    const hold = gate();
    sm.holdBefore.set(B, hold.promise);
    const newer = loadScene(B);
    tail.open();
    expect(await older).toBe('superseded');
    expect(refreshed(E1.path), 'deferred: a newer load is still coming').toEqual([]);
    expect(owedLeaveRepairs()).toEqual([E1.path]);
    return { newer, hold };
  }

  it('B FAILS before its swap', async () => {
    const { newer, hold } = await handedToB();
    sm.failPaths.add(B);
    hold.open();
    expect(await newer).toBe('failed');
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(owedLeaveRepairs()).toEqual([]);
  });

  it('B is SUPERSEDED by a newer load C, which lands', async () => {
    const { newer } = await handedToB();
    const c = loadScene(C); // cancels B before its swap
    expect(await newer).toBe('superseded');
    expect(await c).toBe('loaded');
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(owedLeaveRepairs()).toEqual([]);
  });

  it('B is CANCELLED by a prefab edit-open, which lands', async () => {
    const { newer } = await handedToB();
    await openPrefabForEditing({ path: E2.path, name: E2.name }); // its swap cancels B
    expect(await newer).toBe('superseded');
    await tick();
    expect(editing()).toBe(E2.path);
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(owedLeaveRepairs()).toEqual([]);
  });

  it('B is still WAITING before it registers (a preview takedown) when the older load ends: B runs it, once', async () => {
    await editingPrefab(E1);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const older = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    const takedown = gate();
    registerBeforeSceneLoad(() => takedown.promise); // B waits here, before its world switch registers anything
    const newer = loadScene(B);
    registerBeforeSceneLoad(() => null);
    expect(pendingAdoptions(), 'precondition: only the older load is pending — B has not registered').toEqual(['scene-load']);
    // Were the repair run now, B would land inside it: that is what this lets happen.
    sm.duringRefresh = async () => { if (sm.path !== B) { takedown.open(); await until(() => sm.path === B); } };
    tail.open();
    expect(await older).toBe('superseded');
    takedown.open();
    expect(await newer).toBe('loaded');
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(rebaseWorlds.at(-1)).toBe(getCurrentWorld());
  });

  it('B ENDS normally: the repair runs once, in B`s world — not cut in half by B`s swap', async () => {
    const { newer, hold } = await handedToB();
    // Were the repair run before B's swap, B would land inside it: that is what this lets happen.
    sm.duringRefresh = async () => { if (sm.path !== B) { hold.open(); await until(() => sm.path === B); } };
    hold.open();
    expect(await newer).toBe('loaded');
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(rebaseWorlds.at(-1)).toBe(getCurrentWorld());
    expect(owedLeaveRepairs()).toEqual([]);
  });
});

/** The close-out review of #1698: one case per finding, each red against the code the review read. */
describe('close-out review findings', () => {
  it('adoptionsSettled waits for the leave repair a scene load owes — not only for the load', async () => {
    await editingPrefab(E1);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const load = loadScene(SCENE);
    await until(() => sm.path === SCENE);
    const waiter = adoptionsSettled()!;
    let seen: { refreshed: number; owed: readonly (string | null)[]; settled: boolean } | null = null;
    void waiter.then(() => { seen = { refreshed: refreshed(E1.path).length, owed: owedLeaveRepairs(), settled: adoptionsSettled() === null }; });
    tail.open();
    await load;
    await tick();
    expect(seen, 'a waiter resumed before the repair it waited for had run').toEqual({ refreshed: 1, owed: [], settled: true });
  });

  it('adoptionsSettled waits for the leave repair an edit-open runs — not only for its adopt', async () => {
    await editingPrefab(E1);
    const tail = gate();
    sm.holdTail.set(editWorldOf(E2), tail.promise);
    const open = openPrefabForEditing({ path: E2.path, name: E2.name });
    await until(() => sm.path === editWorldOf(E2));
    let repairingAtResume: boolean | null = null;
    void adoptionsSettled()!.then(() => { repairingAtResume = adoptionsSettled() !== null; });
    tail.open();
    await open;
    await tick();
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(repairingAtResume, 'a waiter resumed into the running repair').toBe(false);
  });

  it('the repair a scene load pays runs while that load still counts as in flight — Play is still refused', async () => {
    await editingPrefab(E1);
    let inFlightDuringRepair: boolean | null = null;
    sm.duringRefresh = async () => { inFlightDuringRepair = isSceneLoadInFlight(); };
    expect(await loadScene(SCENE)).toBe('loaded');
    expect(inFlightDuringRepair).toBe(true);
    expect(isSceneLoadInFlight()).toBe(false);
  });

  it('a superseded load whose scene is adopted still reports its managers that failed to start (#1425)', async () => {
    sm.startupErrors.set(SCENE, [{ manager: 'boomManager', error: new Error('boom') }]);
    const tail = gate();
    sm.holdTail.set(SCENE, tail.promise);
    const first = loadSceneReporting(SCENE);
    await until(() => sm.path === SCENE);
    sm.failPaths.add(MISSING);
    expect(await loadScene(MISSING)).toBe('failed');
    tail.open();
    expect(await first).toEqual({ outcome: 'superseded', adopted: true });
    expect(getLastSceneLoadStartupErrors()).toEqual(['boomManager: boom']);
  });

  it('a hot reload that replaces an edit world names its scene — the path is not left null', async () => {
    await editingPrefab(E1);
    await adoptWorldReloadedFromDisk(SCENE, () => sceneManager.loadScene(SCENE));
    expect(getCurrentScenePath()).toBe(SCENE);
    expect(editing()).toBeNull();
    expect(refreshed(E1.path)).toHaveLength(1);
  });

  it('a RESTORE whose world was replaced before it offered adopts nothing', async () => {
    await loadScene(OLD);
    const tail = gate();
    sm.holdTail.set(OLD, tail.promise);
    const minted = sm.minted.length;
    const restore = restoreAuthoredSnapshot({ key: OLD, primary: { entities: [] } as never, bases: new Map() });
    await until(() => sm.minted.length === minted + 1); // the restore has swapped its world in, and is held in its tail
    sm.holdTail.delete(OLD);
    expect(await loadScene(OTHER)).toBe('loaded');
    tail.open();
    await restore;
    expect(getCurrentScenePath()).toBe(OTHER);
    expect(isWorldAdopted(), 'the restore must not record a world that is no longer on screen').toBe(true);
  });

  it('a writer awaiting adoptionsSettled INSIDE an undo step does not deadlock with a load waiting for that step', async () => {
    await editingPrefab(E1);
    sm.refreshThrows.add(E1.path);
    expect(await loadScene(SCENE)).toBe('loaded');
    expect(owedLeaveRepairs(), 'precondition: a debt stays owed').toEqual([E1.path]);
    const step = gate();
    let wrote = false;
    pushAction({ label: 'a #1692-shaped write', redo: () => {}, undo: async () => { await step.promise; await (adoptionsSettled() ?? Promise.resolve()); wrote = true; } });
    const undoing = undo();
    await tick();
    const load = loadScene(OTHER); // waits for the undo step in flight (#1579)
    await tick();
    step.open();
    await until(() => wrote);
    await undoing;
    expect(await load).toBe('loaded');
  });

  it('a waiter is not released between a repair whose world changed and its re-run', async () => {
    await editingPrefab(E1);
    // Inside E1's repair (run by the edit-open's end), a hot reload replaces the world: the repair keeps its debt.
    // Not awaited: its end queues behind the very repair it interrupts (a production repair awaits no route).
    let reload: Promise<void> | null = null;
    sm.duringRefresh = async () => { reload = adoptWorldReloadedFromDisk(SCENE, () => sceneManager.loadScene(SCENE)); await until(() => sm.path === SCENE); };
    let atResume: { owed: readonly (string | null)[]; refreshes: number } | null = null;
    const open = openPrefabForEditing({ path: E2.path, name: E2.name });
    await until(() => refreshed(E1.path).length === 1);
    void adoptionsSettled()!.then(() => { atResume = { owed: owedLeaveRepairs(), refreshes: refreshed(E1.path).length }; });
    await open;
    await reload;
    await until(() => atResume !== null);
    expect(atResume, 'released before the re-run, with the debts still owed').toEqual({ owed: [], refreshes: 2 });
  });

  it('a waiter blocked only by a swapping load is released when that load ends, a debt still owed', async () => {
    await editingPrefab(E1);
    sm.refreshThrows.add(E1.path);
    expect(await loadScene(SCENE)).toBe('loaded'); // debt E1 stays owed
    const tail = gate();
    sm.holdTail.set(OTHER, tail.promise);
    const load = loadScene(OTHER);
    await until(() => sm.path === OTHER);
    let released = false;
    void adoptionsSettled()!.then(() => { released = true; });
    tail.open();
    expect(await load).toBe('loaded');
    expect(owedLeaveRepairs(), 'precondition: the repair threw again').toEqual([E1.path]);
    await until(() => released);
  });
});

describe('#1700: an edit-open that waited does not swap over a NEWER request', () => {
  /** The prefab fetch for `p`, held until the returned gate opens. */
  function holdFetchOf(p: typeof E1) {
    const g = gate();
    const real = globalThis.fetch;
    let reached = false;
    // @ts-expect-error test stub
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url) === p.path) { reached = true; await g.promise; }
      return real(url);
    });
    return { ...g, reached: () => reached };
  }

  it('a scene load requested and landed during its fetch stays on screen', async () => {
    await loadScene(SCENE);
    const held = holdFetchOf(E1);
    const open = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(held.reached);
    expect(await loadScene(OTHER)).toBe('loaded');
    held.open();
    await open;
    expect(sm.path, 'the older edit-open swapped over the newer load').toBe(OTHER);
    expect(isPrefabEditWorld()).toBe(false);
    expect(editing()).toBeNull();
    expect(getCurrentScenePath()).toBe(OTHER);
    expect(isWorldAdopted()).toBe(true);
  });

  it('the human route: a load landing while the unsaved-work dialog is open stays on screen after "Discard"', async () => {
    await newScene();                            // untitled: nothing to auto-save, so the dialog is asked
    pushAction(action('an unsaved edit'));
    expect(worldHasUnsavedEdits(), 'premise: the dialog is asked').toBe(true);
    const dialog = gate();
    let asked = false;
    const open = openPrefabForEditing({ path: E1.path, name: E1.name }, {
      confirmDiscard: async () => { asked = true; await dialog.promise; return true; },
    });
    await until(() => asked);
    expect(await loadScene(OTHER)).toBe('loaded');
    dialog.open();
    await open;
    expect(sm.path).toBe(OTHER);
    expect(isPrefabEditWorld()).toBe(false);
    expect(getCurrentScenePath()).toBe(OTHER);
  });

  it('Create Scene requested during its fetch stays on screen', async () => {
    await loadScene(SCENE);
    const held = holdFetchOf(E1);
    const open = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(held.reached);
    await newScene();
    const starter = getCurrentWorld();
    held.open();
    await open;
    expect(getCurrentWorld(), 'the edit-open replaced the new scene').toBe(starter);
    expect(isPrefabEditWorld()).toBe(false);
  });

  it('a newer edit-open wins over an older one still fetching', async () => {
    await loadScene(SCENE);
    const held = holdFetchOf(E1);
    const older = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(held.reached);
    await openPrefabForEditing({ path: E2.path, name: E2.name });
    expect(editing()).toBe(E2.path);
    held.open();
    await older;
    expect(sm.path).toBe(editWorldOf(E2));
    expect(editing(), 'the older edit-open replaced the newer one').toBe(E2.path);
  });

  it('ACCEPT SIDE: a Create Scene that is REFUSED does not cancel it — it replaced nothing (close-out review)', async () => {
    await loadScene(SCENE);
    const tail = gate();
    sm.holdTail.set(OTHER, tail.promise);
    const load = loadScene(OTHER);                // older than the edit-open, still in flight
    await until(() => sm.path === OTHER);
    const held = holdFetchOf(E1);
    const open = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(held.reached);
    await expect(newScene(), 'premise: refused while a load is in flight').rejects.toThrow(/still loading/);
    tail.open();
    await load;
    held.open();
    await open;
    expect(editing(), 'the refused Create Scene cancelled the edit-open').toBe(E1.path);
  });

  it('ACCEPT SIDE: an OLDER load landing during its fetch does not stop it — the edit-open is the newer request', async () => {
    const tail = gate();
    sm.holdTail.set(OTHER, tail.promise);
    const load = loadScene(OTHER);
    await until(() => sm.path === OTHER);
    const held = holdFetchOf(E1);
    const open = openPrefabForEditing({ path: E1.path, name: E1.name });
    await until(held.reached);
    tail.open();
    await load;
    expect(getCurrentScenePath(), 'premise: the older load adopted its scene first').toBe(OTHER);
    held.open();
    await open;
    expect(sm.path).toBe(editWorldOf(E1));
    expect(editing()).toBe(E1.path);
  });
});

describe('#1703: Play is refused while a leave repair runs, whichever route runs it', () => {
  /** In `E1`'s edit world with no scene to return to, so Exit ends the session in place. */
  async function editingWithNoReturnScene() {
    await openPrefabForEditing({ path: E1.path, name: E1.name });
    expect(isPrefabEditWorld()).toBe(true);
    expect(useEditorStore.getState().prefabReturnScenePath ?? null, 'premise: Exit has no scene to load').toBeNull();
    calls.length = 0;
  }

  it('Exit in place: a Play pressed during its repair is refused — no scene load is in flight to refuse it', async () => {
    await editingWithNoReturnScene();
    let during: { outcome: PlayOutcome; loadInFlight: boolean } | null = null;
    sm.duringRefresh = async () => { during = { outcome: await enterPlay(), loadInFlight: isSceneLoadInFlight() }; };
    expect(await exitPrefabEditing()).toBeNull();
    expect(refreshed(E1.path), 'premise: the repair ran').toHaveLength(1);
    expect(during!.loadInFlight, 'premise: the old gate could not see it').toBe(false);
    expect(during!.outcome).toMatchObject({ kind: 'refused', reason: 'scene-swap' });
    expect(getPlayState()).toBe('stopped');
  });

  it('an edit-open from inside another edit world: a Play pressed during the repair it runs is refused', async () => {
    await editingWithNoReturnScene();
    let during: PlayOutcome | null = null;
    sm.duringRefresh = async () => { during = await enterPlay(); };
    await openPrefabForEditing({ path: E2.path, name: E2.name });
    expect(refreshed(E1.path)).toHaveLength(1);
    expect(during).toMatchObject({ kind: 'refused', reason: 'scene-swap' });
  });

  it('a repair that STARTS inside Play`s awaits cancels it at the re-check', async () => {
    await editingWithNoReturnScene();
    const settings = gate();
    ai.gate = settings.promise;
    const play = enterPlay();
    await tick();
    const repair = gate();
    sm.duringRefresh = async () => { await repair.promise; };
    const exit = exitPrefabEditing();
    await until(() => refreshed(E1.path).length === 1);
    settings.open();
    const outcome = await play;
    repair.open();
    await exit;
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'load-landed' });
    expect(getPlayState()).toBe('stopped');
  });

  it('ACCEPT SIDE: with the repair done, Play starts', async () => {
    await editingWithNoReturnScene();
    await exitPrefabEditing();
    expect(adoptionsSettled()).toBeNull();
    expect((await enterPlay()).kind).toBe('started');
  });
});

describe('#1704: leaving prefab edit drops that prefab`s undo history (U27, owner 2026-09-28)', () => {
  const fileEdit = (label: string) => ({ ...action(label), _isFileDirect: true });
  /** An edit recorded in `E1`'s edit world, then saved: a CLEAN leave, which used to park the stack. */
  const editAndSave = () => { pushAction(action('Delete A')); markSceneSaved(); };
  const reopenE1 = async () => {
    await openPrefabForEditing({ path: E1.path, name: E1.name });
    expect(editing(), 'premise: back in E1`s edit world').toBe(E1.path);
  };

  for (const [how, leave] of [
    ['Exit', async () => { expect(await exitPrefabEditing()).toBe(SCENE); }],
    ['a scene load', async () => { expect(await loadScene(OTHER)).toBe('loaded'); }],
    ['opening another prefab', async () => { await openPrefabForEditing({ path: E2.path, name: E2.name }); expect(editing()).toBe(E2.path); }],
  ] as const) {
    it(`left by ${how}: the re-open has no entry from the earlier visit`, async () => {
      // #1704 R2: the kept "Delete A" undone after an outside write brought A back at a number another row now held.
      await editingPrefab(E1);
      editAndSave();
      await leave();
      expect(isPrefabEditWorld() && editing() === E1.path, 'premise: E1 was left').toBe(false);
      await reopenE1();
      expect(canUndo(), `the earlier visit's "${undoLabel()}" replays onto a document that may have changed`).toBe(false);
    });
  }

  it('re-opening the prefab from INSIDE its own edit world drops it too (a same-key swap)', async () => {
    await editingPrefab(E1);
    editAndSave();
    await reopenE1();
    expect(canUndo(), `got "${undoLabel()}"`).toBe(false);
  });

  it('Exit in place (no return scene) keeps the stack live, and the NEXT switch drops it: read off the key, not the flag', async () => {
    await openPrefabForEditing({ path: E1.path, name: E1.name });
    expect(useEditorStore.getState().prefabReturnScenePath ?? null, 'premise: Exit has no scene to load').toBeNull();
    editAndSave();
    expect(await exitPrefabEditing()).toBeNull();
    expect(editing(), 'premise: the flag is cleared').toBeNull();
    expect(isPrefabEditWorld(), 'premise: the edit world is still on screen').toBe(true);
    expect(undoLabel(), 'nothing swapped yet: the live world still matches its stack').toBe('Delete A');
    expect(await loadScene(SCENE)).toBe('loaded');
    await reopenE1();
    expect(canUndo(), `got "${undoLabel()}"`).toBe(false);
  });

  it('ACCEPT SIDE: a scene`s clean stack still parks across a prefab-edit round trip, and an asset-file entry survives', async () => {
    await loadScene(SCENE);
    pushAction(action('Move in SCENE'));
    markSceneSaved();
    await openPrefabForEditing({ path: E1.path, name: E1.name });
    pushAction(fileEdit('Material tint')); // an `_isFileDirect` entry: its file is not the prefab, and outlives the swap
    editAndSave();
    expect(await exitPrefabEditing()).toBe(SCENE);
    expect(undoLabel(), 'the scene the edit was entered from keeps its history').toBe('Move in SCENE');
    await reopenE1();
    expect(undoDepth()).toBe(1);
    expect(undoLabel()).toBe('Material tint');
  });
});
