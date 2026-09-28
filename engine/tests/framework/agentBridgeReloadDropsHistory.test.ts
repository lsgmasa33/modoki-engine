// @vitest-environment jsdom
/** #1409 (close-out sibling): a scene HOT-RELOAD replaces the world from disk outside `loadScene`,
 *  and disk wins over unsaved edits (#1164). So it owes `loadScene`'s two rules: a dirty world's
 *  undo entries are dropped, and the reloaded world is the new clean baseline. Observed live before
 *  the fix on games/3d-test: reparent Fog → rewrite the scene file byte-identically → Fog back at the
 *  root, yet `undoLabel` still said 'Reparent "Fog" → Camera' and `unsavedChanges` stayed true.
 *
 *  Driven through the real `scene-changed` handler, over the fake Electron bridge
 *  `agentBridgeDeferredSceneReload.test.ts` uses. The real undo manager and the real
 *  `adoptWorldReloadedFromDisk` are installed through the real hook. Only the SceneManager load and
 *  `fetch` are stubbed, because a real load needs a renderer. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sceneManager, setRunMode } from '@modoki/engine/runtime';
import {
  pushAction, canUndo, undoLabel, hasUnsavedChanges, markSceneSaved, adoptWorldReloadedFromDisk,
} from '@modoki/engine/editor';
import { swapHistory, _resetHistoryContexts } from '../../packages/modoki/src/editor/undo/undoManager';
import { markSceneDirty, isSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

// The hot reload's adopt persists the scene path (#1698 close-out review: a reload over an edit world must name it).
vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
const SCENE_PATH = '/games/g/runtime/assets/Main.scene.json';

const { initAgentBridge, setSceneReloadSuppressor, setWorldReloadedFromDiskHook, setSceneAdoptionHooks, replaySuppressedSceneReloads } =
  await import('../../app/debug/agentBridge');
const { captureAdoption, adoptionsSettled, recordSceneFileChanged, _resetSceneAdoptionForTests } =
  await import('../../packages/modoki/src/editor/scene/sceneAdoption');

let handlers: Map<string, Handler[]>;
let loadScene: ReturnType<typeof vi.spyOn>;
const restores: (() => void)[] = [];
const noop = () => {};
const edit = (label: string) => pushAction({ label, undo: noop, redo: noop });

const PREFAB_PATH = '/games/g/runtime/assets/Crate.prefab.json';

/** `kind: 'scene'` rewrites the open scene's own file; `'prefab'` a prefab it uses (the fixture's loaded entry has no
 *  `prefabRefs`, so the bridge counts every prefab as used and reloads). */
async function hotReload(kind: 'scene' | 'prefab' | 'scene-none' = 'scene'): Promise<void> {
  // 'scene-none' emits nothing: it only lets whatever is in flight settle.
  if (kind !== 'scene-none') {
    const urlPath = kind === 'scene' ? SCENE_PATH : PREFAB_PATH;
    for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath, kind });
  }
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  const win = window as Win;
  handlers = new Map();
  win.__modokiElectron = {
    bridge: {
      on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); },
      send: vi.fn(),
    },
  };
  initAgentBridge();
  _resetSceneAdoptionForTests();
  setWorldReloadedFromDiskHook(adoptWorldReloadedFromDisk);
  // The scene-file debt is the adoption owner's since #1750 (S7): the bridge raises it through these, as the editor installs them.
  setSceneAdoptionHooks({ capture: captureAdoption, settled: () => adoptionsSettled() === null, sceneFileChanged: recordSceneFileChanged });
  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  const getLoaded = vi.spyOn(sceneManager, 'getLoadedScenes')
    .mockReturnValue(new Map([['main', { path: SCENE_PATH, role: 'primary', guid: 'main' }]]) as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() }));
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ version: 7, entities: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  restores.push(() => { getCurrent.mockRestore(); getLoaded.mockRestore(); loadScene.mockRestore(); fetchStub.mockRestore(); });

  setRunMode('stopped');
  _resetHistoryContexts();
  swapHistory(SCENE_PATH);
  markSceneSaved();
  clearAllSceneDirty();
});

afterEach(async () => {
  setSceneReloadSuppressor(null);
  await replaySuppressedSceneReloads();
  setWorldReloadedFromDiskHook(null);
  setSceneAdoptionHooks(null);
  for (const r of restores.splice(0)) r();
  delete (window as Win).__modokiElectron;
});

describe('a hot reload over a dirty world drops its undo history (#1409)', () => {
  it('drops the dirty world\'s entries and rebaselines to clean', async () => {
    edit('Reparent "Fog" → Camera');
    expect(hasUnsavedChanges()).toBe(true);
    await hotReload();
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  // #1744: this case used to KEEP the stack ("the file it reloaded still matches it"). It does not: the reload ran BECAUSE
  // the file changed, so the stack was recorded against bytes that are gone. Live on anim-bug: delete Sphere, save, `git
  // checkout` the scene (Sphere back), undo the delete → two Spheres with one guid.
  it('a SCENE-file reload drops a CLEAN world\'s history too: its file changed under the stack (#1744)', async () => {
    edit('Delete Entity');
    markSceneSaved();
    expect(hasUnsavedChanges(), 'fixture: the world is clean').toBe(false);
    await hotReload('scene');
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a PREFAB-change reload keeps a CLEAN world\'s history: the scene file did not change (Unity keeps scene undo on a reimport)', async () => {
    edit('Move');
    markSceneSaved();
    await hotReload('prefab');
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(undoLabel()).toBe('Move');
  });

  it('a scene change whose reload a PREFAB reload superseded is still owed: the winner drops the stack (#1744)', async () => {
    edit('Delete Entity');
    markSceneSaved();
    loadScene.mockRejectedValueOnce(new DOMException('superseded', 'AbortError'));
    await hotReload('scene');
    expect(undoLabel(), 'fixture: the aborted reload adopted nothing').toBe('Delete Entity');
    await hotReload('prefab');
    expect(loadScene, 'fixture: both reloads ran').toHaveBeenCalledTimes(2);
    expect(canUndo()).toBe(false);
    // …and it is paid once: a later prefab-only reload keeps the new stack.
    edit('Move');
    markSceneSaved();
    await hotReload('prefab');
    expect(undoLabel()).toBe('Move');
  });

  // #1417 replaced #1409's stopgap (adopt nothing while any base is dirty). SceneManager KEEPS a
  // base whose guid is unchanged, snapshotting its entities from the live world, so its unsaved
  // edits outlive a primary/prefab reload (A7 case, sceneManagerBaseSceneChain.test.ts), and it
  // now REPORTS which bases it kept.
  const BASE = 'bbbbbbbb-0000-4000-8000-00000000ba5e';
  const keeping = (...guids: string[]) => loadScene.mockImplementationOnce(async () => ({ world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set(guids) }));

  it('a KEPT dirty base keeps its flag: its edit survived the reload, so saveAll must still write it', async () => {
    edit('Move base Camera');
    markSceneDirty(BASE);
    keeping(BASE);
    await hotReload();
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(isSceneDirty(BASE)).toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
    // The edit version is one global counter, so it cannot tell this base edit from a primary one:
    // the stack drops (the edit stays saveable, not undoable). See the S8 rule in sceneAdoption.ts.
    expect(canUndo()).toBe(false);
  });

  it('a scene change raised while a PREFAB reload is loading is still owed after that reload adopts (#1744 close-out review)', async () => {
    edit('Delete Entity');
    markSceneSaved();
    // P: a prefab reload, held in its load, having read "nothing owed".
    let releaseP!: () => void;
    loadScene.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { releaseP = r; });
      return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
    });
    await hotReload('prefab');
    expect(loadScene, 'fixture: P is loading').toHaveBeenCalledTimes(1);
    // S: the scene change arrives and raises its debt, then waits in its fetch.
    let releaseS!: () => void;
    const realFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (...args) => {
      await new Promise<void>((r) => { releaseS = r; });
      return realFetch(...args);
    });
    await hotReload('scene');
    // P finishes first: it adopts, keeping the stack, since it carried no scene change…
    releaseP();
    await hotReload('scene-none');
    expect(undoLabel(), 'fixture: P kept the clean stack').toBe('Delete Entity');
    // …and S's reload still carries its own.
    releaseS();
    await hotReload('scene-none');
    expect(loadScene, 'fixture: S reloaded').toHaveBeenCalledTimes(2);
    expect(canUndo()).toBe(false);
  });

  it('a reload that carried an OLDER change does not clear a newer one raised during its load (#1744 close-out review)', async () => {
    edit('Delete Entity');
    markSceneSaved();
    // S1 carries generation 1 into its held load.
    let releaseS1!: () => void;
    loadScene.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { releaseS1 = r; });
      return { world: (await import('../../packages/modoki/src/runtime/core/ecs/world')).getCurrentWorld(), keptBaseGuids: new Set<string>() };
    });
    await hotReload('scene');
    // S2: a newer write to the same file raises generation 2, then waits in its fetch.
    let releaseS2!: () => void;
    const realFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (...args) => {
      await new Promise<void>((r) => { releaseS2 = r; });
      return realFetch(...args);
    });
    await hotReload('scene');
    releaseS1();
    await hotReload('scene-none');
    expect(canUndo(), 'fixture: S1 dropped the stale stack').toBe(false);
    // An edit made on S1's world — which predates S2's bytes.
    edit('Move');
    markSceneSaved();
    releaseS2();
    await hotReload('scene-none');
    expect(loadScene, 'fixture: S2 reloaded').toHaveBeenCalledTimes(2);
    expect(canUndo()).toBe(false);
  });

  it('a scene change owed to a scene that was LEFT does not drop the next scene\'s clean stack on a prefab reload', async () => {
    loadScene.mockRejectedValueOnce(new DOMException('superseded', 'AbortError'));
    await hotReload('scene'); // owed to Main, never carried: Main's reload was superseded
    const OTHER = '/games/g/runtime/assets/Other.scene.json';
    vi.mocked(sceneManager.getCurrent).mockReturnValue({ path: OTHER } as never);
    vi.mocked(sceneManager.getLoadedScenes).mockReturnValue(new Map([['other', { path: OTHER, role: 'primary', guid: 'other' }]]) as never);
    swapHistory(OTHER);
    edit('Move');
    markSceneSaved();
    await hotReload('prefab');
    expect(loadScene, 'fixture: the prefab reload ran').toHaveBeenCalledTimes(2);
    expect(undoLabel()).toBe('Move');
  });

  it('a scene-file reload retires the stack PARKED under its key too (a reload overtaking a prefab edit-open)', async () => {
    edit('Delete Entity');
    markSceneSaved();
    swapHistory('/__prefab-edit__/aaaaaaaa-0000-4000-8000-000000001744'); // the edit-open parked Main's clean stack
    await hotReload('scene');
    expect(loadScene, 'fixture: the reload ran').toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
  });

  it('a clean BASE scene file changing drops the stack too', async () => {
    const BASE_PATH = '/games/g/runtime/assets/Base.scene.json';
    vi.mocked(sceneManager.getLoadedScenes).mockReturnValue(new Map([
      ['main', { path: SCENE_PATH, role: 'primary', guid: 'main' }],
      ['base', { path: BASE_PATH, role: 'base', guid: 'base' }],
    ]) as never);
    edit('Move');
    markSceneSaved();
    for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath: BASE_PATH, kind: 'scene' });
    await hotReload('scene-none');
    expect(loadScene, 'fixture: the base change reloaded the scene').toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(false);
  });

  // A PREFAB reload: a scene-file reload drops a clean stack anyway (#1744).
  it('a kept dirty base with a CLEAN edit version (a half-failed Save All) keeps the stack too', async () => {
    edit('Move base Camera');
    markSceneSaved();
    markSceneDirty(BASE);
    keeping(BASE);
    await hotReload('prefab');
    expect(isSceneDirty(BASE)).toBe(true);
    expect(undoLabel()).toBe('Move base Camera');
  });

  it('a base the reload did NOT keep (its own file changed: forceReloadBases) loses its flag', async () => {
    edit('Move base Camera');
    markSceneSaved();
    markSceneDirty(BASE);
    keeping(); // disk wins for the changed base (#1164)
    await hotReload();
    expect(isSceneDirty(BASE)).toBe(false);
    expect(hasUnsavedChanges()).toBe(false);
    expect(canUndo()).toBe(false);
  });

  it('an ABORTED reload (superseded by a newer one) replaced nothing, so it adopts nothing', async () => {
    loadScene.mockRejectedValueOnce(new DOMException('superseded', 'AbortError'));
    edit('Move');
    await hotReload();
    expect(loadScene, 'fixture: the reload was attempted').toHaveBeenCalledTimes(1);
    expect(undoLabel()).toBe('Move');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('a SUPPRESSED reload touches nothing — the world was not replaced', async () => {
    setSceneReloadSuppressor(() => 'game is playing');
    edit('Move');
    await hotReload();
    expect(loadScene).not.toHaveBeenCalled();
    expect(undoLabel()).toBe('Move');
    expect(hasUnsavedChanges()).toBe(true);
  });
});
