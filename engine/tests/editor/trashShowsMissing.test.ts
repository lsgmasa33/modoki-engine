/** #2056 (owner ruling 2026-10-03, "Missing at once, as Unity") and #2067.
 *
 *  #2056 — trashing a prefab the open scene uses turns its instances into Missing Prefab placeholders AT ONCE, keeping
 *  their place and name, so the screen matches what a reload or a Stop shows. They used to stay live until the next load,
 *  and a Play → Stop then changed the world (I13, hunt seeds 7168/7240/7314/7413/7420/8408/8503/8508/8510).
 *  The way back is Unity's: the file put back relinks them.
 *
 *  #2067 — a prefab MOVED outside the editor was reported, evicted and tombstoned as a delete, because the adopt step judged
 *  "gone" by path. Identity decides (docs/mcp-persistence.md rule 2): a gone path whose GUID lives at another path is a move.
 *
 *  Driven through the real editor over the fuzzer's in-process backend (`prefabFuzz/harness.ts`): Q: QR → M; P: R → A → B
 *  and a row C expanding Q; O nests P; the scene holds O1, P1, H1 and Plain → Leaf. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getTraitByName, getAllEntities, readTraitData, getCurrentWorld } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, unexpandedRows, placeholderGuids, flushWatcher, worldTree, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { deletedPrefabsShown, showDeletedPrefabsMissing } from '../../packages/modoki/src/editor/scene/deletedPrefabsMissing';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { SCENE_FORMAT_VERSION, CAPTURE_FORM_SCENE_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { editorPrefabDeleted, getPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { writeTraitFieldWithUndo, duplicateEntity, clipEntity, pasteEntityCopy, deleteEntityWithUndo, createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { isRowPlaceholder } from '../../packages/modoki/src/editor/undo/placeholderGate';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { instantiatePrefabInstance } from '../../packages/modoki/src/editor/scene/prefabInstantiate';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { runAsCompositeAction } from '../../packages/modoki/src/editor/undo/compositeAction';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { reprojectFromStore } from '../../packages/modoki/src/editor/instance/instanceReproject';
import { saveScene, loadSceneReporting, worldHasUnsavedEdits } from '../../packages/modoki/src/editor/scene/serialize';
import { enterPlay, stopPlay } from '../../packages/modoki/src/editor/scene/playMode';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const noNest = async () => {};
const TF = () => getTraitByName('Transform')!;
const framesOf = (guid: string) => getAllEntities().filter((e) => piOf(e.id)?.source === guid).length;
const named = (name: string) => getAllEntities().find((e) => e.name === name)!;
const leafX = () => (readTraitData(named('Leaf').id, TF()) as { x: number }).x;

/** `Assets.tsx`'s `executeDeletion` of one prefab, as the fuzzer's `trashPrefab` op runs it, then the watcher's pass. */
async function trash(f: Fixture, which: 'P' | 'Q'): Promise<void> {
  const before = be.snapshot();
  expect((await deleteAssetFiles(deletionPathsFor(f.prefabs[which].path, 'prefab', null))).ok).toBe(true);
  unbindDeletedAssetEditors([f.prefabs[which].path]);
  await deletedPrefabsShown();
  await flushWatcher(be, before);
  await settle();
}

/** Save, reload from disk, and return the world the reload built. */
async function reloadTree(f: Fixture): Promise<Record<string, unknown>> {
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
  return worldTree();
}

const logs = () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { text: () => spy.mock.calls.map((c) => String(c[0])).join('\n'), restore: () => spy.mockRestore() };
};

describe('#2056: a trashed prefab\'s instances are Missing Prefab at once', () => {
  // Mutation: drop `showDeletedPrefabsMissing()` from `applyAssetPathMoves` → P1 and O1's N stay live frames of P.
  it('the Assets trash turns every instance, top-level and nested, into its placeholder in place — the world a save and reload builds', async () => {
    const f = await startRun(be, noNest, '2056-trash');
    const leaf = named('Leaf');
    expect(writeTraitFieldWithUndo(leaf.id, TF(), 'x', 9)).toBeFalsy(); // an unrelated unsaved edit
    await settle();
    expect(framesOf(f.prefabs.P.guid), 'premise: P1 and O1\'s N are live frames of P').toBeGreaterThan(0);
    const root = getAllEntities().find((e) => { const pi = piOf(e.id); return e.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === e.id; })!;
    await trash(f, 'P');
    expect(framesOf(f.prefabs.P.guid), 'no frame of P is live').toBe(0);
    expect(framesOf(f.prefabs.Q.guid), 'nor of Q, which only P nested').toBe(0);
    expect(placeholderGuids().size + unexpandedRows().size, 'P1 is its entry placeholder, N its row\'s').toBeGreaterThan(0);
    const p1 = getAllEntities().find((e) => e.guid === root.guid);
    expect(p1, 'P1 is still there, as its placeholder').toBeDefined();
    expect(placeholderGuids().has(root.guid!), 'an entry placeholder').toBe(true);
    expect(p1!.name, 'it keeps the instance\'s name').toBe(root.name);
    expect(p1!.parentId, 'and its place').toBe(root.parentId);
    expect(worldHasUnsavedEdits(), 'the scene stays dirty').toBe(true);
    const shown = worldTree();
    // The undo stack survives the reload, as it survives Stop's: the unrelated edit still undoes, by guid.
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(leafX(), 'the edit made before the trash undoes').toBe(1);
    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(leafX()).toBe(9);
    await settle();
    expect(worldTree(), 'the undo and redo leave the placeholders as they were').toEqual(shown);
    expect(await reloadTree(f), 'a save and reload shows exactly what the trash showed').toEqual(shown);
  });

  // The reload adopts under the scene's own key, so it moves no dirty flag (the conversion repairs none, unlike Stop).
  // Mutation: `markSceneDirty` after the conversion's reload → red.
  it('a clean scene stays clean: the scene file already states every placeholder\'s row', async () => {
    const f = await startRun(be, noNest, '2056-clean');
    expect(worldHasUnsavedEdits(), 'premise').toBe(false);
    await trash(f, 'Q');
    expect(framesOf(f.prefabs.Q.guid)).toBe(0);
    expect(worldHasUnsavedEdits()).toBe(false);
  });

  // The #2056 hunt seeds minimize to `trashPrefab ; playStop`: the world after Stop was not the one before Play.
  // Mutation: drop the conversion → Stop turns the live Q frames into placeholders, and the trees differ.
  it('Play then Stop after the trash changes nothing (I13)', async () => {
    const f = await startRun(be, noNest, '2056-stop');
    await trash(f, 'Q');
    const before = worldTree();
    expect((await enterPlay()).kind).toBe('started');
    await settle();
    await stopPlay();
    await settle();
    expect(worldTree()).toEqual(before);
  });

  // Inside Play the world is not the authored one: the trash leaves it, and Stop's own load shows the placeholders.
  // Mutation: drop the `isWorldAuthored()` gate → the trash reloads the Play world, and `stopPlay` restores over it.
  it('a trash during Play leaves the Play world as it is; Stop shows the placeholders', async () => {
    const f = await startRun(be, noNest, '2056-play');
    const live = framesOf(f.prefabs.Q.guid);
    expect((await enterPlay()).kind).toBe('started');
    await settle();
    await trash(f, 'Q');
    expect(framesOf(f.prefabs.Q.guid), 'the Play world keeps its frames').toBe(live);
    await stopPlay();
    await settle();
    expect(framesOf(f.prefabs.Q.guid), 'Stop\'s load shows them missing').toBe(0);
    expect(unexpandedRows().size).toBeGreaterThan(0);
  });

  // Unity relinks a Missing Prefab when an asset with its GUID returns; here the put-back is an outside write (#1868 D2:
  // the delete itself is not undoable), and its adopt re-expands every placeholder in place (#1873 R1 r3).
  it('putting the file back relinks the placeholders, keeping unsaved work', async () => {
    const f = await startRun(be, noNest, '2056-putback');
    const text = be.read(f.prefabs.Q.path)!;
    const live = framesOf(f.prefabs.Q.guid);
    const leaf = named('Leaf');
    expect(writeTraitFieldWithUndo(leaf.id, TF(), 'x', 9)).toBeFalsy();
    await settle();
    await trash(f, 'Q');
    expect(framesOf(f.prefabs.Q.guid), 'premise').toBe(0);
    const before = be.snapshot();
    be.write(f.prefabs.Q.path, text);
    await flushWatcher(be, before);
    expect(framesOf(f.prefabs.Q.guid), 'every Q frame is live again').toBe(live);
    expect(unexpandedRows().size, 'no placeholder is left').toBe(0);
    expect(worldHasUnsavedEdits()).toBe(true);
  });

  // An outside delete (Finder, `git rm`) is the same delete: the watcher's adopt evicts as the trash does, and the screen
  // matches the next load. Mutation: drop the conversion from `reimportOutsidePrefabChangesUnmarked` → Q frames stay live.
  it('an outside delete shows them missing at once too, and says so', async () => {
    const f = await startRun(be, noNest, '2056-outside-rm');
    const before = be.snapshot();
    be.remove(f.prefabs.Q.path);
    const log = logs();
    try {
      await flushWatcher(be, before);
      expect(log.text()).toMatch(new RegExp(`${f.prefabs.Q.path.replace(/[.]/g, '\\.')} was deleted outside the editor — its instances show as Missing Prefab`));
    } finally { log.restore(); }
    expect(framesOf(f.prefabs.Q.guid)).toBe(0);
    expect(unexpandedRows().size).toBeGreaterThan(0);
  });
});

describe('#2056 review: the conversion\'s own reload', () => {
  // Nothing refuses an edit while the reload runs, and an outside delete lands whenever the watcher's batch does — so an
  // edit can land between the capture and the swap. It used to be dropped (the reload builds from the capture) with its undo
  // entry left over a world that no longer held it. Mutation: stop passing the abort signal to `reloadCapturedWorld` →
  // Leaf.x reads 1 after the trash, and the undo changes nothing.
  it('an edit landing before the swap aborts the reload: the edit is kept, its undo works, and the retry converts', async () => {
    const f = await startRun(be, noNest, '2056-edit-mid-reload');
    let landed = false;
    const hook = async () => {
      if (landed) return;
      landed = true;
      expect(writeTraitFieldWithUndo(named('Leaf').id, TF(), 'x', 7), 'an edit is not refused mid-reload').toBeFalsy();
    };
    sceneManager.registerBeforeSwap(hook);
    try {
      await trash(f, 'Q');
    } finally { sceneManager.unregisterBeforeSwap(hook); }
    expect(landed, 'premise: the edit landed inside the reload').toBe(true);
    expect(leafX(), 'the edit is kept').toBe(7);
    expect(framesOf(f.prefabs.Q.guid), 'the retry converted').toBe(0);
    // The aborted reload kept the live world; marking its records stale before the call left the retry banking stale
    // records, which the load does not take (#2056 re-review). Mutation: wrap `reloadCapturedWorld` in
    // `staleAround` (a mark before the call) → every record reads stale here.
    expect(unexpandedRows().size).toBeGreaterThan(0);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(leafX(), 'its undo reaches the live world').toBe(1);
  });

  // A composite frame (an agent's `modoki.composite` with an awaiting body) writes live but pushes only when it closes, so
  // the watch hears nothing while it is open. Mutation: drop the before-swap check → Leaf.x is 1 after the trash, and the
  // composite's undo changes nothing.
  it('a composite still open at the swap aborts the reload too: its edit is kept, and a later pass converts', async () => {
    const f = await startRun(be, noNest, '2056-composite-mid-reload');
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let composite: Promise<unknown> | null = null;
    const hook = async () => {
      composite ??= runAsCompositeAction({ label: 'agent composite' }, async () => {
        expect(writeTraitFieldWithUndo(named('Leaf').id, TF(), 'x', 7)).toBeFalsy();
        await gate;
      });
    };
    sceneManager.registerBeforeSwap(hook);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await trash(f, 'Q');
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n'), 'every attempt met the open composite').toMatch(/edits kept landing/);
    } finally { sceneManager.unregisterBeforeSwap(hook); warn.mockRestore(); }
    open();
    await composite;
    await settle();
    expect(leafX(), 'the composite\'s edit is kept').toBe(7);
    expect(framesOf(f.prefabs.Q.guid), 'premise: the frames stayed live').toBeGreaterThan(0);
    await showDeletedPrefabsMissing();
    expect(framesOf(f.prefabs.Q.guid), 'the next pass converts').toBe(0);
    expect(leafX()).toBe(7);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(leafX(), 'the composite undoes in the live world').toBe(1);
  });

  // A base scene's tree is kept across the reload, not rebuilt, so its frames cannot convert (as Stop does not). Counting
  // them answered "live" for ever after, and every later delete reloaded the world again for nothing.
  // Mutation: drop the `sourceScene` skip in `liveFramesOfDeletedPrefabs` → the second pass replaces the world.
  it('a base scene\'s frames do not count: a second pass after the trash replaces no world', async () => {
    const f = await startRun(be, noNest, '2056-base');
    const lPath = f.scenePath.replace(/Fuzz\.json$/, 'Level.json');
    const lGuid = f.sceneGuid.replace(/^.{8}/, 'abababab');
    const level = {
      id: lGuid, version: SCENE_FORMAT_VERSION, name: 'Level', createdAt: '2026-01-01T00:00:00.000Z', resources: [], baseScene: f.sceneGuid,
      entities: [{ id: 1, prefab: f.prefabs.O.guid, guid: lGuid.replace(/^.{8}/, 'acacacac'), traits: { EntityAttributes: { name: 'LO', parentId: 0 }, Transform: { x: 9, y: 0, z: 0 } } }],
    };
    be.write(lPath, `${JSON.stringify(level, null, 2)}\n`);
    registerAsset(lGuid, lPath, 'scene');
    be.marked.clear();
    expect((await loadSceneReporting(lPath)).outcome).toBe('loaded');
    await settle();
    const fromBase = (guid: string) => getAllEntities().filter((e) => piOf(e.id)?.source === guid && (readTraitData(e.id, getTraitByName('EntityAttributes')!) as { sourceScene?: string }).sourceScene).length;
    const live = fromBase(f.prefabs.Q.guid);
    expect(live, 'premise: the base holds live Q frames').toBeGreaterThan(0);
    await trash(f, 'Q');
    expect(framesOf(f.prefabs.Q.guid), 'the level\'s own Q frames converted; the base\'s stay').toBe(live);
    const world = getCurrentWorld();
    await showDeletedPrefabsMissing();
    expect(getCurrentWorld() === world, 'nothing left to convert, so no reload').toBe(true);
  });
});

describe('#2056 review: a missing nested row\'s placeholder cannot be copied', () => {
  // Its save is its owner's rows, so a copy was written nowhere and the reload lost it (hunt seed 1212, reached by any load
  // that leaves the row missing). Mutation: drop `rowPlaceholderCopyRefusal` from `clipEntity` → the copy is clipped.
  it('Duplicate, Copy and Cut of it are refused; a whole instance holding it still duplicates', async () => {
    const f = await startRun(be, noNest, '2056-rowcopy');
    await trash(f, 'Q');
    const row = getAllEntities().find((e) => isRowPlaceholder(e.id));
    expect(row, 'premise: P1\'s C row is a placeholder').toBeDefined();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(duplicateEntity(row!.id, () => {})).toBeNull();
      expect(clipEntity(row!.id, 'copy')).toBeNull();
      expect(clipEntity(row!.id, 'cut')).toBeNull();
      expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/stands in for a part of a missing nested prefab/);
    } finally { err.mockRestore(); }
    const p1 = getAllEntities().find((e) => { const pi = piOf(e.id); return e.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === e.id; })!;
    expect(duplicateEntity(p1.id, () => {}), 'the instance it belongs to copies with its rows').not.toBeNull();
  });
});

// #2001 S8b: the put-back re-expands an entry placeholder by loading its entry, seats the records a reload parses from it
// (carrying the link to a user's node hung on the placeholder, § 10.4b, onto the instance it now hangs under), and
// projects the tree from them. Before, the re-expansion marked every record of the scene stale and the next write
// re-seeded them from the capture (hunt seed 9335). A record the editor wrote is in the current form, so the
// placeholder's already equals that parse; one loaded from a file before v20 holds the file's localId channels verbatim
// until the document returns (rule 9), and names the root by the entry's own name, which the expansion does not apply.
// Mutations, each red in its own case alone: drop `seatLoadedEntry` → 'the record converted it against P'; drop the
// `reprojectFromStore` after it → 'a save and reload builds the same world' (the root shows R, the record and the
// reload P1); drop the `keepLiveLinks` carry in `seatLoadedEntry` → 'the node hung on the placeholder stays linked'.
describe('putting the file back keeps the records', () => {
  it('an entry placeholder loaded from an older file comes back with the records a reload parses', async () => {
    const f = await startRun(be, noNest, 'putback-old-file');
    const text = be.read(f.prefabs.P.path)!;
    const p1 = () => getAllEntities().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const p1Guid = p1().guid!;
    await trash(f, 'P');
    // P1 as a file from before the instance model states it: A's (localId 2) y through the legacy localId channel, which
    // the parse can only hold verbatim while P is missing (rule 9).
    be.write(f.scenePath, JSON.stringify({
      id: f.sceneGuid, version: CAPTURE_FORM_SCENE_VERSION, name: 'Fuzz', createdAt: '2026-01-01T00:00:00.000Z', resources: [],
      entities: [{ id: 2, prefab: f.prefabs.P.guid, guid: p1Guid, traits: { EntityAttributes: { name: 'P1', parentId: 0 }, Transform: { x: 3, y: 0, z: 0 } }, overrides: { 2: { Transform: { y: 4 } } } }],
    }));
    expect((await loadSceneReporting(f.scenePath)).outcome, 'premise: the file is read with P missing').toBe('loaded');
    await settle();
    const rec = () => storedInstances(getCurrentWorld()).get(p1Guid)!.record;
    expect(rec().held.pendingLegacy, 'premise: the placeholder\'s record holds the legacy channel').toBeDefined();
    const before = be.snapshot();
    be.write(f.prefabs.P.path, text);
    await flushWatcher(be, before);
    expect(piOf(p1().id)?.source, 'P1 is live again').toBe(f.prefabs.P.guid);
    const a = getAllEntities().find((e) => e.parentId === p1().id && e.name === 'A')!;
    expect((readTraitData(a.id, TF()) as { y: number }).y, 'premise: the load gave A its y').toBe(4);
    expect(rec().held.pendingLegacy, 'the record converted it against P').toBeUndefined();
    const mine = structuredClone(rec());
    const shown = worldTree();
    expect(await reloadTree(f), 'a save and reload builds the same world').toEqual(shown);
    // …and parses the same record, but for the pins the save adds: a file before v20 states none, so neither does its load.
    const unpinned = (r: typeof mine) => ({ ...r, list: { rows: new Map([...r.list.rows].map(([k, { guid: _g, name: _n, ...row }]) => [k, row] as const).filter(([, row]) => Object.keys(row).length)) } });
    expect(unpinned(rec()), 'and parses the same record').toEqual(unpinned(mine));
  });

  it('an entry placeholder comes back with fresh records, the user\'s node hung on it still linked', async () => {
    const f = await startRun(be, noNest, 'putback-records');
    const text = be.read(f.prefabs.P.path)!;
    const p1 = () => getAllEntities().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;

    const { specs } = emptySpecs(p1().id);
    const hung = createEntityWithUndo('Create Hung', p1().id, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Hung' } } : s)), () => {});
    expect(hung, 'premise: a node is hung on P1').not.toBeNull();
    await settle();
    await trash(f, 'P');
    expect(piOf(p1().id), 'premise: P1 is its placeholder').toBeUndefined();
    await reloadTree(f);
    expect(named('Hung'), 'premise: the node hangs on the placeholder').toBeDefined();
    const hungGuid = named('Hung').guid!;
    const linksHung = (g: string) => [...(storedInstances(getCurrentWorld()).get(g)?.record.list.rows.values() ?? [])].some((row) => row.own?.some((o) => o.guid === hungGuid));
    expect(linksHung(p1().guid!), 'premise: the placeholder\'s record links it').toBe(true);

    const before = be.snapshot();
    { const d = JSON.parse(text); d.entities = d.entities.filter((e: any) => e.name !== 'B'); be.write(f.prefabs.P.path, JSON.stringify(d)); }
    await flushWatcher(be, before);
    expect(piOf(p1().id)?.source, 'P1 is live again').toBe(f.prefabs.P.guid);
    expect(linksHung(p1().guid!), 'the node hung on the placeholder stays linked').toBe(true);
    // The record, not a capture of the live tree, is what states P1 (#2001 S8b): it keeps the row of the B the prefab no
    // longer has, which no live node shows. A save and reload gives the same records back.
    const mine = structuredClone(storedInstances(getCurrentWorld()).get(p1().guid!)!.record.list);
    const shown = worldTree();
    expect(await reloadTree(f), 'a save and reload builds the same world').toEqual(shown);
    expect(storedInstances(getCurrentWorld()).get(p1().guid!)!.record.list, 'and P1\'s records').toEqual(mine);
  });
});

// #2001 S8b: a copy of a Missing Prefab placeholder carries its record (#1699: "a duplicate keeps the data too") on records,
// under the identities the copy plan re-minted for it, so the copy shares none with the source.
describe('a copy of a placeholder keeps the records', () => {
  it('the copy has a fresh record of its own, re-guided; the undo takes it away, every record fresh', async () => {
    const f = await startRun(be, noNest, 'copy-placeholder');
    await trash(f, 'P');
    const p1 = getAllEntities().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const src = storedInstances(getCurrentWorld()).get(p1.guid!)!;
    expect(piOf(p1.id), 'premise: it is a placeholder').toBeUndefined();

    const copy = duplicateEntity(p1.id, () => {})!;
    const copyGuid = getAllEntities().find((e) => e.id === copy)!.guid!;
    const rec = storedInstances(getCurrentWorld()).get(copyGuid);
    expect(rec!.record.source).toBe(src.record.source);
    const pins = (r: typeof src.record) => [...r.list.rows.values()].map((row) => row.guid).filter(Boolean);
    expect(pins(rec!.record).length, 'premise: the record pins members').toBeGreaterThan(0);
    expect(pins(rec!.record).filter((g) => pins(src.record).includes(g)), 'no identity shared with the source').toEqual([]);

    expect((await undoStep('undo')).did).toBe(true);
    expect(storedInstances(getCurrentWorld()).has(copyGuid)).toBe(false);
  });
});

// #2001 S8b: a delete of a placeholder takes its record (rule 9 kept it); nothing projects it, so the undo seats the record
// back beside the respawned placeholder, exactly, and the redo takes it again.
describe('a delete of a placeholder keeps the records', () => {
  it('undo seats its record back exactly, fresh; redo takes it away', async () => {
    const f = await startRun(be, noNest, 'delete-placeholder');
    await trash(f, 'P');
    const p1 = getAllEntities().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const before = structuredClone(storedInstances(getCurrentWorld()).get(p1.guid!));
    expect(piOf(p1.id), 'premise: it is a placeholder').toBeUndefined();

    deleteEntityWithUndo(p1.id);
    expect(storedInstances(getCurrentWorld()).has(p1.guid!), 'the delete takes its record').toBe(false);
    expect((await undoStep('undo')).did).toBe(true);
    expect(storedInstances(getCurrentWorld()).get(p1.guid!)).toEqual(before);
    expect((await undoStep('redo')).did).toBe(true);
    expect(storedInstances(getCurrentWorld()).has(p1.guid!)).toBe(false);
  });
});

// …and one nested in a live instance: the instance's records are seated around the respawned placeholder (#2001 S8b).
describe('a delete of a placeholder nested in a live instance keeps the records', () => {
  it('undo and redo leave every record exact and fresh', async () => {
    const f = await startRun(be, noNest, 'delete-nested-placeholder');
    const p1 = () => getAllEntities().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const a = getAllEntities().find((e) => e.name === 'A' && e.parentId === p1().id)!;
    const placed = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: a.id }))!;
    const qGuid = getAllEntities().find((e) => e.id === placed)!.guid!;
    await trash(f, 'Q');
    const q = getAllEntities().find((e) => e.guid === qGuid)!;
    expect(piOf(q.id), 'premise: the placed Q is a placeholder now').toBeUndefined();
    expect(piOf(p1().id)?.rootInstanceId, 'premise: P1 is live').toBe(p1().id);
    const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, r]) => [g, structuredClone(r)]));
    const before = store();

    deleteEntityWithUndo(q.id);
    const after = store();
    expect(after.has(qGuid), 'the delete takes its record').toBe(false);
    expect((await undoStep('undo')).did).toBe(true);
    expect(store(), 'the undo seats back the exact records').toEqual(before);
    expect((await undoStep('redo')).did).toBe(true);
    expect(store()).toEqual(after);
  });
});

// …and with the tree's own node it hangs under: that node and the placeholder come back from their snapshots, and the
// tree's records are seated (a reprojection cannot rebuild the placeholder).
describe('a delete of the member a nested placeholder hangs under keeps the records', () => {
  it('undo brings both back with the exact records, fresh', async () => {
    const f = await startRun(be, noNest, 'delete-member-over-placeholder');
    const p1 = () => getAllEntities().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const a = () => getAllEntities().find((e) => e.name === 'A' && e.parentId === p1().id)!;
    const placed = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: a().id }))!;
    const qGuid = getAllEntities().find((e) => e.id === placed)!.guid!;
    await trash(f, 'Q');
    const aGuid = a().guid!;
    const store = () => new Map([...storedInstances(getCurrentWorld())].map(([g, r]) => [g, structuredClone(r)]));
    const before = store();

    deleteEntityWithUndo(a().id);
    expect(getAllEntities().some((e) => e.guid === qGuid), 'premise: the placeholder went with A').toBe(false);
    expect((await undoStep('undo')).did).toBe(true);
    const backA = getAllEntities().find((e) => e.guid === aGuid);
    expect(backA, 'A is back').toBeDefined();
    expect(getAllEntities().find((e) => e.guid === qGuid)?.parentId, 'the placeholder is back under it').toBe(backA!.id);
    expect(store(), 'the undo seats back the exact records').toEqual(before);
  });
});

describe('#2067: an outside move is a move, not a delete', () => {
  // The watcher's one batch holds the unlink and the add. Mutation: drop the `to` branch in `landAdopts` → the old path is
  // reported deleted, Q is tombstoned and its frames become placeholders.
  it('a prefab moved outside the editor keeps its instances linked, is logged as moved, and survives a reload', async () => {
    const f = await startRun(be, noNest, '2067-move');
    const live = framesOf(f.prefabs.Q.guid);
    const moved = f.prefabs.Q.path.replace(/[^/]+$/, 'moved/Q.prefab.json');
    // The editor holds Q under its PATH too, as a live editor does once anything read it by path: the move's rekey then
    // seats the new path's key, which the adopt of the new path must not take for an editor write (live, 2026-10-03).
    expect(await getPrefabSource(f.prefabs.Q.path), 'premise: Q held under its path').not.toBeNull();
    const before = be.snapshot();
    const text = be.read(f.prefabs.Q.path)!;
    be.remove(f.prefabs.Q.path);
    be.write(moved, text);
    const log = logs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await flushWatcher(be, before);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n'), 'the moved file is adopted, not refused').not.toMatch(/was not re-imported/);
      expect(log.text()).toContain(`${f.prefabs.Q.path} was moved outside the editor to ${moved} — its instances stay linked`);
      expect(log.text()).not.toMatch(/deleted outside the editor/);
    } finally { log.restore(); warn.mockRestore(); }
    expect(editorPrefabDeleted(f.prefabs.Q.guid), 'not tombstoned').toBe(false);
    expect(framesOf(f.prefabs.Q.guid), 'every Q frame stays live').toBe(live);
    expect(unexpandedRows().size).toBe(0);
    const shown = worldTree();
    expect(await reloadTree(f), 'the reload resolves Q at its new path').toEqual(shown);
  });

  // The common case: the editor holds Q by GUID only, so no held document names the gone path, and only the manifest's
  // record of the move (`guidMovedFrom`) finds it. Mutation: `guidMovedFrom` answers undefined → reported deleted.
  it('a prefab held by GUID only, moved outside the editor, is found by the manifest\'s record of the move', async () => {
    const f = await startRun(be, noNest, '2067-move-guid');
    const live = framesOf(f.prefabs.Q.guid);
    const moved = f.prefabs.Q.path.replace(/[^/]+$/, 'moved/Q.prefab.json');
    const before = be.snapshot();
    const text = be.read(f.prefabs.Q.path)!;
    be.remove(f.prefabs.Q.path);
    be.write(moved, text);
    const log = logs();
    try {
      await flushWatcher(be, before);
      expect(log.text()).toContain(`${f.prefabs.Q.path} was moved outside the editor to ${moved} — its instances stay linked`);
    } finally { log.restore(); }
    expect(editorPrefabDeleted(f.prefabs.Q.guid)).toBe(false);
    expect(framesOf(f.prefabs.Q.guid)).toBe(live);
  });

  // A real delete keeps its wording and outcome (QA-PREFAB-0030): the GUID lives nowhere else.
  it('a delete whose GUID comes back at another path in a LATER batch is a delete, then a put-back', async () => {
    const f = await startRun(be, noNest, '2067-later');
    const live = framesOf(f.prefabs.Q.guid);
    const text = be.read(f.prefabs.Q.path)!;
    let before = be.snapshot();
    be.remove(f.prefabs.Q.path);
    const log = logs();
    try {
      await flushWatcher(be, before);
      expect(log.text()).toMatch(/was deleted outside the editor/);
    } finally { log.restore(); }
    expect(framesOf(f.prefabs.Q.guid)).toBe(0);
    before = be.snapshot();
    be.write(f.prefabs.Q.path.replace(/[^/]+$/, 'back/Q.prefab.json'), text);
    await flushWatcher(be, before);
    expect(framesOf(f.prefabs.Q.guid), 'the put-back at a new path relinks them by GUID').toBe(live);
  });
});

describe('#2144: a copy taken before its prefab was trashed pastes as its Missing Prefab placeholder', () => {
  // Hunt seeds 9443 / 8056 (copy ; trashPrefab ; paste): pasted INSIDE another instance (HR's QR > M), the copy's frame
  // of P was kept live by HR's reprojection while its record folded to a Missing Prefab placeholder — the live tree
  // was not what a save writes or a reload shows. Hub ruling (B), 2026-10-05, as Unity pastes it: the paste shows the
  // placeholder at once, top-level and nested alike, through the trash's own conversion. Mutation: drop the
  // `showDeletedPrefabsMissing` call in `spawnOnRecords` (`entityActions.ts`) → the paste lands as P's live tree, and
  // the reload does not show what the paste showed.
  const hrM = () => {
    const hr = named('HR');
    const parentOf = new Map(getAllEntities().map((e) => [e.id, e.parentId] as const));
    const under = (id: number) => { for (let a = id, n = 0; a && n < 64; a = parentOf.get(a) ?? 0, n++) if (a === hr.id) return true; return false; };
    return getAllEntities().find((e) => e.name === 'M' && under(e.id))!;
  };
  /** The fuzzer's fixture step (`runner.ts` `setupNest`): Q dropped under H1's root, a scene-added reference node. */
  const nestQ = async (f: Fixture) => {
    const host = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!;
    const q = JSON.parse((await (await fetch(f.prefabs.Q.path)).text()) as string);
    expect(await instantiatePrefabInstance(q, f.prefabs.Q.path, host.id)).toBeTruthy();
  };
  const p1Of = (f: Fixture) => getAllEntities().find((e) => { const pi = piOf(e.id); return e.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === e.id; })!;

  it('pasted inside another instance, or at the top level, it shows as the placeholder a reload shows', async () => {
    const f = await startRun(be, nestQ, '2144-paste');
    const clip = clipEntity(p1Of(f).id, 'copy')!;
    expect(clip, 'premise: the live P1 copies').not.toBeNull();
    await trash(f, 'P');
    const m = hrM();
    expect(m, 'premise: HR holds QR > M').toBeDefined();
    const before = worldTree();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pasted: string[] = [];
      for (const [where, parent] of [['nested', m.id], ['top level', 0]] as const) {
        const id = pasteEntityCopy(clip, parent, () => {});
        expect(id, where).not.toBeNull();
        const guid = getAllEntities().find((e) => e.id === id)!.guid!;
        await deletedPrefabsShown();
        await settle();
        expect(framesOf(f.prefabs.P.guid), `${where}: no frame of P is live`).toBe(0);
        expect(placeholderGuids().has(guid), `${where}: the paste is P's placeholder`).toBe(true);
        pasted.push(guid);
      }
      const shown = worldTree();
      // Each paste is one undo step, the conversion's reload in between; a redo respawns the copy and shows it again.
      for (const dir of ['undo', 'undo'] as const) expect((await undoStep(dir)).did, dir).toBe(true);
      await settle();
      expect(worldTree(), 'undo takes both pastes out').toEqual(before);
      for (const dir of ['redo', 'redo'] as const) expect((await undoStep(dir)).did, dir).toBe(true);
      await deletedPrefabsShown();
      await settle();
      expect(worldTree(), 'redo shows both placeholders again').toEqual(shown);
      expect(await reloadTree(f), 'a save and reload shows what the pastes showed').toEqual(shown);
      for (const g of pasted) expect(placeholderGuids().has(g)).toBe(true);
    } finally { warn.mockRestore(); }
  });

  // Where the conversion does not run, the copy is refused (#2144 close-out review): in prefab edit it pasted P's live tree,
  // and the prefab's save wrote a nest naming the deleted P into H. Mutation: drop the `editingPrefab` arm of the refusal in
  // `spawnOnRecords` → the paste lands and H's file names P.
  it('in prefab edit, where no conversion runs, it is refused and the template is untouched', async () => {
    const f = await startRun(be, noNest, '2144-paste-prefab-edit');
    const clip = clipEntity(p1Of(f).id, 'copy')!;
    await trash(f, 'P');
    expect(await openPrefabForEditing({ path: f.prefabs.H.path, name: 'H' }, { confirmDiscard: async () => true })).toBeFalsy();
    const hr = getAllEntities().find((e) => e.name === 'HR')!;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(pasteEntityCopy(clip, hr.id, () => {}), 'refused').toBeNull();
      await settle();
      expect(framesOf(f.prefabs.P.guid), 'no frame of P is live').toBe(0);
      const said = err.mock.calls.map((c) => String(c[0])).filter((m) => /only in the open scene/.test(m));
      expect(said, 'the refusal says why').toHaveLength(1);
    } finally { err.mockRestore(); warn.mockRestore(); }
    await savePrefabEditReport({});
    await exitPrefabEditing();
    await settle();
    expect(be.read(f.prefabs.H.path), 'H names no P').not.toContain(f.prefabs.P.guid);
  });

  /** Paste `clip` under `parent`, expecting the refusal for a world the conversion does not run on. */
  const pasteRefused = (clip: NonNullable<ReturnType<typeof clipEntity>>, parent = 0) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(pasteEntityCopy(clip, parent, () => {}), 'refused').toBeNull();
      return err.mock.calls.map((c) => String(c[0])).filter((m) => /only in the open scene/.test(m));
    } finally { err.mockRestore(); warn.mockRestore(); }
  };

  // The other two arms (#2144 close-out review, tested on the hub's ask): inside Play the world is not the authored one, so
  // no conversion runs and the copy is refused; Stop puts back a world with no frame of P. Mutation: drop the
  // `!isWorldAuthored()` arm in `spawnOnRecords` → the paste lands in the Play world as P's live tree.
  it('inside Play it is refused, and Stop shows no frame of P', async () => {
    const f = await startRun(be, noNest, '2144-paste-play');
    const clip = clipEntity(p1Of(f).id, 'copy')!;
    await trash(f, 'P');
    expect((await enterPlay()).kind).toBe('started');
    await settle();
    expect(pasteRefused(clip), 'the refusal says why').toHaveLength(1);
    expect(framesOf(f.prefabs.P.guid), 'no frame of P in the Play world').toBe(0);
    await stopPlay();
    await settle();
    expect(framesOf(f.prefabs.P.guid), 'nor after Stop').toBe(0);
  });

  // Pasted under a base scene's entity, the copy takes the base's `sourceScene`, and the conversion keeps a base's live
  // tree (it reloads only the open scene's own), so the copy is refused. (At the top level it lands in the open scene and
  // converts.) Mutation: drop the `base` arm in `spawnOnRecords` → it lands as P's live tree under the base.
  it('a copy of a base scene\'s frame is refused', async () => {
    const f = await startRun(be, nestQ, '2144-paste-base');
    const lPath = f.scenePath.replace(/Fuzz\.json$/, 'Level.json');
    const lGuid = f.sceneGuid.replace(/^.{8}/, 'abababab');
    const level = { id: lGuid, version: SCENE_FORMAT_VERSION, name: 'Level', createdAt: '2026-01-01T00:00:00.000Z', resources: [], baseScene: f.sceneGuid, entities: [] };
    be.write(lPath, `${JSON.stringify(level, null, 2)}\n`);
    registerAsset(lGuid, lPath, 'scene');
    be.marked.clear();
    expect((await loadSceneReporting(lPath)).outcome).toBe('loaded');
    await settle();
    const p1 = p1Of(f);
    expect((readTraitData(p1.id, getTraitByName('EntityAttributes')!) as { sourceScene?: string }).sourceScene, 'premise: P1 is the base\'s').toBeTruthy();
    const clip = clipEntity(p1.id, 'copy')!;
    await trash(f, 'P');
    const live = framesOf(f.prefabs.P.guid);
    expect(live, 'premise: the base keeps its live P frames').toBeGreaterThan(0);
    const m = hrM();
    expect((readTraitData(m.id, getTraitByName('EntityAttributes')!) as { sourceScene?: string }).sourceScene, 'premise: HR\'s M is the base\'s').toBeTruthy();
    expect(pasteRefused(clip, m.id), 'the refusal says why').toHaveLength(1);
    expect(framesOf(f.prefabs.P.guid), 'nothing pasted').toBe(live);
  });

  // Control: a copy of P1's placeholder (a placeholder is projected from its record, never kept) pastes inside HR as it
  // did, and reloads as it shows.
  it('a copy of the placeholder still pastes inside another instance', async () => {
    const f = await startRun(be, nestQ, '2144-placeholder');
    const root = p1Of(f);
    await trash(f, 'P');
    const ph = getAllEntities().find((e) => e.guid === root.guid)!;
    expect(placeholderGuids().has(ph.guid!), 'premise: P1 is its placeholder').toBe(true);
    const clip = clipEntity(ph.id, 'copy')!;
    expect(clip).not.toBeNull();
    const pasted = pasteEntityCopy(clip, hrM().id, () => {});
    expect(pasted).not.toBeNull();
    await settle();
    expect(framesOf(f.prefabs.P.guid)).toBe(0);
    const shown = worldTree();
    expect(await reloadTree(f), 'a save and reload shows what the paste showed').toEqual(shown);
  });
});

describe('#2146: an undone delete of a frame whose prefab was trashed since shows its Missing Prefab placeholder', () => {
  // The sibling of #2144's ruling (B): delete a frame of P, trash P, undo the delete. The undo respawned P's live tree, which
  // a reload then showed as the placeholder — the world on screen was not the one a reload builds. It now runs the trash's
  // conversion too. Mutation: drop the `showDeletedPrefabsMissing` call in the delete's undo (`entityActions.ts`) → the
  // top-level frame and a P instance the user placed under H1's root come back as P's live tree. The frame O's TEMPLATE
  // nests (O1's N) is a CONTROL, green under that mutation: O1's records put N back, and the record of a frame whose
  // prefab is gone already projects it as its placeholder. A scene-added nested instance has no such record to come back
  // through (close-out review).
  const topP1 = (f: Fixture) => getAllEntities().find((e) => { const pi = piOf(e.id); return e.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === e.id; })!;
  /** O1's N: the P frame nested in O. */
  const nInO1 = (f: Fixture) => {
    const o1 = getAllEntities().find((e) => e.guid === `ffffffff-0000-4000-8001-${f.prefabs.P.guid.slice(-12)}`)!;
    const parentOf = new Map(getAllEntities().map((e) => [e.id, e.parentId] as const));
    const under = (id: number) => { for (let a = parentOf.get(id) ?? 0, n = 0; a && n < 64; a = parentOf.get(a) ?? 0, n++) if (a === o1.id) return true; return false; };
    return getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.P.guid && pi.rootInstanceId === e.id && under(e.id); })!;
  };

  it('placed by the user under H1\'s root: the undo shows the placeholder a reload shows', async () => {
    const f = await startRun(be, noNest, '2146-h1');
    const h1 = getAllEntities().find((e) => { const pi = piOf(e.id); return e.parentId === 0 && pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!;
    expect(await placePrefabFromPath(f.prefabs.P.path, { tag: 'test', parentId: h1.id })).toBeTruthy();
    await settle();
    const placed = getAllEntities().find((e) => { const pi = piOf(e.id); return e.parentId === h1.id && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === e.id; })!;
    expect(placed, 'premise: a P instance under H1').toBeDefined();
    const guid = placed.guid!;
    deleteEntityWithUndo(placed.id);
    await settle();
    await trash(f, 'P');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await undoStep('undo')).did, 'the delete undoes').toBe(true);
      await deletedPrefabsShown();
      await settle();
      expect(framesOf(f.prefabs.P.guid), 'no frame of P is live').toBe(0);
      expect(placeholderGuids().has(guid), 'the undone instance is P\'s placeholder').toBe(true);
      const shown = worldTree();
      expect(await reloadTree(f), 'a save and reload shows what the undo showed').toEqual(shown);
    } finally { warn.mockRestore(); }
  });

  for (const [where, pick] of [['top level', topP1], ['nested by O\'s template (control)', nInO1]] as const) {
    it(`${where}: the undo shows the placeholder a reload shows; redo and undo again keep it so`, async () => {
      const f = await startRun(be, noNest, `2146-${where}`);
      const target = pick(f);
      expect(target, 'premise: the frame of P').toBeDefined();
      const guid = target.guid!;
      deleteEntityWithUndo(target.id);
      await settle();
      await trash(f, 'P');
      expect(framesOf(f.prefabs.P.guid), 'premise: the trash left no live frame of P').toBe(0);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect((await undoStep('undo')).did, 'the delete undoes').toBe(true);
        await deletedPrefabsShown();
        await settle();
        expect(framesOf(f.prefabs.P.guid), 'no frame of P is live').toBe(0);
        expect(placeholderGuids().has(guid), 'the undone frame is P\'s placeholder').toBe(true);
        const shown = worldTree();
        expect((await undoStep('redo')).did, 'redo').toBe(true);
        await settle();
        expect(getAllEntities().some((e) => e.guid === guid), 'redo deletes it again').toBe(false);
        expect((await undoStep('undo')).did, 'undo again').toBe(true);
        await deletedPrefabsShown();
        await settle();
        expect(worldTree(), 'the second undo shows the same world').toEqual(shown);
        expect(await reloadTree(f), 'a save and reload shows what the undo showed').toEqual(shown);
      } finally { warn.mockRestore(); }
    });
  }
});

// #2144 seed 8045: an instance the user placed AT the root of an instance whose prefab is then trashed shows under the
// Missing Prefab placeholder, its own record (hub ruling Q3 on #2025: "`/` is always nameable, so a link there is
// projected"). The seed's shape: the trashed Q instance is itself scene-added inside H1; the top-level Q is the control.
describe('#2144 8045: an instance at a trashed instance\'s root stays, under its placeholder', () => {
  const qDoc = async (f: Fixture) => JSON.parse((await (await fetch(f.prefabs.Q.path)).text()) as string);
  const oDoc = async (f: Fixture) => JSON.parse((await (await fetch(f.prefabs.O.path)).text()) as string);
  const nestQ = async (f: Fixture) => {
    const host = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.H.guid && pi.rootInstanceId === e.id; })!;
    expect(await instantiatePrefabInstance(await qDoc(f), f.prefabs.Q.path, host.id)).toBeTruthy();
  };
  const qAt = (f: Fixture, top: boolean) => getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.Q.guid && pi.rootInstanceId === e.id && (e.parentId === 0) === top && (top || getAllEntities().find((h) => h.id === e.parentId)?.name === 'HR'); })!;

  for (const top of [false, true]) {
    it(`${top ? 'top-level (control)' : 'inside H1 (the seed)'}: O at Q's root shows under Q's placeholder, and after a reload`, async () => {
      const f = await startRun(be, top ? noNest : nestQ, `2144-8045-${top}`);
      if (top) expect(await instantiatePrefabInstance(await qDoc(f), f.prefabs.Q.path, 0)).toBeTruthy();
      await settle();
      const q = qAt(f, top);
      expect(q, 'premise: the Q instance').toBeTruthy();
      expect(await instantiatePrefabInstance(await oDoc(f), f.prefabs.O.path, q.id)).toBeTruthy();
      await settle();
      const o = getAllEntities().find((e) => { const pi = piOf(e.id); return pi?.source === f.prefabs.O.guid && pi.rootInstanceId === e.id && e.parentId === q.id; })!;
      expect(o, 'premise: O placed at Q\'s root').toBeTruthy();
      await trash(f, 'Q');
      expect(placeholderGuids().has(q.guid!), 'premise: Q is its placeholder').toBe(true);
      const shown = () => getAllEntities().find((e) => e.guid === o.guid);
      const parentGuid = () => getAllEntities().find((e) => e.id === shown()?.parentId)?.guid;
      expect(shown(), 'O stays').toBeTruthy();
      expect(parentGuid(), 'under the placeholder').toBe(q.guid);
      expect(storedInstances(getCurrentWorld()).has(o.guid!), 'O is its own record').toBe(true);
      const tree = worldTree();
      // A rebuild from the store of the instance holding Q's placeholder (H1) projects O from the placeholder's record,
      // not from the node the placeholder carries (the links taken out of it).
      if (!top) {
        const h1 = getAllEntities().find((e) => e.name === 'HR' && e.parentId === 0)!;
        expect(reprojectFromStore(h1.id), 'premise: H1 rebuilds').toBeTruthy();
        await settle();
        expect(shown(), 'O stays through the rebuild').toBeTruthy();
        expect(parentGuid()).toBe(q.guid);
        expect(worldTree(), 'the rebuild is the identity').toEqual(tree);
      }
      expect(await reloadTree(f), 'a save and reload shows what the trash showed').toEqual(tree);
    });
  }
});
