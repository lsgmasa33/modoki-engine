/** #1745: a prefab edit-open saves the open scene on the way in, so the exit's reload from disk keeps its edits. That save
 *  ran BEFORE the two decisions that say not to: the caller asked to discard the edits (the agent's `discardUnsaved`,
 *  which the op's guard lets through), or a newer scene request superseded this one while it waited (#1700). Both wrote
 *  the discarded work into the scene file. Found by #1723 (E7 second pass), OBSERVED live on anim-bug for the first.
 *
 *  Driven through the real `openPrefabForEditing`, `loadScene`, `saveScene` and adoption owner; only `SceneManager`'s load
 *  (it mints a world, and can hold its post-swap tail), the file write and the prefab rebuilds are stubbed, as in
 *  `sceneAdoption.test.ts`.
 *
 *  Mutation checked: move the `stillNewest()` check back below the save → "superseded" goes red; drop `!opts.discardUnsaved`
 *  → "discardUnsaved" goes red; skip the save always → the accept side goes red. Nothing else in the file moves. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sm = vi.hoisted(() => ({ path: '', holdTail: new Map<string, Promise<void>>(), preSwap: new Set<(e: unknown) => void>(), minted: [] as { destroy(): void }[] }));
const writes = vi.hoisted(() => [] as { path: string; content: string }[]);

vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const promote = async () => {
    const { createWorld } = await import('koota');
    const { setCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/world');
    return (after: () => void) => { const w = createWorld(); sm.minted.push(w); setCurrentWorld(w); after(); return w; };
  };
  return { ...real, sceneManager: {
    getCurrent: () => (sm.path ? { path: sm.path, guid: 'g-' + sm.path } : null),
    getNext: () => null, getLoadedScenes: () => new Map(), getCurrentBaseScene: () => undefined,
    loadScene: (path: string) => (async () => {
      const swap = await promote();
      await Promise.resolve();
      const world = swap(() => { sm.path = path; });
      const tail = sm.holdTail.get(path);
      if (tail) await tail;
      await Promise.resolve();
      return { world, keptBaseGuids: new Set<string>() };
    })(),
    replaceWorldContent: async (populate: (w: unknown) => void) => { const swap = await promote(); const w = swap(() => { sm.path = ''; }); populate(w); return w; },
  } };
});
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  writeAssetFile: async (path: string, content: string) => { writes.push({ path, content }); return { ok: true as const }; },
}));
vi.mock('../../packages/modoki/src/editor/scene/prefab', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  refreshPrefabSourceForPath: async () => {}, rebaseStaleInstances: async () => 0,
}));

import { setRunMode } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getCurrentWorld, setCurrentWorld, spawnEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { openPrefabForEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { loadScene, setCurrentScenePath, markSceneSaved } from '../../packages/modoki/src/editor/scene/serialize';
import { _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { _resetHistoryContexts, swapHistory } from '../../packages/modoki/src/editor/undo/undoManager';

registerAllTraits();
vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {}, clear: () => {} });
const SCENE = '/assets/scenes/Station.json';
const OTHER = '/assets/scenes/Other.json';
const P1 = { path: '/games/x/assets/prefabs/Crate.prefab.json', name: 'Crate' };
const doc = (id: string, name: string) => ({ id, version: 2, name, rootLocalId: 1, entities: [{ localId: 1, name, traits: { EntityAttributes: { name, parentId: 0, guid: '' } } }] });
const home = getCurrentWorld();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function until(c: () => boolean) { for (let i = 0; i < 100 && !c(); i++) await tick(); expect(c()).toBe(true); }
const names = (content: string) => (JSON.parse(content).entities as { name: string; prefab?: string }[]).map((e) => e.name + (e.prefab ? '@' + e.prefab : ''));
function spawnNamed(name: string) {
  const ea = getTraitByName('EntityAttributes')!.trait;
  spawnEntity(getCurrentWorld(), ea({ name, parentId: 0, guid: '', sortOrder: 0, isActive: true } as never));
}

beforeEach(() => {
  for (const k of ['log', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => {});
  setRunMode('stopped'); _resetHistoryContexts(); swapHistory(''); setCurrentScenePath(null); markSceneSaved();
  useEditorStore.getState().closePrefabEditor(); _resetSceneAdoptionForTests();
  sm.path = ''; sm.holdTail.clear(); writes.length = 0;
  // @ts-expect-error stub
  globalThis.fetch = vi.fn(async (url: string) => { const d = String(url).includes('Barrel') ? doc('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2698', 'Barrel') : doc('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1698', 'Crate'); return { ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d }; });
});
afterEach(async () => { await tick(); setCurrentWorld(home); for (const w of sm.minted.splice(0)) w.destroy(); vi.restoreAllMocks(); });


describe('a prefab edit-open saves the scene only when its caller keeps the edits (#1745)', () => {
  it('ACCEPT SIDE: a plain edit-open saves the unsaved work, so the exit\'s reload from disk keeps it', async () => {
    await loadScene(SCENE);
    writes.length = 0;
    spawnNamed('KeptWork');
    await openPrefabForEditing(P1);
    expect(useEditorStore.getState().editingPrefab?.path, 'premise: the open entered the prefab').toBe(P1.path);
    expect(writes.filter((w) => w.path === SCENE).map((w) => names(w.content))).toEqual([['KeptWork']]);
  });

  it('discardUnsaved: the work the caller said to throw away is NOT written to the scene file', async () => {
    await loadScene(SCENE);
    writes.length = 0;
    spawnNamed('UnsavedExperiment');
    await openPrefabForEditing(P1, { discardUnsaved: true });
    expect(useEditorStore.getState().editingPrefab?.path, 'premise: the open entered the prefab').toBe(P1.path);
    expect(writes.filter((w) => w.path === SCENE)).toEqual([]);
  });

  it('superseded: an edit-open a newer load replaced while it waited writes nothing', async () => {
    await loadScene(SCENE);
    writes.length = 0;
    spawnNamed('UnsavedExperiment');
    let openFetch!: () => void; const fetchGate = new Promise<void>((r) => { openFetch = r; });
    const realFetch = globalThis.fetch; let reached = false;
    // @ts-expect-error stub
    globalThis.fetch = vi.fn(async (u: string) => { if (String(u) === P1.path) { reached = true; await fetchGate; } return realFetch(u); });
    const open = openPrefabForEditing(P1);
    await until(() => reached);
    let releaseOther!: () => void; sm.holdTail.set(OTHER, new Promise<void>((r) => { releaseOther = r; }));
    const load = loadScene(OTHER); // the newer request, e.g. an agent's load_scene {discardUnsaved}
    openFetch();
    await open;
    releaseOther(); await load;
    expect(sm.path, 'premise: the newer load won').toBe(OTHER);
    expect(useEditorStore.getState().editingPrefab, 'premise: the edit-open did not enter').toBeNull();
    expect(writes.filter((w) => w.path === SCENE)).toEqual([]);
  });
});
