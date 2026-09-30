/** #1873 S2 — `modoki_discard_asset_edits` on a PARKED prefab re-imports it IN PLACE (`reimportPrefabsInPlace`): both
 *  caches take the file's document and every live instance is rebased onto it, keeping its own overrides. It used to go
 *  through the watcher's path "as if the file had just changed" — the #1164 disk-wins reload of the whole open scene — and
 *  an unrelated unsaved scene edit and the undo stack went with it, while the reply said only that the prefab was reloaded.
 *
 *  The state a discard meets is built as `prefabPark.test.ts` builds it: X parked (XA at y=5, the file y=0) and the live
 *  instances expanded from the park by a world swap — what an Apply's undo leaves. The scene is made to look OPEN and to
 *  use X (`sceneManager.getCurrent`, a live instance), so the old path really reaches `sceneManager.loadScene`; that is
 *  spied, so "no reload" is asserted, not inferred from the values.
 *
 *  Mutations (each run, see the close-out): the discard goes back to the watcher's path (`handleSceneChanged`) → every case goes red
 *  (loadScene called, the edit or the stack gone); `markSceneDirty` inside the re-import → the clean-scene case goes red;
 *  the replay routes an in-place entry to `handleSceneChanged` → the deferred case goes red (loadScene called). */

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
import { parkPrefab, peekDirtyAsset, clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { worldHasUnsavedEdits } from '../../packages/modoki/src/editor/scene/serialize';
import { canUndo } from '../../packages/modoki/src/editor/undo/undoManager';
import { _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { installEditorPrefabCacheWarm } from '../../packages/modoki/src/editor/scene/prefabCacheWarm';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp, replaySuppressedSceneReloads, peekSuppressedSceneReloads } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();
setActionCallback(pushAction);
const uninstallWarm = installEditorPrefabCacheWarm();

const X = 'cccccccc-0000-4000-8000-000000001873';
const X_PATH = '/assets/prefabs/X.prefab.json';
const H = 'cccccccc-0000-4000-8000-00000000187b';
const H_PATH = '/assets/prefabs/H.prefab.json';
const SCENE_PATH = '/assets/scenes/S1873.scene.json';
const HOLDER = 'dddddddd-0000-4000-8000-000000001870';
const I1 = 'dddddddd-0000-4000-8000-000000001871';
const I2 = 'dddddddd-0000-4000-8000-000000001872';
const HI = 'dddddddd-0000-4000-8000-000000001874';
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
  // Park X, cold in both caches, then swap in: every instance of X — top-level and nested in H — is built from the park.
  parkPrefab(X_PATH, parkDoc(), diskDoc());
  await quietly(() => load(emptyScene()));
  await quietly(() => load(scene()));
  // The scene is OPEN at a path and uses X, so the watcher's path would reach its disk-wins reload.
  vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  loadScene = vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => { throw new Error('the open scene was reloaded'); });
  markSceneSaved();
});
afterEach(() => { vi.restoreAllMocks(); setRunMode('stopped'); });
afterAll(() => { uninstallWarm(); clearDirtyAssets(); for (const k of [X, X_PATH, H, H_PATH]) setPrefabCache(k, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

/** The instances show the FILE's document, each keeping its own overrides; both caches and the registry agree. */
function expectReimported(): void {
  expect(tf(I1, 'XA').y, 'I1 is rebuilt from the file').toBe(0);
  expect(tf(I2, 'XA').y, 'I2 too').toBe(0);
  expect(tf(HI, 'XA').y, 'and the X nested in H').toBe(0);
  expect((getCachedPrefabSync(X)!.entities[1]!.traits as { Transform: { y: number } }).Transform.y, 'editor cache').toBe(0);
  expect(((getCachedPrefab(X) as PrefabFile).entities[1]!.traits as { Transform: { y: number } }).Transform.y, 'runtime cache').toBe(0);
  expect(peekDirtyAsset(X_PATH), 'the park is gone').toBeNull();
}

describe('discarding a parked prefab re-imports it in place (#1873 S2)', () => {
  it('keeps an unrelated unsaved scene edit, its undo, and an instance\'s own override; the scene is not reloaded', async () => {
    expect(tf(I1, 'XA').y, 'premise: built from the park').toBe(5);
    expect(tf(HI, 'XA').y, 'premise: the nested X too').toBe(5);
    // An instance's own override, and an edit that has nothing to do with X.
    writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
    writeTraitFieldWithUndo(rootOf(HOLDER), getTraitByName('Transform')!, 'x', 3);
    expect(worldHasUnsavedEdits(), 'premise: the scene has unsaved edits').toBe(true);
    expect(canUndo()).toBe(true);

    const r = await quietly(() => runAgentOp('discard-asset-edits', { paths: [X_PATH] })) as { ok: boolean; discarded: string[]; reimported?: string[]; notRebased?: unknown[] };

    expect(r).toMatchObject({ ok: true, discarded: [X_PATH], reimported: [X_PATH] });
    expect(r.notRebased, 'every instance was rebased').toBeUndefined();
    expect(loadScene, 'the open scene was not reloaded from disk').not.toHaveBeenCalled();
    expectReimported();
    expect(tf(I1, 'XB').x, "I1's own override survived the rebase").toBe(4);
    expect(tfOf(rootOf(HOLDER)).x, 'the unrelated edit is still there').toBe(3);
    expect(worldHasUnsavedEdits(), 'still unsaved').toBe(true);
    expect(canUndo(), 'the undo stack is alive').toBe(true);
    await quietly(() => undo());
    expect(tfOf(rootOf(HOLDER)).x, 'and it undoes the edit').toBe(0);
  });

  // #1912: it answered ok:true with the failure in `reimportFailed`, which the tool description never mentioned — a
  // discard that left the editor showing the discarded document read as done. Mutation: return `{ ok: true, ...reply }`
  // unconditionally (drop the `reimportFailedPartial` branch) — this answers ok:true.
  it('a re-import that FAILS answers PARTIAL: the write is dropped, the failure named, and not to repeat the call', async () => {
    route.disk.set(X_PATH, '{ not json');

    const r = await quietly(() => runAgentOp('discard-asset-edits', { paths: [X_PATH] })) as {
      ok: boolean; code?: string; error?: string; options?: string[]; discarded: string[]; reimportFailed?: Array<{ path: string; reason: string }>;
    };

    expect(r).toMatchObject({ ok: false, code: 'PARTIAL', discarded: [X_PATH] });
    expect(r.reimportFailed?.map((f) => f.path)).toEqual([X_PATH]);
    expect(r.error).toContain(`the pending write(s) were dropped (${X_PATH}`);
    expect(r.error).toContain('Do NOT repeat the discard');
    expect(r.options?.[0]).toContain('modoki_refresh');
    expect(peekDirtyAsset(X_PATH), 'the write IS dropped').toBeNull();
    expect(tf(I1, 'XA').y, 'and the editor still shows the discarded document').toBe(5);
  });

  it('over a CLEAN scene: still clean, nothing to undo, and not reloaded', async () => {
    expect(worldHasUnsavedEdits(), 'premise: clean').toBe(false);
    expect(canUndo(), 'premise: an empty stack').toBe(false);

    await quietly(() => runAgentOp('discard-asset-edits', { paths: [X_PATH] }));

    expect(loadScene).not.toHaveBeenCalled();
    expectReimported();
    expect(worldHasUnsavedEdits(), 'the re-import added no scene edit').toBe(false);
    expect(canUndo()).toBe(false);
  });

  it('during Play it is deferred, and the replay after Stop is an in-place re-import, not a reload', async () => {
    writeTraitFieldWithUndo(rootOf(HOLDER), getTraitByName('Transform')!, 'x', 3);
    setRunMode('playing');
    const r = await quietly(() => runAgentOp('discard-asset-edits', { paths: [X_PATH] })) as { reimportDeferred?: string };
    expect(r.reimportDeferred, 'the reply says it waits').toMatch(/re-imported in place once/);
    expect(peekSuppressedSceneReloads()).toEqual([X_PATH]);
    expect(tf(I1, 'XA').y, 'nothing rebuilt during Play').toBe(5);

    setRunMode('stopped');
    // Stop settles authoring, whose listener replays (`onAuthoringSettled`); called here too, for a settle the fixture
    // does not raise. Either way the entry leaves the queue and the re-import lands.
    await quietly(async () => {
      await replaySuppressedSceneReloads();
      await vi.waitFor(() => expect(tf(I1, 'XA').y).toBe(0));
    });
    expect(peekSuppressedSceneReloads()).toEqual([]);

    expect(loadScene, 'the replay did not reload the scene').not.toHaveBeenCalled();
    expectReimported();
    expect(tfOf(rootOf(HOLDER)).x).toBe(3);
    expect(worldHasUnsavedEdits()).toBe(true);
    expect(canUndo()).toBe(true);
  });

  it('resolve-unsaved\'s discard awaits the same re-import', async () => {
    writeTraitFieldWithUndo(rootOf(HOLDER), getTraitByName('Transform')!, 'x', 3);
    const r = await quietly(() => runAgentOp('resolve-unsaved', { registries: ['dirtyAsset'], discard: ['dirtyAsset'] })) as { discarded?: unknown[]; reimported?: string[] };
    expect(r.reimported, JSON.stringify(r)).toEqual([X_PATH]);
    expect(loadScene).not.toHaveBeenCalled();
    expectReimported();
    expect(tfOf(rootOf(HOLDER)).x).toBe(3);
    expect(canUndo()).toBe(true);
  });
});
