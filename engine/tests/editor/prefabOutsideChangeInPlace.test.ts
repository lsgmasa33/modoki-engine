/** #1873 R1 — OWNER RULING 2026-09-30, the Unity way: an OUTSIDE change to a prefab the open scene uses (a `git checkout`
 *  writing it, a delete, a put-back from the OS Trash) re-imports it and updates the instances IN PLACE, keeping the
 *  scene's unsaved edits, its dirty flag and its undo stack. It reverses #1164's disk-wins reload for prefab changes; an
 *  outside change to the scene FILE still reloads (pinned beside the prefab case in `deferredReloadWiring.test.ts`).
 *
 *  Driven through the watcher's own entry (`_watcherPrefabChangedForTests` is `handleSceneChanged({urlPath, kind:'prefab'})`, the
 *  message both watchers send), over a scene made to look OPEN and to use X, with `sceneManager.loadScene` spied — so
 *  "not reloaded" is asserted, not inferred. The world is loaded by the real loader (`loadSceneFile`) as in
 *  `prefabPark.test.ts`.
 *
 *  Mutations (run in the close-out): the prefab branch in `handleSceneChanged` skipped (the old reload) → the write,
 *  delete and put-back cases go red; `reexpandPlaceholders` a no-op → the put-back case goes red; `needsReload` always
 *  false → the clean-fallback case goes red. */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const route = vi.hoisted(() => ({ disk: new Map<string, string>() }));
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string }) => {
    const cur = route.disk.get(path);
    if (opts?.ifMatch !== undefined && (cur === undefined || sha(cur) !== opts.ifMatch)) return answer(409, { reason: 'if-match' });
    route.disk.set(path, content);
    return answer(200, { ok: true, path });
  },
  backendFetch: async () => answer(200, {}),
}));

async function serve(url: string): Promise<Response> {
  const hit = [...route.disk.keys()].find((p) => url.endsWith(p));
  if (!hit) return url.includes('/api/') ? answer(200, { files: [] }) : answer(404, {});
  return new Response(route.disk.get(hit)!, { status: 200 });
}

import {
  getCurrentWorld, setCurrentWorld, getAllEntities, getTraitByName, setRunMode,
  loadSceneFile, instantiatePrefabIntoWorld, destroyEntity, registerAsset, readTraitData, type SceneData,
} from '@modoki/engine/runtime';
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, markSceneSaved, undo } from '@modoki/engine/editor';
import { acquirePrefab, getCachedPrefab, releaseAllForScene } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { worldHasUnsavedEdits } from '../../packages/modoki/src/editor/scene/serialize';
import { canUndo } from '../../packages/modoki/src/editor/undo/undoManager';
import { _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { installEditorPrefabCacheWarm } from '../../packages/modoki/src/editor/scene/prefabCacheWarm';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { _watcherPrefabChangedForTests as reloadPrefabFromDisk } from '../../app/debug/agentBridge';
import { getPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { loadManifestJson, getGuidForPath } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { markSceneDirty, clearSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { UnresolvedPrefabRef } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { resetPrefabMarkRecord, commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { reimportPrefabsInPlace } from '../../packages/modoki/src/editor/scene/prefabReimport';
import { peekDirtyAsset, flushDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { localIdCounter } from '../../packages/modoki/src/runtime/core/localIdCounter';
import { createEntityWithUndo } from '@modoki/engine/editor';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';

registerAllTraits();
registerEditorAgentOps();
setActionCallback(pushAction);
const uninstallWarm = installEditorPrefabCacheWarm();

const X = 'cccccccc-0000-4000-8000-00000000187d';
const X_PATH = '/assets/prefabs/X.prefab.json';
const H = 'cccccccc-0000-4000-8000-00000000187b';
const H_PATH = '/assets/prefabs/H.prefab.json';
const SCENE_PATH = '/assets/scenes/R1873.scene.json';
const HOLDER = 'dddddddd-0000-4000-8000-000000001870';
const I1 = 'dddddddd-0000-4000-8000-000000001871';
const I2 = 'dddddddd-0000-4000-8000-000000001872';
const HI = 'dddddddd-0000-4000-8000-000000001874';
const KID = 'dddddddd-0000-4000-8000-00000000187e';
const Y = 'cccccccc-0000-4000-8000-00000000187f';
const Y_PATH = '/assets/prefabs/Y.prefab.json';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000187${n}`;

const row = (localId: number, name: string, parentId: number, nodeGuid: string, tf: Record<string, number> = {}) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0, ...tf } },
});
/** X = XR → XA, XB, as the FILE holds it. */
const diskDoc = (): PrefabFile => ({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [
  row(1, 'XR', 0, g(1)), row(2, 'XA', 1, g(2)), row(3, 'XB', 1, g(3)),
] } as unknown as PrefabFile);
/** X as the PARK holds it: XA at y=5, which the file does not have. */
const parkDoc = (): PrefabFile => ({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [
  row(1, 'XR', 0, g(1)), row(2, 'XA', 1, g(2), { y: 5 }), row(3, 'XB', 1, g(3)),
] } as unknown as PrefabFile);
/** H = HR → an instance of X: X nested in another prefab. */
const hDoc = (): PrefabFile => ({ id: H, version: 6, name: 'H', rootLocalId: 1, entities: [
  row(1, 'HR', 0, g(5)),
  { localId: 2, prefab: X, nodeGuid: g(6), traits: { EntityAttributes: { name: 'HX', parentId: 1, guid: '' } } },
] } as unknown as PrefabFile);
const scene = (): SceneData => ({
  id: 's1873', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER }, Transform: { x: 0, y: 0, z: 0 } } },
    { id: 2, prefab: X, guid: I1, traits: { EntityAttributes: { name: 'I1', parentId: HOLDER } } },
    { id: 3, prefab: X, guid: I2, traits: { EntityAttributes: { name: 'I2', parentId: HOLDER } } },
    { id: 4, prefab: H, guid: HI, traits: { EntityAttributes: { name: 'HI', parentId: HOLDER } } },
    { id: 5, guid: KID, traits: { EntityAttributes: { name: 'Kid', parentId: I1 }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
} as unknown as SceneData);
const emptyScene = (): SceneData => ({ id: 's-empty', version: 16, name: 'E', resources: [], entities: [] } as unknown as SceneData);

let sceneN = 0;
async function load(data: SceneData): Promise<void> {
  const prevScene = 187_300 + sceneN;
  const sid = 187_300 + ++sceneN;
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
  const eaMeta = getTraitByName('EntityAttributes')!;
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    loadModels: false,
    fetchPrefab: async (ref: string) => { await acquirePrefab(sid, ref); return (getCachedPrefab(ref) as object) ?? null; },
    onDeletePlaceholder: (id: number) => {
      const world = getCurrentWorld();
      for (const e of world.entities) if (e.id() === id) { destroyEntity(e, world); break; }
    },
    onInstantiatePrefab: async (source, parentId, rootTf, _o, _x, overrides, structure, nested, rootGuid, _f, nestedStructure) => {
      const id = instantiatePrefabIntoWorld(
        getCurrentWorld(), getCachedPrefab(source) as never, parentId, rootTf, source, overrides, structure, undefined, nested, nestedStructure,
      );
      if (id && rootGuid) {
        for (const e of getCurrentWorld().entities) {
          if (e.id() === id) e.set(eaMeta.trait, { ...(e.get(eaMeta.trait) as Record<string, unknown>), guid: rootGuid });
        }
      }
      return id ?? undefined;
    },
  });
  releaseAllForScene(prevScene);
}

const rootOf = (guid: string) => getAllEntities().find((e) => e.guid === guid)!.id;
const inInstance = (guid: string, name: string): number => {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const root = rootOf(guid);
  const mine = all.filter((e) => e.name === name && (() => { for (let c = byId.get(e.parentId); c; c = byId.get(c.parentId)) if (c.id === root) return true; return false; })());
  if (mine.length !== 1) throw new Error(`fixture: ${mine.length} entities named ${name} in ${guid}`);
  return mine[0]!.id;
};
const tfOf = (id: number) => readTraitData(id, getTraitByName('Transform')!) as { x: number; y: number };
const tf = (guid: string, name: string) => tfOf(inInstance(guid, name));
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

let loadScene: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  resetPrefabMarkRecord(); // the session's mark record (#1880) belongs to its own case
  setRunMode('stopped');
  clearHistory();
  clearDirtyAssets();
  _resetSceneAdoptionForTests();
  route.disk.clear();
  vi.stubGlobal('fetch', serve);
  registerAsset(X, X_PATH, 'prefab');
  registerAsset(H, H_PATH, 'prefab');
  route.disk.set(X_PATH, jsonFileBody(diskDoc()));
  route.disk.set(H_PATH, jsonFileBody(hDoc()));
  route.disk.set(SCENE_PATH, JSON.stringify(scene()));
  for (const k of [X, X_PATH, H, H_PATH]) setPrefabCache(k, null);
  await quietly(() => load(scene()));
  vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => { throw new Error('the open scene was reloaded'); });
  markSceneSaved();
});
afterEach(() => { vi.restoreAllMocks(); setRunMode('stopped'); });
afterAll(() => { uninstallWarm(); clearDirtyAssets(); for (const k of [X, X_PATH, H, H_PATH]) setPrefabCache(k, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

/** The file as a `git checkout` leaves it: XA at y=5. */
const outsideWrite = () => route.disk.set(X_PATH, jsonFileBody(parkDoc()));
const placeholders = () => [...getCurrentWorld().query(UnresolvedPrefabRef)].length;

describe('an outside change to a prefab the open scene uses re-imports it in place (#1873 R1)', () => {
  it('a write: every instance takes it (nested too), an unrelated unsaved edit, the dirty flag, undo and overrides survive, no reload', async () => {
    writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
    writeTraitFieldWithUndo(rootOf(HOLDER), getTraitByName('Transform')!, 'x', 3);
    expect(worldHasUnsavedEdits()).toBe(true);
    outsideWrite();

    await quietly(() => reloadPrefabFromDisk(X_PATH));

    expect(loadScene, 'the open scene was not reloaded').not.toHaveBeenCalled();
    expect(tf(I1, 'XA').y).toBe(5);
    expect(tf(I2, 'XA').y).toBe(5);
    expect(tf(HI, 'XA').y, 'the X nested in H').toBe(5);
    expect(tf(I1, 'XB').x, "I1's own override").toBe(4);
    expect(tfOf(rootOf(HOLDER)).x, 'the unrelated edit').toBe(3);
    expect(worldHasUnsavedEdits()).toBe(true);
    expect(canUndo()).toBe(true);
    await quietly(() => undo());
    expect(tfOf(rootOf(HOLDER)).x, 'and its undo still runs').toBe(0);
  });

  it('a write over a CLEAN scene leaves it clean and the stack as it was', async () => {
    outsideWrite();
    await quietly(() => reloadPrefabFromDisk(X_PATH));
    expect(loadScene).not.toHaveBeenCalled();
    expect(tf(I1, 'XA').y).toBe(5);
    expect(worldHasUnsavedEdits()).toBe(false);
    expect(canUndo()).toBe(false);
  });

  // R1 review F2/F3: the editor cache is WARM (the fixture used to leave it cold, so the eviction was unobservable), and the
  // dev editor's delete lands its PRUNED manifest before the event, so the path resolves to no guid by then. Mutation:
  // drop `evictDeletedEditorPrefabs(path)`, or ask "is it used" before the absent check — the editor cache keeps X.
  // #2056: the live instances are then shown as Missing Prefab through the reload Stop runs (`deletedPrefabsMissing.ts`) —
  // what that load builds is `trashShowsMissing.test.ts`'s; this fixture's `sceneManager.loadScene` is a stub, so here
  // the adopt is held to asking for it once, with the captured world, over the scene's own key. Mutation: drop the
  // conversion from `reimportOutsidePrefabChangesUnmarked` → no reload is asked.
  it('a delete evicts both caches, says so, and asks the reload that shows its instances as Missing Prefab', async () => {
    writeTraitFieldWithUndo(rootOf(HOLDER), getTraitByName('Transform')!, 'x', 3);
    loadManifestJson({ version: 1, assets: [{ guid: X, path: X_PATH, type: 'prefab' }, { guid: H, path: H_PATH, type: 'prefab' }] } as never, { prune: true });
    expect(await getPrefabSource(X), 'premise: the editor cache holds X').not.toBeNull();
    route.disk.delete(X_PATH);
    loadManifestJson({ version: 1, assets: [{ guid: H, path: H_PATH, type: 'prefab' }] } as never, { prune: true });
    expect(getGuidForPath(X_PATH), 'premise: the pruned manifest no longer maps X').toBeUndefined();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = getCurrentWorld();
    loadScene.mockImplementation(async () => ({ world }) as never);
    await reloadPrefabFromDisk(X_PATH);
    // Named as a delete of instances the scene HAS — decided through the path X lived at (Mutation: ask only the pruned
    // path's own keys — it reads as unused).
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/X\.prefab\.json was deleted outside the editor — its instances show as Missing Prefab/);
    expect(loadScene, 'the reload is asked once').toHaveBeenCalledTimes(1);
    expect(loadScene.mock.calls[0]![1], 'with the world captured before it').toMatchObject({ preloaded: { entities: expect.any(Array) } });
    expect(getCachedPrefabSync(X), 'the editor cache is evicted').toBeNull();
    expect(getCachedPrefab(X), 'and the loader\'s').toBeUndefined();
    expect(tfOf(rootOf(HOLDER)).x).toBe(3);
    expect(canUndo()).toBe(true);
  });

  it('a put-back re-expands the Missing Prefab placeholders in place, keeping unsaved work', async () => {
    // The scene loaded while X was missing: I1 and I2 are entry placeholders, and H's X row shows one too (ruling D, #2028:
    // before S5 it expanded to nothing).
    route.disk.delete(X_PATH);
    for (const k of [X, X_PATH]) setPrefabCache(k, null);
    await quietly(() => load(emptyScene()));
    await quietly(() => load(scene()));
    markSceneSaved();
    expect(placeholders(), 'premise: I1, I2 and H\'s X row are placeholders').toBe(3);
    writeTraitFieldWithUndo(rootOf(HOLDER), getTraitByName('Transform')!, 'x', 3);
    // I2 belongs to a BASE scene (R1 review F5): its re-expanded subtree keeps that scene. Mutation: drop the stamp — red.
    const BASE = '/assets/scenes/Base1873.scene.json';
    const i2 = getCurrentWorld().entities.find((e) => e.id() === rootOf(I2))!;
    const eaT = getTraitByName('EntityAttributes')!.trait;
    i2.set(eaT, { ...(i2.get(eaT) as object), sourceScene: BASE });
    // The template lists its ROOT LAST (R1 review F5): the new root does not take the placeholder's recycled id first, so
    // a child left pointing at the old id would hang off a member. Mutation: drop the children's re-parent — Kid is lost.
    route.disk.set(X_PATH, jsonFileBody({ ...parkDoc(), entities: [...parkDoc().entities.slice(1), parkDoc().entities[0]!] } as never)); // back from the Trash

    await quietly(() => reloadPrefabFromDisk(X_PATH));

    expect(loadScene).not.toHaveBeenCalled();
    expect(placeholders(), 'no placeholder is left').toBe(0);
    expect(tf(I1, 'XA').y, 'I1 is an instance again').toBe(5);
    expect(tf(I2, 'XA').y).toBe(5);
    expect(tf(HI, 'XA').y, 'H\'s unexpanded X row too').toBe(5);
    expect(getAllEntities().find((e) => e.guid === I1)!.parentId, 'under its parent').toBe(rootOf(HOLDER));
    expect(getAllEntities().find((e) => e.guid === KID)!.parentId, "the placeholder's child is under the new root").toBe(rootOf(I1));
    const eaOf = (id: number) => (getCurrentWorld().entities.find((e) => e.id() === id)!.get(getTraitByName('EntityAttributes')!.trait) as { sourceScene: string });
    expect(eaOf(rootOf(I2)).sourceScene, 'the base instance keeps its scene').toBe(BASE);
    expect(eaOf(inInstance(I2, 'XA')).sourceScene, 'its members too').toBe(BASE);
    expect(eaOf(rootOf(I1)).sourceScene, 'a primary one stays primary').toBe('');
    expect(tfOf(rootOf(HOLDER)).x).toBe(3);
    expect(canUndo()).toBe(true);
  });

  // R1 review F1: a prefab a loaded scene OWNS with no live frame (a timeline clip, an empty pool, a game trait's ref) —
  // its loader copy is replaced from the file, never left evicted until the next load. Mutation: drop the
  // `acquirePrefab`/`replaceCachedPrefab` for the owning scenes — Y reads undefined.
  it('a prefab a loaded scene owns with no live instance keeps its loader copy, the file\'s', async () => {
    registerAsset(Y, Y_PATH, 'prefab');
    const yDoc = (y: number) => ({ id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(9), { y })] });
    route.disk.set(Y_PATH, jsonFileBody(yDoc(0) as never));
    await acquirePrefab(187_399, Y);
    expect(getCachedPrefab(Y), 'premise: the scene owns Y in the loader').toBeDefined();
    vi.spyOn(sceneManager, 'getLoadedScenes').mockReturnValue(new Map([[187_399, { prefabRefs: new Set([Y]) }]]) as never);
    route.disk.set(Y_PATH, jsonFileBody(yDoc(7) as never));
    await quietly(() => reloadPrefabFromDisk(Y_PATH));
    expect(loadScene).not.toHaveBeenCalled();
    expect(((getCachedPrefab(Y) as PrefabFile | undefined)?.entities[0]?.traits as { Transform?: { y: number } } | undefined)?.Transform?.y).toBe(7);
    releaseAllForScene(187_399);
  });

  // R1 review F4: what the in-place path cannot reach reloads a CLEAN scene through the watcher's own reload, and never a
  // dirty one. X comes back as a document with no root, so I1/I2 stay placeholders. Mutation: `if (!needsReload) return`
  // always returns — the clean case goes red; `needsReload` ignores the scene — the dirty case goes red.
  it.each([['clean', false], ['dirty', true]] as const)('a put-back it cannot expand over a %s scene', async (_label, dirty) => {
    route.disk.delete(X_PATH);
    for (const k of [X, X_PATH]) setPrefabCache(k, null);
    await quietly(() => load(emptyScene()));
    await quietly(() => load(scene()));
    markSceneSaved();
    expect(placeholders(), 'premise (I1, I2, H\'s X row: ruling D)').toBe(3);
    if (dirty) markSceneDirty('g-r1-dirty');
    try {
      route.disk.set(X_PATH, jsonFileBody({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [] } as never));
      await quietly(() => reloadPrefabFromDisk(X_PATH));
      expect(placeholders(), 'premise: still placeholders').toBe(3);
      if (dirty) {
        expect(loadScene, 'unsaved work is never reloaded away').not.toHaveBeenCalled();
        expect(useEditorStore.getState().toast?.message ?? '').toMatch(/could not be updated in place/);
      } else {
        expect(loadScene, 'a clean scene reloads what the in-place path could not reach').toHaveBeenCalledTimes(1);
      }
    } finally { clearSceneDirty('g-r1-dirty'); }
  });
  // R1 re-review 1: a prefab nothing in the open scene uses is said as the #1702 gate says it — not as a re-import of
  // instances or a delete of instances it does not have (QA-PREFAB-0027 polls for this line). Mutation: report an unused
  // path as `reimported`/`deleted` — the line is missing.
  it('a prefab nothing uses: its write and its delete log the #1702 line, and nothing else', async () => {
    const Z = 'cccccccc-0000-4000-8000-0000000018a1';
    const Z_PATH = '/assets/prefabs/Z.prefab.json';
    loadManifestJson({ version: 1, assets: [{ guid: X, path: X_PATH, type: 'prefab' }, { guid: H, path: H_PATH, type: 'prefab' }, { guid: Z, path: Z_PATH, type: 'prefab' }] } as never, { prune: true });
    const zDoc = { id: Z, version: 6, name: 'Z', rootLocalId: 1, entities: [row(1, 'ZR', 0, g(8))] };
    route.disk.set(Z_PATH, jsonFileBody(zDoc as never));
    expect(await getPrefabSource(Z), 'premise: the editor has read Z').not.toBeNull();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = () => log.mock.calls.map((c) => String(c[0]));
    route.disk.set(Z_PATH, jsonFileBody({ ...zDoc, name: 'Z2' } as never));
    await reloadPrefabFromDisk(Z_PATH);
    expect(lines()).toContain(`[agentBridge] prefab change not used by the open scene — no reload (${Z_PATH})`);
    expect(getCachedPrefabSync(Z)?.name, 'the key it read is brought up to date').toBe('Z2');
    log.mockClear();
    route.disk.delete(Z_PATH);
    loadManifestJson({ version: 1, assets: [{ guid: X, path: X_PATH, type: 'prefab' }, { guid: H, path: H_PATH, type: 'prefab' }] } as never, { prune: true });
    await reloadPrefabFromDisk(Z_PATH);
    expect(lines()).toContain(`[agentBridge] prefab change not used by the open scene — no reload (${Z_PATH})`);
    expect(lines().join('\n')).not.toMatch(/re-imported|deleted outside the editor/);
    expect(getCachedPrefabSync(Z), 'and a delete evicts it').toBeNull();
    expect(loadScene).not.toHaveBeenCalled();
  });

  /** An outside RENAME (a `git mv`): the manifest maps Y to its new path, and the watcher sends an unlink of the old path
   *  and an add of the new. The owning scene re-acquires Y there (R1 re-review 3). `onAcquireRead` runs inside the add's
   *  second fetch — the acquire's — to land an editor write in that window (R1 re-review 2). */
  async function renameY(onAcquireRead?: () => void, opts: { deleteFirst?: boolean } = {}): Promise<void> {
    const Y_OLD = '/assets/prefabs/Yold.prefab.json';
    const yDoc = (y: number) => ({ id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(9), { y })] });
    registerAsset(Y, Y_OLD, 'prefab');
    route.disk.set(Y_OLD, jsonFileBody(yDoc(0) as never));
    await acquirePrefab(187_398, Y);
    expect(getCachedPrefab(Y), 'premise: the scene owns Y').toBeDefined();
    setPrefabCache(Y, yDoc(0) as never); // the editor has read Y, so its key is re-seated (not left cold)
    vi.spyOn(sceneManager, 'getLoadedScenes').mockReturnValue(new Map([[187_398, { prefabRefs: new Set([Y, Y_OLD]) }]]) as never);
    route.disk.delete(Y_OLD);
    if (opts.deleteFirst) {
      loadManifestJson({ version: 1, assets: [{ guid: X, path: X_PATH, type: 'prefab' }, { guid: H, path: H_PATH, type: 'prefab' }] } as never, { prune: true });
      await quietly(() => reloadPrefabFromDisk(Y_OLD));
    }
    route.disk.set(Y_PATH, jsonFileBody(yDoc(7) as never));
    registerAsset(Y, Y_PATH, 'prefab');
    if (!opts.deleteFirst) await quietly(() => reloadPrefabFromDisk(Y_OLD));
    let reads = 0;
    vi.stubGlobal('fetch', async (u: string) => {
      if (String(u).endsWith(Y_PATH) && ++reads === 2) onAcquireRead?.();
      return serve(u);
    });
    await quietly(() => reloadPrefabFromDisk(Y_PATH));
    vi.stubGlobal('fetch', serve);
  }

  // Mutation: drop the acquire loop — the new path has no owner, so the loader's copy is evicted.
  it('an outside rename keeps the owning scene\'s loader copy, under the new path', async () => {
    await renameY();
    expect(((getCachedPrefab(Y) as PrefabFile | undefined)?.entities[0]?.traits as { Transform?: { y: number } } | undefined)?.Transform?.y).toBe(7);
    releaseAllForScene(187_398);
  });

  // Mutation: drop the re-check after the acquires — the stale file bytes overwrite the Apply the editor just seated.
  // The loader must not hold Y when the add is adopted, or the acquire reads nothing: a DELETE first (the GUID gone from the
  // manifest), then Y put back at another path in a later batch — a move in one batch rekeys the loader's copy (#2067).
  it('an editor write landing during the acquire\'s read is kept', async () => {
    const applied = { id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(9), { y: 9 })] } as unknown as PrefabFile;
    await renameY(() => { setPrefabCache(Y, applied); }, { deleteFirst: true });
    expect((getCachedPrefabSync(Y)!.entities[0]!.traits as { Transform: { y: number } }).Transform.y, 'the Apply stands').toBe(9);
    releaseAllForScene(187_398);
  });
});

/** #1880 W4: the watcher's every prefab branch is the prefab step's `'adopt'` landing — REPLACE, never evict (#1308). The
 *  branches with no scene file open and in prefab edit evicted the runtime copy, so a synchronous runtime reader (a pooled
 *  scroll view, a timeline spawn) read `undefined` until the next scene load. */
describe('#1880 W4: an outside change is adopted through the prefab step on every watcher branch', () => {
  const runtimeXA = () => ((getCachedPrefab(X) as PrefabFile | undefined)?.entities.find((e) => e.name === 'XA')?.traits as { Transform?: { y: number } } | undefined)?.Transform?.y;

  // Mutation: the caches-only branch goes back to `evictRuntimePrefabs(); refreshEditorPrefabs()` — the reader reads undefined.
  it('in prefab edit, a synchronous runtime reader reads the file\'s document, not undefined, and nothing reloads', async () => {
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: `/__prefab-edit__/${H}` } as never);
    outsideWrite();
    await quietly(() => reloadPrefabFromDisk(X_PATH));
    expect(loadScene).not.toHaveBeenCalled();
    expect(runtimeXA()).toBe(5);
    expect(getCachedPrefabSync(X)?.entities.find((e) => e.name === 'XA')?.traits).toMatchObject({ Transform: { y: 5 } });
  });

  it('with no scene file open, the same', async () => {
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null as never);
    outsideWrite();
    await quietly(() => reloadPrefabFromDisk(X_PATH));
    expect(runtimeXA()).toBe(5);
  });

  // Hub ruling (2026-09-30): an outside write cannot be refused, but a file that would contain itself is not seated; the
  // editor keeps what it held, and the report names the prefab that closes the cycle. Mutation: skip the adopt's I16 —
  // X is seated nesting H, which nests X.
  it('a file written to contain itself is not seated, and the report names the cycle', async () => {
    const before = getCachedPrefabSync(X);
    route.disk.set(X_PATH, jsonFileBody({ ...diskDoc(), entities: [...diskDoc().entities, { localId: 4, prefab: H, nodeGuid: g(7), traits: { EntityAttributes: { name: 'XH', parentId: 1, guid: '' } } }] } as never));
    const report = await quietly(() => reimportPrefabsInPlace([X_PATH]));
    expect(report.failed).toEqual([{ path: X_PATH, reason: expect.stringMatching(new RegExp(`would contain itself \\(it nests ${H_PATH}, which nests it back\\)`)) }]);
    expect(report.reimported).toEqual([]);
    expect(getCachedPrefabSync(X)).toBe(before);
    expect(tf(I1, 'XA').y).toBe(0);
  });
});

/** #1880 W4, hub ruling (A): the mark says "no number below me is handed out again", and an outside REWIND (a `git
 *  checkout` of an older document) lowered it — the next minting writer, which reads the cached document's mark, then
 *  numbered a new row at a number the scene still keys a newer member by. The adopt raises the mark in the CACHES only,
 *  to the session's record and to what the caches held. */
describe('#1880 close-out review: what the adopt must not seat, and what it must take again', () => {
  // Finding 1. #1813: JSON that is not a prefab (no `entities`) is not a prefab document. Mutation: drop the
  // `isPrefabDocument` test in `landAdopts` — the adopt throws ("nodes is not iterable") in the watcher's path.
  it('an outside write of JSON that is not a prefab is reported, and the editor keeps what it held', async () => {
    const before = getCachedPrefabSync(X);
    route.disk.set(X_PATH, JSON.stringify({ id: X, name: 'X' }));
    const report = await quietly(() => reimportPrefabsInPlace([X_PATH]));
    expect(report.failed).toEqual([{ path: X_PATH, reason: expect.stringMatching(/could not be read as a prefab/) }]);
    expect(getCachedPrefabSync(X)).toBe(before);
    expect(tf(I1, 'XA').y).toBe(0);
  });

  // Finding 3. A checkout that FLIPS a nesting direction arrives one file per event: X (now nesting H) first, while the
  // caches still hold the old H (which nests X) — a cycle that is not there once H's event lands. Mutation: drop the
  // retry in `landAdopts` — X stays refused, and I1 never gains the H it now nests.
  it('a file refused as a cycle is taken again once the other file of the change lands', async () => {
    const xNestsH = { ...diskDoc(), entities: [...diskDoc().entities, { localId: 4, prefab: H, nodeGuid: g(7), traits: { EntityAttributes: { name: 'XH', parentId: 1, guid: '' } } }] };
    route.disk.set(X_PATH, jsonFileBody(xNestsH as never));
    route.disk.set(H_PATH, jsonFileBody({ ...hDoc(), entities: [hDoc().entities[0]!] } as never));
    await quietly(() => reloadPrefabFromDisk(X_PATH));
    expect((getCachedPrefab(X) as PrefabFile).entities.map((e) => e.localId), 'premise: X refused while the old H nests it').toEqual([1, 2, 3]);
    await quietly(() => reloadPrefabFromDisk(H_PATH));
    expect((getCachedPrefab(X) as PrefabFile).entities.map((e) => e.localId)).toEqual([1, 2, 3, 4]);
    expect(() => inInstance(I1, 'HR'), 'I1 is rebuilt onto it: the H it now nests (its root) is in it').not.toThrow();
    expect(loadScene).not.toHaveBeenCalled();
  });
});

describe('#1880 close-out re-review: a refused cycle waits for the prefab that closed it, and nothing else', () => {
  const xNests = (ref: string) => ({ ...diskDoc(), entities: [...diskDoc().entities, { localId: 4, prefab: ref, nodeGuid: g(7), traits: { EntityAttributes: { name: 'XN', parentId: 1, guid: '' } } }] });
  const yNestsX = () => ({ id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(8)), { localId: 2, prefab: X, nodeGuid: g(9), traits: { EntityAttributes: { name: 'YX', parentId: 1, guid: '' } } }] });
  const yAlone = () => ({ id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(8))] });

  // Re-review gap 1: a cycle through THREE prefabs is broken by its middle link. X (now nesting H) meets X→H→Y→X in the
  // caches; Y's event (Y no longer nests X) breaks it. Mutation: store only the first link (`new Set([hit.ref])`) — Y is
  // not it, and X is never taken again.
  it('a cycle through three prefabs is taken again when its middle link lands', async () => {
    registerAsset(Y, Y_PATH, 'prefab');
    const hNestsY = { ...hDoc(), entities: [hDoc().entities[0]!, { localId: 2, prefab: Y, nodeGuid: g(6), traits: { EntityAttributes: { name: 'HY', parentId: 1, guid: '' } } }] };
    setPrefabCache(H, hNestsY as never);
    setPrefabCache(Y, yNestsX() as never);
    route.disk.set(X_PATH, jsonFileBody(xNests(H) as never));
    const first = await quietly(() => reimportPrefabsInPlace([X_PATH]));
    expect(first.failed[0]?.reason, 'premise: refused through H → Y → X').toMatch(/would contain itself/);
    route.disk.set(Y_PATH, jsonFileBody(yAlone() as never));
    await quietly(() => reimportPrefabsInPlace([Y_PATH]));
    expect((getCachedPrefab(X) as PrefabFile).entities.map((e) => e.localId)).toEqual([1, 2, 3, 4]);
    for (const k of [Y, H]) setPrefabCache(k, null as never);
  });

  // Re-review gap 2: the cycle is broken by an editor WRITE, not an outside change. Mutation: drop the retry after
  // `landFiles`' rebase — X stays on its old document.
  it('a cycle broken by an editor write is taken again', async () => {
    route.disk.set(X_PATH, jsonFileBody(xNests(H) as never));
    const first = await quietly(() => reimportPrefabsInPlace([X_PATH]));
    expect(first.failed[0]?.reason, 'premise: refused while H nests X').toMatch(/would contain itself/);
    const hAlone = { ...hDoc(), entities: [hDoc().entities[0]!] } as PrefabFile;
    expect((await quietly(() => commitPrefabWrite(H, hAlone, { expected: hDoc() }))).ok).toBe(true);
    expect((getCachedPrefab(X) as PrefabFile).entities.map((e) => e.localId)).toEqual([1, 2, 3, 4]);
  });

  // Re-review gap 3: the prefab that closed the cycle is DELETED outside — that may end the cycle too, so the refused file
  // is examined again (here it is still one: H's live frame still nests X, #1866's reader). Mutation: leave the deleted
  // keys out of `landed` — X is never looked at again, and the delete's report has no row for it.
  it('a deleted closer takes the refused file again', async () => {
    route.disk.set(X_PATH, jsonFileBody(xNests(H) as never));
    const first = await quietly(() => reimportPrefabsInPlace([X_PATH]));
    expect(first.failed[0]?.reason, 'premise: refused while H nests X').toMatch(/would contain itself/);
    route.disk.delete(H_PATH);
    const gone = await quietly(() => reimportPrefabsInPlace([H_PATH]));
    expect(gone.deleted).toEqual([H_PATH]);
    expect(gone.failed.map((f) => f.path), 'X was examined again').toEqual([X_PATH]);
  });

  // Re-review 3, item 2: a WRITE of the refused file itself does not retry it — re-read, it would be noted as changed (a
  // read of X in flight refused for this step's own write) and seated a second time. Mutation: exclude nothing in
  // `landFiles`' retry — the cache holds the re-read copy, not the document the write seated.
  it('a write of the refused file itself does not take it again', async () => {
    route.disk.set(X_PATH, jsonFileBody(xNests(H) as never));
    await quietly(() => reimportPrefabsInPlace([X_PATH]));
    const fixed = { ...diskDoc(), name: 'X fixed' } as PrefabFile;
    expect((await quietly(() => commitPrefabWrite(X, fixed, { expected: xNests(H) as never }))).ok).toBe(true);
    expect(getCachedPrefabSync(X)).toBe(fixed);
  });

  // X nests Y while Y (held, nothing live uses it) nests X: a genuine cycle. An unrelated outside change to H lands after —
  // it must not re-read X. Mutation: retry every refused path once anything lands (`closedBy` → true) — X, fixed on
  // disk meanwhile with no event of its own, is re-read and re-seated (a new document object).
  it('an unrelated adopt does not re-read a path refused as a cycle', async () => {
    registerAsset(Y, Y_PATH, 'prefab');
    const yNestsX = { id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(8)), { localId: 2, prefab: X, nodeGuid: g(9), traits: { EntityAttributes: { name: 'YX', parentId: 1, guid: '' } } }] };
    setPrefabCache(Y, yNestsX as never);
    route.disk.set(Y_PATH, jsonFileBody(yNestsX as never));
    route.disk.set(X_PATH, jsonFileBody({ ...diskDoc(), entities: [...diskDoc().entities, { localId: 4, prefab: Y, nodeGuid: g(7), traits: { EntityAttributes: { name: 'XY', parentId: 1, guid: '' } } }] } as never));
    const refused = await quietly(() => reimportPrefabsInPlace([X_PATH]));
    expect(refused.failed[0]?.reason, 'premise: X is refused as a cycle').toMatch(/would contain itself/);
    const before = getCachedPrefab(X);
    route.disk.set(X_PATH, jsonFileBody(diskDoc())); // fixed on disk, with no event of its own yet
    route.disk.set(H_PATH, jsonFileBody({ ...hDoc(), name: 'H edited' } as never));
    const other = await quietly(() => reimportPrefabsInPlace([H_PATH]));
    expect(other.reimported, 'premise: the unrelated adopt landed').toEqual([H_PATH]);
    expect(getCachedPrefab(X), 'X was not re-read').toBe(before);
    setPrefabCache(Y, null as never);
  });
});

describe('#1880 W4 (A): an outside rewind does not lower the mark any minting writer reads', () => {
  /** The newer X: XN added at 4, the mark at 5. */
  const newer = (): PrefabFile => ({ ...diskDoc(), nextLocalId: 5, entities: [...diskDoc().entities, row(4, 'XN', 1, g(4))] } as unknown as PrefabFile);
  const rewind = async () => {
    route.disk.set(X_PATH, jsonFileBody(newer()));
    for (const k of [X, X_PATH]) setPrefabCache(k, null);
    await quietly(() => load(emptyScene()));
    await quietly(() => load(scene()));
    markSceneSaved();
    expect(localIdCounter(getCachedPrefab(X) as PrefabFile), 'premise: the loader holds the newer mark').toBe(5);
    route.disk.set(X_PATH, jsonFileBody(diskDoc())); // the rewind: rows 1-3, no mark (it derives 4)
    await quietly(() => reloadPrefabFromDisk(X_PATH));
  };

  // Mutation: drop the adopt's raise (`need` ignored) — the cached mark is 4, and the Apply below numbers its row 4: XN's.
  it('the cached document keeps the mark, and an Apply numbers its new row above it — not at the number XN had', async () => {
    await rewind();
    expect(getCachedPrefabSync(X)!.entities.map((e) => e.name), 'the rewind was taken').toEqual(['XR', 'XA', 'XB']);
    expect(localIdCounter(getCachedPrefabSync(X)!)).toBe(5);
    createEntityWithUndo('Add', rootOf(I2), [{ name: 'Transform', data: {} }, { name: 'EntityAttributes', data: { name: 'New', parentId: rootOf(I2) } }], () => {});
    const keys = collectInstanceOverrideKeys(rootOf(I2), getCachedPrefabSync(X)!);
    const applied = await quietly(() => applyToPrefabWithUndo(rootOf(I2), new Set(keys.all)));
    expect(applied.applied, JSON.stringify(applied)).toBe(true);
    const written = JSON.parse(route.disk.get(X_PATH)!) as PrefabFile & { nextLocalId: number };
    expect(written.entities.find((e) => e.name === 'New')!.localId).toBe(5);
    expect(written.nextLocalId).toBe(6);
  });

  // Pin (1): the raise changes nothing a human sees as unsaved. Mutation: land the raise as a PARK — red.
  it('the raise is not unsaved work: no park, the scene clean, the stack empty', async () => {
    await rewind();
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    expect(worldHasUnsavedEdits()).toBe(false);
    expect(canUndo()).toBe(false);
  });

  // Pin (3): the raise reaches the file with the next real write, and a Save with no prefab change writes nothing.
  // Mutation: the write's mark ignores the editor's document — the file is written at 4.
  it('a Save writes nothing for it, and the next write carries it to the file', async () => {
    await rewind();
    const text = route.disk.get(X_PATH);
    expect((await quietly(() => flushDirtyAssets())).saved).toEqual([]);
    expect(route.disk.get(X_PATH)).toBe(text);
    const edited = { ...diskDoc(), name: 'X edited' } as PrefabFile;
    expect((await quietly(() => commitPrefabWrite(X, edited, { expected: diskDoc() }))).ok).toBe(true);
    expect((JSON.parse(route.disk.get(X_PATH)!) as { nextLocalId?: number }).nextLocalId).toBe(5);
  });
});
