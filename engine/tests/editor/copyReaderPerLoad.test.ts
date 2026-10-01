/** #1934 (E7 round 4, area 4c): the scene's copies of missing prefabs (#1867, F8 = A1) meet two loads and a chain.
 *
 *  S1 — ONE reader per load. A placeholder whose prefab returns IN PLACE (an outside put-back released by focus or
 *  `modoki_refresh`) is re-expanded by `reexpandEntryPlaceholder` through `loadSceneFile`. It expanded with the editor's
 *  cache, which holds no copies, while the load's settle read WITH them: a nested frame a copy backs stayed unexpanded,
 *  R2's orphan test called its rows backed, and the next save wrote nothing for them. A reload of the same file expanded
 *  that frame from the copy. Hunt seed 1212 was the same two readers the other way round. `loadSceneFile` now takes one
 *  `read`, adds the copies to it, expands and settles with it, and refuses an expansion that used another.
 *
 *  L1 — a copy belongs to its SCENE. The store was per world, so in a base + level chain the level's copy was written
 *  into the base's file at the base's next save, and the base's reload then expanded frames that were unexpanded at its
 *  save (R7 fork A, I23).
 *
 *  Driven through the real editor over the fuzzer's in-process backend (`prefabFuzz/harness.ts`): #1707's fixture, where
 *  P is R → A → B plus row C expanding Q (QR → M), O nests P, and the scene holds P1 and O1. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getTraitByName, getAllEntities, getCurrentWorld } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, unexpandedRows, flushWatcher, placeholderGuids, type Fixture } from './prefabFuzz/harness';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { writeTraitFieldWithUndo, deleteEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { saveScene, saveAll, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { loadSceneFile, instantiatePrefabIntoWorld, type ExpansionReader, type SceneData } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const noNest = async () => {};
const TF = () => getTraitByName('Transform')!;
const ty = (id: number) => (readTraitData(id, TF()) as Record<string, number> | null)?.y;

/** Trash a fixture prefab as the Assets panel does, and let the watcher see it. */
async function trash(f: Fixture, which: 'P' | 'Q'): Promise<void> {
  const path = f.prefabs[which].path;
  const before = be.snapshot();
  expect((await deleteAssetFiles(deletionPathsFor(path, 'prefab', null))).ok).toBe(true);
  unbindDeletedAssetEditors([path]);
  await flushWatcher(be, before);
  await settle();
}
/** The top-level instance of P (P1). */
const p1Id = (f: Fixture) => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.P.guid && pi.rootInstanceId === x.id; })!.id;
/** Q's member M inside the subtree of `root`, if it is live. */
function mUnder(f: Fixture, root: number): number | undefined {
  const all = getAllEntities();
  const under = new Set<number>([root]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (!under.has(e.id) && under.has(e.parentId)) { under.add(e.id); grew = true; } }
  return all.find((x) => under.has(x.id) && x.name === 'M' && piOf(x.id)?.source === f.prefabs.Q.guid)?.id;
}
type Entry = { guid?: string; members?: Record<string, { traits?: { Transform?: { y?: number } } }> };
/** The member-row key of P1's entry (by guid) that states Transform.y = `y`, in the saved file. */
const rowWithY = (f: Fixture, guid: string, y: number) => {
  const e = (JSON.parse(be.read(f.scenePath)!) as { entities: Entry[] }).entities.find((x) => x.guid === guid)!;
  return Object.keys(e.members ?? {}).find((k) => e.members![k]!.traits?.Transform?.y === y);
};

/** O1 deleted; M.y = 6 on P1's Q frame; trash Q, then P; save; reload as a build BEFORE #1935 wrote the file, so P1
 *  reloads as its placeholder while the world holds the copy of Q its Q frame was expanded from. That older build copied
 *  the NESTED frame (Q) and never a top-level one (P): the file is today's save without P's copy. Since #1935 today's own
 *  file expands P1 from P's copy, so this is the shape the in-place return still meets a placeholder in. */
async function missingBoth(key: string) {
  const f = await startRun(be, noNest, key);
  const o1 = getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs.O.guid && pi.rootInstanceId === x.id; })!.id;
  deleteEntitiesWithUndo([o1]);
  await settle();
  const p1 = p1Id(f);
  const p1Guid = getAllEntities().find((x) => x.id === p1)!.guid!;
  expect(writeTraitFieldWithUndo(mUnder(f, p1)!, TF(), 'y', 6)).toBeFalsy();
  await settle();
  const pText = be.read(f.prefabs.P.path)!;
  await trash(f, 'Q');
  await trash(f, 'P');
  expect((await saveScene({ allowDialog: false })).saved).toBe(true);
  const file = JSON.parse(be.read(f.scenePath)!) as { embeddedPrefabs?: Record<string, unknown> };
  expect(Object.keys(file.embeddedPrefabs ?? {}).sort(), 'premise: the save copies P and Q').toEqual([f.prefabs.P.guid, f.prefabs.Q.guid].sort());
  const rowKey = rowWithY(f, p1Guid, 6);
  expect(rowKey, 'premise: P1 states M.y = 6 on a member row').toBeTruthy();
  delete file.embeddedPrefabs![f.prefabs.P.guid]; // the file as the build before #1935 wrote it
  be.write(f.scenePath, `${JSON.stringify(file, null, 2)}\n`);
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
  expect(placeholderGuids().has(p1Guid), 'premise: P1 reloads as a placeholder').toBe(true);
  return { f, p1Guid, rowKey: rowKey!, pText };
}

describe('#1934 S1: one reader per load — a placeholder returning in place reads the scene\'s copies', () => {
  it('P put back through the outside-change hold: P1 re-expands its Q frame from the copy, as a reload does, and the save keeps the edit', async () => {
    // Mutation: in `reexpandEntryPlaceholder` drop `read:` from the load's options and expand with `getCachedPrefabSync`
    // again (the pre-fix reader, no copies) → the expansion is refused (the guard below); remove the guard as well → M is
    // absent under P1 and the saved row is gone (`expected undefined to be '/…'`), the reviewer's observed defect.
    const { f, p1Guid, rowKey, pText } = await missingBoth('s1-inplace');
    const before = be.snapshot();
    be.write(f.prefabs.P.path, pText);
    await flushWatcher(be, before); // the outside put-back, released at once (focus / `modoki_refresh`)
    await settle();
    expect(placeholderGuids().has(p1Guid), 'premise: P1 re-expanded in place').toBe(false);
    const m = mUnder(f, getAllEntities().find((x) => x.guid === p1Guid)!.id);
    expect(m, 'the Q frame expands from the copy, as the reload in the next case does').toBeTruthy();
    expect(ty(m!)).toBe(6);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(rowWithY(f, p1Guid, 6)).toBe(rowKey);
  });

  it('control: the same return by a RELOAD expands P1\'s Q frame from the copy with M.y = 6', async () => {
    const { f, p1Guid, pText } = await missingBoth('s1-reload');
    be.write(f.prefabs.P.path, pText);
    registerAsset(f.prefabs.P.guid, f.prefabs.P.path, 'prefab');
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    const m = mUnder(f, getAllEntities().find((x) => x.guid === p1Guid)!.id);
    expect(m).toBeTruthy();
    expect(ty(m!)).toBe(6);
  });
});

describe('#1934 S1: a load refuses an expansion that read with another reader', () => {
  /** A one-entry scene placing P, loaded into the live world with `expandWith` choosing the callback's reader. */
  async function loadP(f: Fixture, opts: { read?: ExpansionReader; expandWith: (handed: ExpansionReader | undefined) => ExpansionReader | undefined }) {
    const world = getCurrentWorld();
    const scene = { version: SCENE_FORMAT_VERSION, resources: [], entities: [{ id: 1, prefab: f.prefabs.P.guid, guid: 'abcdabcd-0000-4000-8000-000000000001', traits: { EntityAttributes: { name: 'Probe', parentId: 0 } } }] } as unknown as SceneData;
    return loadSceneFile(scene, {
      world, clearMarks: false, loadModels: false, read: opts.read,
      fetchPrefab: async (r) => (getCachedPrefabSync(r) as object | null) ?? null,
      onInstantiatePrefab: (source, parentId, rootTf, _old, _x, overrides, structure, nestedOverrides, _g, _f, nestedStructure, load) => {
        const read = opts.expandWith(load?.read);
        return instantiatePrefabIntoWorld(world, getCachedPrefabSync(source) as never, parentId, rootTf, source, overrides, structure, undefined, nestedOverrides, nestedStructure, read ? { read } : {});
      },
    });
  }
  const other: ExpansionReader = (r) => getCachedPrefabSync(r) as never;

  it('a callback expanding with its OWN reader is refused, with or without a load reader', async () => {
    // Mutation: delete the `usedRead` check after `onInstantiatePrefab` in `loadSceneFile` → both resolve.
    const f = await startRun(be, noNest, 's1-guard-refuse');
    await expect(loadP(f, { expandWith: () => other })).rejects.toThrow(/different document reader/);
    await expect(loadP(f, { read: other, expandWith: () => (r) => other(r) })).rejects.toThrow(/different document reader/);
  });

  it('accept side: the handed reader, or none at all when the load was given none, loads', async () => {
    // Mutation: compare `usedRead` against `options.read` instead of the composed `read` → the SECOND call is refused (no
    // load reader; the first passes, since with no copy loaded the composed reader IS `options.read`).
    const f = await startRun(be, noNest, 's1-guard-accept');
    await expect(loadP(f, { read: other, expandWith: (handed) => handed })).resolves.toBeUndefined();
    await expect(loadP(f, { expandWith: (handed) => handed })).resolves.toBeUndefined();
    await expect(loadP(f, { expandWith: () => undefined })).resolves.toBeUndefined();
    // Given its own reader, the load refuses an expansion that fell back to the default.
    await expect(loadP(f, { read: other, expandWith: () => undefined })).rejects.toThrow(/different document reader/);
  });
});

describe('#1934 L1: a copy belongs to the scene that carried it', () => {
  it('a base whose own frames were unexpanded is not saved with its level\'s copy, and its reload expands nothing new', async () => {
    // Mutation: in `collectEmbeddedPrefabs` read every scene's copies (`embeddedPrefabGuids` over all keys) → the base's
    // file gains the level's copy of Q, and its next reload expands the base's Q frames (2 → 0 unexpanded).
    const f = await startRun(be, noNest, 'l1-chain');
    const lPath = f.scenePath.replace(/Fuzz\.json$/, 'Level.json');
    const lGuid = f.sceneGuid.replace(/^.{8}/, 'abababab');
    const loGuid = lGuid.replace(/^.{8}/, 'acacacac');
    const level = {
      id: lGuid, version: SCENE_FORMAT_VERSION, name: 'Level', createdAt: '2026-01-01T00:00:00.000Z', resources: [], baseScene: f.sceneGuid,
      entities: [{ id: 1, prefab: f.prefabs.O.guid, guid: loGuid, traits: { EntityAttributes: { name: 'LO', parentId: 0 }, Transform: { x: 9, y: 0, z: 0 } } }],
    };
    be.write(lPath, `${JSON.stringify(level, null, 2)}\n`);
    registerAsset(lGuid, lPath, 'scene');
    const xPath = f.scenePath.replace(/Fuzz\.json$/, 'Other.json');
    const xGuid = f.sceneGuid.replace(/^.{8}/, 'adadadad');
    be.write(xPath, `${JSON.stringify({ id: xGuid, version: SCENE_FORMAT_VERSION, name: 'X', createdAt: '2026-01-01T00:00:00.000Z', resources: [], entities: [] }, null, 2)}\n`);
    registerAsset(xGuid, xPath, 'scene');
    be.marked.clear();
    const reopenLevel = async () => {
      expect((await loadSceneReporting(xPath)).outcome).toBe('loaded');
      await settle();
      expect((await loadSceneReporting(lPath)).outcome).toBe('loaded'); // the base F loads first, then L
      await settle();
    };
    expect((await loadSceneReporting(lPath)).outcome).toBe('loaded');
    await settle();
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    await trash(f, 'Q');
    // An edit in L only: L's save carries the copy (its Q frames are live), F is not written.
    expect(writeTraitFieldWithUndo(getAllEntities().find((e) => e.guid === loGuid)!.id, TF(), 'x', 10)).toBeFalsy();
    await settle();
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect(Object.keys((JSON.parse(be.read(lPath)!) as { embeddedPrefabs?: object }).embeddedPrefabs ?? {}), 'premise: L carries Q').toEqual([f.prefabs.Q.guid]);
    expect((JSON.parse(be.read(f.scenePath)!) as { embeddedPrefabs?: object }).embeddedPrefabs, 'premise: F carries none').toBeUndefined();
    // Reopen: F loads before L's copy is in the world, so F's own Q frames stay unexpanded (fork A).
    await reopenLevel();
    const unexpandedAtSave = unexpandedRows().size;
    expect(unexpandedAtSave, 'premise: F\'s Q frames are unexpanded').toBeGreaterThan(0);
    // An edit of F's own, then Save All: F is written, with no copy of its own to carry.
    expect(writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Plain')!.id, TF(), 'x', 3)).toBeFalsy();
    await settle();
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect((JSON.parse(be.read(f.scenePath)!) as { embeddedPrefabs?: object }).embeddedPrefabs).toBeUndefined();
    await reopenLevel();
    expect(unexpandedRows().size, 'the reload shows F as it was saved').toBe(unexpandedAtSave);
  });
});

describe('#1939 item 2 (serious): the copy store is carried across an Apply undo\'s world swap', () => {
  // Hunt seed 1268's route, directed. The Apply's snapshot is taken while Q is present, so it carries no copy of Q; Q is
  // trashed after (its live frames kept, the save carries its copy); the Apply's undo reloads the snapshot. Without the
  // carry, Q's frames came back unexpanded and the next save wrote no copy for them.
  // Mutation: drop `sceneCopies` from `applyPrefabUndo.ts`' three restores → `expected 2 to be 0` (unexpanded rows).
  it('undoing an Apply after a nested prefab was trashed keeps that prefab\'s live frames and its copy', async () => {
    const f = await startRun(be, noNest, 'c2-undo-swap');
    const qCount = () => getAllEntities().filter((e) => piOf(e.id)?.source === f.prefabs.Q.guid).length;
    const p1 = p1Id(f);
    expect(writeTraitFieldWithUndo(p1, TF(), 'x', 5)).toBeFalsy();
    await settle();
    const keys = collectInstanceOverrideKeys(p1, getCachedPrefabSync(f.prefabs.P.guid)!);
    const sel = new Set(keys.all.filter((k) => k.includes('Transform')));
    expect(sel.size, 'premise: the root x edit is an override').toBeGreaterThan(0);
    expect((await applyToPrefabWithUndo(p1, sel)).applied).toBe(true);
    await settle();
    await trash(f, 'Q');
    const live = qCount();
    expect(live, 'premise: Q frames live after the trash').toBeGreaterThan(0);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(Object.keys(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs ?? {}), 'premise: the save carries Q').toContain(f.prefabs.Q.guid);
    expect((await undoStep('undo')).did).toBe(true); // the Apply
    await settle();
    expect(unexpandedRows().size).toBe(0);
    expect(qCount()).toBe(live);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(Object.keys(JSON.parse(be.read(f.scenePath)!).embeddedPrefabs ?? {})).toContain(f.prefabs.Q.guid);
  });
});
