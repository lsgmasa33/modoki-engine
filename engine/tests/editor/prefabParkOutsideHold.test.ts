/** The #1879 × #1868 seam: an outside change to a PARKED prefab, HELD until a refresh (#1879), must meet the park as it
 *  did when it applied on arrival — the watcher's keeper marked the park's baseline stale (`fileChanged`), so no restore
 *  dropped the park as "back to the file", Save met the change and asked Overwrite or Cancel, and the file was never
 *  adopted over the unsaved document. Held, nothing marked the park until the release, so a redo during the hold dropped
 *  it and the release then adopted the outside file silently.
 *
 *  Driven through the real hold (`holdOutsideChange` → `releaseOutsideChanges`, the editor's hold switched on and its
 *  keeper and refresher installed by `registerEditorAgentOps`), a real Apply, the restore its undo and redo land through
 *  (`parkPrefabChanges`) and the real flush; only the route is a fake, applying `ifMatch` as the real one does. */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const route = vi.hoisted(() => ({ disk: new Map<string, string>(), refuse: new Set<string>() }));
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string }) => {
    const cur = route.disk.get(path);
    if (route.refuse.has(path)) return answer(409, { reason: 'if-match' }); // changed between the step's read and its write
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
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo, markSceneSaved } from '@modoki/engine/editor';
import { acquirePrefab, getCachedPrefab, releaseAllForScene } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { setPrefabCache, getCachedPrefabSync, getPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { clearDirtyAssets, peekDirtyAsset, flushDirtyAssets, overwriteParkedAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { installEditorPrefabCacheWarm } from '../../packages/modoki/src/editor/scene/prefabCacheWarm';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import {
  holdOutsideChange, releaseOutsideChanges, enableOutsideChangeHold, _resetOutsideChangesForTests, heldOutsideChanges, runAgentOp,
} from '../../app/debug/agentBridge';
import { resetPrefabMarkRecord, parkPrefabChanges, commitPrefabWrites, commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';

registerAllTraits();
registerEditorAgentOps(); // the keeper, the refresher, and the hold switched on — as the editor boots
setActionCallback(pushAction);
const uninstallWarm = installEditorPrefabCacheWarm();

const X = 'cccccccc-0000-4000-8000-0000000018a1';
const X_PATH = '/assets/prefabs/XH.prefab.json';
const SCENE_PATH = '/assets/scenes/Hold.scene.json';
const I1 = 'dddddddd-0000-4000-8000-0000000018a2';
const I2 = 'dddddddd-0000-4000-8000-0000000018a3';
const g = (n: number) => `eeeeeeee-0000-4000-8000-0000000018b${n}`;

const row = (localId: number, name: string, parentId: number, nodeGuid: string, tf: Record<string, number> = {}) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0, ...tf } },
});
/** X = XR → XA, XB, as the file first holds it. */
const diskDoc = (): PrefabFile => ({ id: X, version: 6, name: 'X', rootLocalId: 1, entities: [
  row(1, 'XR', 0, g(1)), row(2, 'XA', 1, g(2)), row(3, 'XB', 1, g(3)),
] } as unknown as PrefabFile);
const scene = (): SceneData => ({
  id: 's18a0', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, prefab: X, guid: I1, traits: { EntityAttributes: { name: 'I1', parentId: 0 } } },
    { id: 2, prefab: X, guid: I2, traits: { EntityAttributes: { name: 'I2', parentId: 0 } } },
  ],
} as unknown as SceneData);

let sceneN = 0;
async function load(data: SceneData): Promise<void> {
  const prevScene = 18_800 + sceneN;
  const sid = 18_800 + ++sceneN;
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
const tf = (guid: string, name: string) => readTraitData(inInstance(guid, name), getTraitByName('Transform')!) as { x: number; y: number; z: number };
const diskRow = (name: string) => ((JSON.parse(route.disk.get(X_PATH)!) as PrefabFile).entities.find((e) => e.name === name)!.traits as { Transform: { x: number; z: number } }).Transform;
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

/** Apply I1's XB.x = 4 to X: the file now holds it. Returns the document the Apply wrote (D1). */
async function applyXB4(): Promise<PrefabFile> {
  await getPrefabSource(X); // the editor's warm on a load (prefabCacheWarm.ts)
  writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
  const keys = collectInstanceOverrideKeys(rootOf(I1), getCachedPrefabSync(X)!);
  const applied = await quietly(() => applyToPrefabWithUndo(rootOf(I1), new Set(keys.fields)));
  expect(applied.applied, JSON.stringify(applied)).toBe(true);
  expect(diskRow('XB').x, 'precondition: Apply wrote the file').toBe(4);
  return JSON.parse(route.disk.get(X_PATH)!) as PrefabFile;
}
/** Apply's undo and redo land through this restore (`restoreSnapshot` in applyPrefabUndo.ts), with the same arguments;
 *  the world rebuild around it is not what this file is about, so it is left out (and `loadScene` refuses, below). */
const restore = (doc: PrefabFile, from: PrefabFile) => quietly(() => parkPrefabChanges([{ source: X, doc, from }], { rebase: false }));
/** A `git checkout` writing X outside the editor: XA at z=7, which neither the editor nor the park holds. */
const outsideWrite = (): void => {
  const doc = JSON.parse(route.disk.get(X_PATH)!) as PrefabFile;
  (doc.entities.find((e) => e.name === 'XA')!.traits as { Transform: { z: number } }).Transform.z = 7;
  route.disk.set(X_PATH, jsonFileBody(doc));
};
/** A second prefab, Y, that no instance uses: registered and on disk. */
const Y = 'cccccccc-0000-4000-8000-0000000018a9';
const Y_PATH = '/assets/prefabs/YH.prefab.json';
const yDoc = (): PrefabFile => ({ id: Y, version: 6, name: 'Y', rootLocalId: 1, entities: [row(1, 'YR', 0, g(9))] } as unknown as PrefabFile);
const addY = (): void => { registerAsset(Y, Y_PATH, 'prefab'); route.disk.set(Y_PATH, jsonFileBody(yDoc())); };
/** The watcher's message for that write: held (the editor's hold is on), or applied at once (`arrives`, the hold off —
 *  how every outside change met the editor before #1879, and the behaviour a held change must reproduce). */
async function watcherSees(mode: 'held' | 'arrives', urlPath = X_PATH): Promise<void> {
  enableOutsideChangeHold(mode === 'held');
  try { holdOutsideChange({ urlPath, kind: 'prefab' }); } finally { enableOutsideChangeHold(true); }
  await quietly(async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); });
  if (mode === 'held') expect(heldOutsideChanges(), 'precondition: the change is held').toContain(urlPath);
}
/** XA's z in the editor's cached X: 7 once the outside change is adopted. */
const cachedXAz = () => ((getCachedPrefabSync(X)!.entities.find((e) => e.name === 'XA')!.traits as { Transform: { z: number } }).Transform.z);
const release = () => quietly(() => releaseOutsideChanges());

beforeEach(async () => {
  resetPrefabMarkRecord();
  setRunMode('stopped');
  clearHistory();
  clearDirtyAssets();
  _resetSceneAdoptionForTests();
  _resetOutsideChangesForTests();
  route.disk.clear();
  route.refuse.clear();
  vi.stubGlobal('fetch', serve);
  registerAsset(X, X_PATH, 'prefab');
  route.disk.set(X_PATH, jsonFileBody(diskDoc()));
  route.disk.set(SCENE_PATH, JSON.stringify(scene()));
  setPrefabCache(X, null);
  setPrefabCache(X_PATH, null);
  await quietly(() => load(scene()));
  vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: SCENE_PATH } as never);
  vi.spyOn(sceneManager, 'loadScene').mockImplementation(async () => { throw new Error('the open scene was reloaded'); });
  markSceneSaved();
});
afterEach(() => { vi.restoreAllMocks(); _resetOutsideChangesForTests(); setRunMode('stopped'); });
afterAll(() => { uninstallWarm(); clearDirtyAssets(); setPrefabCache(X, null); setPrefabCache(X_PATH, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('an outside change to a PARKED prefab meets the park the same way held as on arrival (#1879 × #1868)', () => {
  it.each(['arrives', 'held'] as const)('%s: a redo back to the park\'s baseline keeps the park, the file is not adopted, and Save asks', async (mode) => {
    const d1 = await applyXB4();
    await restore(diskDoc(), d1); // undo the Apply: D0 parked, the file (D1) its baseline
    expect(peekDirtyAsset(X_PATH)?.type, 'precondition: the undone Apply is parked').toBe('prefab');
    outsideWrite();
    await watcherSees(mode);
    await restore(d1, diskDoc()); // redo: the editor is back on what the park recorded as the file's
    await release();
    expect(peekDirtyAsset(X_PATH)?.type, 'the redo is still unsaved: the file holds the outside change, not it').toBe('prefab');
    expect(cachedXAz(), 'the outside change was not adopted over the unsaved document').toBe(0);
    const saved = await quietly(() => flushDirtyAssets());
    expect(saved.failed, 'Save meets the outside change and asks').toEqual([expect.objectContaining({ path: X_PATH, conflict: true })]);
    expect(diskRow('XA').z, 'nothing written over it unasked').toBe(7);
  });

  it.each(['arrives', 'held'] as const)('%s: an undo landing after the change never lets Save write over it unasked', async (mode) => {
    const d1 = await applyXB4();
    outsideWrite();
    await watcherSees(mode);
    // On arrival the editor has adopted the change, so the undo is refused (its `from` is gone); held, it parks. Either
    // is sound — the rule is only that Save never writes over the outside change unasked.
    await restore(diskDoc(), d1).catch((e: unknown) => { if (!(e instanceof UndoRefusedError)) throw e; });
    await release();
    const saved = await quietly(() => flushDirtyAssets());
    expect(diskRow('XA').z, 'the outside change is still on disk').toBe(7);
    expect(saved.saved).not.toContain(X_PATH);
  });
});

describe('an Overwrite Save SUPERSEDES the held change: the release marks no park made after it', () => {
  it.each(['arrives', 'held'] as const)('%s: after Overwrite, a redo re-parks and its undo back to the file drops the park', async (mode) => {
    const d1 = await applyXB4();
    await restore(diskDoc(), d1); // undo the Apply: D0 parked over D1
    outsideWrite();
    await watcherSees(mode);
    const asked = await quietly(() => flushDirtyAssets());
    expect(asked.failed, 'precondition: Save meets the outside change and asks').toEqual([expect.objectContaining({ path: X_PATH, conflict: true })]);
    expect(overwriteParkedAsset(X_PATH)).toBe(true); // the human reads it and picks Overwrite
    const over = await quietly(() => flushDirtyAssets());
    expect(over.saved, 'precondition: the Overwrite wrote the park').toEqual([X_PATH]);
    expect(diskRow('XB').x, 'precondition: the file holds the editor\'s D0').toBe(0);
    expect(peekDirtyAsset(X_PATH), 'precondition: the write retired the park').toBeNull();
    await restore(d1, diskDoc()); // redo: D1 parked, the file (D0, the editor's own write) its baseline
    expect(peekDirtyAsset(X_PATH)?.fileChanged, 'precondition: the new park starts on the file').toBeFalsy();
    await release();
    expect(peekDirtyAsset(X_PATH)?.fileChanged, 'the file still holds the new park\'s baseline').toBeFalsy();
    await restore(diskDoc(), d1); // undo: back on exactly what the file holds
    expect(peekDirtyAsset(X_PATH), 'nothing unsaved: the file holds the document').toBeNull();
    expect(await quietly(() => flushDirtyAssets())).toEqual({ saved: [], failed: [] });
  });

  /** Up to the Overwrite of the case above: the file holds the editor's D0, nothing parked, the held change superseded. */
  async function overwriteHeld(): Promise<PrefabFile> {
    const d1 = await applyXB4();
    await restore(diskDoc(), d1);
    outsideWrite();
    await watcherSees('held');
    await quietly(() => flushDirtyAssets());
    overwriteParkedAsset(X_PATH);
    expect((await quietly(() => flushDirtyAssets())).saved, 'precondition: the Overwrite wrote the park').toEqual([X_PATH]);
    return d1;
  }

  // The accept side: only a change held BEFORE the editor's write is superseded by it. One held after it is on disk.
  it('a change held AFTER the Overwrite still marks a park made after it: its undo keeps the park, and Save asks', async () => {
    const d1 = await overwriteHeld();
    await restore(d1, diskDoc()); // redo: D1 parked over the editor's D0
    outsideWrite();
    await watcherSees('held');
    await release();
    expect(peekDirtyAsset(X_PATH)?.fileChanged, 'the file no longer holds the park\'s baseline').toBe(true);
    await restore(diskDoc(), d1);
    expect(peekDirtyAsset(X_PATH)?.type, 'the undo is still unsaved: the file holds the outside change').toBe('prefab');
    const saved = await quietly(() => flushDirtyAssets());
    expect(saved.failed).toEqual([expect.objectContaining({ path: X_PATH, conflict: true })]);
    expect(diskRow('XA').z, 'nothing written over it unasked').toBe(7);
  });

  it('a change held AFTER the Overwrite, with nothing parked, is adopted on release', async () => {
    await overwriteHeld();
    outsideWrite();
    await watcherSees('held');
    expect(cachedXAz(), 'held: nothing applied yet').toBe(0);
    await release();
    expect(cachedXAz(), 'the release adopts it').toBe(7);
    expect(tf(I1, 'XA').z, 'the instances take it in place').toBe(7);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
  });
});

describe('what supersedes a held prefab change, and what does not (#1889 close-out review)', () => {
  it('F1: a change DEFERRED by Play and replayed at Stop does not end a newer hold of the same file', async () => {
    await applyXB4();
    outsideWrite(); // A
    await watcherSees('held');
    setRunMode('playing');
    const deferred = await release();
    expect(deferred.deferred, 'precondition: Play defers A').toEqual([X_PATH]);
    const b = JSON.parse(route.disk.get(X_PATH)!) as PrefabFile; // B: a second outside write, held during Play
    (b.entities.find((e) => e.name === 'XA')!.traits as { Transform: { z: number } }).Transform.z = 8;
    route.disk.set(X_PATH, jsonFileBody(b));
    await watcherSees('held');
    setRunMode('stopped'); // A replays once authoring settles (the editor's own signal), adopting what the file holds: B
    await quietly(async () => { for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r)); });
    expect(cachedXAz(), 'precondition: A\'s replay adopted the file').toBe(8);
    expect(heldOutsideChanges(), 'precondition: B is still held').toEqual([X_PATH]);
    const onB = getCachedPrefabSync(X)!;
    await restore(diskDoc(), onB); // an undo parks P over the file (B)…
    expect((await quietly(() => flushDirtyAssets())).saved, 'precondition: …and Save writes it').toEqual([X_PATH]);
    await restore(onB, diskDoc()); // a redo parks B's document over the editor's own write
    await release(); // B, which that Save wrote over
    expect(peekDirtyAsset(X_PATH)?.fileChanged, 'the file still holds the park\'s baseline').toBeFalsy();
    await restore(diskDoc(), onB);
    expect(peekDirtyAsset(X_PATH), 'back on the file: nothing unsaved').toBeNull();
  });

  it('F3: two prefabs released together — the one collapsed into the other\'s reload is superseded too', async () => {
    addY();
    const d1 = await applyXB4();
    await restore(diskDoc(), d1);
    outsideWrite();
    await watcherSees('held'); // X, then Y: X is replayed as Y's `evictAlso`
    const y = yDoc();
    (y.entities[0]!.traits as { Transform: { x: number } }).Transform.x = 3;
    route.disk.set(Y_PATH, jsonFileBody(y));
    await watcherSees('held', Y_PATH);
    await quietly(() => flushDirtyAssets());
    overwriteParkedAsset(X_PATH);
    expect((await quietly(() => flushDirtyAssets())).saved, 'precondition: the Overwrite wrote X').toEqual([X_PATH]);
    await restore(d1, diskDoc());
    await release();
    expect(peekDirtyAsset(X_PATH)?.fileChanged, 'X\'s file still holds the park\'s baseline').toBeFalsy();
  });

  it('F3: an Overwrite that is not Save\'s flush (the prefab-edit save\'s) supersedes the held change too', async () => {
    await applyXB4();
    outsideWrite();
    await watcherSees('held');
    const mine = diskDoc();
    (mine.entities.find((e) => e.name === 'XB')!.traits as { Transform: { x: number } }).Transform.x = 5;
    const wrote = await quietly(() => commitPrefabWrite(X, mine, { expected: diskDoc(), overwrite: true }));
    expect(wrote.ok, 'precondition: the Overwrite wrote X').toBe(true);
    expect(diskRow('XA').z, 'precondition: over the outside change').toBe(0);
    const w = getCachedPrefabSync(X)!;
    await restore(diskDoc(), w); // an undo parks over the editor's write
    await release();
    expect(peekDirtyAsset(X_PATH)?.fileChanged, 'the file holds the park\'s baseline').toBeFalsy();
  });
});

describe('a write step REFUSED part-way supersedes nothing: its rollback puts the held change back', () => {
  it('X written over its held change, Y refused, X rolled back: the release still adopts X', async () => {
    addY();
    outsideWrite();
    await watcherSees('held');
    // A writer that read the files as they are now (the outside change included) writes both; Y changes in between.
    const onDisk = JSON.parse(route.disk.get(X_PATH)!) as PrefabFile;
    const mine = JSON.parse(route.disk.get(X_PATH)!) as PrefabFile;
    (mine.entities.find((e) => e.name === 'XB')!.traits as { Transform: { x: number } }).Transform.x = 9;
    route.refuse.add(Y_PATH);
    const res = await quietly(() => commitPrefabWrites([{ source: X, doc: mine, expected: onDisk }, { source: Y, doc: yDoc(), expected: yDoc() }]));
    expect(res.ok, 'precondition: the step is refused at Y').toBe(false);
    expect(diskRow('XB').x, 'precondition: X was rolled back').toBe(0);
    expect(diskRow('XA').z, 'precondition: X holds the outside change again').toBe(7);
    await release();
    expect(cachedXAz(), 'the release adopts the outside change the rollback put back').toBe(7);
  });
});

describe("discarding a parked prefab re-imports its file, which applies the held change (#1902)", () => {
  // The re-import reads X fresh and rebases the instances onto it — the release's whole apply. Left held, the release
  // re-imported it a second time and `pendingOutsideChanges` named a file the editor already showed.
  // Mutation: drop the `landed()` loop in `reimportDiscardedPrefabs` — the change stays held.
  it('the discard drops the hold, and the instances already show the file', async () => {
    const d1 = await applyXB4();
    await restore(diskDoc(), d1); // undo the Apply: D0 parked
    outsideWrite();
    await watcherSees('held');
    const r = await quietly(() => runAgentOp('discard-asset-edits', { paths: [X_PATH] })) as { ok?: boolean };
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    expect(tf(I1, 'XA').z, 'the re-import took the file').toBe(7);
    expect(heldOutsideChanges()).toEqual([]);
  });

  // The accept side: a re-import that could NOT read the file applied nothing, so its change stays held for the
  // release. Mutation: land every path the discard named, not only the ones the report says it read — it drops here.
  it('a re-import that fails to read the file leaves the change held', async () => {
    const d1 = await applyXB4();
    await restore(diskDoc(), d1);
    outsideWrite();
    await watcherSees('held');
    route.disk.set(X_PATH, '{ not json');
    await quietly(() => runAgentOp('discard-asset-edits', { paths: [X_PATH] }));
    expect(heldOutsideChanges()).toEqual([X_PATH]);
  });
});

describe('the accept side: a held change to an UNPARKED prefab applies silently on release', () => {
  it('no park: the release adopts the file, the instances take it, and nothing is unsaved or asked', async () => {
    await applyXB4();
    outsideWrite();
    await watcherSees('held');
    expect(cachedXAz(), 'held: nothing applied yet').toBe(0);
    await release();
    expect(cachedXAz()).toBe(7);
    expect(tf(I1, 'XA').z, 'the instances take it in place').toBe(7);
    expect(tf(I2, 'XA').z).toBe(7);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    expect(await quietly(() => flushDirtyAssets())).toEqual({ saved: [], failed: [] });
  });
});
