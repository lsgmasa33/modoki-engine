/** #1868 step 2 — prefabs join the dirty-asset registry. An undone Apply (step 3) restores the prefab document in memory
 *  and PARKS it; Cmd+S writes it. These cases drive the registry, the commit and the reads through the real runtime
 *  loader cache (`acquirePrefab`/`releaseAllForScene`), the real editor cache, Apply, Revert and the flush; only the
 *  route is a fake, holding the bytes it received and applying `/api/write-file`'s `ifMatch` as the real one does.
 *
 *  - Hub call (c): a parked prefab WINS wherever prefabs are read, the runtime loader's re-read on a world swap included,
 *    or Apply and Revert compute against disk while Save writes the park. Park, swap worlds, then Apply and Revert.
 *    Mutation: drop the override in `fetchPrefab` → the swap case goes red (the live frames show the file); drop it in
 *    `fetchPrefabSource` → the Apply and Revert cases go red (they read the file).
 *  - D-a: a forward write that read the park is checked against the file's baseline and retires the park; a write that
 *    names any OTHER document is checked against the file as it is, and conflicts. Mutation: match every `expected`
 *    over a parked path → the refusal case goes red; never match → the Apply case and the accept case go red (a conflict). Drop the retire → the same two.
 *  - The flush goes through `commitPrefabWrite`, over the document the file held when parked; a changed file refuses as
 *    a conflict and stays parked, and only an explicit Overwrite writes over it (hub call b). Mutation: flush a prefab
 *    through `/api/asset-write` as the other kinds → both flush cases go red; write every flush with `overwrite` → the
 *    conflict case goes red (it overwrites the outside change). (`expected: entry.data` is NOT a mutation of it: the
 *    commit's D-a rule reads a precondition naming the park as the park's own baseline, so it survives, equivalently.)
 *  - A rename carries the park whole, its baseline included. Mutation: re-park without `onDisk` → red.
 *  - Cancel on Overwrite keeps the park. Mutation: overwrite without asking → the conflict case goes red.
 *  - The build gate (hub call c) asks about a parked prefab and passes a clean editor unasked. Mutation: always ask → red.
 *  - Elsewhere: the hot-reload keep (`agentBridgePrefabReloadFilter.test.ts`) and the agent discard's reload
 *    (`dirtyAssets.test.ts`). */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createWorld } from 'koota';

const route = vi.hoisted(() => ({ disk: new Map<string, string>(), assetWrites: 0, fail: false, gate: null as null | { reached: () => void; open: Promise<void> } }));
const sha = (t: string) => createHash('sha256').update(t.replace(/^\uFEFF/, '')).digest('hex');
const answer = (status: number, body: object) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
vi.mock('../../packages/modoki/src/editor/backend/editorBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postWriteFile: async (path: string, content: string, _enc?: string, opts?: { ifMatch?: string; createOnly?: boolean }) => {
    if (route.fail) return answer(500, { error: 'the disk is full' });
    const g = route.gate;
    if (g) { route.gate = null; g.reached(); await g.open; }
    const cur = route.disk.get(path);
    if (opts?.ifMatch !== undefined && (cur === undefined || sha(cur) !== opts.ifMatch)) return answer(409, { reason: 'if-match' });
    if (opts?.createOnly && cur !== undefined) return answer(409, { reason: 'if-none-match', existingPath: path });
    route.disk.set(path, content);
    return answer(200, { ok: true, path });
  },
  // `/api/asset-write` refuses a type that is not an asset schema, as the real route does (editorBackendRouter).
  backendFetch: async (url: string) => {
    if (url.includes('/api/asset-write')) { route.assetWrites++; return answer(400, { error: "unknown asset type 'prefab'" }); }
    return answer(200, {});
  },
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
import { setActionCallback, pushAction, clearHistory, writeTraitFieldWithUndo } from '@modoki/engine/editor';
import { acquirePrefab, getCachedPrefab, releaseAllForScene } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { setPrefabCache, getCachedPrefabSync, getPrefabSource, type PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { commitPrefabWrite } from '../../packages/modoki/src/editor/scene/prefabCommit';
import {
  parkPrefab, peekDirtyAsset, clearDirtyAssets, flushDirtyAssets, getDirtyAssetPaths, keepParkedPrefabOverFileChange,
  overwriteParkedAsset,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { restorePrefabsInMemory } from '../../packages/modoki/src/editor/scene/prefabMemoryRestore';
import { UndoRefusedError } from '../../packages/modoki/src/editor/undo/undoFailure';
import { answerParkedConflicts } from '../../packages/modoki/src/editor/scene/saveCommand';
import { decideUnsavedBeforeBuild } from '../../packages/modoki/src/editor/scene/unsavedGate';
import { unsavedChangeCauses } from '../../packages/modoki/src/editor/scene/serialize';
import { applyMovesToParkedDocs } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { _resetSceneAdoptionForTests } from '../../packages/modoki/src/editor/scene/sceneAdoption';
import { jsonFileBody } from '../../packages/modoki/src/editor/backend/editorBackend';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { revertOverridesWithUndo } from '../../packages/modoki/src/editor/undo/revertPrefabUndo';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { installEditorPrefabCacheWarm } from '../../packages/modoki/src/editor/scene/prefabCacheWarm';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
setActionCallback(pushAction);
// The editor's setup installs the loader's parked-prefab read with the swap warm (app/editor/setup.ts).
const uninstallWarm = installEditorPrefabCacheWarm();

const X = 'cccccccc-0000-4000-8000-000000001868';
const X_PATH = '/assets/prefabs/X.prefab.json';
const HOLDER = 'dddddddd-0000-4000-8000-000000001860';
const I1 = 'dddddddd-0000-4000-8000-000000001861';
const I2 = 'dddddddd-0000-4000-8000-000000001862';
const g = (n: number) => `eeeeeeee-0000-4000-8000-00000000186${n}`;

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
const twoInstances = (): SceneData => ({
  id: 's1868', version: 16, name: 'S', resources: [],
  entities: [
    { id: 1, traits: { EntityAttributes: { name: 'Holder', parentId: 0, guid: HOLDER } } },
    { id: 2, prefab: X, guid: I1, traits: { EntityAttributes: { name: 'I1', parentId: HOLDER } } },
    { id: 3, prefab: X, guid: I2, traits: { EntityAttributes: { name: 'I2', parentId: HOLDER } } },
  ],
} as unknown as SceneData);
const emptyScene = (): SceneData => ({ id: 's-empty', version: 16, name: 'E', resources: [], entities: [] } as unknown as SceneData);

/** A world swap as SceneManager makes one: the incoming scene acquires its prefabs through the runtime loader, THEN the
 *  outgoing scene's are released — so a prefab only the outgoing scene held is evicted, and the next load re-reads it. */
let sceneN = 0;
async function load(data: SceneData): Promise<void> {
  const prevScene = 186_800 + sceneN;
  const sid = 186_800 + ++sceneN;
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
const tf = (guid: string, name: string) => readTraitData(inInstance(guid, name), getTraitByName('Transform')!) as { x: number; y: number };
const onDisk = () => JSON.parse(route.disk.get(X_PATH)!) as PrefabFile;
const diskRow = (name: string) => (onDisk().entities.find((e) => e.name === name)!.traits as { Transform: { x: number; y: number } }).Transform;
const quietly = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const spies = (['log', 'warn', 'info', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
  try { return await fn(); } finally { for (const s of spies) s.mockRestore(); }
};

/** Park X, cold in both caches, then swap worlds: out to a scene without X (its runtime entry goes) and back in. */
async function parkAndSwap(): Promise<void> {
  parkPrefab(X_PATH, parkDoc(), diskDoc());
  setPrefabCache(X, null);
  setPrefabCache(X_PATH, null);
  await quietly(() => load(emptyScene()));
  expect(getCachedPrefab(X), 'precondition: the swap evicted the runtime entry').toBeUndefined();
  await quietly(() => load(twoInstances()));
}

beforeEach(async () => {
  setRunMode('stopped');
  clearHistory();
  clearDirtyAssets();
  _resetSceneAdoptionForTests();
  route.disk.clear();
  route.assetWrites = 0;
  route.fail = false;
  route.gate = null;
  vi.stubGlobal('fetch', serve);
  registerAsset(X, X_PATH, 'prefab');
  route.disk.set(X_PATH, jsonFileBody(diskDoc()));
  setPrefabCache(X, null);
  setPrefabCache(X_PATH, null);
  await quietly(() => load(twoInstances()));
});
afterAll(() => { uninstallWarm(); clearDirtyAssets(); setPrefabCache(X, null); setPrefabCache(X_PATH, null); vi.unstubAllGlobals(); getCurrentWorld()?.destroy(); });

describe('a parked prefab wins every read, across a world swap (hub call c)', () => {
  it('the runtime loader re-reads the park, so the swapped-in instances show it', async () => {
    expect(tf(I1, 'XA').y, 'precondition: built from the file').toBe(0);
    await parkAndSwap();
    expect((getCachedPrefab(X) as PrefabFile).entities[1]!.traits).toMatchObject({ Transform: { y: 5 } });
    expect(tf(I1, 'XA').y).toBe(5);
    expect(tf(I2, 'XA').y).toBe(5);
  });

  it('Apply computes against the park, is checked against the file, and the park retires once it lands (D-a)', async () => {
    await parkAndSwap();
    expect((await getPrefabSource(X))!.entities[1]!.traits).toMatchObject({ Transform: { y: 5 } });
    writeTraitFieldWithUndo(inInstance(I1, 'XB'), getTraitByName('Transform')!, 'x', 4);
    const keys = collectInstanceOverrideKeys(rootOf(I1), getCachedPrefabSync(X)!);
    const applied = await quietly(() => applyToPrefabWithUndo(rootOf(I1), new Set(keys.fields)));
    expect(applied.applied, JSON.stringify(applied)).toBe(true);
    // The written file is the park plus the Apply — not the file plus the Apply.
    expect(diskRow('XB').x).toBe(4);
    expect(diskRow('XA').y).toBe(5);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
  });

  it('Revert puts an override back to the park, not to the file', async () => {
    await parkAndSwap();
    await getPrefabSource(X); // the editor's warm on a swap (prefabCacheWarm.ts)
    writeTraitFieldWithUndo(inInstance(I1, 'XA'), getTraitByName('Transform')!, 'y', 9);
    const keys = collectInstanceOverrideKeys(rootOf(I1), getCachedPrefabSync(X)!);
    expect(keys.fields.length, 'precondition: y=9 reads as an override against the park').toBeGreaterThan(0);
    const reverted = await quietly(() => revertOverridesWithUndo(rootOf(I1), new Set(keys.fields)));
    expect(reverted).not.toBeNull();
    expect(tf(I1, 'XA').y).toBe(5);
    expect(peekDirtyAsset(X_PATH), 'a Revert writes no file, so the park stays').not.toBeNull();
  });
});

describe('a write over a parked prefab (D-a)', () => {
  it('names the park: checked against the file, lands, and retires the park', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const next = parkDoc();
    (next.entities[2]!.traits as { Transform: { x: number } }).Transform.x = 3;
    const res = await quietly(() => commitPrefabWrite(X, next, { expected: parkDoc() }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(diskRow('XB').x).toBe(3);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
  });

  it('names ANOTHER document: checked against the file as it is, conflicts, and the park stays', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const other = diskDoc();
    (other.entities[1]!.traits as { Transform: { z: number } }).Transform.z = 8; // neither the file nor the park
    const before = route.disk.get(X_PATH);
    const res = await quietly(() => commitPrefabWrite(X, parkDoc(), { expected: other }));
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(route.disk.get(X_PATH)).toBe(before);
    expect(peekDirtyAsset(X_PATH)?.type).toBe('prefab');
  });
});

describe('Save writes a parked prefab (hub call b)', () => {
  it('through commitPrefabWrite, over the document the file held, and the park goes', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const res = await quietly(() => flushDirtyAssets());
    expect(res).toEqual({ saved: [X_PATH], failed: [] });
    expect(route.assetWrites).toBe(0);
    expect(diskRow('XA').y).toBe(5);
    expect(getDirtyAssetPaths()).toEqual([]);
  });

  it('a file changed on disk refuses as a conflict; Cancel keeps the park, Overwrite writes it', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const outside = diskDoc();
    (outside.entities[2]!.traits as { Transform: { x: number } }).Transform.x = 6;
    route.disk.set(X_PATH, jsonFileBody(outside));
    const first = await quietly(() => flushDirtyAssets());
    expect(first.failed).toEqual([expect.objectContaining({ path: X_PATH, conflict: true })]);
    expect(diskRow('XB').x, 'refused: the outside change stays').toBe(6);

    const asked: string[] = [];
    const cancelled = await quietly(() => answerParkedConflicts(first, async (p) => { asked.push(p); return false; }));
    expect(asked).toEqual([X_PATH]);
    expect(cancelled.failed).toEqual(first.failed);
    expect(diskRow('XB').x).toBe(6);
    expect(peekDirtyAsset(X_PATH)?.type).toBe('prefab');

    const overwritten = await quietly(() => answerParkedConflicts(first, async () => true));
    expect(overwritten).toEqual({ saved: [X_PATH], failed: [] });
    expect(diskRow('XA').y).toBe(5);
    expect(diskRow('XB').x).toBe(0);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
  });
});

describe('the registry around a parked prefab', () => {
  it('a rename carries the park whole, the baseline its file holds included', () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const to = '/assets/prefabs/Y.prefab.json';
    applyMovesToParkedDocs([{ from: X_PATH, to }]);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    expect(peekDirtyAsset(to)).toMatchObject({ type: 'prefab', onDisk: diskDoc() });
  });

  it('the build gate names a parked prefab, and passes a clean editor without asking', async () => {
    const ask = vi.fn(async () => false);
    // Only the dirty-asset cause is read live; the test world's own scene state is not this case's subject.
    const causes = () => {
      const all = unsavedChangeCauses() as unknown as Record<string, unknown>;
      const quiet = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? [] : false]));
      return { ...quiet, dirtyAssetPaths: all.dirtyAssetPaths } as unknown as ReturnType<typeof unsavedChangeCauses>;
    };
    expect(await decideUnsavedBeforeBuild('build for web', causes, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    expect(await decideUnsavedBeforeBuild('build for web', causes, ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith('build for web', [expect.stringContaining(X_PATH)]);
  });
});

/** The close-out review's findings (#1868), each pinned by the scenario that showed it. Mutations, each red on its case:
 *  - F3: retire a park only when the write named it (`w.park?.landed` only under `readPark`) — the file-reader case.
 *  - F1: drop the restore's `assetWritesSettled` wait — the redo-during-Save case.
 *  - F2: drop `!park?.fileChanged` from the restore's drop test — the outside-change case.
 *  - F4: drop the settled-conflict filter in `answerParkedConflicts` — the prefab-edit case.
 *  - F6: drop the flush's `overwrite` clear — the failed-Overwrite case. */
describe('the close-out review\'s park findings (#1868)', () => {
  it('F3: a write that read the FILE, not the park, still retires the park, and reads get the written document', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const next = diskDoc();
    (next.entities[2]!.traits as { Transform: { x: number } }).Transform.x = 7;
    expect((await quietly(() => commitPrefabWrite(X, next, { expected: diskDoc() }))).ok).toBe(true);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
    setPrefabCache(X, null);
    expect(((await getPrefabSource(X))!.entities[2]!.traits as { Transform: { x: number } }).Transform.x).toBe(7);
  });

  it('F1: a redo during Save waits for the write, then parks against what the file now holds', async () => {
    await getPrefabSource(X);
    parkPrefab(X_PATH, parkDoc(), diskDoc()); // an undone Apply: the park is A (y=5), the file B
    const saving = quietly(() => flushDirtyAssets()); // Save writes A…
    const redo = quietly(() => restorePrefabsInMemory([{ source: X, doc: diskDoc(), from: parkDoc() }], { rebase: false })); // …a redo to B
    await Promise.all([saving, redo]);
    expect(diskRow('XA').y).toBe(5); // the file holds what Save wrote
    expect((peekDirtyAsset(X_PATH)?.data as PrefabFile | undefined)?.entities[1]!.traits).toMatchObject({ Transform: { y: 0 } }); // the redo is parked for the next Save
  });

  it('F2: a park kept over an outside change is not dropped when a restore returns to its recorded baseline', async () => {
    await getPrefabSource(X);
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    route.disk.set(X_PATH, jsonFileBody({ ...diskDoc(), name: 'pulled' } as PrefabFile)); // a git pull
    expect(keepParkedPrefabOverFileChange(X_PATH)).toBe(true); // the watcher keeps the park
    await quietly(() => restorePrefabsInMemory([{ source: X, doc: diskDoc(), from: parkDoc() }], { rebase: false }));
    expect(peekDirtyAsset(X_PATH)?.type).toBe('prefab'); // still unsaved: Save meets the pull and asks
    expect((await quietly(() => flushDirtyAssets())).failed).toEqual([expect.objectContaining({ path: X_PATH, conflict: true })]);
  });

  it('F4: a conflict settled before the question (the prefab-edit save wrote it) is neither asked nor reported', async () => {
    const ask = vi.fn(async () => true);
    const out = await answerParkedConflicts({ saved: [], failed: [{ path: X_PATH, error: 'changed', conflict: true }] }, ask, async () => ({ saved: [], failed: [] }));
    expect(ask).not.toHaveBeenCalled();
    expect(out).toEqual({ saved: [], failed: [] });
  });

  it('F6: an Overwrite answers one conflict — a flush that then fails does not carry it to the next Save', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    expect(overwriteParkedAsset(X_PATH)).toBe(true);
    route.fail = true;
    expect((await quietly(() => flushDirtyAssets())).failed).toHaveLength(1);
    expect(peekDirtyAsset(X_PATH)?.overwrite).toBeFalsy();
  });
});

/** The close-out RE-review of the F3 fix (#1868). A forward write and a restore race; so do a write and a flag-only
 *  rewrite of the park. Mutations, each red on its case:
 *  - drop the commit's `beginAssetWrites` (a restore no longer waits for a forward write) — R1;
 *  - retire a park only when it is the SAME entry (`now === d`), not the same document re-flagged — R2. */
describe('a park and a forward write that race (#1868 close-out re-review)', () => {
  /** Hold the next route write until `open()`; resolves once the write is in flight. */
  const holdNextWrite = () => {
    let open!: () => void;
    let reached!: () => void;
    const inFlight = new Promise<void>((r) => { reached = r; });
    route.gate = { reached, open: new Promise<void>((r) => { open = r; }) };
    return { inFlight, open: () => open() };
  };
  const next = () => { const d = diskDoc(); (d.entities[2]!.traits as { Transform: { x: number } }).Transform.x = 3; return d; };

  it('R1: a restore during a forward write waits for it, and the editor, the file and the registry agree after', async () => {
    await getPrefabSource(X);
    const hold = holdNextWrite();
    const writing = quietly(() => commitPrefabWrite(X, next(), { expected: diskDoc() }));
    await hold.inFlight;
    const z = diskDoc();
    (z.entities[2]!.traits as { Transform: { x: number } }).Transform.x = 9;
    const restoring = quietly(() => restorePrefabsInMemory([{ source: X, doc: z, from: diskDoc() }], { rebase: false }).catch((e: unknown) => e));
    hold.open();
    expect((await writing).ok).toBe(true);
    // The restore ran after the write: the editor held another document than it left, so it refused and changed nothing.
    expect(await restoring).toBeInstanceOf(UndoRefusedError);
    expect(diskRow('XB').x).toBe(3);
    expect((getCachedPrefabSync(X)!.entities[2]!.traits as { Transform: { x: number } }).Transform.x).toBe(3);
    expect(peekDirtyAsset(X_PATH)).toBeNull();
  });

  it('R2: a park re-flagged during a write that lands over it (Overwrite answered meanwhile) is still retired', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    const hold = holdNextWrite();
    const writing = quietly(() => commitPrefabWrite(X, next(), { expected: diskDoc() })); // a writer that read the FILE
    await hold.inFlight;
    expect(overwriteParkedAsset(X_PATH)).toBe(true); // the same document, re-flagged
    hold.open();
    expect((await writing).ok).toBe(true);
    expect(peekDirtyAsset(X_PATH)).toBeNull(); // no park left to overwrite the write at the next Save
    expect(diskRow('XB').x).toBe(3);
  });

  // Mutation: clear `overwrite` after every prefab flush, whether or not it wrote with it — this goes red.
  it('R4: an Overwrite answered while another flush writes survives that flush\'s conflict, for the Save that asked', async () => {
    parkPrefab(X_PATH, parkDoc(), diskDoc());
    route.disk.set(X_PATH, jsonFileBody({ ...diskDoc(), name: 'pulled' } as PrefabFile)); // the file changed meanwhile
    const hold = holdNextWrite();
    const flushing = quietly(() => flushDirtyAssets()); // e.g. an agent save_all, which does not take the Cmd+S latch
    await hold.inFlight;
    expect(overwriteParkedAsset(X_PATH)).toBe(true); // the human answers Overwrite on the Cmd+S question
    hold.open();
    expect((await flushing).failed).toEqual([expect.objectContaining({ path: X_PATH, conflict: true })]);
    expect(peekDirtyAsset(X_PATH)?.overwrite).toBe(true);
  });
});
