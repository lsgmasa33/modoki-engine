// @vitest-environment jsdom
/** #1750 part (ii) — the scene hot reload against the worlds other operations hold, over the REAL editor wiring:
 *  `registerEditorAgentOps()` installs the suppressor, the reload hook, the adoption hooks and the replay listeners
 *  exactly as the editor does, and the real `scene-changed` handler runs over the fake Electron bridge. Only the
 *  SceneManager LOAD and `fetch` are stubbed, because a real load needs a dev server.
 *
 *  - **R3, Unity's `DisallowAutoRefresh`**: a reload nobody asked for does not start while an operation holds the world
 *    (a world-bound hold: an Apply, a prefab commit; an undo step). It is DEFERRED, replayed once the hold drains, reads
 *    the file at replay time, and several changes in one hold are one reload.
 *  - **R2, #1749**: the reload reads its target once; an edit-open adopted inside its fetch is not replaced by it.
 *  - **S7, #1744's debt in the owner**: a scene open that supersedes the reload still pays it; a reload whose offer LOST
 *    does not clear it; a change to a scene that is not open (anymore) becomes that scene's debt (owner fork 4).
 *  - The replay listeners are registered once: deferrals add none.
 *
 *  Mutations (each goes red here, and only its own cases):
 *  - the suppressor drops its `undoStepPending() !== null` clause → the hold, coalescing, re-read and undo-step cases,
 *    and the scene-left case (it then reloads the scene it was holding for).
 *  - drop the `onWorldHoldsSettled` replay registration → the hold and undo-step cases (nothing replays).
 *  - drop `handleSceneChanged`'s `!adopted()` re-check → the #1749 case.
 *  - `adopt` stops paying the INCOMING key (`incomingChanged` → false) → the superseded-reload, scene-left and
 *    Windows-key cases (and #1744's own cases in agentBridgeReloadDropsHistory.test.ts).
 *  - a lost offer clears every debt (as the bridge did) → the lost-offer case.
 *  - the handler raises the debt only for a scene in the loaded chain (move the `sceneFileChanged(msg.urlPath)` below
 *    `matchedAny`) → the scene-left case.
 *  - `normScenePath` stops normalising separators → the Windows-form key case.
 *  - `normScenePath` stops folding case → both #1786 cases; the undo manager keys its stacks by the raw path
 *    (drop `normScenePath` from `swapHistory`) → the #1786 parked-stack case only.
 *  - drop the `onAdoptionsSettled` replay registration, or `notifySettled`'s listener call → the switch-tail replay case.
 *  - `refuseEditOfPosedWorld` ignores `notAuthoredExit` → the agent-edit case. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, type World } from 'koota';
import { sceneManager, setRunMode, getCurrentWorld, setCurrentWorld, normScenePath } from '@modoki/engine/runtime';
import { pushAction, canUndo, undoLabel, markSceneSaved, undo } from '@modoki/engine/editor';
import {
  swapHistory, _resetHistoryContexts, beginWorldBoundOperation, worldHoldsSettledListenerCount,
} from '../../packages/modoki/src/editor/undo/undoManager';
import {
  withAdoption, owedSceneFileChanges, recordSceneFileChanged, adoptionsSettledListenerCount, _resetSceneAdoptionForTests,
} from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
const SCENE = '/games/g/runtime/assets/Main.scene.json';
const OTHER = '/games/g/runtime/assets/Other.scene.json';
const EDIT = '/__prefab-edit__/aaaaaaaa-0000-4000-8000-000000001750';

const { initAgentBridge, peekSuppressedSceneReloads, replaySuppressedSceneReloads, runAgentOp } = await import('../../app/debug/agentBridge');
const { registerEditorAgentOps } = await import('../../app/editor/agentEditorOps');

let handlers: Map<string, Handler[]>;
let loadScene: ReturnType<typeof vi.spyOn>;
const restores: (() => void)[] = [];
const noop = () => {};
const edit = (label: string) => pushAction({ label, undo: noop, redo: noop });
const minted: World[] = [];
const home = getCurrentWorld();
/** What the file holds NOW — the fetch serves it, so a replay that re-reads the file sees the latest. */
let fileName = 'v1';
let open = SCENE;

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const changed = (urlPath: string, kind: 'scene' | 'prefab' = 'scene') => {
  for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath, kind });
};
/** A scene open (or any route) that installs a world of its own and adopts it under `path`. */
const adoptTo = (path: string) => withAdoption('scene-load', async (t) => {
  const w = createWorld(); minted.push(w); setCurrentWorld(w);
  open = path;
  t.offer({ world: w, path, baseScene: 'none', history: { key: path, keptBaseGuids: new Set() } });
});
const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };

beforeEach(async () => {
  const win = window as Win;
  handlers = new Map();
  win.__modokiElectron = { bridge: { on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); }, send: vi.fn() } };
  initAgentBridge();
  registerEditorAgentOps(); // once per module: the suppressor, the hooks and the replay listeners, as the editor installs them
  _resetSceneAdoptionForTests();
  open = SCENE;
  fileName = 'v1';
  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockImplementation(() => ({ path: open }) as never);
  const getLoaded = vi.spyOn(sceneManager, 'getLoadedScenes').mockImplementation(() => new Map([['p', { path: open, role: 'primary', guid: 'p' }]]) as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: getCurrentWorld(), keptBaseGuids: new Set<string>() }));
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ version: 7, name: fileName, entities: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  restores.push(() => { getCurrent.mockRestore(); getLoaded.mockRestore(); loadScene.mockRestore(); fetchStub.mockRestore(); });
  for (const k of ['log', 'warn', 'info'] as const) { const s = vi.spyOn(console, k).mockImplementation(noop); restores.push(() => s.mockRestore()); }
  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory(SCENE);
  markSceneSaved();
  clearAllSceneDirty();
  await adoptTo(SCENE); // the editor has adopted the open scene
});

afterEach(async () => {
  await settle();
  await replaySuppressedSceneReloads(); // nothing a case deferred may replay into the next one's spies
  await settle();
  for (const r of restores.splice(0)) r();
  setCurrentWorld(home);
  for (const w of minted.splice(0)) w.destroy();
  delete (window as Win).__modokiElectron;
});

describe('R3: a reload does not start while an operation holds the world (Unity`s DisallowAutoRefresh)', () => {
  it('held: deferred, not run; released: replayed ONCE for several changes, reading the file as it is at replay', async () => {
    const release = beginWorldBoundOperation();
    changed(SCENE);
    fileName = 'v2';
    changed(SCENE);
    fileName = 'v3';
    changed(SCENE);
    await settle();
    expect(loadScene, 'a reload landed inside the hold').not.toHaveBeenCalled();
    expect(peekSuppressedSceneReloads(), 'coalesced to one pending change').toEqual([SCENE]);
    fileName = 'latest';
    release();
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect((loadScene.mock.calls[0]![1] as { preloaded?: { name: string } }).preloaded?.name, 'read at replay, not at deferral').toBe('latest');
  });

  it('an undo step in flight: deferred until the step ends, then replayed', async () => {
    const step = gate();
    pushAction({ label: 'Slow', undo: () => step.promise, redo: noop });
    const undoing = undo();
    changed(SCENE);
    await settle();
    expect(loadScene).not.toHaveBeenCalled();
    step.release();
    await undoing;
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
  });

  it('the open scene changed before the replay: no reload of what is open now — the change becomes the left scene`s debt', async () => {
    edit('Delete Entity');
    markSceneSaved(); // clean: leaving parks this stack
    const release = beginWorldBoundOperation();
    changed(SCENE);
    await settle();
    await adoptTo(OTHER); // the scene switch runs (a hold does not block a user's switch in this harness)
    release();
    await settle();
    expect(loadScene, 'a reload of what is open now').not.toHaveBeenCalled();
    expect(owedSceneFileChanges()).toEqual([normScenePath(SCENE)]);
    await adoptTo(SCENE);
    expect(canUndo(), 'the parked stack was recorded against bytes that are gone (fork 4)').toBe(false);
    expect(owedSceneFileChanges()).toEqual([]);
  });

  it('the replay listeners are registered once: N deferrals add none', async () => {
    const holds = worldHoldsSettledListenerCount();
    const settled = adoptionsSettledListenerCount();
    expect(holds, 'premise: the editor registered its replay').toBeGreaterThan(0);
    const release = beginWorldBoundOperation();
    for (let i = 0; i < 5; i++) { changed(`/games/g/runtime/assets/P${i}.prefab.json`, 'prefab'); changed(SCENE); }
    await settle();
    expect(worldHoldsSettledListenerCount()).toBe(holds);
    expect(adoptionsSettledListenerCount()).toBe(settled);
    release();
    await settle();
    expect(worldHoldsSettledListenerCount()).toBe(holds);
    expect(adoptionsSettledListenerCount()).toBe(settled);
  });
});

describe('a landing scene switch (close-out review)', () => {
  /** A route that has swapped its world in and holds its tail, as a scene open waiting on its managers does. */
  const heldSwitch = (path: string) => {
    const tail = gate();
    let swapped = false;
    const done = withAdoption('scene-load', async (t) => {
      const w = createWorld(); minted.push(w); setCurrentWorld(w); swapped = true;
      await tail.promise;
      open = path;
      t.offer({ world: w, path, baseScene: 'none', history: { key: path, keptBaseGuids: new Set() } });
    });
    return { tail, done, swapped: () => swapped };
  };

  it('a change arriving in its tail is deferred, and REPLAYED when the switch settles — no hold or token is involved', async () => {
    const sw = heldSwitch(SCENE);
    await settle();
    expect(sw.swapped()).toBe(true);
    changed(SCENE);
    await settle();
    expect(loadScene, 'a reload inside the tail').not.toHaveBeenCalled();
    expect(peekSuppressedSceneReloads()).toEqual([SCENE]);
    sw.tail.release();
    await sw.done;
    await settle();
    expect(loadScene, 'nothing replayed it once the switch landed').toHaveBeenCalledTimes(1);
    expect(peekSuppressedSceneReloads()).toEqual([]);
  });

  it('an agent live edit in its tail is refused with the way out that applies — not a Play/preview exit', async () => {
    const sw = heldSwitch(SCENE);
    await settle();
    const r = await runAgentOp('create-entity', { spec: { kind: 'empty' } }).catch((e: Error) => ({ ok: false, error: e.message })) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/a scene is still loading.*Try again once it's open/);
    expect(r.error).not.toMatch(/restore|preview|Play/);
    sw.tail.release();
    await sw.done;
  });
});

describe('#1749: the reload re-asks its target before it loads', () => {
  it('an edit-open adopted inside the reload`s fetch keeps its world; the reload defers and does not replace it', async () => {
    const fetched = gate();
    let fetching = false;
    const realFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (...args) => { fetching = true; await fetched.promise; return realFetch(...args); });
    changed(SCENE);
    await settle();
    expect(fetching, 'premise: the reload is in its fetch').toBe(true);
    let editWorld: World | null = null;
    await withAdoption('prefab-edit-open', async (t) => {
      editWorld = createWorld(); minted.push(editWorld); setCurrentWorld(editWorld);
      open = EDIT;
      t.offer({ world: editWorld, path: null, baseScene: 'none', history: { key: EDIT, keptBaseGuids: new Set() } });
    });
    fetched.release();
    await settle();
    expect(loadScene, 'the reload replaced the edit world with the scene it left').not.toHaveBeenCalled();
    expect(getCurrentWorld() === editWorld).toBe(true);
    expect(owedSceneFileChanges(), 'the change is still owed to the scene, paid when it is opened again').toEqual([normScenePath(SCENE)]);
  });
});

describe('S7: the scene-file debt is the adoption owner`s (#1744 residual)', () => {
  it('a scene open that SUPERSEDES the reload pays the debt: the left scene`s clean stack is dropped, not parked', async () => {
    edit('Delete Entity');
    markSceneSaved();
    loadScene.mockRejectedValueOnce(new DOMException('superseded', 'AbortError'));
    changed(SCENE);
    await settle();
    expect(undoLabel(), 'premise: the aborted reload adopted nothing').toBe('Delete Entity');
    await adoptTo(OTHER);
    await adoptTo(SCENE);
    expect(canUndo(), 'the stale stack came back with the scene').toBe(false);
  });

  it('a reload whose offer LOST (its world replaced before it adopted) leaves the debt owed; the next adopt pays it', async () => {
    edit('Delete Entity');
    markSceneSaved();
    loadScene.mockImplementationOnce(async () => {
      const lost = createWorld(); minted.push(lost); setCurrentWorld(lost);
      const winner = createWorld(); minted.push(winner); setCurrentWorld(winner); // another switch landed in its tail
      return { world: lost, keptBaseGuids: new Set<string>() };
    });
    changed(SCENE);
    await settle();
    expect(undoLabel(), 'premise: the lost offer adopted nothing').toBe('Delete Entity');
    expect(owedSceneFileChanges()).toEqual([normScenePath(SCENE)]);
    // The next ADOPT of the scene pays it. (This was a prefab change's reload; since #1873 R1 a prefab change re-imports
    // in place and adopts nothing, so a scene open stands in for "a later adopt that carries no scene change".)
    await adoptTo(SCENE);
    expect(owedSceneFileChanges()).toEqual([]);
    expect(canUndo()).toBe(false);
  });
});

describe('the debt KEY is one per scene file, whatever form its path arrives in (Windows forms, #1750 hub note)', () => {
  it('normScenePath: backslashes, the drive letter`s case and a query all reduce to the /assets/ suffix', () => {
    const want = '/assets/scenes/x.json';
    expect(normScenePath('C:\\proj\\runtime\\assets\\scenes\\x.json')).toBe(want);
    expect(normScenePath('/@fs/C:/proj/runtime/assets/scenes/x.json')).toBe(want);
    expect(normScenePath('/@fs/c:/proj/runtime/assets/scenes/x.json?url')).toBe(want);
    expect(normScenePath('/assets/scenes/x.json')).toBe(want);
    expect(normScenePath(EDIT), 'a synthetic key is left alone').toBe(EDIT);
  });

  it('a change raised under a Windows path is paid by the adopt of the same scene under its /@fs/ form', async () => {
    const fsForm = '/@fs/C:/proj/runtime/assets/Win.scene.json';
    await adoptTo(fsForm);
    edit('Delete Entity');
    markSceneSaved();
    await adoptTo(OTHER);
    recordSceneFileChanged('C:\\proj\\runtime\\assets\\Win.scene.json');
    await adoptTo(fsForm);
    expect(owedSceneFileChanges()).toEqual([]);
    expect(canUndo()).toBe(false);
  });

  // #1786 — the RAW strings observed on Windows (games/3d-test, launch-editor.sh, 2026-09-29). Both sides arrive in the
  // manifest's `/assets/…` form; they diverge only when the scene was OPENED under a spelling whose case differs from
  // the file's, which Windows (and macOS) resolve anyway. The watcher always reports the on-disk name.
  const OPENED_AS = '/assets/scenes/Empty.scene.json';
  const WATCHER_SAYS = '/assets/scenes/empty.scene.json';

  it('a scene opened under another case of its name reloads when the watcher reports its on-disk name (#1786)', async () => {
    expect(normScenePath(OPENED_AS)).toBe(normScenePath(WATCHER_SAYS));
    await adoptTo(OPENED_AS);
    changed(WATCHER_SAYS);
    await settle();
    expect(loadScene, 'the disk edit matched no loaded scene — skipped silently').toHaveBeenCalledTimes(1);
  });

  // #1791 — the strings observed on Windows (games/scroll-demo, 2026-09-29): a scene in a folder named `Assets` shared
  // its key with a top-level scene of the same name, and a scene opened through a `./` segment matched no broadcast.
  it('a change to a same-named scene outside the Assets folder does not reload the open nested one (#1791)', async () => {
    await adoptTo('/assets/scenes/Assets/nest1791.scene.json');
    changed('/assets/nest1791.scene.json');
    await settle();
    expect(loadScene, 'a different file reloaded the open scene — disk-wins over its unsaved edits').not.toHaveBeenCalled();
    changed('/assets/scenes/Assets/nest1791.scene.json');
    await settle();
    expect(loadScene, 'its own change still reloads it').toHaveBeenCalledTimes(1);
  });

  it('a scene opened through a ./ segment reloads when the watcher reports its clean path (#1791)', async () => {
    await adoptTo('/assets/scenes/./win1791.scene.json');
    changed('/assets/scenes/win1791.scene.json');
    await settle();
    expect(loadScene, 'the disk edit matched no loaded scene — skipped silently').toHaveBeenCalledTimes(1);
  });

  it('the stack parked under one case of the name is the one the debt raised under the other retires (#1786)', async () => {
    await adoptTo(OPENED_AS);
    edit('Delete Entity');
    markSceneSaved();
    await adoptTo(OTHER); // parks OPENED_AS's clean stack
    changed(WATCHER_SAYS); // not open: the change becomes the scene's debt
    await settle();
    await adoptTo(WATCHER_SAYS); // pays it
    expect(owedSceneFileChanges()).toEqual([]);
    expect(canUndo()).toBe(false);
    await adoptTo(OTHER);
    await adoptTo(OPENED_AS); // a stack parked under the raw spelling survived the payment and came back here
    expect(canUndo(), 'the stack recorded over the old bytes came back under the other spelling').toBe(false);
  });
});
