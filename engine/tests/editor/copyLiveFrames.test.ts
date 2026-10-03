/** #1939: a scene's copy of a missing prefab lists the frames it was LIVE for at the save (`embeddedPrefabFrames`, scene
 *  v19, `frameAddress.ts`), and the copy store is carried across a world swap.
 *
 *  Owner ruling B (#2001 S5, #2028): no copy expands anything. Every frame of a missing prefab loads as its Missing Prefab
 *  placeholder, listed or not, keeping every record under it, and the list is written back as the file held it until
 *  S6 stops writing copies. What item 1 decided (which frames a copy restores) is retired with the expansion; what is
 *  left is the round trip, the validator's warnings, and the records under the placeholders.
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
import { boot, bridge, memoryStorage, startRun, settle, piOf, unexpandedRows, flushWatcher, placeholderGuids, authored, worldTree, evictKeepingFramesLive, withFramesKeptLive, type Fixture } from './prefabFuzz/harness';
import { refreshInstances } from '../../packages/modoki/src/editor/scene/prefabRebuild';
import { getCachedPrefabSync } from '../../packages/modoki/src/editor/scene/prefabCache';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { findEntity, readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { deleteAssetFiles, deletionPathsFor } from '../../packages/modoki/src/editor/panels/assetOps';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';
import { deleteEntitiesWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { enterPlay, stopPlay } from '../../packages/modoki/src/editor/scene/playMode';
import { validateSceneData } from '../../packages/modoki/src/runtime/loaders/sceneValidation';

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

/** Trash a fixture prefab as the Assets panel does, and let the watcher see it — its frames kept LIVE
 *  (`evictKeepingFramesLive`): the state the copy store meets in prefab edit's template or an envelope's world. A scene's
 *  own trash shows them as placeholders at once (#2056). */
async function trash(f: Fixture, which: 'P' | 'Q'): Promise<void> {
  const before = be.snapshot();
  expect((await withFramesKeptLive(be, () => deleteAssetFiles(deletionPathsFor(f.prefabs[which].path, 'prefab', null)))).ok).toBe(true);
  evictKeepingFramesLive(f.prefabs[which].path);
  await flushWatcher(be, before);
  await settle();
}

/** The guid of the top-level entry of `prefab` in scene file `sc`. */
const topRootGuidOf = (sc: SceneFile, prefab: string) => sc.entities.find((e) => e.prefab === prefab && e.guid)!.guid!;

async function reload(f: Fixture): Promise<void> {
  expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
  await settle();
}

describe('#1939 item 1: a copy restores exactly the frames its scene listed live at the save', () => {
  it('F3/T14: three Q frames live at the save, one inside a TEMPLATE reference node of O, are listed; each reloads its placeholder; the file round-trips', async () => {
    // O's row N states a keyed reference node PN of P under N's A, so O1 holds three Q frames: P1's C, N's C, and PN's C.
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
    // Until scene v20 the save listed the three frames beside Q's copy; a v20 save writes neither (#2001 S6).
    expect(file(f).embeddedPrefabs).toBeUndefined();
    expect(file(f).embeddedPrefabFrames).toBeUndefined();
    await reload(f);
    expect(countOf(f.prefabs.Q.guid), 'ruling B: no Q frame expands').toBe(0);
    expect(unexpandedRows().size, 'each Q row its placeholder').toBe(3);
    const bytes = be.read(f.scenePath)!;
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath)).toBe(bytes); // I23
  });

  it('C1: a placeholder ENTRY saved beside a live instance of its prefab, and the listed one, both reload as placeholders', async () => {
    const f = await startRun(be, noNest, 'lf-c1');
    const pDoc = JSON.parse(be.read(f.prefabs.P.path)!) as unknown;
    await trash(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    const p1Guid = topRoot(f, 'P').guid!;
    // As a v19 editor left it: P's copy, with P1 listed live (a v20 save writes neither, so they are put in by hand).
    sc.embeddedPrefabs = { [f.prefabs.P.guid]: pDoc };
    sc.embeddedPrefabFrames = { [f.prefabs.P.guid]: [p1Guid] };
    // A second entry of P that was a Missing Prefab placeholder at the save: its record, and no list entry.
    const p2Guid = p1Guid.replace(/^.{8}/, '12121212');
    sc.entities.push({ prefab: f.prefabs.P.guid, guid: p2Guid, traits: { EntityAttributes: { sortOrder: 9 } }, members: { '/': { traits: { EntityAttributes: { name: 'P2' }, Transform: { x: 20, y: 0, z: 0 } } } } });
    write(f, sc);
    await reload(f);
    expect(placeholderGuids().has(p2Guid)).toBe(true);
    expect(placeholderGuids().has(p1Guid), 'ruling B: listed live, still a placeholder').toBe(true);
  });

  it('an address that resolves to nothing is ignored, and the validator names an unanchored one; the load completes', async () => {
    // Mutation: drop `embeddedPrefabFrameWarnings` from `validateSceneData` → the anchor warning is not reported.
    const f = await startRun(be, noNest, 'lf-unresolved');
    const pDoc = JSON.parse(be.read(f.prefabs.P.path)!) as unknown;
    await trash(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    // A v19 file's copy and list, by hand (a v20 save writes neither).
    sc.embeddedPrefabs = { [f.prefabs.P.guid]: pDoc };
    const list = [topRoot(f, 'P').guid!];
    sc.embeddedPrefabFrames = { [f.prefabs.P.guid]: list };
    const ghost = 'abababab-0000-4000-8000-000000000001';
    list.push(ghost, `${list[0]}/eeeeeeee-0000-4000-8fff-000000000001`, `${list[0]}/+no-such-key`);
    write(f, sc);
    expect(validateSceneData(sc).warnings).toEqual([
      `embeddedPrefabFrames['${f.prefabs.P.guid}']: the frame '${ghost}' is anchored on no entity of this scene — the loader matches no frame to it`,
    ]);
    await reload(f);
    expect(placeholderGuids().has(topRootGuidOf(sc, f.prefabs.P.guid)), 'ruling B: P1 its placeholder').toBe(true);
    expect(countOf(f.prefabs.P.guid)).toBe(0);
  });

  it('a list that is not a list is ignored with a warning, never a throw', async () => {
    // (A frame with no address answered by the rows rule; ruling B retired that with every expansion from a copy.)
    const f = await startRun(be, noNest, 'lf-unaddressable');
    const pDoc = JSON.parse(be.read(f.prefabs.P.path)!) as unknown;
    await trash(f, 'P');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    // A malformed list beside a v19 file's copy (by hand: a v20 save writes neither): warned and ignored, and the load completes.
    const bad = file(f);
    bad.embeddedPrefabs = { [f.prefabs.P.guid]: pDoc };
    bad.embeddedPrefabFrames = { [f.prefabs.P.guid]: 'not a list' } as never;
    write(f, bad);
    expect(validateSceneData(bad).warnings).toContain(`embeddedPrefabFrames['${f.prefabs.P.guid}']: not a list of frame addresses — the loader ignores it, and the copy answers by the member rows`);
    const warn = vi.spyOn(console, 'warn');
    await reload(f);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('embeddedPrefabFrames for'))).toBe(true);
    warn.mockRestore();
  });

  it('a legacy channel into a frame of a missing prefab is kept under its placeholder, not dropped (S1 class)', async () => {
    // P1's row C (localId 4) expands Q, and P1's own rows still state members under C. Ruling B: C is Q's placeholder, and
    // every record under it is held verbatim (rule 9), the legacy `nestedOverrides` channel too, so the save keeps it.
    const f = await startRun(be, noNest, 'lf-legacy-reach');
    await trash(f, 'Q');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    const sc = file(f);
    const p1Guid = topRoot(f, 'P').guid!;
    const p1 = sc.entities.find((e) => e.guid === p1Guid)! as Record<string, unknown> & { members?: Record<string, unknown> };
    const cRow = Object.keys(p1.members ?? {}).find((k) => k.split('/').length === 2);
    expect(cRow, 'premise: P1 states a row at its C frame').toBeTruthy();
    p1.nestedOverrides = { 4: { 2: { Transform: { y: 11 } } } };
    write(f, sc);
    await reload(f);
    expect(unexpandedRows().size, 'premise: P1\'s and O1\'s Q frames are placeholders').toBe(2);
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

describe('#1939 item 2: a world swap', () => {
  it('a frame of a missing prefab destroyed during Play is back after Stop, as its placeholder (Unity discards Play state)', async () => {
    // Stop reloads the edit world's snapshot: a load, so ruling B shows every Q frame as its row's placeholder (#2001 S5,
    // #2028). (Until scene v20 the save after Stop also wrote Q's copy, carried by the snapshot; a v20 save writes none.)
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
    expect(countOf(f.prefabs.Q.guid)).toBe(0);
    expect(unexpandedRows().size, 'O1\'s Q frame is back, as a placeholder, with P1\'s').toBe(live / 2);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect(file(f).embeddedPrefabs).toBeUndefined();
  });
  // H1 (a kept base's copies carried across a level switch, so its next save wrote them) went with the copy writer:
  // a v20 save writes no copy, whatever was carried (#2001 S6).
});

describe('#1939 hunts 1031 and 3081: the editor meets a copy-restored frame by the rules a reload does', () => {
  it('1031, rule 1: a kept TEMPLATE reference node of a missing prefab survives a no-op rebuild expanded (met by its frame address)', async () => {
    // O's row N states two keyed reference nodes of Q, both live; Q is trashed mid-session, which keeps them live (#1738),
    // and the rebuild of O1 KEEPS them. Hunt 1031 reached it by a reload from the copy that left k-q2 a placeholder, which
    // blocked Q's frame record; ruling B (#2028) makes both placeholders at any load, so only the session reaches it, and
    // there two carriers meet the frames: Q's frame record (`withFrameRecords`) and the kept nodes by frame address.
    // Mutation, compound: `withFrameRecords` returns its base reader, AND key `rebuildFromEntry`'s kept nodes by entity
    // instead of address → 2 placeholders (either alone stays green).
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
    const qPlaceholders = () => authored().filter((e) => unresolvedRefOf(findEntity(e.id) as never)?.source === f.prefabs.Q.guid).length;
    expect(qPlaceholders(), 'premise: both nodes live').toBe(0);
    const tree = () => Object.fromEntries(Object.entries(worldTree()).sort(([a], [b]) => a.localeCompare(b)));
    const was = tree();
    const oDoc = getCachedPrefabSync(f.prefabs.O.guid)!;
    expect(refreshInstances(f.prefabs.O.guid, [topRoot(f, 'O').id], oDoc, oDoc), 'premise: O1 is rebuilt').toBe(1);
    await settle();
    expect(qPlaceholders()).toBe(0);
    expect(tree()).toEqual(was);
  });

  it('#1948 S1: a kept template node the document RE-POINTS is the new prefab after the rebuild, as after a reload', async () => {
    // 1031's premise (hunt seed 1031 reaches it by real ops: a created prefab's template node kept from Q's copy), then
    // an outside change of O re-points k-q1 from Q to H. Met by its address alone, the kept Q frame stood in for the H
    // statement: k-q1 stayed Q, and the save persisted it. The kept frame is released before H spawns, so H's root
    // derives the guid the Q frame held, and the rebuild equals the reload.
    // Mutations: (a) the spawn skip ignores the prefab (`keeping.frames.has` alone) → k-q1 is still Q;
    // (b) no `release` on a re-point → H spawns beside the live Q frame under a fallback guid → the trees differ.
    const f = await startRun(be, noNest, 'lf-kept-node-repointed');
    const o = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ added?: Array<Record<string, unknown>> }> };
    for (const key of ['k-q1', 'k-q2']) {
      o.entities[1]!.added!.push({ parentLocalId: 2, guid: '', key, name: key, prefab: f.prefabs.Q.guid, traits: { EntityAttributes: { name: key, parentId: 0 } }, children: [] });
    }
    let before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(o, null, 2)}\n`);
    await flushWatcher(be, before);
    await reload(f);
    await trash(f, 'Q');
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    await reload(f);
    const k1 = () => getAllEntities().filter((e) => templateKeyOf(findEntity(e.id) as never) === 'k-q1').map((e) => piOf(e.id)?.source ?? unresolvedRefOf(findEntity(e.id) as never)?.source);
    expect(k1(), 'premise: k-q1 is Q\'s (its placeholder, ruling B)').toEqual([f.prefabs.Q.guid]);
    const o2 = JSON.parse(be.read(f.prefabs.O.path)!) as { entities: Array<{ added?: Array<Record<string, unknown>> }> };
    for (const n of o2.entities[1]!.added!) if (n.key === 'k-q1') n.prefab = f.prefabs.H.guid;
    before = be.snapshot();
    be.write(f.prefabs.O.path, `${JSON.stringify(o2, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();
    expect(k1()).toEqual([f.prefabs.H.guid]);
    const tree = () => Object.fromEntries(Object.entries(worldTree()).sort(([a], [b]) => a.localeCompare(b)));
    const rebuilt = tree();
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    await reload(f);
    expect(k1()).toEqual([f.prefabs.H.guid]);
    expect(tree()).toEqual(rebuilt);
  });

  it('3081, rule 2: an undo on a frame of a missing prefab takes an unmarked field from the document the frame was built from', async () => {
    // P1's member A is set to y 7 (an override), P's template is then changed outside to y 7 too, and P is trashed: P1 is
    // kept live on its record, which says 7. Undoing the edit drops the mark, so the field is unmarked and must show the
    // template's value, as it does with P present. (A reload shows P1's placeholder: ruling B, #2028.)
    // On member A, not the root: a v20 `/` row states the root's position, so that field is never unmarked (#2001 S6).
    // Mutation: `takeUnmarkedFromBase` reads `getCachedPrefabSync(source)` again → A keeps the undo's restored 0.
    const f = await startRun(be, noNest, 'lf-unmarked-from-record');
    const a = () => getAllEntities().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === topRoot(f, 'P').id)!;
    const y = () => readTraitData(a().id, TF())!.y as number;
    expect(y(), 'premise: A starts at 0').toBe(0);
    expect(writeTraitFieldWithUndo(a().id, TF(), 'y', 7)).toBeFalsy();
    await settle();
    const p = JSON.parse(be.read(f.prefabs.P.path)!) as { entities: Array<{ name?: string; traits: { Transform?: Record<string, number> } }> };
    const row = p.entities.find((r) => r.name === 'A')!;
    row.traits.Transform = { ...(row.traits.Transform ?? {}), y: 7 };
    const before = be.snapshot();
    be.write(f.prefabs.P.path, `${JSON.stringify(p, null, 2)}\n`);
    await flushWatcher(be, before);
    await settle();
    await trash(f, 'P');
    expect(getCachedPrefabSync(f.prefabs.P.guid), 'premise: P is out of the cache').toBeNull();
    expect((await undoStep('undo')).did, 'premise: the edit undoes').toBe(true);
    await settle();
    expect(y()).toBe(7);
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
