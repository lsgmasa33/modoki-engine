/** #1939: a scene's copy of a missing prefab lists the frames it was LIVE for at the save (`embeddedPrefabFrames`, scene
 *  v19, `frameAddress.ts`), and the copy store is carried across a world swap.
 *
 *  Item 1 — the list. Before it, "live at the save" was read off the member rows the save happened to write, and the
 *  writer writes none inside a stored root's expansion (`memberRows` exclusion 2), so a frame inside a TEMPLATE reference
 *  node came back unexpanded (F3, T14: 6 Q entities live, 4 reloaded); a scene-added node never read a copy (M-b); and a
 *  top-level placeholder saved beside a live instance of its prefab reloaded expanded (C1).
 *
 *  Item 2 — the carry. A kept base is carried across a level switch, not reloaded, so its copies go with it (H1); Stop
 *  carries the edit world's, never the Play world's.
 *
 *  Driven through the real editor over the fuzzer's in-process backend (`prefabFuzz/harness.ts`): #1707's fixture, where
 *  P is R → A → B plus row C expanding Q (QR → M), O's row N nests P, and the scene holds O1, P1 and H1. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { getAllEntities, getTraitByName } from '@modoki/engine/runtime';
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, piOf, unexpandedRows, flushWatcher, placeholderGuids, authored, worldTree, type Fixture } from './prefabFuzz/harness';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { findEntity, readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { unbindDeletedAssetEditors } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { saveScene, saveAll, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { deleteEntitiesWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { enterPlay, stopPlay } from '../../packages/modoki/src/editor/scene/playMode';
import { validateSceneData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const noNest = async () => {};
const TF = () => getTraitByName('Transform')!;
type SceneFile = { entities: Array<Record<string, unknown> & { guid?: string; prefab?: string }>; embeddedPrefabs?: Record<string, unknown>; embeddedPrefabFrames?: Record<string, string[]> };
const file = (f: Fixture) => JSON.parse(be.read(f.scenePath)!) as SceneFile;
const write = (f: Fixture, sc: SceneFile) => be.write(f.scenePath, `${JSON.stringify(sc, null, 2)}\n`);
/** Live entities expanded from `guid`'s document. */
const countOf = (guid: string) => getAllEntities().filter((e) => piOf(e.id)?.source === guid).length;
const topRoot = (f: Fixture, which: 'O' | 'P') => getAllEntities().find((x) => { const pi = piOf(x.id); return x.parentId === 0 && pi?.source === f.prefabs[which].guid && pi.rootInstanceId === x.id; })!;

/** Trash a fixture prefab as the Assets panel does, and let the watcher see it. */
async function trash(f: Fixture, which: 'P' | 'Q'): Promise<void> {
  const before = be.snapshot();
  expect((await deleteAssetFiles(deletionPathsFor(f.prefabs[which].path, 'prefab', null))).ok).toBe(true);
  unbindDeletedAssetEditors([f.prefabs[which].path]);
  await flushWatcher(be, before);
  await settle();
}

async function reload(f: Fixture): Promise<void> {
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
}

describe('#1939 item 1: a copy restores exactly the frames its scene listed live at the save', () => {
  it('F3/T14: a Q frame inside a TEMPLATE reference node of O comes back from the copy (6 Q entities live, 6 reloaded)', async () => {
    // O's row N states a keyed reference node PN of P under N's A, so O1 holds three Q frames: P1's C, N's C, and PN's C.
    // Mutation: in `spawnReferenceNode`, hand the node's expansion no `frame` → PN's C answers by the rows rule, which the
    // writer never feeds inside a stored root's expansion → `expected 4 to be 6`.
    const f = await startRun(be, noNest, 'lf-template-node');
    const o = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ added?: unknown[] }> };
    o.entities[1]!.added!.push({ parentLocalId: 2, guid: '', key: 'k-pn', name: 'PN', prefab: f.prefabs.P.guid, traits: { EntityAttributes: { name: 'PN', parentId: 0 } }, children: [] });
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(o, null, 2)}\n`);
    await flushWatcher(be, before);
    await reload(f);
    expect(countOf(f.prefabs.Q.guid), 'premise: three Q frames live').toBe(6);
    await trash(f, 'Q');
    expect(countOf(f.prefabs.Q.guid), 'premise: the trash keeps them').toBe(6);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const listed = file(f).embeddedPrefabFrames![f.prefabs.Q.guid]!;
    expect(listed).toHaveLength(3);
    expect(listed.filter((a) => a.includes('/+k-pn/'))).toHaveLength(1);
    await reload(f);
    expect(countOf(f.prefabs.Q.guid)).toBe(6);
    expect(unexpandedRows().size).toBe(0);
    const bytes = be.read(f.scenePath)!;
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(bytes); // I23
  });

  it('C1: a placeholder ENTRY saved beside a live instance of its prefab stays a placeholder; the live one comes back', async () => {
    // Mutation: in `loadSceneFile`'s prefab loop, ask `copyBacksFrame` with no `entryFrame` (the pre-#1939 rule, always) →
    // the placeholder entry reloads expanded.
    const f = await startRun(be, noNest, 'lf-c1');
    await trash(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    const p1Guid = topRoot(f, 'P').guid!;
    expect(sc.embeddedPrefabFrames![f.prefabs.P.guid], 'premise: P1 is listed').toContain(p1Guid);
    // A second entry of P that was a Missing Prefab placeholder at the save: its record, and no list entry.
    const p2Guid = p1Guid.replace(/^.{8}/, '12121212');
    sc.entities.push({ prefab: f.prefabs.P.guid, guid: p2Guid, traits: { EntityAttributes: { name: 'P2', parentId: 0 }, Transform: { x: 20, y: 0, z: 0 } } });
    write(f, sc);
    await reload(f);
    expect(placeholderGuids().has(p2Guid)).toBe(true);
    expect(placeholderGuids().has(p1Guid)).toBe(false);
  });

  it('an address that resolves to nothing is ignored, and the validator names an unanchored one; the listed frames still come back', async () => {
    // Mutation: drop `embeddedPrefabFrameWarnings` from `validateSceneData` → the anchor warning is not reported.
    const f = await startRun(be, noNest, 'lf-unresolved');
    await trash(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    const list = sc.embeddedPrefabFrames![f.prefabs.P.guid]!;
    const ghost = 'abababab-0000-4000-8000-000000000001';
    list.push(ghost, `${list[0]}/eeeeeeee-0000-4000-8fff-000000000001`, `${list[0]}/+no-such-key`);
    write(f, sc);
    expect(validateSceneData(sc).warnings).toEqual([
      `embeddedPrefabFrames['${f.prefabs.P.guid}']: the frame '${ghost}' is anchored on no entity of this scene — the loader matches no frame to it`,
    ]);
    await reload(f);
    expect(placeholderGuids().size).toBe(0);
    expect(countOf(f.prefabs.P.guid)).toBeGreaterThan(0);
  });

  it('a frame with no address answers by the rows rule; a list that is not a list is ignored with a warning, never a throw', async () => {
    // An entry with no durable guid has no address: with an EMPTY list for P it still expands (the entry's rows rule,
    // always). Mutation: in `copyBacksFrame`, answer from the list whenever there is one (`live ? live.has(frame ?? '')`) →
    // the guid-less entry reloads a placeholder.
    const f = await startRun(be, noNest, 'lf-unaddressable');
    await trash(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const p1Guid = topRoot(f, 'P').guid!;
    const sc = file(f);
    sc.embeddedPrefabFrames![f.prefabs.P.guid] = [];
    write(f, sc);
    await reload(f);
    expect(placeholderGuids().has(p1Guid), 'premise: listed none → a placeholder').toBe(true);
    const bare = file(f);
    bare.embeddedPrefabFrames![f.prefabs.P.guid] = [];
    delete bare.entities.find((e) => e.guid === p1Guid)!.guid;
    write(f, bare);
    await reload(f);
    expect(countOf(f.prefabs.P.guid)).toBeGreaterThan(0);
    // A malformed list: warned and ignored (that copy answers by the rows rule again), and the load completes.
    const bad = file(f);
    (bad.embeddedPrefabFrames as Record<string, unknown>)[f.prefabs.P.guid] = 'not a list';
    write(f, bad);
    expect(validateSceneData(bad).warnings).toContain(`embeddedPrefabFrames['${f.prefabs.P.guid}']: not a list of frame addresses — the loader ignores it, and the copy answers by the member rows`);
    const warn = vi.spyOn(console, 'warn');
    await reload(f);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('embeddedPrefabFrames for'))).toBe(true);
    warn.mockRestore();
  });

  it('the settle asks the same list: a legacy channel into a frame with rows but not listed is kept, not dropped (S1 class)', async () => {
    // P1's row C (localId 4) expands Q. The file lists O1's Q frame but not P1's, while P1's own rows still state members
    // under C: the expansion leaves P1's C unexpanded (the list), so the settle must not read the frame as reached (the
    // rows). Mutation: revert `legacyPathDoc`'s stand-in line to the rows rule → the channel reads as reached, nothing
    // keeps it, and the save drops P1's `nestedOverrides`.
    const f = await startRun(be, noNest, 'lf-legacy-reach');
    await trash(f, 'Q');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    const p1Guid = topRoot(f, 'P').guid!;
    const p1 = sc.entities.find((e) => e.guid === p1Guid)! as Record<string, unknown> & { members?: Record<string, unknown> };
    const cRow = Object.keys(p1.members ?? {}).find((k) => k.split('/').length === 2);
    expect(cRow, 'premise: P1 states a row at its C frame').toBeTruthy();
    const list = sc.embeddedPrefabFrames![f.prefabs.Q.guid]!;
    sc.embeddedPrefabFrames![f.prefabs.Q.guid] = list.filter((a) => !a.startsWith(`${p1Guid}/`));
    expect(sc.embeddedPrefabFrames![f.prefabs.Q.guid], 'premise: O1\'s Q frame stays listed').toHaveLength(1);
    p1.nestedOverrides = { 4: { 2: { Transform: { y: 11 } } } };
    write(f, sc);
    await reload(f);
    expect(unexpandedRows().size, 'premise: P1\'s C frame is unexpanded').toBe(1);
    expect(writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Plain')!.id, TF(), 'x', 2)).toBeFalsy();
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((file(f).entities.find((e) => e.guid === p1Guid) as { nestedOverrides?: unknown }).nestedOverrides).toEqual({ 4: { 2: { Transform: { y: 11 } } } });
  });

  it('a list for a prefab with no copy is named by the validator and dropped by the next save', async () => {
    const f = await startRun(be, noNest, 'lf-orphan-list');
    const sc = file(f);
    const Z = 'cccccccc-0000-4000-8fff-000000000009';
    sc.embeddedPrefabFrames = { [Z]: [] };
    write(f, sc);
    expect(validateSceneData(sc).warnings).toEqual([`embeddedPrefabFrames['${Z}']: no copy of this prefab in embeddedPrefabs — nothing reads the list, and the next save drops it`]);
    await reload(f);
    expect(writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Plain')!.id, TF(), 'x', 2)).toBeFalsy();
    await settle();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(file(f).embeddedPrefabFrames).toBeUndefined();
  });
});

describe('#1939 item 2: the copy store crosses a world swap', () => {
  it('a frame of a missing prefab destroyed during Play still expands after Stop (Unity discards Play state)', async () => {
    // Held twice: by the snapshot taken at Play (its copy and list), and by the edit world's carry (`AuthoredSnapshot.copies`).
    // Mutation, compound (the carry alone): strip the snapshot's `embeddedPrefabs`/`embeddedPrefabFrames` in
    // `captureAuthoredSnapshot` → still green; then also restore with no carry, or with one captured from the PLAY world at
    // Stop → red (O1's Q frame, destroyed in Play, is in neither).
    const f = await startRun(be, noNest, 'lf-stop');
    await trash(f, 'Q');
    const live = countOf(f.prefabs.Q.guid);
    expect(live, 'premise: Q frames live').toBe(4);
    expect((await enterPlay()).kind).toBe('started');
    await settle();
    deleteEntitiesWithUndo([topRoot(f, 'O').id]);
    await settle();
    expect(countOf(f.prefabs.Q.guid), 'premise: O1\'s Q frame is gone in Play').toBe(2);
    await stopPlay();
    await settle();
    expect(countOf(f.prefabs.Q.guid)).toBe(live);
    expect(unexpandedRows().size).toBe(0);
  });

  it('H1: a kept base keeps its copies across a level switch and back, and its next save still writes them', async () => {
    // F (the fixture scene) is the base of two levels. Its file carries Q's copy with no frame listed live: P1's and O1's
    // Q rows stay unexpanded (I18 writes the copy back verbatim). Switching L → L2 → L keeps F, carried flat each time.
    // Mutation: make `loadScene`'s default carry empty (`opts.sceneCopies ?? new Map()`) → F's save drops Q's copy.
    const f = await startRun(be, noNest, 'lf-h1');
    await trash(f, 'Q');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const fsc = file(f);
    fsc.embeddedPrefabFrames![f.prefabs.Q.guid] = [];
    write(f, fsc);
    const level = (name: string, tag: string) => {
      const path = f.scenePath.replace(/Fuzz\.json$/, `${name}.json`);
      const guid = f.sceneGuid.replace(/^.{8}/, tag);
      be.write(path, `${JSON.stringify({ id: guid, version: SCENE_FORMAT_VERSION, name, createdAt: '2026-01-01T00:00:00.000Z', resources: [], baseScene: f.sceneGuid, entities: [] }, null, 2)}\n`);
      registerAsset(guid, path, 'scene');
      return path;
    };
    const l1 = level('Level', 'abababab');
    const l2 = level('Level2', 'acacacac');
    be.marked.clear();
    expect((await loadSceneReporting(l1)).outcome).toBe('loaded');
    await settle();
    expect(unexpandedRows().size, 'premise: F\'s Q rows unexpanded').toBeGreaterThan(0);
    expect((await loadSceneReporting(l2)).outcome).toBe('loaded'); // F kept
    await settle();
    expect((await loadSceneReporting(l1)).outcome).toBe('loaded'); // and back: F kept again
    await settle();
    expect(writeTraitFieldWithUndo(getAllEntities().find((e) => e.name === 'Plain')!.id, TF(), 'x', 3)).toBeFalsy();
    await settle();
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect(Object.keys(file(f).embeddedPrefabs ?? {})).toEqual([f.prefabs.Q.guid]);
  });
});

describe('#1939 hunts 1031 and 3081: the editor meets a copy-restored frame by the rules a reload does', () => {
  it('1031, rule 1: a kept TEMPLATE reference node of a missing prefab survives a no-op rebuild expanded (met by its frame address)', async () => {
    // O's row N states two keyed reference nodes of Q. Both were live at the save; the list keeps only k-q1's address, so
    // k-q2 reloads a placeholder, which blocks Q's record (`withFrameRecords`), and the rebuild of O1 KEEPS k-q1 live.
    // Mutation: key `rebuildFromEntry`'s kept nodes by guid again (`[durableGuid(guid), k]`) → the spawner never meets
    // k-q1, spawns a placeholder of it, and the kept frame is dropped as unnamed: 2 placeholders, and the tree changes.
    const f = await startRun(be, noNest, 'lf-kept-template-node');
    const o = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ added?: unknown[] }> };
    for (const key of ['k-q1', 'k-q2']) {
      o.entities[1]!.added!.push({ parentLocalId: 2, guid: '', key, name: key, prefab: f.prefabs.Q.guid, traits: { EntityAttributes: { name: key, parentId: 0 } }, children: [] });
    }
    const before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(o, null, 2)}\n`);
    await flushWatcher(be, before);
    await reload(f);
    await trash(f, 'Q');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    const list = sc.embeddedPrefabFrames![f.prefabs.Q.guid]!;
    expect(list.filter((a) => /\/\+k-q[12]$/.test(a)), 'premise: both nodes listed live').toHaveLength(2);
    sc.embeddedPrefabFrames![f.prefabs.Q.guid] = list.filter((a) => !a.endsWith('/+k-q2'));
    write(f, sc);
    await reload(f);
    const qPlaceholders = () => authored().filter((e) => unresolvedRefOf(findEntity(e.id) as never)?.source === f.prefabs.Q.guid).length;
    expect(qPlaceholders(), 'premise: k-q2 is a placeholder, k-q1 expanded').toBe(1);
    const tree = () => Object.fromEntries(Object.entries(worldTree()).sort(([a], [b]) => a.localeCompare(b)));
    const was = tree();
    const oDoc = getCachedPrefabSync(f.prefabs.O.guid)!;
    refreshInstances(f.prefabs.O.guid, [topRoot(f, 'O').id], oDoc, oDoc);
    await settle();
    expect(qPlaceholders()).toBe(1);
    expect(tree()).toEqual(was);
  });

  it('3081, rule 2: an undo on a frame of a missing prefab takes an unmarked field from the document the frame was built from', async () => {
    // P1's root is set to x 7 (an override), P's template is then changed outside to x 7 too, and P is trashed: P1 is kept
    // live on its record, which says 7. Undoing the edit drops the mark, so the field is unmarked and must show the
    // template's value, as it does with P present, and as the save → reload (from the scene's copy) gives.
    // Mutation: `takeUnmarkedFromBase` reads `getCachedPrefabSync(source)` again → P1 keeps the undo's restored 0.
    const f = await startRun(be, noNest, 'lf-unmarked-from-record');
    const p1 = () => topRoot(f, 'P');
    const x = () => readTraitData(p1().id, TF())!.x as number;
    expect(x(), 'premise: P1 starts at 0').toBe(0);
    expect(writeTraitFieldWithUndo(p1().id, TF(), 'x', 7)).toBeFalsy();
    await settle();
    const p = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: Array<{ traits: { Transform?: Record<string, number> } }> };
    p.entities[0]!.traits.Transform = { ...(p.entities[0]!.traits.Transform ?? {}), x: 7 };
    const before = be.snapshot();
    be.write(f.prefabs.P.path, `${JSON.stringify(p, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();
    await trash(f, 'P');
    expect(getCachedPrefabSync(f.prefabs.P.guid), 'premise: P is out of the cache').toBeNull();
    expect((await undoStep('undo')).did, 'premise: the edit undoes').toBe(true);
    await settle();
    expect(x()).toBe(7);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    await reload(f);
    expect(x()).toBe(7);
  });
});

describe('#1966 (known limit, parked): a node a prefab anchors AT a nested row is restated by the save, so its key address matches no reload', () => {
  // The capture's added walk never anchors a node at a nested row's root (`ownedByEcs` is not walked), so the save writes
  // the declaring frame's node REMOVED plus a scene copy by guid, while the list names the frame by key: the reload asks the
  // guid address, the copy is refused, and the frame reloads a placeholder (6 Q entities live, 4 reloaded). Goes green
  // when #1966 is fixed (the save then states the node by key) — delete `.fails` then. An anchor at a plain row (F3) works.
  const anchoredAtC = (f: Fixture, viaGroup: boolean) => {
    const q = { parentLocalId: viaGroup ? 0 : 4, guid: '', key: 'k-y', name: 'Y', prefab: f.prefabs.Q.guid, traits: { EntityAttributes: { name: 'Y', parentId: 0 } }, children: [] };
    return viaGroup
      ? { parentLocalId: 4, guid: '', key: 'k-x', name: 'X', traits: { EntityAttributes: { name: 'X', parentId: 0 }, Transform: { x: 0, y: 0, z: 0 } }, children: [q] }
      : q;
  };
  for (const [label, viaGroup] of [['a template reference node', false], ['a keyed plain group holding it', true]] as const) {
    it.fails(`${label} anchored at row C (a nested Q row): live 6, reloaded 6, no placeholder`, async () => {
      const f = await startRun(be, noNest, `lf-1966-${viaGroup ? 'group' : 'node'}`);
      const o = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ added?: unknown[] }> };
      o.entities[1]!.added!.push(anchoredAtC(f, viaGroup));
      const before = be.snapshot();
      be.write(f.prefabs.O.path, `${JSON.stringify(o, null, 2)}\n`);
      await flushWatcher(be, before);
      await reload(f);
      expect(countOf(f.prefabs.Q.guid), 'premise: three Q frames live').toBe(6);
      await trash(f, 'Q');
      expect((await saveScene({ allowDialog: false })).saved).toBe(true);
      await reload(f);
      expect(placeholderGuids().size).toBe(0);
      expect(countOf(f.prefabs.Q.guid)).toBe(6);
    });
  }
});
