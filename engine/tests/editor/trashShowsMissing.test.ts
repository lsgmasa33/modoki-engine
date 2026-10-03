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
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { editorPrefabDeleted, getPrefabSource } from '../../packages/modoki/src/editor/scene/prefabCache';
import { writeTraitFieldWithUndo, duplicateEntity, clipEntity } from '../../packages/modoki/src/editor/undo/entityActions';
import { isRowPlaceholder } from '../../packages/modoki/src/editor/undo/placeholderGate';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { runAsCompositeAction } from '../../packages/modoki/src/editor/undo/compositeAction';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';
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
const staleRecords = () => [...storedInstances(getCurrentWorld()).entries()].filter(([, r]) => r.stale).map(([g, r]) => `${g}:${r.stale}`);
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
    expect(staleRecords(), 'the load took back every record exactly (the baseline an aborted reload\'s retry is held to)').toEqual([]);
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
    // `staleAroundUnless` again → every record reads stale here.
    expect(staleRecords(), 'the retry\'s world holds fresh records, as a clean conversion\'s does').toEqual([]);
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
