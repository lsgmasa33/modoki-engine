// @vitest-environment jsdom
/** #1712 — a scene made by `newScene()` and then saved to a file is still hot-reloaded from that file.
 *
 *  `newScene()` swaps the world through `SceneManager.replaceWorldContent`, which leaves `getCurrent()` null by
 *  design, and a save that gives the world a file afterwards (`save_all {path}`, a first Cmd+S, Assets → Create
 *  Scene) tells only the editor. The reload handler asked `SceneManager` alone, found nothing and returned: an outside
 *  edit to a prefab the scene used, or to the scene file itself, was dropped with no reload and no log until the scene
 *  was reopened, and `get_scene_state` reported `scenePath: null`. Observed on the win clone.
 *
 *  Driven through the real `newScene`, the real `saveScene` (only its file write is stubbed), the real reader that
 *  `agentEditorOps` installs, the real `adoptWorldReloadedFromDisk` and the real `scene-changed` handler over the fake
 *  Electron bridge. Only the SceneManager LOAD and `fetch` are stubbed, because a real load needs a dev server.
 *
 *  Mutations, each checked red: drop the editor fallback in `openScenePath` — the three "saved" cases go red and the
 *  untitled one stays green; start the scene-kind match at `false` again — only the scene-file case goes red; drop
 *  `writePrimaryScene`'s `rekeyUntitledHistory` — the two save_all undo cases go red, and the dialog branch's — the
 *  Cmd+S case goes red; drop either world-identity check in a first save — its Create-Scene-landed case goes red; read
 *  the world after `serializeScene` instead of before — only the SERIALIZES case goes red (close-out review: the reload adopted under
 *  the file's key while the stacks were still under the untitled '', and Cmd+Z came back empty). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sceneManager, setRunMode, registerAsset, unregisterAsset, getCurrentWorld, normScenePath } from '@modoki/engine/runtime';
import { newScene, saveScene, getCurrentScenePath, setCurrentScenePath, adoptWorldReloadedFromDisk, pushAction, canUndo, undoLabel, hasUnsavedChanges } from '@modoki/engine/editor';
import { _resetHistoryContexts, activeHistoryKey } from '../../packages/modoki/src/editor/undo/undoManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';

const written: string[] = [];
/** Runs INSIDE the next file write's await — where a Create Scene can land. */
const hook = vi.hoisted(() => ({ duringWrite: null as null | (() => Promise<void>) }));
const takeHook = async () => { const f = hook.duringWrite; hook.duringWrite = null; if (f) await f(); };
const serializeHook = vi.hoisted(() => ({ during: null as null | (() => Promise<void>) }));
const takeSerializeHook = async () => { const f = serializeHook.during; serializeHook.during = null; if (f) await f(); };
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeAssetFile: async (path: string) => { written.push(path); await takeHook(); return { ok: true as const }; },
}));

// A human's first Cmd+S: the Save-As panel answers, and the create-only write lands.
// `serializeScene` awaits the prefab source of every instance — the earlier window a Create Scene can land in.
vi.mock('../../packages/modoki/src/editor/scene/prefabCache', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown> & { getPrefabSource: (src: string) => Promise<unknown> }>();
  return { ...real, getPrefabSource: async (src: string) => { await takeSerializeHook(); return real.getPrefabSource(src); } };
});
vi.mock('../../packages/modoki/src/editor/utils/saveDialog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chooseNewAssetPath: async () => ({ path: '/games/g/runtime/assets/Fresh.scene.json', confirmReplace: false }),
}));
vi.mock('../../packages/modoki/src/editor/scene/createAssetDocument', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeNewAssetDocument: async (path: string, _body: unknown, opts: { guid: string }) => {
    written.push(path);
    await takeHook();
    return { outcome: 'created', path, guid: opts.guid };
  },
}));

registerAllTraits();

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
const SCENE_PATH = '/games/g/runtime/assets/Fresh.scene.json';
const PREFAB_GUID = 'c0ffee00-0000-4000-8000-00000000d712';
const PREFAB_PATH = '/games/g/runtime/assets/Box.prefab.json';

const {
  initAgentBridge, setWorldReloadedFromDiskHook, setPrefabSourceRefresher, dumpSceneState,
} = await import('../../app/debug/agentBridge');
// #1718: the reader lives beside `openScenePath` in the runtime, where every reader of the open scene's file asks it.
const { setEditorScenePathReader } = await import('../../packages/modoki/src/runtime/scene/openScenePath');

let handlers: Map<string, Handler[]>;
let loadScene: ReturnType<typeof vi.spyOn>;
const restores: (() => void)[] = [];

const emit = (urlPath: string, kind: string) => { for (const cb of handlers.get('scene-changed') ?? []) cb({ urlPath, kind }); };
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}
/** Two live instances of the prefab, as the win clone's scene held after `modoki_prefab instantiate`: through the
 *  editor's instantiate, which records what it makes (a bare `PrefabInstance` spawn holds no record, and the save refuses
 *  a tree with none). */
const PREFAB_DOC = { id: PREFAB_GUID, version: 5, name: 'Box', rootLocalId: 1, entities: [
  { localId: 1, nodeGuid: 'c0ffee00-0000-4000-8000-00000000d713', traits: { EntityAttributes: { name: 'Box', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } } },
] };
async function instantiate(): Promise<void> {
  setPrefabCache(PREFAB_GUID, PREFAB_DOC as never);
  for (let i = 0; i < 2; i++) expect(await instantiatePrefabInstance(PREFAB_DOC as never, PREFAB_PATH)).toBeTruthy();
}

beforeEach(async () => {
  const win = window as Win;
  handlers = new Map();
  win.__modokiElectron = { bridge: { on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); }, send: vi.fn() } };
  initAgentBridge();
  setWorldReloadedFromDiskHook(adoptWorldReloadedFromDisk);
  setEditorScenePathReader(getCurrentScenePath); // as agentEditorOps installs it
  setPrefabSourceRefresher(async () => {});
  written.length = 0;
  hook.duringWrite = null;
  serializeHook.during = null;
  setRunMode('stopped'); // an authored world: a save is refused while one is not
  setCurrentScenePath(null);
  registerAsset(PREFAB_GUID, PREFAB_PATH, 'prefab');
  _resetHistoryContexts();
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => ({ world: getCurrentWorld(), keptBaseGuids: new Set<string>() }));
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify({ version: 7, entities: [] }), { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  restores.push(() => { loadScene.mockRestore(); fetchStub.mockRestore(); });
  await newScene();
});

afterEach(() => {
  setWorldReloadedFromDiskHook(null);
  setEditorScenePathReader(null);
  setPrefabSourceRefresher(null);
  unregisterAsset(PREFAB_GUID);
  for (const r of restores.splice(0)) r();
  delete (window as Win).__modokiElectron;
});

describe('#1712: a newScene() world saved to a file is bound to that file', () => {
  it('premise: the save names the file to the editor only — SceneManager still has no scene', async () => {
    const r = await saveScene({ path: SCENE_PATH, allowDialog: false });
    expect(r).toMatchObject({ saved: true, reason: 'ok' });
    expect(written).toEqual([SCENE_PATH]);
    expect(getCurrentScenePath()).toBe(SCENE_PATH);
    expect(sceneManager.getCurrent(), 'if this ever holds the file, the fallback is no longer what fixes #1712').toBeNull();
  });

  it('an outside change to a prefab it uses reloads the scene from its file', async () => {
    await instantiate();
    await saveScene({ path: SCENE_PATH, allowDialog: false });
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(loadScene.mock.calls[0][0]).toBe(SCENE_PATH);
  });

  it('an outside change to the scene file itself reloads it', async () => {
    await saveScene({ path: SCENE_PATH, allowDialog: false });
    emit(SCENE_PATH, 'scene');
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(loadScene.mock.calls[0][0]).toBe(SCENE_PATH);
  });

  it('get_scene_state names the file', async () => {
    await saveScene({ path: SCENE_PATH, allowDialog: false });
    expect(dumpSceneState().scenePath).toBe(SCENE_PATH);
  });

  it('the reload keeps the undo stack of a clean scene — as it does for a loaded one', async () => {
    await instantiate();
    pushAction({ label: 'Move Box', undo: () => {}, redo: () => {} });
    await saveScene({ path: SCENE_PATH, allowDialog: false });
    expect(activeHistoryKey(), 'the untitled world\'s stacks moved to its file').toBe(normScenePath(SCENE_PATH));
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(canUndo()).toBe(true);
    expect(undoLabel()).toBe('Move Box');
  });

  // A PREFAB reload proves the stacks moved: it adopts under the file's key and keeps a clean stack. A scene-file reload
  // would drop the stack whichever key it sat under (#1744), so it cannot tell a moved stack from a stranded one.
  it("a human's first Cmd+S (the Save-As panel) moves the stacks to the file too", async () => {
    await instantiate();
    pushAction({ label: 'Move Box', undo: () => {}, redo: () => {} });
    const r = await saveScene();
    expect(r).toMatchObject({ saved: true, path: SCENE_PATH });
    expect(activeHistoryKey()).toBe(normScenePath(SCENE_PATH));
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(undoLabel()).toBe('Move Box');
  });

  it('a reload that discards unsaved edits still keeps the asset-file edits (#1409), under the file', async () => {
    await instantiate();
    await saveScene({ path: SCENE_PATH, allowDialog: false });
    pushAction({ label: 'Edit material', undo: () => {}, redo: () => {}, _isFileDirect: true });
    pushAction({ label: 'Move Box', undo: () => {}, redo: () => {} }); // unsaved: the reload discards it
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(loadScene).toHaveBeenCalledTimes(1);
    expect(undoLabel(), 'the asset edit was parked under the untitled key and lost from the live stack').toBe('Edit material');
  });

  it('a Create Scene landing during a first save_all is not bound to the file, nor given its undo key', async () => {
    // Close-out re-review: the untitled → untitled switch leaves the path null → null, which the path check cannot see.
    pushAction({ label: 'Move Box', undo: () => {}, redo: () => {} });
    hook.duringWrite = () => newScene();
    const r = await saveScene({ path: SCENE_PATH, allowDialog: false });
    expect(r).toMatchObject({ saved: true, path: SCENE_PATH }); // the OLD world's bytes did land there
    expect(getCurrentScenePath(), 'the new untitled world was named after a file holding the old one').toBeNull();
    expect(activeHistoryKey()).toBe('');
    expect(hasUnsavedChanges(), 'the new starter world ends clean').toBe(false); // (a markSceneSaved before the guard is a no-op here: same edit version)
  });

  // The world the bytes would come from is destroyed by the New Scene, and the serialize read every entity after its await
  // from the NEW one: one world's entity list written with another's data (#2001 S8b: the save's instance entries then
  // named the new world's entities, refused, and marked the NEW world unsavable). It stops instead, writing nothing.
  // Mutation: drop `sameWorld()` after the preload in `serializeSceneScoped`.
  it('…and one landing while the save SERIALIZES (a prefab instance\'s source is awaited there): nothing is written', async () => {
    await instantiate();
    serializeHook.during = () => newScene();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await saveScene({ path: SCENE_PATH, allowDialog: false });
    warn.mockRestore();
    expect(r).toMatchObject({ saved: false, reason: 'superseded' });
    expect(written).toEqual([]);
    expect(whyWorldNotAuthored(), 'the new world is not marked by the old one\'s save').toBeNull();
    expect((await saveScene({ path: SCENE_PATH, allowDialog: false })).saved, 'and saves').toBe(true);
    written.length = 0;
    setCurrentScenePath(null);
    await newScene();
    expect(getCurrentScenePath()).toBeNull();
    expect(activeHistoryKey()).toBe('');
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('…and the same through the Save-As panel', async () => {
    hook.duringWrite = () => newScene();
    const r = await saveScene();
    expect(r).toMatchObject({ saved: true, path: SCENE_PATH });
    expect(getCurrentScenePath()).toBeNull();
    expect(activeHistoryKey()).toBe('');
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('OTHER SIDE: an untitled scene that was never saved has no file to reload from', async () => {
    await instantiate();
    emit(PREFAB_PATH, 'prefab');
    await settle();
    expect(loadScene).not.toHaveBeenCalled();
    expect(dumpSceneState().scenePath).toBeNull();
  });
});
